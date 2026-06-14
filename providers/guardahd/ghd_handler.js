'use strict';

const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const tmdbHelper = require('../../core/utils/tmdb_helper');
const {
    buildMediaflowUrl,
    buildWebStream,
    extractSizeText,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence,
    qualityRank
} = require('../extractors/common');
const { createMediaflowGateway, getMediaflowBase } = require('../../core/proxy/mediaflow_gateway');
const {
    extractFromUrl,
    HOSTER_DIRECT_LINK_PATTERN,
    resolveExtractorDefinition
} = require('../extractors/registry');
const {
    CircuitBreaker,
    PersistentJsonCache,
    resilientCall
} = require('../extractors/resilience');
const { createBlockedFallbackGuard } = require('../utils/provider_blocked_fallback');
const { AsyncSemaphore, SingleFlight, TtlLruCache } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const { buildLazyExtractorStream } = require('../extractors/lazy_extraction');
const { extractResilientEmbeds } = require('../extractors/semantic_candidate_extractor');
const { getProviderDomain } = require('../utils/provider_domain_registry');

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(process.env[name] || String(fallback), 10);
    const value = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, value));
}

function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value == null) return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

const CONFIG = {
    CACHE: {
        FILE: path.join(__dirname, '..', 'config', 'guardahd_cache.json'),
        TTL: 12 * 60 * 60 * 1000,
        STALE_TTL: 24 * 60 * 60 * 1000,
        MAX_ENTRIES: 1024,
        SAVE_DEBOUNCE_MS: 1200
    },
    SCRAPER: {
        BASE_URL: String(process.env.GUARDAHD_BASE || getProviderDomain('guardahd', 'https://guardahd.stream')).replace(/\/+$/, ''),
        TIMEOUT: envInt('GUARDAHD_TIMEOUT', 15000, 8000, 60000),
        PLAYLIST_TIMEOUT: envInt('GUARDAHD_PLAYLIST_TIMEOUT', 4500, 2500, 20000),
        RETRIES: envInt('GUARDAHD_RETRIES', 3, 1, 8),
        MAX_EMBEDS: envInt('GUARDAHD_MAX_EMBEDS', 24, 4, 80),
        MAX_CONCURRENT_EMBEDS: envInt('GUARDAHD_MAX_CONCURRENT_EMBEDS', 12, 1, 48),
        MAX_CONCURRENT_PLAYLIST_PROBES: envInt('GUARDAHD_MAX_CONCURRENT_PLAYLIST_PROBES', 4, 1, 16),
        PREFER_PLAYLIST_PROBE: envFlag('GUARDAHD_PREFER_PLAYLIST_PROBE', false),
        MIXDROP_LOCAL_PROXY_FIRST: envFlag('GUARDAHD_MIXDROP_LOCAL_PROXY_FIRST', true),
        KRAKEN_PROXY_DIRECT_STREAMS: envFlag('GUARDAHD_KRAKEN_PROXY_DIRECT_STREAMS', true),
        KRAKEN_PROXY_COOKIES: envFlag('GUARDAHD_KRAKEN_PROXY_COOKIES', true),
        DEBUG: envFlag('GUARDAHD_DEBUG', false)
    }
};

const USER_AGENTS = Object.freeze([
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
]);

const MAC_UA = USER_AGENTS[0];
const CHROME_UA = USER_AGENTS[1];

const providerShield = createBlockedFallbackGuard({
    providerName: 'guardahd',
    envPrefix: 'GUARDAHD',
    baseUrl: CONFIG.SCRAPER.BASE_URL,
    logPrefix: 'GHD-SHIELD',
    fallbackUserAgent: CHROME_UA
});

