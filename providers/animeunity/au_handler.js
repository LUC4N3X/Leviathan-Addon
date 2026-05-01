'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const {
    SingleFlight,
    TtlLruCache,
    cacheGet,
    cacheGetStale,
    cacheSet
} = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const kitsuProvider = require('../animeworld/kitsu_provider');
const animeIdentity = require('../anime/anime_identity');
const animeProviderUtils = require('../anime/provider_utils');
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
const NEGATIVE_TTL_MS = 90 * 1000;
const SEARCH_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const EPISODE_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const MANIFEST_TTL_MS = 30 * 60 * 1000;
const MANIFEST_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const FHD_PROBE_TTL_MS = 60 * 60 * 1000;
const FHD_PROBE_STALE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEARCH_CONCURRENCY = 4;

const http = axios.create({
    timeout: REQUEST_TIMEOUT,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: () => true,
    proxy: false
});

const cache = {
    session: new TtlLruCache({ max: 4, ttlMs: SESSION_TTL_MS, staleTtlMs: 2 * SESSION_TTL_MS }),
    search: new TtlLruCache({ max: 800, ttlMs: SEARCH_TTL_MS, staleTtlMs: SEARCH_STALE_TTL_MS }),
    page: new TtlLruCache({ max: 1000, ttlMs: PAGE_TTL_MS, staleTtlMs: PAGE_STALE_TTL_MS }),
    episode: new TtlLruCache({ max: 3000, ttlMs: EPISODE_TTL_MS, staleTtlMs: EPISODE_STALE_TTL_MS }),
    embed: new TtlLruCache({ max: 3000, ttlMs: EPISODE_TTL_MS, staleTtlMs: EPISODE_STALE_TTL_MS }),
    manifest: new TtlLruCache({ max: 1000, ttlMs: MANIFEST_TTL_MS, staleTtlMs: MANIFEST_STALE_TTL_MS }),
    fhdProbe: new TtlLruCache({ max: 1000, ttlMs: FHD_PROBE_TTL_MS, staleTtlMs: FHD_PROBE_STALE_TTL_MS }),
    inflight: new SingleFlight('animeunity')
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

const getCached = cacheGet;
const getStaleCached = cacheGetStale;
const setCached = cacheSet;

async function singleFlight(key, worker) {
    return cache.inflight.do(key, worker);
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

function extractSeasonMarker(value) {
    const text = ` ${normalizeLookupTitle(value)} `;
    const patterns = [
        /\b(?:season|stagione|serie|s)\s*([1-9]\d*)\b/i,
        /\b([1-9]\d*)(?:st|nd|rd|th)\s+season\b/i,
        /\b(?:part|cour)\s*([1-9]\d*)\b/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            const parsed = Number.parseInt(match[1], 10);
            if (Number.isInteger(parsed) && parsed > 0) return parsed;
        }
    }

    const roman = text.match(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b/i);
    if (roman?.[1]) {
        const romanMap = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
        return romanMap[String(roman[1]).toLowerCase()] || null;
    }

    const tail = text.match(/\b([2-9])\b\s*$/);
    return tail?.[1] ? Number.parseInt(tail[1], 10) : null;
}

function replaceSeasonMarkerWithNumber(value, season) {
    const replacement = String(season || '').trim();
    if (!replacement) return null;
    return String(value || '')
        .replace(/\b(?:season|stagione|serie)\s*\d+\b/gi, replacement)
        .replace(/\bs\s*\d+\b/gi, replacement)
        .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, replacement)
        .replace(/\b(?:ii|iii|iv|v|vi|vii|viii|ix|x)\b(?=\s*$)/i, replacement)
        .replace(/\s+/g, ' ')
        .trim();
}

