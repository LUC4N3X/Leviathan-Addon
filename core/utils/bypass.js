'use strict';

const axios = require('axios');
const antibotSignatures = require('./antibot_signatures');

const IMPIT_INSTANCE_CACHE = new Map();
let impitModulePromise = null;

const IMPIT_BROWSER_VERSIONS = Object.freeze({
    chrome: Object.freeze([142]),
    firefox: Object.freeze([144]),
    okhttp: Object.freeze([3, 4, 5])
});

const SUPPORTED_IMPIT_BROWSERS = new Set(Object.entries(IMPIT_BROWSER_VERSIONS).flatMap(([prefix, versions]) => [
    prefix,
    ...versions.map((version) => `${prefix}${version}`)
]));

const ACCEPT_DOCUMENT_CHROMIUM = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const ACCEPT_DOCUMENT_FIREFOX = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const ACCEPT_JSON = 'application/json, text/plain, */*';
const ACCEPT_SCRIPT = 'application/javascript,text/javascript,*/*;q=0.8';
const ACCEPT_MEDIA = '*/*';
const ACCEPT_HLS = 'application/vnd.apple.mpegurl, application/x-mpegURL, */*';
const ACCEPT_DASH = 'application/dash+xml, */*';

const DEFAULT_FINGERPRINT_POOL = Object.freeze([
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="142", "Not A(Brand";v="8", "Chromium";v="142"',
        secChUaMobile: '?0',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
        browserType: 'edge',
        secChUa: '"Microsoft Edge";v="142", "Chromium";v="142", "Not(A:Brand";v="8"',
        secChUaMobile: '?0',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="142", "Not A(Brand";v="8", "Chromium";v="142"',
        secChUaMobile: '?0',
        secChUaPlatform: '"macOS"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
        browserType: 'firefox',
        secChUa: null,
        secChUaMobile: null,
        secChUaPlatform: null,
        acceptLanguage: 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="142", "Not A(Brand";v="8", "Chromium";v="142"',
        secChUaMobile: '?0',
        secChUaPlatform: '"Linux"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="142", "Not A(Brand";v="8", "Chromium";v="142"',
        secChUaMobile: '?0',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'en-US,en;q=0.9,it;q=0.8'
    })
]);

const DEFAULT_STICKY_FINGERPRINT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_COOKIE_TTL_MS = 45 * 60 * 1000;
const DEFAULT_CIRCUIT_BREAKER_RESET_MS = 90 * 1000;
const DEFAULT_CIRCUIT_BREAKER_FAILURES = 5;
const DEFAULT_SINGLE_FLIGHT_TTL_MS = 0;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([300, 700, 1500]);
const DEFAULT_IMPIT_BROWSER_STICKY_TTL_MS = 45 * 60 * 1000;
const DEFAULT_IMPIT_ROTATION_STATUSES = Object.freeze([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const DEFAULT_IMPIT_BROWSER_FALLBACKS = Object.freeze([
    'chrome142',
    'firefox144',
    'okhttp4'
]);

const stickyFingerprintCache = new Map();
const impitGoodBrowserCache = new Map();
const impitBadBrowserCache = new Map();

function now() {
    return Date.now();
}

function safeString(value) {
    if (value == null) return '';
    return String(value);
}

function normalizeHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        out[String(key).toLowerCase()] = value;
    }
    return out;
}

function getHost(input) {
    try {
        return new URL(input).hostname.toLowerCase();
    } catch (_) {
        return null;
    }
}

function getOrigin(input) {
    try {
        return new URL(input).origin;
    } catch (_) {
        return null;
    }
}

function sameOrigin(a, b) {
    const originA = getOrigin(a);
    const originB = getOrigin(b);
    return Boolean(originA && originB && originA === originB);
}

function compactHeaderObject(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null || value === '') continue;
        out[key] = value;
    }
    return out;
}

function getRandomFingerprint(pool = DEFAULT_FINGERPRINT_POOL) {
    const items = Array.isArray(pool) && pool.length ? pool : DEFAULT_FINGERPRINT_POOL;
    return items[Math.floor(Math.random() * items.length)];
}

function getStickyFingerprintForUrl(url, ttlMs = DEFAULT_STICKY_FINGERPRINT_TTL_MS, pool = DEFAULT_FINGERPRINT_POOL) {
    const host = getHost(url);
    if (!host) return getRandomFingerprint(pool);

    const cached = stickyFingerprintCache.get(host);
    const expiresAt = cached?.expiresAt || 0;
    if (cached?.fingerprint && expiresAt > now()) return cached.fingerprint;

    const fingerprint = getRandomFingerprint(pool);
    stickyFingerprintCache.set(host, {
        fingerprint,
        expiresAt: now() + Math.max(1000, Number(ttlMs) || DEFAULT_STICKY_FINGERPRINT_TTL_MS)
    });
    return fingerprint;
}

function rememberGoodImpitBrowser(url, browser, ttlMs = DEFAULT_IMPIT_BROWSER_STICKY_TTL_MS) {
    const host = getHost(url);
    const selectedBrowser = safeString(browser).trim();
    if (!host || !selectedBrowser) return false;
    impitGoodBrowserCache.set(host, {
        browser: selectedBrowser,
        expiresAt: now() + Math.max(10_000, Number(ttlMs) || DEFAULT_IMPIT_BROWSER_STICKY_TTL_MS)
    });
    return true;
}

function getGoodImpitBrowser(url) {
    const host = getHost(url);
    if (!host) return null;
    const cached = impitGoodBrowserCache.get(host);
    if (!cached) return null;
    if (cached.expiresAt <= now()) {
        impitGoodBrowserCache.delete(host);
        return null;
    }
    return cached.browser || null;
}

function clearGoodImpitBrowser(url = null) {
    if (!url) {
        impitGoodBrowserCache.clear();
        return true;
    }
    const host = getHost(url);
    if (!host) return false;
    return impitGoodBrowserCache.delete(host);
}

