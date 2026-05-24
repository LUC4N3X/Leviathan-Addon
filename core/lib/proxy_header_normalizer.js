'use strict';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_ACCEPT_LANGUAGE = 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
const DEFAULT_HLS_ACCEPT = 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*';
const DEFAULT_ACCEPT = '*/*';
const MAX_HEADER_VALUE_LENGTH = 4096;
const LOG_THROTTLE_MS = 60 * 1000;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_CONTROL_RE = /[\r\n\0]/;

const HOP_BY_HOP_HEADERS = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'upgrade',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'cf-connecting-ip',
    'true-client-ip',
    'x-real-ip'
]);

const CANONICAL_HEADER_NAMES = new Map([
    ['accept', 'Accept'],
    ['accept-encoding', 'Accept-Encoding'],
    ['accept-language', 'Accept-Language'],
    ['authorization', 'Authorization'],
    ['cache-control', 'Cache-Control'],
    ['content-type', 'Content-Type'],
    ['cookie', 'Cookie'],
    ['origin', 'Origin'],
    ['pragma', 'Pragma'],
    ['range', 'Range'],
    ['referer', 'Referer'],
    ['referrer', 'Referer'],
    ['user-agent', 'User-Agent'],
    ['x-requested-with', 'X-Requested-With']
]);

const PROXY_ROUTE_HINTS = [
    '/ccproxy/',
    '/proxy/',
    '/proxy/stream',
    '/proxy/hls/',
    '/extractor/video',
    '/extractor/',
    '/hls?',
    '/lazy_extract/',
    '/vixsynthetic.m3u8',
    '/play_rd/',
    '/play_tb/'
];

const lastLogByKey = new Map();

function safeString(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.filter((entry) => entry != null && entry !== '').map((entry) => String(entry).trim()).filter(Boolean).join(', ');
    return String(value).trim();
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch (_) {
        return String(value || '');
    }
}

function canonicalHeaderName(name) {
    const raw = String(name || '').trim();
    if (!raw || !HEADER_NAME_RE.test(raw)) return '';
    const lower = raw.toLowerCase();
    if (!lower) return '';
    if (CANONICAL_HEADER_NAMES.has(lower)) return CANONICAL_HEADER_NAMES.get(lower);
    return lower
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('-');
}

function isValidHttpUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function normalizeUrl(value, base = null) {
    try {
        if (!value) return null;
        const raw = String(value).trim();
        if (!raw) return null;
        if (raw.startsWith('//')) return new URL(`https:${raw}`).toString();
        if (/^https?:\/\//i.test(raw)) return new URL(raw).toString();
        if (base) return new URL(raw, base).toString();
    } catch (_) {
        return null;
    }
    return null;
}

function getOrigin(value, fallback = '') {
    try {
        return new URL(String(value || '')).origin;
    } catch (_) {
        return fallback;
    }
}

function isHlsUrl(value, contentType = '') {
    return /mpegurl|x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(String(contentType || ''))
        || /\.m3u8(?:$|[?#])/i.test(String(value || ''));
}

function getHeader(headers, name) {
    const target = String(name || '').toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (String(key || '').toLowerCase() === target && value != null && value !== '') return safeString(value);
        if (target === 'referer' && String(key || '').toLowerCase() === 'referrer' && value != null && value !== '') return safeString(value);
    }
    return '';
}

function normalizeHeaderValue(name, value, options = {}) {
    const canonical = canonicalHeaderName(name);
    let text = safeString(value);
    if (!canonical || !text || text.length > MAX_HEADER_VALUE_LENGTH || HEADER_VALUE_CONTROL_RE.test(text)) return null;

    if (canonical === 'Range') {
        if (options.allowRange === false) return null;
        return /^bytes=\d*-\d*(?:,\d*-\d*)*$/i.test(text) ? text : null;
    }

    if (canonical === 'Referer') {
        const url = normalizeUrl(text);
        return url || null;
    }

    if (canonical === 'Origin') {
        const origin = getOrigin(text, '');
        return origin || null;
    }

    if (canonical === 'Authorization') {
        return options.allowAuthorization === false ? null : text;
    }

    if (canonical === 'Accept-Encoding') {
        return options.forceIdentityEncoding === false ? text : 'identity';
    }

    return text;
}

function normalizeProxyHeaders(headers = {}, options = {}) {
    const out = {};
    const dropped = [];
    const duplicated = [];
    let normalized = false;

    for (const [rawKey, rawValue] of Object.entries(headers || {})) {
        const lower = String(rawKey || '').trim().toLowerCase();
        if (!lower || HOP_BY_HOP_HEADERS.has(lower)) {
            if (lower) dropped.push(lower);
            continue;
        }

        const canonical = canonicalHeaderName(rawKey);
        const value = normalizeHeaderValue(canonical, rawValue, options);
        if (!canonical || !value) {
            dropped.push(lower || String(rawKey || ''));
            continue;
        }

        if (Object.prototype.hasOwnProperty.call(out, canonical)) duplicated.push(canonical);
        if (canonical !== rawKey || value !== safeString(rawValue)) normalized = true;
        out[canonical] = value;
    }

    const targetUrl = normalizeUrl(options.targetUrl || '');
    if (targetUrl) {
        const targetOrigin = getOrigin(targetUrl, '');
        if (!out.Referer && options.fillReferer !== false) {
            out.Referer = normalizeUrl(options.referer || `${targetOrigin}/`) || `${targetOrigin}/`;
            normalized = true;
        }
        if (!out.Origin && options.fillOrigin !== false) {
            out.Origin = getOrigin(out.Referer, targetOrigin) || targetOrigin;
            normalized = true;
        }
        if (!out.Accept) {
            out.Accept = options.accept || (isHlsUrl(targetUrl, options.contentType) ? DEFAULT_HLS_ACCEPT : DEFAULT_ACCEPT);
            normalized = true;
        }
    }

    if (!out['User-Agent'] && options.fillUserAgent !== false) {
        out['User-Agent'] = options.userAgent || DEFAULT_USER_AGENT;
        normalized = true;
    }
    if (!out['Accept-Language'] && options.fillAcceptLanguage !== false) {
        out['Accept-Language'] = options.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE;
        normalized = true;
    }
    if (options.forceIdentityEncoding !== false) {
        out['Accept-Encoding'] = 'identity';
    }

    return {
        headers: out,
        changed: normalized || dropped.length > 0 || duplicated.length > 0,
        dropped,
        duplicated: Array.from(new Set(duplicated))
    };
}

function moveBasicAuthFromUrl(targetUrl, headers = {}) {
    const normalized = normalizeUrl(targetUrl);
    if (!normalized) return { url: targetUrl, headers: { ...(headers || {}) }, moved: false };

    try {
        const parsed = new URL(normalized);
        if (!parsed.username && !parsed.password) return { url: normalized, headers: { ...(headers || {}) }, moved: false };

        const username = safeDecodeURIComponent(parsed.username);
        const password = safeDecodeURIComponent(parsed.password);
        parsed.username = '';
        parsed.password = '';

        const nextHeaders = { ...(headers || {}) };
        if (!getHeader(nextHeaders, 'authorization')) {
            nextHeaders.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        }

        return {
            url: parsed.toString(),
            headers: nextHeaders,
            moved: true
        };
    } catch (_) {
        return { url: targetUrl, headers: { ...(headers || {}) }, moved: false };
    }
}

function sameOrigin(first, second) {
    const a = normalizeUrl(first);
    const b = normalizeUrl(second);
    if (!a || !b) return false;
    return getOrigin(a) === getOrigin(b);
}

function isAlreadyProxiedUrl(targetUrl, options = {}) {
    const normalized = normalizeUrl(targetUrl);
    if (!normalized) return false;
    try {
        const parsed = new URL(normalized);
        const pathname = parsed.pathname || '/';
        const pathLooksProxy = PROXY_ROUTE_HINTS.some((hint) => pathname.startsWith(hint) || normalized.includes(hint));
        if (pathname.startsWith('/lazy_extract/')) return true;
        const addonBase = normalizeUrl(options.addonBase || options.reqHost || '');
        if (addonBase && sameOrigin(normalized, addonBase) && pathLooksProxy) return true;

        const mediaflowUrl = normalizeUrl(options.mediaflowUrl || '');
        if (mediaflowUrl && sameOrigin(normalized, mediaflowUrl)) return true;

        const host = parsed.hostname.toLowerCase();
        if ((host.includes('mediaflow') || host.includes('krakenproxy')) && pathLooksProxy) return true;
        return false;
    } catch (_) {
        return false;
    }
}

function shouldProxyUrl(targetUrl, options = {}) {
    const normalized = normalizeUrl(targetUrl);
    if (!normalized || !isValidHttpUrl(normalized)) return { proxy: false, reason: 'invalid_url' };
    if (isAlreadyProxiedUrl(normalized, options)) return { proxy: false, reason: 'already_proxied' };

    const service = String(options.service || options.provider || '').toLowerCase();
    if (/^(?:rd|realdebrid|real-debrid|tb|torbox|torrent|debrid)$/i.test(service)) {
        return { proxy: false, reason: 'debrid_or_torrent_service' };
    }

    return { proxy: true, reason: 'web_stream' };
}

function prepareProxyTarget(targetUrl, headers = {}, options = {}) {
    const authMoved = moveBasicAuthFromUrl(targetUrl, headers || {});
    const decision = shouldProxyUrl(authMoved.url, options);
    const normalized = normalizeProxyHeaders(authMoved.headers, {
        ...options,
        targetUrl: authMoved.url
    });

    return {
        url: normalizeUrl(authMoved.url) || authMoved.url,
        headers: normalized.headers,
        shouldProxy: decision.proxy,
        reason: decision.reason,
        changed: authMoved.moved || normalized.changed,
        basicAuthMoved: authMoved.moved,
        dropped: normalized.dropped,
        duplicated: normalized.duplicated,
        headerCount: Object.keys(normalized.headers || {}).length
    };
}

function redactedHost(targetUrl) {
    try {
        return new URL(String(targetUrl || '')).hostname.replace(/^www\./i, '');
    } catch (_) {
        return 'unknown';
    }
}

function proxyHeaderLogLine(result, targetUrl, prefix = '[PROXY HEADERS]') {
    const parts = [
        prefix,
        `normalized=${Boolean(result?.changed)}`,
        `host=${redactedHost(targetUrl)}`,
        `headers=${Number(result?.headerCount || 0)}`
    ];
    if (result?.basicAuthMoved) parts.push('basicAuthMoved=true');
    if (result?.reason) parts.push(`reason=${result.reason}`);
    if (Array.isArray(result?.dropped) && result.dropped.length) parts.push(`dropped=${result.dropped.length}`);
    if (Array.isArray(result?.duplicated) && result.duplicated.length) parts.push(`deduped=${result.duplicated.join(',')}`);
    return parts.join(' ');
}

function maybeLogProxyHeaderDecision(result, targetUrl, { logger = console, prefix = '[PROXY HEADERS]', force = false } = {}) {
    if (!result || (!force && !result.changed && result.reason !== 'already_proxied')) return false;
    const key = `${redactedHost(targetUrl)}:${result.reason || 'ok'}:${result.basicAuthMoved ? 'auth' : 'noauth'}:${result.changed ? 'changed' : 'same'}`;
    const now = Date.now();
    const last = lastLogByKey.get(key) || 0;
    if (!force && now - last < LOG_THROTTLE_MS) return false;
    lastLogByKey.set(key, now);
    const line = proxyHeaderLogLine(result, targetUrl, prefix);
    if (logger && typeof logger.info === 'function') logger.info(line);
    else if (logger && typeof logger.log === 'function') logger.log(line);
    return true;
}

module.exports = {
    DEFAULT_USER_AGENT,
    DEFAULT_ACCEPT_LANGUAGE,
    canonicalHeaderName,
    getHeader,
    isAlreadyProxiedUrl,
    isHlsUrl,
    moveBasicAuthFromUrl,
    normalizeProxyHeaders,
    prepareProxyTarget,
    proxyHeaderLogLine,
    shouldProxyUrl,
    maybeLogProxyHeaderDecision
};
