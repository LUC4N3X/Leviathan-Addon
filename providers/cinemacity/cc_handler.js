'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const {
    buildContextHeaders,
    createCircuitBreaker,
    createDomainCookieJar,
    getStickyFingerprintForUrl,
    isCloudflareChallenge,
    requestWithImpitRotating,
    responseText
} = require('../utils/bypass');
const { createBlockedFallbackGuard } = require('../utils/provider_blocked_fallback');
const { SingleFlight, TtlLruCache } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { createRustShieldClient } = require('../utils/rust_shield_client');
const { normalizeStreams } = require('../utils/stream_normalizer');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const animeIdentity = require('../anime/anime_identity');
const kitsuProvider = require('../animeworld/kitsu_provider');
const { buildCinemaCityProxyUrl, prewarmCinemaCityPlayback } = require('./cc_proxy');
const {
    buildWebStream,
    dedupeStreamsByUrl,
    normalizeRemoteUrl,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistQuality,
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence,
    qualityRank
} = require('../extractors/common');
const {
    buildExtractorUrl: buildMediaflowGatewayExtractorUrl,
    buildProxyUrl: buildMediaflowGatewayProxyUrl,
    getMediaflowBase
} = require('../../core/proxy/mediaflow_gateway');

const BASE_URL = Buffer.from('aHR0cHM6Ly9jaW5lbWFjaXR5LmNj', 'base64').toString('utf8');
const DEFAULT_SESSION_COOKIE = Buffer.from(
    'ZGxlX3VzZXJfaWQ9MzI3Mjk7IGRsZV9wYXNzd29yZD04OTQxNzFjNmE4ZGFiMThlZTU5NGQ1YzY1MjAwOWEzNTs=',
    'base64'
).toString('utf8');
const FETCH_TIMEOUT = 4500;
const IMPIT_TIMEOUT = 2500;
const IMPIT_ATTEMPTS = 3;
const IMPIT_ROTATING_MAX_ATTEMPTS = 2;
const IMPIT_ROTATING_HARD_ATTEMPTS = 3;
const IMPIT_TOTAL_BUDGET_MS = 5200;
const IMPIT_WARMUP_TTL_MS = 10 * 60 * 1000;
const DIRECT_BREAKER_FAILURES = 3;
const DIRECT_BREAKER_RESET_MS = 45 * 1000;
const MAX_LISTING_PAGES = 8;
const MAX_LISTING_CANDIDATES_PER_PAGE = 24;
const SEARCH_CACHE_TTL_MS = 20 * 60 * 1000;
const RESOLVED_SEARCH_CACHE_TTL_MS = 45 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;
const TMDB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const KITSU_MAPPING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const QUALITY_PROBE_CACHE_TTL_MS = 20 * 60 * 1000;

// CinemaCity tuned defaults are embedded here, so the addon works without adding
// the CinemaCity tuning block to .env. Real environment variables still win if set.
const CINEMACITY_EMBEDDED_ENV_DEFAULTS = Object.freeze({
    CINEMACITY_BACKGROUND_CLEARANCE: 'true',
    CINEMACITY_BACKGROUND_CLEARANCE_DELAY_MS: '30000',
    CINEMACITY_BACKGROUND_CLEARANCE_REFRESH_MS: '600000',
    CINEMACITY_BACKGROUND_CLEARANCE_FORCE: 'false',
    CINEMACITY_BACKGROUND_PRIME_HOME: 'false',
    CINEMACITY_BACKGROUND_PRIME_SEARCH: 'true',

    CINEMACITY_PAGE_EXTRACTOR_PATH: '/extractor/video.m3u8',
    CINEMACITY_PAGE_EXTRACTOR_HOST: 'cccdn',
    CINEMACITY_PAGE_EXTRACTOR_LABEL: 'CCCDN',
    MEDIAFLOW_CCCDN_EXTRACTOR_PATH: '/extractor/video.m3u8',

    CINEMACITY_SITEMAP_LOOKUP: 'false',
    CINEMACITY_RUST_ACCEL_SITEMAP: 'false',
    CINEMACITY_RUST_ACCEL_SEARCH_GET: 'false',
    CINEMACITY_FORCE_CLEARANCE_BEFORE_SEARCH: 'true',
    CINEMACITY_FORWARD_PROXY_FIRST: 'false',
    CINEMACITY_FORWARD_PROXY_ENABLED: 'true',
    CINEMACITY_SEARCH_POST_FIRST: 'true',
    CINEMACITY_PAGE_EXTRACTOR_PRIMARY: 'true',
    CINEMACITY_MOVIE_PAGE_EXTRACTOR_PRIMARY: 'true',
    CINEMACITY_RUST_SHIELD_SESSION: 'false',
    CINEMACITY_CF_FALLBACK: 'true',
    CINEMACITY_ALLOW_RAW_DIRECT: 'false',
    CINEMACITY_SERIES_FORCE_CCDN: 'true',

    CINEMACITY_BACKGROUND_CLEARANCE_RETRY_MS: '30000',
    CINEMACITY_FLARE_TIMEOUT: '60000',
    CINEMACITY_SEARCH_POST_TIMEOUT_MS: '5000',
    CINEMACITY_DIRECT_FETCH_TIMEOUT: '6500',

    CC_PROVIDER_TIMEOUT: '42000',
    CC_PROVIDER_EMPTY_TTL: '60',
    CC_PROVIDER_ERROR_TTL: '10'
});

for (const [name, value] of Object.entries(CINEMACITY_EMBEDDED_ENV_DEFAULTS)) {
    if (process.env[name] === undefined || process.env[name] === null || process.env[name] === '') {
        process.env[name] = value;
    }
}

const FAST_PLAYBACK_MODE = String(process.env.CINEMACITY_FAST_PLAYBACK || '1') !== '0';
const QUALITY_PROBE_FAST_TIMEOUT_MS = Math.max(650, Math.min(6000, Number.parseInt(process.env.CINEMACITY_QUALITY_PROBE_TIMEOUT_MS || '1400', 10) || 1400));
const QUALITY_PROBE_FULL_TIMEOUT_MS = Math.max(1500, Math.min(8000, Number.parseInt(process.env.CINEMACITY_QUALITY_PROBE_FULL_TIMEOUT_MS || '6000', 10) || 6000));
function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}
const CINEMACITY_USE_RUST_SHIELD = envFlag('CINEMACITY_RUST_SHIELD', true);
const CINEMACITY_USE_CF_FALLBACK = envFlag('CINEMACITY_CF_FALLBACK', true);
const CINEMACITY_RUST_ACCEL = envFlag('CINEMACITY_RUST_ACCEL', true);
const CINEMACITY_RUST_ACCEL_RACE = envFlag('CINEMACITY_RUST_ACCEL_RACE', true);
const CINEMACITY_RUST_ACCEL_LISTING = envFlag('CINEMACITY_RUST_ACCEL_LISTING', true);
const CINEMACITY_RUST_ACCEL_SEARCH_GET = envFlag('CINEMACITY_RUST_ACCEL_SEARCH_GET', false);
const CINEMACITY_RUST_ACCEL_SITEMAP = envFlag('CINEMACITY_RUST_ACCEL_SITEMAP', false);
const CINEMACITY_RUST_ACCEL_TIMEOUT_MS = Math.max(350, Math.min(2500, Number.parseInt(process.env.CINEMACITY_RUST_ACCEL_TIMEOUT_MS || '950', 10) || 950));
const CINEMACITY_RUST_ACCEL_CACHE_TTL_MS = Math.max(30 * 1000, Math.min(60 * 60 * 1000, Number.parseInt(process.env.CINEMACITY_RUST_ACCEL_CACHE_TTL_MS || String(15 * 60 * 1000), 10) || (15 * 60 * 1000)));
const CINEMACITY_RUST_ACCEL_STALE_TTL_MS = Math.max(CINEMACITY_RUST_ACCEL_CACHE_TTL_MS, Math.min(4 * 60 * 60 * 1000, Number.parseInt(process.env.CINEMACITY_RUST_ACCEL_STALE_TTL_MS || String(60 * 60 * 1000), 10) || (60 * 60 * 1000)));
const CINEMACITY_SEARCH_WARMUP = envFlag('CINEMACITY_SEARCH_WARMUP', false);
const CINEMACITY_SITEMAP_LOOKUP = envFlag('CINEMACITY_SITEMAP_LOOKUP', false);
const CINEMACITY_FORCE_CLEARANCE_BEFORE_SEARCH = envFlag('CINEMACITY_FORCE_CLEARANCE_BEFORE_SEARCH', true);
const CINEMACITY_BACKGROUND_CLEARANCE = envFlag('CINEMACITY_BACKGROUND_CLEARANCE', true)
    && process.env.NODE_ENV !== 'test'
    && !process.env.JEST_WORKER_ID
    && !process.env.VITEST;
const CINEMACITY_BACKGROUND_CLEARANCE_FORCE = envFlag('CINEMACITY_BACKGROUND_CLEARANCE_FORCE', true);
const CINEMACITY_BACKGROUND_CLEARANCE_DELAY_MS = Math.max(0, Math.min(120000, Number.parseInt(process.env.CINEMACITY_BACKGROUND_CLEARANCE_DELAY_MS || '2500', 10) || 2500));
const CINEMACITY_BACKGROUND_CLEARANCE_REFRESH_MS = Math.max(60000, Math.min(3600000, Number.parseInt(process.env.CINEMACITY_BACKGROUND_CLEARANCE_REFRESH_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000)));
const CINEMACITY_BACKGROUND_CLEARANCE_RETRY_MS = Math.max(5000, Math.min(300000, Number.parseInt(process.env.CINEMACITY_BACKGROUND_CLEARANCE_RETRY_MS || '30000', 10) || 30000));
const CINEMACITY_BACKGROUND_PRIME_HOME = envFlag('CINEMACITY_BACKGROUND_PRIME_HOME', true);
const CINEMACITY_BACKGROUND_PRIME_SEARCH = envFlag('CINEMACITY_BACKGROUND_PRIME_SEARCH', false);
const CINEMACITY_BACKGROUND_PRIME_QUERY = String(process.env.CINEMACITY_BACKGROUND_PRIME_QUERY || 'a').trim() || 'a';
const CINEMACITY_SITEMAP_TIMEOUT_MS = Math.max(900, Math.min(3500, Number.parseInt(process.env.CINEMACITY_SITEMAP_TIMEOUT_MS || '1400', 10) || 1400));
const CINEMACITY_SITEMAP_TOTAL_MS = Math.max(CINEMACITY_SITEMAP_TIMEOUT_MS + 250, Math.min(4500, Number.parseInt(process.env.CINEMACITY_SITEMAP_TOTAL_MS || '2300', 10) || 2300));
const CINEMACITY_SEARCH_GET_TIMEOUT_MS = Math.max(1200, Math.min(5000, Number.parseInt(process.env.CINEMACITY_SEARCH_GET_TIMEOUT_MS || '2400', 10) || 2400));
const CINEMACITY_SEARCH_GET_TOTAL_MS = Math.max(CINEMACITY_SEARCH_GET_TIMEOUT_MS + 500, Math.min(6500, Number.parseInt(process.env.CINEMACITY_SEARCH_GET_TOTAL_MS || '3800', 10) || 3800));
const CINEMACITY_SEARCH_POST_TIMEOUT_MS = Math.max(1200, Math.min(5000, Number.parseInt(process.env.CINEMACITY_SEARCH_POST_TIMEOUT_MS || '2600', 10) || 2600));
const CINEMACITY_SEARCH_POST_TOTAL_MS = Math.max(CINEMACITY_SEARCH_POST_TIMEOUT_MS + 600, Math.min(7000, Number.parseInt(process.env.CINEMACITY_SEARCH_POST_TOTAL_MS || '4300', 10) || 4300));
const CINEMACITY_SEARCH_POST_FIRST = envFlag('CINEMACITY_SEARCH_POST_FIRST', true);
const CINEMACITY_QUICK_TITLE_SEARCH = envFlag('CINEMACITY_QUICK_TITLE_SEARCH', true);
const CINEMACITY_QUICK_TITLE_QUERIES = Math.max(1, Math.min(6, Number.parseInt(process.env.CINEMACITY_QUICK_TITLE_QUERIES || '3', 10) || 3));
const CINEMACITY_AXIOS_ON_BLOCKED = envFlag('CINEMACITY_AXIOS_ON_BLOCKED', true);
const CINEMACITY_LISTING_SCAN = envFlag('CINEMACITY_LISTING_SCAN', true);
const CINEMACITY_LISTING_MAX_PAGES = Math.max(4, Math.min(80, Number.parseInt(process.env.CINEMACITY_LISTING_MAX_PAGES || '55', 10) || 55));
const CINEMACITY_LISTING_CONCURRENCY = Math.max(1, Math.min(8, Number.parseInt(process.env.CINEMACITY_LISTING_CONCURRENCY || '3', 10) || 3));
const CINEMACITY_LISTING_TIMEOUT_MS = Math.max(900, Math.min(4500, Number.parseInt(process.env.CINEMACITY_LISTING_TIMEOUT_MS || '2200', 10) || 2200));
const CINEMACITY_LISTING_TOTAL_MS = Math.max(CINEMACITY_LISTING_TIMEOUT_MS + 900, Math.min(9000, Number.parseInt(process.env.CINEMACITY_LISTING_TOTAL_MS || '6500', 10) || 6500));
const CINEMACITY_LISTING_CACHE_TTL_MS = Math.max(5 * 60 * 1000, Math.min(4 * 60 * 60 * 1000, Number.parseInt(process.env.CINEMACITY_LISTING_CACHE_TTL_MS || String(45 * 60 * 1000), 10) || (45 * 60 * 1000)));
const CINEMACITY_LISTING_PAGE_CACHE_TTL_MS = Math.max(2 * 60 * 1000, Math.min(60 * 60 * 1000, Number.parseInt(process.env.CINEMACITY_LISTING_PAGE_CACHE_TTL_MS || String(20 * 60 * 1000), 10) || (20 * 60 * 1000)));
const CINEMACITY_DEBUG = envFlag('CINEMACITY_DEBUG', false) || envFlag('DEBUG_CINEMACITY', false);
const CINEMACITY_KRAKEN_FORWARD_URL = (
    String(process.env.CINEMACITY_FORWARD_PROXY || '').trim()
    || String(process.env.CINEMACITY_KRAKEN_FORWARD_URL || '').trim()
    || 'https://krakenproxy.questoleviatanormio.dpdns.org/forward?url='
);
const CINEMACITY_KRAKEN_FORWARD_ENABLED = envFlag('CINEMACITY_FORWARD_PROXY_ENABLED', true);
const CINEMACITY_KRAKEN_FORWARD_FIRST = envFlag('CINEMACITY_FORWARD_PROXY_FIRST', false);
const CINEMACITY_KRAKEN_FORWARD_TIMEOUT_MS = Math.max(1500, Math.min(15000, Number.parseInt(process.env.CINEMACITY_FORWARD_PROXY_TIMEOUT_MS || '6000', 10) || 6000));
// Serie CinemaCity: preferiamo il proxy locale CCCDN/ccproxy come nei film.
// Il page extractor MediaFlow/Kraken resta fallback se la pagina non espone un file episodio sicuro.
const CINEMACITY_SERIES_FORCE_CCDN = envFlag('CINEMACITY_SERIES_FORCE_CCDN', true);
const CINEMACITY_PAGE_EXTRACTOR_HOST = String(process.env.CINEMACITY_PAGE_EXTRACTOR_HOST || 'cccdn').trim() || 'cccdn';
const CINEMACITY_PAGE_EXTRACTOR_LABEL = String(process.env.CINEMACITY_PAGE_EXTRACTOR_LABEL || 'CCCDN').trim() || 'CCCDN';
const CINEMACITY_PAGE_EXTRACTOR_PRIMARY = envFlag('CINEMACITY_PAGE_EXTRACTOR_PRIMARY', true);
const CINEMACITY_MOVIE_PAGE_EXTRACTOR_PRIMARY = envFlag('CINEMACITY_MOVIE_PAGE_EXTRACTOR_PRIMARY', CINEMACITY_PAGE_EXTRACTOR_PRIMARY);
const CINEMACITY_SERIES_PAGE_EXTRACTOR_PRIMARY = envFlag('CINEMACITY_SERIES_PAGE_EXTRACTOR_PRIMARY', false);
const MAPPING_API_BASE = 'https://anime.questoleviatanormio.dpdns.org';
const NEWS_SITEMAP_URL = `${BASE_URL}/news_pages.xml`;
const providerShield = createBlockedFallbackGuard({
    providerName: 'cinemacity',
    envPrefix: 'CINEMACITY',
    baseUrl: BASE_URL,
    logPrefix: 'CC-SHIELD',
    enabled: CINEMACITY_USE_CF_FALLBACK,
    // FlareSolverr fallback on by default (easystreams-style): on Cloudflare block,
    // request clearance cookies+UA from FlareSolverr and retry through provider_http_guard.
    useRustShield: CINEMACITY_USE_RUST_SHIELD,
    useRustShieldForSession: envFlag('CINEMACITY_RUST_SHIELD_SESSION', false),
    // CinemaCity movie pages are large DLE templates (~50-100KB) that contain text/css
    // tokens ("cloudflare", "ray id", "cf-..." classes) which trip the heuristic scoring
    // in provider_http_guard. Restrict the challenge detection to the canonical signals
    // (status 403/429/503 + Cloudflare-specific bodies) so real pages aren't rejected
    // after FlareSolverr clearance has been obtained.
    strictChallengeOnly: true
});
const cinemaCityRustAccel = createRustShieldClient({
    providerName: 'cinemacity-accel',
    logger: {
        debug(message, data = {}) { logCinemaCityDebug(message, data); },
        warn(message, data = {}) { logCinemaCityDebug(message, data); }
    }
});
let lastProviderBlockedFetch = null;
function markProviderBlockedFetch(url, reason) {
    lastProviderBlockedFetch = { url: String(url || ''), reason: reason || 'blocked', at: Date.now() };
}
function wasProviderBlockedFetch(url) {
    return Boolean(lastProviderBlockedFetch && lastProviderBlockedFetch.url === String(url || '') && Date.now() - lastProviderBlockedFetch.at < 15000);
}
function logCinemaCityDebug(message, data = {}) {
    if (!CINEMACITY_DEBUG) return;
    try {
        console.log(`[CinemaCity:debug] ${message}`, JSON.stringify(data));
    } catch (_) {
        console.log(`[CinemaCity:debug] ${message}`);
    }
}
function logCinemaCityInfo(message, data = {}) {
    try {
        console.log(`[CinemaCity] ${message}`, JSON.stringify(data));
    } catch (_) {
        console.log(`[CinemaCity] ${message}`);
    }
}
const NEWS_SITEMAP_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const { updateCookiesFromResponse, getCookieHeaderForUrl } = createDomainCookieJar();

function getCinemaCitySessionCookie() {
    return String(process.env.CINEMACITY_COOKIE || '').trim() || DEFAULT_SESSION_COOKIE;
}

const httpClient = axios.create({
    timeout: FETCH_TIMEOUT,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    proxy: false,
    validateStatus: () => true
});

const newsSitemapCache = {
    fetchedAt: 0,
    entries: null,
    pending: null
};

const pendingTasks = new SingleFlight('cinemacity');
const directFetchBreaker = createCircuitBreaker({
    maxFailures: DIRECT_BREAKER_FAILURES,
    resetMs: DIRECT_BREAKER_RESET_MS
});

async function singleFlight(key, fn) {
    return pendingTasks.do(key, fn);
}

function loadHtml(html) {
    return cheerio.load(String(html || ''), { decodeEntities: false });
}

function normalizeSectionLabel(value) {
    return decodeHtmlEntities(value)
        .replace(/\s+/g, ' ')
        .replace(/:$/g, '')
        .trim()
        .toLowerCase();
}

function cleanSectionValue(value) {
    return decodeHtmlEntities(value)
        .replace(/\s+/g, ' ')
        .replace(/^[,;:|\-]+|[,;:|\-]+$/g, '')
        .trim();
}

function attrSelectorValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const pageMetadataCache = new TtlLruCache({
    missingValue: null,
    ttlMs: 60 * 60 * 1000,
    max: 1000
});

const searchCandidatesCache = new TtlLruCache({
    missingValue: null,
    ttlMs: SEARCH_CACHE_TTL_MS,
    max: 800
});

const resolvedSearchCache = new TtlLruCache({
    missingValue: null,
    ttlMs: RESOLVED_SEARCH_CACHE_TTL_MS,
    max: 800
});

const streamResultCache = new TtlLruCache({
    missingValue: null,
    ttlMs: STREAM_CACHE_TTL_MS,
    max: 600
});

const tmdbMetadataCache = new TtlLruCache({
    missingValue: null,
    ttlMs: TMDB_CACHE_TTL_MS,
    max: 1200
});