function rememberBadImpitBrowser(url, browser, ttlMs = 10 * 60 * 1000) {
    const host = getHost(url);
    const normalized = safeString(browser).trim();
    if (!host || !normalized) return false;
    const current = impitBadBrowserCache.get(host) || { browsers: new Map() };
    current.browsers.set(normalized, now() + Math.max(30_000, Number(ttlMs) || 10 * 60 * 1000));
    impitBadBrowserCache.set(host, current);
    return true;
}

function getBadImpitBrowsers(url = null) {
    const host = getHost(url);
    if (!host) return new Set();
    const current = impitBadBrowserCache.get(host);
    if (!current?.browsers) return new Set();

    const ts = now();
    const out = new Set();
    for (const [browser, expiresAt] of current.browsers.entries()) {
        if (Number(expiresAt) > ts) out.add(browser);
        else current.browsers.delete(browser);
    }
    if (current.browsers.size === 0) impitBadBrowserCache.delete(host);
    return out;
}

function clearBadImpitBrowser(url = null) {
    if (!url) {
        impitBadBrowserCache.clear();
        return true;
    }
    const host = getHost(url);
    if (!host) return false;
    return impitBadBrowserCache.delete(host);
}

function clearStickyFingerprints(url = null) {
    if (!url) {
        stickyFingerprintCache.clear();
        return true;
    }
    const host = getHost(url);
    if (!host) return false;
    return stickyFingerprintCache.delete(host);
}

function isFirefoxFingerprint(fp = {}) {
    return safeString(fp.browserType || fp.family || fp.browser || fp.name).toLowerCase().includes('firefox')
        || /firefox\//i.test(safeString(fp.userAgent || fp.ua));
}

function isChromiumFingerprint(fp = {}) {
    const type = safeString(fp.browserType || fp.family || fp.browser || fp.name).toLowerCase();
    const ua = safeString(fp.userAgent || fp.ua);
    if (isFirefoxFingerprint(fp)) return false;
    return type.includes('chrome') || type.includes('edge') || /(?:Chrome|Chromium|CriOS|Edg)\//i.test(ua);
}