const REGEX = {
    Q_4K: /(?:\b4k\b|2160p|uhd)/i,
    Q_1440: /(?:1440p|\b2k\b|qhd)/i,
    Q_1080: /(?:1080p|fullhd|fhd)/i,
    Q_720: /(?:720p|\bhd\b)/i,
    Q_480: /(?:480p|\bsd\b)/i,
    Q_ANY: /(2160|1440|1080|720|480|360|240)p?/i,
    SIZE: /([\d.,]+\s?(?:G|M)B)/i,
    NOT_FOUND: /can't find the (?:file|video)|file not found|video not found/i,
    MIXDROP: /mixdr(?:op|p)|m1xdrop|mxcontent/i,
    STREAMHG: /dhcplay|vibuxer/i,
    DIRECT_URL: /https?:\/\/(?:www\.)?(?:dropload|dr0pstream|mixdrop|mixdrp|m1xdrop|mxcontent|dhcplay|vibuxer)[^"'<>\s\\]+/ig,
    IFRAME: /<iframe\b[^>]+src=["']([^"']+)["']/ig,
    DATA_LINK: /data-link=["']([^"']+)["']/ig,
    SRC_HREF: /(?:src|href)=["']([^"']+)["']/ig,
    PACKED: /eval\(function\(p,a,c,k,e,d\)\s*\{.*?\}\s*\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('(.*?)'\)/s,
    FILE: /file\s*[:=]\s*["'](https?:\/\/.*?)["']/i,
    SOURCES_OBJECT: /sources:\s*\[\s*\{\s*file:\s*["'](.*?)["']/i,
    SOURCES_ARRAY: /sources:\s*\[\s*["'](.*?)["']\s*\]/i
};

const ALLOWED_HOSTERS = new Set(['mixdrop', 'dropload', 'streamhg']);

const HOSTER_PRIORITY = {
    dropload: 0,
    streamhg: 1,
    mixdrop: 2,
    unknown: 9
};

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    maxSockets: 120,
    maxFreeSockets: 24,
    timeout: 30000
});

const httpClient = axios.create({
    timeout: CONFIG.SCRAPER.TIMEOUT,
    httpsAgent,
    maxRedirects: 5,
    decompress: true,
    validateStatus: () => true
});

const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

const requestBreaker = new CircuitBreaker({
    failureThreshold: 4,
    recoveryTimeoutMs: 20000,
    halfOpenMaxCalls: 1
});

const runtime = {
    embedSemaphore: new AsyncSemaphore(CONFIG.SCRAPER.MAX_CONCURRENT_EMBEDS),
    playlistSemaphore: new AsyncSemaphore(CONFIG.SCRAPER.MAX_CONCURRENT_PLAYLIST_PROBES),
    playlistCache: new TtlLruCache({
        name: 'guardahd:playlist',
        ttlMs: 30 * 60 * 1000,
        max: 4096
    }),
    playlistInflight: new SingleFlight('guardahd:playlist')
};

const cacheManager = new PersistentJsonCache({
    file: CONFIG.CACHE.FILE,
    ttlMs: CONFIG.CACHE.TTL,
    staleTtlMs: CONFIG.CACHE.STALE_TTL - CONFIG.CACHE.TTL,
    maxEntries: CONFIG.CACHE.MAX_ENTRIES,
    saveDebounceMs: CONFIG.CACHE.SAVE_DEBOUNCE_MS
});

const registryDirectLinkRegex = HOSTER_DIRECT_LINK_PATTERN
    ? new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig')
    : null;

function debug(message, payload = null) {
    if (!CONFIG.SCRAPER.DEBUG) return;

    if (payload && typeof payload === 'object') {
        try {
            console.log(`[GHD] ${message} ${JSON.stringify(payload)}`);
            return;
        } catch (_) {
            console.log(`[GHD] ${message}`);
            return;
        }
    }

    console.log(`[GHD] ${message}`);
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || CHROME_UA;
}

function getRequestDomain(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (_) {
        return 'guardahd';
    }
}

function safeText(value) {
    if (value == null) return '';
    return String(value);
}

function responseText(response) {
    const data = response?.data;

    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (typeof data === 'string') return data;
    if (data == null) return '';

    return String(data);
}

function isSuccessfulStatus(status) {
    const code = Number(status || 0);
    return code >= 200 && code < 400;
}

function createHttpStatusError(response, url) {
    const status = Number(response?.status || 0);
    const error = new Error(`HTTP ${status || 'unknown'} for ${safeText(url).slice(0, 120)}`);
    error.status = status;
    error.response = response;
    error.url = url;
    return error;
}

function normalizeUrl(rawUrl) {
    let url = safeText(rawUrl)
        .trim()
        .replace(/&amp;/gi, '&')
        .replace(/&#038;/gi, '&')
        .replace(/\\u002F/gi, '/')
        .replace(/\\u002f/gi, '/')
        .replace(/\\u003A/gi, ':')
        .replace(/\\u003a/gi, ':')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u003D/gi, '=')
        .replace(/\\u003d/gi, '=')
        .replace(/\\\//g, '/')
        .replace(/%5C\//gi, '/')
        .replace(/\s+/g, '');

    url = url.replace(/[),.;]+$/g, '');

    if (url.startsWith('//')) url = `https:${url}`;

    return url;
}

function originFromUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}`;
    } catch (_) {
        return '';
    }
}


function safeHost(value) {
    try {
        return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./i, '');
    } catch (_) {
        return '';
    }
}

function safePath(value) {
    try {
        return new URL(String(value || '')).pathname || '/';
    } catch (_) {
        return '';
    }
}

function isHlsStreamUrl(value) {
    return /\.m3u8(?:$|[?#])/i.test(String(value || ''));
}

function isSameOrigin(first, second) {
    const a = originFromUrl(first);
    const b = originFromUrl(second);
    return Boolean(a && b && a === b);
}

function isKrakenOrMediaflowUrl(config = {}, value) {
    const base = getMediaflowBase(config);
    if (!base || !value) return false;
    return isSameOrigin(base, value);
}

function extractorHeadersFor(targetUrl, hoster = '') {
    const normalized = normalizeUrl(targetUrl);
    const origin = originFromUrl(normalized);
    const headers = { 'User-Agent': CHROME_UA };

    if (/mixdrop|m1xdrop|mxcontent/i.test(String(hoster || '') + ' ' + normalized)) {
        headers.Referer = origin ? `${origin}/` : 'https://mixdrop.ag/';
        headers.Origin = origin || 'https://mixdrop.ag';
        return headers;
    }

    if (origin) {
        headers.Referer = `${origin}/`;
        headers.Origin = origin;
    } else {
        headers.Referer = CONFIG.SCRAPER.BASE_URL;
    }

    return headers;
}

function buildKrakenProxyUrl(config = {}, targetUrl, headers = {}, hoster = '') {
    const base = getMediaflowBase(config);
    const normalized = normalizeUrl(targetUrl);

    if (!base || !normalized || isKrakenOrMediaflowUrl(config, normalized)) {
        return normalized;
    }

    const gateway = createMediaflowGateway(config);
    const requestHeaders = Object.keys(headers || {}).length
        ? headers
        : extractorHeadersFor(normalized, hoster);
    const proxied = gateway.buildProxyUrl(normalized, requestHeaders, {
        isHls: isHlsStreamUrl(normalized),
        allowCookie: CONFIG.SCRAPER.KRAKEN_PROXY_COOKIES
    });

    if (proxied && proxied !== normalized) {
        debug('kraken proxy url built', {
            hoster,
            sourceHost: safeHost(normalized),
            sourcePath: safePath(normalized),
            proxyHost: safeHost(proxied),
            proxyPath: safePath(proxied),
            isHls: isHlsStreamUrl(normalized),
            headerNames: Object.keys(requestHeaders || {})
        });
        return proxied;
    }

    return normalized;
}

function normalizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};

    const out = {};

    for (const [key, value] of Object.entries(headers)) {
        if (value == null) continue;

        const lower = String(key).toLowerCase();

        if (lower === 'user-agent') out['User-Agent'] = String(value);
        else if (lower === 'referer' || lower === 'referrer') out.Referer = String(value);
        else if (lower === 'origin') out.Origin = String(value);
        else if (lower === 'accept') out.Accept = String(value);
        else if (lower === 'accept-language') out['Accept-Language'] = String(value);
        else if (lower === 'cookie') out.Cookie = String(value);
        else out[String(key)] = String(value);
    }

    return out;
}

function hosterFromUrl(url) {
    const lower = safeText(url).toLowerCase();

    if (REGEX.MIXDROP.test(lower)) return 'mixdrop';
    if (lower.includes('dropload') || lower.includes('dr0pstream')) return 'dropload';
    if (REGEX.STREAMHG.test(lower)) return 'streamhg';

    return 'unknown';
}

function hosterLabel(hoster) {
    switch (hoster) {
        case 'dropload':
            return 'DropLoad';
        case 'mixdrop':
            return 'MixDrop';
        case 'streamhg':
            return 'StreamHG';
        default:
            return 'Hoster';
    }
}

function fileIdFromUrl(url) {
    try {
        const parsed = new URL(url);
        const hash = parsed.hash ? parsed.hash.replace(/^#/, '') : '';
        const parts = parsed.pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1] || '';

        return hash || last || parsed.href;
    } catch (_) {
        return url;
    }
}

function embedDedupeKey(url) {
    const normalized = normalizeUrl(url);
    const hoster = hosterFromUrl(normalized);
    const id = fileIdFromUrl(normalized);

    return `${hoster}:${id || normalized}`.toLowerCase();
}

function parseQuality(text) {
    const value = safeText(text);

    if (!value) return 'Unknown';
    if (REGEX.Q_4K.test(value)) return '4K';
    if (REGEX.Q_1440.test(value)) return '1440p';
    if (REGEX.Q_1080.test(value)) return '1080p';
    if (REGEX.Q_720.test(value)) return '720p';
    if (REGEX.Q_480.test(value)) return '480p';

    const match = value.match(REGEX.Q_ANY);
    if (!match) return 'Unknown';

    const number = Number(match[1]);

    if (number >= 2160) return '4K';
    if (number >= 1440) return '1440p';
    if (number >= 1080) return '1080p';
    if (number >= 720) return '720p';
    if (number >= 480) return '480p';
    if (number >= 360) return '360p';
    if (number >= 240) return '240p';

    return 'Unknown';
}

function normalizeGuardaHdDisplayQuality(value) {
    const quality = normalizeQuality(value);

    if (quality === '4K' || quality === '2160p' || quality === '1440p' || quality === '1080p') return '1080p';
    if (quality === '720p') return '720p';
    if (quality === '480p' || quality === '360p' || quality === '240p') return quality;

    return '720p';
}

function extractSize(...values) {
    for (const value of values) {
        const text = safeText(value);
        if (!text) continue;

        const common = extractSizeText(text);
        if (common && common !== 'N/A') return common.replace(/\s+/g, '');

        const match = text.match(REGEX.SIZE);
        if (match) return match[1].replace(/\s+/g, '');
    }

    return 'N/A';
}

function generateRichDescription(title, quality = 'Unknown', size = 'N/A', hoster = '') {
    const sizeTag = size && size !== 'N/A' ? `💾 ${size} • ` : '';
    const hosterTag = hoster ? ` [${hoster}]` : '';

    return `🎬 ${title}${hosterTag}\n${sizeTag}📺 ${quality || 'Unknown'} • 🇮🇹 ITA\n⚡ GuardaHD`;
}

async function fetchSmart(url, options = {}) {
    const method = options.method || 'GET';

    const requestConfig = {
        url,
        method,
        timeout: options.timeout || CONFIG.SCRAPER.TIMEOUT,
        responseType: options.responseType || 'text',
        headers: {
            'User-Agent': getRandomUserAgent(),
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            Referer: CONFIG.SCRAPER.BASE_URL,
            ...(options.headers || {})
        },
        data: options.data,
        params: options.params,
        maxRedirects: options.maxRedirects ?? 5
    };

    const shieldOptions = {
        method,
        data: options.data,
        ttl: options.ttl || 10 * 60 * 1000,
        timeout: Math.min(options.timeout || CONFIG.SCRAPER.TIMEOUT, 6000),
        via: 'guardahd-shield'
    };

    try {
        const response = await requestBreaker.run(getRequestDomain(url), async () => resilientCall(
            async () => {
                const res = await httpClient(requestConfig);
                const status = Number(res?.status || 0);

                if (RETRYABLE_STATUSES.has(status)) {
                    const error = createHttpStatusError(res, url);
                    error.retryable = true;
                    throw error;
                }

                return res;
            },
            {
                attempts: Math.max(1, CONFIG.SCRAPER.RETRIES),
                shouldRetry: ({ error, status }) => {
                    const code = Number(status || error?.status || error?.response?.status || 0);
                    return code ? RETRYABLE_STATUSES.has(code) : Boolean(error);
                }
            }
        ));

        if (providerShield.shouldUseShield({
            url,
            status: response?.status,
            body: responseText(response),
            headers: response?.headers
        })) {
            const shielded = await providerShield.fetchAxiosLike(url, shieldOptions);
            if (shielded && isSuccessfulStatus(shielded.status || 200)) return shielded;
        }

        if (!isSuccessfulStatus(response?.status)) {
            throw createHttpStatusError(response, url);
        }

        return response;
    } catch (error) {
        if (providerShield.shouldUseShield({ url, error })) {
            const shielded = await providerShield.fetchAxiosLike(url, shieldOptions);
            if (shielded && isSuccessfulStatus(shielded.status || 200)) return shielded;
        }

        throw error;
    }
}

async function httpGetText(url, headers = {}, timeout = CONFIG.SCRAPER.TIMEOUT) {
    try {
        const response = await fetchSmart(url, { headers, timeout });
        return {
            status: response?.status || 0,
            text: responseText(response)
        };
    } catch (_) {
        return {
            status: 0,
            text: ''
        };
    }
}

function unbase(num, base) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let n = Number(num);
    const b = Number(base);

    if (!Number.isFinite(n) || !Number.isFinite(b) || b < 2) return '';
    if (n < b) return chars[n] || '';

    let out = '';

    while (n > 0) {
        out = chars[n % b] + out;
        n = Math.floor(n / b);
    }

    return out;
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unpackPacked(p, a, c, k) {
    let out = safeText(p);
    const base = Number(a);
    const count = Number(c);
    const tokens = Array.isArray(k) ? k : [];

    for (let i = count - 1; i >= 0; i -= 1) {
        const token = unbase(i, base);
        if (!token) continue;

        const replacement = tokens[i] || token;
        out = out.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g'), replacement);
    }

    return out;
}

function extractPacked(html) {
    const match = safeText(html).match(REGEX.PACKED);
    if (!match) return '';

    return unpackPacked(
        match[1],
        Number(match[2]),
        Number(match[3]),
        safeText(match[4]).split(match[5] || '|')
    );
}

async function probePlaylistIntelligenceCached(streamUrl, headers = {}) {
    const normalized = normalizeUrl(streamUrl);

    if (!/\.m3u8(?:$|[?#])/i.test(normalized)) return null;

    const cached = runtime.playlistCache.get(normalized);
    if (cached !== undefined) return cached;

    return runtime.playlistInflight.do(normalized, async () => {
        await runtime.playlistSemaphore.acquire();

        try {
            const intelligence = await probePlaylistIntelligence(httpClient, normalized, {
                headers: normalizeHeaders(headers),
                timeout: CONFIG.SCRAPER.PLAYLIST_TIMEOUT
            }).catch(() => null);

            runtime.playlistCache.set(normalized, intelligence || null);
            return intelligence || null;
        } finally {
            runtime.playlistSemaphore.release();
        }
    }).catch(() => null);
}

async function resolveStreamQuality(streamUrl, headers, fallback = 'Unknown', playlistIntel) {
    const guessed = parseQuality(fallback);
    const baseQuality = normalizeQuality(guessed !== 'Unknown' ? guessed : fallback);

    if (!/\.m3u8(?:$|[?#])/i.test(safeText(streamUrl))) return baseQuality || 'Unknown';
    if (baseQuality !== 'Unknown' && !CONFIG.SCRAPER.PREFER_PLAYLIST_PROBE) return baseQuality;

    const intel = playlistIntel !== undefined
        ? playlistIntel
        : await probePlaylistIntelligenceCached(streamUrl, headers || {});

    return pickBetterQuality(intel?.quality || 'Unknown', baseQuality || 'Unknown');
}

function parseStremioLikeId(raw) {
    const clean = safeText(raw).trim();
    if (!clean) return null;

    const decoded = (() => {
        try {
            return decodeURIComponent(clean);
        } catch (_) {
            return clean;
        }
    })();

    const tt = decoded.match(/^(tt\d+)(?::(\d+):(\d+))?$/i);
    if (tt) {
        return {
            imdbId: tt[1],
            season: tt[2] ? Number(tt[2]) : null,
            episode: tt[3] ? Number(tt[3]) : null,
            typeById: tt[2] && tt[3] ? 'tv' : 'movie'
        };
    }

    const tmdb = decoded.match(/^tmdb:(\d+)(?::(\d+):(\d+))?$/i);
    if (tmdb) {
        return {
            tmdbId: tmdb[1],
            season: tmdb[2] ? Number(tmdb[2]) : null,
            episode: tmdb[3] ? Number(tmdb[3]) : null,
            typeById: tmdb[2] && tmdb[3] ? 'tv' : 'movie'
        };
    }

    return null;
}

function resolveTmdbId(meta) {
    const direct = safeText(meta?.tmdb_id || meta?.tmdbId || meta?.tmdb).trim();
    if (/^\d+$/.test(direct)) return direct;

    const parsed = parseStremioLikeId(meta?.id || meta?.videoId || meta?.stremioId);
    if (parsed?.tmdbId) return parsed.tmdbId;

    const id = safeText(meta?.id || '').trim();
    const match = id.match(/^tmdb:(\d+)/i);

    return match ? match[1] : null;
}

async function fetchTmdbByImdb(imdbId, mediaType) {
    const hint = mediaType === 'tv' ? 'tv' : 'movie';

    for (const language of ['it-IT', 'en-US']) {
        try {
            const meta = await tmdbHelper.getTmdbMetaFromImdb(imdbId, {
                mediaHint: hint,
                language
            });

            if (meta) return meta;
        } catch (_) {}
    }

    return null;
}

async function fetchTmdbById(tmdbId, mediaType) {
    const clean = safeText(tmdbId).trim();
    if (!/^\d+$/.test(clean)) return null;

    const endpoint = mediaType === 'tv'
        ? `/tv/${encodeURIComponent(clean)}`
        : `/movie/${encodeURIComponent(clean)}`;

    for (const language of ['it-IT', 'en-US']) {
        try {
            const meta = await tmdbHelper.fetchTmdbJson(endpoint, {
                params: { language },
                cacheTtlMs: 30 * 60 * 1000
            });

            if (meta) return meta;
        } catch (_) {}
    }

    return null;
}

async function fetchImdbFromTmdb(tmdbId, mediaType) {
    const clean = safeText(tmdbId).trim();
    if (!/^\d+$/.test(clean)) return null;

    const hints = mediaType === 'tv' ? ['tv', 'series'] : ['movie'];

    for (const hint of hints) {
        try {
            const imdbId = await tmdbHelper.getImdbFromTmdb(clean, hint);
            if (/^tt\d+$/i.test(safeText(imdbId))) return String(imdbId);
        } catch (_) {}
    }

    return null;
}

function titleFromMeta(meta, tmdbMeta, fallback = 'Film HD') {
    const title = safeText(
        meta?.title ||
        meta?.name ||
        tmdbMeta?.title ||
        tmdbMeta?.name ||
        tmdbMeta?.original_title ||
        tmdbMeta?.original_name ||
        fallback
    ).trim() || fallback;

    const year = safeText(
        meta?.year ||
        (tmdbMeta?.release_date ? String(tmdbMeta.release_date).slice(0, 4) : '') ||
        (tmdbMeta?.first_air_date ? String(tmdbMeta.first_air_date).slice(0, 4) : '')
    ).trim();

    if (year && !new RegExp(`\\(${escapeRegExp(year)}\\)`).test(title)) {
        return `${title} (${year})`;
    }

    return title;
}

async function resolveMediaIdentity(meta) {
    if (!meta) return null;

    const parsedId = parseStremioLikeId(meta.id || meta.videoId || meta.stremioId || '');
    const explicitImdb = /^tt\d+$/i.test(safeText(meta.imdb_id || meta.imdbId).trim())
        ? safeText(meta.imdb_id || meta.imdbId).trim()
        : parsedId?.imdbId || null;

    const isSeries = Boolean(
        meta.isSeries ||
        meta.type === 'series' ||
        meta.type === 'tv' ||
        parsedId?.typeById === 'tv'
    );

    const mediaType = isSeries ? 'tv' : 'movie';
    const season = Number(meta.season || meta.s || parsedId?.season || 0) || null;
    const episode = Number(meta.episode || meta.e || parsedId?.episode || 0) || null;
    const fallbackTitle = mediaType === 'tv' ? 'Serie TV' : 'Film HD';

    if (mediaType === 'tv' && (!season || !episode)) return null;

    if (explicitImdb) {
        const tmdbMeta = await fetchTmdbByImdb(explicitImdb, mediaType).catch(() => null);
        const tmdbId = safeText(tmdbMeta?.tmdb_id || tmdbMeta?.id || resolveTmdbId(meta)).trim() || null;

        return {
            imdbId: explicitImdb,
            tmdbId,
            mediaType,
            season,
            episode,
            title: titleFromMeta(meta, tmdbMeta, fallbackTitle),
            cacheKey: mediaType === 'tv'
                ? `tv:${explicitImdb}:${season}:${episode}`
                : `movie:${explicitImdb}`
        };
    }

    const tmdbId = resolveTmdbId(meta);
    if (tmdbId) {
        const [tmdbMeta, imdbId] = await Promise.all([
            fetchTmdbById(tmdbId, mediaType),
            fetchImdbFromTmdb(tmdbId, mediaType)
        ]);

        if (!imdbId) return null;

        return {
            imdbId,
            tmdbId,
            mediaType,
            season,
            episode,
            title: titleFromMeta(meta, tmdbMeta, fallbackTitle),
            cacheKey: mediaType === 'tv'
                ? `tv:${imdbId}:${season}:${episode}`
                : `movie:${imdbId}`
        };
    }

    return null;
}

function endpointForMedia(identity) {
    if (identity.mediaType === 'tv') {
        return `${CONFIG.SCRAPER.BASE_URL}/set-tv-a/${identity.imdbId}/${identity.season}/${identity.episode}`;
    }

    return `${CONFIG.SCRAPER.BASE_URL}/set-movie-a/${identity.imdbId}`;
}

function extractRegexAll(regex, html) {
    const out = [];
    const text = safeText(html);
    const scanner = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);

    let match;

    while ((match = scanner.exec(text)) !== null) {
        out.push(match[1] || match[0]);

        if (match.index === scanner.lastIndex) {
            scanner.lastIndex += 1;
        }
    }

    return out;
}

function isUsefulEmbedUrl(url) {
    const normalized = normalizeUrl(url);

    if (!/^https?:\/\//i.test(normalized)) return false;

    return ALLOWED_HOSTERS.has(hosterFromUrl(normalized));
}

async function scrapeEmbedUrls(identity) {
    try {
        const endpoint = endpointForMedia(identity);

        const response = await fetchSmart(endpoint, {
            headers: {
                'User-Agent': MAC_UA,
                Referer: CONFIG.SCRAPER.BASE_URL,
                Accept: 'text/html,application/xhtml+xml'
            }
        });

        const html = responseText(response);
        if (!html || REGEX.NOT_FOUND.test(html)) return [];

        const $ = cheerio.load(html);
        const links = [];
        const seen = new Set();

        const push = (raw) => {
            const normalized = normalizeUrl(raw);
            if (!isUsefulEmbedUrl(normalized)) return;

            const key = embedDedupeKey(normalized);
            if (seen.has(key)) return;

            seen.add(key);
            links.push(normalized);
        };

        $('iframe[src]').each((_, el) => push($(el).attr('src')));
        $('li[data-link]').each((_, el) => push($(el).attr('data-link')));
        $('a[href]').each((_, el) => push($(el).attr('href')));
        $('source[src]').each((_, el) => push($(el).attr('src')));

        for (const value of extractRegexAll(REGEX.IFRAME, html)) push(value);
        for (const value of extractRegexAll(REGEX.DATA_LINK, html)) push(value);
        for (const value of extractRegexAll(REGEX.SRC_HREF, html)) push(value);
        for (const value of safeText(html).match(REGEX.DIRECT_URL) || []) push(value);

        if (registryDirectLinkRegex) {
            for (const value of safeText(html).match(registryDirectLinkRegex) || []) {
                push(value);
            }
        }

        const semanticEmbeds = extractResilientEmbeds(html, {
            baseUrl: endpoint,
            maxCandidates: CONFIG.SCRAPER.MAX_EMBEDS
        }) || [];

        for (const semanticUrl of semanticEmbeds) {
            push(semanticUrl);
        }

        debug('embeds scraped', {
            type: identity.mediaType,
            embeds: links.length,
            endpoint
        });

        return links.slice(0, CONFIG.SCRAPER.MAX_EMBEDS);
    } catch (error) {
        debug('embed scrape failed', {
            error: error?.message || String(error)
        });
        return [];
    }
}

async function extractViaRegistry(embedUrl) {
    const embedHoster = hosterFromUrl(embedUrl);

    if (!ALLOWED_HOSTERS.has(embedHoster)) return [];

    const definition = resolveExtractorDefinition(embedUrl);
    if (!definition) return [];

    try {
        const result = await extractFromUrl(embedUrl, {
            client: httpClient,
            userAgent: getRandomUserAgent(),
            requestReferer: CONFIG.SCRAPER.BASE_URL,
            referer: CONFIG.SCRAPER.BASE_URL
        });

        const items = Array.isArray(result) ? result : (result ? [result] : []);

        return items
            .filter((item) => item?.url)
            .map((item) => ({
                url: normalizeUrl(item.url),
                headers: normalizeHeaders(item.headers),
                behaviorHints: item.behaviorHints || item.extraBehaviorHints || {},
                name: item.name || hosterLabel(embedHoster),
                quality: item.quality || 'Unknown',
                size: item.size || 'N/A',
                hoster: embedHoster,
                priority: item.priority ?? definition.priority ?? HOSTER_PRIORITY[embedHoster] ?? 9
            }))
            .filter((item) => /^https?:\/\//i.test(item.url));
    } catch (_) {
        return [];
    }
}

async function extractMixdropMediaflow(embedUrl, config) {
    if (!getMediaflowBase(config)) return [];

    const normalized = normalizeUrl(embedUrl);
    const playerUrl = normalized.replace('/f/', '/e/');
    let quality = parseQuality(playerUrl);
    let size = 'N/A';

    try {
        const fileUrl = playerUrl.replace('/e/', '/f/');
        const response = await fetchSmart(fileUrl, {
            headers: {
                Referer: `${originFromUrl(fileUrl)}/`
            },
            timeout: 8000
        });

        const html = responseText(response);

        quality = pickBetterQuality(parseQuality(html), quality);
        size = extractSize(html, fileUrl);
    } catch (_) {}

    const mediaflowUrl = buildMediaflowUrl(config, playerUrl, 'extractor', 'Mixdrop', {
        extractorPath: '/extractor/video.mp4',
        redirectStream: true,
        headers: extractorHeadersFor(playerUrl, 'mixdrop')
    });
    if (!mediaflowUrl) return [];

    debug('mixdrop kraken extractor fallback built', {
        embedHost: safeHost(playerUrl),
        embedPath: safePath(playerUrl),
        krakenHost: safeHost(mediaflowUrl),
        krakenPath: safePath(mediaflowUrl)
    });

    return [{
        url: mediaflowUrl,
        headers: {},
        behaviorHints: { notWebReady: false },
        name: 'MixDrop',
        quality,
        size,
        hoster: 'mixdrop',
        priority: HOSTER_PRIORITY.mixdrop
    }];
}

async function extractPackedFileFallback(embedUrl, hoster) {
    const normalized = normalizeUrl(embedUrl);
    const origin = originFromUrl(normalized);

    const headers = {
        'User-Agent': CHROME_UA,
        Referer: origin ? `${origin}/` : CONFIG.SCRAPER.BASE_URL
    };

    const { status, text } = await httpGetText(normalized, headers, 10000);
    if (status < 200 || status >= 400 || !text) return [];

    const unpacked = extractPacked(text) || text;
    const match = unpacked.match(REGEX.FILE)
        || unpacked.match(REGEX.SOURCES_OBJECT)
        || unpacked.match(REGEX.SOURCES_ARRAY);

    if (!match) return [];

    const streamUrl = normalizeUrl(match[1]);
    if (!/^https?:\/\//i.test(streamUrl)) return [];

    return [{
        url: streamUrl,
        headers,
        name: hosterLabel(hoster),
        quality: parseQuality(`${streamUrl} ${unpacked}`),
        size: extractSize(unpacked, streamUrl),
        hoster,
        priority: HOSTER_PRIORITY[hoster] ?? 9
    }];
}

async function extractManual(embedUrl, config) {
    const hoster = hosterFromUrl(embedUrl);

    if (hoster === 'mixdrop') return extractMixdropMediaflow(embedUrl, config);
    if (hoster === 'dropload') return extractPackedFileFallback(embedUrl, 'dropload');
    if (hoster === 'streamhg') return extractPackedFileFallback(embedUrl, 'streamhg');

    return [];
}

function shouldNotWebReady(hoster, name) {
    const text = `${hoster || ''} ${name || ''}`.toLowerCase();

    return text.includes('mixdrop') ||
        text.includes('m1xdrop') ||
        text.includes('mxcontent');
}

async function finalizeRawStream(raw, displayTitle, embedUrl, config = {}) {
    if (!raw?.url) return null;

    const streamUrl = normalizeUrl(raw.url);
    if (!/^https?:\/\//i.test(streamUrl)) return null;

    const hoster = raw.hoster || hosterFromUrl(embedUrl || streamUrl);
    if (!ALLOWED_HOSTERS.has(hoster)) return null;

    const headers = normalizeHeaders(raw.headers || raw.playbackHeaders || {});
    const behaviorHints = { ...(raw.behaviorHints || {}) };
    const proxyHeaders = behaviorHints?.proxyHeaders?.request;
    const effectiveHeaders = Object.keys(headers).length ? headers : normalizeHeaders(proxyHeaders || {});
    const shouldKrakenProxy = CONFIG.SCRAPER.KRAKEN_PROXY_DIRECT_STREAMS
        && getMediaflowBase(config)
        && !isKrakenOrMediaflowUrl(config, streamUrl);
    const playbackUrl = shouldKrakenProxy
        ? buildKrakenProxyUrl(config, streamUrl, effectiveHeaders, hoster)
        : streamUrl;
    const finalHeaders = playbackUrl !== streamUrl ? {} : effectiveHeaders;

    if (Object.keys(finalHeaders).length) {
        behaviorHints.proxyHeaders = behaviorHints.proxyHeaders || {};
        behaviorHints.proxyHeaders.request = finalHeaders;
        behaviorHints.headers = finalHeaders;
    } else {
        delete behaviorHints.proxyHeaders;
        delete behaviorHints.headers;
    }

    if (shouldNotWebReady(hoster, raw.name)) {
        behaviorHints.notWebReady = playbackUrl === streamUrl && !isKrakenOrMediaflowUrl(config, playbackUrl);
    }

    const guessed = parseQuality(`${raw.quality || ''} ${raw.name || ''} ${raw.title || ''} ${embedUrl || ''} ${streamUrl}`);
    const playlistIntel = await probePlaylistIntelligenceCached(playbackUrl, finalHeaders);
    const resolvedQuality = await resolveStreamQuality(playbackUrl, finalHeaders, raw.quality || guessed, playlistIntel);
    const quality = normalizeGuardaHdDisplayQuality(
        pickBetterQuality(playlistIntel?.quality || 'Unknown', resolvedQuality)
    );

    const size = raw.size && raw.size !== 'N/A'
        ? raw.size
        : extractSize(raw.title, raw.name, embedUrl, streamUrl);

    const label = raw.name || hosterLabel(hoster);
    const priority = raw.priority ?? HOSTER_PRIORITY[hoster] ?? 9;

    let stream = buildWebStream({
        name: `🦁 GHD\n⚡ ${label}`,
        title: generateRichDescription(displayTitle, quality, size, label),
        url: playbackUrl,
        extractor: label,
        provider: 'GuardaHD',
        providerCode: 'GHD',
        quality,
        headers: Object.keys(finalHeaders).length ? finalHeaders : null,
        mediaflowUrl: getMediaflowBase(config) || null,
        extraBehaviorHints: {
            bingeWatching: true,
            ...behaviorHints
        },
        extra: {
            _priority: priority,
            _hoster: hoster
        }
    });

    stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
    return stream;
}

class GuardaHDScraper {
    #config;
    #reqHost;

    constructor(config = {}, reqHost = null) {
        this.#config = config || {};
        this.#reqHost = reqHost || null;
    }

    async #refreshCache(identity) {
        try {
            const embeds = await scrapeEmbedUrls(identity);
            if (embeds?.length) {
                await cacheManager.set(identity.cacheKey, {
                    embeds,
                    title: identity.title
                });
            }
        } catch (_) {}
    }

    async #getCachedEmbeds(identity) {
        const key = identity.cacheKey;
        const { data: cached, isStale } = await cacheManager.get(key);

        if (cached?.embeds?.length) {
            if (isStale) {
                this.#refreshCache(identity).catch(() => {});
            }

            return {
                embeds: Array.isArray(cached.embeds) ? cached.embeds : [],
                title: cached.title || identity.title,
                cacheHit: true
            };
        }

        const embeds = await scrapeEmbedUrls(identity);

        if (embeds.length) {
            await cacheManager.set(key, {
                embeds,
                title: identity.title
            });
        }

        return {
            embeds,
            title: identity.title,
            cacheHit: false
        };
    }

    async #processSingleEmbed(embedUrl, displayTitle) {
        await runtime.embedSemaphore.acquire();

        try {
            const normalized = normalizeUrl(embedUrl);
            const hoster = hosterFromUrl(normalized);

            if (!ALLOWED_HOSTERS.has(hoster)) return [];

            let rawStreams = [];

            if (hoster === 'mixdrop' && getMediaflowBase(this.#config) && CONFIG.SCRAPER.MIXDROP_LOCAL_PROXY_FIRST) {
                rawStreams = await extractViaRegistry(normalized);
                if (rawStreams.length) {
                    debug('mixdrop local extraction success; proxying source through kraken', {
                        embedHost: safeHost(normalized),
                        streams: rawStreams.length
                    });
                }
            }

            if (!rawStreams.length && hoster === 'mixdrop' && getMediaflowBase(this.#config)) {
                rawStreams = await extractMixdropMediaflow(normalized, this.#config);
            }

            if (!rawStreams.length) {
                rawStreams = await extractViaRegistry(normalized);
            }

            if (!rawStreams.length) {
                rawStreams = await extractManual(normalized, this.#config);
            }

            if (!rawStreams.length) {
                const lazy = buildLazyExtractorStream({
                    embedUrl: normalized,
                    reqHost: this.#reqHost,
                    provider: 'GuardaHD',
                    providerCode: 'GHD',
                    title: displayTitle,
                    name: hosterLabel(hoster),
                    quality: parseQuality(normalized),
                    referer: CONFIG.SCRAPER.BASE_URL,
                    extra: {
                        _priority: HOSTER_PRIORITY[hoster] ?? 9,
                        _hoster: hoster
                    }
                });

                return lazy ? [lazy] : [];
            }

            const finalized = [];

            for (const raw of rawStreams) {
                const stream = await finalizeRawStream(raw, displayTitle, normalized, this.#config);
                if (stream) finalized.push(stream);
            }

            return finalized;
        } catch (_) {
            return [];
        } finally {
            runtime.embedSemaphore.release();
        }
    }

    #dedupAndSort(streams) {
        const unique = new Map();

        for (const stream of streams) {
            if (!stream?.url) continue;

            const existing = unique.get(stream.url);

            if (!existing) {
                unique.set(stream.url, stream);
                continue;
            }

            const currentPriority = Number(stream._priority ?? stream.extra?._priority ?? 9);
            const existingPriority = Number(existing._priority ?? existing.extra?._priority ?? 9);
            const currentQualityRank = qualityRank(stream.quality || 'Unknown');
            const existingQualityRank = qualityRank(existing.quality || 'Unknown');

            if (
                currentQualityRank > existingQualityRank ||
                (currentQualityRank === existingQualityRank && currentPriority < existingPriority)
            ) {
                unique.set(stream.url, stream);
            }
        }

        return Array.from(unique.values())
            .sort((a, b) => {
                const qualityDelta = qualityRank(b.quality || 'Unknown') - qualityRank(a.quality || 'Unknown');
                if (qualityDelta !== 0) return qualityDelta;

                const hosterDelta = Number(a._priority ?? a.extra?._priority ?? 9) -
                    Number(b._priority ?? b.extra?._priority ?? 9);
                if (hosterDelta !== 0) return hosterDelta;

                return safeText(a.title).localeCompare(safeText(b.title));
            })
            .map((stream) => {
                const { _priority, _hoster, ...clean } = stream;

                if (clean.extra && typeof clean.extra === 'object') {
                    delete clean.extra._priority;
                    delete clean.extra._hoster;

                    if (!Object.keys(clean.extra).length) {
                        delete clean.extra;
                    }
                }

                return clean;
            });
    }

    async getStreams(meta) {
        const started = Date.now();
        const identity = await resolveMediaIdentity(meta);

        if (!identity?.imdbId) return [];

        const { embeds, title, cacheHit } = await this.#getCachedEmbeds(identity);
        if (!embeds.length) return [];

        const displayTitle = identity.mediaType === 'tv'
            ? `${title} ${identity.season}x${identity.episode}`
            : title;

        const settled = await Promise.allSettled(
            embeds.map((url) => this.#processSingleEmbed(url, displayTitle))
        );

        const rawStreams = settled
            .filter((item) => item.status === 'fulfilled')
            .flatMap((item) => item.value || []);

        const streams = normalizeStreams(this.#dedupAndSort(rawStreams), {
            provider: 'guardahd',
            providerLabel: 'GuardaHD',
            providerCode: 'GHD',
            sort: false,
            debug: CONFIG.SCRAPER.DEBUG
        });

        debug('done', {
            type: identity.mediaType,
            cache: cacheHit,
            embeds: embeds.length,
            streams: streams.length,
            ms: Date.now() - started
        });

        return streams;
    }
}

async function searchGuardaHDImpl(meta, config, reqHost = null) {
    return new GuardaHDScraper(config, reqHost).getStreams(meta);
}

async function searchGuardaHD(meta, config, reqHost = null) {
    return withProviderHealth('guardahd', () => searchGuardaHDImpl(meta, config, reqHost), {
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = { searchGuardaHD };