const tmdbImdbCache = new TtlLruCache({
    missingValue: null,
    ttlMs: TMDB_CACHE_TTL_MS,
    max: 1200
});

const kitsuMappingCache = new TtlLruCache({
    missingValue: null,
    ttlMs: KITSU_MAPPING_CACHE_TTL_MS,
    max: 1600
});

const qualityProbeCache = new TtlLruCache({
    missingValue: null,
    ttlMs: QUALITY_PROBE_CACHE_TTL_MS,
    max: 800
});

const fetchFailureCache = new TtlLruCache({
    missingValue: null,
    ttlMs: NEGATIVE_CACHE_TTL_MS,
    max: 2000
});

const listingPageCache = new TtlLruCache({
    missingValue: null,
    ttlMs: CINEMACITY_LISTING_PAGE_CACHE_TTL_MS,
    max: 220
});

const listingScanCache = new TtlLruCache({
    missingValue: null,
    ttlMs: CINEMACITY_LISTING_CACHE_TTL_MS,
    max: 24
});

const impitWarmupCache = new TtlLruCache({
    missingValue: null,
    ttlMs: IMPIT_WARMUP_TTL_MS,
    max: 50
});

function buildCinemaCityRequestHeaders(url, context = 'document', extraHeaders = {}, cookieFallback = '') {
    const fp = getStickyFingerprintForUrl(url);
    const suppliedCookie = extraHeaders.Cookie || extraHeaders.cookie || '';
    const cookieHeader = getCookieHeaderForUrl(url, suppliedCookie || cookieFallback || '');
    const headers = buildContextHeaders(url, context, {
        ...extraHeaders,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
    }, fp);

    return { fp, headers };
}

function isUsableCinemaCityHtml(html, minBytes = 500) {
    const body = String(html || '');
    if (body.length < minBytes) return false;
    return !isCloudflareChallenge(body, 200);
}

async function fetchHtmlWithRustAccel(url, extraHeaders = {}, options = {}) {
    if (!CINEMACITY_RUST_ACCEL || !cinemaCityRustAccel.enabled || !url) return null;
    if (options.enabled === false) return null;

    const context = options.context || 'document';
    const { headers } = buildCinemaCityRequestHeaders(url, context, extraHeaders, getCinemaCitySessionCookie());
    const startedAt = Date.now();

    try {
        const response = await cinemaCityRustAccel.fetch(url, {
            method: 'GET',
            headers,
            providerName: 'cinemacity',
            timeout: Math.min(Number(options.timeout || CINEMACITY_RUST_ACCEL_TIMEOUT_MS) || CINEMACITY_RUST_ACCEL_TIMEOUT_MS, CINEMACITY_RUST_ACCEL_TIMEOUT_MS),
            cacheTtlMs: Number(options.cacheTtlMs || CINEMACITY_RUST_ACCEL_CACHE_TTL_MS) || CINEMACITY_RUST_ACCEL_CACHE_TTL_MS,
            staleTtlMs: Number(options.staleTtlMs || CINEMACITY_RUST_ACCEL_STALE_TTL_MS) || CINEMACITY_RUST_ACCEL_STALE_TTL_MS,
            cache: options.cache !== false,
            maxRedirects: options.maxRedirects ?? 6
        });
        if (!response || response.rustBlocked) return null;

        const status = Number(response.status || 0);
        const html = responseText(response.data);
        updateCookiesFromResponse(url, response.headers);
        if (status >= 200 && status < 400 && isUsableCinemaCityHtml(html, options.minBytes || 500)) {
            logCinemaCityDebug('rust accel ok', { url, cache: response.rustCache, bytes: html.length, ms: Date.now() - startedAt });
            return html;
        }
        logCinemaCityDebug('rust accel unusable', { url, status, cache: response.rustCache, bytes: html.length, ms: Date.now() - startedAt });
        return null;
    } catch (error) {
        logCinemaCityDebug('rust accel fail-open', { url, error: error?.message || String(error), ms: Date.now() - startedAt });
        return null;
    }
}

async function firstUsableHtml(tasks = [], { minBytes = 500, totalMs = 0 } = {}) {
    const startedAt = Date.now();
    const pending = tasks
        .filter((task) => typeof task?.run === 'function')
        .map((task) => {
            const item = { name: task.name || 'unknown', promise: null };
            item.promise = Promise.resolve()
                .then(task.run)
                .then((html) => ({ html: isUsableCinemaCityHtml(html, minBytes) ? html : null }))
                .catch(() => ({ html: null }));
            return item;
        });

    if (!pending.length) return null;

    const deadlineAt = Number(totalMs || 0) > 0 ? startedAt + Math.max(50, totalMs) : 0;
    const remaining = new Set(pending);

    while (remaining.size > 0) {
        const waiters = [...remaining].map((item) => item.promise.then((result) => ({ item, result })));
        if (deadlineAt > 0) {
            const leftMs = deadlineAt - Date.now();
            if (leftMs <= 0) return null;
            waiters.push(new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), leftMs)));
        }

        const winner = await Promise.race(waiters);
        if (winner?.timeout) return null;
        remaining.delete(winner.item);

        if (winner?.result?.html) {
            logCinemaCityDebug('fast race winner', { via: winner.item.name, bytes: winner.result.html.length, ms: Date.now() - startedAt });
            return { html: winner.result.html, via: winner.item.name };
        }
    }
    return null;
}

async function fetchPublicHtmlFast(url, extraHeaders = {}, options = {}) {
    const minBytes = options.minBytes || 500;
    const totalMs = Math.max(650, Number(options.totalMs || options.timeout || 1600) || 1600);
    const rustTimeout = Math.min(CINEMACITY_RUST_ACCEL_TIMEOUT_MS, Math.max(350, Number(options.rustTimeout || options.timeout || CINEMACITY_RUST_ACCEL_TIMEOUT_MS) || CINEMACITY_RUST_ACCEL_TIMEOUT_MS));
    const axiosTimeout = Math.max(600, Math.min(Number(options.axiosTimeout || options.timeout || 1600) || 1600, Math.max(700, totalMs)));

    const tasks = [];
    if (CINEMACITY_RUST_ACCEL_RACE) {
        tasks.push({
            name: 'rust-accel',
            run: () => fetchHtmlWithRustAccel(url, extraHeaders, {
                context: options.context || 'document',
                timeout: rustTimeout,
                cacheTtlMs: options.cacheTtlMs,
                staleTtlMs: options.staleTtlMs,
                minBytes
            })
        });
    }
    tasks.push({
        name: 'axios-fast',
        run: () => fetchHtmlWithAxios(url, extraHeaders, axiosTimeout, options.context || 'document')
    });

    return firstUsableHtml(tasks, { minBytes, totalMs });
}


async function fetchHtmlWithImpit(
    url,
    extraHeaders = {},
    attempt = 0,
    requestTimeout = IMPIT_TIMEOUT,
    requestContext = 'document',
    options = {}
) {
    const { fp, headers: mergedHeaders } = buildCinemaCityRequestHeaders(url, requestContext, extraHeaders);
    const hardMode = options.hardMode === true || attempt > 0 || requestContext === 'ajax' || requestContext === 'json';

    try {
        const response = await requestWithImpitRotating({
            url,
            headers: mergedHeaders,
            fingerprint: fp,
            timeout: requestTimeout,
            totalTimeoutMs: Math.max(
                requestTimeout + 900,
                Number(options.totalTimeoutMs || IMPIT_TOTAL_BUDGET_MS)
            ),
            maxBrowserAttempts: hardMode ? IMPIT_ROTATING_HARD_ATTEMPTS : IMPIT_ROTATING_MAX_ATTEMPTS,
            followRedirect: true,
            maxRedirects: 6,
            responseType: 'text',
            ignoreTlsErrors: true,
            failSoft: true,
            innerRetry: { limit: 0 },
            retryOnStatuses: [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]
        });
        if (!response) return null;

        const status = Number(response?.statusCode || 0);
        const body = response?.body || '';
        updateCookiesFromResponse(url, response.headers);

        if (isCloudflareChallenge(body, status)) {
            markProviderBlockedFetch(url, `cloudflare:${response.impitBrowser || 'unknown'}`);
            directFetchBreaker.failure(url, new Error(`cloudflare_${status || 0}`));
            return null;
        }
        if ([403, 429, 503].includes(status)) {
            markProviderBlockedFetch(url, `http_${status}:${response.impitBrowser || 'unknown'}`);
            directFetchBreaker.failure(url, new Error(`http_${status}`));
            return null;
        }
        if (status >= 200 && status < 400) {
            directFetchBreaker.success(url);
            return body;
        }
        return null;
    } catch (error) {
        if (providerShield.shouldUseShield({ url, error })) {
            markProviderBlockedFetch(url, error?.code || error?.message || 'network');
            directFetchBreaker.failure(url, error);
        }
        return null;
    }
}

async function fetchHtmlWithAxios(url, extraHeaders = {}, requestTimeout = FETCH_TIMEOUT, requestContext = 'document') {
    const { headers: mergedHeaders } = buildCinemaCityRequestHeaders(url, requestContext, extraHeaders);

    try {
        const response = await httpClient.get(url, {
            headers: mergedHeaders,
            responseType: 'text',
            timeout: requestTimeout
        });
        const status = Number(response?.status || 0);
        const body = responseText(response?.data);
        updateCookiesFromResponse(url, response.headers);

        if (isCloudflareChallenge(body, status)) {
            markProviderBlockedFetch(url, 'cloudflare');
            return null;
        }
        if ([403, 429, 503].includes(status)) {
            markProviderBlockedFetch(url, `http_${status}`);
            return null;
        }
        if (status >= 200 && status < 400) return body;
        return null;
    } catch (error) {
        if (providerShield.shouldUseShield({ url, error })) markProviderBlockedFetch(url, error?.code || error?.message || 'network');
        return null;
    }
}

function buildCinemaCityKrakenForwardUrl(targetUrl, headers = {}) {
    if (!CINEMACITY_KRAKEN_FORWARD_ENABLED || !CINEMACITY_KRAKEN_FORWARD_URL || !targetUrl) return '';
    const base = String(CINEMACITY_KRAKEN_FORWARD_URL || '').trim();
    if (!base) return '';
    const encoded = encodeURIComponent(targetUrl);
    let forwardUrl;
    if (base.includes('{url}')) forwardUrl = base.replace('{url}', encoded);
    else if (/[?&][^=]+=$/.test(base)) forwardUrl = `${base}${encoded}`;
    else forwardUrl = `${base}${targetUrl}`;
    try {
        const u = new URL(forwardUrl);
        const ua = headers?.['User-Agent'] || headers?.['user-agent'];
        const referer = headers?.Referer || headers?.referer;
        const origin = headers?.Origin || headers?.origin;
        if (ua && !u.searchParams.has('h_user-agent')) u.searchParams.set('h_user-agent', ua);
        if (referer && !u.searchParams.has('h_referer')) u.searchParams.set('h_referer', referer);
        if (origin && !u.searchParams.has('h_origin')) u.searchParams.set('h_origin', origin);
        return u.toString();
    } catch (_) {
        return forwardUrl;
    }
}

async function fetchHtmlWithKrakenForward(url, extraHeaders = {}, requestTimeout = CINEMACITY_KRAKEN_FORWARD_TIMEOUT_MS, requestContext = 'document', method = 'GET', body = null) {
    if (!CINEMACITY_KRAKEN_FORWARD_ENABLED || !CINEMACITY_KRAKEN_FORWARD_URL) return null;
    // Kraken /forward only supports GET (POST returns 405). Skip POST entirely.
    if (String(method || 'GET').toUpperCase() !== 'GET') return null;
    const { headers: mergedHeaders } = buildCinemaCityRequestHeaders(url, requestContext, extraHeaders);
    const forwardUrl = buildCinemaCityKrakenForwardUrl(url, mergedHeaders);
    if (!forwardUrl) return null;

    const startedAt = Date.now();
    try {
        const config = {
            headers: mergedHeaders,
            responseType: 'text',
            timeout: requestTimeout
        };
        const response = await httpClient.get(forwardUrl, config);
        const status = Number(response?.status || 0);
        const respBody = responseText(response?.data);
        updateCookiesFromResponse(url, response.headers);

        if (isCloudflareChallenge(respBody, status)) {
            logCinemaCityDebug('kraken forward challenge', { url, status, ms: Date.now() - startedAt });
            return null;
        }
        if ([403, 429, 503].includes(status)) {
            logCinemaCityDebug('kraken forward blocked', { url, status, ms: Date.now() - startedAt });
            return null;
        }
        if (status >= 200 && status < 400) {
            logCinemaCityDebug('kraken forward ok', { url, status, bytes: respBody.length, ms: Date.now() - startedAt });
            return respBody;
        }
        logCinemaCityDebug('kraken forward unusable', { url, status, ms: Date.now() - startedAt });
        return null;
    } catch (error) {
        logCinemaCityDebug('kraken forward error', { url, error: error?.code || error?.message || String(error), ms: Date.now() - startedAt });
        return null;
    }
}

async function fetchHtmlPostWithAxios(url, formBody, extraHeaders = {}, requestTimeout = CINEMACITY_SEARCH_POST_TIMEOUT_MS) {
    const { headers: mergedHeaders } = buildCinemaCityRequestHeaders(url, 'ajax', {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/`,
        ...extraHeaders
    }, getCinemaCitySessionCookie());

    try {
        const response = await httpClient.post(url, formBody, {
            headers: mergedHeaders,
            responseType: 'text',
            timeout: requestTimeout
        });
        const status = Number(response?.status || 0);
        const body = responseText(response?.data);
        updateCookiesFromResponse(url, response.headers);

        if (isCloudflareChallenge(body, status)) {
            markProviderBlockedFetch(url, 'cloudflare-post-axios');
            return null;
        }
        if ([403, 429, 503].includes(status)) {
            markProviderBlockedFetch(url, `http_${status}_post_axios`);
            return null;
        }
        if (status >= 200 && status < 400) return body;
        return null;
    } catch (error) {
        if (providerShield.shouldUseShield({ url, error })) markProviderBlockedFetch(url, error?.code || error?.message || 'post-axios-network');
        return null;
    }
}

async function fetchHtmlPostWithImpit(url, formBody, extraHeaders = {}, options = {}) {
    const { fp, headers: baseHeaders } = buildCinemaCityRequestHeaders(url, 'ajax', {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/`,
        ...extraHeaders
    }, getCinemaCitySessionCookie());

    try {
        const response = await requestWithImpitRotating({
            url,
            method: 'POST',
            body: formBody,
            headers: baseHeaders,
            fingerprint: fp,
            timeout: Math.max(1000, Number(options.timeout || CINEMACITY_SEARCH_POST_TIMEOUT_MS || IMPIT_TIMEOUT) || IMPIT_TIMEOUT),
            totalTimeoutMs: Math.max(1800, Number(options.totalTimeoutMs || CINEMACITY_SEARCH_POST_TOTAL_MS || IMPIT_TOTAL_BUDGET_MS) || IMPIT_TOTAL_BUDGET_MS),
            maxBrowserAttempts: IMPIT_ROTATING_MAX_ATTEMPTS,
            followRedirect: true,
            maxRedirects: 6,
            responseType: 'text',
            ignoreTlsErrors: true,
            failSoft: true,
            innerRetry: { limit: 0 },
            retryOnStatuses: [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]
        });
        if (!response) return null;

        const status = Number(response?.statusCode || 0);
        const body = response?.body || '';
        updateCookiesFromResponse(url, response.headers);

        if (isCloudflareChallenge(body, status)) {
            markProviderBlockedFetch(url, `cloudflare-post:${response.impitBrowser || 'unknown'}`);
            directFetchBreaker.failure(url, new Error(`cloudflare_post_${status || 0}`));
            const shielded = await providerShield.fetchHtml(url, { method: 'POST', body: formBody, timeout: Math.min(CINEMACITY_SEARCH_POST_TIMEOUT_MS, IMPIT_TIMEOUT), ttl: SEARCH_CACHE_TTL_MS });
            return shielded || null;
        }
        if ([403, 429, 503].includes(status)) {
            markProviderBlockedFetch(url, `http_${status}_post:${response.impitBrowser || 'unknown'}`);
            directFetchBreaker.failure(url, new Error(`http_${status}_post`));
            const shielded = await providerShield.fetchHtml(url, { method: 'POST', body: formBody, timeout: Math.min(CINEMACITY_SEARCH_POST_TIMEOUT_MS, IMPIT_TIMEOUT), ttl: SEARCH_CACHE_TTL_MS });
            return shielded || null;
        }
        if (status >= 200 && status < 400) {
            directFetchBreaker.success(url);
            return body;
        }
        return null;
    } catch (error) {
        if (providerShield.shouldUseShield({ url, error })) {
            markProviderBlockedFetch(url, error?.code || error?.message || 'post-network');
            directFetchBreaker.failure(url, error);
            const shielded = await providerShield.fetchHtml(url, { method: 'POST', body: formBody, timeout: Math.min(CINEMACITY_SEARCH_POST_TIMEOUT_MS, IMPIT_TIMEOUT), ttl: SEARCH_CACHE_TTL_MS });
            return shielded || null;
        }
        return null;
    }
}


async function fetchHtml(url, extraHeaders = {}, options = {}) {
    const context = options.context || 'document';
    const cacheKey = `url:${context}:${url}`;
    if (fetchFailureCache.get(cacheKey)) return null;

    return singleFlight(`fetch:${cacheKey}`, async () => {
        if (fetchFailureCache.get(cacheKey)) return null;

        const timeout = options.timeout || FETCH_TIMEOUT;
        const directAllowed = directFetchBreaker.canRequest(url);
        const rotatingEnabled = options.rotating !== false;
        const attempts = rotatingEnabled
            ? Math.max(1, Math.min(2, Number.parseInt(String(options.attempts || 1), 10) || 1))
            : Math.max(1, Math.min(IMPIT_ATTEMPTS, Number.parseInt(String(options.attempts || IMPIT_ATTEMPTS), 10) || IMPIT_ATTEMPTS));

        // Kraken forward proxy first-line: masks the leviathan IP from CinemaCity/Cloudflare
        // and reuses Kraken's clean egress. Falls through to impit/axios/shield on miss.
        if (
            CINEMACITY_KRAKEN_FORWARD_ENABLED
            && CINEMACITY_KRAKEN_FORWARD_FIRST
            && options.krakenForward !== false
        ) {
            const krakenTimeout = Math.min(
                CINEMACITY_KRAKEN_FORWARD_TIMEOUT_MS,
                Math.max(2000, Number(options.krakenForwardTimeout || timeout) || timeout)
            );
            const krakenBody = await fetchHtmlWithKrakenForward(url, extraHeaders, krakenTimeout, context);
            if (krakenBody) {
                directFetchBreaker.success(url);
                return krakenBody;
            }
        }

        if (directAllowed) {
            for (let attempt = 0; attempt < attempts; attempt++) {
                if (attempt > 0) {
                    const baseDelay = Math.min(1200, 180 * Math.pow(2, attempt));
                    const jitter = Math.floor(Math.random() * 140);
                    await sleep(baseDelay + jitter);
                }

                const impitBody = await fetchHtmlWithImpit(url, extraHeaders, attempt, timeout, context, {
                    hardMode: options.hardMode === true || attempt > 0,
                    totalTimeoutMs: options.totalTimeoutMs || IMPIT_TOTAL_BUDGET_MS
                });
                if (impitBody) return impitBody;
            }

            const blockedNow = wasProviderBlockedFetch(url);
            const allowAxiosAfterBlocked = options.axiosOnBlocked === true || CINEMACITY_AXIOS_ON_BLOCKED === true;
            if ((!blockedNow || allowAxiosAfterBlocked) && options.axiosFallback !== false) {
                const axiosBody = await fetchHtmlWithAxios(url, extraHeaders, timeout, context);
                if (axiosBody) {
                    directFetchBreaker.success(url);
                    return axiosBody;
                }
            }
        }

        if (options.allowClearanceFallback !== false && (wasProviderBlockedFetch(url) || !directAllowed)) {
            const shieldBody = await providerShield.fetchHtml(url, {
                ttl: options.ttl || SEARCH_CACHE_TTL_MS,
                timeout: Math.min(timeout, 6000)
            });
            if (shieldBody) {
                directFetchBreaker.success(url);
                return shieldBody;
            }
        }

        fetchFailureCache.set(cacheKey, true);
        return null;
    });
}


const cinemaCityBackgroundClearanceState = {
    started: false,
    timer: null,
    running: null,
    lastOkAt: 0,
    lastRunAt: 0,
    lastError: null
};

