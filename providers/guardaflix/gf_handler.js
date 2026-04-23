const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { URL } = require('url');
const {
    buildWebStream,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistQuality,
    qualityRank
} = require('../extractors/common');
const { extractFromUrl } = require('../extractors/registry');

const CONFIG = {
    BASE_URL: 'https://guardaplay.live/',
    TMDB_API_KEY: '5bae8d11f2a7bc7a95c6d040a31d2163',
    TIMEOUT: 15000,
    PROBE_TIMEOUT: 5000,
    SEARCH_ACCEPT_THRESHOLD: 1.45,
    SEARCH_SOFT_THRESHOLD: 1.10,
    MAX_IFRAME_DEPTH: 3,
    MAX_IFRAMES_PER_PAGE: 18,
    MAX_NESTED_IFRAMES_PER_NODE: 8,
    IFRAME_CONCURRENCY: 4,
    TMDB_META_TTL_MS: 6 * 60 * 60 * 1000,
    SEARCH_TTL_MS: 2 * 60 * 60 * 1000,
    PAGE_JOBS_TTL_MS: 10 * 60 * 1000,
    PLAYLIST_QUALITY_TTL_MS: 8 * 60 * 60 * 1000,
    CACHE_SWEEP_INTERVAL_OPS: 50,
    CACHE_MAX_ITEMS: 600
};

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SITE_HOST = new URL(CONFIG.BASE_URL).hostname;
const SITE_ORIGIN = new URL(CONFIG.BASE_URL).origin;

const logDebug = (msg, ...args) => {
    console.log(`[GuardaFlix-Live] ${msg}`, ...args);
};

class TTLCache {
    constructor({ ttl, max = CONFIG.CACHE_MAX_ITEMS, name = 'cache' }) {
        this.ttl = ttl;
        this.max = max;
        this.name = name;
        this.map = new Map();
        this.ops = 0;
    }

    get(key) {
        this.ops++;
        if (this.ops % CONFIG.CACHE_SWEEP_INTERVAL_OPS === 0) this.sweep();
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            this.map.delete(key);
            return undefined;
        }
        entry.lastAccess = Date.now();
        return entry.value;
    }

    set(key, value, ttl = this.ttl) {
        this.ops++;
        if (this.map.size >= this.max) this.evictOne();
        this.map.set(key, {
            value,
            expiresAt: Date.now() + ttl,
            lastAccess: Date.now()
        });
        if (this.ops % CONFIG.CACHE_SWEEP_INTERVAL_OPS === 0) this.sweep();
        return value;
    }

    delete(key) {
        this.map.delete(key);
    }

    sweep() {
        const now = Date.now();
        for (const [key, entry] of this.map.entries()) {
            if (entry.expiresAt <= now) this.map.delete(key);
        }
        while (this.map.size > this.max) this.evictOne();
    }

    evictOne() {
        let oldestKey = null;
        let oldestAccess = Number.POSITIVE_INFINITY;
        for (const [key, entry] of this.map.entries()) {
            if (entry.lastAccess < oldestAccess) {
                oldestAccess = entry.lastAccess;
                oldestKey = key;
            }
        }
        if (oldestKey !== null) this.map.delete(oldestKey);
    }
}

const tmdbMetaCache = new TTLCache({ ttl: CONFIG.TMDB_META_TTL_MS, name: 'tmdbMeta' });
const searchCache = new TTLCache({ ttl: CONFIG.SEARCH_TTL_MS, name: 'search' });
const pageJobsCache = new TTLCache({ ttl: CONFIG.PAGE_JOBS_TTL_MS, name: 'pageJobs' });
const playlistQualityCache = new TTLCache({ ttl: CONFIG.PLAYLIST_QUALITY_TTL_MS, name: 'playlistQuality' });

const inflight = new Map();

async function runSingleFlight(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = Promise.resolve()
        .then(fn)
        .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
}

function createLimiter(concurrency) {
    let active = 0;
    const queue = [];

    const next = () => {
        if (active >= concurrency || queue.length === 0) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                active--;
                next();
            });
    };

    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

const strictHttpsAgent = new https.Agent({ rejectUnauthorized: true, keepAlive: true, maxSockets: 32 });
const looseHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 32 });

const strictHttpClient = axios.create({ timeout: CONFIG.TIMEOUT, httpsAgent: strictHttpsAgent, maxRedirects: 5 });
const looseHttpClient = axios.create({ timeout: CONFIG.TIMEOUT, httpsAgent: looseHttpsAgent, maxRedirects: 5 });

