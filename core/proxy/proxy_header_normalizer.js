'use strict';

const DEFAULT_USER_AGENT = process.env.PROXY_HEADER_NORMALIZER_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const ENABLED = !/^(?:0|false|no|off)$/i.test(String(process.env.PROXY_HEADER_NORMALIZER_ENABLED || 'true'));
const DEFAULT_UA_ENABLED = !/^(?:0|false|no|off)$/i.test(String(process.env.PROXY_HEADER_NORMALIZER_DEFAULT_UA || 'true'));

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'content-length',
    'expect',
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto'
]);

const HEADER_NAME_MAP = new Map([
    ['accept', 'Accept'],
    ['accept-language', 'Accept-Language'],
    ['authorization', 'Authorization'],
    ['cache-control', 'Cache-Control'],
    ['cookie', 'Cookie'],
    ['origin', 'Origin'],
    ['pragma', 'Pragma'],
    ['range', 'Range'],
    ['referer', 'Referer'],
    ['referrer', 'Referer'],
    ['user-agent', 'User-Agent'],
    ['x-requested-with', 'X-Requested-With']
]);

const DEFAULT_QUERY_HEADER_ALLOWLIST = new Set([
    'accept',
    'accept-language',
    'authorization',
    'origin',
    'range',
    'referer',
    'user-agent',
    'x-requested-with'
]);

function isEnabled() {
    return ENABLED;
}

function toHeaderObject(headers = {}) {
    if (!headers || typeof headers !== 'object') return {};
    if (headers instanceof Map) return Object.fromEntries(headers.entries());
    return headers;
}

function normalizeHeaderName(name = '') {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return '';
    return HEADER_NAME_MAP.get(lower) || lower.split('-').map(part => part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part).join('-');
}

function normalizeHeaderValue(value) {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean).join(', ');
    return String(value).trim();
}

function pickHeader(headers = {}, name = '') {
    const lower = String(name || '').toLowerCase();
    for (const [key, value] of Object.entries(toHeaderObject(headers))) {
        const keyLower = String(key || '').toLowerCase();
        if (keyLower === lower || (lower === 'referer' && keyLower === 'referrer')) {
            const normalized = normalizeHeaderValue(value);
            if (normalized) return normalized;
        }
    }
    return '';
}

function getOriginFromUrl(value = '') {
    try {
        return new URL(String(value || '')).origin;
    } catch (_) {
        return '';
    }
}

function normalizeTargetUrl(rawUrl = '') {
    const text = String(rawUrl || '').trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!text) return { url: '', authHeader: '', authMoved: false };

    try {
        const parsed = new URL(text);
        let authHeader = '';
        let authMoved = false;
        if (parsed.username || parsed.password) {
            const username = decodeURIComponent(parsed.username || '');
            const password = decodeURIComponent(parsed.password || '');
            authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
            parsed.username = '';
            parsed.password = '';
            authMoved = true;
        }
        return { url: parsed.toString(), authHeader, authMoved };
    } catch (_) {
        return { url: text, authHeader: '', authMoved: false };
    }
}