function scheduleCinemaCityBackgroundClearance(delayMs, reason = 'scheduled') {
    if (!CINEMACITY_BACKGROUND_CLEARANCE) return;
    const safeDelay = Math.max(0, Number(delayMs) || 0);
    if (cinemaCityBackgroundClearanceState.timer) {
        clearTimeout(cinemaCityBackgroundClearanceState.timer);
        cinemaCityBackgroundClearanceState.timer = null;
    }
    cinemaCityBackgroundClearanceState.timer = setTimeout(() => {
        cinemaCityBackgroundClearanceState.timer = null;
        runCinemaCityBackgroundClearance(reason).catch(() => {});
    }, safeDelay);
    if (typeof cinemaCityBackgroundClearanceState.timer.unref === 'function') {
        cinemaCityBackgroundClearanceState.timer.unref();
    }
}

async function runCinemaCityBackgroundClearance(reason = 'startup') {
    if (!CINEMACITY_BACKGROUND_CLEARANCE || !providerShield?.guard?.ensureClearance) return false;
    if (cinemaCityBackgroundClearanceState.running) return cinemaCityBackgroundClearanceState.running;

    cinemaCityBackgroundClearanceState.running = (async () => {
        const startedAt = Date.now();
        let runSucceeded = false;
        const triggerUrl = `${BASE_URL}/index.php`;
        const warmupBody = new URLSearchParams({
            do: 'search',
            subaction: 'search',
            story: CINEMACITY_BACKGROUND_PRIME_QUERY
        }).toString();

        try {
            const alreadyFresh = typeof providerShield.guard.isSessionFresh === 'function'
                ? providerShield.guard.isSessionFresh(triggerUrl)
                : false;

            logCinemaCityInfo('background clearance start', {
                reason,
                triggerUrl,
                force: CINEMACITY_BACKGROUND_CLEARANCE_FORCE,
                sessionFresh: alreadyFresh,
                primeHome: CINEMACITY_BACKGROUND_PRIME_HOME,
                primeSearch: CINEMACITY_BACKGROUND_PRIME_SEARCH
            });

            let clearanceOk = false;
            if (!alreadyFresh || CINEMACITY_BACKGROUND_CLEARANCE_FORCE) {
                const clearanceResult = await providerShield.guard.ensureClearance(triggerUrl, {
                    force: !alreadyFresh || CINEMACITY_BACKGROUND_CLEARANCE_FORCE,
                    isPost: true,
                    body: warmupBody,
                    ignoreProviderCooldown: true
                });
                clearanceOk = Boolean(clearanceResult);
            } else {
                clearanceOk = true;
            }

            let homeReady = false;
            if (CINEMACITY_BACKGROUND_PRIME_HOME) {
                const homeHtml = await providerShield.fetchHtml(BASE_URL, {
                    timeout: Math.min(4200, Math.max(2600, CINEMACITY_SEARCH_POST_TIMEOUT_MS)),
                    ttl: SEARCH_CACHE_TTL_MS,
                    allowFlareSolverr: false
                }).catch(() => null);
                homeReady = Boolean(homeHtml && homeHtml.length > 500);
            }

            let searchReady = false;
            if (CINEMACITY_BACKGROUND_PRIME_SEARCH) {
                const searchHtml = await providerShield.fetchHtml(triggerUrl, {
                    method: 'POST',
                    body: warmupBody,
                    timeout: CINEMACITY_SEARCH_POST_TIMEOUT_MS,
                    ttl: SEARCH_CACHE_TTL_MS,
                    allowFlareSolverr: false
                }).catch(() => null);
                searchReady = Boolean(searchHtml && searchHtml.length > 500);
            }

            const freshAfter = typeof providerShield.guard.isSessionFresh === 'function'
                ? providerShield.guard.isSessionFresh(triggerUrl)
                : false;

            // In alcuni casi CinemaCity restituisce cookie validi e la ricerca POST funziona,
            // ma il guard non marca la sessione come "fresh" per l'URL trigger.
            // Se il prime configurato Ã¨ riuscito, il daemon deve passare al refresh periodico
            // invece di continuare con retry aggressivi ogni pochi secondi.
            const backgroundOk = Boolean(
                freshAfter
                || clearanceOk
                || (CINEMACITY_BACKGROUND_PRIME_HOME && homeReady)
                || (CINEMACITY_BACKGROUND_PRIME_SEARCH && searchReady)
            );

            runSucceeded = backgroundOk;
            cinemaCityBackgroundClearanceState.lastOkAt = backgroundOk ? Date.now() : cinemaCityBackgroundClearanceState.lastOkAt;
            cinemaCityBackgroundClearanceState.lastRunAt = Date.now();
            cinemaCityBackgroundClearanceState.lastError = backgroundOk ? null : 'background_clearance_not_ready';

            logCinemaCityInfo('background clearance done', {
                reason,
                ok: backgroundOk,
                clearanceOk,
                sessionReady: freshAfter,
                homeReady,
                searchReady,
                ageMs: cinemaCityBackgroundClearanceState.lastOkAt ? Date.now() - cinemaCityBackgroundClearanceState.lastOkAt : null,
                ms: Date.now() - startedAt
            });

            return backgroundOk;
        } catch (error) {
            cinemaCityBackgroundClearanceState.lastRunAt = Date.now();
            cinemaCityBackgroundClearanceState.lastError = error?.message || String(error);
            logCinemaCityInfo('background clearance failed', {
                reason,
                error: cinemaCityBackgroundClearanceState.lastError,
                ms: Date.now() - startedAt
            });
            return false;
        } finally {
            cinemaCityBackgroundClearanceState.running = null;
            const nextDelay = runSucceeded ? CINEMACITY_BACKGROUND_CLEARANCE_REFRESH_MS : CINEMACITY_BACKGROUND_CLEARANCE_RETRY_MS;
            const nextReason = runSucceeded ? 'refresh' : 'retry';
            if (nextDelay > 0) {
                scheduleCinemaCityBackgroundClearance(nextDelay, nextReason);
            }
        }
    })();

    return cinemaCityBackgroundClearanceState.running;
}

function startCinemaCityBackgroundClearanceDaemon() {
    if (!CINEMACITY_BACKGROUND_CLEARANCE || cinemaCityBackgroundClearanceState.started) return;
    cinemaCityBackgroundClearanceState.started = true;
    logCinemaCityInfo('background clearance daemon active', {
        delayMs: CINEMACITY_BACKGROUND_CLEARANCE_DELAY_MS,
        refreshMs: CINEMACITY_BACKGROUND_CLEARANCE_REFRESH_MS,
        retryMs: CINEMACITY_BACKGROUND_CLEARANCE_RETRY_MS,
        force: CINEMACITY_BACKGROUND_CLEARANCE_FORCE,
        primeHome: CINEMACITY_BACKGROUND_PRIME_HOME,
        primeSearch: CINEMACITY_BACKGROUND_PRIME_SEARCH
    });
    scheduleCinemaCityBackgroundClearance(CINEMACITY_BACKGROUND_CLEARANCE_DELAY_MS, 'startup');
}

async function warmupCinemaCitySession(reason = 'search') {
    const cacheKey = `warmup:${BASE_URL}`;
    if (impitWarmupCache.get(cacheKey)) return true;

    try {
        const html = await fetchHtml(BASE_URL, {
            'Referer': `${BASE_URL}/`,
            'Cookie': getCinemaCitySessionCookie(),
            'Sec-Fetch-Site': 'same-origin'
        }, {
            timeout: 1800,
            attempts: 1,
            context: 'document',
            axiosFallback: false,
            allowClearanceFallback: false,
            hardMode: false,
            totalTimeoutMs: 2600
        });

        const ok = Boolean(html && html.length > 500);
        if (ok) impitWarmupCache.set(cacheKey, true);
        return ok;
    } catch (error) {
        return false;
    }
}

