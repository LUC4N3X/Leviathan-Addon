const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { URL } = require('url');

const tmdbHelper = require('../../core/utils/tmdb_helper');

const {
    buildWebStream,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistQuality,
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence,
    qualityRank
} = require('../extractors/common');
const {
    buildProxyUrl: buildMediaflowGatewayProxyUrl,
    getMediaflowBase
} = require('../../core/proxy/mediaflow_gateway');

const { extractFromUrl, resolveExtractorDefinition } = require('../extractors/registry');
const { createBlockedFallbackGuard } = require('../utils/provider_blocked_fallback');
const { SingleFlight, TtlLruCache, createLimiter } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const { buildLazyExtractorStream } = require('../extractors/lazy_extraction');
const { extractEmbedCandidates } = require('../extractors/semantic_candidate_extractor');
const { requestWithImpit } = require('../utils/bypass');

const CONFIG = Object.freeze({
    BASE_URL: 'https://guardaplay.live/',
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
    CACHE_MAX_ITEMS: 600,
    MEDIAFLOW_LOADM_DEFAULT: false
});

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE_URL = new URL(CONFIG.BASE_URL);
const SITE_HOST = BASE_URL.hostname;
const SITE_ORIGIN = BASE_URL.origin;

const providerShield = createBlockedFallbackGuard({
    providerName: 'guardaflix',
    envPrefix: 'GUARDAFLIX',
    baseUrl: SITE_ORIGIN,
    logPrefix: 'GF-SHIELD',
    fallbackUserAgent: USER_AGENT
});

const REGEX = Object.freeze({
    CLEAN_TITLE: /guardaflix|guardaplay|film streaming ita|film completo|streaming/gi,
    NON_ALNUM: /[^a-z0-9]+/g,
    YEAR: /\b(19\d{2}|20\d{2})\b/,
    NOISE: /\b(altadefinizione|guardaflix|guardaplay|film|serie|streaming|sub(?:b?ita)?|ita|hd|fullhd|uhd|1080p|720p|4k)\b/gi,
    ACCEPTABLE_PATH: /(\/film\/|\/movie\/|\/guarda\/|\/streaming\/|\/titles?\/|\/watch\/)/i
});

const MEDIAFLOW_LOADM_KEYS = Object.freeze([
    'loadm',
    'enableLoadm',
    'mfpLoadm',
    'mediaflowLoadm'
]);

const logDebug = (message, ...args) => {
    console.log(`[GuardaFlix-Live] ${message}`, ...args);
};

const tmdbMetaCache = new TtlLruCache({
    ttlMs: CONFIG.TMDB_META_TTL_MS,
    name: 'guardaflix:tmdbMeta',
    max: CONFIG.CACHE_MAX_ITEMS,
    sweepIntervalOps: CONFIG.CACHE_SWEEP_INTERVAL_OPS
});

const searchCache = new TtlLruCache({
    ttlMs: CONFIG.SEARCH_TTL_MS,
    name: 'guardaflix:search',
    max: CONFIG.CACHE_MAX_ITEMS,
    sweepIntervalOps: CONFIG.CACHE_SWEEP_INTERVAL_OPS
});

const pageJobsCache = new TtlLruCache({
    ttlMs: CONFIG.PAGE_JOBS_TTL_MS,
    name: 'guardaflix:pageJobs',
    max: CONFIG.CACHE_MAX_ITEMS,
    sweepIntervalOps: CONFIG.CACHE_SWEEP_INTERVAL_OPS
});

const playlistQualityCache = new TtlLruCache({
    ttlMs: CONFIG.PLAYLIST_QUALITY_TTL_MS,
    name: 'guardaflix:playlistQuality',
    max: CONFIG.CACHE_MAX_ITEMS,
    sweepIntervalOps: CONFIG.CACHE_SWEEP_INTERVAL_OPS
});

const playlistIntelCache = new TtlLruCache({
    ttlMs: CONFIG.PLAYLIST_QUALITY_TTL_MS,
    name: 'guardaflix:playlistIntel',
    max: CONFIG.CACHE_MAX_ITEMS,
    sweepIntervalOps: CONFIG.CACHE_SWEEP_INTERVAL_OPS
});

const inflight = new SingleFlight('guardaflix');

async function runSingleFlight(key, fn) {
    return inflight.do(key, fn);
}

const strictHttpsAgent = new https.Agent({
    rejectUnauthorized: true,
    keepAlive: true,
    maxSockets: 32
});

const looseHttpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    maxSockets: 32
});

const strictHttpClient = axios.create({
    timeout: CONFIG.TIMEOUT,
    httpsAgent: strictHttpsAgent,
    maxRedirects: 5
});

const looseHttpClient = axios.create({
    timeout: CONFIG.TIMEOUT,
    httpsAgent: looseHttpsAgent,
    maxRedirects: 5
});

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

    if ([401, 403, 429, 500, 502, 503, 504, 521, 522, 523, 524].includes(status)) {
        return true;
    }

    const message = String(error?.message || '').toLowerCase();

    return [
        'tls',
        'ssl',
        'socket hang up',
        'econnreset',
        'certificate',
        'unexpected end'
    ].some((token) => message.includes(token));
}