function defaultHeaders(extra = {}) {
    return {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        ...extra
    };
}

function isLikelySiteUrl(targetUrl) {
    try {
        const hostname = new URL(targetUrl).hostname;
        return hostname === SITE_HOST || hostname.endsWith(`.${SITE_HOST}`);
    } catch {
        return false;
    }
}

function isPossiblyProtectedError(error) {
    const status = error?.response?.status || error?.statusCode || error?.status;
    if ([401, 403, 429, 500, 502, 503, 504, 521, 522, 523, 524].includes(status)) return true;
    const msg = String(error?.message || '').toLowerCase();
    return msg.includes('tls') || msg.includes('ssl') || msg.includes('socket hang up') || msg.includes('econnreset') || msg.includes('certificate') || msg.includes('unexpected end');
}

let gotScrapingInstance = null;
async function getGotScraping() {
    if (!gotScrapingInstance) {
        const mod = await import('got-scraping');
        gotScrapingInstance = mod.gotScraping;
    }
    return gotScrapingInstance;
}

async function fetchWithGot(targetUrl, customHeaders = {}, responseType = 'text') {
    const gotScraping = await getGotScraping();
    const response = await gotScraping({
        url: targetUrl,
        headers: defaultHeaders(customHeaders),
        retry: { limit: 2 },
        responseType: responseType === 'json' ? 'text' : responseType,
        https: { rejectUnauthorized: false },
        timeout: { request: CONFIG.TIMEOUT },
        throwHttpErrors: false,
        followRedirect: true
    });

    if (response.statusCode < 200 || response.statusCode >= 400) {
        const error = new Error(`got-scraping HTTP ${response.statusCode} for ${targetUrl}`);
        error.status = response.statusCode;
        throw error;
    }

    if (responseType === 'json') {
        try {
            return { data: JSON.parse(response.body), status: response.statusCode, headers: response.headers, via: 'got' };
        } catch (error) {
            error.message = `Invalid JSON via got-scraping: ${error.message}`;
            throw error;
        }
    }

    return { data: response.body, status: response.statusCode, headers: response.headers, via: 'got' };
}

async function fetchViaAxios(client, targetUrl, options = {}) {
    const response = await client({
        url: targetUrl,
        method: 'GET',
        validateStatus: (status) => status >= 200 && status < 400,
        responseType: options.responseType || 'text',
        headers: defaultHeaders(options.headers || {})
    });
    return { data: response.data, status: response.status, headers: response.headers, via: options.via || 'axios' };
}

async function fetchSmart(targetUrl, options = {}) {
    const isSite = isLikelySiteUrl(targetUrl) || options.preferLoose || options.allowGotFallback;
    const attempts = [
        async () => fetchViaAxios(strictHttpClient, targetUrl, { ...options, via: 'axios-strict' }),
        async () => isSite ? fetchViaAxios(looseHttpClient, targetUrl, { ...options, via: 'axios-loose' }) : null,
        async () => (isSite || options.allowGotFallback) ? fetchWithGot(targetUrl, options.headers || {}, options.responseType || 'text') : null
    ];

    let lastError = null;
    for (const attempt of attempts) {
        try {
            const result = await attempt();
            if (result) return result;
        } catch (error) {
            lastError = error;
            if (!isPossiblyProtectedError(error)) break;
        }
    }
    throw lastError || new Error(`Fetch failed: ${targetUrl}`);
}

const REGEX = {
    CLEAN_TITLE: /guardaflix|guardaplay|film streaming ita|film completo|streaming/gi,
    NON_ALNUM: /[^a-z0-9]+/g,
    YEAR: /\b(19\d{2}|20\d{2})\b/,
    NOISE: /\b(altadefinizione|guardaflix|guardaplay|film|serie|streaming|sub(?:b?ita)?|ita|hd|fullhd|uhd|1080p|720p|4k)\b/gi,
    ACCEPTABLE_PATH: /(\/film\/|\/movie\/|\/guarda\/|\/streaming\/|\/titles?\/|\/watch\/)/i
};

function cleanTitle(text) {
    return String(text || '').replace(REGEX.CLEAN_TITLE, ' ').replace(/\s+/g, ' ').trim();
}