async function fetchJson(url, options = {}) {
    const { headers } = buildCinemaCityRequestHeaders(url, 'json', options.headers || {});
    const response = await httpClient.get(url, {
        ...options,
        headers
    });
    const status = Number(response?.status || 0);
    if (status >= 200 && status < 400) return response.data;
    throw new Error(`HTTP ${status || 500}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value) {
    return he.decode(String(value || ''))
        .replace(/\u2013|\u2014/g, '-')
        .replace(/&ndash;|&mdash;/gi, '-');
}

function uniqueStrings(values = []) {
    return [...new Set((values || []).map((v) => decodeHtmlEntities(String(v || '')).trim()).filter(Boolean))];
}

function normalizeTitle(value) {
    return decodeHtmlEntities(String(value || ''))
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function extractImdbId(value) {
    const match = String(value || '').trim().match(/\btt\d{5,}\b/i);
    return match ? match[0].toLowerCase() : null;
}

function extractTmdbId(value) {
    const raw = String(value || '').trim();
    const tagged = raw.match(/^tmdb:(\d+)/i);
    if (tagged) return tagged[1];
    return /^\d+$/.test(raw) ? raw : null;
}

function extractKitsuId(value) {
    const raw = String(value || '').trim();
    if (/^\d+$/.test(raw)) return raw;
    const match = raw.match(/^kitsu:(\d+)/i);
    return match ? match[1] : null;
}

function getMappingLanguage(config = {}) {
    const lang = String(config?.filters?.language || '').trim().toLowerCase();
    return lang === 'ita' ? 'it' : null;
}

function extractSitemapLocs(xml) {
    return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/gi)]
        .map((m) => String(m[1] || '').trim())
        .filter(Boolean);
}

function getCinemaCitySectionType(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname.startsWith('/movies/')) return 'movie';
        if (pathname.startsWith('/anime/')) return 'anime';
        if (pathname.startsWith('/tv-series/') || pathname.startsWith('/series/')) return 'tv';
        return null;
    } catch (_) {
        return null;
    }
}

function isCinemaCityContentUrlForType(url, providerType) {
    const sectionType = getCinemaCitySectionType(url);
    if (providerType === 'movie') return sectionType === 'movie';
    if (providerType === 'anime') return sectionType === 'anime' || sectionType === 'tv';
    return sectionType === 'tv' || sectionType === 'anime';
}

function getCinemaCityTypeBoost(url, providerType) {
    const sectionType = getCinemaCitySectionType(url);
    if (providerType === 'movie') return sectionType === 'movie' ? 18 : -40;
    if (providerType === 'anime') {
        if (sectionType === 'anime') return 24;
        if (sectionType === 'tv') return 10;
        return -40;
    }
    if (sectionType === 'tv') return 16;
    if (sectionType === 'anime') return 4;
    return -40;
}

function titleFromContentUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const slug = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
        return decodeHtmlEntities(
            slug
                .replace(/\.html?$/i, '')
                .replace(/^\d+-/, '')
                .replace(/-/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        );
    } catch (_) {
        return '';
    }
}

function extractYear(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function extractSectionValues(html, sectionLabel) {
    const $ = loadHtml(html);
    const wanted = normalizeSectionLabel(sectionLabel);
    const values = [];

    $('li').each((_, li) => {
        const spans = $(li).children('span');
        if (spans.length < 2) return;
        const label = normalizeSectionLabel($(spans[0]).text());
        if (label !== wanted) return;

        const valueNode = $(spans[1]);
        const linked = [];
        valueNode.find('a').each((__, a) => {
            const value = cleanSectionValue($(a).text());
            if (value) linked.push(value);
        });

        const rawText = cleanSectionValue(valueNode.text());
        const sourceValues = linked.length > 0 ? linked : rawText.split(/[,;|]/g);
        for (const value of sourceValues) {
            const cleaned = cleanSectionValue(value);
            if (cleaned) values.push(cleaned);
        }
    });

    return uniqueStrings(values);
}

function extractMetaContent(html, property) {
    const $ = loadHtml(html);
    const key = attrSelectorValue(property);
    const value = $(`meta[property="${key}"]`).first().attr('content')
        || $(`meta[name="${key}"]`).first().attr('content')
        || '';
    return decodeHtmlEntities(value).trim();
}

function extractHeadingTitle(html) {
    const $ = loadHtml(html);
    const value = $('h1').first().text();
    return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
}

function pickHighestResolution(resolutions = []) {
    let best = 'Unknown';
    for (const r of resolutions) {
        best = pickBetterQuality(best, normalizeQuality(r));
    }
    return normalizeQuality(best);
}

function extractDownloadLanguagesFromPage(html) {
    const $ = loadHtml(html);
    const languages = [];

    $('.dar-tr_item').each((_, item) => {
        const title = decodeHtmlEntities($(item).find('.dar-tr_title').text() || '');
        const langLine = decodeHtmlEntities($(item).find('li').filter((__, li) => {
            return /language/i.test($(li).find('span').first().text() || '');
        }).text() || '');

        const combined = `${title} ${langLine}`;
        if (/\bItalian\b|\.Italian\.|\bITA\b/i.test(combined)) languages.push('italian');
        if (/\bEnglish\b|\.English\.|\bENG\b/i.test(combined)) languages.push('english');
        if (/\bMulti\b|Dual[-\s]?Audio|Multiaudio/i.test(combined)) languages.push('multi');
    });

    return normalizeLanguageList(languages);
}

function parseCinemaCityPageMetadata(html, pageUrl = '') {
    const body = String(html || '');
    const $ = loadHtml(body);
    const pageTitle = extractHeadingTitle(body)
        || extractMetaContent(body, 'og:title')
        || extractMetaContent(body, 'twitter:title')
        || titleFromContentUrl(pageUrl);
    const genres = extractSectionValues(body, 'Genre');
    const audioLanguages = extractSectionValues(body, 'Audio language');
    const downloadLanguages = extractDownloadLanguagesFromPage(body);
    const subtitleLanguages = extractSectionValues(body, 'Subtitle language');
    const listedResolutions = extractSectionValues(body, 'Resolution')
        .map((v) => normalizeQuality(v))
        .filter((v) => v !== 'Unknown');
    const uploadedQuality = body.match(/Uploaded\s+([^<\n]+)/i)?.[1] || '';
    const listedQualities = uniqueStrings([
        ...extractSectionValues(body, 'Quality'),
        uploadedQuality
    ]);

    let tmdbId = null;
    $('a[href*="themoviedb.org"], link[href*="themoviedb.org"]').each((_, node) => {
        if (tmdbId) return;
        const href = String($(node).attr('href') || '');
        const match = href.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
        if (match?.[1]) tmdbId = extractTmdbId(match[1]);
    });
    if (!tmdbId) {
        const tmdbMatch = body.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
        tmdbId = tmdbMatch?.[1] ? extractTmdbId(tmdbMatch[1]) : null;
    }

    const imdbId = extractImdbId(body);
    const quality = pickHighestResolution(listedResolutions);
    const qualityTag = listedQualities.find((v) => /web[- ]?dl|webrip|bluray|hdrip/i.test(String(v)));
    const isMultiAudio = audioLanguages.length > 1
        || downloadLanguages.includes('multi')
        || /multi|dual[-\s]?audio|multiaudio/i.test(listedQualities.join(' '));
    const isAnime = genres.some((v) => /\banime\b|\banimation\b/i.test(String(v)))
        || getCinemaCitySectionType(pageUrl) === 'anime';

    return {
        title: pageTitle,
        year: extractYear(pageTitle) || extractYear(body),
        imdbId,
        tmdbId,
        genres,
        audioLanguages,
        downloadLanguages,
        subtitleLanguages,
        listedResolutions,
        quality,
        qualityTag: qualityTag || '',
        isMultiAudio,
        isAnime
    };
}

async function fetchCinemaCityPageMetadata(pageUrl) {
    const normalizedUrl = normalizeRemoteUrl(pageUrl);
    if (!normalizedUrl) return null;

    const cached = pageMetadataCache.get(normalizedUrl);
    if (cached) return cached;

    return singleFlight(`metadata:${normalizedUrl}`, async () => {
        const existing = pageMetadataCache.get(normalizedUrl);
        if (existing) return existing;

        try {
            const html = await fetchHtml(normalizedUrl, {
                'Referer': `${BASE_URL}/`,
                'Cookie': getCinemaCitySessionCookie(),
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1'
            });
            const metadata = parseCinemaCityPageMetadata(html, normalizedUrl);
            pageMetadataCache.set(normalizedUrl, metadata);
            return metadata;
        } catch (_) {
            return null;
        }
    });
}

const LANGUAGE_ALIASES = {
    italian: ['italian', 'ita', 'it', 'italiano'],
    english: ['english', 'eng', 'en', 'inglese'],
    japanese: ['japanese', 'jpn', 'ja', 'giapponese'],
    multi: ['multi', 'multiaudio', 'multi audio', 'dual audio', 'dual-audio']
};

function normalizeLanguageToken(value) {
    const raw = decodeHtmlEntities(String(value || ''))
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!raw) return '';

    const tokens = raw.split(' ').filter(Boolean);
    const compact = raw.replace(/\s+/g, '');

    for (const [canonical, aliases] of Object.entries(LANGUAGE_ALIASES)) {
        if (aliases.some((alias) => {
            const cleanAlias = String(alias || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (!cleanAlias) return false;
            const aliasCompact = cleanAlias.replace(/\s+/g, '');
            if (raw === cleanAlias || compact === aliasCompact) return true;
            if (cleanAlias.length <= 3) return tokens.includes(cleanAlias);
            return tokens.includes(cleanAlias) || compact.includes(aliasCompact);
        })) {
            return canonical;
        }
    }

    return raw;
}

function normalizeLanguageList(values = []) {
    return uniqueStrings(
        (Array.isArray(values) ? values : [values])
            .flatMap((value) => String(value || '').split(/[,;/|]+/g))
            .map(normalizeLanguageToken)
            .filter(Boolean)
    );
}

function getWantedLanguage(config = {}) {
    const raw = String(
        config?.filters?.language
        || config?.language
        || config?.preferredLanguage
        || ''
    ).trim().toLowerCase();

    if (['ita', 'it', 'italian', 'italiano'].includes(raw)) return 'italian';
    if (['eng', 'en', 'english', 'inglese'].includes(raw)) return 'english';
    if (['jpn', 'ja', 'japanese', 'giapponese'].includes(raw)) return 'japanese';

    return raw || null;
}

function isStrictSingleLanguageMode(config = {}) {
    const wanted = getWantedLanguage(config);
    if (!wanted) return false;

    const raw = String(config?.filters?.language || config?.language || '').trim().toLowerCase();

    return (
        raw === 'ita'
        || raw === 'it'
        || raw === 'italian'
        || raw === 'italiano'
        || config?.filters?.strictLanguage === true
        || config?.strictLanguage === true
    );
}

function pageHasRequestedAudio(pageMetadata = {}, config = {}) {
    const wanted = getWantedLanguage(config);
    if (!wanted) return true;

    const strict = isStrictSingleLanguageMode(config);
    if (!strict) return true;

    const pageAudio = normalizeLanguageList(pageMetadata.audioLanguages || []);
    const downloadAudio = normalizeLanguageList(pageMetadata.downloadLanguages || []);
    const qualityTag = normalizeLanguageToken(pageMetadata.qualityTag || '');
    const pageHasWanted = pageAudio.includes(wanted);
    const pageHasMulti = pageAudio.includes('multi')
        || qualityTag === 'multi'
        || pageMetadata.isMultiAudio === true
        || /\bmulti\b|dual[-\s]?audio|multiaudio/i.test(String(pageMetadata.qualityTag || ''));
    const downloadHasWanted = downloadAudio.includes(wanted);
    const downloadHasMulti = downloadAudio.includes('multi');
    const pageOnlyEnglish = pageAudio.length === 1 && pageAudio[0] === 'english';
    const downloadOnlyEnglish = downloadAudio.length > 0 && downloadAudio.every((lang) => lang === 'english');

    if (wanted === 'italian') {
        if (pageHasWanted) return true;
        if (pageHasMulti && config?.filters?.allowMultiWhenItalianOnly === true) return true;

        if (pageAudio.length > 0) return false;

        if (downloadHasWanted) return true;
        if (downloadHasMulti && config?.filters?.allowMultiWhenItalianOnly === true) return true;
        if (downloadOnlyEnglish) return false;

        return false;
    }

    if (pageHasWanted || downloadHasWanted) return true;
    if (pageHasMulti || downloadHasMulti) return true;
    if (pageOnlyEnglish && wanted !== 'english') return false;

    return pageAudio.length === 0 && downloadAudio.length === 0;
}

function buildLanguageRejectReason(pageMetadata = {}, config = {}) {
    const wanted = getWantedLanguage(config) || 'unknown';
    const foundPage = normalizeLanguageList(pageMetadata.audioLanguages || []);
    const foundDownload = normalizeLanguageList(pageMetadata.downloadLanguages || []);
    return `[CinemaCity] Skip lingua: richiesta=${wanted}, pagina=${foundPage.join(',') || 'unknown'}, download=${foundDownload.join(',') || 'unknown'}, titolo=${pageMetadata.title || 'unknown'}`;
}

function streamUrlHasForbiddenLanguage(streamUrl = '', config = {}) {
    const wanted = getWantedLanguage(config);
    if (!wanted || !isStrictSingleLanguageMode(config)) return false;

    const text = decodeURIComponent(String(streamUrl || '')).replace(/[._-]+/g, ' ');
    const hasItalian = /(?:^|[^a-z0-9])(ita|it|italian|italiano)(?:[^a-z0-9]|$)/i.test(text);
    const hasEnglish = /(?:^|[^a-z0-9])(eng|en|english|inglese)(?:[^a-z0-9]|$)/i.test(text);
    const hasMulti = /(?:^|[^a-z0-9])(multi|multiaudio|dual audio|dual)(?:[^a-z0-9]|$)/i.test(text);

    if (wanted === 'italian') {
        return hasEnglish && !hasItalian && !hasMulti;
    }

    const normalized = normalizeLanguageToken(text);
    return hasEnglish && !normalized.includes(wanted);
}

function buildCinemaCityLanguageLabel(pageMetadata = {}, config = {}) {
    const languages = normalizeLanguageList(pageMetadata?.audioLanguages || []);
    const downloadLanguages = normalizeLanguageList(pageMetadata?.downloadLanguages || []);
    const wantsItalian = getWantedLanguage(config) === 'italian';

    const hasItalian = languages.includes('italian') || downloadLanguages.includes('italian');
    const hasEnglish = languages.includes('english') || downloadLanguages.includes('english');
    const hasMulti = languages.includes('multi') || downloadLanguages.includes('multi') || pageMetadata?.isMultiAudio === true;

    if (hasItalian && hasMulti) return 'ðŸ‡®ðŸ‡¹ ITA+MULTI';
    if (hasItalian) return 'ðŸ‡®ðŸ‡¹ ITA';

    if (wantsItalian && hasMulti && config?.filters?.allowMultiWhenItalianOnly === true) {
        return 'ðŸŒ  MULTI';
    }

    if (hasEnglish && languages.length <= 1 && downloadLanguages.length <= 1) return 'ðŸ‡¬ðŸ‡§ ENG';
    if (hasMulti || languages.length > 1 || downloadLanguages.length > 1) return 'ðŸŒ  MULTI';

    return 'ðŸŒ  WEB';
}

function isDeferredCinemaCityExtractorStream(stream = {}) {
    const url = String(stream?.url || '');
    const extractor = String(stream?.extractor || stream?.host || stream?.behaviorHints?.extractor || stream?.behaviorHints?.vortexExtractor || '').toLowerCase();
    const provider = String(stream?.provider || stream?.source || stream?.site || stream?.behaviorHints?.vortexSource || stream?.behaviorHints?.vortexMeta?.provider || '').toLowerCase();

    return provider.includes('cinemacity') && (
        extractor === 'city'
        || extractor.includes('city fallback')
        || stream?.behaviorHints?.lazyExtraction === true
        || /[?&]host=city(?:&|$)/i.test(url)
        || /\/extractor\/video(?:\.m3u8)?\?/i.test(url)
    );
}

function hardFilterStreamsByLanguage(streams = [], config = {}) {
    const wanted = getWantedLanguage(config);
    if (!wanted || !isStrictSingleLanguageMode(config)) return streams;

    return streams.filter((stream) => {
        const meta = stream?.behaviorHints?.vortexMeta || {};
        const languageText = [
            ...(Array.isArray(meta.audioLanguages) ? meta.audioLanguages : []),
            ...(Array.isArray(meta.downloadLanguages) ? meta.downloadLanguages : []),
            ...(Array.isArray(meta.subtitleLanguages) ? meta.subtitleLanguages : []),
            meta.audio,
            meta.language,
            meta.qualityTag
        ].filter(Boolean).join(' ');
        const text = [
            stream.name,
            stream.title,
            stream.description,
            stream.behaviorHints?.filename,
            stream.filename,
            languageText,
            stream.url
        ].filter(Boolean).join(' ');

        if (wanted === 'italian') {
            if (/(?:^|[^a-z0-9])(ita|it|italian|italiano)(?:[^a-z0-9]|$)/i.test(text)) return true;
            if (/(?:^|[^a-z0-9])(multi|multiaudio|dual[-\s]?audio)(?:[^a-z0-9]|$)/i.test(text)
                && config?.filters?.allowMultiWhenItalianOnly === true) return true;
            if (/(?:^|[^a-z0-9])(eng|en|english|inglese)(?:[^a-z0-9]|$)/i.test(text)) return false;

            // CITY is a deferred page extractor: at provider-time we often only know the
            // CinemaCity page URL, while Kraken/MediaFlow resolves the final media later.
            // Do not kill a valid CinemaCity result just because the page-extractor stream
            // has no explicit language token yet. This was the cause of raw=0/formatted=0
            // after the locator had already found the correct movie page.
            if (isDeferredCinemaCityExtractorStream(stream)) return true;
            return false;
        }

        const normalized = normalizeLanguageToken(text);
        if (normalized.includes(wanted)) return true;
        return isDeferredCinemaCityExtractorStream(stream) && !/(?:^|[^a-z0-9])(eng|en|english|inglese)(?:[^a-z0-9]|$)/i.test(text);
    });
}

function collectMetaTitles(meta = {}) {
    return uniqueStrings([
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.originalName,
        meta?.canonicalTitle,
        meta?.seriesTitle,
        ...(Array.isArray(meta?.titles) ? meta.titles : []),
        ...(Array.isArray(meta?.aliases) ? meta.aliases : []),
        ...(Array.isArray(meta?.aka_titles) ? meta.aka_titles : [])
    ]);
}

function looksLikeAnimeMeta(meta = {}) {
    const directType = String(meta?.type || meta?.kind || meta?.mediaType || '').toLowerCase();
    if (/(^|[^a-z])(anime|animation)([^a-z]|$)/i.test(directType)) return true;
    const genres = Array.isArray(meta?.genres) ? meta.genres : [];
    if (genres.some((v) => /(anime|animation|animazione)/i.test(String(v)))) return true;
    const haystack = uniqueStrings([
        meta?.id, meta?.requestedId, meta?.originalId,
        meta?.kitsu_id, meta?.kitsuId,
        ...collectMetaTitles(meta)
    ]).join(' | ').toLowerCase();
    return /(anime-kitsu|kitsu:|\banime\b|\banimazione\b)/i.test(haystack);
}

function normalizeEpisodeNumber(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getExpectedYear(metadata = {}, meta = {}) {
    return extractYear(metadata?.release_date)
        || extractYear(metadata?.first_air_date)
        || extractYear(meta?.year)
        || extractYear(meta?.releaseInfo)
        || null;
}

function collectExpectedTitles(metadata = {}, meta = {}) {
    return Array.from(new Set([
        meta?.title, meta?.name, meta?.originalTitle, meta?.original_title,
        meta?.originalName, meta?.original_name,
        metadata?.title, metadata?.name, metadata?.original_title, metadata?.original_name
    ]
        .map((v) => decodeHtmlEntities(String(v || '')).trim())
        .filter(Boolean)));
}

function stripEpisodeDecorations(value) {
    return decodeHtmlEntities(value)
        .replace(/\b(?:season|stagione|episode|episodio|episodi|ep\.?)\s*\d+\b/gi, ' ')
        .replace(/\bS\s*\d+\s*E\s*\d+\b/gi, ' ')
        .replace(/\bS\s*\d+\b/gi, ' ')
        .replace(/\bE\s*\d+\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleAliasesFromOneTitle(title) {
    const cleaned = stripEpisodeDecorations(title);
    if (!cleaned) return [];

    const aliases = [cleaned];
    const slashParts = cleaned.split(/\s+[\\/|]\s+/g).map((v) => v.trim()).filter(Boolean);
    if (slashParts.length > 1) aliases.push(...slashParts);

    const akaParts = cleaned.split(/\s+(?:aka|a\.k\.a\.|also known as|conosciuto come)\s+/ig).map((v) => v.trim()).filter(Boolean);
    if (akaParts.length > 1) aliases.push(...akaParts);

    for (const part of [...aliases]) {
        const colon = part.split(/\s*[:ï¼š]\s+/g).map((v) => v.trim()).filter(Boolean);
        if (colon.length > 1) {
            aliases.push(colon[0]);
            aliases.push(colon.slice(1).join(' '));
        }
    }

    const ascii = cleaned.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (ascii !== cleaned) aliases.push(ascii);

    if (/\bone\s*piece\b/i.test(cleaned) || /\bwan\s*p[Ã®i]?su\b/i.test(cleaned) || /\bwan\s*pi+su\b/i.test(ascii)) {
        aliases.push('One Piece');
        aliases.push('Wan Pisu');
        aliases.push('Wan piisu');
    }

    return uniqueStrings(aliases).filter((v) => v.length >= 2);
}

function buildSearchQueryVariants(titles = []) {
    const seen = new Set();
    const out = [];
    for (const title of uniqueStrings(titles)) {
        const aliases = titleAliasesFromOneTitle(title);
        for (const alias of aliases) {
            const normalized = kitsuProvider.normalizeTitle(alias);
            const compact = stripEpisodeDecorations(alias);
            const noYear = compact.replace(/\s*\((?:19|20)\d{2}.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
            for (const variant of uniqueStrings([alias, normalized, compact, noYear])) {
                const cleanVariant = String(variant || '').replace(/\s+/g, ' ').trim();
                if (!cleanVariant) continue;
                const key = normalizeTitle(cleanVariant);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(cleanVariant);
            }
        }
    }
    return out;
}

async function getNewsSitemapEntries() {
    const now = Date.now();
    if (Array.isArray(newsSitemapCache.entries) && (now - newsSitemapCache.fetchedAt) < NEWS_SITEMAP_TTL_MS) {
        return newsSitemapCache.entries;
    }

    return singleFlight('sitemap:news_pages', async () => {
        const current = Date.now();
        if (Array.isArray(newsSitemapCache.entries) && (current - newsSitemapCache.fetchedAt) < NEWS_SITEMAP_TTL_MS) {
            return newsSitemapCache.entries;
        }
        const sitemapHeaders = {
            'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8',
            'Referer': `${BASE_URL}/`
        };
        let xml = null;
        if (CINEMACITY_RUST_ACCEL_SITEMAP) {
            const fast = await fetchPublicHtmlFast(NEWS_SITEMAP_URL, sitemapHeaders, {
                timeout: CINEMACITY_SITEMAP_TIMEOUT_MS,
                totalMs: CINEMACITY_SITEMAP_TOTAL_MS,
                minBytes: 120,
                cacheTtlMs: NEWS_SITEMAP_TTL_MS,
                staleTtlMs: Math.max(NEWS_SITEMAP_TTL_MS, CINEMACITY_RUST_ACCEL_STALE_TTL_MS)
            }).catch(() => null);
            xml = fast?.html || null;
        }
        if (!xml) {
            xml = await fetchHtml(NEWS_SITEMAP_URL, sitemapHeaders, {
                timeout: CINEMACITY_SITEMAP_TIMEOUT_MS,
                attempts: 1,
                context: 'document',
                axiosFallback: true,
                axiosOnBlocked: true,
                allowClearanceFallback: false,
                hardMode: false,
                totalTimeoutMs: CINEMACITY_SITEMAP_TOTAL_MS
            });
        }
        const entries = extractSitemapLocs(xml).filter((url) => /^https:\/\/cinemacity\.cc\//i.test(url));
        if (entries.length === 0) return Array.isArray(newsSitemapCache.entries) ? newsSitemapCache.entries : [];
        newsSitemapCache.entries = entries;
        newsSitemapCache.fetchedAt = Date.now();
        return entries;
    });
}

async function getIdsFromKitsu(kitsuId, season, episode, config = {}) {
    if (!kitsuId) return null;

    const parsedEpisode = Number.parseInt(String(episode || ''), 10);
    const parsedSeason = Number.parseInt(String(season || ''), 10);
    const mappingLanguage = getMappingLanguage(config) || '';
    const cacheKey = `kitsu-map:${String(kitsuId).trim()}:${Number.isInteger(parsedSeason) ? parsedSeason : ''}:${Number.isInteger(parsedEpisode) ? parsedEpisode : '1'}:${mappingLanguage}`;
    const cached = kitsuMappingCache.get(cacheKey);
    if (cached) return cached.value;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = kitsuMappingCache.get(cacheKey);
        if (alreadyCached) return alreadyCached.value;

        try {
            const params = new URLSearchParams();
            params.set('ep', Number.isInteger(parsedEpisode) && parsedEpisode > 0 ? String(parsedEpisode) : '1');
            if (Number.isInteger(parsedSeason) && parsedSeason >= 0) params.set('s', String(parsedSeason));
            if (mappingLanguage) params.set('lang', mappingLanguage);

            const payload = await fetchJson(`${MAPPING_API_BASE}/kitsu/${encodeURIComponent(String(kitsuId).trim())}?${params.toString()}`);
            const ids = payload?.mappings?.ids || {};
            const tmdbEpisode = payload?.mappings?.tmdb_episode || payload?.mappings?.tmdbEpisode
                || payload?.tmdb_episode || payload?.tmdbEpisode || null;

            const mappedSeason = Number.parseInt(String(
                tmdbEpisode?.season || tmdbEpisode?.seasonNumber || tmdbEpisode?.season_number || ''
            ), 10);
            const mappedEpisode = Number.parseInt(String(
                tmdbEpisode?.episode || tmdbEpisode?.episodeNumber || tmdbEpisode?.episode_number || ''
            ), 10);
            const rawEpisodeNumber = Number.parseInt(String(
                tmdbEpisode?.rawEpisodeNumber || tmdbEpisode?.raw_episode_number || tmdbEpisode?.rawEpisode || ''
            ), 10);

            const result = {
                imdbId: extractImdbId(ids.imdb),
                tmdbId: extractTmdbId(ids.tmdb),
                mappedSeason: Number.isInteger(mappedSeason) && mappedSeason > 0 ? mappedSeason : null,
                mappedEpisode: Number.isInteger(mappedEpisode) && mappedEpisode > 0 ? mappedEpisode : null,
                rawEpisodeNumber: Number.isInteger(rawEpisodeNumber) && rawEpisodeNumber > 0 ? rawEpisodeNumber : null
            };
            kitsuMappingCache.set(cacheKey, { value: result });
            return result;
        } catch (error) {
            console.error('[CinemaCity] Kitsu mapping error:', error.message);
            kitsuMappingCache.set(cacheKey, { value: null });
            return null;
        }
    });
}

async function getTmdbMetadata(id, providerType) {
    const normalizedId = String(id || '').trim();
    const normalizedType = providerType === 'movie' ? 'movie' : 'tv';
    if (!normalizedId) return null;

    const cacheKey = `tmdb-meta:${normalizedType}:${normalizedId}`;
    const cached = tmdbMetadataCache.get(cacheKey);
    if (cached) return cached.value;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = tmdbMetadataCache.get(cacheKey);
        if (alreadyCached) return alreadyCached.value;

        try {
            let result = null;
            if (extractImdbId(normalizedId)) {
                const payload = await tmdbHelper.fetchTmdbJson(`/find/${encodeURIComponent(normalizedId)}`, {
                    params: { external_source: 'imdb_id', language: 'en-US' }
                });
                const results = normalizedType === 'movie' ? payload?.movie_results : payload?.tv_results;
                result = Array.isArray(results) && results.length > 0 ? results[0] : null;
            } else {
                const cleanTmdbId = extractTmdbId(normalizedId);
                if (cleanTmdbId) {
                    result = await tmdbHelper.fetchTmdbJson(`/${normalizedType}/${cleanTmdbId}`, {
                        params: { language: 'en-US' }
                    });
                }
            }
            tmdbMetadataCache.set(cacheKey, { value: result });
            return result;
        } catch (error) {
            console.error('[CinemaCity] TMDB metadata error:', error.message);
            tmdbMetadataCache.set(cacheKey, { value: null });
            return null;
        }
    });
}

async function resolveImdbFromTmdb(tmdbId, providerType) {
    const cleanTmdbId = extractTmdbId(tmdbId);
    if (!cleanTmdbId) return null;

    const normalizedType = providerType === 'movie' ? 'movie' : 'tv';
    const cacheKey = `tmdb-imdb:${normalizedType}:${cleanTmdbId}`;
    const cached = tmdbImdbCache.get(cacheKey);
    if (cached) return cached.value;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = tmdbImdbCache.get(cacheKey);
        if (alreadyCached) return alreadyCached.value;

        try {
            const result = extractImdbId(await tmdbHelper.getImdbFromTmdb(cleanTmdbId, normalizedType));
            tmdbImdbCache.set(cacheKey, { value: result });
            return result;
        } catch (error) {
            console.error('[CinemaCity] TMDBâ†’IMDb resolution error:', error.message);
            tmdbImdbCache.set(cacheKey, { value: null });
            return null;
        }
    });
}

function cleanCinemaCityHref(value) {
    const raw = decodeHtmlEntities(String(value || ''))
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&')
        .trim();
    if (!raw) return null;
    const withoutTrailingNoise = raw.replace(/[)\],.;]+$/g, '');
    return resolveUrl(BASE_URL, withoutTrailingNoise);
}

function normalizeListingCandidateTitle(value, url) {
    const fromText = decodeHtmlEntities(String(value || ''))
        .replace(/\s+/g, ' ')
        .replace(/^\s*(?:New|TS|CAM-Rip|WEB-DL|HD|SD)\s*$/i, '')
        .trim();
    return fromText || titleFromContentUrl(url);
}

function extractCandidateLinksFromListing(html, sectionType) {
    const body = String(html || '');
    const $ = loadHtml(body);
    const results = [];
    const seen = new Set();

    const addCandidate = (href, title = '') => {
        const absoluteUrl = cleanCinemaCityHref(href);
        if (!absoluteUrl || seen.has(absoluteUrl)) return;
        if (!/\.html(?:$|[?#])/i.test(absoluteUrl)) return;
        if (!/^https?:\/\/cinemacity\.cc\//i.test(absoluteUrl)) return;
        if (!isCinemaCityContentUrlForType(absoluteUrl, sectionType)) return;

        const cleanTitle = normalizeListingCandidateTitle(title, absoluteUrl);
        if (!cleanTitle) return;
        seen.add(absoluteUrl);
        results.push({ url: absoluteUrl, title: cleanTitle });
    };

    // DOM path: works for normal cards and preserves human title when present.
    $('a[href], [data-href], [data-url]').each((_, node) => {
        const el = $(node);
        const href = el.attr('href') || el.attr('data-href') || el.attr('data-url') || '';
        const title = el.attr('title') || el.attr('aria-label') || el.text() || '';
        addCandidate(href, title);
    });

    // Raw HTML rescue: CinemaCity sometimes renders cards/links in attributes or minified chunks
    // that cheerio does not expose as simple anchors. This keeps the locator independent from
    // cosmetic HTML changes and fixes pages after /movies/page/1/ returning zero candidates.
    const rawPatterns = [
        /(?:href|data-href|data-url)\s*=\s*["']([^"']*(?:\/|%2F)(?:movies|anime|tv-series|series)(?:\/|%2F)\d+[-_][^"']+?\.html(?:\?[^"']*)?)["']/gi,
        /(https?:\\?\/\\?\/cinemacity\.cc\\?\/(?:movies|anime|tv-series|series)\\?\/\d+[-_][^\s"'<>\\]+?\.html(?:\?[^\s"'<>\\]*)?)/gi,
        /(^|[\s"'>(])((?:\/)?(?:movies|anime|tv-series|series)\/\d+[-_][^\s"'<>]+?\.html(?:\?[^\s"'<>]*)?)/gi
    ];

    for (const pattern of rawPatterns) {
        for (const match of body.matchAll(pattern)) {
            const href = match[2] || match[1];
            addCandidate(href, titleFromContentUrl(cleanCinemaCityHref(href) || href));
        }
    }

    return results;
}


function extractListingLastPage(html, fallback = CINEMACITY_LISTING_MAX_PAGES) {
    let maxPage = 1;
    const body = String(html || '');
    for (const match of body.matchAll(/\/page\/(\d+)\/?/gi)) {
        const page = Number.parseInt(match[1], 10);
        if (Number.isInteger(page) && page > maxPage) maxPage = page;
    }
    return Math.max(1, Math.min(CINEMACITY_LISTING_MAX_PAGES, maxPage || fallback || 1));
}

function buildListingPageUrl(listingBase, page) {
    const cleanBase = String(listingBase || '').replace(/\/+$/, '/');
    const pageNumber = Math.max(1, Number.parseInt(String(page || 1), 10) || 1);
    return pageNumber === 1 ? cleanBase : `${cleanBase}page/${pageNumber}/`;
}

async function fetchListingPageHtml(pageUrl) {
    const headers = {
        'Referer': `${BASE_URL}/movies/`,
        'Cookie': getCinemaCitySessionCookie(),
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate'
    };

    // Acceleration path: public listing pages do not need ImpIt first.
    // Race Rust/reqwest keep-alive against Axios and return the first valid HTML.
    if (CINEMACITY_RUST_ACCEL_LISTING) {
        const fast = await fetchPublicHtmlFast(pageUrl, headers, {
            timeout: CINEMACITY_LISTING_TIMEOUT_MS,
            totalMs: Math.min(CINEMACITY_LISTING_TOTAL_MS, Math.max(1200, CINEMACITY_LISTING_TIMEOUT_MS + 350)),
            minBytes: 500,
            cacheTtlMs: CINEMACITY_LISTING_PAGE_CACHE_TTL_MS,
            staleTtlMs: Math.max(CINEMACITY_LISTING_PAGE_CACHE_TTL_MS, CINEMACITY_RUST_ACCEL_STALE_TTL_MS)
        }).catch(() => null);
        if (fast?.html) return fast;
    }

    // Legacy compatibility fallback: unchanged behavior if the fast path misses.
    const axiosHtml = await fetchHtmlWithAxios(pageUrl, headers, CINEMACITY_LISTING_TIMEOUT_MS, 'document').catch(() => null);
    if (axiosHtml && isUsableCinemaCityHtml(axiosHtml, 500)) return { html: axiosHtml, via: 'axios' };

    const guardedHtml = await fetchHtml(pageUrl, headers, {
        timeout: CINEMACITY_LISTING_TIMEOUT_MS,
        attempts: 1,
        context: 'document',
        axiosFallback: true,
        axiosOnBlocked: true,
        allowClearanceFallback: false,
        hardMode: false,
        totalTimeoutMs: CINEMACITY_LISTING_TOTAL_MS
    }).catch(() => null);
    return { html: guardedHtml || '', via: guardedHtml ? 'guarded' : 'none' };
}

async function fetchListingPageCandidates(providerType, listingBase, page) {
    const pageNumber = Math.max(1, Number.parseInt(String(page || 1), 10) || 1);
    const pageUrl = buildListingPageUrl(listingBase, pageNumber);
    const cacheKey = `listing-page:v6:${providerType}:${pageUrl}`;
    const cached = listingPageCache.get(cacheKey);
    if (cached) return cached;

    const value = await singleFlight(cacheKey, async () => {
        const alreadyCached = listingPageCache.get(cacheKey);
        if (alreadyCached) return alreadyCached;
        const startedAt = Date.now();
        const { html, via } = await fetchListingPageHtml(pageUrl);
        const candidates = extractCandidateLinksFromListing(html, providerType);
        const result = {
            page: pageNumber,
            url: pageUrl,
            lastPage: pageNumber === 1 ? extractListingLastPage(html) : null,
            candidates,
            ok: Boolean(html && html.length > 500),
            via,
            ms: Date.now() - startedAt
        };
        listingPageCache.set(cacheKey, result);
        return result;
    });

    return value || { page: pageNumber, url: pageUrl, lastPage: null, candidates: [], ok: false, via: 'none', ms: 0 };
}

async function searchListingIndexCandidates(providerType, expectedTitles, { requestedImdbId = null, expectedYear = null, fastMode = true } = {}) {
    if (!CINEMACITY_LISTING_SCAN) return null;

    const cacheKey = `listing-resolve:v6:${providerType}:${requestedImdbId || ''}:${expectedYear || ''}:${buildSearchQueryVariants(expectedTitles).slice(0, 10).map(normalizeTitle).join('|')}`;
    const cached = listingScanCache.get(cacheKey);
    if (cached) return cached;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = listingScanCache.get(cacheKey);
        if (alreadyCached) return alreadyCached;

        const collected = [];
        const seen = new Set();
        const startedAt = Date.now();
        let pagesScanned = 0;
        let okPages = 0;
        let pagesWithCandidates = 0;
        const pageFetchVia = {};

        const noteVia = (result) => {
            const via = result?.via || 'none';
            pageFetchVia[via] = (pageFetchVia[via] || 0) + 1;
        };

        const addCandidates = (items = []) => {
            for (const candidate of items || []) {
                if (!candidate?.url || seen.has(candidate.url)) continue;
                seen.add(candidate.url);
                collected.push(candidate);
            }
        };

        const pick = async () => pickBestCandidate(collected, expectedTitles, {
            requestedImdbId,
            expectedYear,
            providerType,
            fastMode: true
        });

        for (const listingBase of getListingBaseUrls(providerType)) {
            const firstPage = await fetchListingPageCandidates(providerType, listingBase, 1);
            pagesScanned += 1;
            if (firstPage?.ok) okPages += 1;
            noteVia(firstPage);
            if ((firstPage?.candidates || []).length > 0) pagesWithCandidates += 1;
            addCandidates(firstPage.candidates);

            let best = await pick();
            if (best?.score >= 100) {
                listingScanCache.set(cacheKey, best);
                logCinemaCityDebug('locator hit listing scan', { providerType, title: best.title, url: best.url, pagesScanned, ms: Date.now() - startedAt, reason: 'page-1' });
                return best;
            }

            const lastPage = Math.max(1, Math.min(CINEMACITY_LISTING_MAX_PAGES, firstPage.lastPage || CINEMACITY_LISTING_MAX_PAGES));
            const pages = Array.from({ length: Math.max(0, lastPage - 1) }, (_, i) => i + 2);

            for (let i = 0; i < pages.length; i += CINEMACITY_LISTING_CONCURRENCY) {
                const batch = pages.slice(i, i + CINEMACITY_LISTING_CONCURRENCY);
                const batchResults = await Promise.all(batch.map((page) => fetchListingPageCandidates(providerType, listingBase, page).catch(() => null)));
                for (const result of batchResults) {
                    if (!result) continue;
                    pagesScanned += 1;
                    if (result?.ok) okPages += 1;
                    noteVia(result);
                    if ((result?.candidates || []).length > 0) pagesWithCandidates += 1;
                    addCandidates(result.candidates);
                }

                best = await pick();
                if (best?.score >= 100 || (best?.score >= 95 && pagesScanned >= 8)) {
                    listingScanCache.set(cacheKey, best);
                    logCinemaCityDebug('locator hit listing scan', { providerType, title: best.title, url: best.url, pagesScanned, ms: Date.now() - startedAt, reason: 'batch' });
                    return best;
                }

                if (fastMode && Date.now() - startedAt > 9000 && best?.score >= 80) {
                    listingScanCache.set(cacheKey, best);
                    logCinemaCityDebug('locator hit listing scan budget', { providerType, title: best.title, url: best.url, pagesScanned, ms: Date.now() - startedAt });
                    return best;
                }
            }
        }

        const finalBest = await pick();
        const value = finalBest?.url ? finalBest : null;
        listingScanCache.set(cacheKey, value);
        logCinemaCityDebug(value ? 'locator hit listing scan final' : 'locator listing scan miss', {
            providerType,
            pagesScanned,
            okPages,
            pagesWithCandidates,
            via: pageFetchVia,
            candidates: collected.length,
            sample: collected.slice(0, 5).map((c) => c.title || titleFromContentUrl(c.url)),
            expectedYear,
            titles: expectedTitles.slice(0, 4),
            ms: Date.now() - startedAt
        });
        return value;
    });
}

function scoreTitleMatch(candidateTitle, expectedTitles) {
    const normalizedCandidate = normalizeTitle(candidateTitle);
    if (!normalizedCandidate) return 0;
    let best = 0;
    for (const title of expectedTitles) {
        const normalizedExpected = normalizeTitle(title);
        if (!normalizedExpected) continue;
        if (normalizedCandidate === normalizedExpected) return 100;
        if (normalizedCandidate.includes(normalizedExpected) || normalizedExpected.includes(normalizedCandidate)) {
            best = Math.max(best, 80);
        } else if (
            normalizedExpected.length > 5 && normalizedCandidate.length > 5
            && (normalizedCandidate.startsWith(normalizedExpected) || normalizedExpected.startsWith(normalizedCandidate))
        ) {
            best = Math.max(best, 60);
        }
    }
    return best;
}

function scoreCandidateEntry(candidate, expectedTitles, expectedYear, providerType) {
    if (!candidate?.url) return 0;
    const title = candidate.title || titleFromContentUrl(candidate.url);
    let score = scoreTitleMatch(title, expectedTitles);
    if (score <= 0) return 0;
    score += getCinemaCityTypeBoost(candidate.url, providerType);
    const candidateYear = extractYear(title) || extractYear(candidate.url);
    if (expectedYear && candidateYear) {
        if (candidateYear === expectedYear) score += 15;
        else if (Math.abs(candidateYear - expectedYear) === 1) score += 5;
        else score -= 20;
    }
    return score;
}

function extractSearchCandidates(html) {
    const body = String(html || '');
    if (/site search yielded no results|ricerca non ha prodotto risultati/i.test(body)) return [];

    const $ = loadHtml(body);
    const roots = $('#dle-content').length ? $('#dle-content') : $('body');
    const results = [];

    roots.find('a[href]').each((_, anchor) => {
        const href = String($(anchor).attr('href') || '').trim();
        if (!href) return;
        const absoluteUrl = resolveUrl(BASE_URL, href);
        if (!absoluteUrl) return;
        if (!/^https?:\/\/cinemacity\.cc\/(?:movies|anime|series|tv-series)\/\d+-[^?#]+\.html(?:$|[?#])/i.test(absoluteUrl)) return;

        const title = decodeHtmlEntities(
            $(anchor).attr('title') || $(anchor).text() || titleFromContentUrl(absoluteUrl)
        ).replace(/\s+/g, ' ').trim();
        if (!title) return;
        results.push({ url: absoluteUrl, title });
    });

    return Array.from(new Map(results.map((item) => [item.url, item])).values());
}

async function verifyCandidateImdb(candidateUrl, expectedImdbId) {
    const normalizedExpected = extractImdbId(expectedImdbId);
    if (!normalizedExpected) return null;
    try {
        const pageMetadata = await fetchCinemaCityPageMetadata(candidateUrl);
        return pageMetadata?.imdbId || null;
    } catch (_) {
        return null;
    }
}

async function pickBestCandidate(candidates, expectedTitles, { requestedImdbId = null, expectedYear = null, providerType = 'tv', fastMode = false } = {}) {
    const scoredCandidates = (candidates || [])
        .map((c) => ({ ...c, score: scoreCandidateEntry(c, expectedTitles, expectedYear, providerType) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scoredCandidates.length === 0) return null;

    const normalizedRequestedImdbId = extractImdbId(requestedImdbId);
    if (normalizedRequestedImdbId) {
        // Anti-mismatch guard: never fast-return a title candidate while we have an IMDb id.
        // Failed CinemaCity searches can return generic homepage cards; those must never be
        // accepted for another movie just because they are first in the HTML.
        const candidatesToCheck = scoredCandidates.slice(0, fastMode ? 4 : 8).filter(c => c.score >= 80);
        const imdbResults = await Promise.all(
            candidatesToCheck.map(c => verifyCandidateImdb(c.url, normalizedRequestedImdbId))
        );
        const mismatchedUrls = new Set();
        candidatesToCheck.forEach((c, i) => {
            if (imdbResults[i] && imdbResults[i] !== normalizedRequestedImdbId) mismatchedUrls.add(c.url);
        });
        const firstMatch = candidatesToCheck.find((_, i) => imdbResults[i] === normalizedRequestedImdbId);
        if (firstMatch) return firstMatch;

        const safeByTitle = scoredCandidates.find((c) => {
            const year = extractYear(c.title) || extractYear(c.url);
            return c.score >= 100 && !mismatchedUrls.has(c.url) && (!expectedYear || !year || Math.abs(year - expectedYear) <= 1);
        });
        return safeByTitle || null;
    }

    if (fastMode === true && scoredCandidates[0]?.score >= 100) {
        return scoredCandidates[0];
    }

    if (providerType === 'anime') {
        const enriched = [];
        for (const candidate of scoredCandidates.slice(0, 6)) {
            const pageMetadata = await fetchCinemaCityPageMetadata(candidate.url);
            let score = candidate.score;
            if (pageMetadata?.isAnime) score += 35;
            else if (pageMetadata) score -= 10;
            if (pageMetadata?.title) {
                const pageTitleScore = scoreTitleMatch(pageMetadata.title, expectedTitles);
                if (pageTitleScore >= 80) score += 12;
                else if (pageTitleScore === 0) score -= 10;
            }
            if (expectedYear && pageMetadata?.year) {
                if (pageMetadata.year === expectedYear) score += 12;
                else if (Math.abs(pageMetadata.year - expectedYear) === 1) score += 4;
                else score -= 15;
            }
            enriched.push({ ...candidate, pageMetadata, score });
        }
        const bestAnime = [...enriched, ...scoredCandidates.slice(6)].sort((a, b) => b.score - a.score)[0];
        return bestAnime?.score >= 80 ? bestAnime : null;
    }

    return scoredCandidates[0]?.score >= 80 ? scoredCandidates[0] : null;
}

async function fetchSearchCandidates(query) {
    const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();
    if (!cleanQuery) return [];

    const cacheKey = `search:${cleanQuery.toLowerCase()}`;
    const cached = searchCandidatesCache.get(cacheKey);
    if (cached) return cached.value;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = searchCandidatesCache.get(cacheKey);
        if (alreadyCached) return alreadyCached.value;

        const searchGetUrl = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(cleanQuery)}`;
        const searchCommonHeaders = {
            'Referer': `${BASE_URL}/`,
            'Cookie': getCinemaCitySessionCookie(),
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'navigate'
        };

        const tryParse = (html) => {
            const candidates = extractSearchCandidates(html);
            if (candidates.length > 0) {
                searchCandidatesCache.set(cacheKey, { value: candidates });
                return candidates;
            }
            return null;
        };

        const tryPostSearch = async (source = 'post') => {
            if (CINEMACITY_FORCE_CLEARANCE_BEFORE_SEARCH && providerShield?.guard?.ensureClearance) {
                try {
                    const fresh = typeof providerShield.guard.isSessionFresh === 'function'
                        ? providerShield.guard.isSessionFresh(`${BASE_URL}/index.php`)
                        : false;
                    if (!fresh) {
                        logCinemaCityDebug('pre-search clearance start', { query: cleanQuery, source });
                        await providerShield.guard.ensureClearance(`${BASE_URL}/index.php`, {
                            force: true,
                            isPost: true,
                            body: formBody,
                            ignoreProviderCooldown: true
                        });
                        logCinemaCityDebug('pre-search clearance done', { query: cleanQuery, source });
                    }
                } catch (error) {
                    logCinemaCityDebug('pre-search clearance failed', { query: cleanQuery, source, error: error?.message || String(error) });
                }
            }

            try {
                const shieldHtml = await providerShield.fetchHtml(`${BASE_URL}/index.php`, {
                    method: 'POST',
                    body: formBody,
                    timeout: CINEMACITY_SEARCH_POST_TIMEOUT_MS,
                    ttl: SEARCH_CACHE_TTL_MS
                });
                if (shieldHtml) {
                    networkFailed = false;
                    const result = tryParse(shieldHtml);
                    if (result) {
                        logCinemaCityDebug('locator search post hit', { query: cleanQuery, source, candidates: result.length });
                        return result;
                    }
                    logCinemaCityDebug('locator search post empty', { query: cleanQuery, source, bytes: shieldHtml.length });
                }
            } catch (_) {}

            if (CINEMACITY_KRAKEN_FORWARD_ENABLED && CINEMACITY_KRAKEN_FORWARD_FIRST) {
                try {
                    const krakenHtml = await fetchHtmlWithKrakenForward(
                        `${BASE_URL}/index.php`,
                        {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Origin': BASE_URL,
                            'Referer': `${BASE_URL}/`,
                            'Cookie': getCinemaCitySessionCookie()
                        },
                        CINEMACITY_KRAKEN_FORWARD_TIMEOUT_MS,
                        'ajax',
                        'POST',
                        formBody
                    );
                    if (krakenHtml) {
                        networkFailed = false;
                        const result = tryParse(krakenHtml);
                        if (result) {
                            logCinemaCityDebug('locator kraken post hit', { query: cleanQuery, source, candidates: result.length });
                            return result;
                        }
                    }
                } catch (_) {}
            }

            try {
                const postHtml = await fetchHtmlPostWithImpit(`${BASE_URL}/index.php`, formBody, {
                    'Cookie': getCinemaCitySessionCookie()
                }, {
                    timeout: CINEMACITY_SEARCH_POST_TIMEOUT_MS,
                    totalTimeoutMs: CINEMACITY_SEARCH_POST_TOTAL_MS
                });
                if (postHtml) {
                    networkFailed = false;
                    const result = tryParse(postHtml);
                    if (result) {
                        logCinemaCityDebug('locator impit post hit', { query: cleanQuery, source, candidates: result.length });
                        return result;
                    }
                }
            } catch (_) {}

            try {
                const postAxiosHtml = await fetchHtmlPostWithAxios(`${BASE_URL}/index.php`, formBody, {
                    'Cookie': getCinemaCitySessionCookie()
                }, CINEMACITY_SEARCH_POST_TIMEOUT_MS);
                if (postAxiosHtml) {
                    networkFailed = false;
                    const result = tryParse(postAxiosHtml);
                    if (result) {
                        logCinemaCityDebug('locator axios post hit', { query: cleanQuery, source, candidates: result.length });
                        return result;
                    }
                }
            } catch (_) {}

            return null;
        };

        let networkFailed = true;

        const formBody = new URLSearchParams({
            do: 'search',
            subaction: 'search',
            story: cleanQuery
        }).toString();

        if (CINEMACITY_SEARCH_POST_FIRST) {
            const postFirstResult = await tryPostSearch('post-first');
            if (postFirstResult) return postFirstResult;
        }

        if (CINEMACITY_SEARCH_WARMUP) {
            try {
                await warmupCinemaCitySession('search');
            } catch (_) {}
        }

        if (CINEMACITY_RUST_ACCEL_SEARCH_GET) {
            try {
                const fast = await fetchPublicHtmlFast(searchGetUrl, searchCommonHeaders, {
                    context: 'document',
                    timeout: CINEMACITY_SEARCH_GET_TIMEOUT_MS,
                    totalMs: Math.min(CINEMACITY_SEARCH_GET_TOTAL_MS, Math.max(1300, CINEMACITY_SEARCH_GET_TIMEOUT_MS + 350)),
                    minBytes: 500,
                    cacheTtlMs: SEARCH_CACHE_TTL_MS,
                    staleTtlMs: Math.max(SEARCH_CACHE_TTL_MS, CINEMACITY_RUST_ACCEL_STALE_TTL_MS)
                });
                if (fast?.html) {
                    networkFailed = false;
                    const result = tryParse(fast.html);
                    if (result) return result;
                }
            } catch (_) {}
        }

        try {
            const html = await fetchHtml(searchGetUrl, searchCommonHeaders, {
                context: 'document',
                timeout: CINEMACITY_SEARCH_GET_TIMEOUT_MS,
                attempts: 1,
                hardMode: false,
                axiosFallback: true,
                axiosOnBlocked: true,
                allowClearanceFallback: false,
                totalTimeoutMs: CINEMACITY_SEARCH_GET_TOTAL_MS
            });
            if (html) {
                networkFailed = false;
                const result = tryParse(html);
                if (result) return result;
            }
        } catch (_) {}

        if (!CINEMACITY_SEARCH_POST_FIRST) {
            const postResult = await tryPostSearch('post-fallback');
            if (postResult) return postResult;
        }

        if (!networkFailed) {
            searchCandidatesCache.set(cacheKey, { value: [] });
        }
        return [];
    });
}