function removeSeasonMarkers(value) {
    return ` ${normalizeLookupTitle(value)} `
        .replace(/\b(?:season|stagione|serie|s)\s*\d+\b/gi, ' ')
        .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, ' ')
        .replace(/\b(?:part|cour)\s*\d+\b/gi, ' ')
        .replace(/\b(?:ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, ' ')
        .replace(/\b[2-9]\b\s*$/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function firstSeasonMarker(values = []) {
    for (const value of values || []) {
        const season = extractSeasonMarker(value);
        if (season) return season;
    }
    return null;
}

function filterSeasonSpecificTitles(titles = []) {
    const season = firstSeasonMarker(titles);
    if (!season) return titles;
    const filtered = titles.filter((title) => extractSeasonMarker(title) === season);
    return filtered.length ? filtered : titles;
}

function seasonScoreAdjustment(query, candidateText) {
    const querySeason = extractSeasonMarker(query);
    const candidateSeason = extractSeasonMarker(candidateText);
    if (!querySeason) return candidateSeason ? -0.35 : 0;
    if (!candidateSeason) return -3.2;
    if (querySeason !== candidateSeason) return -4.5;

    const queryRoot = removeSeasonMarkers(query);
    const candidateRoot = removeSeasonMarkers(candidateText);
    return queryRoot && candidateRoot && (queryRoot === candidateRoot || candidateRoot.includes(queryRoot) || queryRoot.includes(candidateRoot))
        ? 3.0
        : 2.2;
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
    const season = extractSeasonMarker(raw);
    const numericSeason = replaceSeasonMarkerWithNumber(compact, season);
    const normalizedKey = normalizeLookupTitle(raw);
    const fixed = TITLE_FIXES.get(normalizedKey);
    return uniqueNonEmpty([
        raw,
        fixed,
        numericSeason,
        season && numericSeason ? numericSeason.replace(new RegExp(`\\b${season}\\b`, 'g'), `S${season}`) : null,
        compact,
        season ? null : stripped,
        isDubbed && !season && stripped ? `${stripped} (ITA)` : null,
        isDubbed && !season && stripped ? `${stripped} ITA` : null
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
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
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
            if (Number(response?.status || 0) !== 200) return setCached(cache.session, 'session', null, NEGATIVE_TTL_MS);
            const html = responseText(response);
            const $ = cheerio.load(html || '');
            const session = {
                csrfToken: $('meta[name="csrf-token"]').attr('content') || '',
                cookie: extractSetCookieHeader(response)
            };
            return setCached(cache.session, 'session', session, SESSION_TTL_MS);
        } catch (error) {
            console.error(`[AnimeUnity] session error: ${error.message}`);
            return setCached(cache.session, 'session', null, NEGATIVE_TTL_MS);
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

function candidateLooksLikeMovie(item = {}) {
    const text = normalizeLookupTitle([
        item?.type,
        item?.anime_type,
        item?.animeType,
        item?.format,
        item?.kind,
        item?.category,
        item?.slug,
        buildCandidateTitle(item)
    ].filter(Boolean).join(' '));
    return /\b(?:movie|film|the movie|gekijouban)\b/i.test(` ${text} `);
}

function candidateLooksLikeSpecial(item = {}) {
    const text = normalizeLookupTitle([
        item?.type,
        item?.anime_type,
        item?.animeType,
        item?.format,
        item?.kind,
        item?.category,
        item?.slug,
        buildCandidateTitle(item)
    ].filter(Boolean).join(' '));
    return /\b(?:special|ova|oad|ona|recap|fan letter|spin off|spinoff)\b/i.test(` ${text} `);
}

function queryLooksLikeSpecial(query) {
    const text = normalizeLookupTitle(query);
    return /\b(?:special|ova|oad|ona|recap|fan letter|spin off|spinoff)\b/i.test(` ${text} `);
}
function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
}

function collectIdentityIds(identity = {}) {
    const info = identity?.info || {};
    const meta = identity?.meta || {};
    const mappedIds = identity?.mappedIds || identity?.mappingPayload || identity?.mappingLookup || {};
    const collect = (...values) => uniqueNonEmpty(values.flatMap(asArray).map((value) => value == null ? null : String(value)));
    return {
        mal: collect(identity.malId, identity.mal_id, identity.mal, info.malId, info.mal_id, info.mal, meta.malId, meta.mal_id, mappedIds.mal, mappedIds.malId),
        anilist: collect(identity.anilistId, identity.anilist_id, identity.anilist, info.anilistId, info.anilist_id, info.anilist, meta.anilistId, meta.anilist_id, mappedIds.anilist, mappedIds.anilistId),
        kitsu: collect(identity.kitsuId, identity.kitsu_id, identity.kitsu, info.kitsuId, info.kitsu_id, meta.kitsuId, meta.kitsu_id, mappedIds.kitsu, mappedIds.kitsuId),
        tmdb: collect(identity.tmdbId, identity.tmdb_id, meta.tmdbId, meta.tmdb_id, mappedIds.tmdb, mappedIds.tmdbId),
        imdb: collect(identity.imdbId, identity.imdb_id, meta.imdbId, meta.imdb_id, mappedIds.imdb, mappedIds.imdbId)
    };
}

function firstItemId(item = {}, keys = []) {
    for (const key of keys) {
        const value = item?.[key];
        if (value != null && value !== '') return String(value);
    }
    return null;
}

function idListHas(list = [], value) {
    if (!value) return false;
    const normalized = normalizeLookupTitle(value);
    return list.some((entry) => normalizeLookupTitle(entry) === normalized);
}

function identityScore(item = {}, identity = null) {
    if (!identity) return 0;
    const ids = collectIdentityIds(identity);
    let score = 0;
    const anilist = firstItemId(item, ['anilist_id', 'anilistId', 'anilist']);
    const mal = firstItemId(item, ['mal_id', 'malId', 'mal']);
    const kitsu = firstItemId(item, ['kitsu_id', 'kitsuId', 'kitsu']);
    const tmdb = firstItemId(item, ['tmdb_id', 'tmdbId', 'tmdb']);
    const imdb = firstItemId(item, ['imdb_id', 'imdbId', 'imdb']);

    if (anilist && ids.anilist.length) score += idListHas(ids.anilist, anilist) ? 1.5 : -1.2;
    if (mal && ids.mal.length) score += idListHas(ids.mal, mal) ? 1.25 : -1.0;
    if (kitsu && ids.kitsu.length) score += idListHas(ids.kitsu, kitsu) ? 1.0 : -0.7;
    if (tmdb && ids.tmdb.length) score += idListHas(ids.tmdb, tmdb) ? 0.7 : -0.45;
    if (imdb && ids.imdb.length) score += idListHas(ids.imdb, imdb) ? 0.7 : -0.45;
    return score;
}

function identitySignature(identity = null) {
    if (!identity) return 'noid';
    const ids = collectIdentityIds(identity);
    return Object.entries(ids)
        .map(([kind, values]) => kind + ':' + values.slice(0, 3).join(','))
        .join('|') || 'noid';
}


function scoreCandidate(query, item, isDubbed, isMovie = null, identity = null) {
    const title = buildCandidateTitle(item);
    if (!title) return 0;
    let score = Math.max(...titleVariants(query, isDubbed).map((variant) => tokenScore(variant, title)), 0);
    const seasonText = [title, item?.slug, item?.title_slug, item?.titleSlug].filter(Boolean).join(' ');
    score += seasonScoreAdjustment(query, seasonText);
    const dubFlag = item.dub === 1 || item.dub === true || String(item.dub).toLowerCase() === 'true';
    if (isDubbed) {
        if (dubFlag) score += 0.55;
        if (containsDubMarker(title)) score += 0.4;
    } else {
        if (dubFlag) score -= 0.25;
        if (containsDubMarker(title)) score -= 0.2;
    }
    const movieFlag = candidateLooksLikeMovie(item);
    if (isMovie === true) score += movieFlag ? 0.8 : -0.35;
    if (isMovie === false && movieFlag) score -= 2.25;
    if (isMovie === false && candidateLooksLikeSpecial(item) && !queryLooksLikeSpecial(query)) score -= 1.35;
    score += identityScore(item, identity);
    if (item.always_home === 1 || item.always_home === true) score += 0.05;
    return score;
}

function rankAnimeCandidates(query, records, isDubbed, isMovie = null, limit = 5, identity = null) {
    const ranked = [];
    const seen = new Set();

    for (const record of records || []) {
        const score = scoreCandidate(query, record, isDubbed, isMovie, identity);
        if (score < 0.55) continue;
        const path = buildAnimePath(record) || `${record?.id || record?.anime_id || ''}|${record?.slug || record?.title_slug || ''}|${buildCandidateTitle(record)}`;
        const key = normalizeLookupTitle(path);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        ranked.push({ record, score });
    }

    ranked.sort((left, right) => right.score - left.score);
    const output = ranked.slice(0, Math.max(1, limit)).map((entry) => entry.record);
    if (output[0]) {
        console.log(`[AnimeUnity] match ${query} -> ${buildCandidateTitle(output[0]) || output[0].slug || output[0].id} score=${ranked[0].score.toFixed(2)} dub=${isDubbed}`);
    }
    return output;
}

function pickBestCandidate(query, records, isDubbed, isMovie = null, identity = null) {
    return rankAnimeCandidates(query, records, isDubbed, isMovie, 1, identity)[0] || null;
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

async function runLimited(tasks = [], limit = DEFAULT_SEARCH_CONCURRENCY) {
    const output = [];
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || DEFAULT_SEARCH_CONCURRENCY, 8));
    let index = 0;

    async function worker() {
        while (index < tasks.length) {
            const current = index;
            index += 1;
            try {
                output[current] = await tasks[current]();
            } catch (error) {
                output[current] = [];
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(safeLimit, tasks.length) }, () => worker()));
    return output;
}

async function searchAnimeCandidates(query, isDubbed = false, isMovie = null, limit = 5, identity = null, options = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return [];
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 5, 8));
    const concurrency = Math.max(1, Math.min(Number.parseInt(options.searchConcurrency, 10) || DEFAULT_SEARCH_CONCURRENCY, 8));
    const key = [
        normalizeLookupTitle(normalizedQuery),
        isDubbed ? 'dub' : 'sub',
        isMovie === null ? 'any' : isMovie ? 'movie' : 'tv',
        'limit=' + safeLimit,
        identitySignature(identity)
    ].join(':');
    const cached = getCached(cache.search, key);
    if (cached !== undefined) return cached;

    return singleFlight('au:search:' + key, async () => {
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

        const tasks = [];
        for (const singleQuery of titleVariants(normalizedQuery, isDubbed).slice(0, options.maxTitleVariants || 6)) {
            const payloads = [
                { title: singleQuery, type: '', year: '', order: 'desc', status: '', genres: '', season: '', offset: 0, dubbed: isDubbed ? 1 : 0 },
                { title: singleQuery, type: false, year: false, order: 'Lista A-Z', status: false, genres: false, season: false, offset: 0, dubbed: isDubbed },
                { title: singleQuery, type: '', year: '', order: 'Lista A-Z', status: '', genres: '', season: '', offset: 0, dubbed: isDubbed ? 'true' : 'false' }
            ];

            for (const payload of payloads) {
                tasks.push(async () => postSearchEndpoint('/archivio/get-animes', payload, session, false).catch((error) => {
                    console.warn(`[AnimeUnity] archivio form failed: ${error.message}`);
                    return [];
                }));
                tasks.push(async () => postSearchEndpoint('/archivio/get-animes', payload, session, true).catch((error) => {
                    console.warn(`[AnimeUnity] archivio json failed: ${error.message}`);
                    return [];
                }));
            }

            tasks.push(async () => {
                try {
                    const response = await request(`${AU_BASE}/archivio`, {
                        params: { title: singleQuery },
                        headers: buildHeaders(`${AU_BASE}/`, session?.cookie ? { Cookie: session.cookie } : {}),
                        timeout: REQUEST_TIMEOUT
                    });
                    return Number(response?.status || 0) === 200 ? extractCandidatesFromPayload(responseText(response)) : [];
                } catch (error) {
                    console.warn(`[AnimeUnity] archivio html failed: ${error.message}`);
                    return [];
                }
            });

            tasks.push(async () => postSearchEndpoint('/livesearch', { title: singleQuery }, session, true).catch((error) => {
                console.warn(`[AnimeUnity] livesearch json failed: ${error.message}`);
                return [];
            }));
            tasks.push(async () => postSearchEndpoint('/livesearch', { title: singleQuery }, session, false).catch((error) => {
                console.warn(`[AnimeUnity] livesearch form failed: ${error.message}`);
                return [];
            }));
        }

        try {
            const groups = await runLimited(tasks, concurrency);
            groups.forEach(extend);
            if (!candidates.length) {
                const stale = getStaleCached(cache.search, key);
                if (stale !== undefined && Array.isArray(stale) && stale.length) {
                    console.warn(`[AnimeUnity] search stale fallback | query=${normalizedQuery} dub=${isDubbed} reason=empty-live-results`);
                    return stale;
                }
            }
            const ranked = rankAnimeCandidates(normalizedQuery, candidates, isDubbed, isMovie, safeLimit, identity);
            return setCached(cache.search, key, ranked, SEARCH_TTL_MS, SEARCH_STALE_TTL_MS);
        } catch (error) {
            const stale = getStaleCached(cache.search, key);
            if (stale !== undefined) {
                console.warn(`[AnimeUnity] search stale fallback | query=${normalizedQuery} dub=${isDubbed} reason=${error.message}`);
                return stale;
            }
            console.warn(`[AnimeUnity] search failed | query=${normalizedQuery} dub=${isDubbed} reason=${error.message}`);
            return setCached(cache.search, key, [], NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
        }
    });
}

async function searchAnime(query, isDubbed = false, isMovie = null) {
    const candidates = await searchAnimeCandidates(query, isDubbed, isMovie, 1);
    return candidates[0] || null;
}

function normalizeAnimeUnityMappingItem(item = null) {
    if (!item) return null;
    if (typeof item === 'string') {
        const url = normalizeAnimeUrl(item, AU_BASE);
        if (url && url.includes('/anime/')) return { path: url };
        const match = String(item).match(/(?:^|\/)(\d+)-([a-z0-9][a-z0-9-]*)/i);
        if (match) return { id: Number(match[1]), slug: match[2], path: `${AU_BASE}/anime/${match[1]}-${match[2]}` };
        return null;
    }

    if (typeof item !== 'object') return null;
    const path = normalizeAnimeUrl(item.path || item.url || item.href || item.link || item.playPath, AU_BASE);
    const id = safeInt(item.id || item.anime_id || item.animeId || item.au_id || item.auId);
    const slug = String(item.slug || item.title_slug || item.titleSlug || item.name_slug || item.nameSlug || '').trim();
    const candidate = { ...item };
    if (path) candidate.path = path;
    if (id) candidate.id = id;
    if (slug) candidate.slug = slug;
    if (!candidate.path && candidate.id && candidate.slug) candidate.path = `${AU_BASE}/anime/${candidate.id}-${candidate.slug}`;
    return buildAnimePath(candidate) ? candidate : null;
}

function extractAnimeUnityCandidatesFromMapping(mappingPayload, isDubbed = false) {
    const raw = mappingPayload?.mappings?.animeunity
        || mappingPayload?.providers?.animeunity
        || mappingPayload?.animeunity
        || mappingPayload?.mapping?.animeunity
        || null;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const output = [];
    const seen = new Set();

    for (const item of list) {
        const candidate = normalizeAnimeUnityMappingItem(item);
        if (!candidate) continue;
        const dubValue = candidate.dub ?? candidate.dubbed ?? candidate.isDubbed ?? candidate.italianDub;
        if (dubValue !== undefined && dubValue !== null) {
            const isCandidateDub = dubValue === true || dubValue === 1 || String(dubValue).toLowerCase() === 'true';
            if (isDubbed !== isCandidateDub) continue;
        }
        const key = normalizeLookupTitle(buildAnimePath(candidate) || JSON.stringify(candidate));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(candidate);
    }

    return output;
}

function buildAnimeUnityMappingLookup(searchContext = {}, requestedEpisode = 1) {
    const episode = safeInt(requestedEpisode) || resolveRequestedAnimeEpisode(searchContext, searchContext?.meta || {});
    const season = safeInt(searchContext?.seasonNumber || searchContext?.season || searchContext?.requestedSeason || searchContext?.meta?.season);
    const kitsuId = safeInt(searchContext?.kitsuId || searchContext?.kitsu_id || searchContext?.kitsu || searchContext?.meta?.kitsuId || searchContext?.meta?.kitsu_id);
    if (kitsuId) return { provider: 'kitsu', externalId: String(kitsuId), season: null, episode, contentType: 'anime' };

    const imdbId = String(searchContext?.imdbId || searchContext?.imdb_id || searchContext?.imdb || searchContext?.meta?.imdbId || searchContext?.meta?.imdb_id || '').trim();
    if (/^tt\d+$/i.test(imdbId)) return { provider: 'imdb', externalId: imdbId, season: season || null, episode, contentType: season ? 'series' : null };

    const tmdbId = safeInt(searchContext?.tmdbId || searchContext?.tmdb_id || searchContext?.tmdb || searchContext?.meta?.tmdbId || searchContext?.meta?.tmdb_id);
    if (tmdbId) return { provider: 'tmdb', externalId: String(tmdbId), season: season || null, episode, contentType: season ? 'series' : null };

    return null;
}

async function fetchAnimeUnityMapping(searchContext = {}, requestedEpisode = 1) {
    const lookup = buildAnimeUnityMappingLookup(searchContext, requestedEpisode);
    if (!lookup) return null;

    try {
        return await animeProviderUtils.fetchMappingPayload(lookup, {
            ...searchContext,
            providerName: PROVIDER_NAME,
            mappingLanguage: 'it',
            mappingTtlMs: 45 * 60 * 1000,
            mappingStaleMs: 36 * 60 * 60 * 1000,
            mappingTimeoutMs: REQUEST_TIMEOUT,
            mappingRetries: 2,
            mappingOriginConcurrency: 6
        });
    } catch (error) {
        console.warn(`[AnimeUnity] mapping failed | reason=${error.message}`);
        return null;
    }
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

function resolveRequestedAnimeEpisode(searchContext = {}, meta = {}) {
    return safeInt(meta?.requested_kitsu_episode)
        || safeInt(meta?.anime_absolute_episode)
        || safeInt(meta?.anime_episode)
        || safeInt(searchContext?.episodeNumber)
        || safeInt(searchContext?.requestedEpisode)
        || safeInt(meta?.episode)
        || 1;
}

function resolveExplicitKitsuRequestId(requestId, meta = {}) {
    const taggedCandidates = uniqueNonEmpty([
        requestId,
        meta?.id,
        meta?.requestedId,
        meta?.originalId,
        meta?.kitsu_id,
        meta?.kitsuId,
        meta?.kitsu
    ]).filter((value) => /kitsu/i.test(String(value || '')));

    for (const candidate of taggedCandidates) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) return candidate;
    }

    for (const candidate of [meta?.kitsu_id, meta?.kitsuId, meta?.kitsu]) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) return `kitsu:${parsed.kitsuId}`;
    }

    return null;
}