function requestAcceptForContext(context, url = '') {
    const selected = normalizeRequestContext(context);
    const value = safeString(url);
    if (selected === 'json') return ACCEPT_JSON;
    if (selected === 'script') return ACCEPT_SCRIPT;
    if (selected === 'playlist' || /\.m3u8(?:[?#]|$)/i.test(value)) return ACCEPT_HLS;
    if (selected === 'dash' || /\.mpd(?:[?#]|$)/i.test(value)) return ACCEPT_DASH;
    if (selected === 'media') return ACCEPT_MEDIA;
    return null;
}

function normalizeRequestContext(context = 'document') {
    const value = safeString(context || 'document').trim().toLowerCase();
    if (['api', 'json', 'ajax', 'xhr', 'fetch'].includes(value)) return 'json';
    if (['iframe', 'embed', 'player'].includes(value)) return 'iframe';
    if (['playlist', 'hls', 'm3u8'].includes(value)) return 'playlist';
    if (['dash', 'mpd'].includes(value)) return 'dash';
    if (['media', 'video', 'segment', 'stream'].includes(value)) return 'media';
    if (['script', 'js'].includes(value)) return 'script';
    return 'document';
}

function buildBrowserHeaders(fp = getRandomFingerprint(), extra = {}) {
    const firefox = isFirefoxFingerprint(fp);
    const headers = {
        'User-Agent': fp.userAgent,
        Accept: firefox ? ACCEPT_DOCUMENT_FIREFOX : ACCEPT_DOCUMENT_CHROMIUM,
        'Accept-Language': fp.acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    };

    if (isChromiumFingerprint(fp)) {
        Object.assign(headers, {
            'sec-ch-ua': fp.secChUa,
            'sec-ch-ua-mobile': fp.secChUaMobile || (/Mobile|Android/i.test(fp.userAgent || '') ? '?1' : '?0'),
            'sec-ch-ua-platform': fp.secChUaPlatform
        });
    } else if (firefox) {
        headers.TE = 'trailers';
    }

    return compactHeaderObject(Object.assign(headers, extra));
}

function inferRequestContext(url, fallback = 'document') {
    const value = safeString(url).toLowerCase().split('?')[0];
    if (/\.m3u8$/i.test(value) || /\/playlist\//i.test(value)) return 'playlist';
    if (/\.mpd$/i.test(value)) return 'dash';
    if (/\.(ts|m4s|mp4|mkv|avi|mov|webm|m4v|mp3|m4a|aac|vtt|srt|key)$/.test(value)) return 'media';
    if (/\.(json)$/.test(value) || /\/api\//i.test(value)) return 'json';
    if (/\.(js)$/.test(value)) return 'script';
    if (/embed|iframe|player/i.test(value)) return 'iframe';
    return normalizeRequestContext(fallback || 'document');
}

function getFetchSite(url, referer) {
    if (!referer) return 'none';
    if (sameOrigin(url, referer)) return 'same-origin';
    return 'cross-site';
}

function hasExplicitXRequestedWith(headers = {}) {
    return Object.keys(headers || {}).some((key) => safeString(key).toLowerCase() === 'x-requested-with');
}

function buildContextHeaders(url = null, context = null, extra = {}, fp = null) {
    if (context && typeof context === 'object' && !Array.isArray(context)) {
        extra = context;
        context = null;
    }

    const selectedContext = normalizeRequestContext(context || inferRequestContext(url, 'document'));
    const fingerprint = fp || (url ? getStickyFingerprintForUrl(url) : getRandomFingerprint());
    const referer = extra?.Referer || extra?.referer || extra?.referrer || null;
    const headers = buildBrowserHeaders(fingerprint, extra);
    const site = extra?.['Sec-Fetch-Site'] || extra?.['sec-fetch-site'] || getFetchSite(url, referer);
    const explicitXrw = hasExplicitXRequestedWith(extra);

    if (selectedContext === 'iframe') {
        Object.assign(headers, {
            Accept: fingerprint.acceptDocument || (isFirefoxFingerprint(fingerprint) ? ACCEPT_DOCUMENT_FIREFOX : ACCEPT_DOCUMENT_CHROMIUM),
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': site,
            'Upgrade-Insecure-Requests': '1'
        });
        delete headers['Sec-Fetch-User'];
    } else if (selectedContext === 'json') {
        Object.assign(headers, {
            Accept: ACCEPT_JSON,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': site
        });
        if (context === 'xhr' || explicitXrw) headers['X-Requested-With'] = extra['X-Requested-With'] || extra['x-requested-with'] || 'XMLHttpRequest';
        delete headers['Sec-Fetch-User'];
        delete headers['Upgrade-Insecure-Requests'];
    } else if (selectedContext === 'script') {
        Object.assign(headers, {
            Accept: ACCEPT_SCRIPT,
            'Sec-Fetch-Dest': 'script',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': site
        });
        delete headers['Cache-Control'];
        delete headers['Pragma'];
        delete headers['Sec-Fetch-User'];
        delete headers['Upgrade-Insecure-Requests'];
    } else if (selectedContext === 'playlist' || selectedContext === 'dash' || selectedContext === 'media') {
        Object.assign(headers, {
            Accept: requestAcceptForContext(selectedContext, url) || ACCEPT_MEDIA,
            'Sec-Fetch-Dest': selectedContext === 'media' ? 'video' : 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': site
        });
        delete headers['Cache-Control'];
        delete headers['Pragma'];
        delete headers['Sec-Fetch-User'];
        delete headers['Upgrade-Insecure-Requests'];
    } else {
        Object.assign(headers, {
            Accept: fingerprint.acceptDocument || (isFirefoxFingerprint(fingerprint) ? ACCEPT_DOCUMENT_FIREFOX : ACCEPT_DOCUMENT_CHROMIUM),
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': site,
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });
    }

    return compactHeaderObject(Object.assign(headers, extra));
}

function pickNearestImpitBrowser(prefix, version, fallback) {
    const versions = IMPIT_BROWSER_VERSIONS[prefix] || [];
    const parsed = Number.parseInt(String(version || ''), 10);
    if (!Number.isInteger(parsed) || !versions.length) return fallback;

    const selected = versions.reduce((best, candidate) =>
        Math.abs(candidate - parsed) < Math.abs(best - parsed) ? candidate : best
    , versions[0]);
    return `${prefix}${selected}`;
}

function normalizeImpitBrowser(browser, fallback = 'chrome142') {
    const value = safeString(browser).trim().toLowerCase();
    if (!value) return fallback;
    if (SUPPORTED_IMPIT_BROWSERS.has(value)) return value;

    const match = value.match(/^(chrome|edge|firefox|okhttp)(\d+)$/);
    if (match) {
        const family = match[1] === 'edge' ? 'chrome' : match[1];
        return pickNearestImpitBrowser(family, match[2], fallback);
    }

    return fallback;
}

function getImpitBrowserForFingerprint(fp = null) {
    const browserType = safeString(fp?.browserType || fp?.family || fp?.browser || fp?.name).toLowerCase();
    const userAgent = safeString(fp?.userAgent || fp?.ua).toLowerCase();

    if (browserType.includes('firefox') || userAgent.includes('firefox/')) {
        return pickNearestImpitBrowser('firefox', userAgent.match(/firefox\/(\d+)/i)?.[1], 'firefox144');
    }
    if (browserType.includes('okhttp') || userAgent.includes('okhttp/')) {
        return pickNearestImpitBrowser('okhttp', userAgent.match(/okhttp\/(\d+)/i)?.[1], 'okhttp4');
    }

    const chromeVersion =
        userAgent.match(/(?:chrome|crios|chromium)\/(\d+)/i)?.[1] ||
        userAgent.match(/edg\/(\d+)/i)?.[1];
    return pickNearestImpitBrowser('chrome', chromeVersion, 'chrome142');
}

function normalizeBrowserList(list = []) {
    const out = [];
    for (const item of Array.isArray(list) ? list : [list]) {
        const browser = normalizeImpitBrowser(item, '');
        if (browser && !out.includes(browser)) out.push(browser);
    }
    return out;
}

function getImpitBrowserCandidatesForFingerprint(fp = null, options = {}) {
    const url = options.url || options.hostBiasUrl || null;
    const explicit = normalizeBrowserList(options.browser || options.preferredBrowser);
    const sticky = normalizeBrowserList(getGoodImpitBrowser(url));
    const inferred = normalizeBrowserList(getImpitBrowserForFingerprint(fp));
    const custom = normalizeBrowserList(options.browserFallbacks || options.fallbackBrowsers || []);
    const defaults = normalizeBrowserList(DEFAULT_IMPIT_BROWSER_FALLBACKS);

    const candidates = normalizeBrowserList([
        ...explicit,
        ...sticky,
        ...inferred,
        ...custom,
        ...defaults
    ]);
    const badBrowsers = getBadImpitBrowsers(url);
    const filtered = candidates.filter((browser) => !badBrowsers.has(browser));
    return filtered.length > 0 ? filtered : candidates;
}

function deleteHeaderCaseInsensitive(headers, name) {
    const target = safeString(name).toLowerCase();
    for (const key of Object.keys(headers || {})) {
        if (safeString(key).toLowerCase() === target) delete headers[key];
    }
}

function setHeaderCaseInsensitive(headers, name, value) {
    deleteHeaderCaseInsensitive(headers, name);
    if (value !== undefined && value !== null && value !== '') headers[name] = value;
}

const PLATFORM_PATTERNS = Object.freeze([
    { regex: /Macintosh|Mac OS X/i, platform: '"macOS"', uaToken: 'Macintosh; Intel Mac OS X 10_15_7' },
    { regex: /CrOS/i, platform: '"Chrome OS"', uaToken: 'X11; CrOS x86_64 14541.0.0' },
    { regex: /Android/i, platform: '"Android"', uaToken: 'Linux; Android 13; Pixel 7' },
    { regex: /Linux/i, platform: '"Linux"', uaToken: 'X11; Linux x86_64' },
    { regex: /Windows/i, platform: '"Windows"', uaToken: 'Windows NT 10.0; Win64; x64' }
]);

function detectPlatformFromUserAgent(userAgent = '') {
    for (const entry of PLATFORM_PATTERNS) {
        if (entry.regex.test(userAgent)) return entry;
    }
    return PLATFORM_PATTERNS[PLATFORM_PATTERNS.length - 1];
}

function getHeaderCaseInsensitive(headers = {}, name = '') {
    const target = safeString(name).toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (safeString(key).toLowerCase() === target) return value;
    }
    return undefined;
}

function inferContextFromHeaders(headers = {}) {
    const dest = safeString(getHeaderCaseInsensitive(headers, 'Sec-Fetch-Dest')).toLowerCase();
    const mode = safeString(getHeaderCaseInsensitive(headers, 'Sec-Fetch-Mode')).toLowerCase();
    const accept = safeString(getHeaderCaseInsensitive(headers, 'Accept')).toLowerCase();
    if (dest === 'iframe') return 'iframe';
    if (dest === 'script') return 'script';
    if (dest === 'video') return 'media';
    if (dest === 'empty' && accept.includes('mpegurl')) return 'playlist';
    if (dest === 'empty' && accept.includes('dash+xml')) return 'dash';
    if (dest === 'empty' && (accept.includes('json') || mode === 'cors')) return 'json';
    if (accept.includes('json')) return 'json';
    if (accept.includes('mpegurl')) return 'playlist';
    if (accept.includes('dash+xml')) return 'dash';
    if (accept === '*/*') return 'media';
    return 'document';
}

function applyAlignedContextHeaders(out, context, defaults = {}) {
    const selected = normalizeRequestContext(context);
    const site = getHeaderCaseInsensitive(out, 'Sec-Fetch-Site') || defaults.site || 'none';
    const accept = requestAcceptForContext(selected) || defaults.documentAccept || ACCEPT_DOCUMENT_CHROMIUM;

    if (selected === 'json') {
        setHeaderCaseInsensitive(out, 'Accept', accept);
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Dest', 'empty');
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Mode', 'cors');
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Site', site);
        deleteHeaderCaseInsensitive(out, 'Sec-Fetch-User');
        deleteHeaderCaseInsensitive(out, 'Upgrade-Insecure-Requests');
        return;
    }

    if (selected === 'script') {
        setHeaderCaseInsensitive(out, 'Accept', accept);
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Dest', 'script');
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Mode', 'no-cors');
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Site', site);
        deleteHeaderCaseInsensitive(out, 'Sec-Fetch-User');
        deleteHeaderCaseInsensitive(out, 'Upgrade-Insecure-Requests');
        return;
    }

    if (selected === 'playlist' || selected === 'dash' || selected === 'media') {
        setHeaderCaseInsensitive(out, 'Accept', accept || ACCEPT_MEDIA);
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Dest', selected === 'media' ? 'video' : 'empty');
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Mode', 'cors');
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Site', site);
        deleteHeaderCaseInsensitive(out, 'Sec-Fetch-User');
        deleteHeaderCaseInsensitive(out, 'Upgrade-Insecure-Requests');
        return;
    }

    if (selected === 'iframe') {
        setHeaderCaseInsensitive(out, 'Accept', defaults.documentAccept || ACCEPT_DOCUMENT_CHROMIUM);
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Dest', 'iframe');
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Mode', 'navigate');
        setHeaderCaseInsensitive(out, 'Sec-Fetch-Site', site);
        deleteHeaderCaseInsensitive(out, 'Sec-Fetch-User');
        setHeaderCaseInsensitive(out, 'Upgrade-Insecure-Requests', '1');
        return;
    }

    setHeaderCaseInsensitive(out, 'Accept', defaults.documentAccept || ACCEPT_DOCUMENT_CHROMIUM);
    setHeaderCaseInsensitive(out, 'Sec-Fetch-Dest', 'document');
    setHeaderCaseInsensitive(out, 'Sec-Fetch-Mode', 'navigate');
    setHeaderCaseInsensitive(out, 'Sec-Fetch-Site', site);
    setHeaderCaseInsensitive(out, 'Sec-Fetch-User', '?1');
    setHeaderCaseInsensitive(out, 'Upgrade-Insecure-Requests', '1');
}

function alignHeadersForImpitBrowser(headers = {}, browser = '') {
    const selected = safeString(browser).toLowerCase();
    const out = { ...(headers || {}) };
    const version = Number.parseInt(selected.match(/(\d+)/)?.[1] || '', 10);
    const existingUa = safeString(getHeaderCaseInsensitive(out, 'User-Agent') || '');
    const existingPlatformHeader = safeString(getHeaderCaseInsensitive(out, 'sec-ch-ua-platform') || '').trim();
    const detected = detectPlatformFromUserAgent(existingUa);
    const platformLabel = existingPlatformHeader || detected.platform;
    const isMobile = /Mobile|Android/i.test(existingUa) ? '?1' : '?0';
    const context = inferContextFromHeaders(out);

    if (selected.startsWith('firefox')) {
        const major = Number.isInteger(version) ? version : 144;
        const ffPlatformToken = detected.platform === '"macOS"'
            ? 'Macintosh; Intel Mac OS X 10.15'
            : detected.platform === '"Linux"'
                ? 'X11; Linux x86_64'
                : 'Windows NT 10.0; Win64; x64';
        const ffUa = `Mozilla/5.0 (${ffPlatformToken}; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`;
        setHeaderCaseInsensitive(out, 'User-Agent', ffUa);
        setHeaderCaseInsensitive(out, 'Accept-Language', getHeaderCaseInsensitive(out, 'Accept-Language') || 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3');
        setHeaderCaseInsensitive(out, 'Accept-Encoding', 'gzip, deflate, br, zstd');
        deleteHeaderCaseInsensitive(out, 'sec-ch-ua');
        deleteHeaderCaseInsensitive(out, 'sec-ch-ua-mobile');
        deleteHeaderCaseInsensitive(out, 'sec-ch-ua-platform');
        deleteHeaderCaseInsensitive(out, 'Priority');
        applyAlignedContextHeaders(out, context, { documentAccept: ACCEPT_DOCUMENT_FIREFOX });
        setHeaderCaseInsensitive(out, 'TE', 'trailers');
        return compactHeaderObject(out);
    }

    if (selected.startsWith('chrome') || selected.startsWith('edge')) {
        const major = Number.isInteger(version) ? version : 142;
        const edgeLike = selected.startsWith('edge') || /\bEdg\//i.test(existingUa);
        const brandStr = edgeLike
            ? `"Microsoft Edge";v="${major}", "Chromium";v="${major}", "Not(A:Brand";v="8"`
            : `"Google Chrome";v="${major}", "Not A(Brand";v="8", "Chromium";v="${major}"`;
        const ua = edgeLike
            ? `Mozilla/5.0 (${detected.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`
            : `Mozilla/5.0 (${detected.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
        setHeaderCaseInsensitive(out, 'User-Agent', ua);
        setHeaderCaseInsensitive(out, 'Accept-Language', getHeaderCaseInsensitive(out, 'Accept-Language') || 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7');
        setHeaderCaseInsensitive(out, 'Accept-Encoding', 'gzip, deflate, br, zstd');
        setHeaderCaseInsensitive(out, 'sec-ch-ua', brandStr);
        setHeaderCaseInsensitive(out, 'sec-ch-ua-mobile', isMobile);
        setHeaderCaseInsensitive(out, 'sec-ch-ua-platform', platformLabel);
        applyAlignedContextHeaders(out, context, { documentAccept: ACCEPT_DOCUMENT_CHROMIUM });
        if (normalizeRequestContext(context) === 'document') setHeaderCaseInsensitive(out, 'Priority', 'u=0, i');
        else deleteHeaderCaseInsensitive(out, 'Priority');
        deleteHeaderCaseInsensitive(out, 'TE');
        return compactHeaderObject(out);
    }

    if (selected.startsWith('okhttp')) {
        const major = Number.isInteger(version) ? version : 4;
        setHeaderCaseInsensitive(out, 'User-Agent', `okhttp/${major}.12.0`);
        setHeaderCaseInsensitive(out, 'Accept', '*/*');
        deleteHeaderCaseInsensitive(out, 'sec-ch-ua');
        deleteHeaderCaseInsensitive(out, 'sec-ch-ua-mobile');
        deleteHeaderCaseInsensitive(out, 'sec-ch-ua-platform');
        deleteHeaderCaseInsensitive(out, 'Sec-Fetch-Dest');
        deleteHeaderCaseInsensitive(out, 'Sec-Fetch-Mode');
        deleteHeaderCaseInsensitive(out, 'Sec-Fetch-Site');
        deleteHeaderCaseInsensitive(out, 'Sec-Fetch-User');
        deleteHeaderCaseInsensitive(out, 'Upgrade-Insecure-Requests');
        deleteHeaderCaseInsensitive(out, 'Priority');
    }

    return compactHeaderObject(out);
}

function headersToPlainObject(headers = {}) {
    const out = {};
    if (!headers) return out;

    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        for (const [key, value] of headers.entries()) out[key.toLowerCase()] = value;
        const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
        if (setCookies?.length) out['set-cookie'] = setCookies;
        return out;
    }

    if (typeof headers.entries === 'function') {
        for (const [key, value] of headers.entries()) out[String(key).toLowerCase()] = value;
        return out;
    }

    for (const [key, value] of Object.entries(headers || {})) {
        out[String(key).toLowerCase()] = value;
    }
    return out;
}

async function loadImpitModule() {
    if (!impitModulePromise) {
        impitModulePromise = import('impit').catch((error) => {
            impitModulePromise = null;
            throw error;
        });
    }
    return impitModulePromise;
}

function buildImpitClientKey(options = {}) {
    const browser = normalizeImpitBrowser(options.browser || 'chrome142', 'chrome142');
    return JSON.stringify({
        browser,
        ignoreTlsErrors: options.ignoreTlsErrors === true,
        vanillaFallback: options.vanillaFallback !== false,
        followRedirects: options.followRedirects !== false,
        maxRedirects: Math.max(0, Number(options.maxRedirects ?? 10) || 0),
        proxyUrl: options.proxyUrl || null,
        http3: options.http3 === true,
        localAddress: options.localAddress || null
    });
}

async function getImpitClient(options = {}) {
    const browser = normalizeImpitBrowser(options.browser || 'chrome142', 'chrome142');
    const clientOptions = {
        browser,
        ignoreTlsErrors: options.ignoreTlsErrors === true,
        vanillaFallback: options.vanillaFallback !== false,
        followRedirects: options.followRedirects !== false,
        maxRedirects: Math.max(0, Number(options.maxRedirects ?? 10) || 0),
        proxyUrl: options.proxyUrl || undefined,
        http3: options.http3 === true,
        localAddress: options.localAddress || undefined
    };
    const cacheKey = buildImpitClientKey(clientOptions);
    const cached = IMPIT_INSTANCE_CACHE.get(cacheKey);
    if (cached) return cached;

    try {
        const mod = await loadImpitModule();
        const Impit = mod.Impit || mod.default?.Impit || mod.default || mod.ImpitWrapper;
        if (typeof Impit !== 'function') throw new Error('Impit export not found');
        const client = new Impit(clientOptions);
        IMPIT_INSTANCE_CACHE.set(cacheKey, client);
        return client;
    } catch (error) {
        if (options.failSoft) return null;
        throw error;
    }
}

function resolveImpitTimeout(timeout) {
    const value = typeof timeout === 'object' && timeout
        ? timeout.request || timeout.timeout || timeout.ms
        : timeout;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveImpitRedirect(options = {}) {
    if (options.redirect === 'follow' || options.redirect === 'manual' || options.redirect === 'error') return options.redirect;
    return options.followRedirect === false ? 'manual' : 'follow';
}

async function requestWithImpit(input, config = {}) {
    const options = typeof input === 'string' || input instanceof URL
        ? { ...config, url: String(input) }
        : { ...(input || {}), ...config };
    const url = options.url || options.href;
    if (!url) throw new Error('Impit request missing url');

    const timeout = resolveImpitTimeout(options.timeout);
    const method = safeString(options.method || 'GET').toUpperCase() || 'GET';
    const selectedBrowser = normalizeImpitBrowser(options.browser || getImpitBrowserForFingerprint(options.fingerprint || options.fp), 'chrome142');
    const requestHeaders = options.alignHeaders === false
        ? compactHeaderObject(headersToPlainObject(options.headers || {}))
        : compactHeaderObject(alignHeadersForImpitBrowser(headersToPlainObject(options.headers || {}), selectedBrowser));
    const client = await getImpitClient({
        browser: selectedBrowser,
        ignoreTlsErrors: options.ignoreTlsErrors ?? options.https?.rejectUnauthorized === false,
        vanillaFallback: options.vanillaFallback,
        followRedirects: options.followRedirect !== false,
        maxRedirects: options.maxRedirects,
        proxyUrl: options.proxyUrl,
        http3: options.http3,
        localAddress: options.localAddress,
        failSoft: options.failSoft
    });
    if (!client) return null;

    const body = method === 'GET' || method === 'HEAD'
        ? undefined
        : options.body ?? options.data;
    const retryLimit = Math.max(0, Number(options.retry?.limit ?? options.retries ?? 0) || 0);
    let lastError = null;

    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        try {
            const response = await client.fetch(String(url), {
                method,
                headers: requestHeaders,
                body,
                timeout,
                forceHttp3: options.forceHttp3 === true,
                signal: options.signal,
                redirect: resolveImpitRedirect(options)
            });

            let responseBody;
            if (options.responseType === 'buffer' || options.responseType === 'arraybuffer') {
                responseBody = Buffer.from(await response.arrayBuffer());
            } else {
                responseBody = await response.text();
            }

            return {
                body: responseBody,
                data: responseBody,
                statusCode: response.status,
                status: response.status,
                statusMessage: response.statusText,
                headers: headersToPlainObject(response.headers),
                url: response.url || String(url),
                ok: response.ok,
                impitBrowser: selectedBrowser
            };
        } catch (error) {
            lastError = error;
            if (attempt >= retryLimit || !isRetryableError(error)) throw error;
            await sleep(getRetryDelay(attempt, options.retry || {}));
        }
    }

    throw lastError;
}

function shouldRotateImpitResponse(response, options = {}) {
    if (!response) return true;
    const status = Number(response.statusCode || response.status || 0);
    const rotateStatuses = new Set(Array.isArray(options.retryOnStatuses) && options.retryOnStatuses.length
        ? options.retryOnStatuses.map(Number)
        : DEFAULT_IMPIT_ROTATION_STATUSES);
    const classification = classifyBlockResponse(response.body ?? response.data, status, response.headers || {});

    if (classification.blocked && classification.retryable) return true;
    if (options.retryOnChallenge !== false && isCloudflareChallenge(response.body ?? response.data, status, response.headers || {})) return true;
    return rotateStatuses.has(status);
}

async function requestWithImpitRotating(input, config = {}) {
    const options = typeof input === 'string' || input instanceof URL
        ? { ...config, url: String(input) }
        : { ...(input || {}), ...config };
    const url = options.url || options.href;
    if (!url) throw new Error('Impit request missing url');

    const candidates = getImpitBrowserCandidatesForFingerprint(options.fingerprint || options.fp, {
        url,
        browser: options.browser,
        browserFallbacks: options.browserFallbacks || options.fallbackBrowsers
    });
    const maxBrowserAttempts = Math.max(1, Math.min(
        Number(options.maxBrowserAttempts || options.impitMaxAttempts || 1) || 1,
        candidates.length
    ));
    const startedAt = now();
    const baseTimeout = resolveImpitTimeout(options.timeout);
    const totalTimeout = Math.max(0, Number(options.totalTimeoutMs || options.impitTotalTimeoutMs || 0) || 0);
    const browserStickyTtlMs = Number(options.browserStickyTtlMs || DEFAULT_IMPIT_BROWSER_STICKY_TTL_MS);

    let lastError = null;
    let lastResponse = null;
    let attempts = 0;

    for (const browser of candidates.slice(0, maxBrowserAttempts)) {
        if (options.signal?.aborted) break;
        if (totalTimeout) {
            const remainingMs = totalTimeout - (now() - startedAt);
            if (remainingMs < 900) break;
            options.timeout = baseTimeout ? Math.max(900, Math.min(baseTimeout, remainingMs - 75)) : Math.max(900, remainingMs - 75);
        }

        attempts += 1;
        try {
            const response = await requestWithImpit({
                ...options,
                browser,
                headers: alignHeadersForImpitBrowser(headersToPlainObject(options.headers || {}), browser),
                alignHeaders: false,
                retry: options.innerRetry || { limit: 0 },
                retries: 0
            });
            if (!response) continue;

            response.impitBrowser = browser;
            response.impitAttempts = attempts;
            lastResponse = response;

            const rotateResponse = shouldRotateImpitResponse(response, options);
            if (!rotateResponse || attempts >= maxBrowserAttempts) {
                if (!rotateResponse) {
                    rememberGoodImpitBrowser(response.url || url, browser, browserStickyTtlMs);
                    clearBadImpitBrowser(response.url || url);
                } else {
                    rememberBadImpitBrowser(response.url || url, browser, options.badBrowserTtlMs);
                }
                return response;
            }
            rememberBadImpitBrowser(response.url || url, browser, options.badBrowserTtlMs);
        } catch (error) {
            lastError = error;
            if (isCanceledError(error) || options.signal?.aborted) throw error;
            if (isRetryableError(error)) rememberBadImpitBrowser(url, browser, options.badBrowserTtlMs);
            if (attempts >= maxBrowserAttempts && !isRetryableError(error)) throw error;
        }
    }

    if (lastResponse) return lastResponse;
    if (lastError) throw lastError;
    return null;
}

function responseText(data) {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data); }
}

function hasCfResponseHeaders(headers = {}) {
    const h = normalizeHeaders(headers);
    return Boolean(
        h['cf-ray'] ||
        h['cf-cache-status'] ||
        h['cf-mitigated'] ||
        safeString(h.server).toLowerCase().includes('cloudflare')
    );
}

function isCloudflareChallenge(body, status, headers = null) {
    return antibotSignatures.isCloudflareChallenge(responseText(body), status, headers);
}

function classifyBlockResponse(body, status = 0, headers = {}) {
    const code = Number(status) || 0;
    const normalized = normalizeHeaders(headers);
    const text = responseText(body);
    const low = text.slice(0, 80000).toLowerCase();
    const server = safeString(normalized.server).toLowerCase();
    const hasCfHeaders = Boolean(normalized['cf-ray'] || normalized['cf-cache-status'] || normalized['cf-mitigated'] || server.includes('cloudflare'));
    const bodyHasCfChallenge = antibotSignatures.bodyHasCloudflareChallenge(text);
    const headerHasCfChallenge = antibotSignatures.headersIndicateCloudflareChallenge(normalized);
    const hasCfChallenge = bodyHasCfChallenge || headerHasCfChallenge;
    const vendorDetection = antibotSignatures.detectAntibot(text, code, normalized);
    const hasWaf = (vendorDetection.kind === 'waf' && vendorDetection.vendor !== 'cloudflare')
        || /access denied|request blocked|forbidden|ddos-guard|sucuri|incapsula|akamai|perimeterx|datadome|bot protection|security check/i.test(text);
    const isTinyBody = !text || text.trim().length < 32;

    if (hasCfChallenge || (hasCfHeaders && [403, 429, 503].includes(code) && text.length < 120000)) {
        let reason = 'cf_headers_status';
        if (bodyHasCfChallenge) {
            reason = 'cf_challenge_body';
        } else if (headerHasCfChallenge) {
            reason = 'cf_challenge_header';
        }
        return { blocked: true, type: 'cloudflare_challenge', retryable: true, status: code, reason, vendor: 'cloudflare' };
    }

    if (code === 429) {
        return { blocked: true, type: 'rate_limit', retryable: true, status: code, reason: 'http_429', vendor: vendorDetection.vendor };
    }

    if ([502, 503, 504, 520, 521, 522, 523, 524].includes(code)) {
        return { blocked: true, type: 'temporary_upstream', retryable: true, status: code, reason: 'temporary_http_status' };
    }

    if (code === 403 && hasWaf) {
        return { blocked: true, type: 'waf_block', retryable: true, status: code, reason: 'waf_body', vendor: vendorDetection.vendor !== 'none' ? vendorDetection.vendor : 'unknown' };
    }

    if (code === 403) {
        return { blocked: true, type: 'forbidden', retryable: false, status: code, reason: 'http_403' };
    }

    if ([401, 451].includes(code)) {
        return { blocked: true, type: code === 451 ? 'geo_or_legal_block' : 'unauthorized', retryable: false, status: code, reason: `http_${code}` };
    }

    if ([200, 204].includes(code) && isTinyBody) {
        return { blocked: false, type: 'empty_response', retryable: false, status: code, reason: 'tiny_body' };
    }

    return { blocked: false, type: 'ok', retryable: false, status: code, reason: 'no_block_detected' };
}

function isCanceledError(error) {
    return axios.isCancel(error) ||
        error?.code === 'ERR_CANCELED' ||
        error?.code === 'ABORT_ERR' ||
        error?.name === 'AbortError';
}

function isRetryableError(error) {
    if (!error || isCanceledError(error)) return false;

    const code = safeString(error.code || error.cause?.code).toUpperCase();
    const name = safeString(error.name || error.constructor?.name).toLowerCase();
    if (/(timeout|network|transport|connect|read|write|protocol|proxy)/i.test(name)) return true;

    if ([
        'ECONNRESET',
        'ETIMEDOUT',
        'ESOCKETTIMEDOUT',
        'ECONNABORTED',
        'EAI_AGAIN',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT'
    ].includes(code)) return true;

    const status = Number(error.response?.status || error.statusCode || error.status || 0);
    return [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(status);
}

function getRetryDelay(attempt = 0, options = {}) {
    const delays = Array.isArray(options.delays) && options.delays.length ? options.delays : DEFAULT_RETRY_DELAYS_MS;
    const index = Math.max(0, Math.min(Number(attempt) || 0, delays.length - 1));
    const base = Number(delays[index]) || 300;
    const jitter = options.jitter === false ? 0 : Math.floor(Math.random() * Math.max(40, Math.floor(base * 0.25)));
    return base + jitter;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function createDomainCookieJar(options = {}) {
    const domainCookies = new Map();
    const ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_COOKIE_TTL_MS);
    const maxDomains = Math.max(1, Number(options.maxDomains) || 300);
    const maxCookiesPerDomain = Math.max(1, Number(options.maxCookiesPerDomain) || 80);

    function prune() {
        const t = now();
        for (const [host, record] of domainCookies.entries()) {
            if (!record?.cookies?.size || record.expiresAt <= t) {
                domainCookies.delete(host);
                continue;
            }
            for (const [name, cookie] of record.cookies.entries()) {
                if (cookie.expiresAt <= t) record.cookies.delete(name);
            }
            if (!record.cookies.size) domainCookies.delete(host);
        }

        while (domainCookies.size > maxDomains) {
            const firstKey = domainCookies.keys().next().value;
            if (!firstKey) break;
            domainCookies.delete(firstKey);
        }
    }

    function getRecord(host) {
        prune();
        const existing = domainCookies.get(host);
        if (existing) return existing;
        const created = { cookies: new Map(), expiresAt: now() + ttlMs, touchedAt: now() };
        domainCookies.set(host, created);
        return created;
    }

    function updateCookiesFromResponse(url, headers = {}) {
        const host = getHost(url);
        if (!host) return;

        const normalized = normalizeHeaders(headers);
        const setCookie = normalized['set-cookie'];
        if (!setCookie) return;

        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        const record = getRecord(host);
        record.expiresAt = now() + ttlMs;
        record.touchedAt = now();

        for (const cookie of cookies) {
            const raw = safeString(cookie).trim();
            const pair = raw.split(';')[0].trim();
            const eqIndex = pair.indexOf('=');
            if (eqIndex <= 0) continue;

            const name = pair.slice(0, eqIndex).trim();
            const value = pair.slice(eqIndex + 1);
            if (!name) continue;

            if (!value) {
                record.cookies.delete(name);
                continue;
            }

            record.cookies.set(name, { pair: `${name}=${value}`, expiresAt: now() + ttlMs });
        }

        while (record.cookies.size > maxCookiesPerDomain) {
            const firstKey = record.cookies.keys().next().value;
            if (!firstKey) break;
            record.cookies.delete(firstKey);
        }
    }

    function getCookieHeaderForUrl(url, extraCookies = '') {
        const host = getHost(url);
        if (!host) return extraCookies || null;

        prune();
        const record = domainCookies.get(host);
        if (!record?.cookies?.size) return extraCookies || null;

        record.touchedAt = now();
        const combined = [...record.cookies.values()].map((cookie) => cookie.pair).filter(Boolean).join('; ');
        if (extraCookies && combined) return extraCookies + '; ' + combined;
        return extraCookies || combined || null;
    }

    function clearDomain(url) {
        const host = getHost(url);
        if (!host) return false;
        return domainCookies.delete(host);
    }

    function size() {
        prune();
        let cookies = 0;
        for (const record of domainCookies.values()) cookies += record.cookies?.size || 0;
        return { domains: domainCookies.size, cookies };
    }

    return {
        updateCookiesFromResponse,
        getCookieHeaderForUrl,
        clear: () => domainCookies.clear(),
        clearDomain,
        prune,
        size
    };
}

function createSingleFlight(options = {}) {
    const inflight = new Map();
    const ttlMs = Math.max(0, Number(options.ttlMs) || DEFAULT_SINGLE_FLIGHT_TTL_MS);
    const maxKeys = Math.max(1, Number(options.maxKeys) || 1000);

    function prune() {
        if (!ttlMs) return;
        const t = now();
        for (const [key, record] of inflight.entries()) {
            if (record.expiresAt <= t) inflight.delete(key);
        }
    }

    async function doOnce(key, factory) {
        const flightKey = safeString(key);
        if (!flightKey || typeof factory !== 'function') return factory?.();

        prune();
        const existing = inflight.get(flightKey);
        if (existing) return existing.promise;

        const promise = Promise.resolve()
            .then(factory)
            .finally(() => {
                if (!ttlMs) inflight.delete(flightKey);
            });

        inflight.set(flightKey, {
            promise,
            expiresAt: now() + ttlMs
        });

        while (inflight.size > maxKeys) {
            const firstKey = inflight.keys().next().value;
            if (!firstKey || firstKey === flightKey) break;
            inflight.delete(firstKey);
        }

        return promise;
    }

    return {
        do: doOnce,
        run: doOnce,
        clear: () => inflight.clear(),
        size: () => inflight.size,
        prune
    };
}

function createCircuitBreaker(options = {}) {
    const state = new Map();
    const maxFailures = Math.max(1, Number(options.maxFailures) || DEFAULT_CIRCUIT_BREAKER_FAILURES);
    const resetMs = Math.max(1000, Number(options.resetMs) || DEFAULT_CIRCUIT_BREAKER_RESET_MS);

    function keyFor(input) {
        return getHost(input) || safeString(input || 'default');
    }

    function getState(input) {
        const key = keyFor(input);
        const current = state.get(key) || { failures: 0, openedUntil: 0, lastError: null };
        state.set(key, current);
        return current;
    }

    function canRequest(input) {
        const current = getState(input);
        return current.openedUntil <= now();
    }

    function getStatus(input) {
        const current = getState(input);
        return {
            open: current.openedUntil > now(),
            failures: current.failures,
            openedUntil: current.openedUntil,
            remainingMs: Math.max(0, current.openedUntil - now()),
            lastError: current.lastError
        };
    }

    function success(input) {
        const key = keyFor(input);
        state.set(key, { failures: 0, openedUntil: 0, lastError: null });
    }

    function failure(input, error = null) {
        const current = getState(input);
        current.failures += 1;
        current.lastError = error?.message || error?.code || safeString(error || 'failure');
        if (current.failures >= maxFailures) {
            current.openedUntil = now() + resetMs;
        }
        return getStatus(input);
    }

    function clear(input = null) {
        if (!input) {
            state.clear();
            return true;
        }
        return state.delete(keyFor(input));
    }

    return {
        canRequest,
        success,
        failure,
        getStatus,
        clear,
        size: () => state.size
    };
}

async function retry(fn, options = {}) {
    const attempts = Math.max(1, Number(options.attempts) || 3);
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt >= attempts - 1 || !isRetryableError(error)) throw error;
            await sleep(getRetryDelay(attempt, options));
        }
    }

    throw lastError;
}

module.exports = {
    DEFAULT_FINGERPRINT_POOL,
    buildBrowserHeaders,
    createDomainCookieJar,
    getRandomFingerprint,
    detectAntibot: antibotSignatures.detectAntibot,
    hasCfResponseHeaders,
    isCanceledError,
    isCloudflareChallenge,
    responseText,

    buildContextHeaders,
    classifyBlockResponse,
    clearGoodImpitBrowser,
    clearBadImpitBrowser,
    clearStickyFingerprints,
    createCircuitBreaker,
    createSingleFlight,
    getGoodImpitBrowser,
    getImpitBrowserCandidatesForFingerprint,
    normalizeImpitBrowser,
    normalizeRequestContext,
    alignHeadersForImpitBrowser,
    getImpitBrowserForFingerprint,
    getImpitClient,
    getRetryDelay,
    getStickyFingerprintForUrl,
    headersToPlainObject,
    inferRequestContext,
    isRetryableError,
    rememberBadImpitBrowser,
    rememberGoodImpitBrowser,
    requestWithImpit,
    requestWithImpitRotating,
    retry,
    sleep
};