async function searchByTitleQueries(queryTitles, providerType, expectedTitles, requestedImdbId, expectedYear, options = {}) {
    const defaultLimit = providerType === 'anime' ? 10 : 6;
    const maxQueries = Math.max(1, Math.min(defaultLimit, Number.parseInt(String(options.maxQueries || defaultLimit), 10) || defaultLimit));
    const queries = buildSearchQueryVariants(queryTitles).slice(0, maxQueries);
    if (queries.length === 0) return null;

    const collected = [];
    const seen = new Set();
    const BATCH_SIZE = Math.max(1, Math.min(3, Number.parseInt(String(options.batchSize || 3), 10) || 3));

    for (let i = 0; i < queries.length; i += BATCH_SIZE) {
        const batch = queries.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map((q) => fetchSearchCandidates(q)));

        for (const candidates of batchResults) {
            for (const candidate of candidates) {
                if (!candidate?.url || seen.has(candidate.url)) continue;
                seen.add(candidate.url);
                collected.push(candidate);
            }
        }

        const interim = await pickBestCandidate(collected, expectedTitles, { requestedImdbId, expectedYear, providerType, fastMode: true });
        if (interim?.score >= 100) return interim;
    }

    return pickBestCandidate(collected, expectedTitles, { requestedImdbId, expectedYear, providerType, fastMode: true });
}