function buildStrictKitsuContext(context = {}) {
    const info = context?.info || {};
    const rawTitles = uniqueNonEmpty([
        ...(Array.isArray(info?.titles) ? info.titles : []),
        info?.canonicalTitle,
        info?.title
    ]);
    const strictRawTitles = rawTitles;
    const searchTitles = uniqueNonEmpty([
        ...strictRawTitles.map((title) => TITLE_FIXES.get(normalizeLookupTitle(title))),
        ...kitsuProvider.buildTitleVariants(strictRawTitles),
        ...strictRawTitles
    ]);

    return {
        ...context,
        rawTitles: strictRawTitles,
        searchTitles,
        title: searchTitles[0] || strictRawTitles[0] || null,
        tmdbId: null,
        imdbId: null,
        mappedIds: null,
        mappingPayload: null,
        mappingLookup: null,
        identitySources: ['kitsu'],
        strictKitsu: true
    };
}

function pickEpisodeByNumber(episodes = [], episodeNumber = 1) {
    const target = safeInt(episodeNumber) || 1;
    return (episodes || []).find((episode) => safeInt(episode?.number) === target) || null;
}
function numericField(item = {}, keys = []) {
    for (const key of keys) {
        const value = safeInt(item?.[key]);
        if (value) return value;
    }
    return null;
}