function hasUsefulEmbedHtml(html, targetUrl = '') {
    const text = String(html || '');
    if (!text || !/guardaplay|trembed/i.test(`${targetUrl} ${text}`)) return false;
    const $ = cheerio.load(text);
    const iframeSources = $('iframe[src], iframe[data-src], iframe[data-lazy-src]')
        .map((_, element) => $(element).attr('data-src') || $(element).attr('data-lazy-src') || $(element).attr('src'))
        .get();
    return iframeSources.some((src) => resolveExtractorDefinition(safeAbsoluteUrl(src, targetUrl) || src));
}

async function fetchWithImpit(targetUrl, customHeaders = {}, responseType = 'text') {
    const {
        method = 'GET',
        body = null,
        data = null,
        ...headers
    } = customHeaders || {};
    const response = await requestWithImpit({
        url: targetUrl,
        method,
        headers: defaultHeaders(headers),
        body: body || data,
        retry: { limit: 2 },
        responseType: responseType === 'json' ? 'text' : responseType,
        ignoreTlsErrors: true,
        timeout: CONFIG.TIMEOUT,
        followRedirect: true
    });

    if (response.statusCode < 200 || response.statusCode >= 400) {
        const error = new Error(`impit HTTP ${response.statusCode} for ${targetUrl}`);
        error.status = response.statusCode;
        throw error;
    }

    if (responseType === 'json') {
        try {
            return {
                data: JSON.parse(response.body),
                status: response.statusCode,
                headers: response.headers,
                via: 'impit'
            };
        } catch (error) {
            error.message = `Invalid JSON via impit: ${error.message}`;
            throw error;
        }
    }

    return {
        data: response.body,
        status: response.statusCode,
        headers: response.headers,
        via: 'impit'
    };
}

async function fetchViaAxios(client, targetUrl, options = {}) {
    let data = options.data || options.body || null;
    if (!data && options.form && typeof options.form === 'object') {
        data = new URLSearchParams(options.form).toString();
    }

    const response = await client({
        url: targetUrl,
        method: String(options.method || 'GET').toUpperCase(),
        data,
        validateStatus: (status) => status >= 200 && status < 400,
        responseType: options.responseType || 'text',
        headers: defaultHeaders(options.headers || {})
    });

    return {
        data: response.data,
        status: response.status,
        headers: response.headers,
        via: options.via || 'axios'
    };
}

async function fetchSmart(targetUrl, options = {}) {
    const allowSiteFallback = isLikelySiteUrl(targetUrl) || options.preferLoose || options.allowGotFallback;

    const attempts = [
        () => fetchViaAxios(strictHttpClient, targetUrl, { ...options, via: 'axios-strict' }),
        () => allowSiteFallback ? fetchViaAxios(looseHttpClient, targetUrl, { ...options, via: 'axios-loose' }) : null,
        () => allowSiteFallback ? fetchWithImpit(targetUrl, {
            ...(options.headers || {}),
            method: options.method,
            body: options.data || options.body || (options.form ? new URLSearchParams(options.form).toString() : null)
        }, options.responseType || 'text') : null
    ];

    let lastError = null;
    let blockedCandidate = false;

    for (const attempt of attempts) {
        try {
            const result = await attempt();
            if (!result) continue;

            if (providerShield.shouldUseShield({ targetUrl, url: targetUrl, status: result.status, body: result.data, headers: result.headers })) {
                if (hasUsefulEmbedHtml(result.data, targetUrl)) return result;
                blockedCandidate = true;
                break;
            }

            return result;
        } catch (error) {
            lastError = error;

            if (providerShield.shouldUseShield({ url: targetUrl, error })) {
                blockedCandidate = true;
                continue;
            }

            if (!isPossiblyProtectedError(error)) {
                break;
            }
        }
    }

    if (blockedCandidate || providerShield.shouldUseShield({ url: targetUrl, error: lastError })) {
        const shielded = await providerShield.fetchAxiosLike(targetUrl, {
            ttl: options.ttl || CONFIG.SEARCH_TTL_MS,
            timeout: Math.min(options.timeout || CONFIG.TIMEOUT, 6000),
            via: 'guardaflix-shield'
        });
        if (shielded) return shielded;
    }

    throw lastError || new Error(`Fetch failed: ${targetUrl}`);
}