async function searchSitemapCandidates(providerType, expectedTitles, { requestedImdbId = null, expectedYear = null, fastMode = true } = {}) {
    if (!CINEMACITY_SITEMAP_LOOKUP) return null;
    try {
        const sitemapEntries = await getNewsSitemapEntries();
        const sitemapCandidates = sitemapEntries
            .filter((url) => isCinemaCityContentUrlForType(url, providerType))
            .map((url) => ({ url, title: titleFromContentUrl(url) }))
            .filter((c) => scoreTitleMatch(c.title, expectedTitles) > 0);

        return pickBestCandidate(sitemapCandidates, expectedTitles, {
            requestedImdbId, expectedYear, providerType, fastMode
        });
    } catch (_) {
        return null;
    }
}

async function searchByImdb(imdbId) {
    const normalizedImdbId = extractImdbId(imdbId);
    if (!normalizedImdbId) return null;

    const verifyList = async (candidates, source) => {
        const uniqueCandidates = Array.from(new Map((candidates || [])
            .filter((c) => c?.url)
            .map((c) => [c.url, c])).values()).slice(0, 8);
        if (uniqueCandidates.length === 0) return null;

        const imdbResults = await Promise.all(uniqueCandidates.map(c => verifyCandidateImdb(c.url, normalizedImdbId)));
        const matchIndex = imdbResults.findIndex((value) => value === normalizedImdbId);
        if (matchIndex >= 0) return uniqueCandidates[matchIndex];

        logCinemaCityDebug('locator imdb search rejected', {
            imdbId: normalizedImdbId,
            source,
            checked: uniqueCandidates.length,
            sample: uniqueCandidates.slice(0, 4).map((c) => c.title || titleFromContentUrl(c.url))
        });
        return null;
    };

    let result = await verifyList(await fetchSearchCandidates(normalizedImdbId), 'tt');
    if (result) return result;

    const numericId = normalizedImdbId.replace(/\D/g, '');
    if (numericId && numericId !== normalizedImdbId) {
        result = await verifyList(await fetchSearchCandidates(numericId), 'numeric');
    }
    return result;
}

function getListingBaseUrls(providerType) {
    if (providerType === 'movie') return [`${BASE_URL}/movies/`];
    if (providerType === 'anime') return [`${BASE_URL}/anime/`, `${BASE_URL}/tv-series/`];
    return [`${BASE_URL}/tv-series/`, `${BASE_URL}/anime/`];
}

async function searchByTitleFallback(id, providerType, meta = {}, options = {}) {
    const tmdbType = providerType === 'movie' ? 'movie' : 'tv';
    const metadata = options?.metadata || await getTmdbMetadata(id, tmdbType);
    const expectedTitles = uniqueStrings([
        ...(Array.isArray(options?.expectedTitles) ? options.expectedTitles : []),
        ...collectExpectedTitles(metadata, meta)
    ]);

    if (expectedTitles.length === 0) return null;

    const requestedImdbId = extractImdbId(options?.requestedImdbId || id);
    const expectedYear = options?.expectedYear || getExpectedYear(metadata, meta);
    const fastMode = options?.fast !== false;
    const cacheKey = `resolve:v6:${providerType}:${requestedImdbId || ''}:${extractTmdbId(id) || ''}:${expectedYear || ''}:${fastMode ? 'fast' : 'deep'}:${buildSearchQueryVariants(expectedTitles).slice(0, 10).map(normalizeTitle).join('|')}`;
    const cached = resolvedSearchCache.get(cacheKey);
    if (cached) return cached.value;

    const saveResult = (value) => {
        resolvedSearchCache.set(cacheKey, { value: value || null });
        return value || null;
    };

    const bestSitemap = await searchSitemapCandidates(providerType, expectedTitles, {
        requestedImdbId, expectedYear, fastMode
    });
    if (bestSitemap?.url) {
        logCinemaCityDebug('locator hit sitemap', { providerType, title: bestSitemap.title, url: bestSitemap.url });
        return saveResult(bestSitemap);
    }
    logCinemaCityDebug('locator sitemap miss', { providerType, expectedYear, titles: expectedTitles.slice(0, 4) });

    if (fastMode) {
        if (CINEMACITY_QUICK_TITLE_SEARCH) {
            const quickSearched = await searchByTitleQueries(expectedTitles, providerType, expectedTitles, requestedImdbId, expectedYear, {
                maxQueries: CINEMACITY_QUICK_TITLE_QUERIES,
                batchSize: 1
            });
            if (quickSearched?.url) {
                logCinemaCityDebug('locator hit quick title search', { providerType, title: quickSearched.title, url: quickSearched.url });
                return saveResult(quickSearched);
            }
            logCinemaCityDebug('locator quick title miss', { providerType, titles: expectedTitles.slice(0, 4) });
        }

        const listed = await searchListingIndexCandidates(providerType, expectedTitles, {
            requestedImdbId,
            expectedYear,
            fastMode: true
        });
        if (listed?.url) return saveResult(listed);
        return saveResult(null);
    }

    const searched = await searchByTitleQueries(expectedTitles, providerType, expectedTitles, requestedImdbId, expectedYear);
    if (searched?.url) {
        logCinemaCityDebug('locator hit deep title search', { providerType, title: searched.title, url: searched.url });
        return saveResult(searched);
    }

    const listed = await searchListingIndexCandidates(providerType, expectedTitles, {
        requestedImdbId,
        expectedYear,
        fastMode: false
    });
    if (listed?.url) return saveResult(listed);

    let bestResult = null;
    let bestScore = 0;
    const PAGE_CONCURRENCY = 3;

    for (const listingBase of getListingBaseUrls(providerType)) {
        const pageNums = Array.from({ length: MAX_LISTING_PAGES }, (_, i) => i + 1);

        for (let i = 0; i < pageNums.length; i += PAGE_CONCURRENCY) {
            const pageBatch = pageNums.slice(i, i + PAGE_CONCURRENCY);

            const batchResults = await Promise.all(pageBatch.map(async (page) => {
                const pageUrl = page === 1 ? listingBase : `${listingBase}page/${page}/`;
                try {
                    const html = await fetchHtml(pageUrl, {
                        'Referer': `${BASE_URL}/`,
                        'Sec-Fetch-Site': 'same-origin',
                        'Sec-Fetch-Mode': 'navigate'
                    }, { timeout: 2000 });
                    const candidates = extractCandidateLinksFromListing(html, providerType);
                    if (candidates.length === 0) return null;
                    return candidates.slice(0, MAX_LISTING_CANDIDATES_PER_PAGE);
                } catch (_) {
                    return null;
                }
            }));

            let batchExhausted = true;
            for (const candidates of batchResults) {
                if (!candidates) continue;
                batchExhausted = false;
                const picked = await pickBestCandidate(candidates, expectedTitles, { requestedImdbId, expectedYear, providerType, fastMode });
                if (picked?.score > bestScore) {
                    bestScore = picked.score;
                    bestResult = picked;
                }
            }

            if (bestScore >= 100) return saveResult(bestResult);
            if (batchExhausted) break;
        }

        if (bestScore >= 100) break;
    }

    return saveResult(bestScore >= 80 ? bestResult : null);
}

function getIdCandidates(meta = {}, originalId, finalId) {
    return [
        originalId,
        finalId,
        meta?.requestedId,
        meta?.originalId,
        meta?.id,
        meta?.imdb_id,
        meta?.imdbId,
        meta?.tmdb_id,
        meta?.tmdbId,
        meta?.kitsu_id ? 'kitsu:' + meta.kitsu_id : null,
        meta?.kitsuId ? 'kitsu:' + meta.kitsuId : null,
        meta?.kitsu ? (/^\d+$/.test(String(meta.kitsu).trim()) ? 'kitsu:' + meta.kitsu : meta.kitsu) : null
    ].filter(Boolean);
}

function getKitsuIdCandidates(meta = {}, originalId, finalId) {
    const taggedCandidates = [
        originalId,
        finalId,
        meta?.requestedId,
        meta?.originalId,
        meta?.id,
        meta?.sourceId,
        meta?.source_id,
        meta?.stremioId,
        meta?.stremio_id,
        meta?.canonicalId,
        meta?.canonical_id,
        meta?.kitsu_id,
        meta?.kitsuId,
        meta?.kitsu
    ].filter((value) => /kitsu/i.test(String(value || '')));

    const dedicated = [meta?.kitsu_id, meta?.kitsuId, meta?.kitsu].map((value) => {
        const text = String(value || '').trim();
        if (!text) return null;
        return /^\d+$/.test(text) ? 'kitsu:' + text : text;
    });

    return [...taggedCandidates, ...dedicated].filter(Boolean);
}

function canTryCinemaCityAnimeMapping(meta = {}) {
    if (!meta || meta?.isSeries === false || String(meta?.type || '').toLowerCase() === 'movie') return false;
    if (meta?.kitsu_id || meta?.kitsuId || meta?.kitsu) return true;
    if (meta?.tmdbAnimeCandidate === true) return true;
    if (meta?.isAnime === true && (meta?.tmdb_id || meta?.tmdbId || meta?.imdb_id || meta?.imdbId)) return true;
    return false;
}

async function buildAnimeSearchContext(meta = {}, originalId, finalId, config = {}, season = null, episode = null) {
    const candidateIds = getKitsuIdCandidates(meta, originalId, finalId);
    let kitsuToken = null;

    for (const candidate of candidateIds) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) {
            kitsuToken = /^\d+$/.test(String(candidate || '').trim()) ? 'kitsu:' + candidate : String(candidate);
            break;
        }
    }

    if (kitsuToken) {
        try {
            const context = await kitsuProvider.buildSearchContext(kitsuToken, meta);
            if (context?.kitsuId) {
                return {
                    ...context,
                    searchTitles: buildSearchQueryVariants([
                        ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
                        ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                        ...collectMetaTitles(meta)
                    ]),
                    rawTitles: uniqueStrings([
                        ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                        ...collectMetaTitles(meta)
                    ]),
                    strictKitsu: true
                };
            }
        } catch (_) {}
    }

    if (!canTryCinemaCityAnimeMapping(meta)) return null;

    try {
        const safeSeason = Number.parseInt(String(season || meta?.season || 1), 10) || 1;
        const safeEpisode = Number.parseInt(String(episode || meta?.episode || 1), 10) || 1;
        const context = await animeIdentity.buildAnimeSearchContextForProvider({
            requestId: originalId || finalId || meta?.id || (meta?.imdb_id ? `${meta.imdb_id}:${safeSeason}:${safeEpisode}` : meta?.tmdb_id ? `tmdb:${meta.tmdb_id}:${safeSeason}:${safeEpisode}` : null),
            finalId: finalId || originalId || meta?.id || null,
            meta: {
                ...meta,
                type: 'series',
                isSeries: true,
                season: safeSeason,
                episode: safeEpisode
            },
            config,
            season: safeSeason,
            episode: safeEpisode,
            providerName: 'CinemaCityAnimeBridge',
            language: 'it-IT',
            mappingTimeoutMs: FETCH_TIMEOUT,
            kitsuTimeoutMs: 1400,
            debug: false
        });

        if (!context?.kitsuId) return null;

        return {
            ...context,
            searchTitles: buildSearchQueryVariants([
                ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
                ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                ...collectMetaTitles(meta)
            ]),
            rawTitles: uniqueStrings([
                ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                ...collectMetaTitles(meta)
            ]),
            strictKitsu: false,
            mappedKitsu: true
        };
    } catch (_) {}

    return null;
}

async function resolveSearchState(meta = {}, originalId, finalId, config = {}) {
    const fallbackSeason = Number.parseInt(String(meta?.season || ''), 10) || 1;
    const fallbackEpisode = Number.parseInt(String(meta?.episode || ''), 10) || 1;
    const candidateIds = getIdCandidates(meta, originalId, finalId);
    let parsedRequest = parseCompositeSeriesId(candidateIds[0] || '', fallbackSeason, fallbackEpisode);
    for (const candidateId of candidateIds) {
        const parsedCandidate = parseCompositeSeriesId(candidateId, fallbackSeason, fallbackEpisode);
        const rawText = String(candidateId || '').trim();
        const hasCompositeSeasonEpisode = /^(?:tt\d+|\d+|tmdb:\d+|kitsu:\d+):\d+:\d+$/i.test(rawText);
        if (hasCompositeSeasonEpisode) {
            parsedRequest = parsedCandidate;
            break;
        }
        if (!parsedRequest.normalizedId && parsedCandidate.normalizedId) parsedRequest = parsedCandidate;
    }

    const hasCompositeRequestId = candidateIds.some((candidateId) => /^(?:tt\d+|\d+|tmdb:\d+|kitsu:\d+):\d+:\d+$/i.test(String(candidateId || '').trim()));
    const isSeries = Boolean(meta?.isSeries) || hasCompositeRequestId || String(meta?.type || '').toLowerCase() === 'series';

    let workingId = parsedRequest.normalizedId;
    let season = parsedRequest.season;
    let episode = parsedRequest.episode;
    let providerType = isSeries ? 'tv' : 'movie';

    const contextImdbId = candidateIds.map(extractImdbId).find(Boolean) || null;
    const contextTmdbId = candidateIds.map(extractTmdbId).find(Boolean) || null;
    const explicitKitsuCandidates = [
        meta?.kitsu_id,
        meta?.kitsuId,
        ...candidateIds.filter((id) => /^kitsu:/i.test(String(id || '').trim()))
    ];
    const explicitKitsuId = explicitKitsuCandidates.map(extractKitsuId).find(Boolean) || null;
    const contextKitsuId = explicitKitsuId || null;
    let resolvedTmdbId = contextTmdbId || extractTmdbId(workingId) || null;
    let rawEpisodeNumber = null;
    let episodeCandidates = numberCandidates([episode]);
    let animeContext = null;

    if (!workingId) {
        workingId = contextImdbId || contextTmdbId || (contextKitsuId ? `kitsu:${contextKitsuId}` : '');
    }

    const allowAnimeBridge = isSeries && String(meta?.type || '').toLowerCase() !== 'movie';

    const canTryAnime = allowAnimeBridge && Boolean(
        contextKitsuId
        || candidateIds.some((id) => /^kitsu:/i.test(String(id || '').trim()))
        || meta?.tmdbAnimeCandidate === true
        || (meta?.isAnime === true && (contextImdbId || contextTmdbId || meta?.tmdb_id || meta?.imdb_id))
    );
    if (canTryAnime) {
        animeContext = await buildAnimeSearchContext(meta, originalId, finalId, config, season, episode);
        if (animeContext?.kitsuId) {
            if (animeContext?.seasonNumber) season = animeContext.seasonNumber;
            if (animeContext?.requestedEpisode) episode = animeContext.requestedEpisode;
            providerType = 'anime';
        }
    }

    const applyMappedIds = (mapped) => {
        if (!mapped) return false;
        if (mapped.tmdbId) resolvedTmdbId = mapped.tmdbId;
        if (mapped.imdbId) workingId = mapped.imdbId;
        else if (mapped.tmdbId && !extractImdbId(workingId)) workingId = mapped.tmdbId;
        if (mapped.rawEpisodeNumber) rawEpisodeNumber = mapped.rawEpisodeNumber;
        if (mapped.mappedEpisode) episodeCandidates = numberCandidates([mapped.mappedEpisode, episode, rawEpisodeNumber]);
        if (mapped.mappedSeason && mapped.mappedEpisode) {
            season = mapped.mappedSeason;
            episode = mapped.mappedEpisode;
        } else if (mapped.rawEpisodeNumber) {
            episode = mapped.rawEpisodeNumber;
            episodeCandidates = numberCandidates([rawEpisodeNumber, episode]);
        }
        episodeCandidates = numberCandidates([episode, ...(episodeCandidates || []), rawEpisodeNumber]);
        return Boolean(mapped.imdbId || mapped.tmdbId || mapped.mappedSeason || mapped.mappedEpisode || mapped.rawEpisodeNumber);
    };

    const mappedFromSharedContext = animeContext?.mappedIds || null;
    const sharedApplied = applyMappedIds(mappedFromSharedContext);

    if (!sharedApplied && (String(workingId || '').startsWith('kitsu:') || contextKitsuId)) {
        const kitsuId = contextKitsuId || extractKitsuId(workingId);
        const mapped = await getIdsFromKitsu(kitsuId, isSeries ? season : null, isSeries ? episode : 1, config);
        applyMappedIds(mapped);
    }

    if (!extractImdbId(workingId) && contextImdbId) {
        workingId = contextImdbId;
    } else if (!extractTmdbId(workingId) && contextTmdbId) {
        workingId = contextTmdbId;
    }

    if (!extractImdbId(workingId)) {
        const tmdbId = extractTmdbId(workingId) || resolvedTmdbId || contextTmdbId;
        const resolvedImdbId = await resolveImdbFromTmdb(tmdbId, providerType === 'movie' ? 'movie' : 'tv');
        if (resolvedImdbId) workingId = resolvedImdbId;
    }

    return {
        imdbId: extractImdbId(workingId),
        tmdbId: extractTmdbId(workingId) || resolvedTmdbId || contextTmdbId || null,
        isAnime: providerType === 'anime',
        searchTitles: Array.isArray(animeContext?.searchTitles) ? animeContext.searchTitles : [],
        rawTitles: Array.isArray(animeContext?.rawTitles) ? animeContext.rawTitles : [],
        expectedYear: animeContext?.year || extractYear(meta?.year || meta?.releaseInfo || ''),
        season,
        episode,
        rawEpisodeNumber,
        episodeCandidates,
        providerType
    };
}

function parseCompositeSeriesId(rawId, season, episode) {
    const parsed = {
        normalizedId: String(rawId || '').trim(),
        season: Number.isInteger(season) ? season : (Number.parseInt(season, 10) || 1),
        episode: Number.isInteger(episode) ? episode : (Number.parseInt(episode, 10) || 1)
    };

    const kitsuSeasonEpMatch = parsed.normalizedId.match(/^kitsu:(\d+):(\d+):(\d+)$/i);
    if (kitsuSeasonEpMatch) {
        parsed.normalizedId = `kitsu:${kitsuSeasonEpMatch[1]}`;
        parsed.season = Number.parseInt(kitsuSeasonEpMatch[2], 10) || parsed.season;
        parsed.episode = Number.parseInt(kitsuSeasonEpMatch[3], 10) || parsed.episode;
        return parsed;
    }

    const kitsuEpMatch = parsed.normalizedId.match(/^kitsu:(\d+):(\d+)$/i);
    if (kitsuEpMatch) {
        parsed.normalizedId = `kitsu:${kitsuEpMatch[1]}`;
        parsed.season = 1;
        parsed.episode = Number.parseInt(kitsuEpMatch[2], 10) || parsed.episode;
        return parsed;
    }

    const match = parsed.normalizedId.match(/^(tt\d+|\d+|tmdb:\d+):(\d+):(\d+)$/i);
    if (!match) return parsed;
    parsed.normalizedId = match[1];
    parsed.season = Number.parseInt(match[2], 10) || parsed.season;
    parsed.episode = Number.parseInt(match[3], 10) || parsed.episode;
    return parsed;
}

function numberCandidates(values = []) {
    const seen = new Set();
    const out = [];
    for (const value of Array.isArray(values) ? values : [values]) {
        const parsed = normalizeEpisodeNumber(value);
        if (!parsed || seen.has(parsed)) continue;
        seen.add(parsed);
        out.push(parsed);
    }
    return out;
}