function cleanDisplayTitle(text) {
    return cleanTitle(String(text || ''))
        .normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFFF0-\uFFFF]/g, ' ')
        .replace(/[\[\]{}]+/g, ' ')
        .replace(/[?]{2,}/g, ' ')
        .replace(/[^\p{L}\p{N}\p{M}\s:;.,'’&\-()!/]/gu, ' ')
        .replace(/^\?+\s*/g, '')
        .replace(/^[^\p{L}\p{N}]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeText(text) {
    return cleanTitle(String(text || ''))
        .toLowerCase()
        .replace(REGEX.NOISE, ' ')
        .replace(REGEX.NON_ALNUM, '')
        .trim();
}

function slugify(text) {
    return cleanTitle(String(text || ''))
        .toLowerCase()
        .replace(/["'’:`]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]+/g, '')
        .replace(/\-+/g, '-')
        .replace(/^-|-$/g, '');
}

function tokenizeTitle(text) {
    return cleanTitle(String(text || ''))
        .toLowerCase()
        .replace(REGEX.NOISE, ' ')
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter((token) => token && token.length > 1);
}

function uniqueStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const key = String(value || '').trim();
        if (!key || seen.has(key.toLowerCase())) continue;
        seen.add(key.toLowerCase());
        out.push(key);
    }
    return out;
}

function safeAbsoluteUrl(value, base = SITE_ORIGIN) {
    try {
        if (!value) return null;
        if (/^https?:\/\//i.test(value)) return new URL(value).href;
        if (String(value).startsWith('//')) return `https:${value}`;
        return new URL(value, base).href;
    } catch {
        return null;
    }
}

function inferYearFromMeta(meta) {
    const candidates = [meta?.year, meta?.releaseYear, meta?.released, meta?.release_date, meta?.first_air_date, meta?.name, meta?.title, meta?.id];
    for (const candidate of candidates) {
        const match = String(candidate || '').match(REGEX.YEAR);
        if (match) return match[1];
    }
    return '';
}

function resolveTmdbMovieId(meta) {
    const direct = String(meta?.tmdb_id || meta?.tmdbId || '').trim();
    if (/^\d+$/.test(direct)) return direct;
    const metaId = String(meta?.id || '').trim();
    const match = metaId.match(/^tmdb:(\d+)/i);
    return match ? match[1] : null;
}

function getMetaTitleCandidates(meta) {
    return uniqueStrings([
        meta?.name,
        meta?.title,
        meta?.original_name,
        meta?.original_title,
        meta?.canonical_title,
        meta?.aka,
        meta?.imdb_data?.title
    ]);
}

async function fetchTmdbFindByImdb(imdbId) {
    if (!/^tt\d+$/i.test(String(imdbId || '').trim())) return null;
    const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${CONFIG.TMDB_API_KEY}&external_source=imdb_id&language=it-IT`;
    const res = await fetchSmart(url, { responseType: 'json' });
    return res.data?.movie_results?.[0] || null;
}

async function fetchTmdbMovie(tmdbId) {
    if (!/^\d+$/.test(String(tmdbId || '').trim())) return null;
    const url = `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}?api_key=${CONFIG.TMDB_API_KEY}&language=it-IT`;
    const res = await fetchSmart(url, { responseType: 'json' });
    return res.data || null;
}

async function searchTmdbMovieByTitle(title, year) {
    const safeTitle = String(title || '').trim();
    if (!safeTitle) return null;
    const params = new URLSearchParams({
        api_key: CONFIG.TMDB_API_KEY,
        language: 'it-IT',
        query: safeTitle,
        include_adult: 'false'
    });
    if (/^\d{4}$/.test(String(year || ''))) params.set('year', String(year));
    const url = `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
    const res = await fetchSmart(url, { responseType: 'json' });
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    return results[0] || null;
}

function tmdbToMeta(media, fallback = {}) {
    if (!media) return null;
    return {
        title_it: media.title || media.name || fallback.title_it || null,
        title_orig: media.original_title || media.original_name || fallback.title_orig || null,
        year: String(media.release_date || media.first_air_date || fallback.year || '').slice(0, 4),
        tmdb_id: media.id ? String(media.id) : fallback.tmdb_id || null,
        imdb_id: fallback.imdb_id || null
    };
}

function normalizeStreamKey(inputUrl) {
    try {
        const parsed = new URL(inputUrl);
        const removable = ['token', 'expires', 'exp', 'signature', 'sig', 'auth', 'auth_token', 't', 'ts', 'e', 'hash'];
        for (const key of removable) parsed.searchParams.delete(key);
        const sorted = [...parsed.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        parsed.search = new URLSearchParams(sorted).toString();
        return `${parsed.hostname}${parsed.pathname}${parsed.search ? `?${parsed.search}` : ''}`;
    } catch {
        return String(inputUrl || '');
    }
}

function playlistQualityCacheKey(inputUrl) {
    return normalizeStreamKey(inputUrl);
}

async function resolveExtractedQuality(client, extracted) {
    let quality = normalizeQuality(extracted?.quality || 'Unknown');
    const url = String(extracted?.url || '');
    if (!/\.m3u8($|\?)/i.test(url)) return quality;

    const cacheKey = playlistQualityCacheKey(url);
    const cached = playlistQualityCache.get(cacheKey);
    if (cached) return pickBetterQuality(cached, quality);

    const shouldProbe = /unknown|sd|hd|auto/i.test(String(quality || '')) || !quality;
    if (!shouldProbe) return quality;

    try {
        const probed = await probePlaylistQuality(client, url, {
            headers: extracted?.headers || {},
            timeout: CONFIG.PROBE_TIMEOUT
        });
        const finalQuality = pickBetterQuality(probed || 'Unknown', quality);
        playlistQualityCache.set(cacheKey, finalQuality);
        return finalQuality;
    } catch {
        return quality;
    }
}

function extractScriptEmbeds(html, baseUrl) {
    const out = [];
    const regexes = [
        /https?:\/\/[^"'`\s<>()]+/gi,
        /\/\/[^"'`\s<>()]+/gi
    ];
    for (const regex of regexes) {
        const matches = String(html || '').match(regex) || [];
        for (const match of matches) {
            const candidate = safeAbsoluteUrl(match, baseUrl);
            if (!candidate) continue;
            if (!/(embed|iframe|player|stream|loadm|mixdrop|voe|supervideo|maxstream|vix|m3u8)/i.test(candidate)) continue;
            out.push(candidate);
        }
    }
    return out;
}

function parsePageJobs(html, pageUrl) {
    const $ = cheerio.load(html);
    const mediaTitle = cleanTitle($('meta[property="og:title"]').attr('content') || $('title').text());

    const optLangMap = {};
    $('a[href^="#options-"]').each((_, el) => {
        const key = $(el).attr('href')?.substring(1);
        if (!key) return;
        const text = $(el).text().toLowerCase();
        optLangMap[key] = text.includes('sub');
    });

    let defaultIsSub = false;
    $('span[class*="btn"], .btn, button, a').each((_, el) => {
        const text = $(el).text().toLowerCase();
        if (!text) return;
        if ($(el).hasClass('active') && text.includes('sub')) defaultIsSub = true;
    });

    const jobs = [];
    const pushJob = (src, isSub, source = 'iframe') => {
        const absolute = safeAbsoluteUrl(src, pageUrl);
        if (!absolute) return;
        jobs.push({ src: absolute, isSub: !!isSub, source });
    };

    const optionDivs = $('div[id^="options-"]');
    if (optionDivs.length > 0) {
        optionDivs.each((_, div) => {
            const optionId = $(div).attr('id');
            const isSub = optLangMap[optionId] ?? defaultIsSub;
            $(div).find('iframe[src], iframe[data-src], iframe[data-lazy-src]').each((__, iframe) => {
                const src = $(iframe).attr('data-src') || $(iframe).attr('data-lazy-src') || $(iframe).attr('src');
                pushJob(src, isSub, 'option-iframe');
            });
        });
    }

    if (jobs.length === 0) {
        $('iframe[src], iframe[data-src], iframe[data-lazy-src]').each((_, iframe) => {
            const src = $(iframe).attr('data-src') || $(iframe).attr('data-lazy-src') || $(iframe).attr('src');
            const textBlob = [$(iframe).attr('title'), $(iframe).closest('[class],[id]').text()].filter(Boolean).join(' ').toLowerCase();
            const isSub = textBlob.includes('sub') ? true : defaultIsSub;
            pushJob(src, isSub, 'page-iframe');
        });
    }

    if (jobs.length === 0) {
        for (const embed of extractScriptEmbeds(html, pageUrl)) {
            pushJob(embed, defaultIsSub, 'script-url');
        }
    }

    const deduped = [];
    const seen = new Set();
    for (const job of jobs) {
        const key = `${job.src}|${job.isSub ? 'sub' : 'ita'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(job);
        if (deduped.length >= CONFIG.MAX_IFRAMES_PER_PAGE) break;
    }

    return {
        mediaTitle,
        jobs: deduped,
        defaultIsSub
    };
}

function createStreamFingerprint(stream) {
    const extractor = String(stream?.extractor || '').toLowerCase();
    const quality = normalizeQuality(stream?.quality || 'Unknown');
    const urlKey = normalizeStreamKey(stream?.url || '');
    let hostPath = urlKey;
    try {
        const parsed = new URL(stream.url);
        hostPath = `${parsed.hostname}${parsed.pathname}`;
    } catch {}
    return `${extractor}|${quality}|${hostPath}`;
}

function getStreamWeight(stream) {
    const qr = qualityRank(stream?.quality);
    const priority = Number.isFinite(stream?._priority) ? stream._priority : 9;
    const proxyBonus = /\[MFP\]/i.test(String(stream?.name || '')) ? 0.15 : 0;
    return qr * 100 - priority + proxyBonus;
}

function dedupeStreams(streams) {
    const byFingerprint = new Map();
    for (const stream of streams) {
        const fingerprint = createStreamFingerprint(stream);
        const current = byFingerprint.get(fingerprint);
        if (!current || getStreamWeight(stream) > getStreamWeight(current)) {
            byFingerprint.set(fingerprint, stream);
        }
    }

    return [...byFingerprint.values()]
        .sort((a, b) => {
            const qualityDelta = qualityRank(b.quality) - qualityRank(a.quality);
            if (qualityDelta !== 0) return qualityDelta;
            const priorityDelta = (a._priority || 9) - (b._priority || 9);
            if (priorityDelta !== 0) return priorityDelta;
            return String(a.name || '').localeCompare(String(b.name || ''));
        })
        .map((stream) => {
            const { _priority, _fingerprint, ...clean } = stream;
            return clean;
        });
}

function shouldProxyWithMediaflow(config, extracted) {
    if (!config?.mediaflow?.url) return false;
    const url = String(extracted?.url || '');
    const headers = extracted?.headers || {};
    if (!url || !/\.m3u8($|\?)/i.test(url)) return false;
    if (!headers.Referer && !headers.referer && !headers.Origin && !headers.origin) return false;

    const extractor = String(extracted?.name || '').toLowerCase();
    const directUrl = String(extracted?.url || '').toLowerCase();
    return [
        'loadm',
        'mixdrop',
        'supervideo',
        'voe',
        'maxstream',
        'streamtape'
    ].some((token) => extractor.includes(token) || directUrl.includes(token));
}

function applyMediaflow(config, extracted) {
    const originalHeaders = extracted?.headers || {};
    const referer = originalHeaders.Referer || originalHeaders.referer || '';
    const origin = originalHeaders.Origin || originalHeaders.origin || (referer ? new URL(referer).origin : '');
    const mfp = String(config.mediaflow.url || '').replace(/\/$/, '');
    const pass = config.mediaflow.pass ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';
    const url = `${mfp}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(extracted.url)}${pass}${referer ? `&h_Referer=${encodeURIComponent(referer)}` : ''}${origin ? `&h_Origin=${encodeURIComponent(origin)}` : ''}`;
    return { url, referer, origin };
}

function scoreCandidate(queryTitle, year, href, text) {
    let score = 0;
    const cleanQuery = cleanTitle(queryTitle);
    const cleanCandidate = cleanTitle(text);
    const queryNorm = normalizeText(cleanQuery);
    const candNorm = normalizeText(cleanCandidate);
    const querySlug = slugify(cleanQuery);
    const candSlug = slugify(cleanCandidate);
    const hrefLower = String(href || '').toLowerCase();

    if (!cleanCandidate) score -= 0.45;
    if (queryNorm && candNorm) {
        if (queryNorm === candNorm) score += 7.5;
        else if (candNorm.includes(queryNorm) || queryNorm.includes(candNorm)) score += 4.1;
    }

    const qTokens = tokenizeTitle(cleanQuery);
    const cTokens = tokenizeTitle(cleanCandidate);
    if (qTokens.length && cTokens.length) {
        const cSet = new Set(cTokens);
        const shared = qTokens.filter((token) => cSet.has(token)).length;
        const ratio = shared / Math.max(qTokens.length, 1);
        score += ratio * 3.25;
    }

    if (querySlug && (querySlug === candSlug || hrefLower.includes(querySlug))) score += 2.1;
    if (year && (cleanCandidate.includes(year) || hrefLower.includes(year))) score += 1.15;
    if (/\/serie\//i.test(hrefLower)) score -= 6;
    if (/trailer|episodio|stagione|serie tv/i.test(cleanCandidate)) score -= 2.5;
    if (/sub/i.test(cleanCandidate)) score -= 0.2;
    return score;
}

function collectSearchCandidates($, queryTitle, year) {
    const out = [];
    const seen = new Set();

    const push = (href, text, source) => {
        const finalHref = safeAbsoluteUrl(href, SITE_ORIGIN);
        if (!finalHref) return;
        const key = finalHref.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
            href: finalHref,
            text: cleanTitle(text || ''),
            source,
            score: scoreCandidate(queryTitle, year, finalHref, text || '')
        });
    };

    $('a[href]').each((_, el) => {
        const $el = $(el);
        const href = $el.attr('href');
        if (!href) return;
        const absoluteHref = safeAbsoluteUrl(href, SITE_ORIGIN);
        if (!absoluteHref) return;
        const hrefLower = absoluteHref.toLowerCase();
        if (!REGEX.ACCEPTABLE_PATH.test(hrefLower)) return;

        const article = $el.closest('article, .post, .item, .result, .ml-item, .movie, .film, .box, .entry, li');
        const text =
            $el.text().trim() ||
            $el.attr('title') ||
            $el.find('img').attr('alt') ||
            article.find('h1, h2, h3, h4').first().text().trim() ||
            article.find('img').first().attr('alt') ||
            article.attr('title') ||
            article.find('.title, .entry-title, .post-title').first().text().trim() ||
            '';

        push(absoluteHref, text, 'anchor');
    });

    $('article, .post, .item, .result, .ml-item, .movie, .film, li').each((_, el) => {
        const $box = $(el);
        const anchor = $box.find('a[href]').first();
        if (!anchor.length) return;
        const href = anchor.attr('href');
        const text =
            $box.find('h1, h2, h3, h4').first().text().trim() ||
            anchor.attr('title') ||
            $box.find('img').first().attr('alt') ||
            anchor.text().trim() ||
            '';
        push(href, text, 'box');
    });

    out.sort((a, b) => b.score - a.score);
    return out;
}

class GuardaFlixScraper {
    constructor(config) {
        this.config = config || {};
        this.iframeLimiter = createLimiter(CONFIG.IFRAME_CONCURRENCY);
        this.visitedIframes = new Set();
        logDebug('Inizializzato', {
            baseUrl: CONFIG.BASE_URL,
            mediaflow: !!this.config?.mediaflow?.url,
            iframeConcurrency: CONFIG.IFRAME_CONCURRENCY,
            maxDepth: CONFIG.MAX_IFRAME_DEPTH
        });
    }

    async getTmdbMeta(metaInput) {
        const cacheKey = JSON.stringify({
            imdb: String(metaInput?.imdb_id || '').trim(),
            tmdb: String(metaInput?.tmdb_id || metaInput?.tmdbId || '').trim(),
            id: String(metaInput?.id || '').trim(),
            titles: getMetaTitleCandidates(metaInput),
            year: inferYearFromMeta(metaInput)
        });

        const cached = tmdbMetaCache.get(cacheKey);
        if (cached) return cached;

        return runSingleFlight(`tmdb:${cacheKey}`, async () => {
            const cachedAgain = tmdbMetaCache.get(cacheKey);
            if (cachedAgain) return cachedAgain;

            try {
                const explicitImdb = /^tt\d+$/i.test(String(metaInput?.imdb_id || metaInput || '').trim())
                    ? String(metaInput?.imdb_id || metaInput).trim()
                    : null;
                const explicitTmdb = resolveTmdbMovieId(metaInput);
                const year = inferYearFromMeta(metaInput);
                const titleCandidates = getMetaTitleCandidates(metaInput);

                let media = null;
                if (explicitImdb) {
                    logDebug(`TMDb lookup via IMDb: ${explicitImdb}`);
                    media = await fetchTmdbFindByImdb(explicitImdb);
                }
                if (!media && explicitTmdb) {
                    logDebug(`TMDb lookup via TMDb ID: ${explicitTmdb}`);
                    media = await fetchTmdbMovie(explicitTmdb);
                }
                if (!media) {
                    for (const title of titleCandidates) {
                        logDebug(`TMDb search fallback: ${title} (${year || 'no-year'})`);
                        media = await searchTmdbMovieByTitle(title, year);
                        if (media) break;
                    }
                }

                if (!media) {
                    logDebug('TMDb non ha restituito risultati utili');
                    tmdbMetaCache.set(cacheKey, null, 60 * 1000);
                    return null;
                }

                const meta = tmdbToMeta(media, {
                    imdb_id: explicitImdb,
                    tmdb_id: explicitTmdb,
                    year
                });
                logDebug('TMDb meta risolti', meta);
                tmdbMetaCache.set(cacheKey, meta);
                return meta;
            } catch (err) {
                logDebug('Errore getTmdbMeta:', err.message);
                return null;
            }
        });
    }

    async searchMovie(title, year) {
        const cacheKey = `${String(title || '').trim().toLowerCase()}|${String(year || '')}`;
        const cached = searchCache.get(cacheKey);
        if (cached !== undefined) return cached;

        return runSingleFlight(`search:${cacheKey}`, async () => {
            const cachedAgain = searchCache.get(cacheKey);
            if (cachedAgain !== undefined) return cachedAgain;

            try {
                const queryUrl = `${SITE_ORIGIN}/?s=${encodeURIComponent(title)}`;
                logDebug(`Ricerca sito: ${queryUrl}`);
                const startedAt = Date.now();
                const res = await fetchSmart(queryUrl, {
                    responseType: 'text',
                    allowGotFallback: true,
                    preferLoose: true
                });
                const $ = cheerio.load(res.data);
                const candidates = collectSearchCandidates($, title, year);
                const best = candidates[0] || null;

                let finalHref = null;
                if (best) {
                    const hrefLower = String(best.href).toLowerCase();
                    const titleSlug = slugify(cleanTitle(title));
                    const hrefLooksRight =
                        (titleSlug && hrefLower.includes(titleSlug)) ||
                        (year && hrefLower.includes(String(year)));

                    if (best.score >= CONFIG.SEARCH_ACCEPT_THRESHOLD || (hrefLooksRight && best.score >= CONFIG.SEARCH_SOFT_THRESHOLD)) {
                        finalHref = best.href;
                    }
                }

                logDebug('Risultato search', {
                    title,
                    year,
                    via: res.via,
                    ms: Date.now() - startedAt,
                    bestScore: best?.score ?? null,
                    finalHref,
                    bestText: best?.text || null,
                    bestSource: best?.source || null
                });

                searchCache.set(cacheKey, finalHref, finalHref ? undefined : 2 * 60 * 1000);
                return finalHref;
            } catch (err) {
                logDebug('Errore searchMovie:', err.message);
                searchCache.set(cacheKey, null, 2 * 60 * 1000);
                return null;
            }
        });
    }

    buildStreamFromExtractor(extracted, mediaTitle, isSub, resolvedQuality = null) {
        const langTag = isSub ? 'SUB ITA' : 'ITA';
        const displayTitle = cleanDisplayTitle(mediaTitle) || 'Stream';
        const finalTitle = `${displayTitle} - ${langTag}`;
        const originalHeaders = extracted?.headers || null;
        const quality = normalizeQuality(resolvedQuality || extracted?.quality || 'Unknown');
        let streamName = '?? GuardaFlix';
        let streamUrl = extracted.url;
        let modeLabel = 'Direct';
        let headers = originalHeaders;

        if (shouldProxyWithMediaflow(this.config, extracted)) {
            try {
                const proxied = applyMediaflow(this.config, extracted);
                streamUrl = proxied.url;
                streamName = '?? GuardaFlix [MFP]';
                modeLabel = 'Proxy';
                headers = null;
                logDebug(`MediaFlow applicato a ${extracted.name}`);
            } catch (error) {
                logDebug(`MediaFlow skip per ${extracted.name}: ${error.message}`);
            }
        }

        const stream = buildWebStream({
            name: streamName,
            title: `${finalTitle}\n${extracted.name} (${modeLabel})`,
            url: streamUrl,
            extractor: extracted.name,
            provider: 'GuardaFlix',
            providerCode: 'GF',
            quality,
            headers
        });

        stream._priority = extracted.priority ?? 9;
        stream._fingerprint = createStreamFingerprint(stream);
        return stream;
    }

    async processIframe(src, pageUrl, mediaTitle, isSub, depth = 0) {
        if (!src || depth > CONFIG.MAX_IFRAME_DEPTH) return [];
        const absoluteSrc = safeAbsoluteUrl(src, pageUrl);
        if (!absoluteSrc) return [];

        const visitKey = `${absoluteSrc}|${isSub ? 'sub' : 'ita'}`;
        if (this.visitedIframes.has(visitKey)) return [];
        this.visitedIframes.add(visitKey);

        return this.iframeLimiter(async () => {
            try {
                logDebug(`Iframe resolve depth=${depth}`, absoluteSrc);
                const extracted = await extractFromUrl(absoluteSrc, {
                    client: looseHttpClient,
                    userAgent: USER_AGENT,
                    requestReferer: pageUrl,
                    fetchers: [
                        (targetUrl, headers) => fetchWithGot(targetUrl, headers, 'text').then((r) => r.data)
                    ]
                });

                if (extracted?.url) {
                    const quality = await resolveExtractedQuality(looseHttpClient, extracted);
                    return [this.buildStreamFromExtractor(extracted, mediaTitle, isSub, quality)];
                }

                const res = await fetchSmart(absoluteSrc, {
                    responseType: 'text',
                    headers: { Referer: pageUrl },
                    allowGotFallback: true,
                    preferLoose: true
                });
                const $ = cheerio.load(res.data);

                const nestedSources = $('iframe[src], iframe[data-src], iframe[data-lazy-src]')
                    .map((_, el) => $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('src'))
                    .get();

                if (nestedSources.length === 0) {
                    nestedSources.push(...extractScriptEmbeds(res.data, absoluteSrc));
                }

                const limitedNested = uniqueStrings(nestedSources).slice(0, CONFIG.MAX_NESTED_IFRAMES_PER_NODE);
                const nestedResults = await Promise.allSettled(
                    limitedNested.map((nestedSrc) => this.processIframe(nestedSrc, absoluteSrc, mediaTitle, isSub, depth + 1))
                );

                const streams = [];
                for (const result of nestedResults) {
                    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                        streams.push(...result.value);
                    }
                }
                return streams;
            } catch (err) {
                logDebug(`Errore processIframe depth=${depth}:`, err.message);
                return [];
            }
        });
    }

    async resolvePage(pageUrl, preferredMediaTitle = null) {
        const cached = pageJobsCache.get(pageUrl);
        let pageJobs = cached;

        if (!pageJobs) {
            const startedAt = Date.now();
            const res = await fetchSmart(pageUrl, { responseType: 'text', allowGotFallback: true, preferLoose: true });
            pageJobs = parsePageJobs(res.data, pageUrl);
            pageJobsCache.set(pageUrl, pageJobs);
            logDebug('Pagina parsata', {
                url: pageUrl,
                via: res.via,
                jobs: pageJobs.jobs.length,
                ms: Date.now() - startedAt,
                mediaTitle: pageJobs.mediaTitle
            });
        } else {
            logDebug('Page jobs cache hit', { url: pageUrl, jobs: pageJobs.jobs.length });
        }

        const streams = [];
        const results = await Promise.allSettled(
            pageJobs.jobs.map((job) => this.processIframe(job.src, pageUrl, preferredMediaTitle || pageJobs.mediaTitle, job.isSub, 0))
        );

        for (const result of results) {
            if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                streams.push(...result.value);
            }
        }

        const deduped = dedupeStreams(streams);
        logDebug('Resolve completato', {
            url: pageUrl,
            jobs: pageJobs.jobs.length,
            beforeDedupe: streams.length,
            afterDedupe: deduped.length
        });
        return deduped;
    }

    async getStreams(meta) {
        const startedAt = Date.now();
        logDebug('--- Inizio getStreams ---');

        if (meta?.isSeries) {
            logDebug('Provider saltato: solo film');
            return [];
        }

        const tmdbMeta = await this.getTmdbMeta(meta);
        if (!tmdbMeta) {
            logDebug('TMDb meta non risolti');
            return [];
        }

        const searchCandidates = uniqueStrings([
            tmdbMeta.title_it,
            tmdbMeta.title_orig,
            ...getMetaTitleCandidates(meta)
        ]);

        let pageUrl = null;
        for (const title of searchCandidates) {
            logDebug(`Tentativo ricerca: ${title}`);
            pageUrl = await this.searchMovie(title, tmdbMeta.year);
            if (pageUrl) break;
        }

        if (!pageUrl) {
            logDebug('Nessuna pagina utile trovata');
            return [];
        }

        const preferredTitle = cleanDisplayTitle(tmdbMeta.title_it || tmdbMeta.title_orig || meta?.name || meta?.title || '');
        const finalStreams = await this.resolvePage(pageUrl, preferredTitle);
        logDebug('--- Fine getStreams ---', {
            totalMs: Date.now() - startedAt,
            pageUrl,
            streams: finalStreams.length
        });
        return finalStreams;
    }
}

async function searchGuardaFlix(meta, config) {
    const scraper = new GuardaFlixScraper(config);
    return scraper.getStreams(meta);
}

async function searchGuardaHD(meta, config) {
    return searchGuardaFlix(meta, config);
}

module.exports = { searchGuardaFlix, searchGuardaHD };