function isAlreadyProxied(rawUrl = '', config = {}) {
    const text = String(rawUrl || '').trim();
    if (!text) return false;

    if (/\/ccproxy\//i.test(text) || /\/vixsynthetic\.m3u8/i.test(text)) return true;

    try {
        const url = new URL(text);
        const pathname = String(url.pathname || '').toLowerCase();
        if (/\/(?:proxy|hls|extractor)\//i.test(pathname) && (url.searchParams.has('d') || url.searchParams.has('url'))) return true;
        const mfpBase = String(config?.mediaflow?.url || '').trim();
        if (mfpBase) {
            const mfp = new URL(mfpBase);
            if (url.hostname === mfp.hostname && url.port === mfp.port && url.protocol === mfp.protocol) return true;
        }
    } catch (_) {}

    return false;
}

function shouldKeepHeader(lowerName, options = {}) {
    if (!lowerName || HOP_BY_HOP_HEADERS.has(lowerName)) return false;
    if (lowerName === 'cookie' && options.allowCookie !== true) return false;
    if (lowerName === 'set-cookie') return false;
    return true;
}

function normalizeProxyHeaders(headers = {}, options = {}) {
    const sourceHeaders = toHeaderObject(headers);
    const output = {};
    const dropped = [];
    let duplicateCount = 0;

    if (!ENABLED) {
        return {
            headers: { ...sourceHeaders },
            dropped,
            duplicateCount,
            addedDefaultUa: false,
            authMoved: false,
            targetUrl: String(options.targetUrl || '').trim(),
            alreadyProxied: isAlreadyProxied(options.targetUrl, options.config)
        };
    }

    const target = normalizeTargetUrl(options.targetUrl || '');
    for (const [rawName, rawValue] of Object.entries(sourceHeaders)) {
        const lower = String(rawName || '').trim().toLowerCase();
        const value = normalizeHeaderValue(rawValue);
        if (!value) continue;
        if (!shouldKeepHeader(lower, options)) {
            dropped.push(lower || rawName);
            continue;
        }
        const name = normalizeHeaderName(rawName);
        const canonicalLower = String(name || '').toLowerCase();
        if (Object.prototype.hasOwnProperty.call(output, name)) {
            duplicateCount += 1;
            continue;
        }
        // Handle referer/referrer collision by keeping the first meaningful value.
        if (canonicalLower === 'referer' && output.Referer) {
            duplicateCount += 1;
            continue;
        }
        output[name] = value;
    }

    if (target.authHeader && !pickHeader(output, 'Authorization')) {
        output.Authorization = target.authHeader;
    }

    const explicitReferer = normalizeHeaderValue(options.referer);
    if (explicitReferer && !pickHeader(output, 'Referer')) output.Referer = explicitReferer;

    const explicitOrigin = normalizeHeaderValue(options.origin);
    if (explicitOrigin && !pickHeader(output, 'Origin')) output.Origin = explicitOrigin;
    if (!pickHeader(output, 'Origin')) {
        const refererOrigin = getOriginFromUrl(pickHeader(output, 'Referer'));
        if (refererOrigin) output.Origin = refererOrigin;
    }

    const explicitUa = normalizeHeaderValue(options.userAgent);
    let addedDefaultUa = false;
    if (explicitUa && !pickHeader(output, 'User-Agent')) output['User-Agent'] = explicitUa;
    if (DEFAULT_UA_ENABLED && !pickHeader(output, 'User-Agent')) {
        output['User-Agent'] = DEFAULT_USER_AGENT;
        addedDefaultUa = true;
    }

    return {
        headers: output,
        dropped,
        duplicateCount,
        addedDefaultUa,
        authMoved: target.authMoved,
        targetUrl: target.url || String(options.targetUrl || '').trim(),
        alreadyProxied: isAlreadyProxied(target.url || options.targetUrl, options.config)
    };
}

function redactHeaderValue(name, value) {
    const lower = String(name || '').toLowerCase();
    if (['authorization', 'proxy-authorization', 'cookie', 'set-cookie'].includes(lower)) return '[REDACTED]';
    if (/token|secret|password|pass|key|auth/i.test(String(value || ''))) return '[REDACTED]';
    return value;
}

function redactHeaders(headers = {}) {
    const output = {};
    for (const [name, value] of Object.entries(toHeaderObject(headers))) {
        output[normalizeHeaderName(name)] = redactHeaderValue(name, value);
    }
    return output;
}

function buildMediaflowHeaderQuery(headers = {}, options = {}) {
    const allowlist = options.allowlist instanceof Set ? options.allowlist : DEFAULT_QUERY_HEADER_ALLOWLIST;
    const parts = [];
    for (const [rawName, rawValue] of Object.entries(toHeaderObject(headers))) {
        const name = normalizeHeaderName(rawName);
        const lower = String(name || '').toLowerCase();
        const value = normalizeHeaderValue(rawValue);
        if (!name || !value) continue;
        if (!allowlist.has(lower)) continue;
        if (lower === 'authorization' && options.includeAuthorization === false) continue;
        if (lower === 'cookie' && options.includeCookie !== true) continue;
        parts.push(`h_${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
    return parts.length ? `&${parts.join('&')}` : '';
}

function normalizeProxyTarget(targetUrl, headers = {}, options = {}) {
    const normalized = normalizeProxyHeaders(headers, { ...options, targetUrl });
    return {
        url: normalized.targetUrl,
        headers: normalized.headers,
        headerQuery: buildMediaflowHeaderQuery(normalized.headers, options),
        normalized,
        redactedHeaders: redactHeaders(normalized.headers)
    };
}

function applyNormalizedProxyHeadersToStream(stream = {}, options = {}) {
    if (!stream || typeof stream !== 'object') return stream;
    const hints = stream.behaviorHints && typeof stream.behaviorHints === 'object' ? stream.behaviorHints : {};
    const requestHeaders = hints?.proxyHeaders?.request || stream.headers || {};
    const target = normalizeProxyTarget(stream.url, requestHeaders, options);
    const nextHints = { ...hints };
    nextHints.proxyHeaders = {
        ...(nextHints.proxyHeaders || {}),
        request: target.headers
    };
    return {
        ...stream,
        url: target.url || stream.url,
        behaviorHints: nextHints,
        _proxyHeadersNormalized: true,
        _proxyHeadersAuthMoved: Boolean(target.normalized.authMoved)
    };
}

module.exports = {
    DEFAULT_USER_AGENT,
    isEnabled,
    isAlreadyProxied,
    normalizeHeaderName,
    normalizeProxyHeaders,
    normalizeProxyTarget,
    buildMediaflowHeaderQuery,
    redactHeaders,
    applyNormalizedProxyHeadersToStream
};
