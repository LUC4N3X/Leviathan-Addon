'use strict';

const axios = require('axios');

const IMPIT_INSTANCE_CACHE = new Map();
let impitModulePromise = null;

const DEFAULT_FINGERPRINT_POOL = Object.freeze([
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
        browserType: 'edge',
        secChUa: '"Microsoft Edge";v="134", "Chromium";v="134", "Not:A-Brand";v="99"',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"macOS"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
        browserType: 'firefox',
        secChUa: null,
        secChUaPlatform: null,
        acceptLanguage: 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3'
    }),
    Object.freeze({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"Linux"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    })
]);

const DEFAULT_STICKY_FINGERPRINT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_COOKIE_TTL_MS = 45 * 60 * 1000;
const DEFAULT_CIRCUIT_BREAKER_RESET_MS = 90 * 1000;
const DEFAULT_CIRCUIT_BREAKER_FAILURES = 5;
const DEFAULT_SINGLE_FLIGHT_TTL_MS = 0;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([300, 700, 1500]);

const stickyFingerprintCache = new Map();

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

function clearStickyFingerprints(url = null) {
    if (!url) {
        stickyFingerprintCache.clear();
        return true;
    }
    const host = getHost(url);
    if (!host) return false;
    return stickyFingerprintCache.delete(host);
}