function extractSeasonNumberFromTitle(title) {
    const match = String(title || '').match(/(?:season|stagione)\s*0*(\d+)\b|(?:^|\b)s\s*0*(\d+)\b/i);
    const value = Number.parseInt(String(match?.[1] || match?.[2] || ''), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
}

function extractEpisodeNumberFromTitle(title) {
    const text = String(title || '');

    let match = text.match(/\bS\d{1,2}E0*(\d{1,4})\b/i);
    if (match) return Number.parseInt(match[1], 10) || null;

    match = text.match(/\b\d{1,2}x0*(\d{1,4})\b/i);
    if (match) return Number.parseInt(match[1], 10) || null;

    match = text.match(/(?:episode|episodio|ep\.?)\s*0*(\d{1,4})\b/i);
    if (match) return Number.parseInt(match[1], 10) || null;

    match = text.match(/(?:^|[^a-z0-9])E0*(\d{1,4})(?:[^a-z0-9]|$)/i);
    if (match) return Number.parseInt(match[1], 10) || null;

    match = text.match(/^\s*0*(\d{1,4})\s*[-â€“.]/);
    if (match) return Number.parseInt(match[1], 10) || null;

    return null;
}

function pickEpisodeFromFolder(folder = [], episodeCandidates = []) {
    const episodeEntries = folder
        .filter((e) => e && typeof e === 'object' && e.file)
        .map((e, index) => ({ entry: e, index, episodeNumber: extractEpisodeNumberFromTitle(e.title) }));

    if (episodeEntries.length === 0) return null;

    for (const wantedEpisode of episodeCandidates) {
        const exactEpisodeMatch = episodeEntries.find((e) => e.episodeNumber === wantedEpisode);
        if (exactEpisodeMatch?.entry?.file) return exactEpisodeMatch.entry.file;
    }

    const hasExplicitEpisodeNumbers = episodeEntries.some((e) => Number.isInteger(e.episodeNumber));
    if (hasExplicitEpisodeNumbers) return null;

    for (const wantedEpisode of episodeCandidates) {
        const byIndex = episodeEntries[wantedEpisode - 1]?.entry?.file || null;
        if (byIndex) return byIndex;
    }

    return null;
}

function flattenSeasonEpisodes(seasonEntries = []) {
    const flat = [];
    for (const seasonEntry of seasonEntries) {
        for (const item of seasonEntry?.entry?.folder || []) {
            if (item && typeof item === 'object' && item.file) flat.push(item);
        }
    }
    return flat;
}

function pickStream(fileData, type, season = 1, episode = 1, options = {}) {
    const isSeriesLike = type === 'tv' || type === 'series' || type === 'anime' || options?.isSeries === true;
    if (typeof fileData === 'string') {
        // A single string on a tv-series page is usually CinemaCity's default S01E01 payload.
        // Do not reuse it for other episodes: better return no CinemaCity result than a wrong episode.
        return isSeriesLike ? null : fileData;
    }

    const episodeCandidates = numberCandidates([
        episode,
        ...(Array.isArray(options?.episodeCandidates) ? options.episodeCandidates : []),
        options?.rawEpisodeNumber
    ]);
    const seasonCandidates = numberCandidates([
        season,
        ...(Array.isArray(options?.seasonCandidates) ? options.seasonCandidates : []),
        ...(isSeriesLike ? [] : [1])
    ]);

    if (Array.isArray(fileData)) {
        if (
            type === 'movie'
            || fileData.every((e) => e && typeof e === 'object' && 'file' in e && !('folder' in e))
        ) {
            if (type === 'movie') return fileData[0]?.file || null;
            const pickedEpisode = pickEpisodeFromFolder(fileData, episodeCandidates.length ? episodeCandidates : [1]);
            return pickedEpisode || null;
        }

        const seasonEntries = fileData
            .filter((e) => e && typeof e === 'object' && Array.isArray(e.folder))
            .map((e, index) => ({ entry: e, index, seasonNumber: extractSeasonNumberFromTitle(e.title) }));

        if (seasonEntries.length === 0) return null;

        const selectedSeasonEntries = [];
        for (const wantedSeason of seasonCandidates) {
            const exactSeasonMatch = seasonEntries.find((e) => e.seasonNumber === wantedSeason);
            if (exactSeasonMatch) selectedSeasonEntries.push(exactSeasonMatch);
        }

        const hasExplicitSeasonNumbers = seasonEntries.some((e) => Number.isInteger(e.seasonNumber));
        if (selectedSeasonEntries.length === 0 && !hasExplicitSeasonNumbers) {
            for (const wantedSeason of seasonCandidates) {
                const byIndex = seasonEntries[wantedSeason - 1] || null;
                if (byIndex) selectedSeasonEntries.push(byIndex);
            }
        }

        if (options?.looseAnime === true) {
            for (const seasonEntry of seasonEntries) {
                if (!selectedSeasonEntries.includes(seasonEntry)) selectedSeasonEntries.push(seasonEntry);
            }
        }

        for (const seasonEntry of selectedSeasonEntries) {
            const picked = pickEpisodeFromFolder(seasonEntry.entry.folder, episodeCandidates.length ? episodeCandidates : [1]);
            if (picked) return picked;
        }

        const rawEpisodeNumber = normalizeEpisodeNumber(options?.rawEpisodeNumber);
        if (rawEpisodeNumber && options?.looseAnime === true) {
            const flat = flattenSeasonEpisodes(seasonEntries);
            const byAbsoluteIndex = flat[rawEpisodeNumber - 1]?.file || null;
            if (byAbsoluteIndex) return byAbsoluteIndex;
        }
    }
    return null;
}

function extractJsonArray(decoded) {
    let start = decoded.indexOf('file:');
    if (start === -1) start = decoded.indexOf('sources:');
    if (start === -1) return null;
    start = decoded.indexOf('[', start);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < decoded.length; i += 1) {
        if (decoded[i] === '[') depth += 1;
        else if (decoded[i] === ']') depth -= 1;
        if (depth === 0) return decoded.substring(start, i + 1);
    }
    return null;
}

function resolveUrl(baseUrl, relativeOrAbsoluteUrl) {
    if (!relativeOrAbsoluteUrl) return null;
    try { return new URL(relativeOrAbsoluteUrl, baseUrl).toString(); } catch (_) { return relativeOrAbsoluteUrl; }
}

function getOrigin(url) {
    try { return new URL(url).origin; } catch (_) { return BASE_URL; }
}

function extractPlayerReferer(html, pageUrl) {
    const $ = loadHtml(html);
    const src = $('iframe[src*="player.php"]').first().attr('src') || '';
    return src ? resolveUrl(pageUrl, src) : pageUrl;
}

