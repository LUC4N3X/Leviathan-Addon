'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const kitsuProvider = require('../animeworld/kitsu_provider');
const animeIdentity = require('../anime/anime_identity');
const {
    resolveAnimeManifest,
    buildSyntheticUrl,
    normalizeQualityFilter,
    inferCanPlayFHDFromPlaylist
} = require('../streamingcommunity/vix_handler');

const AU_BASE = 'https://www.animeunity.so';
const PROVIDER_NAME = 'AnimeUnity';
const PROVIDER_CODE = 'AU';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT = 10000;
const SESSION_TTL_MS = 20 * 60 * 1000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const PAGE_TTL_MS = 10 * 60 * 1000;
const EPISODE_TTL_MS = 30 * 60 * 1000;
const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

const http = axios.create({
    timeout: REQUEST_TIMEOUT,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: () => true,
    proxy: false
});

const cache = {
    session: new Map(),
    search: new Map(),
    page: new Map(),
    episode: new Map(),
    embed: new Map(),
    inflight: new Map()
};

const TITLE_FIXES = new Map([
    ['shingeki no kyojin', "L'attacco dei Giganti"],
    ['attack on titan', "L'attacco dei Giganti"],
    ['boku no hero academia', 'My Hero Academia'],
    ['ore dake level up na ken', 'Solo Leveling'],
    ['kimetsu no yaiba', 'Demon Slayer'],
    ['oshi no ko', 'Oshi no Ko'],
    ['jujutsu kaisen ii', 'Jujutsu Kaisen Season 2'],
    ['jujutsu kaisen 2', 'Jujutsu Kaisen Season 2'],
    ['one piece fan letter', 'ONE PIECE FAN LETTER']
]);

function now() {
    return Date.now();
}

function getCached(map, key) {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
        map.delete(key);
        return undefined;
    }
    return entry.value;
}

function setCached(map, key, value, ttlMs) {
    map.set(key, { value, expiresAt: now() + ttlMs });
    return value;
}

async function singleFlight(key, worker) {
    const running = cache.inflight.get(key);
    if (running) return running;
    const task = (async () => worker())();
    cache.inflight.set(key, task);
    try {
        return await task;
    } finally {
        cache.inflight.delete(key);
    }
}

function decodeHtml(value) {
    return he.decode(String(value || ''));
}