function cleanTitle(text) {
    return String(text || '')
        .replace(REGEX.CLEAN_TITLE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanDisplayTitle(text) {
    return cleanTitle(text)
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
    return cleanTitle(text)
        .toLowerCase()
        .replace(REGEX.NOISE, ' ')
        .replace(REGEX.NON_ALNUM, '')
        .trim();
}

function slugify(text) {
    return cleanTitle(text)
        .toLowerCase()
        .replace(/["'’:`]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]+/g, '')
        .replace(/\-+/g, '-')
        .replace(/^-|-$/g, '');
}

function tokenizeTitle(text) {
    return cleanTitle(text)
        .toLowerCase()
        .replace(REGEX.NOISE, ' ')
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter((token) => token && token.length > 1);
}

function uniqueStrings(values) {
    const seen = new Set();
    const output = [];

    for (const value of values) {
        const item = String(value || '').trim();
        const key = item.toLowerCase();

        if (!item || seen.has(key)) continue;

        seen.add(key);
        output.push(item);
    }

    return output;
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
    const candidates = [
        meta?.year,
        meta?.releaseYear,
        meta?.released,
        meta?.release_date,
        meta?.first_air_date,
        meta?.name,
        meta?.title,
        meta?.id
    ];

    for (const candidate of candidates) {
        const match = String(candidate || '').match(REGEX.YEAR);
        if (match) return match[1];
    }

    return '';
}

function resolveTmdbMovieId(meta) {
    const direct = String(meta?.tmdb_id || meta?.tmdbId || '').trim();

    if (/^\d+$/.test(direct)) {
        return direct;
    }

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
    const meta = await tmdbHelper
        .getTmdbMetaFromImdb(imdbId, {
            mediaHint: 'movie',
            language: 'it-IT'
        })
        .catch(() => null);

    if (!meta?.tmdb_id) return null;

    return {
        id: meta.tmdb_id,
        title: meta.title,
        original_title: meta.original_title,
        release_date: meta.date || (meta.year ? `${meta.year}-01-01` : '')
    };
}

async function fetchTmdbMovie(tmdbId) {
    const cleanId = String(tmdbId || '').trim();

    if (!/^\d+$/.test(cleanId)) {
        return null;
    }

    return tmdbHelper.fetchTmdbJson(`/movie/${encodeURIComponent(cleanId)}`, {
        params: { language: 'it-IT' },
        cacheTtlMs: CONFIG.TMDB_META_TTL_MS
    }).catch(() => null);
}

async function searchTmdbMovieByTitle(title, year) {
    const query = String(title || '').trim();

    if (!query) return null;

    const payload = await tmdbHelper.fetchTmdbJson('/search/movie', {
        params: {
            language: 'it-IT',
            query,
            include_adult: 'false',
            year: /^\d{4}$/.test(String(year || '')) ? String(year) : undefined
        },
        cacheTtlMs: CONFIG.TMDB_META_TTL_MS
    }).catch(() => null);

    const results = Array.isArray(payload?.results) ? payload.results : [];

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

        const removableParams = [
            'token',
            'expires',
            'exp',
            'signature',
            'sig',
            'auth',
            'auth_token',
            't',
            'ts',
            'e',
            'hash'
        ];

        for (const key of removableParams) {
            parsed.searchParams.delete(key);
        }

        const sortedParams = [...parsed.searchParams.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]));

        parsed.search = new URLSearchParams(sortedParams).toString();

        return `${parsed.hostname}${parsed.pathname}${parsed.search ? `?${parsed.search}` : ''}`;
    } catch {
        return String(inputUrl || '');
    }
}

function playlistQualityCacheKey(inputUrl) {
    return normalizeStreamKey(inputUrl);
}

function normalizeGuardaFlixDisplayQuality(value) {
    return normalizeQuality(value) === '1080p' ? '1080p' : '720p';
}

async function resolveExtractedPlaylistIntelligence(client, extracted) {
    const url = String(extracted?.url || '');
    if (!/\.m3u8($|\?)/i.test(url)) return null;
    const cacheKey = playlistQualityCacheKey(url);
    const cached = playlistIntelCache.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
        const intelligence = await probePlaylistIntelligence(client, url, {
            headers: extracted?.headers || {},
            timeout: CONFIG.PROBE_TIMEOUT
        });
        playlistIntelCache.set(cacheKey, intelligence || null);
        return intelligence || null;
    } catch (_) {
        playlistIntelCache.set(cacheKey, null, Math.min(CONFIG.PLAYLIST_QUALITY_TTL_MS, 10 * 60 * 1000));
        return null;
    }
}

async function resolveExtractedQuality(client, extracted) {
    const url = String(extracted?.url || '');
    let quality = normalizeQuality(extracted?.quality || 'Unknown');

    if (!/\.m3u8($|\?)/i.test(url)) {
        return quality;
    }

    const cacheKey = playlistQualityCacheKey(url);
    const cached = playlistQualityCache.get(cacheKey);

    if (cached) {
        return pickBetterQuality(cached, quality);
    }

    const shouldProbe = /unknown|sd|hd|auto/i.test(String(quality || '')) || !quality;

    if (!shouldProbe) {
        return quality;
    }

    try {
        const intelligence = await resolveExtractedPlaylistIntelligence(client, extracted);
        quality = pickBetterQuality(intelligence?.quality || 'Unknown', quality);
        playlistQualityCache.set(cacheKey, quality);

        return quality;
    } catch {
        return quality;
    }
}