function knownEpisodeCount(pageData = {}, candidate = {}) {
    const anime = pageData?.anime || {};
    const direct = numericField(anime, ['episodes_count', 'episode_count', 'episodesCount', 'episodeCount', 'tot_episodes', 'total_episodes'])
        || numericField(candidate, ['episodes_count', 'episode_count', 'episodesCount', 'episodeCount', 'tot_episodes', 'total_episodes']);
    if (direct) return direct;
    const episodes = Array.isArray(pageData?.episodes) ? pageData.episodes : [];
    let max = 0;
    for (const episode of episodes) max = Math.max(max, safeInt(episode?.number) || 0);
    return max || null;
}

function candidateHasRequestedEpisode(pageData = {}, candidate = {}, episodeNumber = 1, isMovie = false) {
    if (isMovie) return true;
    const target = safeInt(episodeNumber) || 1;
    if (pickEpisodeByNumber(pageData?.episodes || [], target)) return true;
    const count = knownEpisodeCount(pageData, candidate);
    if (count && target > count) return false;
    return true;
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
            if (Number(response?.status || 0) !== 200) {
                const stale = getStaleCached(cache.page, key);
                if (stale !== undefined) {
                    console.warn(`[AnimeUnity] page stale fallback | url=${url} status=${response?.status || 0}`);
                    return stale;
                }
                return setCached(cache.page, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
            }
            const html = responseText(response);
            const parsed = parseVideoPlayer(html);
            if (!parsed) return setCached(cache.page, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
            parsed.url = responseUrl(response, url);
            return setCached(cache.page, key, parsed, PAGE_TTL_MS, PAGE_STALE_TTL_MS);
        } catch (error) {
            const stale = getStaleCached(cache.page, key);
            if (stale !== undefined) {
                console.warn(`[AnimeUnity] page stale fallback | url=${url} reason=${error.message}`);
                return stale;
            }
            console.warn(`[AnimeUnity] page failed: ${error.message}`);
            return setCached(cache.page, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
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
        if (exact?.id) return setCached(cache.episode, key, safeInt(exact.id), EPISODE_TTL_MS, EPISODE_STALE_TTL_MS);
        if (safeInt(page.episode?.number) === target && page.episode?.id) return setCached(cache.episode, key, safeInt(page.episode.id), EPISODE_TTL_MS, EPISODE_STALE_TTL_MS);
        const count = knownEpisodeCount(page);
        if (count && target > count) {
            console.log(`[AnimeUnity] episode rejected by count | anime=${parts.id} target=${target} total=${count}`);
            return setCached(cache.episode, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
        }
    }

    try {
        const info = await request(`${AU_BASE}/info_api/${parts.id}/`, { headers: buildHeaders(parts.url), timeout: REQUEST_TIMEOUT });
        const total = safeInt(info?.data?.episodes_count) || 0;
        if (total && target > total) {
            console.log(`[AnimeUnity] episode api rejected by count | anime=${parts.id} target=${target} total=${total}`);
            return setCached(cache.episode, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
        }
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
            if (exact?.id) return setCached(cache.episode, key, safeInt(exact.id), EPISODE_TTL_MS, EPISODE_STALE_TTL_MS);
        }
    } catch (error) {
        const stale = getStaleCached(cache.episode, key);
        if (stale !== undefined) {
            console.warn(`[AnimeUnity] episode stale fallback | anime=${parts.id} ep=${target} reason=${error.message}`);
            return stale;
        }
        console.warn(`[AnimeUnity] episode api failed: ${error.message}`);
    }

    return setCached(cache.episode, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
}

async function extractEmbedUrl(animeUrl, episodeNumber, isMovie = false, candidate = null) {
    const parts = animePathParts(animeUrl);
    if (!parts?.url) return null;
    const target = safeInt(episodeNumber) || 1;
    const key = `embed:${parts.url}:${target}:${isMovie ? 'movie' : 'tv'}`;
    const cached = getCached(cache.embed, key);
    if (cached !== undefined) return cached;

    const page = await fetchAnimePage(parts.url);
    if (!page) {
        const stale = getStaleCached(cache.embed, key);
        if (stale !== undefined) return stale;
        return setCached(cache.embed, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
    }

    if (!candidateHasRequestedEpisode(page, candidate || {}, target, isMovie)) {
        console.log(`[AnimeUnity] candidate rejected episode-missing | path=${parts.url} ep=${target} total=${knownEpisodeCount(page, candidate || {}) || 'unknown'}`);
        return setCached(cache.embed, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
    }

    const chosen = pickEpisodeByNumber(page.episodes, target);
    const directFromList = normalizeAnimeUrl(chosen?.embed_url, page.url);
    if (directFromList) return setCached(cache.embed, key, directFromList, EPISODE_TTL_MS, EPISODE_STALE_TTL_MS);

    if (isMovie && page.embedUrl) return setCached(cache.embed, key, page.embedUrl, EPISODE_TTL_MS, EPISODE_STALE_TTL_MS);

    const episodeId = chosen?.id ? safeInt(chosen.id) : await getEpisodeId(parts.url, target);
    if (episodeId) {
        const episodePage = await fetchAnimePage(parts.url, episodeId);
        if (episodePage?.embedUrl) return setCached(cache.embed, key, episodePage.embedUrl, EPISODE_TTL_MS, EPISODE_STALE_TTL_MS);
        const $ = cheerio.load(episodePage?.html || '');
        const iframe = normalizeAnimeUrl($('iframe[src*="vixcloud"],iframe[src*="vixsrc"]').first().attr('src'), episodePage?.url || parts.url);
        if (iframe) return setCached(cache.embed, key, iframe, EPISODE_TTL_MS, EPISODE_STALE_TTL_MS);
    }

    if (safeInt(page.episode?.number) === target && page.embedUrl) {
        return setCached(cache.embed, key, page.embedUrl, EPISODE_TTL_MS, EPISODE_STALE_TTL_MS);
    }

    const stale = getStaleCached(cache.embed, key);
    if (stale !== undefined) {
        console.warn(`[AnimeUnity] embed stale fallback | path=${parts.url} ep=${target}`);
        return stale;
    }
    return setCached(cache.embed, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
}

function buildMfpHlsUrl(config, sourceUrl, referer) {
    const base = String(config?.mediaflow?.url || '').trim().replace(/\/+$/, '');
    if (!base || !sourceUrl) return null;
    const password = config?.mediaflow?.pass ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';
    const ref = referer ? `&h_Referer=${encodeURIComponent(referer)}` : '';
    let origin = 'https://vixsrc.to';
    try { origin = new URL(referer || sourceUrl).origin; } catch {}
    const org = origin ? `&h_Origin=${encodeURIComponent(origin)}` : '';
    const ua = `&h_User-Agent=${encodeURIComponent(USER_AGENT)}`;
    return `${base}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(sourceUrl)}${password}${ref}${org}${ua}`;
}

function qualityRank(value) {
    return { '4K': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '576p': 576, '480p': 480, Unknown: 0 }[String(value || 'Unknown')] || 0;
}

function languageRank(stream = {}) {
    const language = String(stream?.language || stream?.behaviorHints?.vortexMeta?.language || '').toLowerCase();
    if (/^(?:ita|it|italian)$/.test(language)) return 0;
    if (/^(?:jpn|jp|japanese)$/.test(language) || /sub\s*ita|vost/.test(language)) return 2;
    return 1;
}

function buildStream({ sourceUrl, referer, quality, title, langTag, emoji, reqHost, config, branch }) {
    const viaMfp = Boolean(config?.mediaflow?.url) && config?.filters?.animeUnityUseMfp !== false;
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

async function resolveCachedAnimeManifest(embedUrl) {
    const key = normalizeAnimeUrl(embedUrl) || String(embedUrl || '');
    if (!key) return null;
    const cached = getCached(cache.manifest, key);
    if (cached !== undefined) return cached;
    return singleFlight(`au:manifest:${key}`, async () => {
        const second = getCached(cache.manifest, key);
        if (second !== undefined) return second;
        try {
            const manifest = await resolveAnimeManifest(embedUrl);
            if (!manifest?.streamUrl) return setCached(cache.manifest, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
            return setCached(cache.manifest, key, manifest, MANIFEST_TTL_MS, MANIFEST_STALE_TTL_MS);
        } catch (error) {
            const stale = getStaleCached(cache.manifest, key);
            if (stale !== undefined) {
                console.warn(`[AnimeUnity] manifest stale fallback | embed=${key} reason=${error.message}`);
                return stale;
            }
            console.warn(`[AnimeUnity] manifest failed | embed=${key} reason=${error.message}`);
            return setCached(cache.manifest, key, null, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
        }
    });
}

async function inferCachedCanPlayFHD(streamUrl, referer) {
    const key = `${streamUrl || ''}|${referer || ''}`;
    if (!streamUrl) return false;
    const cached = getCached(cache.fhdProbe, key);
    if (cached !== undefined) return cached === true;
    return singleFlight(`au:fhd:${key}`, async () => {
        const second = getCached(cache.fhdProbe, key);
        if (second !== undefined) return second === true;
        try {
            const canPlay = await inferCanPlayFHDFromPlaylist(streamUrl, referer);
            return setCached(cache.fhdProbe, key, canPlay === true, FHD_PROBE_TTL_MS, FHD_PROBE_STALE_TTL_MS);
        } catch (error) {
            const stale = getStaleCached(cache.fhdProbe, key);
            if (stale !== undefined) {
                console.warn(`[AnimeUnity] fhd probe stale fallback | reason=${error.message}`);
                return stale === true;
            }
            return setCached(cache.fhdProbe, key, false, NEGATIVE_TTL_MS, NEGATIVE_TTL_MS);
        }
    });
}

async function buildStreamsFromEmbed(embedUrl, title, langTag, emoji, episodeNumber, config, reqHost) {
    const manifest = await resolveCachedAnimeManifest(embedUrl);
    if (!manifest?.streamUrl) return [];

    const fastStart = boolOption(config?.filters?.animeUnityFastStart, true);
    let canPlayFhd = manifest?.payload?.canPlayFHD === true;

    if (!canPlayFhd && !fastStart) {
        canPlayFhd = await inferCachedCanPlayFHD(manifest.streamUrl, manifest.referer || embedUrl);
    }

    if (!fastStart && !canPlayFhd) return [];

    return [buildStream({
        sourceUrl: manifest.streamUrl,
        referer: manifest.referer || embedUrl,
        quality: '1080p',
        title,
        langTag,
        emoji,
        reqHost,
        config,
        branch: fastStart ? 'animeunity-vix-1080-fast' : 'animeunity-vix-1080'
    })].filter(Boolean);
}

async function resolveAnimeUnityCandidate(candidate, title, mode, requestedEpisode, isMovie, config, reqHost, triedPaths) {
    let animePath = buildAnimePath(candidate);
    if (!animePath || triedPaths.has(`${mode.langTag}:${animePath}`)) return [];
    triedPaths.add(`${mode.langTag}:${animePath}`);

    let page = await fetchAnimePage(animePath);
    if (page && !candidateHasRequestedEpisode(page, candidate, requestedEpisode, isMovie)) {
        console.log(`[AnimeUnity] candidate rejected episode-missing | title=${buildCandidateTitle(candidate)} ep=${requestedEpisode} total=${knownEpisodeCount(page, candidate) || 'unknown'} mode=${mode.langTag}`);
        return [];
    }

    const variant = page ? selectRelatedVariant(page, mode.dubbed) : null;
    const variantPath = buildAnimePath(variant);
    if (variantPath && variantPath !== animePath && !triedPaths.has(`${mode.langTag}:${variantPath}`)) {
        animePath = variantPath;
        triedPaths.add(`${mode.langTag}:${animePath}`);
        page = await fetchAnimePage(animePath);
        if (page && !candidateHasRequestedEpisode(page, variant || candidate, requestedEpisode, isMovie)) {
            console.log(`[AnimeUnity] variant rejected episode-missing | title=${buildCandidateTitle(variant || candidate)} ep=${requestedEpisode} total=${knownEpisodeCount(page, variant || candidate) || 'unknown'} mode=${mode.langTag}`);
            return [];
        }
    }

    const embedUrl = await extractEmbedUrl(animePath, requestedEpisode, isMovie, variant || candidate);
    if (!embedUrl) {
        console.log(`[AnimeUnity] skip candidate without requested episode | ${animePath} ep=${requestedEpisode} mode=${mode.langTag}`);
        return [];
    }

    const pageTitle = buildCandidateTitle(page?.anime || {}) || buildCandidateTitle(variant || candidate);
    const displayTitle = `${title || pageTitle || 'Anime'} Ep ${requestedEpisode}`;
    return buildStreamsFromEmbed(embedUrl, displayTitle, mode.langTag, mode.emoji, requestedEpisode, config, reqHost);
}

async function resolveMode(mode, searchContext, config, reqHost) {
    const options = getAnimeUnityOptions(config);
    const titles = filterSeasonSpecificTitles(uniqueNonEmpty([
        ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
        searchContext?.title
    ]));
    const requestedEpisode = resolveRequestedAnimeEpisode(searchContext, searchContext?.meta || {});
    const isMovie = searchContext?.isMovie === true;
    const triedPaths = new Set();

    const mappedCandidates = extractAnimeUnityCandidatesFromMapping(searchContext?.mappingPayload, mode.dubbed);
    for (const candidate of mappedCandidates) {
        const streams = await resolveAnimeUnityCandidate(
            candidate,
            searchContext?.title || buildCandidateTitle(candidate),
            mode,
            requestedEpisode,
            isMovie,
            config,
            reqHost,
            triedPaths
        );
        if (streams.length > 0) {
            console.log(`[AnimeUnity] mapping hit | mode=${mode.langTag} | streams=${streams.length}`);
            return streams;
        }
    }

    for (const title of titles.slice(0, options.maxSearchTitles)) {
        const candidates = await searchAnimeCandidates(title, mode.dubbed, isMovie, options.candidateLimit, searchContext, options);
        for (const candidate of candidates) {
            const streams = await resolveAnimeUnityCandidate(candidate, title || searchContext?.title, mode, requestedEpisode, isMovie, config, reqHost, triedPaths);
            if (streams.length > 0) return streams;
        }
    }

    console.log(`[AnimeUnity] no embed for requested episode ep=${requestedEpisode} mode=${mode.langTag}`);
    return [];
}

function boolOption(value, fallback) {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on', 'always'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off', 'never'].includes(normalized)) return false;
    }
    return fallback;
}

function intOption(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function getAnimeUnityOptions(config = {}) {
    const filters = config?.filters || {};
    return {
        enabledDubbed: boolOption(filters.enableAnimeUnityDubbed, true),
        enabledSub: boolOption(filters.enableAnimeUnitySub, true),
        preferDubbed: boolOption(filters.animeUnityPreferDubbed, true),
        strictAnimeOnly: boolOption(filters.animeUnityStrictAnimeOnly, true),
        searchConcurrency: intOption(filters.animeUnitySearchConcurrency, DEFAULT_SEARCH_CONCURRENCY, 1, 8),
        candidateLimit: intOption(filters.animeUnityCandidateLimit, 4, 1, 8),
        maxSearchTitles: intOption(filters.animeUnityMaxSearchTitles, 8, 1, 12),
        maxTitleVariants: intOption(filters.animeUnityMaxTitleVariants, 6, 1, 8),
        useMapping: boolOption(filters.animeUnityUseMapping, true)
    };
}

function textFromUnknown(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(textFromUnknown).join(' ');
    if (typeof value === 'object') return Object.values(value).map(textFromUnknown).join(' ');
    return String(value);
}

function hasAnimeMarker(text) {
    const normalized = ` ${normalizeLookupTitle(text)} `;
    return /\b(?:anime|kitsu|anilist|myanimelist|mal|manga|otaku|japanese animation|animazione giapponese)\b/i.test(normalized);
}

function hasJapanHint(meta = {}, context = {}) {
    const text = textFromUnknown([
        meta?.originalLanguage, meta?.original_language, meta?.language, meta?.languages,
        meta?.country, meta?.countries, meta?.production_countries,
        context?.originalLanguage, context?.country, context?.countries
    ]);
    const normalized = ` ${normalizeLookupTitle(text)} `;
    return /\b(?:ja|jp|jpn|japan|japanese|giappone|giapponese)\b/i.test(normalized);
}

function shouldRunAnimeUnity(requestId, meta = {}, context = {}, options = {}) {
    if (options.strictAnimeOnly === false) return true;
    if (resolveExplicitKitsuRequestId(requestId, meta)) return true;
    if (context?.strictKitsu || context?.kitsuId || context?.kitsu_id || context?.isAnime === true || meta?.isAnime === true) return true;
    const idText = textFromUnknown([requestId, meta?.id, meta?.requestedId, meta?.originalId]);
    if (/\b(?:kitsu|anilist|mal)[:_\-]/i.test(idText)) return true;
    const sourceText = textFromUnknown([context?.identitySources, context?.sources, meta?.identitySources]);
    if (hasAnimeMarker(sourceText)) return true;
    const contentText = textFromUnknown([
        meta?.genres, meta?.genre, meta?.type, meta?.kind, meta?.category, meta?.description,
        context?.genres, context?.genre, context?.type, context?.kind, context?.category
    ]);
    if (hasAnimeMarker(contentText)) return true;
    if (hasJapanHint(meta, context) && /\b(?:animation|animazione|anime)\b/i.test(` ${normalizeLookupTitle(contentText)} `)) return true;
    return false;
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
        const lang = languageRank(a) - languageRank(b);
        if (lang !== 0) return lang;
        const qa = qualityRank(b?.quality) - qualityRank(a?.quality);
        if (qa !== 0) return qa;
        const la = String(a?.language || '').localeCompare(String(b?.language || ''));
        return la || String(a?.title || '').localeCompare(String(b?.title || ''));
    });
}

async function searchAnimeUnityImpl(requestId, meta = {}, config = {}, reqHost = null) {
    const filters = config?.filters || {};
    if (Object.prototype.hasOwnProperty.call(filters, 'enableAnimeUnity') && filters.enableAnimeUnity === false) return [];
    const options = getAnimeUnityOptions(config);
    if (!options.enabledDubbed && !options.enabledSub) return [];

    try {
        const kitsuRequestId = resolveExplicitKitsuRequestId(requestId, meta);
        let context = kitsuRequestId
            ? buildStrictKitsuContext(await kitsuProvider.buildSearchContext(kitsuRequestId, meta))
            : await animeIdentity.buildAnimeSearchContextForProvider({
                requestId,
                meta,
                config,
                providerName: 'AnimeUnity'
            });

        if (!kitsuRequestId && !context?.title && !context?.searchTitles?.length && !context?.rawTitles?.length) {
            context = await kitsuProvider.buildSearchContext(requestId, meta);
        }
        context = { ...(context || {}), meta };
        if (!context?.title && !context?.searchTitles?.length && !context?.rawTitles?.length) return [];

        if (!shouldRunAnimeUnity(requestId, meta, context, options)) {
            console.log(`[AnimeUnity] gate skip non-anime | title=${context.title || meta?.title || meta?.name || requestId}`);
            return [];
        }

        if (options.useMapping) {
            const mappingPayload = await fetchAnimeUnityMapping(context, resolveRequestedAnimeEpisode(context, meta));
            if (mappingPayload) context = { ...context, mappingPayload };
        }

        console.log(`[AnimeUnity] start | title=${context.title || meta?.title || meta?.name || requestId} | ep=${context.requestedEpisode || meta?.episode || 1} | kitsu=${context.kitsuId || context.kitsu_id || 'no'} | tmdb=${context.tmdbId || context.tmdb_id || 'no'} | imdb=${context.imdbId || context.imdb_id || 'no'} | concurrency=${options.searchConcurrency} | mapping=${Boolean(context.mappingPayload)}`);

        const modes = [];
        if (options.enabledDubbed) modes.push({ dubbed: true, langTag: 'ITA', emoji: '🇮🇹' });
        if (options.enabledSub) modes.push({ dubbed: false, langTag: 'SUB ITA', emoji: '🇯🇵' });
        if (!options.preferDubbed) modes.reverse();

        const settled = await Promise.allSettled(modes.map((mode) => resolveMode(mode, context, config, reqHost)));
        const streams = normalizeStreams(
            dedupeStreams(settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])),
            {
                provider: 'animeunity',
                providerLabel: PROVIDER_NAME,
                providerCode: PROVIDER_CODE,
                sort: false,
                debug: process.env.ANIMEUNITY_DEBUG === '1'
            }
        );
        console.log(`[AnimeUnity] done | streams=${streams.length}`);
        return streams;
    } catch (error) {
        console.error(`[AnimeUnity] error: ${error.message}`);
        return [];
    }
}

async function searchAnimeUnity(requestId, meta = {}, config = {}, reqHost = null) {
    return withProviderHealth('animeunity', () => searchAnimeUnityImpl(requestId, meta, config, reqHost), {
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = { searchAnimeUnity };
