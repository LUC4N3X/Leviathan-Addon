'use strict';

const { buildWebStream, normalizeRemoteUrl } = require('../extractors/common');
const { createMediaflowGateway, getMediaflowBase, buildMediaflowUrl } = require('../../core/proxy/mediaflow_gateway');
const {
    buildForwardProxyUrl,
    getForwardProxyBase,
    normalizeForwardProxyBase: normalizeSharedForwardProxyBase
} = require('../../core/proxy/forward_proxy_config');
const { isUprotUrl, resolveUprotToMaxstream } = require('../extractors/hosters/uprot');
const { extractMixdrop } = require('../extractors/hosters/mixdrop');
const { extractResilientEmbeds } = require('../extractors/semantic_candidate_extractor');
const { requestWithImpitRotating, isCanceledError } = require('../utils/bypass');
let runCurlCffiBypass = null;
try { ({ runCurlCffiBypass } = require('../utils/cloudflare_bypass')); } catch (_) { runCurlCffiBypass = null; }
let curlCffiRunnerOverride = null;
const {
    buildProviderHtmlHeaders,
    createProviderCache,
    createProviderEnv,
    createProviderLogger,
    normalizeProviderBaseUrl,
    resolveProviderBaseUrls,
    sanitizeLogValue: sanitizeProviderLogValue
} = require('../utils/provider_toolkit');
const { getProviderDomains } = require('../utils/provider_domain_registry');

const DEFAULT_BASE_URLS = Object.freeze(getProviderDomains('cb01', ['https://cb01uno.help']));
const DEFAULT_BASE_URL = DEFAULT_BASE_URLS[0] || 'https://cb01uno.help';
const PROVIDER = 'CB01';
const PROVIDER_CODE = 'CB01';
const ICON = '🎬';
const SEARCH_TTL_FALLBACK_MS = 12_000;
const SAFEGO_FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';


const CB01_CODE_DEFAULTS = Object.freeze({
    CB01_BASE_URL: 'https://cb01uno.bar',
    CB01_BASE_URLS: '',
    CB01_PROVIDER_TIMEOUT: '12000',
    CB01_DEBUG: '1',
    CB01_TRACE: '1',

    CB01_IMPIT_STRATEGY: 'forward-only',
    CB01_USE_PROXY: '0',
    CB01_PROXY_MAX_ATTEMPTS: '0',

    CB01_IMPIT_FORWARD_ENABLED: '1',
    CB01_IMPIT_FORWARD_FALLBACK: '0',

    CB01_IMPIT_DIRECT_FALLBACK: '0',
    CB01_STOP_ON_CHALLENGE: '1',

    CB01_SEARCH_TIMEOUT_MS: '12000',
    CB01_PAGE_TIMEOUT_MS: '12000',
    CB01_SEARCH_TOTAL_BUDGET_MS: '10500',
    CB01_PAGE_TOTAL_BUDGET_MS: '14000',

    CB01_DIRECT_SLUG_FALLBACK: '1',
    CB01_DIRECT_SLUG_MAX_PROBES: '8',
    CB01_DIRECT_MIN_SCORE: '54',

    CB01_IMPIT_PROXY_TIMEOUT_MS: '1',
    CB01_IMPIT_FORWARD_TIMEOUT_MS: '9500',
    CB01_IMPIT_DIRECT_TIMEOUT_MS: '1',
    CB01_IMPIT_MAX_ATTEMPTS_TOTAL: '1',
    CB01_IMPIT_MAX_BROWSER_ATTEMPTS: '1',
    CB01_IMPIT_INNER_RETRY: '0',
    CB01_IMPIT_RETRY_ON_CHALLENGE: '0',
    CB01_IMPIT_HTTP3: '0',
    CB01_IMPIT_BROWSER: 'chrome125',

    CB01_CURL_CFFI_FALLBACK: '1',
    CB01_CURL_CFFI_IMPERSONATE: 'auto',
    CB01_CURL_CFFI_SEARCH_TIMEOUT_MS: '4200',
    CB01_CURL_CFFI_PAGE_TIMEOUT_MS: '5200',
    CB01_CURL_CFFI_MIN_REMAINING_MS: '2600',
    CB01_CURL_CFFI_RETRIES: '0',
    CB01_CURL_CFFI_RETRY_BACKOFF_MS: '0',
    CB01_CURL_CFFI_WARMUP_ORIGIN: '0'
});

const CB_SIMPLE_UAS = Object.freeze([
    DESKTOP_UA,
    SAFEGO_FIREFOX_UA,
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'
]);

const CB_IMPIT_BROWSER_FALLBACKS = Object.freeze(['chrome142', 'chrome136', 'chrome131', 'chrome125', 'firefox144', 'firefox135']);

const CB_DEFAULT_PROXY_LIST = Object.freeze([
    'http://znvmriuj-rotate:bkpzeu8rhr24@p.webshare.io:80',
    'http://pzhhzcks-rotate:sggme9zee12p@p.webshare.io:80',
    'http://pnpswulu-rotate:chmxqkncvb9d@p.webshare.io:80'
]);
const CB_PROXY_COOLDOWN_MS = 90_000;
const CB_PROXY_MAX_FAILURES = 4;

const CB_CACHE_LIMIT = 700;
const CB_CACHE_TTL = Object.freeze({
    movieSearch: 30 * 60_000,
    seriesSearch: 30 * 60_000,
    moviePage: 20 * 60_000,
    seriesPage: 20 * 60_000,
    stayonline: 15 * 60_000,
    uprotLocalFail: 5 * 60_000,
    seasonAlias: 30 * 60_000
});

const cbEnv = createProviderEnv(CB01_CODE_DEFAULTS);
const cbCache = createProviderCache({
    providerName: 'cb01',
    maxEntries: CB_CACHE_LIMIT,
    inflightMaxEntries: 500,
    ttlByNamespace: CB_CACHE_TTL,
    logger: (level, message, payload) => cbDebug(level, message, payload),
    traceCache: true
});
const cbLogger = createProviderLogger({
    prefix: 'CB01',
    enabled: () => isCbDebugEnabled(),
    traceEnabled: () => isCbTraceEnabled(),
    debugPrefix: '[CB01:debug]',
    tracePrefix: '[CB01:trace]'
});

function cacheNamespaceKey(namespace, parts = []) {
    return cbCache.key(namespace, parts);
}

function cloneCacheValue(value) {
    return cbCache.clone(value);
}

function getCbCache(namespace, parts = []) {
    return cbCache.get(namespace, parts);
}

function setCbCache(namespace, parts = [], value, ttlMs) {
    return cbCache.set(namespace, parts, value, ttlMs);
}

async function withCbCoalescing(namespace, parts = [], worker) {
    return cbCache.withCoalescing(namespace, parts, worker);
}

function normalizeBaseUrl(value) {
    return normalizeProviderBaseUrl(value);
}

function getBaseUrls() {
    const raw = [
        envString('CB01_BASE_URL', DEFAULT_BASE_URL),
        envString('CB01_BASE_URL_2', ''),
        envString('CB01_BASE_URL_3', ''),
        ...cbEnv.list('CB01_BASE_URLS', []),
    ];
    const out = resolveProviderBaseUrls(raw, DEFAULT_BASE_URLS);
    cbDebug('trace', 'base urls resolved', { bases: out, source: 'code-defaults+env-override' });
    return out;
}

function getBaseUrl() {
    return getBaseUrls()[0];
}

function getDefaultClient() {
    try {
        const axios = require('axios');
        return axios.create({
            timeout: envInt('CB01_PROVIDER_TIMEOUT', SEARCH_TTL_FALLBACK_MS, 1000, 60000),
            maxRedirects: 5,
            proxy: false,
            validateStatus: () => true,
            headers: {
                'User-Agent': DESKTOP_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5'
            }
        });
    } catch (_) {
        return null;
    }
}

function envRaw(name, fallback = '') {
    return cbEnv.raw(name, fallback);
}

function envString(name, fallback = '') {
    return cbEnv.string(name, fallback);
}

function envFlag(name, defaultValue = false) {
    return cbEnv.flag(name, defaultValue);
}

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return cbEnv.int(name, fallback, min, max);
}

function isCbDebugEnabled() {
    return envFlag('CB01_DEBUG', false) || envFlag('CB01_VERBOSE', false) || envFlag('WEB_PROVIDER_DEBUG', false);
}

function isCbTraceEnabled() {
    return envFlag('CB01_TRACE', false) || envFlag('CB01_DEBUG_VERBOSE', false);
}

function sanitizeLogValue(value, depth = 0) {
    return sanitizeProviderLogValue(value, depth);
}


function cbDebug(level, message, payload = null) {
    const normalizedLevel = String(level || 'info').toLowerCase();
    const alwaysShow = /^(warn|error)$/i.test(normalizedLevel);
    if (!alwaysShow && !isCbDebugEnabled()) return;
    if (normalizedLevel === 'trace' && !isCbTraceEnabled()) return;
    const logger = console[normalizedLevel] || console.info;
    const prefix = normalizedLevel === 'trace' ? '[CB01:trace]' : '[CB01:debug]';
    if (payload && typeof payload === 'object') {
        try {
            logger(`${prefix} ${message} ${JSON.stringify(sanitizeLogValue(payload))}`);
        } catch (_) {
            logger(`${prefix} ${message}`);
        }
    } else {
        logger(`${prefix} ${message}`);
    }
}

function safeHost(value) {
    try { return new URL(String(value || '')).hostname; } catch (_) { return ''; }
}

function safePath(value) {
    try { return new URL(String(value || '')).pathname; } catch (_) { return ''; }
}

function safeUrlForLog(value) {
    try {
        const parsed = new URL(String(value || ''));
        const search = parsed.search ? parsed.search.replace(/(api_password=)[^&]+/gi, '$1***').replace(/((?:api|key|token|pass|password|apikey|api_key)=)[^&]+/gi, '$1***') : '';
        return `${parsed.origin}${parsed.pathname}${search}`;
    } catch (_) {
        return sanitizeLogValue(String(value || ''));
    }
}

function htmlProbe(html = '') {
    const text = String(html || '');
    return {
        bytes: Buffer.byteLength(text, 'utf8'),
        cards: (text.match(/card-content/gi) || []).length,
        iframen1: /id=["']iframen1["']/i.test(text),
        iframen2: /id=["']iframen2["']/i.test(text),
        spoilers: (text.match(/sp-head/gi) || []).length,
        anchors: (text.match(/<a\b/gi) || []).length,
        challenge: isChallengePage(text),
        snippet: isCbTraceEnabled() ? text.replace(/\s+/g, ' ').slice(0, 220) : undefined
    };
}

function responseSummary(response, url = '') {
    const headers = response?.headers || {};
    const text = responseText(response);
    return {
        url: safeUrlForLog(url),
        status: Number(response?.status || 0),
        finalUrl: safeUrlForLog(response?.request?.res?.responseUrl || response?.responseUrl || url || ''),
        contentType: headers['content-type'] || headers['Content-Type'] || '',
        bytes: Buffer.byteLength(String(text || ''), 'utf8'),
        challenge: isChallengePage(text)
    };
}

function logCandidateTable(kind, title, candidates, year = null) {
    if (!isCbDebugEnabled()) return;
    const rows = (Array.isArray(candidates) ? candidates : []).slice(0, isCbTraceEnabled() ? 12 : 6).map((candidate) => {
        let urlYear = extractYear(candidate?.dateText) || extractYear(candidate?.cardHtml);
        try {
            const parts = new URL(candidate?.href || '').pathname.split('/').filter(Boolean);
            urlYear = urlYear || extractYear(parts[parts.length - 1] || '');
        } catch (_) {}
        return {
            title: candidate?.title || '',
            sim: Math.round(similarity(candidate?.title || '', title) * 100),
            year: urlYear || null,
            expectedYear: year || null,
            host: safeHost(candidate?.href),
            path: safePath(candidate?.href)
        };
    });
    cbDebug('info', `${kind} candidates detail`, { queryTitle: title, expectedYear: year || null, rows });
}

function responseData(response) {
    return response?.data ?? response?.body ?? response;
}

function responseText(response) {
    const data = responseData(response);
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data || ''); }
}

function responseJson(response) {
    const data = responseData(response);
    if (data && typeof data === 'object' && !Buffer.isBuffer(data)) return data;
    try { return JSON.parse(responseText(response)); } catch (_) { return null; }
}

