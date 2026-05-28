'use strict';

const { ProviderRequestCache, cloneValue } = require('../../core/cache/provider_request_cache');

const TRUE_RE = /^(?:1|true|yes|on)$/i;
const FALSE_RE = /^(?:0|false|no|off)$/i;
const SECRET_KEY_RE = /password|pass|token|apikey|api_key|authorization|cookie|secret|key/i;

function providerEnvName(providerName) {
    return String(providerName || 'provider')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'PROVIDER';
}

function applyProviderEnvDefaults(defaults = {}, target = process.env) {
    for (const [name, value] of Object.entries(defaults || {})) {
        if (target[name] === undefined || target[name] === null || target[name] === '') {
            target[name] = String(value ?? '');
        }
    }
    return target;
}

function createProviderEnv(defaults = {}, target = process.env) {
    function raw(name, fallback = '') {
        const value = target[name];
        if (value !== undefined && value !== null && value !== '') return value;
        const defaultValue = defaults?.[name];
        if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') return defaultValue;
        return fallback;
    }

    function string(name, fallback = '') {
        return String(raw(name, fallback) ?? '').trim();
    }

    function flag(name, fallback = false) {
        const value = raw(name, fallback ? '1' : '0');
        if (value === undefined || value === null || value === '') return Boolean(fallback);
        return TRUE_RE.test(String(value).trim());
    }

    function flagNotFalse(name, fallback = true) {
        const value = raw(name, fallback ? '1' : '0');
        if (value === undefined || value === null || value === '') return Boolean(fallback);
        return !FALSE_RE.test(String(value).trim());
    }

    function int(name, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
        const value = Number.parseInt(String(raw(name, fallback)), 10);
        if (!Number.isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
    }

    function number(name, fallback = 0, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
        const value = Number(raw(name, fallback));
        if (!Number.isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
    }

    function list(name, fallback = [], splitter = /[\s,;]+/) {
        const value = raw(name, Array.isArray(fallback) ? fallback.join(',') : fallback);
        return String(value || '')
            .split(splitter)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return { raw, string, flag, flagNotFalse, int, number, list, applyDefaults: () => applyProviderEnvDefaults(defaults, target) };
}

function normalizeProviderBaseUrl(value, fallback = '') {
    const raw = String(value || fallback || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
        try { return new URL(raw).origin; } catch (_) { return raw; }
    }
    try { return new URL(`https://${raw}`).origin; } catch (_) { return `https://${raw}`; }
}

function resolveProviderBaseUrls(values = [], fallbackValues = []) {
    const merged = [...values, ...fallbackValues];
    return [...new Set(merged.map((value) => normalizeProviderBaseUrl(value)).filter(Boolean))];
}

function makeProviderCacheKey(namespace, parts = []) {
    return `${namespace}:${parts.map((part) => String(part ?? '').trim()).join('|')}`;
}

function createProviderCache({
    providerName = 'provider',
    maxEntries = 700,
    inflightMaxEntries = 400,
    ttlByNamespace = {},
    minTtlMs = 1_000,
    logger = null,
    traceCache = false,
    redisEnabled = false
} = {}) {
    const memory = new Map();
    const requestCache = new ProviderRequestCache({
        name: providerName,
        maxEntries: Math.max(1, Number(maxEntries) || 700),
        inflightMaxEntries: Math.max(1, Number(inflightMaxEntries) || 400),
        redisEnabled
    });

    function log(level, message, payload) {
        if (!logger) return;
        try {
            if (typeof logger === 'function') logger(level, message, payload);
            else if (typeof logger[level] === 'function') logger[level](message, payload);
        } catch (_) {}
    }

    function get(namespace, parts = []) {
        const key = makeProviderCacheKey(namespace, parts);
        const entry = memory.get(key);
        if (!entry) {
            if (traceCache) log('trace', 'cache miss', { namespace, key: String(key).slice(0, 160) });
            return null;
        }
        if (entry.expiresAt <= Date.now()) {
            memory.delete(key);
            if (traceCache) log('trace', 'cache expired', { namespace, key: String(key).slice(0, 160) });
            return null;
        }
        entry.lastHit = Date.now();
        if (traceCache) log('trace', 'cache hit', { namespace, key: String(key).slice(0, 160), ttlLeftMs: Math.max(0, entry.expiresAt - Date.now()) });
        return cloneValue(entry.value);
    }

    function set(namespace, parts = [], value, ttlMs = null) {
        if (value == null) return value;
        const key = makeProviderCacheKey(namespace, parts);
        const effectiveTtl = Math.max(minTtlMs, Number(ttlMs || ttlByNamespace[namespace] || 60_000));
        memory.set(key, {
            value: cloneValue(value),
            expiresAt: Date.now() + effectiveTtl,
            lastHit: Date.now()
        });
        if (traceCache) log('trace', 'cache set', { namespace, key: String(key).slice(0, 160), ttlMs: effectiveTtl, size: memory.size });
        if (memory.size > maxEntries) {
            const victims = [...memory.entries()]
                .sort((a, b) => (a[1].expiresAt - b[1].expiresAt) || (a[1].lastHit - b[1].lastHit))
                .slice(0, Math.ceil(maxEntries * 0.15));
            for (const [victimKey] of victims) memory.delete(victimKey);
        }
        return value;
    }

    async function withCoalescing(namespace, parts = [], worker) {
        const key = makeProviderCacheKey(namespace, parts);
        if (requestCache.inflight.has(key)) {
            log('info', 'coalescing hit', { namespace, key: String(key).slice(0, 160) });
        }
        return requestCache.singleFlight(key, worker);
    }

    return {
        get,
        set,
        withCoalescing,
        key: makeProviderCacheKey,
        clone: cloneValue,
        memory,
        requestCache,
        stats: () => ({ providerName, memorySize: memory.size, requestCache: requestCache.stats() })
    };
}

function sanitizeLogValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        let out = value;
        out = out.replace(/(api_password=)[^&\s]+/gi, '$1***');
        out = out.replace(/([?&](?:api|key|token|pass|password|apikey|api_key)=)[^&\s]+/gi, '$1***');
        out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1***');
        out = out.replace(/((?:dle_password|password|token|api_key|apikey)=)[^;\s&]+/gi, '$1***');
        return out.length > 650 ? `${out.slice(0, 650)}…` : out;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        if (depth > 2) return `[array:${value.length}]`;
        return value.slice(0, 12).map((item) => sanitizeLogValue(item, depth + 1));
    }
    if (typeof value === 'object') {
        if (depth > 2) return '[object]';
        const out = {};
        for (const [key, item] of Object.entries(value).slice(0, 40)) {
            out[key] = SECRET_KEY_RE.test(key) ? (item ? '***' : item) : sanitizeLogValue(item, depth + 1);
        }
        return out;
    }
    return String(value);
}

function createProviderLogger({
    prefix = 'Provider',
    enabled = true,
    traceEnabled = false,
    debugPrefix = null,
    tracePrefix = null,
    sink = console
} = {}) {
    function isEnabled(value) {
        return typeof value === 'function' ? Boolean(value()) : Boolean(value);
    }

    function write(level, message, payload = null) {
        const normalizedLevel = String(level || 'info').toLowerCase();
        const alwaysShow = /^(warn|error)$/i.test(normalizedLevel);
        if (!alwaysShow && !isEnabled(enabled)) return;
        if (normalizedLevel === 'trace' && !isEnabled(traceEnabled)) return;
        const logger = sink[normalizedLevel] || sink.info || console.info;
        const label = normalizedLevel === 'trace'
            ? (tracePrefix || `[${prefix}:trace]`)
            : (debugPrefix || `[${prefix}:debug]`);
        if (payload && typeof payload === 'object') {
            logger(`${label} ${message} ${JSON.stringify(sanitizeLogValue(payload))}`);
        } else {
            logger(`${label} ${message}`);
        }
    }

    return {
        log: write,
        trace: (message, payload) => write('trace', message, payload),
        debug: (message, payload) => write('debug', message, payload),
        info: (message, payload) => write('info', message, payload),
        warn: (message, payload) => write('warn', message, payload),
        error: (message, payload) => write('error', message, payload)
    };
}

function buildProviderHtmlHeaders({
    userAgent,
    referer = '',
    origin = '',
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    acceptLanguage = 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    acceptEncoding = '',
    cacheControl = '',
    pragma = '',
    upgradeInsecureRequests = false,
    extra = {}
} = {}) {
    const headers = {
        'User-Agent': userAgent,
        'Accept': accept,
        'Accept-Language': acceptLanguage,
        ...extra
    };
    if (acceptEncoding) headers['Accept-Encoding'] = acceptEncoding;
    if (cacheControl) headers['Cache-Control'] = cacheControl;
    if (pragma) headers.Pragma = pragma;
    if (origin) headers.Origin = origin;
    if (referer) headers.Referer = referer;
    if (upgradeInsecureRequests) headers['Upgrade-Insecure-Requests'] = '1';
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null || value === '') delete headers[key];
    }
    return headers;
}

function safeUrlPart(value, fallback = '') {
    try { return new URL(String(value || '')).origin; } catch (_) { return fallback; }
}

module.exports = {
    applyProviderEnvDefaults,
    buildProviderHtmlHeaders,
    createProviderCache,
    createProviderEnv,
    createProviderLogger,
    makeProviderCacheKey,
    normalizeProviderBaseUrl,
    providerEnvName,
    resolveProviderBaseUrls,
    safeUrlPart,
    sanitizeLogValue,
    cloneProviderValue: cloneValue
};