function uniqueNonEmpty(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = decodeHtml(value).trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function normalizeLookupTitle(value) {
    return decodeHtml(value)
        .replace('½', '1/2')
        .replace(/[’`]/g, "'")
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function containsDubMarker(value) {
    const normalized = ` ${normalizeLookupTitle(value)} `;
    return /(\sita\s|\sdoppiat[oa]\s|\sdub(?:bed)?\s)/i.test(normalized);
}

function titleVariants(title, isDubbed = false) {
    const raw = decodeHtml(title).trim();
    if (!raw) return [];
    const compact = raw
        .replace(/[\[\](){}:_|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const stripped = compact
        .replace(/\b(?:season|stagione|part|cour)\s+\d+\b/gi, ' ')
        .replace(/\b(?:sub\s*ita|ita|dub(?:bed)?|doppiat[oa])\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const normalizedKey = normalizeLookupTitle(raw);
    const fixed = TITLE_FIXES.get(normalizedKey);
    return uniqueNonEmpty([
        raw,
        fixed,
        compact,
        stripped,
        isDubbed && stripped ? `${stripped} (ITA)` : null,
        isDubbed && stripped ? `${stripped} ITA` : null
    ]);
}

function tokenScore(query, candidate) {
    const q = normalizeLookupTitle(query);
    const c = normalizeLookupTitle(candidate);
    if (!q || !c) return 0;
    if (q === c) return 3;
    let score = 0;
    if (q.includes(c) || c.includes(q)) score += 1.2;
    const qTokens = new Set(q.split(' ').filter(Boolean));
    const cTokens = new Set(c.split(' ').filter(Boolean));
    let hits = 0;
    for (const token of qTokens) if (cTokens.has(token)) hits += 1;
    if (qTokens.size) score += hits / qTokens.size;
    const qPrefix = q.split(' ').slice(0, 3).join(' ');
    const cPrefix = c.split(' ').slice(0, 3).join(' ');
    if (qPrefix && qPrefix === cPrefix) score += 0.4;
    return score;
}

function normalizeAnimeUrl(value, base = AU_BASE) {
    const raw = decodeHtml(value).trim();
    if (!raw) return null;
    try {
        if (raw.startsWith('//')) return `https:${raw}`;
        if (/^https?:\/\//i.test(raw)) return new URL(raw).toString();
        return new URL(raw, base.endsWith('/') ? base : `${base}/`).toString();
    } catch {
        return null;
    }
}

function responseText(response) {
    if (!response) return '';
    if (typeof response.data === 'string') return response.data;
    if (Buffer.isBuffer(response.data)) return response.data.toString('utf8');
    if (response.data == null) return '';
    try {
        return JSON.stringify(response.data);
    } catch {
        return String(response.data || '');
    }
}

function responseUrl(response, fallback) {
    return response?.request?.res?.responseUrl || response?.config?.url || fallback;
}

function extractSetCookieHeader(response) {
    const header = response?.headers?.['set-cookie'];
    if (!header) return '';
    if (Array.isArray(header)) return header.map((entry) => String(entry).split(';')[0]).join('; ');
    return String(header).split(';')[0] || '';
}

function buildHeaders(referer = `${AU_BASE}/`, extra = {}) {
    return {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: referer,
        Origin: AU_BASE,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...extra
    };
}

async function request(url, options = {}) {
    const attempts = Math.max(1, Number(options.attempts || 2));
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await http.request({
                url,
                method: options.method || 'GET',
                headers: options.headers || buildHeaders(),
                params: options.params,
                data: options.data,
                timeout: options.timeout || REQUEST_TIMEOUT,
                responseType: options.responseType,
                validateStatus: () => true,
                proxy: false
            });
            last = response;
            const status = Number(response?.status || 0);
            if (!RETRYABLE_STATUSES.has(status) || attempt === attempts) return response;
        } catch (error) {
            if (attempt === attempts) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    return last;
}

async function fetchSession() {
    const cached = getCached(cache.session, 'session');
    if (cached !== undefined) return cached;

    return singleFlight('au:session', async () => {
        const second = getCached(cache.session, 'session');
        if (second !== undefined) return second;

        try {
            const response = await request(AU_BASE, { headers: buildHeaders(`${AU_BASE}/`), attempts: 3 });
            if (Number(response?.status || 0) !== 200) return setCached(cache.session, 'session', null, 90 * 1000);
            const html = responseText(response);
            const $ = cheerio.load(html || '');
            const session = {
                csrfToken: $('meta[name="csrf-token"]').attr('content') || '',
                cookie: extractSetCookieHeader(response)
            };
            return setCached(cache.session, 'session', session, SESSION_TTL_MS);
        } catch (error) {
            console.error(`[AnimeUnity] session error: ${error.message}`);
            return setCached(cache.session, 'session', null, 90 * 1000);
        }
    });
}

function parseJsonMaybe(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(decodeHtml(value));
    } catch {
        return null;
    }
}

function collectCandidateObjects(payload) {
    const output = [];
    const seenObjects = new Set();

    function add(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        const key = `${item.id || item.anime_id || ''}|${item.slug || item.title_slug || ''}|${item.title || item.name || ''}`;
        if (seenObjects.has(key)) return;
        if (!(item.id || item.anime_id || item.slug || item.title || item.name || item.path || item.url || item.href)) return;
        seenObjects.add(key);
        output.push(item);
    }

    function walk(value, depth = 0) {
        if (depth > 5 || value == null) return;
        if (Array.isArray(value)) {
            for (const item of value) walk(item, depth + 1);
            return;
        }
        if (typeof value !== 'object') return;
        add(value);
        for (const inner of Object.values(value)) walk(inner, depth + 1);
    }

    walk(payload);
    return output;
}

function extractCandidatesFromPayload(payload) {
    const candidates = [];
    const seen = new Set();
    const add = (item) => {
        if (!item || typeof item !== 'object') return;
        const key = `${item.id || item.anime_id || ''}|${item.slug || item.title_slug || ''}|${item.title || item.name || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(item);
    };

    if (Array.isArray(payload)) payload.forEach(add);
    else if (payload && typeof payload === 'object') {
        for (const key of ['records', 'data', 'results', 'animes', 'anime', 'items']) {
            if (Array.isArray(payload[key])) payload[key].forEach(add);
        }
        collectCandidateObjects(payload).forEach(add);
    }

    const text = typeof payload === 'string' ? payload : '';
    if (text) {
        let match;
        const pathRe = /\/anime\/(\d+)-([a-z0-9-]+)/gi;
        while ((match = pathRe.exec(text)) !== null) {
            add({ id: Number(match[1]), slug: match[2], title: match[2].replace(/-/g, ' ') });
        }
        const dataRe = /data-id=["'](\d+)["'][^>]*data-slug=["']([^"']+)["']/gi;
        while ((match = dataRe.exec(text)) !== null) {
            add({ id: Number(match[1]), slug: match[2] });
        }
    }

    return candidates;
}

function buildCandidateTitle(item = {}) {
    return String(item.title || item.title_it || item.title_eng || item.name || item.slug || '').replace(/-/g, ' ').trim();
}

function scoreCandidate(query, item, isDubbed) {
    const title = buildCandidateTitle(item);
    if (!title) return 0;
    let score = Math.max(...titleVariants(query, isDubbed).map((variant) => tokenScore(variant, title)), 0);
    const dubFlag = item.dub === 1 || item.dub === true || String(item.dub).toLowerCase() === 'true';
    if (isDubbed) {
        if (dubFlag) score += 0.55;
        if (containsDubMarker(title)) score += 0.4;
    } else {
        if (dubFlag) score -= 0.25;
        if (containsDubMarker(title)) score -= 0.2;
    }
    if (item.always_home === 1 || item.always_home === true) score += 0.05;
    return score;
}

function pickBestCandidate(query, records, isDubbed) {
    let best = null;
    let bestScore = -Infinity;
    for (const record of records || []) {
        const score = scoreCandidate(query, record, isDubbed);
        if (score > bestScore) {
            best = record;
            bestScore = score;
        }
    }
    if (!best || bestScore < 0.55) return null;
    console.log(`[AnimeUnity] match ${query} -> ${buildCandidateTitle(best) || best.slug || best.id} score=${bestScore.toFixed(2)} dub=${isDubbed}`);
    return best;
}

async function postSearchEndpoint(endpoint, payload, session, asJson = false) {
    const headers = buildHeaders(`${AU_BASE}/`, {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json,text/plain,*/*',
        ...(session?.csrfToken ? { 'X-CSRF-TOKEN': session.csrfToken, 'X-CSRF-Token': session.csrfToken } : {}),
        ...(session?.cookie ? { Cookie: session.cookie } : {}),
        ...(asJson ? { 'Content-Type': 'application/json;charset=UTF-8' } : { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' })
    });

    const data = asJson ? payload : new URLSearchParams(payload).toString();
    const response = await request(`${AU_BASE}${endpoint}`, {
        method: 'POST',
        headers,
        data,
        timeout: REQUEST_TIMEOUT,
        attempts: 2
    });
    if (Number(response?.status || 0) !== 200) return [];
    let parsed = response.data;
    if (!parsed || typeof parsed !== 'object') parsed = parseJsonMaybe(responseText(response)) || responseText(response);
    return extractCandidatesFromPayload(parsed);
}

async function searchAnime(query, isDubbed = false) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return null;
    const key = `${normalizeLookupTitle(normalizedQuery)}:${isDubbed ? 'dub' : 'sub'}`;
    const cached = getCached(cache.search, key);
    if (cached !== undefined) return cached;

    return singleFlight(`au:search:${key}`, async () => {
        const second = getCached(cache.search, key);
        if (second !== undefined) return second;

        const session = await fetchSession();
        const candidates = [];
        const seen = new Set();
        const extend = (items) => {
            for (const item of items || []) {
                const cKey = `${item.id || item.anime_id || ''}|${item.slug || item.title_slug || ''}|${buildCandidateTitle(item)}`;
                if (seen.has(cKey)) continue;
                seen.add(cKey);
                candidates.push(item);
            }
        };

        for (const singleQuery of titleVariants(normalizedQuery, isDubbed)) {
            const payloads = [
                { title: singleQuery, type: '', year: '', order: 'desc', status: '', genres: '', season: '', offset: 0, dubbed: isDubbed ? 1 : 0 },
                { title: singleQuery, type: false, year: false, order: 'Lista A-Z', status: false, genres: false, season: false, offset: 0, dubbed: isDubbed },
                { title: singleQuery, type: '', year: '', order: 'Lista A-Z', status: '', genres: '', season: '', offset: 0, dubbed: isDubbed ? 'true' : 'false' }
            ];

            for (const payload of payloads) {
                try { extend(await postSearchEndpoint('/archivio/get-animes', payload, session, false)); } catch (error) { console.warn(`[AnimeUnity] archivio form failed: ${error.message}`); }
                try { extend(await postSearchEndpoint('/archivio/get-animes', payload, session, true)); } catch (error) { console.warn(`[AnimeUnity] archivio json failed: ${error.message}`); }
            }

            try {
                const response = await request(`${AU_BASE}/archivio`, {
                    params: { title: singleQuery },
                    headers: buildHeaders(`${AU_BASE}/`, session?.cookie ? { Cookie: session.cookie } : {}),
                    timeout: REQUEST_TIMEOUT
                });
                if (Number(response?.status || 0) === 200) extend(extractCandidatesFromPayload(responseText(response)));
            } catch (error) {
                console.warn(`[AnimeUnity] archivio html failed: ${error.message}`);
            }

            try { extend(await postSearchEndpoint('/livesearch', { title: singleQuery }, session, true)); } catch (error) { console.warn(`[AnimeUnity] livesearch json failed: ${error.message}`); }
            try { extend(await postSearchEndpoint('/livesearch', { title: singleQuery }, session, false)); } catch (error) { console.warn(`[AnimeUnity] livesearch form failed: ${error.message}`); }
        }

        return setCached(cache.search, key, pickBestCandidate(normalizedQuery, candidates, isDubbed), SEARCH_TTL_MS);
    });
}

function parseVideoPlayer(html) {
    const $ = cheerio.load(String(html || ''));
    const player = $('video-player').first();
    if (!player.length) return null;
    const anime = parseJsonMaybe(player.attr('anime')) || {};
    const episode = parseJsonMaybe(player.attr('episode')) || {};
    const episodes = parseJsonMaybe(player.attr('episodes')) || [];
    const animeList = parseJsonMaybe(player.attr('anime_list')) || [];
    const embedUrl = normalizeAnimeUrl(player.attr('embed_url'), AU_BASE);
    return {
        anime: anime && typeof anime === 'object' && !Array.isArray(anime) ? anime : {},
        episode: episode && typeof episode === 'object' && !Array.isArray(episode) ? episode : {},
        episodes: Array.isArray(episodes) ? episodes : [],
        animeList: Array.isArray(animeList) ? animeList : [],
        embedUrl,
        html: String(html || '')
    };
}

function safeInt(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function pickEpisodeByNumber(episodes = [], episodeNumber = 1) {
    const target = safeInt(episodeNumber) || 1;
    return (episodes || []).find((episode) => safeInt(episode?.number) === target) || null;
}

function buildAnimePath(item) {
    if (!item) return null;
    const direct = normalizeAnimeUrl(item.path || item.url || item.href, AU_BASE);
    if (direct && direct.includes('/anime/')) return direct;
    const id = item.id || item.anime_id;
    const slug = item.slug || item.title_slug;
    if (id && slug) return `${AU_BASE}/anime/${id}-${slug}`;
    if (slug) return `${AU_BASE}/anime/${slug}`;
    return null;
}

function animePathParts(pathOrUrl) {
    const normalized = normalizeAnimeUrl(pathOrUrl, AU_BASE);
    if (!normalized) return null;
    const match = normalized.match(/\/anime\/(\d+)-([^/?#]+)/i);
    if (!match) return null;
    return { id: Number(match[1]), slug: match[2], url: normalized };
}

async function fetchAnimePage(animeUrl, episodeId = null) {
    const base = normalizeAnimeUrl(animeUrl, AU_BASE);
    if (!base) return null;
    const url = episodeId ? `${base.replace(/\/+$/, '')}/${episodeId}` : base;
    const key = `page:${url}`;
    const cached = getCached(cache.page, key);
    if (cached !== undefined) return cached;

    return singleFlight(`au:${key}`, async () => {
        const second = getCached(cache.page, key);
        if (second !== undefined) return second;
        try {
            const response = await request(url, { headers: buildHeaders(base), timeout: REQUEST_TIMEOUT, attempts: 2 });
            if (Number(response?.status || 0) !== 200) return setCached(cache.page, key, null, 90 * 1000);
            const html = responseText(response);
            const parsed = parseVideoPlayer(html);
            if (!parsed) return setCached(cache.page, key, null, 90 * 1000);
            parsed.url = responseUrl(response, url);
            return setCached(cache.page, key, parsed, PAGE_TTL_MS);
        } catch (error) {
            console.warn(`[AnimeUnity] page failed: ${error.message}`);
            return setCached(cache.page, key, null, 90 * 1000);
        }
    });
}

function selectRelatedVariant(pageData, isDubbed) {
    const anime = pageData?.anime || {};
    const related = Array.isArray(anime.related) ? anime.related : [];
    if (!related.length) return null;
    const currentDub = anime.dub === 1 || anime.dub === true || containsDubMarker(buildCandidateTitle(anime));
    if (Boolean(currentDub) === Boolean(isDubbed)) return anime;

    const baseTitle = buildCandidateTitle(anime);
    let best = null;
    let bestScore = -Infinity;
    for (const item of related) {
        const score = scoreCandidate(baseTitle, item, isDubbed)
            + (anime.anilist_id && item.anilist_id === anime.anilist_id ? 0.9 : 0)
            + (anime.mal_id && item.mal_id === anime.mal_id ? 0.75 : 0);
        if (score > bestScore) {
            best = item;
            bestScore = score;
        }
    }
    return bestScore >= 0.95 ? best : null;
}

async function getEpisodeId(animeUrl, episodeNumber) {
    const parts = animePathParts(animeUrl);
    if (!parts?.id) return null;
    const target = safeInt(episodeNumber) || 1;
    const key = `ep:${parts.id}:${target}`;
    const cached = getCached(cache.episode, key);
    if (cached !== undefined) return cached;

    const page = await fetchAnimePage(parts.url);
    if (page) {
        const exact = pickEpisodeByNumber(page.episodes, target);
        if (exact?.id) return setCached(cache.episode, key, safeInt(exact.id), EPISODE_TTL_MS);
        if (safeInt(page.episode?.number) === target && page.episode?.id) return setCached(cache.episode, key, safeInt(page.episode.id), EPISODE_TTL_MS);
    }

    try {
        const info = await request(`${AU_BASE}/info_api/${parts.id}/`, { headers: buildHeaders(parts.url), timeout: REQUEST_TIMEOUT });
        const total = safeInt(info?.data?.episodes_count) || 0;
        for (let start = 1; start <= total; start += 120) {
            const end = Math.min(start + 119, total);
            if (!(start <= target && target <= end)) continue;
            const response = await request(`${AU_BASE}/info_api/${parts.id}/1`, {
                params: { start_range: start, end_range: end },
                headers: buildHeaders(parts.url),
                timeout: REQUEST_TIMEOUT
            });
            const episodes = Array.isArray(response?.data?.episodes) ? response.data.episodes : [];
            const exact = pickEpisodeByNumber(episodes, target);
            if (exact?.id) return setCached(cache.episode, key, safeInt(exact.id), EPISODE_TTL_MS);
        }
    } catch (error) {
        console.warn(`[AnimeUnity] episode api failed: ${error.message}`);
    }

    return setCached(cache.episode, key, null, 90 * 1000);
}

async function extractEmbedUrl(animeUrl, episodeNumber, isMovie = false) {
    const parts = animePathParts(animeUrl);
    if (!parts?.url) return null;
    const target = safeInt(episodeNumber) || 1;
    const key = `embed:${parts.url}:${target}`;
    const cached = getCached(cache.embed, key);
    if (cached !== undefined) return cached;

    const page = await fetchAnimePage(parts.url);
    if (!page) return setCached(cache.embed, key, null, 90 * 1000);

    const chosen = pickEpisodeByNumber(page.episodes, target);
    const directFromList = normalizeAnimeUrl(chosen?.embed_url, page.url);
    if (directFromList) return setCached(cache.embed, key, directFromList, EPISODE_TTL_MS);

    if (isMovie && page.embedUrl) return setCached(cache.embed, key, page.embedUrl, EPISODE_TTL_MS);

    const episodeId = chosen?.id ? safeInt(chosen.id) : await getEpisodeId(parts.url, target);
    if (episodeId) {
        const episodePage = await fetchAnimePage(parts.url, episodeId);
        if (episodePage?.embedUrl) return setCached(cache.embed, key, episodePage.embedUrl, EPISODE_TTL_MS);
        const $ = cheerio.load(episodePage?.html || '');
        const iframe = normalizeAnimeUrl($('iframe[src*="vixcloud"],iframe[src*="vixsrc"]').first().attr('src'), episodePage?.url || parts.url);
        if (iframe) return setCached(cache.embed, key, iframe, EPISODE_TTL_MS);
    }

    return setCached(cache.embed, key, page.embedUrl || null, EPISODE_TTL_MS);
}

function buildMfpHlsUrl(config, sourceUrl, referer) {
    const base = String(config?.mediaflow?.url || '').trim().replace(/\/+$/, '');
    if (!base || !sourceUrl) return null;
    const password = config?.mediaflow?.pass ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';
    const ref = referer ? `&h_Referer=${encodeURIComponent(referer)}` : '';
    let origin = 'https://vixsrc.to';
    try { origin = new URL(referer || sourceUrl).origin; } catch {}
    const org = origin ? `&h_Origin=${encodeURIComponent(origin)}` : '';
    return `${base}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(sourceUrl)}${password}${ref}${org}`;
}

function qualityRank(value) {
    return { '4K': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '576p': 576, '480p': 480, Unknown: 0 }[String(value || 'Unknown')] || 0;
}

function buildStream({ sourceUrl, referer, quality, title, langTag, emoji, reqHost, config, branch }) {
    const viaMfp = Boolean(config?.mediaflow?.url);
    const url = viaMfp
        ? buildMfpHlsUrl(config, sourceUrl, referer)
        : buildSyntheticUrl(sourceUrl, quality, referer, reqHost);
    if (!url) return null;

    const filename = title;
    const bingeGroup = `animeunity-${String(langTag || 'sub').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${normalizeLookupTitle(title).replace(/\s+/g, '-') || 'anime'}`;
    const extractor = 'VixCloud';
    const behaviorHints = {
        notWebReady: false,
        bingeGroup,
        bingieGroup: bingeGroup,
        extractor,
        vortexExtractor: extractor,
        vortexSource: PROVIDER_NAME,
        vortexProviderCode: PROVIDER_CODE,
        filename,
        seriesTitle: title,
        quality,
        vortexMeta: {
            extractor,
            provider: PROVIDER_NAME,
            source: PROVIDER_NAME,
            site: PROVIDER_NAME,
            providerCode: PROVIDER_CODE,
            filename,
            seriesTitle: title,
            quality,
            language: langTag,
            branch: viaMfp ? `${branch}-mfp` : branch
        }
    };

    return {
        name: `🌀 AnimeUnity | ${quality}`,
        title: `${title}\n${emoji} ${langTag} • ${quality}\n☁️ VixCloud${viaMfp ? ' • MFP' : ' • Proxy interno'}`,
        url,
        quality,
        language: String(langTag || '').toUpperCase().includes('ITA') && !String(langTag || '').toUpperCase().includes('SUB') ? 'ita' : 'jpn',
        extractor,
        host: extractor,
        provider: PROVIDER_NAME,
        source: PROVIDER_NAME,
        site: PROVIDER_NAME,
        filename,
        behaviorHints
    };
}

async function buildStreamsFromEmbed(embedUrl, title, langTag, emoji, episodeNumber, config, reqHost) {
    const manifest = await resolveAnimeManifest(embedUrl);
    if (!manifest?.streamUrl) return [];

    const qualityFilter = normalizeQualityFilter(config?.filters?.scQuality || config?.filters?.animeUnityQuality || 'all');
    const wants1080 = qualityFilter !== '720';
    const wants720 = qualityFilter !== '1080';
    let canPlayFhd = manifest?.payload?.canPlayFHD === true;

    if (!canPlayFhd && wants1080) {
        try {
            canPlayFhd = await inferCanPlayFHDFromPlaylist(manifest.streamUrl, manifest.referer || embedUrl);
        } catch {}
    }

    const streams = [];
    if (canPlayFhd && wants1080) {
        streams.push(buildStream({
            sourceUrl: manifest.streamUrl,
            referer: manifest.referer || embedUrl,
            quality: '1080p',
            title,
            langTag,
            emoji,
            reqHost,
            config,
            branch: 'animeunity-vix-1080'
        }));
    }
    if (wants720 || !streams.length) {
        streams.push(buildStream({
            sourceUrl: manifest.streamUrl,
            referer: manifest.referer || embedUrl,
            quality: '720p',
            title,
            langTag,
            emoji,
            reqHost,
            config,
            branch: 'animeunity-vix-720'
        }));
    }

    return streams.filter(Boolean).sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
}

async function resolveMode(mode, searchContext, config, reqHost) {
    const titles = uniqueNonEmpty([
        ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
        searchContext?.title
    ]);
    const requestedEpisode = safeInt(searchContext?.requestedEpisode) || 1;

    let candidate = null;
    let chosenTitle = null;
    for (const title of titles.slice(0, 8)) {
        candidate = await searchAnime(title, mode.dubbed);
        if (candidate) {
            chosenTitle = title;
            break;
        }
    }
    if (!candidate) return [];

    let animePath = buildAnimePath(candidate);
    if (!animePath) return [];

    let page = await fetchAnimePage(animePath);
    const variant = page ? selectRelatedVariant(page, mode.dubbed) : null;
    const variantPath = buildAnimePath(variant);
    if (variantPath && variantPath !== animePath) {
        animePath = variantPath;
        page = await fetchAnimePage(animePath);
    }

    const embedUrl = await extractEmbedUrl(animePath, requestedEpisode, searchContext?.isMovie === true);
    if (!embedUrl) {
        console.log(`[AnimeUnity] no embed for ${animePath} ep=${requestedEpisode} mode=${mode.langTag}`);
        return [];
    }

    const displayTitle = `${chosenTitle || searchContext?.title || buildCandidateTitle(candidate) || 'Anime'} Ep ${requestedEpisode}`;
    return buildStreamsFromEmbed(embedUrl, displayTitle, mode.langTag, mode.emoji, requestedEpisode, config, reqHost);
}

function dedupeStreams(streams = []) {
    const seen = new Set();
    const out = [];
    for (const stream of streams || []) {
        const url = String(stream?.url || '').trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push(stream);
    }
    return out.sort((a, b) => {
        const qa = qualityRank(b?.quality) - qualityRank(a?.quality);
        if (qa !== 0) return qa;
        const la = String(a?.language || '').localeCompare(String(b?.language || ''));
        return la || String(a?.title || '').localeCompare(String(b?.title || ''));
    });
}

async function searchAnimeUnity(requestId, meta = {}, config = {}, reqHost = null) {
    const filters = config?.filters || {};
    if (Object.prototype.hasOwnProperty.call(filters, 'enableAnimeUnity') && filters.enableAnimeUnity === false) return [];

    try {
        let context = await animeIdentity.buildAnimeSearchContextForProvider({
            requestId,
            meta,
            config,
            providerName: 'AnimeUnity'
        });

        if (!context?.title && !context?.searchTitles?.length && !context?.rawTitles?.length) {
            context = await kitsuProvider.buildSearchContext(requestId, meta);
        }
        if (!context?.title && !context?.searchTitles?.length && !context?.rawTitles?.length) return [];

        console.log(`[AnimeUnity] start | title=${context.title || meta?.title || meta?.name || requestId} | ep=${context.requestedEpisode || 1} | kitsu=${context.kitsuId || 'no'} | tmdb=${context.tmdbId || 'no'} | imdb=${context.imdbId || 'no'}`);
        const modes = [
            { dubbed: false, langTag: 'SUB ITA', emoji: '🇯🇵' },
            { dubbed: true, langTag: 'ITA', emoji: '🇮🇹' }
        ];

        const settled = await Promise.allSettled(modes.map((mode) => resolveMode(mode, context, config, reqHost)));
        const streams = dedupeStreams(settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []));
        console.log(`[AnimeUnity] done | streams=${streams.length}`);
        return streams;
    } catch (error) {
        console.error(`[AnimeUnity] error: ${error.message}`);
        return [];
    }
}

module.exports = { searchAnimeUnity };