function cbHtmlSignals(html = '') {
    const text = String(html || '');
    return {
        cards: (text.match(/card-content/gi) || []).length,
        cardTitles: (text.match(/card-title/gi) || []).length,
        iframen1: /id=["']iframen1["']/i.test(text),
        iframen2: /id=["']iframen2["']/i.test(text),
        spoilers: (text.match(/sp-head/gi) || []).length,
        anchors: (text.match(/<a\b/gi) || []).length
    };
}

function hasCbUsableHtml(html = '') {
    const signals = cbHtmlSignals(html);
    return Boolean(
        signals.cards > 0 ||
        signals.cardTitles > 0 ||
        signals.iframen1 ||
        signals.iframen2 ||
        signals.spoilers > 0
    );
}

function isChallengePage(html = '') {
    const text = String(html || '').slice(0, 200000);
    if (!text) return false;

    const challengeMarker = /cf-browser-verification|just a moment|challenge-platform|cf-chl|captcha|attention required|checking your browser|verify you are human|turnstile/i.test(text);
    return Boolean(challengeMarker && !hasCbUsableHtml(text));
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&#215;|&#x0?d7;/gi, 'x')
        .replace(/&#8211;|&#8212;/g, '-')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTitle(value) {
    return decodeHtml(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function similarity(a, b) {
    const left = normalizeTitle(a);
    const right = normalizeTitle(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.98;
    const leftTokens = new Set(left.split(' ').filter(Boolean));
    const rightTokens = right.split(' ').filter(Boolean);
    if (!leftTokens.size || !rightTokens.length) return 0;
    const matches = rightTokens.filter((token) => leftTokens.has(token)).length;
    return matches / Math.max(leftTokens.size, rightTokens.length);
}

function extractYear(value) {
    const match = String(value || '').match(/(?<!\/)(?:19|20)\d{2}(?!\/)/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function withTimeout(promise, ms, label = 'operation') {
    const timeoutMs = Number.parseInt(String(ms || 0), 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function getMetaTitle(meta = {}) {
    return decodeHtml(meta?.title || meta?.name || meta?.originalTitle || meta?.seriesName || '').trim();
}

function getMetaYear(meta = {}) {
    return Number.parseInt(String(meta?.year || meta?.releaseYear || meta?.released || meta?.firstAirDate || '').slice(0, 4), 10) || null;
}

function getSeasonEpisode(meta = {}) {
    const season = Number.parseInt(String(meta?.season || meta?.s || meta?.seasonNumber || meta?.tmdbSeason || 0), 10);
    const episode = Number.parseInt(String(meta?.episode || meta?.e || meta?.episodeNumber || meta?.tmdbEpisode || 0), 10);
    return { season, episode };
}

function isSeriesMeta(meta = {}) {
    if (meta?.isSeries === true || meta?.type === 'series') return true;
    const { season, episode } = getSeasonEpisode(meta);
    return Boolean(season && episode);
}

const STAYONLINE_URL_RE = /https?:\/\/(?:www\.)?stayonline\.[a-z.]+[^"'<>\s\\]+/i;
const MIXDROP_URL_RE = /https?:\/\/(?:www\.)?(?:mixdrop|m1xdrop|mxcontent|mixdrp)[^"'<>\s\\]+/i;
const UPROT_LIKE_URL_RE = /https?:\/\/(?:www\.)?(?:(?:uprot|uproat)\.(?:net|pro))[^"'<>\s\\]+/i;
const MAXSTREAM_URL_RE = /https?:\/\/(?:www\.)?(?:(?:uprot|uproat)\.(?:net|pro)|maxstream\.video|maxstream\.[a-z.]+|stayonline\.[a-z.]+)[^"'<>\s\\]+/i;
const HOSTER_URL_RE = /https?:\/\/(?:www\.)?(?:mixdrop|m1xdrop|mxcontent|mixdrp|(?:uprot|uproat)\.(?:net|pro)|maxstream\.video|maxstream\.[a-z.]+|stayonline\.[a-z.]+)[^"'<>\s\\]+/i;

function isStayonlineUrl(value) {
    return STAYONLINE_URL_RE.test(String(value || ''));
}

function isMixdropUrl(value) {
    return MIXDROP_URL_RE.test(String(value || ''));
}

function isCbUprotUrl(value) {
    return isUprotUrl(value) || UPROT_LIKE_URL_RE.test(String(value || ''));
}

function normalizeCbUprotUrl(value) {
    const normalized = normalizeRemoteUrl(value);
    if (!normalized || !isCbUprotUrl(normalized)) return null;
    return normalized;
}

function isMaxstreamLikeUrl(value) {
    return MAXSTREAM_URL_RE.test(String(value || ''));
}

function shouldResolveUprotLocally(options = {}) {
    return envFlag('CB01_UPROT_LOCAL_RESOLVE_FORCE', false);
}

function normalizeMixdropForExtractor(value) {
    const normalized = normalizeRemoteUrl(value);
    if (!normalized || !isMixdropUrl(normalized)) return null;
    try {
        const parsed = new URL(normalized);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const fileId = parts.length >= 2 && /^(?:e|emb|embed|f|file|watch|video)$/i.test(parts[0])
            ? parts[1]
            : parts.length === 1 ? parts[0] : '';
        if (!fileId) return normalized;
        parsed.pathname = `/e/${fileId}`;
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return normalized
            .replace('/emb/', '/e/')
            .replace('/embed/', '/e/')
            .replace('/f/', '/e/')
            .replace('/file/', '/e/')
            .replace('/watch/', '/e/')
            .replace('/video/', '/e/');
    }
}

async function resolveStayonline(client, url, options = {}) {
    const cleaned = normalizeRemoteUrl(url);
    if (!cleaned || !isStayonlineUrl(cleaned)) {
        cbDebug('trace', 'stayonline skip: invalid url', { rawHost: safeHost(url), rawPath: safePath(url) });
        return null;
    }

    cbDebug('info', 'stayonline resolve start', { host: safeHost(cleaned), path: safePath(cleaned) });
    const cacheKey = [cleaned];
    const cached = getCbCache('stayonline', cacheKey);
    if (cached) return cached;

    return withCbCoalescing('stayonline', cacheKey, async () => {
        const afterWait = getCbCache('stayonline', cacheKey);
        if (afterWait) return afterWait;
        try {
            const id = cleaned.split('/').filter(Boolean).slice(-1)[0] || '';
            if (!id) return null;
            const endpointHost = (() => {
                try { return new URL(cleaned).host; } catch (_) { return 'stayonline.pro'; }
            })();
            const endpoint = `https://${endpointHost}/ajax/linkEmbedView.php`;
            const body = `id=${encodeURIComponent(id)}&ref=`;
            cbDebug('info', 'stayonline ajax request', { endpoint: safeUrlForLog(endpoint), id: String(id).slice(0, 80), refererHost: safeHost(cleaned) });
            const headers = {
                'User-Agent': DESKTOP_UA,
                'Accept': '*/*',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': `https://${endpointHost}`,
                'Referer': cleaned
            };
            const response = await withTimeout(client.post(endpoint, body, {
                headers,
                timeout: envInt('CB01_STAYONLINE_TIMEOUT_MS', 8000, 1500, 20000),
                maxRedirects: 5,
                validateStatus: () => true,
                responseType: 'text'
            }), envInt('CB01_STAYONLINE_TIMEOUT_MS', 8000, 1500, 20000) + 1500, 'CB01 stayonline');
            const status = Number(response?.status || 0);
            cbDebug('info', 'stayonline ajax response', responseSummary(response, endpoint));
            if (status && (status < 200 || status >= 400)) {
                cbDebug('warn', 'stayonline bad status', { status, host: safeHost(cleaned), endpoint: safeUrlForLog(endpoint) });
                return null;
            }
            const json = responseJson(response);
            cbDebug('trace', 'stayonline ajax json probe', { keys: json && typeof json === 'object' ? Object.keys(json).slice(0, 20) : [], dataKeys: json?.data && typeof json.data === 'object' ? Object.keys(json.data).slice(0, 20) : [] });
            const real = normalizeRemoteUrl(json?.data?.value || json?.data?.url || json?.value || json?.url || '');
            if (real) {
                cbDebug('info', 'stayonline resolved from json', { fromHost: safeHost(cleaned), toHost: safeHost(real), toPath: safePath(real) });
                setCbCache('stayonline', cacheKey, real, CB_CACHE_TTL.stayonline);
                return real;
            }
            const fromText = normalizeRemoteUrl((responseText(response).match(HOSTER_URL_RE) || [])[0] || '');
            if (fromText) {
                cbDebug('info', 'stayonline resolved from html/text', { fromHost: safeHost(cleaned), toHost: safeHost(fromText), toPath: safePath(fromText) });
                setCbCache('stayonline', cacheKey, fromText, CB_CACHE_TTL.stayonline);
                return fromText;
            }
            cbDebug('warn', 'stayonline unresolved: no hoster url in response', { host: safeHost(cleaned), probe: htmlProbe(responseText(response)) });
            return null;
        } catch (error) {
            cbDebug('warn', 'stayonline resolve failed', { error: error?.message || String(error), host: safeHost(cleaned) });
            return null;
        }
    });
}

function buildMfpProxyUrl(config = {}, targetUrl, headers = {}, { isHls = false } = {}) {
    const gateway = createMediaflowGateway(config);
    cbDebug('trace', 'mfp proxy build start', {
        configured: gateway.isConfigured,
        targetHost: safeHost(targetUrl),
        targetPath: safePath(targetUrl),
        isHls,
        headerNames: Object.keys(headers || {})
    });
    const proxied = gateway.buildProxyUrl(targetUrl, headers, {
        isHls,
        allowCookie: envFlag('CB01_PROXY_COOKIE', true)
    });
    cbDebug('trace', 'mfp proxy build end', {
        changed: Boolean(proxied && proxied !== targetUrl),
        proxyHost: safeHost(proxied),
        proxyPath: safePath(proxied)
    });
    return proxied && proxied !== targetUrl ? proxied : null;
}

function isHlsStreamUrl(value) {
    return /\.m3u8(?:$|[?#])/i.test(String(value || ''));
}

function urlOrigin(value, fallback = '') {
    try { return new URL(String(value || '')).origin; } catch (_) { return fallback; }
}

function extractorHeadersFor(targetUrl, kind = '') {
    const origin = urlOrigin(targetUrl);
    const headers = { 'User-Agent': SAFEGO_FIREFOX_UA };
    if (/mix/i.test(kind)) {
        headers.Referer = origin ? `${origin}/` : 'https://mixdrop.vip/';
        headers.Origin = origin || 'https://mixdrop.vip';
        return headers;
    }
    if (/max|uprot/i.test(kind)) {
        const isUprot = /(?:uprot|uproat)\.(?:net|pro)/i.test(String(targetUrl || ''));
        headers.Referer = isUprot ? (origin ? `${origin}/` : 'https://uprot.net/') : (origin ? `${origin}/` : 'https://uprot.net/');
        headers.Origin = isUprot ? (origin || 'https://uprot.net') : (origin || 'https://uprot.net');
        return headers;
    }
    if (origin) {
        headers.Referer = `${origin}/`;
        headers.Origin = origin;
    }
    return headers;
}

function streamPriority(label) {
    if (/mix/i.test(label)) return 1;
    if (/max/i.test(label)) return 2;
    return 9;
}

function buildDirectExtractorStream({ targetUrl, label, title, headers = null, mediaflowUrl = null, via = 'direct' }) {
    return buildWebStream({
        name: `${ICON} ${PROVIDER} | ${label}`,
        title: `${title}\n☁️ ${label} • 🇮🇹 ITA`,
        url: targetUrl,
        extractor: label,
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers,
        mediaflowUrl,
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                language: 'ITA',
                audioLanguages: ['ita'],
                subtitleLanguages: [],
                via
            }
        },
        extra: { _priority: streamPriority(label) }
    });
}

function buildMfpExtractorStream({ config, targetUrl, host, label, title, via = 'mfp', mediaflowOptions = null, streamKind = 'video' }) {
    if (!getMediaflowBase(config)) return null;
    const mfpUrl = buildMediaflowUrl(config, targetUrl, 'extractor', host, mediaflowOptions || {});
    if (!mfpUrl || mfpUrl === targetUrl) return null;
    cbDebug('info', 'mfp extractor stream built', {
        label,
        host,
        via,
        targetHost: safeHost(targetUrl),
        targetPath: safePath(targetUrl),
        mfpPath: safePath(mfpUrl),
        redirectStream: /[?&]redirect_stream=true(?:&|$)/i.test(mfpUrl),
        streamKind
    });
    return buildWebStream({
        name: `${ICON} ${PROVIDER} | ${label}`,
        title: `${title}\n☁️ ${label} • 🇮🇹 ITA`,
        url: mfpUrl,
        extractor: label,
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers: null,
        mediaflowUrl: getMediaflowBase(config),
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                language: 'ITA',
                audioLanguages: ['ita'],
                subtitleLanguages: [],
                via,
                streamKind
            }
        },
        extra: { _priority: streamPriority(label) }
    });
}

function shouldForwardMaxstreamViaKraken(options = {}) {
    if (options?.maxstreamForwardProxy !== undefined) return options.maxstreamForwardProxy === true;
    return envFlag('CB01_MAXSTREAM_FORWARD_PROXY', false);
}

function buildForwardedMaxstreamTarget(config = {}, targetUrl, kind = 'maxstream', options = {}) {
    const normalized = normalizeRemoteUrl(targetUrl);
    const headers = extractorHeadersFor(normalized, kind);
    if (!normalized || !getMediaflowBase(config) || !shouldForwardMaxstreamViaKraken(options)) {
        return { targetUrl: normalized, headers, forwarded: false };
    }

    const gateway = createMediaflowGateway(config);
    const forwarded = gateway.buildForwardUrl(normalized, headers, { allowCookie: false });
    const changed = Boolean(forwarded && forwarded !== normalized);
    cbDebug(changed ? 'info' : 'warn', 'maxstream forward target built', {
        kind,
        sourceHost: safeHost(normalized),
        sourcePath: safePath(normalized),
        forwardHost: safeHost(forwarded),
        forwardPath: safePath(forwarded),
        forwarded: changed
    });
    return { targetUrl: changed ? forwarded : normalized, headers, forwarded: changed };
}

function buildKrakenUprotMaxstreamStream({ config, targetUrl, title, options = {} }) {
    const normalized = normalizeCbUprotUrl(targetUrl);
    if (!normalized || !getMediaflowBase(config)) return null;
    const headers = extractorHeadersFor(normalized, 'uprot');
    return buildMfpExtractorStream({
        config,
        targetUrl: normalized,
        host: 'Maxstream',
        label: 'MaxStream',
        title,
        via: 'uprot-kraken',
        mediaflowOptions: {
            extractorPath: '/extractor/video.m3u8',
            redirectStream: true,
            headers
        },
        streamKind: 'hls'
    });
}

async function buildMixdropStream(rawUrl, context) {
    const { client, config, title } = context;
    let targetUrl = normalizeRemoteUrl(rawUrl);
    cbDebug('info', 'mixdrop build start', {
        rawHost: safeHost(rawUrl),
        rawPath: safePath(rawUrl),
        normalizedHost: safeHost(targetUrl),
        hasMfp: Boolean(getMediaflowBase(config))
    });
    if (targetUrl && isStayonlineUrl(targetUrl)) {
        const beforeStayonline = targetUrl;
        const resolved = await resolveStayonline(client, targetUrl, context.options);
        if (resolved) targetUrl = resolved;
        cbDebug(resolved ? 'info' : 'warn', 'mixdrop stayonline resolution result', {
            fromHost: safeHost(beforeStayonline),
            resolved: Boolean(resolved),
            toHost: safeHost(targetUrl),
            toPath: safePath(targetUrl)
        });
    }
    if (!targetUrl || !isMixdropUrl(targetUrl)) {
        cbDebug('warn', 'mixdrop build skipped: target is not MixDrop', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl) });
        return null;
    }
    const normalized = normalizeMixdropForExtractor(targetUrl);
    if (!normalized) {
        cbDebug('warn', 'mixdrop build skipped: normalization failed', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl) });
        return null;
    }
    cbDebug('info', 'mixdrop normalized', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl), normalizedPath: safePath(normalized) });

    if (getMediaflowBase(config) && envFlag('CB01_MIXDROP_LOCAL_PROXY_FIRST', true)) {
        try {
            const extracted = await withTimeout(
                extractMixdrop(normalized, { client, userAgent: SAFEGO_FIREFOX_UA }),
                envInt('CB01_MIXDROP_LOCAL_TIMEOUT_MS', 3500, 800, 8000),
                'CB01 MixDrop local'
            );
            if (extracted?.url) {
                cbDebug('info', 'mixdrop local extractor success', {
                    sourceHost: safeHost(extracted.url),
                    sourcePath: safePath(extracted.url),
                    hasHeaders: Boolean(extracted.headers),
                    headerNames: Object.keys(extracted.headers || {})
                });
                const isHls = isHlsStreamUrl(extracted.url);
                const proxied = buildMfpProxyUrl(config, extracted.url, extracted.headers || extractorHeadersFor(normalized, 'mixdrop'), { isHls });
                if (proxied && proxied !== extracted.url) {
                    cbDebug('info', 'mixdrop source proxied via MFP/Kraken', {
                        sourceHost: safeHost(extracted.url),
                        sourcePath: safePath(extracted.url),
                        proxyPath: safePath(proxied),
                        isHls,
                        hasHeaders: Boolean(extracted.headers)
                    });
                    return buildDirectExtractorStream({
                        targetUrl: proxied,
                        label: 'MixDrop',
                        title,
                        headers: null,
                        mediaflowUrl: getMediaflowBase(config),
                        via: isHls ? 'mixdrop-local-mfp-hls' : 'mixdrop-local-mfp-stream'
                    });
                }
                cbDebug('warn', 'mixdrop local extractor returned source but MFP proxy did not change URL', { sourceHost: safeHost(extracted.url), sourcePath: safePath(extracted.url) });
            } else {
                cbDebug('warn', 'mixdrop local extractor returned no url', { normalizedHost: safeHost(normalized), normalizedPath: safePath(normalized) });
            }
        } catch (error) {
            cbDebug('warn', 'mixdrop local proxy failed; using MFP extractor fallback', { error: error?.message || String(error), targetHost: safeHost(normalized), targetPath: safePath(normalized) });
        }
    }

    if (!getMediaflowBase(config)) {
        cbDebug('warn', 'mixdrop stream skipped: MediaFlow Proxy not configured', { targetHost: safeHost(normalized) });
        return null;
    }

    cbDebug('info', 'mixdrop using MFP extractor fallback', { targetHost: safeHost(normalized), targetPath: safePath(normalized), redirectStream: envFlag('CB01_MIXDROP_REDIRECT_STREAM', true) });
    return buildMfpExtractorStream({
        config,
        targetUrl: normalized,
        host: 'Mixdrop',
        label: 'MixDrop',
        title,
        via: 'mixdrop-mfp',
        mediaflowOptions: {
            redirectStream: envFlag('CB01_MIXDROP_REDIRECT_STREAM', true),
            headers: extractorHeadersFor(normalized, 'mixdrop')
        },
        streamKind: 'video'
    });
}

async function buildMaxstreamStream(rawUrl, context) {
    const { client, config, title, options } = context;
    let targetUrl = normalizeRemoteUrl(rawUrl);
    cbDebug('info', 'maxstream build start', {
        rawHost: safeHost(rawUrl),
        rawPath: safePath(rawUrl),
        normalizedHost: safeHost(targetUrl),
        hasMfp: Boolean(getMediaflowBase(config))
    });
    let stayonlineRefererForUprot = null;
    if (targetUrl && isStayonlineUrl(targetUrl)) {
        const beforeStayonline = targetUrl;
        const resolved = await resolveStayonline(client, targetUrl, options);
        if (resolved) {
            targetUrl = resolved;
            stayonlineRefererForUprot = beforeStayonline;
        }
        cbDebug(resolved ? 'info' : 'warn', 'maxstream stayonline resolution result', {
            fromHost: safeHost(beforeStayonline),
            resolved: Boolean(resolved),
            toHost: safeHost(targetUrl),
            toPath: safePath(targetUrl)
        });
    }
    if (!targetUrl) {
        cbDebug('warn', 'maxstream build skipped: empty target after normalization/resolution', { rawHost: safeHost(rawUrl), rawPath: safePath(rawUrl) });
        return null;
    }

    const originalUprotUrl = isCbUprotUrl(targetUrl) ? targetUrl : null;
    const canonicalUprotUrl = originalUprotUrl ? normalizeCbUprotUrl(originalUprotUrl) : null;
    if (originalUprotUrl) {
        const krakenStream = buildKrakenUprotMaxstreamStream({
            config,
            targetUrl: canonicalUprotUrl || originalUprotUrl,
            title,
            options
        });
        if (krakenStream) {
            cbDebug('info', 'uprot sent to Kraken MaxStream extractor; Kraken handles WARP internally', {
                targetHost: safeHost(canonicalUprotUrl || originalUprotUrl),
                targetPath: safePath(canonicalUprotUrl || originalUprotUrl)
            });
            return krakenStream;
        }

        cbDebug('warn', 'uprot MaxStream skipped: Kraken/MediaFlow is required and local UProt resolver is intentionally disabled', {
            hrefHost: safeHost(originalUprotUrl),
            hrefPath: safePath(originalUprotUrl),
            configure: 'KRAKEN_URL or config.mediaflow.url',
            reason: 'cb01_maxstream_kraken_only'
        });
        return null;
    }

    if (!targetUrl || !isMaxstreamLikeUrl(targetUrl)) {
        cbDebug('warn', 'maxstream build skipped: target is not MaxStream-like', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl) });
        return null;
    }

    if (!getMediaflowBase(config)) {
        cbDebug('warn', 'maxstream stream skipped: MediaFlow Proxy not configured', { targetHost: safeHost(targetUrl) });
        return null;
    }

    const forwardedTarget = buildForwardedMaxstreamTarget(config, targetUrl, originalUprotUrl ? 'uprot' : 'maxstream', options);
    cbDebug('info', 'maxstream using MFP extractor', {
        targetHost: safeHost(targetUrl),
        targetPath: safePath(targetUrl),
        extractorTargetHost: safeHost(forwardedTarget.targetUrl),
        extractorTargetPath: safePath(forwardedTarget.targetUrl),
        via: originalUprotUrl ? (forwardedTarget.forwarded ? 'uprot-local-forward-kraken' : 'uprot-local') : (forwardedTarget.forwarded ? 'maxstream-forward-kraken' : 'maxstream'),
        extractorPath: '/extractor/video.m3u8',
        redirectStream: true,
        forwarded: forwardedTarget.forwarded
    });
    return buildMfpExtractorStream({
        config,
        targetUrl: forwardedTarget.targetUrl,
        host: 'Maxstream',
        label: 'MaxStream',
        title,
        via: originalUprotUrl ? (forwardedTarget.forwarded ? 'uprot-local-forward-kraken' : 'uprot-local') : (forwardedTarget.forwarded ? 'maxstream-forward-kraken' : 'maxstream'),
        mediaflowOptions: {
            extractorPath: '/extractor/video.m3u8',
            redirectStream: true,
            headers: forwardedTarget.headers
        },
        streamKind: 'hls'
    });
}

function extractCardCandidates(html, baseUrl = null) {
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (cardHtml, hrefRaw, titleRaw, dateRaw = '') => {
        const href = normalizeRemoteUrl(hrefRaw || '', baseUrl);
        const title = decodeHtml(titleRaw || '');
        if (!href || !title) return;
        const key = `${href}|${normalizeTitle(title)}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ href, title, dateText: decodeHtml(dateRaw || ''), cardHtml: String(cardHtml || '') });
    };

    const source = String(html || '');
    const cardRe = /<(?:div|article|li)\b[^>]*class=["'][^"']*(?:card-content|card|post|item|result)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|article|li)>/gi;
    for (const cardMatch of source.matchAll(cardRe)) {
        const cardHtml = cardMatch?.[1] || '';
        const titleBlock = cardHtml.match(/<h[1-6]\b[^>]*class=["'][^"']*(?:card-title|entry-title|title)[^"']*["'][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]
            || cardHtml.match(/<(?:h[1-6]|strong|b)\b[^>]*>([\s\S]{0,500}?)<\/(?:h[1-6]|strong|b)>/i)?.[1]
            || cardHtml;
        const linkMatch = titleBlock.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
            || cardHtml.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>/i)
            || cardHtml.match(/<a\b[^>]*title=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/i);
        if (!linkMatch) continue;
        let href = linkMatch[1] || '';
        let title = linkMatch[2] || '';
        if (/^https?:|^\//i.test(title) && !/^https?:|^\//i.test(href)) {
            const tmp = href;
            href = title;
            title = tmp;
        }
        const dateSpanMatch = cardHtml.match(/<span\b[^>]*(?:class=["'][^"']*(?:date|year|meta)[^"']*["']|style=["'][^"']*color[^"']*["'])[^>]*>([\s\S]*?)<\/span>/i)
            || cardHtml.match(/(?:19|20)\d{2}/);
        const dateText = dateSpanMatch?.[1] || dateSpanMatch?.[0] || '';
        pushCandidate(cardHtml, href, title, dateText);
    }

    if (!candidates.length) {
        const fallbackRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*(?:title=["']([^"']+)["'])?[^>]*>([\s\S]{0,220}?)<\/a>/gi;
        for (const match of source.matchAll(fallbackRe)) {
            const href = match?.[1] || '';
            if (!/(?:film|movie|serietv|serie|tv-series|streaming)/i.test(href)) continue;
            const title = match?.[2] || match?.[3] || '';
            pushCandidate(match?.[0] || '', href, title, match?.[0] || '');
            if (candidates.length >= 40) break;
        }
    }
    return candidates;
}

function parseCbProxyList() {
    const raw = envString('CB01_PROXY_LIST', '');
    if (!raw) return CB_DEFAULT_PROXY_LIST.slice();
    const out = raw
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter(Boolean)
        .filter((value) => /^https?:\/\//i.test(value) || /^socks[45]?:\/\//i.test(value));
    return out.length ? out : CB_DEFAULT_PROXY_LIST.slice();
}

const CB_PROXY_POOL = (() => {
    const list = parseCbProxyList();
    const entries = list.map((url) => ({
        url,
        host: (() => { try { return new URL(url).host; } catch (_) { return 'invalid'; } })(),
        failures: 0,
        cooldownUntil: 0,
        lastUsedAt: 0
    }));
    let cursor = 0;
    const advance = () => { cursor = (cursor + 1) % Math.max(entries.length, 1); };
    return {
        size: () => entries.length,
        entries: () => entries.slice(),
        next() {
            if (!entries.length) return null;
            const now = Date.now();
            const startedCursor = cursor;
            for (let i = 0; i < entries.length; i += 1) {
                const entry = entries[cursor];
                advance();
                if (entry.cooldownUntil <= now) {
                    entry.lastUsedAt = now;
                    return entry;
                }
            }
            const oldest = entries.slice().sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
            oldest.cooldownUntil = 0;
            oldest.failures = 0;
            oldest.lastUsedAt = Date.now();
            cursor = (startedCursor + 1) % entries.length;
            cbDebug('warn', 'proxy pool exhausted; force-clearing oldest cooldown', { host: oldest.host, failures: oldest.failures });
            return oldest;
        },
        markSuccess(entry) {
            if (!entry) return;
            entry.failures = 0;
            entry.cooldownUntil = 0;
        },
        markFailure(entry, reason = '') {
            if (!entry) return;
            entry.failures += 1;
            if (entry.failures >= CB_PROXY_MAX_FAILURES) {
                entry.cooldownUntil = Date.now() + CB_PROXY_COOLDOWN_MS;
                cbDebug('warn', 'proxy cooldown engaged', { host: entry.host, failures: entry.failures, cooldownMs: CB_PROXY_COOLDOWN_MS, reason });
            }
        }
    };
})();

function pickSimpleUa() {
    return CB_SIMPLE_UAS[Math.floor(Math.random() * CB_SIMPLE_UAS.length)] || DESKTOP_UA;
}

function normalizeForwardProxyBase(value) {
    return normalizeSharedForwardProxyBase(value, 'cb01');
}

function getExplicitCbForwardProxy() {
    return getForwardProxyBase({ context: 'cb01' });
}

function getCbForwardProxy() {
    return normalizeForwardProxyBase(getExplicitCbForwardProxy());
}

function buildCbForwardProxyUrl(targetUrl) {
    return buildForwardProxyUrl(targetUrl, { context: 'cb01' });
}

function buildCbBrowserHeaders(baseUrl, targetUrl = '', label = 'fetch') {
    const isSeriesSearch = /\/serietv\/?\?/i.test(String(targetUrl || ''));
    const referer = isSeriesSearch ? `${baseUrl}/serietv/` : `${baseUrl}/`;
    return buildProviderHtmlHeaders({
        userAgent: pickSimpleUa(),
        referer,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5',
        acceptEncoding: 'gzip, deflate, br',
        cacheControl: 'no-cache',
        pragma: 'no-cache',
        upgradeInsecureRequests: true
    });
}

function toAxiosProxyConfig(proxyUrl) {
    if (!proxyUrl) return false;
    try {
        const parsed = new URL(proxyUrl);
        if (!/^https?:$/i.test(parsed.protocol)) return false;
        const proxy = {
            protocol: parsed.protocol.replace(':', ''),
            host: parsed.hostname,
            port: Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10)
        };
        if (parsed.username || parsed.password) {
            proxy.auth = {
                username: decodeURIComponent(parsed.username || ''),
                password: decodeURIComponent(parsed.password || '')
            };
        }
        return proxy;
    } catch (_) {
        return false;
    }
}

function pickCbImpitBrowser(label = '') {
    const preferred = envString('CB01_IMPIT_BROWSER', '');
    if (preferred) return preferred;
    if (label === 'search') return 'chrome125';
    return CB_IMPIT_BROWSER_FALLBACKS[Math.floor(Math.random() * CB_IMPIT_BROWSER_FALLBACKS.length)] || 'chrome125';
}

function impitResponseToText(response) {
    if (!response) return '';
    const data = response.data ?? response.body;
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data || ''); }
}

function impitResponseStatus(response) {
    if (!response) return 0;
    const value = Number(response.statusCode ?? response.status ?? 0);
    return Number.isFinite(value) ? value : 0;
}

function getCbCurlCffiRunner() {
    return curlCffiRunnerOverride || runCurlCffiBypass || null;
}

function isCbCurlCffiFallbackEnabled() {
    if (!envFlag('CB01_CURL_CFFI_FALLBACK', true)) return false;
    const global = String(process.env.CURL_CFFI_ENABLED ?? '').trim().toLowerCase();
    return !['0', 'false', 'no', 'off', 'disabled'].includes(global);
}

function isUsableCbCurlCffiResult(result) {
    if (!result || result.status !== 'ok') return false;
    const status = Number(result.code || result.statusCode || 0);
    const html = String(result.html || result.response || '');
    if (!status || status >= 400) return false;
    if (!html) return false;
    const usableHtml = hasCbUsableHtml(html);
    const challenge = result.challengeDetected === true || isChallengePage(html);
    return !challenge || usableHtml;
}

async function fetchViaCbCurlCffi(url, baseUrl, {
    label = 'fetch',
    headers = null,
    timeoutMs = 4500,
    totalBudgetMs = 0,
    startedAt = Date.now(),
    previousVia = '',
    previousStatus = 0,
    previousError = '',
    previousChallenge = false
} = {}) {
    const runner = getCbCurlCffiRunner();
    if (typeof runner !== 'function' || !isCbCurlCffiFallbackEnabled()) {
        return null;
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingBudgetMs = Number(totalBudgetMs || 0) > 0 ? Number(totalBudgetMs) - elapsedMs : Number(timeoutMs || 0);
    const minRemainingMs = envInt('CB01_CURL_CFFI_MIN_REMAINING_MS', 2600, 1000, 12000);
    if (remainingBudgetMs < minRemainingMs) {
        cbDebug('trace', 'curl_cffi fallback skipped: not enough budget', {
            label,
            url: safeUrlForLog(url),
            elapsedMs,
            remainingBudgetMs,
            minRemainingMs
        });
        return null;
    }

    const isSearch = label === 'search';
    const configuredTimeout = envInt(
        isSearch ? 'CB01_CURL_CFFI_SEARCH_TIMEOUT_MS' : 'CB01_CURL_CFFI_PAGE_TIMEOUT_MS',
        isSearch ? 4200 : 5200,
        1200,
        15000
    );
    const effectiveTimeoutMs = Math.max(1200, Math.min(Number(timeoutMs || configuredTimeout), configuredTimeout, remainingBudgetMs - 350));
    const requestHeaders = headers || buildCbBrowserHeaders(baseUrl, url, label);
    const referer = requestHeaders.Referer || requestHeaders.referer || `${baseUrl}/`;

    cbDebug('info', 'curl_cffi fallback attempt', {
        label,
        url: safeUrlForLog(url),
        timeoutMs: effectiveTimeoutMs,
        remainingBudgetMs,
        previousVia,
        previousStatus,
        previousChallenge
    });

    try {
        const result = await runner(url, 'cb01', {
            headers: requestHeaders,
            referer,
            timeout: effectiveTimeoutMs,
            retries: envInt('CB01_CURL_CFFI_RETRIES', 0, 0, 2),
            retryBackoffMs: envInt('CB01_CURL_CFFI_RETRY_BACKOFF_MS', 0, 0, 3000),
            warmupOrigin: envFlag('CB01_CURL_CFFI_WARMUP_ORIGIN', false),
            browserHeaders: true,
            impersonate: envString('CB01_CURL_CFFI_IMPERSONATE', 'auto'),
            signalsJson: {
                provider: 'cb01',
                label,
                previousVia,
                previousStatus,
                previousError: String(previousError || '').slice(0, 160),
                previousChallenge: Boolean(previousChallenge),
                budgetRemainingMs: remainingBudgetMs
            },
            coalesceKey: `cb01:curl_cffi:${label}:${url}`
        });

        const html = String(result?.html || result?.response || '');
        const status = Number(result?.code || result?.statusCode || 0);
        const challenge = result?.challengeDetected === true || isChallengePage(html);
        const usableHtml = hasCbUsableHtml(html);
        const ok = isUsableCbCurlCffiResult(result);

        cbDebug(ok ? 'info' : 'warn', 'curl_cffi fallback result', {
            label,
            url: safeUrlForLog(url),
            status,
            bytes: Buffer.byteLength(html || '', 'utf8'),
            challenge,
            usableHtml,
            impersonate: result?.impersonate || '',
            profileScore: result?.profileScore,
            httpVersionMode: result?.httpVersionMode || '',
            elapsedMs: result?.elapsedMs || undefined,
            probe: htmlProbe(html)
        });

        if (!ok) return null;
        return { text: html, status, proxyHost: '', via: 'curl-cffi-fast-fallback' };
    } catch (error) {
        cbDebug('warn', 'curl_cffi fallback failed', {
            label,
            url: safeUrlForLog(url),
            error: error?.message || String(error),
            ms: Date.now() - startedAt
        });
        return null;
    }
}

function buildCbImpitAttempts(url, baseUrl, label, config = {}, hardTimeoutMs = 9000) {
    const attempts = [];
    const upstreamHeaders = buildCbBrowserHeaders(baseUrl, url, label);
    const isSearch = label === 'search';
    const forwardUrl = buildCbForwardProxyUrl(url, config, upstreamHeaders);
    const hasForward = Boolean(forwardUrl && forwardUrl !== url);

    const directTimeoutMs = envInt('CB01_IMPIT_DIRECT_TIMEOUT_MS', isSearch ? 2500 : 3500, 1500, 12000);
    const forwardTimeoutMs = envInt('CB01_IMPIT_FORWARD_TIMEOUT_MS', isSearch ? 5500 : 7000, 2000, 18000);
    const proxyTimeoutMs = envInt('CB01_IMPIT_PROXY_TIMEOUT_MS', isSearch ? 6500 : 7500, 2000, 18000);

    const proxyMaxAttempts = Math.min(
        CB_PROXY_POOL.size(),
        envInt('CB01_PROXY_MAX_ATTEMPTS', isSearch ? 1 : 2, 0, isSearch ? 2 : 4)
    );
    const proxyEnabled = envFlag('CB01_USE_PROXY', false) && proxyMaxAttempts > 0;
    const forwardEnabled = hasForward && envFlag('CB01_IMPIT_FORWARD_ENABLED', true);
    const directFallback = envFlag('CB01_IMPIT_DIRECT_FALLBACK', false);
    const forwardFallback = envFlag('CB01_IMPIT_FORWARD_FALLBACK', true);
    const maxAttempts = envInt('CB01_IMPIT_MAX_ATTEMPTS_TOTAL', isSearch ? 2 : 3, 1, 5);

    const strategy = String(
        envString('CB01_IMPIT_STRATEGY', '') ||
        (proxyEnabled ? 'proxy-first' : (forwardEnabled ? 'forward-first' : 'direct-first'))
    ).trim().toLowerCase();

    const canAdd = () => attempts.length < maxAttempts;

    const addDirect = (via = 'impit-direct', timeout = hardTimeoutMs) => {
        if (!canAdd()) return;
        attempts.push({
            via,
            requestUrl: url,
            proxyEntry: null,
            proxyUrl: '',
            headers: upstreamHeaders,
            browser: pickCbImpitBrowser(label),
            timeoutMs: Math.max(1500, Number(timeout || hardTimeoutMs))
        });
    };

    const addForward = (via = null) => {
        if (!forwardEnabled || !canAdd()) return;
        attempts.push({
            via: via || (getExplicitCbForwardProxy() ? 'impit-explicit-forward' : 'impit-kraken-forward-html'),
            requestUrl: forwardUrl,
            proxyEntry: null,
            proxyUrl: '',
            headers: upstreamHeaders,
            browser: pickCbImpitBrowser(label),
            timeoutMs: Math.max(2000, Number(forwardTimeoutMs || hardTimeoutMs))
        });
    };

    const addProxyAttempts = () => {
        if (!proxyEnabled) return;
        for (let i = 0; i < proxyMaxAttempts && canAdd(); i += 1) {
            const entry = CB_PROXY_POOL.next();
            if (!entry) continue;
            attempts.push({
                via: 'impit-proxy',
                requestUrl: url,
                proxyEntry: entry,
                proxyUrl: entry.url,
                headers: upstreamHeaders,
                browser: pickCbImpitBrowser(label),
                timeoutMs: proxyTimeoutMs
            });
        }
    };

    if (strategy === 'forward-only') {
        addForward('impit-forward-only');
    } else if (strategy === 'proxy-only') {
        addProxyAttempts();
    } else if (strategy === 'direct-only') {
        addDirect('impit-direct-only', hardTimeoutMs);
    } else if (strategy === 'proxy-first') {
        addProxyAttempts();
        if (forwardFallback) addForward('impit-forward-fallback');
        if (directFallback) addDirect('impit-direct-fallback', directTimeoutMs);
    } else if (strategy === 'direct-first') {
        addDirect('impit-direct-first', hasForward ? directTimeoutMs : hardTimeoutMs);
        addProxyAttempts();
        if (forwardFallback) addForward('impit-forward-fallback');
    } else {
        addForward('impit-forward-first');
        addProxyAttempts();
        if (directFallback) addDirect('impit-direct-fallback', hasForward ? directTimeoutMs : hardTimeoutMs);
    }

    if (!attempts.length) {
        if (forwardEnabled) addForward('impit-forward-default');
        if (!attempts.length && proxyEnabled) addProxyAttempts();
        if (!attempts.length) addDirect('impit-direct-default', Math.min(hardTimeoutMs, directTimeoutMs));
    }

    cbDebug('info', 'impit html attempt plan', {
        label,
        url: safeUrlForLog(url),
        strategy,
        hasForward,
        proxyEnabled,
        directFallback,
        forwardFallback,
        maxAttempts,
        forwardHost: safeHost(forwardUrl),
        forwardPath: safePath(forwardUrl),
        attempts: attempts.map((attempt) => ({ via: attempt.via, timeoutMs: attempt.timeoutMs, requestHost: safeHost(attempt.requestUrl), proxyHost: attempt.proxyEntry?.host || '' }))
    });

    return attempts;
}

async function fetchViaCbProxy(url, baseUrl, { timeoutMs, label = 'fetch', config = {} } = {}) {
    const startedAt = Date.now();
    const isSearch = label === 'search';
    const hardTimeoutMs = Math.max(
        2000,
        Number(timeoutMs) || envInt(
            isSearch ? 'CB01_SEARCH_TIMEOUT_MS' : 'CB01_PAGE_TIMEOUT_MS',
            isSearch ? 8500 : 9500,
            1500,
            30000
        )
    );
    const totalBudgetMs = envInt(
        isSearch ? 'CB01_SEARCH_TOTAL_BUDGET_MS' : 'CB01_PAGE_TOTAL_BUDGET_MS',
        isSearch ? 13500 : 16500,
        3000,
        21000
    );

    const attempts = buildCbImpitAttempts(url, baseUrl, label, config, hardTimeoutMs);
    let lastStatus = 0;
    let lastError = '';
    let lastProxyHost = '';
    let lastVia = '';

    for (let index = 0; index < attempts.length; index += 1) {
        const elapsedBefore = Date.now() - startedAt;
        const remainingBudgetMs = totalBudgetMs - elapsedBefore;
        if (remainingBudgetMs < 1800) {
            cbDebug('warn', 'impit html fetch budget exhausted before attempt', {
                label,
                url: safeUrlForLog(url),
                attempt: index + 1,
                maxAttempts: attempts.length,
                elapsedMs: elapsedBefore,
                totalBudgetMs,
                lastVia,
                lastStatus,
                lastError
            });
            break;
        }

        const attempt = attempts[index];
        const headers = attempt.headers || buildCbBrowserHeaders(baseUrl, url, label);
        const proxyHost = attempt.proxyEntry?.host || '';
        const browser = attempt.browser || pickCbImpitBrowser(label);
        const perAttemptTimeout = Math.max(1500, Math.min(Number(attempt.timeoutMs || hardTimeoutMs), remainingBudgetMs - 600));

        lastProxyHost = proxyHost;
        lastVia = attempt.via;

        cbDebug('info', 'impit html fetch attempt', {
            label,
            url: safeUrlForLog(url),
            requestUrl: safeUrlForLog(attempt.requestUrl),
            via: attempt.via,
            proxyHost,
            browser,
            attempt: index + 1,
            maxAttempts: attempts.length,
            timeoutMs: perAttemptTimeout,
            remainingBudgetMs
        });

        let response = null;
        let errorMessage = '';
        try {
            response = await requestWithImpitRotating(attempt.requestUrl, {
                method: 'GET',
                headers,
                timeout: perAttemptTimeout,
                responseType: 'text',
                proxyUrl: attempt.proxyUrl || undefined,
                browser,
                browserFallbacks: [browser, ...CB_IMPIT_BROWSER_FALLBACKS.filter((item) => item !== browser)],
                maxBrowserAttempts: envInt('CB01_IMPIT_MAX_BROWSER_ATTEMPTS', 1, 1, 3),
                totalTimeoutMs: perAttemptTimeout + 300,
                innerRetry: { limit: envInt('CB01_IMPIT_INNER_RETRY', 0, 0, 2) },
                retryOnStatuses: [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524],
                retryOnChallenge: envFlag('CB01_IMPIT_RETRY_ON_CHALLENGE', false),
                http3: envFlag('CB01_IMPIT_HTTP3', true),
                ignoreTlsErrors: true,
                fingerprint: { userAgent: headers['User-Agent'] || headers['user-agent'] || DESKTOP_UA }
            });
        } catch (error) {
            if (isCanceledError(error)) throw error;
            errorMessage = error?.message || String(error);
        }

        const status = impitResponseStatus(response);
        const text = impitResponseToText(response);
        const usableHtml = hasCbUsableHtml(text);
        const challenge = isChallengePage(text);
        const ok = status >= 200 && status < 400 && text && (!challenge || usableHtml);
        lastStatus = status;
        lastError = errorMessage;

        cbDebug(ok ? 'info' : 'warn', 'impit html fetch result', {
            label,
            url: safeUrlForLog(url),
            via: attempt.via,
            proxyHost,
            browser,
            status,
            bytes: Buffer.byteLength(text || '', 'utf8'),
            challenge,
            usableHtml,
            cards: (text.match(/card-content/gi) || []).length,
            probe: htmlProbe(text),
            error: errorMessage || undefined,
            ms: Date.now() - startedAt
        });

        if (ok) {
            if (attempt.proxyEntry) CB_PROXY_POOL.markSuccess(attempt.proxyEntry);
            return { text, status, proxyHost, via: attempt.via };
        }

        if (attempt.proxyEntry) {
            CB_PROXY_POOL.markFailure(attempt.proxyEntry, errorMessage || (challenge ? 'challenge' : `status_${status}`));
        }

        if (challenge && !usableHtml && envFlag('CB01_STOP_ON_CHALLENGE', true)) {
            cbDebug('warn', 'impit html fetch stopped on hard challenge', {
                label,
                url: safeUrlForLog(url),
                via: attempt.via,
                status,
                ms: Date.now() - startedAt
            });
            break;
        }
    }

    const curlFallback = await fetchViaCbCurlCffi(url, baseUrl, {
        label,
        headers: buildCbBrowserHeaders(baseUrl, url, label),
        timeoutMs: envInt(label === 'search' ? 'CB01_CURL_CFFI_SEARCH_TIMEOUT_MS' : 'CB01_CURL_CFFI_PAGE_TIMEOUT_MS', label === 'search' ? 4200 : 5200, 1200, 15000),
        totalBudgetMs,
        startedAt,
        previousVia: lastVia,
        previousStatus: lastStatus,
        previousError: lastError,
        previousChallenge: lastError === 'challenge' || lastStatus === 403 || lastStatus === 429 || lastStatus === 503
    });
    if (curlFallback?.text) return curlFallback;

    cbDebug('warn', 'impit html fetch exhausted attempts', {
        label,
        url: safeUrlForLog(url),
        attempts: attempts.length,
        lastStatus,
        lastError,
        lastProxyHost,
        lastVia,
        ms: Date.now() - startedAt,
        totalBudgetMs
    });

    return { text: '', status: lastStatus, proxyHost: lastProxyHost, via: lastVia || 'error' };
}

async function fetchSearchHtml(client, url, baseUrl, config = {}) {
    cbDebug('info', 'search html request', { url: safeUrlForLog(url), baseUrl });
    const startedAt = Date.now();
    const result = await fetchViaCbProxy(url, baseUrl, {
        timeoutMs: envInt('CB01_SEARCH_TIMEOUT_MS', 7000, 1500, 30000),
        label: 'search',
        config
    });
    const text = result.text || '';
    cbDebug('info', 'search html response', {
        url: safeUrlForLog(url),
        baseUrl,
        status: result.status,
        bytes: Buffer.byteLength(text, 'utf8'),
        proxyHost: result.proxyHost,
        via: result.via,
        ms: Date.now() - startedAt,
        probe: htmlProbe(text)
    });
    if (!text) {
        cbDebug('warn', 'search simple fetch empty', { url: safeUrlForLog(url), baseUrl, status: result.status, via: result.via });
        return '';
    }
    if (isChallengePage(text) && !hasCbUsableHtml(text)) {
        cbDebug('warn', 'search hard challenge detected after simple fetch', { url: safeUrlForLog(url), baseUrl, probe: htmlProbe(text) });
        return '';
    }
    if (!/card-content/i.test(text)) {
        cbDebug('warn', 'search html has no card-content markers', { url: safeUrlForLog(url), baseUrl, probe: htmlProbe(text) });
    }
    return text;
}

async function fetchPageHtml(client, url, baseUrl, namespace = 'page', config = {}) {
    cbDebug('info', 'page html request', { namespace, url: safeUrlForLog(url), baseUrl });
    const cacheKey = [url];
    const cached = getCbCache(namespace, cacheKey);
    if (cached) return cached;
    return withCbCoalescing(namespace, cacheKey, async () => {
        const afterWait = getCbCache(namespace, cacheKey);
        if (afterWait) return afterWait;
        const startedAt = Date.now();
        const result = await fetchViaCbProxy(url, baseUrl, {
            timeoutMs: envInt('CB01_PAGE_TIMEOUT_MS', 9000, 1500, 30000),
            label: namespace,
            config
        });
        const text = result.text || '';
        cbDebug('info', 'page html response', {
            namespace,
            url: safeUrlForLog(url),
            baseUrl,
            status: result.status,
            bytes: Buffer.byteLength(text, 'utf8'),
            proxyHost: result.proxyHost,
            via: result.via,
            ms: Date.now() - startedAt,
            probe: htmlProbe(text)
        });
        if (!text) {
            cbDebug('warn', 'page simple fetch empty', { url: safeUrlForLog(url), namespace, status: result.status, via: result.via });
            return '';
        }
        if (isChallengePage(text) && !hasCbUsableHtml(text)) {
            cbDebug('warn', 'page hard challenge detected after simple fetch', { url: safeUrlForLog(url), baseUrl, namespace, probe: htmlProbe(text) });
            return '';
        }
        setCbCache(namespace, cacheKey, text, CB_CACHE_TTL[namespace] || CB_CACHE_TTL.moviePage);
        return text;
    });
}

function buildSearchQuery(title) {
    const normalized = decodeHtml(title)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
    return new URLSearchParams({ s: normalized }).toString();
}

function normalizeSearchTitleVariant(value) {
    return decodeHtml(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\b(?:stagione|season)\s+\d+\b/gi, ' ')
        .replace(/\bs\d{1,2}e\d{1,2}\b/gi, ' ')
        .replace(/\s*\((?:19|20)\d{2}\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSearchQueries(title) {
    const cleaned = normalizeSearchTitleVariant(title);
    const asciiLoose = cleaned
        .replace(/[\'’]/g, ' ')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const withoutArticles = asciiLoose
        .replace(/^(?:il|lo|la|l|i|gli|le|un|uno|una|the|a|an)\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    const variants = [cleaned, asciiLoose, withoutArticles]
        .filter((value) => value && value.length >= 2);
    return [...new Set(variants)].slice(0, envInt('CB01_SEARCH_QUERY_VARIANTS', 3, 1, 5));
}

function buildSearchUrls(baseUrl, kind, title) {
    const path = kind === 'series' ? '/serietv/' : '/';
    const fallbackPath = kind === 'series' ? '/' : '/serietv/';
    const urls = [];
    for (const queryTitle of buildSearchQueries(title)) {
        urls.push({ url: `${baseUrl}${path}?${buildSearchQuery(queryTitle)}`, queryTitle, scope: kind });
    }
    if (envFlag('CB01_SEARCH_CROSS_SCOPE_FALLBACK', true)) {
        for (const queryTitle of buildSearchQueries(title).slice(0, 2)) {
            urls.push({ url: `${baseUrl}${fallbackPath}?${buildSearchQuery(queryTitle)}`, queryTitle, scope: kind === 'series' ? 'all' : 'series-fallback' });
        }
    }
    const seen = new Set();
    return urls.filter((item) => {
        if (!item?.url || seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
    });
}

function candidateYear(candidate = {}) {
    if (!candidate) return null;
    let value = extractYear(candidate.dateText) || extractYear(candidate.title) || extractYear(candidate.cardHtml);
    if (value) return value;
    try {
        const parts = new URL(candidate.href || '').pathname.split('/').filter(Boolean);
        value = extractYear(parts[parts.length - 1] || '') || extractYear(parts.join(' '));
    } catch (_) {}
    return value || null;
}

function scoreCandidate(candidate, title, year, kind = 'movie') {
    if (!candidate?.href) return { score: 0, sim: 0, candidateYear: null, reason: 'missing_href' };
    const sim = similarity(candidate.title, title) * 100;
    const foundYear = candidateYear(candidate);
    let score = sim;
    const titleNorm = normalizeTitle(candidate.title);
    const wantedNorm = normalizeTitle(title);
    if (titleNorm === wantedNorm) score += 18;
    else if (titleNorm.includes(wantedNorm) || wantedNorm.includes(titleNorm)) score += 10;
    if (year && foundYear) {
        const diff = Math.abs(Number(foundYear) - Number(year));
        if (diff === 0) score += kind === 'series' ? 60 : 70;
        else if (kind === 'series' && diff <= 1) score += 30;
        else if (kind !== 'series' && diff <= 1) score += 8;
        else score -= 35;
    } else if (year && !foundYear) {
        score -= kind === 'series' ? 4 : 8;
    }
    try {
        const path = new URL(candidate.href).pathname;
        if (kind === 'series' && /serietv|serie|tv-series/i.test(path)) score += 12;
        if (kind !== 'series' && /film|movie/i.test(path)) score += 10;
        if (kind !== 'series' && /serietv|serie|tv-series/i.test(path)) score -= 20;
    } catch (_) {}
    return { score, sim, candidateYear: foundYear, reason: 'scored' };
}

function pickBestCandidate(candidates, title, year, kind = 'movie') {
    let best = null;
    let bestMeta = { score: 0, sim: 0, candidateYear: null };
    const minScore = envInt(kind === 'series' ? 'CB01_SERIES_MIN_SCORE' : 'CB01_MOVIE_MIN_SCORE', kind === 'series' ? 58 : 62, 20, 140);
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const meta = scoreCandidate(candidate, title, year, kind);
        if (meta.score > bestMeta.score) {
            best = candidate;
            bestMeta = meta;
        }
    }
    if (best && bestMeta.score >= minScore) return { candidate: best, ...bestMeta, minScore };
    return { candidate: null, ...bestMeta, minScore };
}


function stripCbNoiseFromTitle(value = '') {
    return decodeHtml(value)
        .replace(/\s*-\s*(?:FILM GRATIS|CB01|CINEBLOG01|Streaming).*$/i, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\((?:19|20)\d{2}\)/g, ' ')
        .replace(/\b(?:streaming|ita|hd|fullhd|subita|download)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function slugifyCbTitle(value = '') {
    return stripCbNoiseFromTitle(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' e ')
        .replace(/[‘’'"“”]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .toLowerCase();
}

function extractCbPageHeadline(html = '') {
    const source = String(html || '');
    const ogTitle = source.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1]
        || source.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i)?.[1];
    const jsonHeadline = source.match(/"headline"\s*:\s*"([^"]+)"/i)?.[1];
    const h1 = source.match(/<h1\b[^>]*>([\s\S]{0,260}?)<\/h1>/i)?.[1];
    const titleTag = source.match(/<title\b[^>]*>([\s\S]{0,260}?)<\/title>/i)?.[1];
    return decodeHtml(ogTitle || jsonHeadline || h1 || titleTag || '').trim();
}

function buildDirectMovieUrlCandidates(baseUrl, title, year = null) {
    const slug = slugifyCbTitle(title);
    if (!slug) return [];
    const yearText = year ? String(year) : '';
    const variants = [
        yearText ? `${slug}-hd-${yearText}` : '',
        yearText ? `${slug}-${yearText}-hd` : '',
        yearText ? `${slug}-${yearText}` : '',
        `${slug}-hd`,
        slug
    ].filter(Boolean);
    const seen = new Set();
    const max = envInt('CB01_DIRECT_SLUG_MAX_PROBES', 8, 1, 20);
    return variants
        .map((part) => `${String(baseUrl || '').replace(/\/+$/, '')}/${part.replace(/^\/+|\/+$/g, '')}/`)
        .filter((url) => {
            if (seen.has(url)) return false;
            seen.add(url);
            return true;
        })
        .slice(0, max);
}

function looksLikeDirectMoviePage(html, title, year, baseUrl) {
    const source = String(html || '');
    if (!source || (isChallengePage(source) && !hasCbUsableHtml(source))) return { ok: false, score: 0, headline: '', reason: 'empty_or_challenge' };
    const hasHoster = HOSTER_URL_RE.test(source) || /id=["']iframen[12]["']/i.test(source) || /tabs-catch-all/i.test(source);
    const headline = extractCbPageHeadline(source);
    if (!headline) return { ok: false, score: 0, headline: '', reason: 'missing_headline' };
    const meta = scoreCandidate({
        href: `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/`,
        title: stripCbNoiseFromTitle(headline),
        dateText: headline,
        cardHtml: source.slice(0, 12000)
    }, title, year, 'movie');
    const minScore = envInt('CB01_DIRECT_MIN_SCORE', 54, 20, 120);
    const ok = Boolean(hasHoster && meta.score >= minScore);
    return { ok, score: Math.round(meta.score), sim: Math.round(meta.sim), candidateYear: meta.candidateYear || null, headline, hasHoster, minScore, reason: ok ? 'matched' : 'low_score_or_no_hoster' };
}

async function probeDirectMovieUrl(client, baseUrl, title, year, config = {}) {
    if (!envFlag('CB01_DIRECT_SLUG_FALLBACK', true)) return null;
    const candidates = buildDirectMovieUrlCandidates(baseUrl, title, year);
    if (!candidates.length) return null;
    cbDebug('info', 'movie direct slug fallback start', { title, year: year || null, count: candidates.length, sample: candidates.map((url) => safePath(url)).slice(0, 6) });
    for (const url of candidates) {
        const html = await fetchPageHtml(client, url, baseUrl, 'movieSearch', config);
        const verdict = looksLikeDirectMoviePage(html, title, year, baseUrl);
        cbDebug(verdict.ok ? 'info' : 'warn', 'movie direct slug probe', {
            title,
            year: year || null,
            url: safeUrlForLog(url),
            score: verdict.score,
            sim: verdict.sim,
            candidateYear: verdict.candidateYear,
            hasHoster: verdict.hasHoster,
            headline: verdict.headline,
            minScore: verdict.minScore,
            reason: verdict.reason,
            probe: htmlProbe(html)
        });
        if (verdict.ok) return url;
    }
    return null;
}

async function searchMovieUrl(client, baseUrl, title, year, config = {}) {
    if (!title) return null;
    const cacheKey = [baseUrl, normalizeTitle(title), year || 0];
    const cached = getCbCache('movieSearch', cacheKey);
    if (cached) return cached;
    return withCbCoalescing('movieSearch', cacheKey, async () => {
        const afterWait = getCbCache('movieSearch', cacheKey);
        if (afterWait) return afterWait;
        let bestOverall = { candidate: null, score: 0, sim: 0, candidateYear: null, minScore: 0 };
        for (const attempt of buildSearchUrls(baseUrl, 'movie', title)) {
            cbDebug('info', 'movie search start', { title, queryTitle: attempt.queryTitle, normalizedTitle: normalizeTitle(attempt.queryTitle), year: year || null, url: safeUrlForLog(attempt.url), scope: attempt.scope });
            const html = await fetchSearchHtml(client, attempt.url, baseUrl, config);
            if (!html) {
                cbDebug('warn', 'movie search failed: empty html', { title, year: year || null, url: safeUrlForLog(attempt.url), scope: attempt.scope });
                continue;
            }
            const candidates = extractCardCandidates(html, baseUrl);
            cbDebug('info', 'movie search candidates', { title, queryTitle: attempt.queryTitle, year, count: candidates.length, scope: attempt.scope });
            logCandidateTable('movie search', title, candidates, year);
            const picked = pickBestCandidate(candidates, title, year, 'movie');
            if (picked.score > bestOverall.score) bestOverall = { ...picked, scope: attempt.scope, queryTitle: attempt.queryTitle, url: attempt.url };
            if (picked.candidate?.href) break;
        }
        if (bestOverall.candidate?.href) {
            cbDebug('info', 'movie search selected', {
                title,
                year: year || null,
                selectedTitle: bestOverall.candidate.title,
                score: Math.round(bestOverall.score),
                sim: Math.round(bestOverall.sim),
                candidateYear: bestOverall.candidateYear || null,
                minScore: bestOverall.minScore,
                scope: bestOverall.scope,
                host: safeHost(bestOverall.candidate.href),
                path: safePath(bestOverall.candidate.href)
            });
            setCbCache('movieSearch', cacheKey, bestOverall.candidate.href, CB_CACHE_TTL.movieSearch);
            return bestOverall.candidate.href;
        }
        const directUrl = await probeDirectMovieUrl(client, baseUrl, title, year, config);
        if (directUrl) {
            cbDebug('info', 'movie search selected direct slug fallback', { title, year: year || null, host: safeHost(directUrl), path: safePath(directUrl) });
            setCbCache('movieSearch', cacheKey, directUrl, CB_CACHE_TTL.movieSearch);
            return directUrl;
        }
        cbDebug('warn', 'movie search no suitable candidate', { title, year: year || null, bestScore: Math.round(bestOverall.score), candidateYear: bestOverall.candidateYear || null, minScore: bestOverall.minScore });
        return null;
    });
}

async function searchSeriesUrl(client, baseUrl, title, year, config = {}) {
    if (!title) return null;
    const cacheKey = [baseUrl, normalizeTitle(title), year || 0];
    const cached = getCbCache('seriesSearch', cacheKey);
    if (cached) return cached;
    return withCbCoalescing('seriesSearch', cacheKey, async () => {
        const afterWait = getCbCache('seriesSearch', cacheKey);
        if (afterWait) return afterWait;
        let bestOverall = { candidate: null, score: 0, sim: 0, candidateYear: null, minScore: 0 };
        for (const attempt of buildSearchUrls(baseUrl, 'series', title)) {
            cbDebug('info', 'series search start', { title, queryTitle: attempt.queryTitle, normalizedTitle: normalizeTitle(attempt.queryTitle), year: year || null, url: safeUrlForLog(attempt.url), scope: attempt.scope });
            const html = await fetchSearchHtml(client, attempt.url, baseUrl, config);
            if (!html) {
                cbDebug('warn', 'series search failed: empty html', { title, year: year || null, url: safeUrlForLog(attempt.url), scope: attempt.scope });
                continue;
            }
            const candidates = extractCardCandidates(html, baseUrl);
            cbDebug('info', 'series search candidates', { title, queryTitle: attempt.queryTitle, year, count: candidates.length, scope: attempt.scope });
            logCandidateTable('series search', title, candidates, year);
            const picked = pickBestCandidate(candidates, title, year, 'series');
            if (picked.score > bestOverall.score) bestOverall = { ...picked, scope: attempt.scope, queryTitle: attempt.queryTitle, url: attempt.url };
            if (picked.candidate?.href) break;
        }
        if (bestOverall.candidate?.href) {
            cbDebug('info', 'series search selected', {
                title,
                year: year || null,
                selectedTitle: bestOverall.candidate.title,
                score: Math.round(bestOverall.score),
                sim: Math.round(bestOverall.sim),
                candidateYear: bestOverall.candidateYear || null,
                minScore: bestOverall.minScore,
                scope: bestOverall.scope,
                host: safeHost(bestOverall.candidate.href),
                path: safePath(bestOverall.candidate.href)
            });
            setCbCache('seriesSearch', cacheKey, bestOverall.candidate.href, CB_CACHE_TTL.seriesSearch);
            return bestOverall.candidate.href;
        }
        cbDebug('warn', 'series search no suitable candidate', { title, year: year || null, bestScore: Math.round(bestOverall.score), candidateYear: bestOverall.candidateYear || null, minScore: bestOverall.minScore });
        return null;
    });
}

function collectHosterUrlsFromHtml(html, baseUrl = null) {
    const urls = [];
    const seen = new Set();
    const push = (value) => {
        const normalized = normalizeRemoteUrl(decodeHtml(value || ''), baseUrl);
        if (!normalized || seen.has(normalized)) return;
        if (!HOSTER_URL_RE.test(normalized)) return;
        seen.add(normalized);
        urls.push(normalized);
    };
    const source = String(html || '');
    for (const match of source.matchAll(/(?:data-src|src|href)=["']([^"']+)["']/gi)) push(match?.[1] || '');
    for (const match of source.matchAll(/https?:\/\/[^"'<>\s\\]+/gi)) push(match?.[0] || '');
    for (const semanticUrl of extractResilientEmbeds(source, { baseUrl, maxCandidates: 32 })) push(semanticUrl);
    return urls;
}

function pickHosterLinksFromUrls(urls = []) {
    let mixdropLink = null;
    let maxstreamLink = null;
    for (const url of Array.isArray(urls) ? urls : []) {
        if (!mixdropLink && isMixdropUrl(url)) mixdropLink = url;
        if (!maxstreamLink && (isStayonlineUrl(url) || isCbUprotUrl(url) || isMaxstreamLikeUrl(url))) maxstreamLink = url;
        if (mixdropLink && maxstreamLink) break;
    }
    return { mixdropLink, maxstreamLink };
}

async function extractMovieEmbedLinks(client, pageUrl, baseUrl, config = {}) {
    const html = await fetchPageHtml(client, pageUrl, baseUrl, 'moviePage', config);
    if (!html) {
        cbDebug('warn', 'movie page empty while extracting embeds', { pageUrl: safeUrlForLog(pageUrl), baseUrl });
        return null;
    }
    const iframen2 = html.match(/<div\b[^>]*id=["']iframen2["'][^>]*data-src=["']([^"']+)["'][^>]*>/i)?.[1];
    const iframen1 = html.match(/<div\b[^>]*id=["']iframen1["'][^>]*data-src=["']([^"']+)["'][^>]*>/i)?.[1];
    const fallbackLinks = pickHosterLinksFromUrls(collectHosterUrlsFromHtml(html, baseUrl));
    const links = {
        mixdropLink: normalizeRemoteUrl(iframen2 || fallbackLinks.mixdropLink || '', baseUrl),
        maxstreamLink: normalizeRemoteUrl(iframen1 || fallbackLinks.maxstreamLink || '', baseUrl)
    };
    cbDebug((links.mixdropLink || links.maxstreamLink) ? 'info' : 'warn', 'movie embed extraction result', {
        pageHost: safeHost(pageUrl),
        pagePath: safePath(pageUrl),
        hasIframen2: Boolean(iframen2),
        hasIframen1: Boolean(iframen1),
        fallbackHosterCount: collectHosterUrlsFromHtml(html, baseUrl).length,
        mixdropHost: safeHost(links.mixdropLink),
        mixdropPath: safePath(links.mixdropLink),
        maxstreamHost: safeHost(links.maxstreamLink),
        maxstreamPath: safePath(links.maxstreamLink),
        probe: htmlProbe(html)
    });
    return links;
}

function decodeSeasonAliasText(text) {
    return decodeHtml(text)
        .replace(/STAGIONE/gi, '')
        .replace(/ITA/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseSeasonRange(headerText) {
    const decoded = decodeHtml(headerText);
    const match = /STAGIONE\s*(\d{1,2})\s*A\s*(\d{1,2})/i.exec(decoded);
    if (!match) return null;
    const from = Number.parseInt(match[1], 10);
    const to = Number.parseInt(match[2], 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
}

function extractSpoilerSections(html) {
    const sections = [];
    const headerRe = /<div\b[^>]*class=["'][^"']*sp-head[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
    const sources = String(html || '');
    const headers = [];
    for (const headerMatch of sources.matchAll(headerRe)) {
        headers.push({
            text: headerMatch?.[1] || '',
            startIndex: headerMatch.index ?? 0,
            endIndex: (headerMatch.index ?? 0) + (headerMatch?.[0]?.length || 0)
        });
    }
    for (let i = 0; i < headers.length; i += 1) {
        const header = headers[i];
        const nextStart = i + 1 < headers.length ? headers[i + 1].startIndex : sources.length;
        const blockHtml = sources.slice(header.endIndex, nextStart);
        sections.push({ headerText: header.text, blockHtml });
    }
    if (!sections.length && sources.length) sections.push({ headerText: '', blockHtml: sources });
    return sections;
}

function findStandardEpisodeLinks(blockHtml, season, episode, baseUrl = null) {
    const safeSeason = Math.max(1, Number.parseInt(String(season || 1), 10) || 1);
    const safeEpisode = Math.max(1, Number.parseInt(String(episode || 1), 10) || 1);
    const seasonVariants = [...new Set([String(safeSeason), String(safeSeason).padStart(2, '0')])];
    const episodeVariants = [...new Set([String(safeEpisode), String(safeEpisode).padStart(2, '0')])];
    const sx = seasonVariants.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const ex = episodeVariants.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const separator = '(?:&#215;|&#x0?d7;|\\u00d7|×|x|X)';
    const html = String(blockHtml || '');
    const patterns = [
        `(?:^|>|\\b)(?:${sx})\\s*${separator}\\s*(?:${ex})[\\s\\S]{0,1600}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`,
        `(?:^|>|\\b)s\\s*0*${safeSeason}\\s*[-_. ]*e\\s*0*${safeEpisode}[\\s\\S]{0,1600}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`,
        `(?:^|>|\\b)stagione\\s*0*${safeSeason}\\D{0,35}episodio\\s*0*${safeEpisode}[\\s\\S]{0,1600}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`,
        `(?:^|>|\\b)ep(?:isodio)?\\.?\\s*0*${safeEpisode}\\b[\\s\\S]{0,1600}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`
    ];

    const out = [];
    const seen = new Set();
    const addAnchors = (anchors, source) => {
        for (const anchor of anchors) {
            const href = anchor?.href || '';
            if (!href || seen.has(href)) continue;
            seen.add(href);
            out.push(anchor);
        }
        cbDebug(anchors.length ? 'info' : 'warn', 'series episode pattern matched', {
            season: safeSeason,
            episode: safeEpisode,
            anchors: anchors.length,
            source: String(source || '').slice(0, 120),
            labels: anchors.slice(0, 8).map((anchor) => anchor.label),
            hosts: anchors.slice(0, 8).map((anchor) => safeHost(anchor.href))
        });
    };

    for (const source of patterns) {
        const re = new RegExp(source, 'ig');
        for (const match of html.matchAll(re)) {
            const chunk = match?.[0] || '';
            const anchors = collectAnchors(chunk, baseUrl);
            addAnchors(anchors, source);
            if (out.length >= 4) return out;
        }
    }

    if (!out.length) {
        const hosterUrls = collectHosterUrlsFromHtml(html, baseUrl);
        if (hosterUrls.length && envFlag('CB01_SERIES_HOSTER_FALLBACK_WITHOUT_EPISODE_MATCH', false)) {
            addAnchors(hosterUrls.map((href) => ({ href, label: safeHost(href) })), 'hoster_fallback_without_episode_match');
        }
    }

    if (!out.length) {
        cbDebug('warn', 'series episode pattern not found in standard section', {
            season: safeSeason,
            episode: safeEpisode,
            blockProbe: htmlProbe(html)
        });
    }
    return out;
}

function collectAnchors(html, baseUrl = null) {
    const anchors = [];
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig;
    for (const match of String(html || '').matchAll(re)) {
        const href = normalizeRemoteUrl(match?.[1] || '', baseUrl);
        const label = decodeHtml(match?.[2] || '');
        if (!href) continue;
        anchors.push({ href, label });
    }
    return anchors;
}

function pickEpisodeHostLinks(anchors) {
    if (!Array.isArray(anchors) || !anchors.length) return { mixdropLink: null, maxstreamLink: null };
    let mixdropLink = null;
    let maxstreamLink = null;
    for (const anchor of anchors) {
        const href = anchor?.href || '';
        const label = (anchor?.label || '').toLowerCase();
        if (!href) continue;
        if (!mixdropLink && (/mix\s*drop/i.test(label) || isMixdropUrl(href))) {
            mixdropLink = href;
            continue;
        }
        if (!maxstreamLink && (/max\s*stream/i.test(label) || isStayonlineUrl(href) || isCbUprotUrl(href) || isMaxstreamLikeUrl(href))) {
            maxstreamLink = href;
            continue;
        }
    }
    if (!mixdropLink && !maxstreamLink && anchors.length) {
        if (anchors.length >= 2) {
            maxstreamLink = anchors[0]?.href || null;
            mixdropLink = anchors[1]?.href || null;
        } else {
            maxstreamLink = anchors[0]?.href || null;
        }
        cbDebug('warn', 'series host links guessed by anchor order', {
            anchors: anchors.length,
            labels: anchors.slice(0, 8).map((anchor) => anchor.label),
            hosts: anchors.slice(0, 8).map((anchor) => safeHost(anchor.href))
        });
    }
    cbDebug((mixdropLink || maxstreamLink) ? 'info' : 'warn', 'series host link pick result', {
        anchors: anchors.length,
        mixdropHost: safeHost(mixdropLink),
        mixdropPath: safePath(mixdropLink),
        maxstreamHost: safeHost(maxstreamLink),
        maxstreamPath: safePath(maxstreamLink)
    });
    return { mixdropLink, maxstreamLink };
}

async function resolveAliasSeasonEpisode(client, baseUrl, alias, seasonAliasHeaderText, season, episode, config = {}) {
    if (!alias?.href) {
        cbDebug('warn', 'series alias skipped: missing href', { season, episode, seasonAliasHeaderText });
        return null;
    }
    cbDebug('info', 'series alias resolve start', {
        season,
        episode,
        aliasHeader: decodeHtml(seasonAliasHeaderText),
        aliasHost: safeHost(alias.href),
        aliasPath: safePath(alias.href),
        label: alias.label || ''
    });
    const cacheKey = [alias.href, season, episode];
    const cached = getCbCache('seasonAlias', cacheKey);
    if (cached) return cached;
    return withCbCoalescing('seasonAlias', cacheKey, async () => {
        const afterWait = getCbCache('seasonAlias', cacheKey);
        if (afterWait) return afterWait;
        const html = await fetchPageHtml(client, alias.href, baseUrl, 'seriesPage', config);
        if (!html) return null;
        const safeSeason = Math.max(1, Number.parseInt(String(season || 1), 10) || 1);
        const safeEpisode = Math.max(1, Number.parseInt(String(episode || 1), 10) || 1);
        const seasonVariants = [...new Set([String(safeSeason), String(safeSeason).padStart(2, '0')])];
        const episodeVariants = [...new Set([String(safeEpisode), String(safeEpisode).padStart(2, '0')])];
        const pairs = [];
        for (const sValue of seasonVariants) {
            for (const eValue of episodeVariants) {
                pairs.push(`S${sValue}E${eValue}`, `${sValue}x${eValue}`, `${sValue}×${eValue}`, `${sValue}&#215;${eValue}`, `${sValue}&#xD7;${eValue}`);
            }
        }
        const escapedPairs = pairs.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const re = new RegExp(`(?:${escapedPairs})[\\s\\S]{0,1800}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`, 'i');
        cbDebug('trace', 'series alias regex probe', { pairs: pairs.slice(0, 16), htmlProbe: htmlProbe(html) });
        const match = html.match(re);
        if (!match) {
            cbDebug('warn', 'series alias episode link not found', { season, episode, aliasHost: safeHost(alias.href), aliasPath: safePath(alias.href), pairs: pairs.slice(0, 16), probe: htmlProbe(html) });
            return null;
        }
        const anchors = collectAnchors(match[0] || '', baseUrl);
        const picked = pickEpisodeHostLinks(anchors);
        const out = picked.maxstreamLink ? picked : { maxstreamLink: normalizeRemoteUrl((anchors[0] && anchors[0].href) || '', baseUrl), mixdropLink: picked.mixdropLink || null };
        cbDebug((out.maxstreamLink || out.mixdropLink) ? 'info' : 'warn', 'series alias episode resolved', {
            season,
            episode,
            anchors: anchors.length,
            mixdropHost: safeHost(out.mixdropLink),
            maxstreamHost: safeHost(out.maxstreamLink),
            maxstreamPath: safePath(out.maxstreamLink)
        });
        setCbCache('seasonAlias', cacheKey, out, CB_CACHE_TTL.seasonAlias);
        return out;
    });
}

async function extractSeriesEpisodeLinks(client, pageUrl, baseUrl, season, episode, config = {}) {
    const html = await fetchPageHtml(client, pageUrl, baseUrl, 'seriesPage', config);
    if (!html) return null;
    const sections = extractSpoilerSections(html);
    cbDebug('info', 'series sections', {
        sections: sections.length,
        season,
        episode,
        pageHost: safeHost(pageUrl),
        pagePath: safePath(pageUrl),
        headers: sections.slice(0, 12).map((section) => decodeHtml(section.headerText).slice(0, 120))
    });

    let standardSection = null;
    let aliasAnchor = null;
    let aliasHeaderText = '';
    for (const section of sections) {
        const headerText = decodeHtml(section.headerText);
        if (!headerText) continue;
        if (!/STAGIONE/i.test(headerText)) continue;
        const decoded = decodeSeasonAliasText(headerText);
        if (decoded.includes('A') && /\d+\s*A\s*\d+/i.test(headerText)) {
            const range = parseSeasonRange(headerText);
            if (range && season >= range.from && season <= range.to) {
                const anchors = collectAnchors(section.blockHtml, baseUrl);
                if (anchors.length) {
                    aliasAnchor = anchors[0];
                    aliasHeaderText = headerText;
                    cbDebug('info', 'season range alias matched', { season, range, anchor: safeHost(aliasAnchor?.href) });
                }
            }
            continue;
        }
        const headerSeason = Number.parseInt(decoded.replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(headerSeason) && headerSeason === Number(season)) {
            standardSection = section;
            cbDebug('info', 'series standard season section matched', { season, headerText, blockProbe: htmlProbe(section.blockHtml) });
            break;
        }
    }

    if (!standardSection) {
        cbDebug('warn', 'series standard season section not found', {
            season,
            episode,
            availableHeaders: sections.slice(0, 20).map((section) => decodeHtml(section.headerText).slice(0, 120)),
            aliasCandidate: Boolean(aliasAnchor),
            aliasHost: safeHost(aliasAnchor?.href)
        });
    }

    if (standardSection) {
        const anchors = findStandardEpisodeLinks(standardSection.blockHtml, season, episode, baseUrl);
        if (anchors.length) {
            const picked = pickEpisodeHostLinks(anchors);
            cbDebug('info', 'series standard match', {
                season,
                episode,
                anchors: anchors.length,
                mixdrop: safeHost(picked.mixdropLink),
                maxstream: safeHost(picked.maxstreamLink)
            });
            return picked;
        }
    }

    if (aliasAnchor) {
        const aliasResult = await resolveAliasSeasonEpisode(client, baseUrl, aliasAnchor, aliasHeaderText, season, episode, config);
        if (aliasResult?.maxstreamLink || aliasResult?.mixdropLink) {
            cbDebug('info', 'series alias resolved', { season, episode, mixdrop: safeHost(aliasResult.mixdropLink), maxstream: safeHost(aliasResult.maxstreamLink), maxstreamPath: safePath(aliasResult.maxstreamLink) });
            return { mixdropLink: aliasResult.mixdropLink || null, maxstreamLink: aliasResult.maxstreamLink || null };
        }
        cbDebug('warn', 'series alias resolve failed', { season, episode, aliasHost: safeHost(aliasAnchor?.href), aliasPath: safePath(aliasAnchor?.href) });
    }

    cbDebug('warn', 'series episode links extraction failed', { season, episode, pageUrl: safeUrlForLog(pageUrl) });
    return null;
}

async function buildStreamsFromLinks({ mixdropLink, maxstreamLink } = {}, context) {
    const streams = [];
    const seen = new Set();

    cbDebug('info', 'build streams from links start', {
        title: context?.title || '',
        hasMixdrop: Boolean(mixdropLink),
        mixdropHost: safeHost(mixdropLink),
        mixdropPath: safePath(mixdropLink),
        hasMaxstream: Boolean(maxstreamLink),
        maxstreamHost: safeHost(maxstreamLink),
        maxstreamPath: safePath(maxstreamLink),
        hasMfp: Boolean(getMediaflowBase(context?.config || {}))
    });

    const tasks = [];

    if (mixdropLink) {
        tasks.push((async () => {
            try {
                const timeoutMs = envInt('CB01_MIXDROP_HOST_TIMEOUT_MS', 6000, 1000, 20000);
                const stream = await withTimeout(buildMixdropStream(mixdropLink, context), timeoutMs, 'CB01 MixDrop host');
                if (stream?.url && !seen.has(stream.url)) {
                    seen.add(stream.url);
                    streams.push(stream);
                    cbDebug('info', 'mixdrop stream accepted', { streamHost: safeHost(stream.url), streamPath: safePath(stream.url), name: stream.name, via: stream?.behaviorHints?.vortexMeta?.via || stream?.extraBehaviorHints?.vortexMeta?.via });
                } else {
                    cbDebug('warn', 'mixdrop stream empty or duplicate', { hasStream: Boolean(stream?.url), duplicate: Boolean(stream?.url && seen.has(stream.url)) });
                }
            } catch (error) {
                cbDebug('warn', 'mixdrop stream failed', { error: error?.message || String(error) });
            }
        })());
    }

    if (maxstreamLink) {
        tasks.push((async () => {
            try {
                const timeoutMs = envInt('CB01_MAXSTREAM_HOST_TIMEOUT_MS', 20000, 1000, 30000);
                const stream = await withTimeout(buildMaxstreamStream(maxstreamLink, context), timeoutMs, 'CB01 MaxStream host');
                if (stream?.url && !seen.has(stream.url)) {
                    seen.add(stream.url);
                    streams.push(stream);
                    cbDebug('info', 'maxstream stream accepted', { streamHost: safeHost(stream.url), streamPath: safePath(stream.url), name: stream.name, via: stream?.behaviorHints?.vortexMeta?.via || stream?.extraBehaviorHints?.vortexMeta?.via });
                } else {
                    cbDebug('warn', 'maxstream stream empty or duplicate', { hasStream: Boolean(stream?.url), duplicate: Boolean(stream?.url && seen.has(stream.url)) });
                }
            } catch (error) {
                cbDebug('warn', 'maxstream stream failed', { error: error?.message || String(error) });
            }
        })());
    }

    if (tasks.length) await Promise.allSettled(tasks);
    const sorted = streams.sort((a, b) => (a?.extra?._priority ?? a?._priority ?? 9) - (b?.extra?._priority ?? b?._priority ?? 9));
    cbDebug(sorted.length ? 'info' : 'warn', 'build streams from links done', {
        title: context?.title || '',
        streams: sorted.length,
        names: sorted.map((stream) => stream.name).slice(0, 8),
        urls: sorted.map((stream) => ({ host: safeHost(stream.url), path: safePath(stream.url) })).slice(0, 8)
    });
    return sorted;
}

async function searchCb01(meta = {}, config = {}, reqHost = null, options = {}) {
    if (config?.filters?.enableCb01 !== true) {
        cbDebug('trace', 'provider disabled by config', { enableCb01: config?.filters?.enableCb01 });
        return [];
    }

    const title = getMetaTitle(meta);
    if (!title) {
        cbDebug('warn', 'search aborted: missing title', { metaKeys: Object.keys(meta || {}).slice(0, 30) });
        return [];
    }

    const client = options.client || getDefaultClient();
    if (!client || typeof client.get !== 'function') {
        cbDebug('warn', 'search aborted: missing http client');
        return [];
    }

    const year = getMetaYear(meta);
    const isSeries = isSeriesMeta(meta);
    const { season, episode } = getSeasonEpisode(meta);
    if (isSeries && (!season || !episode)) {
        cbDebug('warn', 'search aborted: series missing season/episode', { title, season, episode, metaSeason: meta?.season, metaEpisode: meta?.episode });
        return [];
    }

    const bases = getBaseUrls();
    const proxyPoolState = CB_PROXY_POOL.entries().map((entry) => ({
        host: entry.host,
        failures: entry.failures,
        cooldownMs: Math.max(0, entry.cooldownUntil - Date.now())
    }));
    cbDebug('info', 'search start', {
        title,
        normalizedTitle: normalizeTitle(title),
        year: year || null,
        isSeries,
        season: season || null,
        episode: episode || null,
        bases,
        hasMfp: Boolean(getMediaflowBase(config)),
        mfpBase: getMediaflowBase(config) ? safeHost(getMediaflowBase(config)) : '',
        cbForwardProxy: Boolean(getCbForwardProxy(config)),
        cbForwardProxyHost: safeHost(getCbForwardProxy(config)),
        reqHost: reqHost || '',
        cb01Debug: isCbDebugEnabled(),
        cb01Trace: isCbTraceEnabled(),
        codeDefaults: {
            strategy: envString('CB01_IMPIT_STRATEGY', ''),
            useProxy: envFlag('CB01_USE_PROXY', false),
            proxyMaxAttempts: envInt('CB01_PROXY_MAX_ATTEMPTS', 0, 0, 10),
            totalBudgetSearchMs: envInt('CB01_SEARCH_TOTAL_BUDGET_MS', 13500, 3000, 30000)
        },
        proxyPool: proxyPoolState
    });

    const failureTrail = [];
    for (const baseUrl of bases) {
        const baseStartedAt = Date.now();
        cbDebug('info', 'base attempt start', { baseUrl, isSeries, title, season: season || null, episode: episode || null });
        try {
            if (isSeries) {
                const pageUrl = await searchSeriesUrl(client, baseUrl, title, year, config);
                if (!pageUrl) {
                    failureTrail.push({ baseUrl, stage: 'series_page_not_found', elapsedMs: Date.now() - baseStartedAt });
                    cbDebug('warn', 'series page not found', { title, year, baseUrl });
                    continue;
                }
                const links = await extractSeriesEpisodeLinks(client, pageUrl, baseUrl, season, episode, config);
                if (!links) {
                    failureTrail.push({ baseUrl, stage: 'series_episode_links_not_found', pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), elapsedMs: Date.now() - baseStartedAt });
                    cbDebug('warn', 'series episode links not found', { title, season, episode, pageUrl: safeUrlForLog(pageUrl) });
                    continue;
                }
                const displayTitle = `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                const streams = await buildStreamsFromLinks(links, {
                    client,
                    config,
                    title: displayTitle,
                    reqHost,
                    options: { ...options, baseUrl }
                });
                if (streams.length) {
                    cbDebug('info', 'base attempt success', { baseUrl, kind: 'series', streams: streams.length, elapsedMs: Date.now() - baseStartedAt });
                    return streams;
                }
                failureTrail.push({ baseUrl, stage: 'series_streams_empty', pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), elapsedMs: Date.now() - baseStartedAt });
            } else {
                const pageUrl = await searchMovieUrl(client, baseUrl, title, year, config);
                if (!pageUrl) {
                    failureTrail.push({ baseUrl, stage: 'movie_page_not_found', elapsedMs: Date.now() - baseStartedAt });
                    cbDebug('warn', 'movie page not found', { title, year, baseUrl });
                    continue;
                }
                const links = await extractMovieEmbedLinks(client, pageUrl, baseUrl, config);
                if (!links || (!links.mixdropLink && !links.maxstreamLink)) {
                    failureTrail.push({ baseUrl, stage: 'movie_embed_links_not_found', pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), elapsedMs: Date.now() - baseStartedAt });
                    cbDebug('warn', 'movie embed links not found', { title, year, pageUrl: safeUrlForLog(pageUrl) });
                    continue;
                }
                const displayTitle = year ? `${title} (${year})` : title;
                const streams = await buildStreamsFromLinks(links, {
                    client,
                    config,
                    title: displayTitle,
                    reqHost,
                    options: { ...options, baseUrl }
                });
                if (streams.length) {
                    cbDebug('info', 'base attempt success', { baseUrl, kind: 'movie', streams: streams.length, elapsedMs: Date.now() - baseStartedAt });
                    return streams;
                }
                failureTrail.push({ baseUrl, stage: 'movie_streams_empty', pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), elapsedMs: Date.now() - baseStartedAt });
            }
        } catch (error) {
            failureTrail.push({ baseUrl, stage: 'exception', error: error?.message || String(error), elapsedMs: Date.now() - baseStartedAt });
            cbDebug('warn', 'search base failed', { baseUrl, error: error?.message || String(error), stack: isCbTraceEnabled() ? error?.stack : undefined });
        }
    }

    cbDebug('warn', 'search finished with zero streams', {
        title,
        year: year || null,
        isSeries,
        season: season || null,
        episode: episode || null,
        basesTried: bases.length,
        failureTrail
    });
    return [];
}

module.exports = {
    searchCb01,
    searchCB01: searchCb01,
    __private: {
        decodeHtml,
        normalizeTitle,
        extractCardCandidates,
        parseSeasonRange,
        decodeSeasonAliasText,
        extractSpoilerSections,
        findStandardEpisodeLinks,
        pickEpisodeHostLinks,
        getBaseUrls,
        normalizeBaseUrl,
        isChallengePage,
        hasCbUsableHtml,
        isMixdropUrl,
        isStayonlineUrl,
        isMaxstreamLikeUrl,
        normalizeMixdropForExtractor,
        buildSearchQuery,
        buildSearchQueries,
        buildSearchUrls,
        stripCbNoiseFromTitle,
        slugifyCbTitle,
        extractCbPageHeadline,
        buildDirectMovieUrlCandidates,
        looksLikeDirectMoviePage,
        candidateYear,
        scoreCandidate,
        pickBestCandidate,
        collectHosterUrlsFromHtml,
        pickHosterLinksFromUrls,
        buildCbBrowserHeaders,
        buildKrakenUprotMaxstreamStream,
        buildForwardedMaxstreamTarget,
        buildMaxstreamStream,
        normalizeForwardProxyBase,
        getCbForwardProxy,
        getExplicitCbForwardProxy,
        buildCbForwardProxyUrl,
        toAxiosProxyConfig,
        fetchViaCbCurlCffi,
        isUsableCbCurlCffiResult,
        __setCurlCffiRunner: (runner) => { curlCffiRunnerOverride = runner; }
    }
};
