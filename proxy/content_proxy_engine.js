'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
let axiosClient = null;

function getAxiosClient() {
    if (!axiosClient) axiosClient = require('axios');
    return axiosClient;
}

const TOKEN_VERSION = 1;

const CONTENT_PROXY_DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'direct',
    allowDebrid: false,
    failOpen: true,
    ttlSeconds: 3 * 60 * 60,
    timeoutMs: 45_000,
    maxRedirects: 5,
    keepAliveMs: 30_000,
    maxSockets: 96,
    maxFreeSockets: 24
});

const DEFAULT_TTL_SECONDS = CONTENT_PROXY_DEFAULTS.ttlSeconds;
const DEFAULT_TIMEOUT_MS = CONTENT_PROXY_DEFAULTS.timeoutMs;
const MAX_REDIRECTS = CONTENT_PROXY_DEFAULTS.maxRedirects;
const PROXY_ROUTE = '/:conf/levi_proxy/content/:token';
const PROXY_PATH_PREFIX = 'levi_proxy/content';

const httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: CONTENT_PROXY_DEFAULTS.keepAliveMs,
    maxSockets: CONTENT_PROXY_DEFAULTS.maxSockets,
    maxFreeSockets: CONTENT_PROXY_DEFAULTS.maxFreeSockets
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: CONTENT_PROXY_DEFAULTS.keepAliveMs,
    maxSockets: CONTENT_PROXY_DEFAULTS.maxSockets,
    maxFreeSockets: CONTENT_PROXY_DEFAULTS.maxFreeSockets
});

const REQUEST_HEADER_BLOCKLIST = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer',
    'proxy-authenticate', 'proxy-authorization', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
    'cf-connecting-ip', 'cf-ray', 'forwarded'
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
    'accept-ranges', 'age', 'cache-control', 'content-disposition', 'content-encoding', 'content-language',
    'content-length', 'content-range', 'content-type', 'etag', 'expires', 'last-modified', 'vary'
]);

function getProxySecret() {
    return String(
        process.env.ADMIN_PASS ||
        process.env.LEVI_NODE_ID ||
        'leviathan-content-proxy-local-secret'
    );
}

function base64UrlEncode(value) {
    return Buffer.from(String(value)).toString('base64url');
}

function base64UrlDecode(value) {
    return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function signPayload(encodedPayload) {
    return crypto.createHmac('sha256', getProxySecret()).update(encodedPayload).digest('base64url');
}

function constantTimeEqual(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function normalizeTargetUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return url.toString();
    } catch (_) {
        return null;
    }
}

function sanitizeRequestHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        const normalizedKey = String(key || '').trim().toLowerCase();
        if (!normalizedKey || REQUEST_HEADER_BLOCKLIST.has(normalizedKey)) continue;
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) out[normalizedKey] = value.map((entry) => String(entry)).join(', ');
        else out[normalizedKey] = String(value);
    }
    return out;
}

function normalizeFilename(value = '') {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[\\/]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 180);
}

function createToken(payload = {}) {
    const targetUrl = normalizeTargetUrl(payload.url || payload.targetUrl || payload.u);
    if (!targetUrl) return null;

    const ttlSeconds = Math.max(30, Math.min(24 * 60 * 60, Number(payload.ttlSeconds || DEFAULT_TTL_SECONDS) || DEFAULT_TTL_SECONDS));
    const safePayload = {
        v: TOKEN_VERSION,
        u: targetUrl,
        h: sanitizeRequestHeaders(payload.headers || payload.requestHeaders || {}),
        fn: normalizeFilename(payload.filename || payload.fileName || ''),
        src: String(payload.source || '').slice(0, 48),
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
        n: crypto.randomBytes(8).toString('hex')
    };

    const encoded = base64UrlEncode(JSON.stringify(safePayload));
    return `${encoded}.${signPayload(encoded)}`;
}