function extractScriptEmbeds(html, baseUrl) {
    const output = [];

    const regexes = [
        /https?:\/\/[^"'`\s<>()]+/gi,
        /\/\/[^"'`\s<>()]+/gi
    ];

    for (const regex of regexes) {
        const matches = String(html || '').match(regex) || [];

        for (const match of matches) {
            const candidate = safeAbsoluteUrl(match, baseUrl);

            if (!candidate) continue;

            if (!/(embed|iframe|player|stream|loadm|mixdrop|voe|supervideo|maxstream|vix|m3u8)/i.test(candidate)) {
                continue;
            }

            output.push(candidate);
        }
    }

    return output;
}

function parsePageJobs(html, pageUrl) {
    const $ = cheerio.load(html);
    const mediaTitle = cleanTitle($('meta[property="og:title"]').attr('content') || $('title').text());

    const optionSubMap = {};

    $('a[href^="#options-"]').each((_, element) => {
        const key = $(element).attr('href')?.substring(1);
        if (!key) return;

        optionSubMap[key] = $(element).text().toLowerCase().includes('sub');
    });

    let defaultIsSub = false;

    $('span[class*="btn"], .btn, button, a').each((_, element) => {
        const text = $(element).text().toLowerCase();

        if ($(element).hasClass('active') && text.includes('sub')) {
            defaultIsSub = true;
        }
    });

    const jobs = [];

    const pushJob = (src, isSub, source) => {
        const absolute = safeAbsoluteUrl(src, pageUrl);

        if (!absolute) return;

        jobs.push({
            src: absolute,
            isSub: Boolean(isSub),
            source
        });
    };

    const optionDivs = $('div[id^="options-"]');

    if (optionDivs.length > 0) {
        optionDivs.each((_, div) => {
            const optionId = $(div).attr('id');
            const isSub = optionSubMap[optionId] ?? defaultIsSub;

            $(div).find('iframe[src], iframe[data-src], iframe[data-lazy-src]').each((__, iframe) => {
                const src = $(iframe).attr('data-src') || $(iframe).attr('data-lazy-src') || $(iframe).attr('src');
                pushJob(src, isSub, 'option-iframe');
            });
        });
    }

    if (jobs.length === 0) {
        $('iframe[src], iframe[data-src], iframe[data-lazy-src]').each((_, iframe) => {
            const src = $(iframe).attr('data-src') || $(iframe).attr('data-lazy-src') || $(iframe).attr('src');

            const context = [
                $(iframe).attr('title'),
                $(iframe).closest('[class],[id]').text()
            ].filter(Boolean).join(' ').toLowerCase();

            pushJob(src, context.includes('sub') || defaultIsSub, 'page-iframe');
        });
    }

    if (jobs.length === 0) {
        for (const embed of extractScriptEmbeds(html, pageUrl)) {
            pushJob(embed, defaultIsSub, 'script-url');
        }
    }

    if (jobs.length === 0) {
        for (const candidate of extractEmbedCandidates(html, { baseUrl: pageUrl, maxCandidates: CONFIG.MAX_IFRAMES_PER_PAGE })) {
            pushJob(candidate.url, defaultIsSub, 'semantic-embed');
        }
    }

    const deduped = [];
    const seen = new Set();

    for (const job of jobs) {
        const key = `${job.src}|${job.isSub ? 'sub' : 'ita'}`;

        if (seen.has(key)) continue;

        seen.add(key);
        deduped.push(job);

        if (deduped.length >= CONFIG.MAX_IFRAMES_PER_PAGE) {
            break;
        }
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
    const qualityScore = qualityRank(stream?.quality);
    const priority = Number.isFinite(stream?._priority) ? stream._priority : 9;
    const proxyBonus = /\[MFP\]/i.test(String(stream?.name || '')) ? 0.15 : 0;

    return qualityScore * 100 - priority + proxyBonus;
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

function boolFromConfig(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;

    const normalized = String(value ?? '').trim().toLowerCase();

    if (['1', 'true', 'yes', 'y', 'on', 'enabled', 'enable', 'si', 'sì'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'n', 'off', 'disabled', 'disable'].includes(normalized)) {
        return false;
    }

    return fallback;
}

function isLoadmExtracted(extracted) {
    const extractor = String(extracted?.name || extracted?.extractor || '').toLowerCase();
    const directUrl = String(extracted?.url || '').toLowerCase();

    return extractor.includes('loadm') || directUrl.includes('loadm');
}

function isMediaflowLoadmEnabled(config) {
    const mediaflow = config?.mediaflow || {};

    for (const key of MEDIAFLOW_LOADM_KEYS) {
        if (Object.prototype.hasOwnProperty.call(mediaflow, key)) {
            return boolFromConfig(mediaflow[key], CONFIG.MEDIAFLOW_LOADM_DEFAULT);
        }
    }

    return CONFIG.MEDIAFLOW_LOADM_DEFAULT;
}

function shouldProxyWithMediaflow(config, extracted) {
    if (!getMediaflowBase(config)) return false;

    const url = String(extracted?.url || '');
    const headers = extracted?.headers || {};

    if (!url || !/\.m3u8($|\?)/i.test(url)) return false;

    if (!headers.Referer && !headers.referer && !headers.Origin && !headers.origin) {
        return false;
    }

    if (isLoadmExtracted(extracted) && !isMediaflowLoadmEnabled(config)) {
        return false;
    }

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
    if (!getMediaflowBase(config) || !extracted?.url) return null;

    const proxied = buildMediaflowGatewayProxyUrl(config, extracted.url, {
        ...(referer ? { Referer: referer } : {}),
        ...(origin ? { Origin: origin } : {})
    }, {
        isHls: true,
        allowCookie: false
    });

    return proxied ? { url: proxied, referer, origin } : null;
}

function scoreCandidate(queryTitle, year, href, text) {
    let score = 0;

    const cleanQuery = cleanTitle(queryTitle);
    const cleanCandidate = cleanTitle(text);
    const queryNorm = normalizeText(cleanQuery);
    const candidateNorm = normalizeText(cleanCandidate);
    const querySlug = slugify(cleanQuery);
    const candidateSlug = slugify(cleanCandidate);
    const hrefLower = String(href || '').toLowerCase();

    if (!cleanCandidate) {
        score -= 0.45;
    }

    if (queryNorm && candidateNorm) {
        if (queryNorm === candidateNorm) {
            score += 7.5;
        } else if (candidateNorm.includes(queryNorm) || queryNorm.includes(candidateNorm)) {
            score += 4.1;
        }
    }

    const queryTokens = tokenizeTitle(cleanQuery);
    const candidateTokens = tokenizeTitle(cleanCandidate);

    if (queryTokens.length && candidateTokens.length) {
        const candidateSet = new Set(candidateTokens);
        const shared = queryTokens.filter((token) => candidateSet.has(token)).length;
        score += (shared / Math.max(queryTokens.length, 1)) * 3.25;
    }

    if (querySlug && (querySlug === candidateSlug || hrefLower.includes(querySlug))) {
        score += 2.1;
    }

    if (year && (cleanCandidate.includes(year) || hrefLower.includes(year))) {
        score += 1.15;
    }

    if (/\/serie\//i.test(hrefLower)) {
        score -= 6;
    }

    if (/trailer|episodio|stagione|serie tv/i.test(cleanCandidate)) {
        score -= 2.5;
    }

    if (/sub/i.test(cleanCandidate)) {
        score -= 0.2;
    }

    return score;
}

function collectSearchCandidates($, queryTitle, year) {
    const candidates = [];
    const seen = new Set();

    const push = (href, text, source) => {
        const finalHref = safeAbsoluteUrl(href, SITE_ORIGIN);

        if (!finalHref) return;

        const key = finalHref.toLowerCase();

        if (seen.has(key)) return;

        seen.add(key);

        candidates.push({
            href: finalHref,
            text: cleanTitle(text || ''),
            source,
            score: scoreCandidate(queryTitle, year, finalHref, text || '')
        });
    };

    $('a[href]').each((_, element) => {
        const $element = $(element);
        const href = $element.attr('href');

        if (!href) return;

        const absoluteHref = safeAbsoluteUrl(href, SITE_ORIGIN);

        if (!absoluteHref) return;

        if (!REGEX.ACCEPTABLE_PATH.test(absoluteHref.toLowerCase())) {
            return;
        }

        const article = $element.closest('article, .post, .item, .result, .ml-item, .movie, .film, .box, .entry, li');

        const text =
            $element.text().trim() ||
            $element.attr('title') ||
            $element.find('img').attr('alt') ||
            article.find('h1, h2, h3, h4').first().text().trim() ||
            article.find('img').first().attr('alt') ||
            article.attr('title') ||
            article.find('.title, .entry-title, .post-title').first().text().trim() ||
            '';

        push(absoluteHref, text, 'anchor');
    });

    $('article, .post, .item, .result, .ml-item, .movie, .film, li').each((_, element) => {
        const $box = $(element);
        const anchor = $box.find('a[href]').first();

        if (!anchor.length) return;

        const text =
            $box.find('h1, h2, h3, h4').first().text().trim() ||
            anchor.attr('title') ||
            $box.find('img').first().attr('alt') ||
            anchor.text().trim() ||
            '';

        push(anchor.attr('href'), text, 'box');
    });

    candidates.sort((a, b) => b.score - a.score);

    return candidates;
}

function cleanAjaxSuggestionText($element) {
    const directText = $element.clone().children().remove().end().text().trim();
    const raw = directText || $element.text().trim();
    return cleanTitle(raw.replace(/^\s*(?:movies?|film|serie)\s*/i, '')).trim();
}

function collectAjaxSearchCandidates($, queryTitle, year) {
    const candidates = [];
    const seen = new Set();

    $('a[href]').each((_, element) => {
        const $element = $(element);
        const finalHref = safeAbsoluteUrl($element.attr('href'), SITE_ORIGIN);
        if (!finalHref || !/\/film\//i.test(finalHref)) return;

        const key = finalHref.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);

        const text = cleanAjaxSuggestionText($element);
        candidates.push({
            href: finalHref,
            text,
            source: 'ajax-suggest',
            score: scoreCandidate(queryTitle, year, finalHref, text)
        });
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

function extractPageYear(html) {
    const $ = cheerio.load(String(html || ''));
    const candidates = [
        $('span.year').first().text(),
        $('.year').first().text(),
        $('[class*="calendar"]').first().text(),
        $('.date').first().text(),
        $('time[datetime]').first().attr('datetime'),
        $('meta[property="article:published_time"]').attr('content')
    ];

    for (const candidate of candidates) {
        const match = String(candidate || '').match(REGEX.YEAR);
        if (match) return match[1];
    }

    return '';
}

class GuardaFlixScraper {
    constructor(config, reqHost = null, options = {}) {
        this.config = config || {};
        this.reqHost = reqHost || null;
        this.fetcher = typeof options.fetcher === 'function' ? options.fetcher : fetchSmart;
        this.iframeLimiter = createLimiter(CONFIG.IFRAME_CONCURRENCY);
        this.visitedIframes = new Set();

        logDebug('Inizializzato', {
            baseUrl: CONFIG.BASE_URL,
            mediaflow: Boolean(getMediaflowBase(this.config)),
            mediaflowLoadm: isMediaflowLoadmEnabled(this.config),
            iframeConcurrency: CONFIG.IFRAME_CONCURRENCY,
            maxDepth: CONFIG.MAX_IFRAME_DEPTH
        });
    }

    async fetchText(targetUrl, options = {}) {
        return this.fetcher(targetUrl, {
            responseType: 'text',
            ...options
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

        if (cached) {
            return cached;
        }

        return runSingleFlight(`tmdb:${cacheKey}`, async () => {
            const cachedAgain = tmdbMetaCache.get(cacheKey);

            if (cachedAgain) {
                return cachedAgain;
            }

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
            } catch (error) {
                logDebug('Errore getTmdbMeta:', error.message);
                return null;
            }
        });
    }

    async searchMovie(title, year) {
        const cacheKey = `${String(title || '').trim().toLowerCase()}|${String(year || '')}`;
        const cached = searchCache.get(cacheKey);

        if (cached !== undefined) {
            return cached;
        }

        return runSingleFlight(`search:${cacheKey}`, async () => {
            const cachedAgain = searchCache.get(cacheKey);

            if (cachedAgain !== undefined) {
                return cachedAgain;
            }

            try {
                const ajaxHref = await this.searchMovieAjax(title, year);
                if (ajaxHref) {
                    searchCache.set(cacheKey, ajaxHref);
                    return ajaxHref;
                }

                const queryUrl = `${SITE_ORIGIN}/?s=${encodeURIComponent(title)}`;
                const startedAt = Date.now();

                logDebug(`Ricerca sito: ${queryUrl}`);

                const response = await this.fetchText(queryUrl, {
                    responseType: 'text',
                    allowGotFallback: true,
                    preferLoose: true
                });

                const $ = cheerio.load(response.data);
                const candidates = collectSearchCandidates($, title, year);
                const best = candidates[0] || null;

                let finalHref = null;

                if (best) {
                    const hrefLower = String(best.href).toLowerCase();
                    const titleSlug = slugify(cleanTitle(title));

                    const hrefLooksRight =
                        (titleSlug && hrefLower.includes(titleSlug)) ||
                        (year && hrefLower.includes(String(year)));

                    if (
                        best.score >= CONFIG.SEARCH_ACCEPT_THRESHOLD ||
                        (hrefLooksRight && best.score >= CONFIG.SEARCH_SOFT_THRESHOLD)
                    ) {
                        finalHref = best.href;
                    }
                }

                logDebug('Risultato search', {
                    title,
                    year,
                    via: response.via,
                    ms: Date.now() - startedAt,
                    bestScore: best?.score ?? null,
                    finalHref,
                    bestText: best?.text || null,
                    bestSource: best?.source || null
                });

                searchCache.set(cacheKey, finalHref, finalHref ? undefined : 2 * 60 * 1000);

                return finalHref;
            } catch (error) {
                logDebug('Errore searchMovie:', error.message);
                searchCache.set(cacheKey, null, 2 * 60 * 1000);
                return null;
            }
        });
    }

    async searchMovieAjax(title, year) {
        const startedAt = Date.now();
        const ajaxUrl = `${SITE_ORIGIN}/wp-admin/admin-ajax.php`;
        const form = {
            action: 'action_tr_search_suggest',
            nonce: process.env.GUARDAFLIX_AJAX_NONCE || '20115729b4',
            term: String(title || '').trim()
        };
        if (!form.term) return null;

        try {
            logDebug(`Ricerca AJAX sito: ${ajaxUrl}`);
            const response = await this.fetchText(ajaxUrl, {
                method: 'POST',
                form,
                headers: {
                    Origin: SITE_ORIGIN,
                    Referer: `${SITE_ORIGIN}/`,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                allowGotFallback: true,
                preferLoose: true
            });

            const candidates = collectAjaxSearchCandidates(cheerio.load(response.data), title, year);
            for (const candidate of candidates.slice(0, 8)) {
                if (year) {
                    const page = await this.fetchText(candidate.href, {
                        headers: { Referer: `${SITE_ORIGIN}/` },
                        allowGotFallback: true,
                        preferLoose: true
                    });
                    const pageYear = extractPageYear(page.data);
                    if (pageYear && pageYear !== String(year)) continue;
                }

                logDebug('Risultato search AJAX', {
                    title,
                    year,
                    via: response.via,
                    ms: Date.now() - startedAt,
                    finalHref: candidate.href,
                    bestScore: candidate.score,
                    bestText: candidate.text
                });
                return candidate.href;
            }

            logDebug('Search AJAX senza match accettato', {
                title,
                year,
                via: response.via,
                ms: Date.now() - startedAt,
                candidates: candidates.length
            });
            return null;
        } catch (error) {
            logDebug('Errore searchMovieAjax:', error.message);
            return null;
        }
    }

    buildStreamFromExtractor(extracted, mediaTitle, isSub, resolvedQuality = null, playlistIntel = null) {
        const langTag = isSub ? 'SUB ITA' : 'ITA';
        const displayTitle = cleanDisplayTitle(mediaTitle) || 'Stream';
        const finalTitle = `${displayTitle} - ${langTag}`;
        const originalHeaders = extracted?.headers || null;
        const quality = normalizeGuardaFlixDisplayQuality(resolvedQuality || extracted?.quality || 'Unknown');

        let streamName = '🎬 GuardaFlix';
        let streamUrl = extracted.url;
        let modeLabel = 'Direct';
        let headers = originalHeaders;

        if (shouldProxyWithMediaflow(this.config, extracted)) {
            try {
                const proxied = applyMediaflow(this.config, extracted);
                if (!proxied?.url) throw new Error('MediaFlow gateway unavailable');

                streamName = '🎬 GuardaFlix [MFP]';
                streamUrl = proxied.url;
                modeLabel = 'Proxy';
                headers = null;

                logDebug(`MediaFlow applicato a ${extracted.name}`);
            } catch (error) {
                logDebug(`MediaFlow skip per ${extracted.name}: ${error.message}`);
            }
        } else if (isLoadmExtracted(extracted) && getMediaflowBase(this.config)) {
            logDebug('MediaFlow non applicato a LoadM: flag disattivata');
        }

        let stream = buildWebStream({
            name: streamName,
            title: `${finalTitle}\n${extracted.name} (${modeLabel})`,
            url: streamUrl,
            extractor: extracted.name,
            provider: 'GuardaFlix',
            providerCode: 'GF',
            quality,
            headers
        });

        stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
        stream._priority = extracted.priority ?? 9;
        stream._fingerprint = createStreamFingerprint(stream);

        return stream;
    }

    async processIframe(src, pageUrl, mediaTitle, isSub, depth = 0) {
        if (!src || depth > CONFIG.MAX_IFRAME_DEPTH) {
            return [];
        }

        const absoluteSrc = safeAbsoluteUrl(src, pageUrl);

        if (!absoluteSrc) {
            return [];
        }

        const visitKey = `${absoluteSrc}|${isSub ? 'sub' : 'ita'}`;

        if (this.visitedIframes.has(visitKey)) {
            return [];
        }

        this.visitedIframes.add(visitKey);

        return this.iframeLimiter(async () => {
            try {
                logDebug(`Iframe resolve depth=${depth}`, absoluteSrc);

                const extracted = await extractFromUrl(absoluteSrc, {
                    client: looseHttpClient,
                    userAgent: USER_AGENT,
                    requestReferer: pageUrl,
                    fetchers: [
                        (targetUrl, headers) => fetchWithImpit(targetUrl, headers, 'text').then((response) => response.data)
                    ]
                });

                if (extracted?.url) {
                    const playlistIntel = await resolveExtractedPlaylistIntelligence(looseHttpClient, extracted);
                    const quality = pickBetterQuality(playlistIntel?.quality || 'Unknown', await resolveExtractedQuality(looseHttpClient, extracted));
                    return [this.buildStreamFromExtractor(extracted, mediaTitle, isSub, quality, playlistIntel)];
                }

                const response = await this.fetchText(absoluteSrc, {
                    responseType: 'text',
                    headers: { Referer: pageUrl },
                    allowGotFallback: true,
                    preferLoose: true
                });

                const $ = cheerio.load(response.data);

                const nestedSources = $('iframe[src], iframe[data-src], iframe[data-lazy-src]')
                    .map((_, element) => $(element).attr('data-src') || $(element).attr('data-lazy-src') || $(element).attr('src'))
                    .get();

                if (nestedSources.length === 0) {
                    nestedSources.push(...extractScriptEmbeds(response.data, absoluteSrc));
                }

                const limitedNested = uniqueStrings(nestedSources).slice(0, CONFIG.MAX_NESTED_IFRAMES_PER_NODE);

                const nestedResults = await Promise.allSettled(
                    limitedNested.map((nestedSrc) => (
                        this.processIframe(nestedSrc, absoluteSrc, mediaTitle, isSub, depth + 1)
                    ))
                );

                const streams = [];

                for (const result of nestedResults) {
                    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
                        streams.push(...result.value);
                    }
                }

                if (streams.length === 0 && resolveExtractorDefinition(absoluteSrc)) {
                    const lazy = buildLazyExtractorStream({
                        embedUrl: absoluteSrc,
                        reqHost: this.reqHost,
                        provider: 'GuardaFlix',
                        providerCode: 'GF',
                        title: cleanDisplayTitle(mediaTitle) || 'GuardaFlix',
                        name: resolveExtractorDefinition(absoluteSrc)?.label,
                        quality: 'Unknown',
                        referer: pageUrl,
                        extra: { _priority: resolveExtractorDefinition(absoluteSrc)?.priority ?? 9 }
                    });
                    if (lazy) streams.push(lazy);
                }

                return streams;
            } catch (error) {
                logDebug(`Errore processIframe depth=${depth}:`, error.message);
                const lazy = resolveExtractorDefinition(absoluteSrc)
                    ? buildLazyExtractorStream({
                        embedUrl: absoluteSrc,
                        reqHost: this.reqHost,
                        provider: 'GuardaFlix',
                        providerCode: 'GF',
                        title: cleanDisplayTitle(mediaTitle) || 'GuardaFlix',
                        name: resolveExtractorDefinition(absoluteSrc)?.label,
                        referer: pageUrl,
                        extra: { _priority: resolveExtractorDefinition(absoluteSrc)?.priority ?? 9 }
                    })
                    : null;
                return lazy ? [lazy] : [];
            }
        });
    }

    async resolvePage(pageUrl, preferredMediaTitle = null) {
        let pageJobs = pageJobsCache.get(pageUrl);

        if (!pageJobs) {
            const startedAt = Date.now();

            const response = await fetchSmart(pageUrl, {
                responseType: 'text',
                allowGotFallback: true,
                preferLoose: true
            });

            pageJobs = parsePageJobs(response.data, pageUrl);
            pageJobsCache.set(pageUrl, pageJobs);

            logDebug('Pagina parsata', {
                url: pageUrl,
                via: response.via,
                jobs: pageJobs.jobs.length,
                ms: Date.now() - startedAt,
                mediaTitle: pageJobs.mediaTitle
            });
        } else {
            logDebug('Page jobs cache hit', {
                url: pageUrl,
                jobs: pageJobs.jobs.length
            });
        }

        const results = await Promise.allSettled(
            pageJobs.jobs.map((job) => (
                this.processIframe(
                    job.src,
                    pageUrl,
                    preferredMediaTitle || pageJobs.mediaTitle,
                    job.isSub,
                    0
                )
            ))
        );

        const streams = [];

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

        const preferredTitle = cleanDisplayTitle(
            tmdbMeta.title_it ||
            tmdbMeta.title_orig ||
            meta?.name ||
            meta?.title ||
            ''
        );

        const streams = normalizeStreams(await this.resolvePage(pageUrl, preferredTitle), {
            provider: 'guardaflix',
            providerLabel: 'GuardaFlix',
            providerCode: 'GF',
            sort: false,
            debug: process.env.GUARDAFLIX_DEBUG === '1'
        });

        logDebug('--- Fine getStreams ---', {
            totalMs: Date.now() - startedAt,
            pageUrl,
            streams: streams.length
        });

        return streams;
    }
}

async function searchGuardaFlixImpl(meta, config) {
    const scraper = new GuardaFlixScraper(config);
    return scraper.getStreams(meta);
}

async function searchGuardaFlix(meta, config) {
    return withProviderHealth('guardaflix', () => searchGuardaFlixImpl(meta, config), {
        swallowErrors: true,
        fallbackValue: []
    });
}

async function searchGuardaHD(meta, config, reqHost = null) {
    return searchGuardaFlix(meta, config, reqHost);
}

module.exports = {
    searchGuardaFlix,
    searchGuardaHD,
    _test: {
        collectAjaxSearchCandidates,
        collectSearchCandidates,
        extractPageYear,
        GuardaFlixScraper,
        hasUsefulEmbedHtml,
        parsePageJobs,
        scoreCandidate
    }
};