async function parseCinemaCityStream(pageUrl, meta = {}) {
    const html = await fetchHtml(pageUrl, {
        'Referer': `${BASE_URL}/`,
        'Cookie': getCinemaCitySessionCookie(),
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1'
    }, { timeout: 6000, attempts: 1 });

    if (!html) {
        logCinemaCityDebug('parse: html missing', { pageUrl });
        return null;
    }

    const pageMetadata = parseCinemaCityPageMetadata(html, pageUrl);
    pageMetadataCache.set(normalizeRemoteUrl(pageUrl), pageMetadata);
    const playerReferer = extractPlayerReferer(html, pageUrl);

    const atobRegex = /atob\s*\(\s*['"](.*?)['"]\s*\)/gi;
    let match;
    let fileData = null;
    let atobMatches = 0;
    let atobDecoded = 0;
    const decodedSamples = [];

    while ((match = atobRegex.exec(html)) !== null) {
        atobMatches += 1;
        const encoded = match[1];
        if (!encoded || encoded.length < 50) continue;
        let decoded = '';
        try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch (_) { continue; }
        if (!decoded) continue;
        atobDecoded += 1;
        if (decodedSamples.length < 4) {
            decodedSamples.push({
                len: decoded.length,
                full: decoded.replace(/\s+/g, ' ')
            });
        }

        if (decoded.trim().startsWith('[')) {
            try { fileData = JSON.parse(decoded); } catch (_) {}
        }
        if (!fileData) {
            const rawJson = extractJsonArray(decoded);
            if (rawJson) {
                try { fileData = JSON.parse(rawJson.replace(/\\(.)/g, '$1')); }
                catch (_) { try { fileData = JSON.parse(rawJson); } catch (_) {} }
            }
        }
        if (!fileData) {
            const fileMatch = decoded.match(/(?:file|sources)\s*:\s*['"](.*?)['"]/i);
            if (fileMatch && (fileMatch[1].includes('.m3u8') || fileMatch[1].includes('.mp4'))) {
                fileData = fileMatch[1];
            }
        }
        // Playerjs new format: file:'[{"title":"...","file":"https:\/\/..."}]' (single-quote wrapper)
        if (!fileData) {
            const arrayMatch = decoded.match(/(?:file|sources)\s*:\s*'(\[[\s\S]+?\])'/i);
            if (arrayMatch) {
                try { fileData = JSON.parse(arrayMatch[1]); }
                catch (_) {
                    try { fileData = JSON.parse(arrayMatch[1].replace(/\\(.)/g, '$1')); }
                    catch (_) {}
                }
            }
        }
        // Last-resort: any .m3u8 / .mp4 URL inside the decoded script (handles \/ escapes)
        if (!fileData) {
            const urlMatch = decoded.match(/(https?:[\\\/]+[^"'\s]+?\.(?:m3u8|mp4)(?:[?#][^"'\s]*)?)/i);
            if (urlMatch) {
                fileData = urlMatch[1].replace(/\\\//g, '/');
            }
        }
        if (fileData) break;
    }

    if (!fileData) {
        const playerjsBlockMatch = html.match(/<div[^>]+id=["']playerjs[^"']*["'][^>]*>[\s\S]{0,400}/i)
            || html.match(/playerjs-\d+[^<]{0,400}/i);
        const dataConfigMatches = [...html.matchAll(/data-(?:config|file|src|source|video|stream|playerjs)\s*=\s*["']([^"']{8,400})["']/gi)]
            .slice(0, 4)
            .map((m) => ({ attr: m[0].slice(0, m[0].indexOf('='))?.trim(), value: m[1].slice(0, 200) }));
        const m3u8Hits = [...html.matchAll(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi)].slice(0, 3).map((m) => m[1].slice(0, 200));
        const mp4Hits = [...html.matchAll(/(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/gi)].slice(0, 3).map((m) => m[1].slice(0, 200));
        const fetchHits = [...html.matchAll(/(?:fetch|axios|XMLHttpRequest|\.ajax|\.open)\s*\(\s*["']?(\/[^"'\s)]+|https?:\/\/[^"'\s)]+)/gi)].slice(0, 5).map((m) => m[1].slice(0, 200));
        const dleHash = (html.match(/dle_(?:root|movie|player|file)[^<\n]{0,200}/i) || [])[0] || '';
        logCinemaCityDebug('parse: fileData missing', {
            pageUrl,
            htmlBytes: html.length,
            atobMatches,
            atobDecoded,
            decodedSamples,
            hasPlayerIframe: /<iframe[^>]+(player|embed|stream)/i.test(html),
            hasJwplayer: /jwplayer\(|jwPlayer/.test(html),
            hasPlayerjs: /\bPlayerjs\b|new\s+Playerjs|window\.Playerjs|playerjs-\d/.test(html),
            hasFileSources: /(?:file|sources)\s*:\s*['"]/.test(html),
            hasEvalAtob: /eval\s*\(\s*atob/i.test(html),
            hasDleFile: /dle_root|dle_movie|dle-player|dle_player/i.test(html),
            hasCcEmbed: /cinemacity\.cc\/[a-z0-9_-]+\/embed|\/get_files\b|\/player\//i.test(html),
            playerjsBlock: playerjsBlockMatch ? String(playerjsBlockMatch[0] || '').replace(/\s+/g, ' ') : '',
            dataConfigMatches,
            m3u8Hits,
            mp4Hits,
            fetchHits,
            dleHash
        });
        return null;
    }

    const streamUrl = resolveUrl(
        pageUrl,
        pickStream(fileData, meta?.isSeries || meta?.providerType === 'tv' || meta?.providerType === 'anime' ? 'tv' : 'movie', meta?.season || 1, meta?.episode || 1, {
            rawEpisodeNumber: meta?.rawEpisodeNumber,
            episodeCandidates: Array.isArray(meta?.episodeCandidates) ? meta.episodeCandidates : [],
            looseAnime: meta?.providerType === 'anime' || meta?.isAnime === true,
            isSeries: meta?.isSeries === true || meta?.providerType === 'tv' || meta?.providerType === 'anime'
        })
    );
    if (!streamUrl) {
        logCinemaCityDebug('parse: streamUrl missing after pickStream', {
            pageUrl,
            fileDataType: typeof fileData,
            fileDataLen: Array.isArray(fileData) ? fileData.length : (typeof fileData === 'string' ? fileData.length : 0)
        });
        return null;
    }
    logCinemaCityDebug('parse: stream extracted', { pageUrl, streamUrl: streamUrl.slice(0, 160) });

    const streamContext = /\.m3u8($|\?)/i.test(streamUrl) ? 'hls' : 'media';
    const { headers: streamHeaders } = buildCinemaCityRequestHeaders(streamUrl, streamContext, {
        'Referer': playerReferer,
        'Origin': getOrigin(pageUrl)
    }, getCinemaCitySessionCookie());

    return {
        streamUrl,
        pageMetadata,
        headers: streamHeaders
    };
}

async function getParsedCinemaCityStream(pageUrl, meta = {}) {
    const normalizedUrl = normalizeRemoteUrl(pageUrl);
    if (!normalizedUrl) return null;

    const cacheKey = `stream-result:${normalizedUrl}:${meta?.season || 1}:${meta?.episode || 1}:${meta?.rawEpisodeNumber || ''}:${(meta?.episodeCandidates || []).join(',')}`;

    if (streamResultCache.has(cacheKey)) {
        return streamResultCache.get(cacheKey);
    }

    return singleFlight(cacheKey, async () => {
        if (streamResultCache.has(cacheKey)) {
            return streamResultCache.get(cacheKey);
        }

        const result = await parseCinemaCityStream(pageUrl, meta);
        streamResultCache.set(cacheKey, result || null);
        return result || null;
    });
}

function mergePlaylistIntelligenceIntoPageMetadata(pageMetadata = {}, playlistIntel = null) {
    if (!playlistIntel || typeof playlistIntel !== 'object') return pageMetadata;
    if (playlistIntel?.audioLanguages?.length) {
        pageMetadata.audioLanguages = Array.from(new Set([...(pageMetadata.audioLanguages || []), ...playlistIntel.audioLanguages]));
        pageMetadata.isMultiAudio = pageMetadata.audioLanguages.length > 1;
    }
    if (playlistIntel?.subtitleLanguages?.length) {
        pageMetadata.subtitleLanguages = Array.from(new Set([...(pageMetadata.subtitleLanguages || []), ...playlistIntel.subtitleLanguages]));
    }
    return pageMetadata;
}

function pageNeedsPlaylistProbeForStrictLanguage(pageMetadata = {}, config = {}) {
    if (!isStrictSingleLanguageMode(config)) return false;
    const known = normalizeLanguageList([
        ...(Array.isArray(pageMetadata.audioLanguages) ? pageMetadata.audioLanguages : []),
        ...(Array.isArray(pageMetadata.downloadLanguages) ? pageMetadata.downloadLanguages : [])
    ]);
    return known.length === 0;
}

async function runPlaylistIntelligenceProbe(streamUrl, headers = {}, timeoutMs = QUALITY_PROBE_FAST_TIMEOUT_MS) {
    const intelligence = await probePlaylistIntelligence(httpClient, streamUrl, {
        headers,
        timeout: timeoutMs
    });
    const detected = intelligence?.quality || 'Unknown';
    return { detected, intelligence: intelligence || null };
}

function warmPlaylistIntelligenceCache(qualityCacheKey, streamUrl, headers = {}) {
    // Fire-and-cache only: the current Stremio response must not wait for this unless
    // strict language filtering has no other proof. Later opens reuse the enriched cache.
    singleFlight(qualityCacheKey, async () => {
        const alreadyCached = qualityProbeCache.get(qualityCacheKey);
        if (alreadyCached) return { detected: alreadyCached.value, intelligence: alreadyCached.intelligence || null };
        const result = await runPlaylistIntelligenceProbe(streamUrl, headers, QUALITY_PROBE_FAST_TIMEOUT_MS);
        qualityProbeCache.set(qualityCacheKey, { value: result.detected, intelligence: result.intelligence || null });
        return result;
    }).catch(() => null);
}

function buildDisplayTitle(meta = {}, fallbackTitle, season, episode) {
    const baseTitle = decodeHtmlEntities(
        meta?.title || meta?.name || meta?.originalTitle || fallbackTitle || 'CinemaCity'
    )
        .replace(/\s*\((.*?)\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (meta?.isSeries) {
        return `${baseTitle} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    }
    return baseTitle;
}


function buildCinemaCityMediaflowUrl(config = {}, streamUrl, headers = {}, isHls = false) {
    const normalizedTarget = normalizeRemoteUrl(streamUrl);
    if (!getMediaflowBase(config) || !normalizedTarget) return null;

    const proxyHeaders = {};
    if (headers?.Referer || headers?.referer) proxyHeaders.Referer = headers.Referer || headers.referer;
    if (headers?.Origin || headers?.origin) proxyHeaders.Origin = headers.Origin || headers.origin;

    const proxied = buildMediaflowGatewayProxyUrl(config, normalizedTarget, proxyHeaders, {
        isHls: Boolean(isHls),
        allowCookie: false
    });
    return proxied && proxied !== normalizedTarget ? proxied : null;
}

function buildCinemaCityEpisodePageUrl(pageUrl, season, episode) {
    const normalized = normalizeRemoteUrl(pageUrl);
    if (!normalized) return null;
    try {
        const url = new URL(normalized);
        url.hash = '';
        url.searchParams.set('s', String(Math.max(1, Number.parseInt(String(season || 1), 10) || 1)));
        url.searchParams.set('e', String(Math.max(1, Number.parseInt(String(episode || 1), 10) || 1)));
        return url.toString();
    } catch (_) {
        const separator = normalized.includes('?') ? '&' : '?';
        return `${normalized.replace(/#.*$/, '')}${separator}s=${encodeURIComponent(String(season || 1))}&e=${encodeURIComponent(String(episode || 1))}`;
    }
}

function deriveCinemaCityExtractorBase(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        parsed.hash = '';
        parsed.search = '';
        parsed.pathname = parsed.pathname.replace(/\/forward\/?$/i, '').replace(/\/+$/g, '');
        return parsed.toString().replace(/\/+$/g, '');
    } catch (_) {
        return raw
            .replace(/[?#].*$/g, '')
            .replace(/\/forward\/?$/i, '')
            .replace(/\/+$/g, '');
    }
}

function getCinemaCityPageExtractorBase(config = {}) {
    return getMediaflowBase(config)
        || String(process.env.CINEMACITY_PAGE_EXTRACTOR_BASE || '').trim().replace(/\/+$/g, '')
        || String(process.env.CINEMACITY_KRAKEN_EXTRACTOR_URL || '').trim().replace(/\/+$/g, '')
        || String(process.env.KRAKEN_PROXY_URL || '').trim().replace(/\/+$/g, '')
        || String(process.env.MEDIAFLOW_PROXY_URL || process.env.MEDIAFLOW_URL || '').trim().replace(/\/+$/g, '')
        || deriveCinemaCityExtractorBase(CINEMACITY_KRAKEN_FORWARD_URL);
}

function buildCinemaCityPageExtractorUrl(config = {}, pageUrl, season, episode, options = {}) {
    const targetPage = options?.isSeries === false
        ? normalizeRemoteUrl(pageUrl)
        : buildCinemaCityEpisodePageUrl(pageUrl, season, episode);
    const extractorBase = getCinemaCityPageExtractorBase(config);
    if (!extractorBase || !targetPage) return null;

    const extractorConfig = getMediaflowBase(config)
        ? config
        : {
            ...config,
            mediaflow: {
                ...(config?.mediaflow || {}),
                url: extractorBase
            }
        };

    // Kraken/MediaFlow receives only the target page URL here. Pass browser-like
    // context as explicit extractor headers so the CinemaCity resolver is not invoked
    // as a naked bot request. The cookie is intentionally omitted: a Cloudflare
    // clearance is IP/UA scoped and a cookie solved by Leviathan is often invalid
    // when Kraken resolves through its own egress/WARP.
    const { headers: extractorContextHeaders } = buildCinemaCityRequestHeaders(targetPage, 'document', {
        'Referer': `${BASE_URL}/`,
        'Origin': BASE_URL
    }, '');
    const extractorHeaders = {
        'User-Agent': extractorContextHeaders['User-Agent'],
        'Referer': extractorContextHeaders.Referer || `${BASE_URL}/`,
        'Origin': extractorContextHeaders.Origin || BASE_URL,
        'Accept-Language': extractorContextHeaders['Accept-Language']
    };

    const proxied = buildMediaflowGatewayExtractorUrl(extractorConfig, targetPage, CINEMACITY_PAGE_EXTRACTOR_HOST, {
        // CinemaCity behaves like the working EasyProxy integration: expose the
        // resolver as an HLS manifest endpoint, never as a generic /extractor/video
        // raw Direct URL. The public extractor label is CCCDN; host is configurable.
        extractorPath: process.env.CINEMACITY_PAGE_EXTRACTOR_PATH || '/extractor/video.m3u8',
        redirectStream: true,
        headers: extractorHeaders
    });
    return proxied && proxied !== targetPage ? proxied : null;
}

function shouldPreferCinemaCityLocalProxy(isSeriesRequest) {
    return Boolean(isSeriesRequest && CINEMACITY_SERIES_FORCE_CCDN);
}

function isLikelyCinemaCityMediaUrl(rawUrl = '') {
    const value = String(rawUrl || '').trim();
    if (!value) return false;
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname.toLowerCase();
        const full = `${host}${path}`;
        if (/\.(?:m3u8|mp4|mkv|webm|mov|m4v)(?:$|[?#])/i.test(value)) return true;
        if (/(?:cccdn|ccddn|cdn|hls|stream|video|playlist|master)/i.test(full)) return true;
        return false;
    } catch (_) {
        return /\.(?:m3u8|mp4|mkv|webm|mov|m4v)(?:$|[?#])/i.test(value)
            || /(?:cccdn|ccddn|cdn|hls|stream|video|playlist|master)/i.test(value);
    }
}

function buildCinemaCityPageExtractorStream(pageExtractorUrl, {
    enrichedMeta = {},
    basePageMetadata = {},
    searchResult = {},
    resolved = {},
    targetPageUrl = '',
    config = {},
    addonBase = null
} = {}) {
    if (!pageExtractorUrl) return null;
    const displayTitle = buildDisplayTitle(enrichedMeta, basePageMetadata.title || searchResult.title, resolved.season, resolved.episode);
    const languageLabel = buildCinemaCityLanguageLabel(basePageMetadata, config);
    return buildWebStream({
        name: `ðŸŽŸï¸  CinemaCity | ${CINEMACITY_PAGE_EXTRACTOR_LABEL}`,
        title: `${displayTitle}\nâ˜ ï¸  ${CINEMACITY_PAGE_EXTRACTOR_LABEL} â€¢ ${languageLabel}`,
        url: pageExtractorUrl,
        extractor: CINEMACITY_PAGE_EXTRACTOR_LABEL,
        provider: 'CinemaCity',
        providerCode: 'CC',
        quality: normalizeQuality(basePageMetadata.quality || '1080p'),
        headers: null,
        mediaflowUrl: getCinemaCityPageExtractorBase(config),
        addonBase,
        notWebReady: false,
        extra: {
            // Helps downstream UI layers avoid presenting this as a naked Direct stream.
            deliveryMode: 'Proxy',
            streamType: 'hls'
        },
        extraBehaviorHints: {
            deliveryMode: 'Proxy',
            bingeWatching: true,
            vortexMeta: {
                pageTitle: basePageMetadata.title || '',
                imdbId: basePageMetadata.imdbId || resolved.imdbId || '',
                tmdbId: basePageMetadata.tmdbId || resolved.tmdbId || '',
                qualityTag: basePageMetadata.qualityTag || '',
                audioLanguages: Array.isArray(basePageMetadata.audioLanguages) ? basePageMetadata.audioLanguages : [],
                subtitleLanguages: Array.isArray(basePageMetadata.subtitleLanguages) ? basePageMetadata.subtitleLanguages : [],
                genres: Array.isArray(basePageMetadata.genres) ? basePageMetadata.genres : [],
                isMultiAudio: basePageMetadata.isMultiAudio === true,
                isAnime: basePageMetadata.isAnime === true,
                requestedSeason: resolved.season,
                requestedEpisode: resolved.episode,
                targetPageUrl
            }
        }
    });
}

async function searchCinemaCityImpl(originalId, finalId, meta, config = {}, reqHost = null) {
    try {
        const resolved = await resolveSearchState(meta, originalId, finalId, config);
        if (!resolved.imdbId && !resolved.tmdbId && (!resolved.isAnime || resolved.searchTitles.length === 0)) return [];

        const titleFallbackOptions = {
            expectedTitles: uniqueStrings([
                ...(Array.isArray(resolved.searchTitles) ? resolved.searchTitles : []),
                ...(Array.isArray(resolved.rawTitles) ? resolved.rawTitles : [])
            ]),
            requestedImdbId: resolved.imdbId,
            expectedYear: resolved.expectedYear,
            fast: config?.filters?.cinemacityFast !== false
        };

        let searchResult = null;
        searchResult = await searchByTitleFallback(
            resolved.tmdbId || resolved.imdbId || originalId,
            resolved.providerType, meta, titleFallbackOptions
        );
        if (!searchResult?.url && resolved.imdbId) {
            searchResult = await searchByImdb(resolved.imdbId);
        }
        if (!searchResult?.url) {
            const diagnosticTitles = uniqueStrings([
                ...(Array.isArray(titleFallbackOptions.expectedTitles) ? titleFallbackOptions.expectedTitles : []),
                ...(Array.isArray(resolved.searchTitles) ? resolved.searchTitles : []),
                ...(Array.isArray(resolved.rawTitles) ? resolved.rawTitles : []),
                ...collectMetaTitles(meta)
            ]);
            logCinemaCityDebug('locator final miss', { providerType: resolved.providerType, imdbId: resolved.imdbId, tmdbId: resolved.tmdbId, titles: diagnosticTitles.slice(0, 5) });
            return [];
        }
        logCinemaCityDebug('locator selected page', { providerType: resolved.providerType, url: searchResult.url, title: searchResult.title });

        const isSeriesRequest = resolved.providerType === 'tv' || resolved.providerType === 'anime';
        const targetPageUrl = isSeriesRequest
            ? buildCinemaCityEpisodePageUrl(searchResult.url, resolved.season, resolved.episode)
            : searchResult.url;
        const enrichedMeta = {
            ...meta,
            isSeries: isSeriesRequest || meta?.isSeries === true,
            season: resolved.season,
            episode: resolved.episode,
            rawEpisodeNumber: resolved.rawEpisodeNumber,
            episodeCandidates: resolved.episodeCandidates,
            providerType: resolved.providerType
        };

        const pageExtractorUrl = buildCinemaCityPageExtractorUrl(config, searchResult.url, resolved.season, resolved.episode, {
            isSeries: isSeriesRequest
        });
        const basePageMetadataForSeries = isSeriesRequest && pageExtractorUrl
            ? (await fetchCinemaCityPageMetadata(searchResult.url).catch(() => null) || {})
            : {};

        if (
            pageExtractorUrl
            && CINEMACITY_SERIES_PAGE_EXTRACTOR_PRIMARY
            && isSeriesRequest
            && !shouldPreferCinemaCityLocalProxy(isSeriesRequest)
        ) {
            const cityExtractorStream = buildCinemaCityPageExtractorStream(pageExtractorUrl, {
                enrichedMeta,
                basePageMetadata: basePageMetadataForSeries,
                searchResult,
                resolved,
                targetPageUrl,
                config,
                addonBase: reqHost
            });
            const streams = cityExtractorStream ? [cityExtractorStream] : [];
            return normalizeStreams(hardFilterStreamsByLanguage(dedupeStreamsByUrl(streams), config), { provider: 'cinemacity' });
        }

        if (!isSeriesRequest && pageExtractorUrl && CINEMACITY_MOVIE_PAGE_EXTRACTOR_PRIMARY) {
            const moviePageMetadata = CINEMACITY_FORCE_CLEARANCE_BEFORE_SEARCH
                ? { title: searchResult.title || '', quality: '1080p' }
                : (await fetchCinemaCityPageMetadata(targetPageUrl || searchResult.url).catch(() => null) || {});
            const cityExtractorStream = buildCinemaCityPageExtractorStream(pageExtractorUrl, {
                enrichedMeta,
                basePageMetadata: moviePageMetadata,
                searchResult,
                resolved,
                targetPageUrl,
                config,
                addonBase: reqHost
            });
            const streams = cityExtractorStream ? [cityExtractorStream] : [];
            return normalizeStreams(hardFilterStreamsByLanguage(dedupeStreamsByUrl(streams), config), {
                provider: 'cinemacity',
                providerLabel: 'CinemaCity',
                providerCode: 'CC'
            });
        }

        const extracted = await getParsedCinemaCityStream(targetPageUrl || searchResult.url, enrichedMeta);
        if (!extracted?.streamUrl || (isSeriesRequest && !isLikelyCinemaCityMediaUrl(extracted.streamUrl))) {
            if (pageExtractorUrl) {
                const cityExtractorStream = buildCinemaCityPageExtractorStream(pageExtractorUrl, {
                    enrichedMeta,
                    basePageMetadata: basePageMetadataForSeries,
                    searchResult,
                    resolved,
                    targetPageUrl,
                    config,
                    addonBase: reqHost
                });
                const streams = cityExtractorStream ? [cityExtractorStream] : [];
                if (streams.length) {
                    logCinemaCityDebug('local stream unavailable; using CCCDN extractor fallback', {
                        page: targetPageUrl || searchResult.url,
                        streamUrl: extracted?.streamUrl || '',
                        providerType: resolved.providerType,
                        season: resolved.season,
                        episode: resolved.episode
                    });
                    return normalizeStreams(hardFilterStreamsByLanguage(dedupeStreamsByUrl(streams), config), { provider: 'cinemacity' });
                }
            }
            if (isSeriesRequest && (config?.debug || process.env.DEBUG_CINEMACITY === '1' || process.env.DEBUG_CINEMACITY_EPISODE === '1')) {
                console.warn(`[CinemaCity] Skip diretto serie: pagina=${targetPageUrl || searchResult.url} S=${resolved.season} E=${resolved.episode} non espone uno stream episodio sicuro. Configura MediaFlow/Kraken cccdn extractor per le serie.`);
            }
            return [];
        }

        const pageMetadata = extracted.pageMetadata || {};
        let quality = normalizeQuality(pageMetadata.quality || '1080p');
        let playlistIntel = null;
        if (/\.m3u8($|\?)/i.test(extracted.streamUrl)) {
            try {
                const qualityCacheKey = `quality:${normalizeRemoteUrl(extracted.streamUrl)}`;
                const cachedQuality = qualityProbeCache.get(qualityCacheKey);
                const mustWaitForLanguageProof = pageNeedsPlaylistProbeForStrictLanguage(pageMetadata, config);

                if (cachedQuality) {
                    playlistIntel = cachedQuality?.intelligence || null;
                    quality = pickBetterQuality(cachedQuality.value || 'Unknown', quality);
                    mergePlaylistIntelligenceIntoPageMetadata(pageMetadata, playlistIntel);
                } else if (FAST_PLAYBACK_MODE && !mustWaitForLanguageProof) {
                    warmPlaylistIntelligenceCache(qualityCacheKey, extracted.streamUrl, extracted.headers);
                } else {
                    const result = await singleFlight(qualityCacheKey, async () => {
                        const alreadyCached = qualityProbeCache.get(qualityCacheKey);
                        if (alreadyCached) return { detected: alreadyCached.value, intelligence: alreadyCached.intelligence || null };
                        const probed = await runPlaylistIntelligenceProbe(
                            extracted.streamUrl,
                            extracted.headers,
                            FAST_PLAYBACK_MODE ? QUALITY_PROBE_FAST_TIMEOUT_MS : QUALITY_PROBE_FULL_TIMEOUT_MS
                        );
                        qualityProbeCache.set(qualityCacheKey, { value: probed.detected, intelligence: probed.intelligence || null });
                        return probed;
                    });
                    playlistIntel = result?.intelligence || null;
                    quality = pickBetterQuality(result?.detected || 'Unknown', quality);
                    mergePlaylistIntelligenceIntoPageMetadata(pageMetadata, playlistIntel);
                }
            } catch (_) {}
        }

        if (!pageHasRequestedAudio(pageMetadata, config)) {
            if (config?.debug || process.env.DEBUG_CINEMACITY === '1') {
                console.warn(buildLanguageRejectReason(pageMetadata, config));
            }
            return [];
        }
        if (streamUrlHasForbiddenLanguage(extracted.streamUrl, config)) {
            if (config?.debug || process.env.DEBUG_CINEMACITY === '1') {
                console.warn('[CinemaCity] Skip stream URL non-ITA strict:', extracted.streamUrl);
            }
            return [];
        }

        const isHlsStream = /\.m3u8($|\?)/i.test(extracted.streamUrl);
        const extractorLabel = /cc(?:c|d)dn/i.test(extracted.streamUrl) ? 'CCCDN' : (isHlsStream ? 'HLS' : 'Direct');
        const displayTitle = buildDisplayTitle(enrichedMeta, pageMetadata.title || searchResult.title, resolved.season, resolved.episode);
        const languageLabel = buildCinemaCityLanguageLabel(pageMetadata, config);
        const localCinemaCityProxyUrl = buildCinemaCityProxyUrl(extracted.streamUrl, extracted.headers, reqHost, { isHls: isHlsStream, providerType: resolved.providerType, season: resolved.season, episode: resolved.episode, rawEpisodeNumber: resolved.rawEpisodeNumber, pageUrl: targetPageUrl || searchResult.url });
        const mediaflowProxyUrl = buildCinemaCityMediaflowUrl(config, extracted.streamUrl, extracted.headers, isHlsStream);
        const preferLocalProxy = shouldPreferCinemaCityLocalProxy(isSeriesRequest);
        const cinemaCityUrl = preferLocalProxy
            ? (localCinemaCityProxyUrl || mediaflowProxyUrl)
            : (mediaflowProxyUrl || localCinemaCityProxyUrl);
        if (localCinemaCityProxyUrl) {
            prewarmCinemaCityPlayback(extracted.streamUrl, extracted.headers, reqHost, { isHls: isHlsStream });
        }
        const cinemaCityMode = cinemaCityUrl === mediaflowProxyUrl ? 'MFP' : 'CCCDN';
        const extraVortexMeta = {
            bingeWatching: true,
            vortexMeta: {
                pageTitle: pageMetadata.title || '',
                imdbId: pageMetadata.imdbId || resolved.imdbId || '',
                tmdbId: pageMetadata.tmdbId || resolved.tmdbId || '',
                qualityTag: pageMetadata.qualityTag || '',
                audioLanguages: Array.isArray(pageMetadata.audioLanguages) ? pageMetadata.audioLanguages : [],
                subtitleLanguages: Array.isArray(pageMetadata.subtitleLanguages) ? pageMetadata.subtitleLanguages : [],
                genres: Array.isArray(pageMetadata.genres) ? pageMetadata.genres : [],
                isMultiAudio: pageMetadata.isMultiAudio === true,
                isAnime: pageMetadata.isAnime === true
            }
        };

        const streams = [];
        if (cinemaCityUrl) {
            streams.push(decorateStreamWithPlaylistIntelligence(buildWebStream({
                name: `ðŸŽŸï¸  CinemaCity | ${cinemaCityMode}`,
                title: `${displayTitle}\nâ˜ ï¸  ${cinemaCityMode} â€¢ ${languageLabel}`,
                url: cinemaCityUrl,
                extractor: cinemaCityMode,
                provider: 'CinemaCity',
                providerCode: 'CC',
                quality,
                headers: null,
                mediaflowUrl: getMediaflowBase(config),
                addonBase: reqHost,
                notWebReady: false,
                extraBehaviorHints: extraVortexMeta
            }), playlistIntel));
        }

        // Serie CinemaCity: se il CDN locale risponde ma il player non parte, offri anche
        // il percorso CCCDN/MFP come backup esplicito. Prima lo usavamo solo quando
        // l'estrazione locale falliva; cosÃ¬ su Stremio/Android hai una seconda strada
        // cliccabile senza perdere il CCCDN principale.
        if (isSeriesRequest && pageExtractorUrl && cinemaCityUrl && cinemaCityUrl === localCinemaCityProxyUrl) {
            const cityFallbackStream = buildCinemaCityPageExtractorStream(pageExtractorUrl, {
                enrichedMeta,
                basePageMetadata: basePageMetadataForSeries || pageMetadata,
                searchResult,
                resolved,
                targetPageUrl,
                config,
                addonBase: reqHost
            });
            if (cityFallbackStream) {
                cityFallbackStream.name = 'ðŸŽŸï¸  CinemaCity | CCCDN fallback';
                cityFallbackStream.title = `${displayTitle}\nâ˜ ï¸  CCCDN fallback â€¢ ${languageLabel}`;
                cityFallbackStream.extractor = CINEMACITY_PAGE_EXTRACTOR_LABEL;
                cityFallbackStream.host = CINEMACITY_PAGE_EXTRACTOR_LABEL;
                if (cityFallbackStream.behaviorHints) {
                    cityFallbackStream.behaviorHints.extractor = CINEMACITY_PAGE_EXTRACTOR_LABEL;
                    cityFallbackStream.behaviorHints.vortexExtractor = CINEMACITY_PAGE_EXTRACTOR_LABEL;
                }
                streams.push(cityFallbackStream);
            }
        }

        if (streams.length === 0) {
            const cityFallbackStream = pageExtractorUrl ? buildCinemaCityPageExtractorStream(pageExtractorUrl, {
                enrichedMeta,
                basePageMetadata: pageMetadata,
                searchResult,
                resolved,
                targetPageUrl,
                config,
                addonBase: reqHost
            }) : null;

            if (cityFallbackStream) {
                cityFallbackStream.name = 'ðŸŽŸï¸  CinemaCity | CCCDN fallback';
                cityFallbackStream.title = `${displayTitle}\nâ˜ ï¸  CCCDN fallback â€¢ ${languageLabel}`;
                cityFallbackStream.extractor = CINEMACITY_PAGE_EXTRACTOR_LABEL;
                cityFallbackStream.host = CINEMACITY_PAGE_EXTRACTOR_LABEL;
                if (cityFallbackStream.behaviorHints) {
                    cityFallbackStream.behaviorHints.extractor = CINEMACITY_PAGE_EXTRACTOR_LABEL;
                    cityFallbackStream.behaviorHints.vortexExtractor = CINEMACITY_PAGE_EXTRACTOR_LABEL;
                    cityFallbackStream.behaviorHints.notWebReady = false;
                }
                streams.push(cityFallbackStream);
                logCinemaCityDebug('raw direct suppressed; using CCCDN extractor fallback', {
                    page: targetPageUrl || searchResult.url,
                    streamHost: safeHostname(extracted.streamUrl),
                    extractor: extractorLabel
                });
            } else if (envFlag('CINEMACITY_ALLOW_RAW_DIRECT', false)) {
                streams.push(decorateStreamWithPlaylistIntelligence(buildWebStream({
                    name: 'ðŸŽŸï¸  CinemaCity | Direct',
                    title: `${displayTitle}\nâ˜ ï¸  ${extractorLabel} â€¢ ${languageLabel}`,
                    url: extracted.streamUrl,
                    extractor: extractorLabel,
                    provider: 'CinemaCity',
                    providerCode: 'CC',
                    quality,
                    headers: extracted.headers,
                    mediaflowUrl: getMediaflowBase(config),
                    addonBase: reqHost,
                    notWebReady: true,
                    extraBehaviorHints: extraVortexMeta
                }), playlistIntel));
            }
        }

        if (config?.debug || process.env.DEBUG_CINEMACITY === '1' || process.env.DEBUG_CINEMACITY_EPISODE === '1') {
            logCinemaCityDebug('stream output', {
                providerType: resolved.providerType,
                season: resolved.season,
                episode: resolved.episode,
                mode: cinemaCityMode,
                hasLocalProxy: Boolean(localCinemaCityProxyUrl),
                hasMediaflowProxy: Boolean(mediaflowProxyUrl),
                hasCccdnFallback: Boolean(pageExtractorUrl && streams.some((s) => /CCCDN/i.test(String(s?.name || s?.extractor || '')))),
                count: streams.length
            });
        }

        const filteredStreams = hardFilterStreamsByLanguage(dedupeStreamsByUrl(streams), config);
        return normalizeStreams(filteredStreams, {
            provider: 'cinemacity',
            providerLabel: 'CinemaCity',
            providerCode: 'CC',
            sort: false,
            debug: config?.debug === true
        }).sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    } catch (error) {
        console.error('[CinemaCity] Error:', error.message);
        return [];
    }
}

async function searchCinemaCity(originalId, finalId, meta, config = {}, reqHost = null) {
    return withProviderHealth('cinemacity', () => searchCinemaCityImpl(originalId, finalId, meta, config, reqHost), {
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = {
    searchCinemaCity,
    __private: {
        looksLikeAnimeMeta,
        isCinemaCityContentUrlForType,
        extractCandidateLinksFromListing,
        buildSearchQueryVariants,
        titleFromContentUrl,
        scoreTitleMatch,
        titleAliasesFromOneTitle,
        getListingBaseUrls,
        pickStream,
        buildCinemaCityEpisodePageUrl,
        buildCinemaCityPageExtractorUrl,
        shouldPreferCinemaCityLocalProxy,
        isLikelyCinemaCityMediaUrl,
        parseCinemaCityPageMetadata,
        extractDownloadLanguagesFromPage,
        buildCinemaCityLanguageLabel,
        runCinemaCityBackgroundClearance,
        startCinemaCityBackgroundClearanceDaemon,
        cinemaCityBackgroundClearanceState,
        normalizeLanguageToken,
        normalizeLanguageList,
        getWantedLanguage,
        isStrictSingleLanguageMode,
        pageHasRequestedAudio,
        buildLanguageRejectReason,
        streamUrlHasForbiddenLanguage,
        hardFilterStreamsByLanguage,
        isDeferredCinemaCityExtractorStream,
        buildCinemaCityPageExtractorStream,
        deriveCinemaCityExtractorBase,
        getCinemaCityPageExtractorBase,
        cinemaCityQuickTitleSearchEnabled: CINEMACITY_QUICK_TITLE_SEARCH,
        cinemaCitySearchPostFirstEnabled: CINEMACITY_SEARCH_POST_FIRST
    }
};

startCinemaCityBackgroundClearanceDaemon();