function decodeToken(token) {
    const [encoded, signature] = String(token || '').split('.');
    if (!encoded || !signature || !constantTimeEqual(signPayload(encoded), signature)) {
        const error = new Error('invalid_proxy_token');
        error.statusCode = 403;
        throw error;
    }

    let payload;
    try {
        payload = JSON.parse(base64UrlDecode(encoded));
    } catch (_) {
        const error = new Error('invalid_proxy_payload');
        error.statusCode = 400;
        throw error;
    }

    if (!payload || payload.v !== TOKEN_VERSION || !normalizeTargetUrl(payload.u)) {
        const error = new Error('invalid_proxy_target');
        error.statusCode = 400;
        throw error;
    }
    if (Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) {
        const error = new Error('expired_proxy_token');
        error.statusCode = 410;
        throw error;
    }

    return {
        url: normalizeTargetUrl(payload.u),
        headers: sanitizeRequestHeaders(payload.h || {}),
        filename: normalizeFilename(payload.fn || ''),
        source: String(payload.src || '')
    };
}

function getContentProxyMode(config = {}) {
    const configured = String(
        config?.contentProxy?.mode ||
        config?.filters?.contentProxyMode ||
        CONTENT_PROXY_DEFAULTS.mode
    ).trim().toLowerCase();
    if (['off', 'none', 'disabled', 'false'].includes(configured)) return 'off';
    if (['all', 'always'].includes(configured)) return 'all';
    if (['direct', 'web', 'external'].includes(configured)) return 'direct';
    return 'debrid';
}

function isContentProxyEnabled(config = {}) {
    if (config?.contentProxy?.enabled === true || config?.filters?.contentProxy === true || config?.filters?.enableContentProxy === true) return true;
    if (config?.contentProxy?.enabled === false || config?.filters?.contentProxy === false || config?.filters?.enableContentProxy === false) return false;
    return CONTENT_PROXY_DEFAULTS.enabled;
}

function isDebridProxyAllowed(config = {}) {
    if (config?.contentProxy?.proxyDebrid === true || config?.filters?.contentProxyDebrid === true) return true;
    if (config?.contentProxy?.proxyDebrid === false || config?.filters?.contentProxyDebrid === false) return false;
    return CONTENT_PROXY_DEFAULTS.allowDebrid;
}

function isFailOpenEnabled() {
    return CONTENT_PROXY_DEFAULTS.failOpen;
}

function shouldProxyContentUrl(config = {}, options = {}) {
    if (!isContentProxyEnabled(config)) return false;
    const targetUrl = normalizeTargetUrl(options.targetUrl || options.url);
    if (!targetUrl) return false;
    const mode = getContentProxyMode(config);
    if (mode === 'off') return false;
    const source = String(options.source || '').toLowerCase();
    const isDebrid = source === 'rd' || source === 'tb' || source.includes('debrid') || options.debrid === true;
    const isDirect = source.includes('external') || source.includes('web') || options.direct === true;

    if (isDebrid && !isDebridProxyAllowed(config)) return false;

    if (mode === 'all') return true;
    if (mode === 'direct') return isDirect || !isDebrid;
    return isDebrid;
}

function buildContentProxyPath(conf, token) {
    const safeConf = encodeURIComponent(String(conf || '').trim());
    return `/${safeConf}/${PROXY_PATH_PREFIX}/${encodeURIComponent(token)}`;
}

function buildContentProxyUrlFromBase(baseUrl, conf, targetUrl, options = {}) {
    const token = createToken({
        url: targetUrl,
        headers: options.headers || options.requestHeaders || {},
        filename: options.filename || options.fileName || '',
        source: options.source || '',
        ttlSeconds: options.ttlSeconds
    });
    if (!token) return null;
    const normalizedBase = String(baseUrl || '').replace(/\/+$/, '');
    return `${normalizedBase}${buildContentProxyPath(conf, token)}`;
}

function buildContentProxyUrlFromRequest(req, conf, targetUrl, options = {}) {
    const protocol = req?.protocol || 'http';
    const host = req?.get ? req.get('host') : req?.headers?.host;
    const origin = host ? `${protocol}://${host}` : '';
    return buildContentProxyUrlFromBase(origin, conf, targetUrl, options);
}