function buildBrowserHeaders(fp = getRandomFingerprint(), extra = {}) {
    const headers = {
        'User-Agent': fp.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': fp.acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };

    if (fp.browserType !== 'firefox') {
        Object.assign(headers, {
            'sec-ch-ua': fp.secChUa,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': fp.secChUaPlatform,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });
    } else {
        Object.assign(headers, {
            'TE': 'trailers'
        });
    }

    return compactHeaderObject(Object.assign(headers, extra));
}

function inferRequestContext(url, fallback = 'document') {
    const value = safeString(url).toLowerCase().split('?')[0];
    if (/\.(m3u8|mpd|ts|m4s|mp4|mkv|avi|mov|webm|m4v|mp3|m4a|aac|vtt|srt)$/.test(value)) return 'media';
    if (/\.(json)$/.test(value) || /\/api\//i.test(value)) return 'json';
    if (/embed|iframe|player/i.test(value)) return 'iframe';
    return fallback || 'document';
}

function getFetchSite(url, referer) {
    if (!referer) return 'none';
    if (sameOrigin(url, referer)) return 'same-origin';
    return 'cross-site';
}

function buildContextHeaders(url = null, context = null, extra = {}, fp = null) {
    if (context && typeof context === 'object' && !Array.isArray(context)) {
        extra = context;
        context = null;
    }

    const selectedContext = safeString(context || inferRequestContext(url, 'document')).toLowerCase();
    const fingerprint = fp || (url ? getStickyFingerprintForUrl(url) : getRandomFingerprint());
    const referer = extra?.Referer || extra?.referer || extra?.referrer || null;
    const headers = buildBrowserHeaders(fingerprint, extra);
    const site = getFetchSite(url, referer);

    if (selectedContext === 'iframe' || selectedContext === 'embed' || selectedContext === 'player') {
        Object.assign(headers, {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': site,
            'Upgrade-Insecure-Requests': '1'
        });
        delete headers['Sec-Fetch-User'];
    } else if (selectedContext === 'ajax' || selectedContext === 'xhr' || selectedContext === 'json') {
        Object.assign(headers, {
            'Accept': selectedContext === 'json' ? 'application/json, text/plain, */*' : '*/*',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': site,
            'X-Requested-With': 'XMLHttpRequest'
        });
        delete headers['Sec-Fetch-User'];
        delete headers['Upgrade-Insecure-Requests'];
    } else if (selectedContext === 'media' || selectedContext === 'playlist' || selectedContext === 'hls' || selectedContext === 'dash') {
        Object.assign(headers, {
            'Accept': /\.m3u8(\?|$)/i.test(safeString(url))
                ? 'application/vnd.apple.mpegurl, application/x-mpegURL, */*'
                : /\.mpd(\?|$)/i.test(safeString(url))
                    ? 'application/dash+xml, */*'
                    : '*/*',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': site
        });
        delete headers['Cache-Control'];
        delete headers['Pragma'];
        delete headers['Sec-Fetch-User'];
        delete headers['Upgrade-Insecure-Requests'];
    } else {
        Object.assign(headers, {
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': site,
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });
    }

    return compactHeaderObject(Object.assign(headers, extra));
}

function getImpitBrowserForFingerprint(fp = null) {
    const browserType = safeString(fp?.browserType || fp?.family || fp?.browser || fp?.name).toLowerCase();
    const userAgent = safeString(fp?.userAgent || fp?.ua).toLowerCase();

    if (browserType.includes('firefox') || userAgent.includes('firefox/')) return 'firefox135';
    if (browserType.includes('okhttp') || userAgent.includes('okhttp/')) return 'okhttp4';
    return 'chrome136';
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
    return JSON.stringify({
        browser: options.browser || 'chrome136',
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
    const clientOptions = {
        browser: options.browser || 'chrome136',
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
    const client = await getImpitClient({
        browser: options.browser || getImpitBrowserForFingerprint(options.fingerprint || options.fp),
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
                headers: compactHeaderObject(headersToPlainObject(options.headers || {})),
                body,
                timeout,
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
                ok: response.ok
            };
        } catch (error) {
            lastError = error;
            if (attempt >= retryLimit || !isRetryableError(error)) throw error;
            await sleep(getRetryDelay(attempt, options.retry || {}));
        }
    }

    throw lastError;
}

function responseText(data) {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data); }
}

function isCloudflareChallenge(body, status) {
    if ([403, 429, 503].includes(Number(status))) return true;

    const text = responseText(body);
    return (
        /just a moment|checking your browser|cloudflare ray id|cf-browser-verification/i.test(text)
        || /enable javascript and cookies|<div id=["']cf-wrapper["']|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate/i.test(text)
        || (/challenge-platform|_cf_chl_opt|cf_clearance/i.test(text) && text.length < 20000)
    );
}

function classifyBlockResponse(body, status = 0, headers = {}) {
    const code = Number(status) || 0;
    const normalized = normalizeHeaders(headers);
    const text = responseText(body);
    const low = text.slice(0, 80000).toLowerCase();
    const server = safeString(normalized.server).toLowerCase();
    const hasCfHeaders = Boolean(normalized['cf-ray'] || normalized['cf-cache-status'] || server.includes('cloudflare'));
    const hasCfChallenge = /just a moment|checking your browser|cloudflare ray id|cf-browser-verification|cf-chl-widget|__cf_chl_opt|cf\.challenge\.orchestrate|challenge-platform|turnstile\.cloudflare\.com/i.test(text);
    const hasWaf = /access denied|request blocked|forbidden|ddos-guard|sucuri|incapsula|akamai|perimeterx|datadome|bot protection|security check/i.test(text);
    const isTinyBody = !text || text.trim().length < 32;

    if (hasCfChallenge || (hasCfHeaders && [403, 429, 503].includes(code) && text.length < 120000)) {
        return { blocked: true, type: 'cloudflare_challenge', retryable: true, status: code, reason: hasCfChallenge ? 'cf_challenge_body' : 'cf_headers_status' };
    }

    if (code === 429) {
        return { blocked: true, type: 'rate_limit', retryable: true, status: code, reason: 'http_429' };
    }

    if ([502, 503, 504, 520, 521, 522, 523, 524].includes(code)) {
        return { blocked: true, type: 'temporary_upstream', retryable: true, status: code, reason: 'temporary_http_status' };
    }

    if (code === 403 && hasWaf) {
        return { blocked: true, type: 'waf_block', retryable: true, status: code, reason: 'waf_body' };
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
    isCanceledError,
    isCloudflareChallenge,
    responseText,

    buildContextHeaders,
    classifyBlockResponse,
    clearStickyFingerprints,
    createCircuitBreaker,
    createSingleFlight,
    getImpitBrowserForFingerprint,
    getImpitClient,
    getRetryDelay,
    getStickyFingerprintForUrl,
    headersToPlainObject,
    inferRequestContext,
    isRetryableError,
    requestWithImpit,
    retry,
    sleep
};