function copyResponseHeaders(upstreamHeaders = {}, res, fallbackFilename = '') {
    for (const [key, value] of Object.entries(upstreamHeaders || {})) {
        const lower = String(key || '').toLowerCase();
        if (!RESPONSE_HEADER_ALLOWLIST.has(lower)) continue;
        if (value === undefined || value === null) continue;
        try { res.setHeader(key, value); } catch (_) {}
    }

    if (fallbackFilename && !res.getHeader('content-disposition')) {
        try { res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fallbackFilename)}`); } catch (_) {}
    }
    res.setHeader('X-Leviathan-Content-Proxy', '1');
}

function buildUpstreamHeaders(decoded, req) {
    const headers = sanitizeRequestHeaders(decoded.headers || {});
    const range = req?.headers?.range;
    if (range) headers.range = String(range);
    if (!headers['user-agent']) headers['user-agent'] = req?.headers?.['user-agent'] || 'LeviathanContentProxy/1.0';
    if (!headers.accept) headers.accept = req?.headers?.accept || '*/*';
    return headers;
}

async function handleContentProxy(req, res, logger = console) {
    const startedAt = Date.now();
    let decoded;
    try {
        decoded = decodeToken(req.params.token);
    } catch (error) {
        return res.status(error.statusCode || 400).send(error.message || 'Invalid proxy token');
    }

    const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
    const headers = buildUpstreamHeaders(decoded, req);

    try {
        const upstream = await getAxiosClient()({
            url: decoded.url,
            method,
            headers,
            responseType: method === 'HEAD' ? 'text' : 'stream',
            timeout: DEFAULT_TIMEOUT_MS,
            maxRedirects: MAX_REDIRECTS,
            httpAgent,
            httpsAgent,
            decompress: false,
            validateStatus: () => true,
            proxy: false
        });

        const upstreamStatus = upstream.status || 502;
        if (upstreamStatus >= 400 && upstreamStatus !== 416 && isFailOpenEnabled() && !res.headersSent) {
            try { logger.warn(`[CONTENT PROXY] fail-open redirect | source=${decoded.source || 'n/a'} | status=${upstreamStatus} | ms=${Date.now() - startedAt}`); } catch (_) {}
            return res.redirect(307, decoded.url);
        }

        copyResponseHeaders(upstream.headers, res, decoded.filename);
        res.status(upstreamStatus);

        if (method === 'HEAD') return res.end();
        if (!upstream.data || typeof upstream.data.pipe !== 'function') return res.end();

        upstream.data.on('error', (error) => {
            try { logger.warn(`[CONTENT PROXY] upstream stream error | source=${decoded.source || 'n/a'} | error=${error.message}`); } catch (_) {}
            if (!res.headersSent) res.status(502);
            try { res.end(); } catch (_) {}
        });
        res.on('close', () => {
            if (!res.writableEnded && upstream.data && typeof upstream.data.destroy === 'function') {
                try { upstream.data.destroy(); } catch (_) {}
            }
        });
        upstream.data.pipe(res);
    } catch (error) {
        try { logger.warn(`[CONTENT PROXY] failed | source=${decoded?.source || 'n/a'} | ms=${Date.now() - startedAt} | error=${error.message}`); } catch (_) {}
        if (!res.headersSent) {
            if (decoded?.url && isFailOpenEnabled()) return res.redirect(307, decoded.url);
            return res.status(502).send('Leviathan content proxy error');
        }
        try { res.end(); } catch (_) {}
    }
}

function registerContentProxyRoutes(app, { logger = console } = {}) {
    if (!app || typeof app.get !== 'function') return false;
    app.get(PROXY_ROUTE, (req, res) => handleContentProxy(req, res, logger));
    app.head(PROXY_ROUTE, (req, res) => handleContentProxy(req, res, logger));
    return true;
}

module.exports = {
    PROXY_ROUTE,
    CONTENT_PROXY_DEFAULTS,
    isContentProxyEnabled,
    getContentProxyMode,
    isDebridProxyAllowed,
    shouldProxyContentUrl,
    createToken,
    decodeToken,
    buildContentProxyUrlFromBase,
    buildContentProxyUrlFromRequest,
    registerContentProxyRoutes,
    normalizeTargetUrl,
    sanitizeRequestHeaders
};
