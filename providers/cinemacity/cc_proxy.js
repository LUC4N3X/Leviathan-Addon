'use strict';

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { getRequestOrigin, isSafeRemoteUrl } = require('../../core/utils/url');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const {
    prepareProxyTarget,
    maybeLogProxyHeaderDecision
} = require('../../core/lib/proxy_header_normalizer');

const CC_MANIFEST_ROUTE = '/ccproxy/manifest.m3u8';
const CC_STREAM_ROUTE = '/ccproxy/stream';
const TOKEN_VERSION = 'ccp1';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_ACCEPT_LANGUAGE = 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
const UPSTREAM_TIMEOUT_MS = Math.max(10000, Number.parseInt(process.env.CC_PROXY_TIMEOUT_MS || '22000', 10) || 22000);
const MAX_UPSTREAM_REDIRECTS = Math.max(0, Math.min(10, Number.parseInt(process.env.CC_PROXY_MAX_REDIRECTS || '5', 10) || 5));
const MANIFEST_MAX_BYTES = Math.max(128 * 1024, Math.min(4 * 1024 * 1024, Number.parseInt(process.env.CC_PROXY_MANIFEST_MAX_BYTES || String(1024 * 1024), 10) || (1024 * 1024)));
const PLAYBACK_TOKEN_TTL_MS = Math.max(10 * 60 * 1000, Number.parseInt(process.env.CC_PROXY_TOKEN_TTL_MS || String(3 * 60 * 60 * 1000), 10) || (3 * 60 * 60 * 1000));
const TOKEN_MAX_BYTES = Math.max(512, Math.min(12 * 1024, Number.parseInt(process.env.CC_PROXY_TOKEN_MAX_BYTES || String(8192), 10) || 8192));
const MANIFEST_CACHE_TTL_MS = Math.max(1500, Math.min(45 * 1000, Number.parseInt(process.env.CC_PROXY_MANIFEST_CACHE_TTL_MS || '12000', 10) || 12000));
const MANIFEST_CACHE_MAX = Math.max(32, Math.min(1200, Number.parseInt(process.env.CC_PROXY_MANIFEST_CACHE_MAX || '400', 10) || 400));
const UPSTREAM_RETRY_ATTEMPTS = Math.max(1, Math.min(3, Number.parseInt(process.env.CC_PROXY_RETRY_ATTEMPTS || '2', 10) || 2));
const UPSTREAM_RETRY_BASE_DELAY_MS = Math.max(40, Math.min(600, Number.parseInt(process.env.CC_PROXY_RETRY_BASE_DELAY_MS || '120', 10) || 120));
const MAX_RANGE_SPAN_BYTES = Math.max(1024 * 1024, Math.min(512 * 1024 * 1024, Number.parseInt(process.env.CC_PROXY_MAX_RANGE_SPAN_BYTES || String(96 * 1024 * 1024), 10) || (96 * 1024 * 1024)));
const SECRET_FILE = path.join(__dirname, '..', 'config', 'cinemacity_proxy_secret.key');
const FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');
let cachedSecret = null;

const proxyHttpClient = axios.create({
    timeout: UPSTREAM_TIMEOUT_MS,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: MAX_UPSTREAM_REDIRECTS,
    responseType: 'stream',
    validateStatus: () => true,
    proxy: false,
    decompress: true
});


function sha256Short(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url').slice(0, 22);
}

class TinyTtlCache {
    constructor({ ttlMs, max }) {
        this.ttlMs = Math.max(1000, Number(ttlMs) || 1000);
        this.max = Math.max(16, Number(max) || 256);
        this.map = new Map();
    }

    get(key) {
        const item = this.map.get(key);
        if (!item) return null;
        if (item.expiresAt <= Date.now()) {
            this.map.delete(key);
            return null;
        }
        this.map.delete(key);
        this.map.set(key, item);
        return item.value;
    }

    set(key, value, ttlMs = this.ttlMs) {
        if (!key) return false;
        this.map.set(key, {
            value,
            expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || this.ttlMs)
        });
        while (this.map.size > this.max) {
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
        }
        return true;
    }

    delete(key) {
        return this.map.delete(key);
    }
}

const manifestCache = new TinyTtlCache({ ttlMs: MANIFEST_CACHE_TTL_MS, max: MANIFEST_CACHE_MAX });
const inFlightRequests = new Map();

function singleFlight(key, fn) {
    const existing = inFlightRequests.get(key);
    if (existing) return existing;
    const task = Promise.resolve()
        .then(fn)
        .finally(() => inFlightRequests.delete(key));
    inFlightRequests.set(key, task);
    return task;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCanceledProxyError(error, signal = null) {
    return Boolean(signal?.aborted || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED' || error?.name === 'AbortError');
}

function isRetryableUpstreamStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(Number(status || 0));
}

function isRetryableProxyError(error) {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || '').toLowerCase();
    return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED', 'ENOTFOUND', 'EPIPE'].includes(code)
        || message.includes('timeout')
        || message.includes('socket hang up');
}

function retryDelay(attempt) {
    const jitter = Math.floor(Math.random() * 90);
    return Math.min(900, UPSTREAM_RETRY_BASE_DELAY_MS * Math.pow(2, attempt)) + jitter;
}

function destroyUpstream(upstream) {
    try { upstream?.data?.destroy?.(); } catch (_) {}
}


function previewBuffer(buffer, limit = 180) {
    try {
        return Buffer.from(buffer || Buffer.alloc(0)).slice(0, limit).toString('utf8').replace(/\s+/g, ' ').trim();
    } catch {
        return '';
    }
}

function looksLikeHtmlBlock(buffer, contentType = '') {
    const type = String(contentType || '').toLowerCase();
    const preview = previewBuffer(buffer, 512).toLowerCase();
    return type.includes('text/html')
        || type.includes('application/xhtml')
        || preview.startsWith('<!doctype')
        || preview.startsWith('<html')
        || preview.includes('<title>just a moment')
        || preview.includes('cloudflare')
        || preview.includes('ddos-guard')
        || preview.includes('access denied')
        || preview.includes('forbidden')
        || preview.includes('captcha')
        || preview.includes('checking your browser')
        || preview.includes('attention required')
        || preview.includes('temporarily unavailable');
}

function getProxySecret() {
    if (cachedSecret) return cachedSecret;
    const envSecret = String(process.env.CC_PROXY_SECRET || process.env.ADDON_SECRET || process.env.JWT_SECRET || process.env.ADMIN_PASS || '').trim();
    if (envSecret.length >= 16) {
        cachedSecret = envSecret;
        return cachedSecret;
    }
    try {
        if (fs.existsSync(SECRET_FILE)) {
            const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
            if (existing.length >= 32) {
                cachedSecret = existing;
                return cachedSecret;
            }
        }
        fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
        const generated = crypto.randomBytes(32).toString('hex');
        try {
            fs.writeFileSync(SECRET_FILE, generated, { flag: 'wx', mode: 0o600 });
            cachedSecret = generated;
            return cachedSecret;
        } catch (writeError) {
            if (fs.existsSync(SECRET_FILE)) {
                const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
                if (existing.length >= 32) {
                    cachedSecret = existing;
                    return cachedSecret;
                }
            }
            throw writeError;
        }
    } catch (_) {
        cachedSecret = FALLBACK_SECRET;
        return cachedSecret;
    }
}

function hmac(value) {
    return crypto.createHmac('sha256', getProxySecret()).update(String(value || ''), 'utf8').digest('base64url');
}

function packToken(payload) {
    const json = JSON.stringify(payload || {});
    const body = zlib.deflateRawSync(Buffer.from(json, 'utf8')).toString('base64url');
    const sig = hmac(`${TOKEN_VERSION}.${body}`);
    const token = `${TOKEN_VERSION}.${body}.${sig}`;
    return token.length <= TOKEN_MAX_BYTES ? token : null;
}

function unpackToken(token) {
    const raw = String(token || '').trim();
    const match = raw.match(/^ccp1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!match) return null;
    const body = match[1];
    const sig = match[2];
    const expected = hmac(`${TOKEN_VERSION}.${body}`);
    const left = Buffer.from(sig, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
    try {
        const inflated = zlib.inflateRawSync(Buffer.from(body, 'base64url')).toString('utf8');
        const payload = JSON.parse(inflated);
        if (!payload || typeof payload !== 'object') return null;
        if (Number(payload.e || 0) <= Date.now()) return null;
        if (Number(payload.e || 0) > Date.now() + PLAYBACK_TOKEN_TTL_MS + 60 * 1000) return null;
        if (payload.h && typeof payload.h === 'object' && JSON.stringify(payload.h).length > TOKEN_MAX_BYTES) return null;
        return payload;
    } catch {
        return null;
    }
}

function normalizeAddonBase(reqHost) {
    const raw = process.env.PUBLIC_BASE_URL || process.env.ADDON_URL || (process.env.SPACE_HOST ? `https://${process.env.SPACE_HOST}` : null) || reqHost || 'https://localhost';
    try {
        if (/^https?:\/\//i.test(raw)) return String(raw).replace(/\/+$/, '');
        return `https://${String(raw).replace(/^\/+/, '').replace(/\/+$/, '')}`;
    } catch {
        return 'https://localhost';
    }
}

function safeUrl(value, base = null) {
    try {
        if (!value) return null;
        let resolved = null;
        if (/^https?:\/\//i.test(value)) resolved = new URL(value).toString();
        else if (String(value).startsWith('//')) resolved = `https:${value}`;
        else if (base) resolved = new URL(value, base).toString();
        return resolved && isSafeRemoteUrl(resolved) ? resolved : null;
    } catch {
        return null;
    }
}

function getHeader(headers, name) {
    const target = String(name || '').toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (String(key || '').toLowerCase() === target && value != null && value !== '') return String(value);
    }
    return null;
}

function getOrigin(value, fallback = null) {
    try { return new URL(String(value || '')).origin; } catch { return fallback; }
}

function normalizeRequestHeaders(headers = {}) {
    const blocked = new Set([
        'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'
    ]);
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(headers || {})) {
        if (rawValue == null) continue;
        const key = String(rawKey || '').trim().toLowerCase();
        const value = String(rawValue || '').trim();
        if (!key || !value || blocked.has(key) || value.length > 4096) continue;
        out[key] = value;
    }
    return out;
}

function buildRequestHeaders(targetUrl, sourceHeaders = {}, options = {}) {
    const sanitizedHeaders = normalizeRequestHeaders(sourceHeaders);
    const prepared = prepareProxyTarget(targetUrl, sanitizedHeaders, {
        userAgent: DEFAULT_UA,
        acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
        allowRange: options.allowRange !== false,
        forceIdentityEncoding: true,
        fillReferer: true,
        fillOrigin: true,
        ...options
    });
    maybeLogProxyHeaderDecision(prepared, prepared.url || targetUrl);
    return prepared.headers;
}


function isHlsUrl(targetUrl, contentType = '') {
    return /mpegurl|x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(contentType || '') || /\.m3u8(?:$|[?#])/i.test(String(targetUrl || ''));
}

function getRouteForTarget(targetUrl, contentType = '') {
    return isHlsUrl(targetUrl, contentType) ? CC_MANIFEST_ROUTE : CC_STREAM_ROUTE;
}

function buildProxyUrl(baseUrl, targetUrl, headers = {}, routePath = null, meta = null) {
    const normalizedBase = normalizeAddonBase(baseUrl);
    const prepared = prepareProxyTarget(targetUrl, headers, {
        addonBase: normalizedBase,
        mediaflowUrl: process.env.MEDIAFLOW_PROXY_URL || process.env.MEDIAFLOW_URL || '',
        userAgent: DEFAULT_UA,
        acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
        forceIdentityEncoding: true,
        fillReferer: true,
        fillOrigin: true
    });
    const normalizedTarget = safeUrl(prepared.url);
    if (!normalizedTarget) return null;
    if (!prepared.shouldProxy) {
        maybeLogProxyHeaderDecision(prepared, normalizedTarget, { prefix: '[PROXY] skip' });
        return normalizedTarget;
    }
    const selectedRoute = routePath || getRouteForTarget(normalizedTarget);
    maybeLogProxyHeaderDecision(prepared, normalizedTarget);
    const token = packToken({
        u: normalizedTarget,
        h: normalizeRequestHeaders(prepared.headers),
        r: selectedRoute,
        e: Date.now() + PLAYBACK_TOKEN_TTL_MS,
        i: Date.now(),
        m: meta || null
    });
    return token ? `${normalizedBase}${selectedRoute}?d=${encodeURIComponent(token)}` : null;
}


function buildCinemaCityProxyUrl(streamUrl, headers = {}, reqHost = null, options = {}) {
    const route = options?.isHls === true ? CC_MANIFEST_ROUTE : getRouteForTarget(streamUrl);
    return buildProxyUrl(reqHost, streamUrl, headers, route, {
        provider: 'CinemaCity',
        hls: route === CC_MANIFEST_ROUTE
    });
}

function setPlaybackHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range,Origin,Accept,Content-Type,User-Agent,Referer,Cache-Control,Pragma');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Content-Type,ETag,Last-Modified,Cache-Control,X-CC-Proxy-Cache,X-CC-Proxy-Error');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
}

function fallbackContentType(targetUrl, upstreamContentType = '') {
    const cleanType = String(upstreamContentType || '').split(';')[0].trim();
    if (cleanType) return upstreamContentType;
    const clean = String(targetUrl || '').split('?')[0].toLowerCase();
    if (clean.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl; charset=utf-8';
    if (clean.endsWith('.ts')) return 'video/mp2t';
    if (clean.endsWith('.m4s')) return 'video/iso.segment';
    if (clean.endsWith('.mp4')) return 'video/mp4';
    if (clean.endsWith('.aac')) return 'audio/aac';
    if (clean.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
    if (clean.endsWith('.key')) return 'application/octet-stream';
    return 'application/octet-stream';
}

function copyUsefulHeaders(upstream, res, manifest = false) {
    const allowed = manifest ? ['etag', 'last-modified'] : ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    for (const name of allowed) {
        const value = upstream?.headers?.[name];
        if (value != null && value !== '') res.setHeader(name.split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join('-'), value);
    }
}

async function readStreamLimited(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            const error = new Error('Manifest too large');
            error.code = 'MANIFEST_TOO_LARGE';
            throw error;
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function normalizeRangeHeader(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const match = raw.match(/^bytes=(\d*)-(\d*)$/i);
    if (!match) return null;
    const startRaw = match[1];
    const endRaw = match[2];
    if (!startRaw && !endRaw) return null;

    if (startRaw && endRaw) {
        const start = Number.parseInt(startRaw, 10);
        const end = Number.parseInt(endRaw, 10);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
        if ((end - start + 1) > MAX_RANGE_SPAN_BYTES) return null;
        return `bytes=${start}-${end}`;
    }

    if (startRaw) {
        const start = Number.parseInt(startRaw, 10);
        if (!Number.isSafeInteger(start) || start < 0) return null;
        return `bytes=${start}-`;
    }

    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || suffix > MAX_RANGE_SPAN_BYTES) return null;
    return `bytes=-${suffix}`;
}

function buildManifestCacheKey(req, sourceUrl, headers = {}) {
    const origin = getRequestOrigin(req) || 'unknown-origin';
    const headerKey = sha256Short(JSON.stringify(normalizeRequestHeaders(headers)));
    return `${origin}:${sourceUrl}:${headerKey}`;
}

function sendManifestResponse(res, req, payload, cacheState = 'MISS') {
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${Math.max(1, Math.floor(MANIFEST_CACHE_TTL_MS / 1000))}, stale-while-revalidate=15`);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('X-CC-Proxy-Cache', cacheState);
    if (payload?.etag) res.setHeader('ETag', payload.etag);
    if (payload?.lastModified) res.setHeader('Last-Modified', payload.lastModified);
    const body = String(payload?.body || '');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
}

function sendProxyError(res, status, code, message) {
    res.status(status);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-CC-Proxy-Error', code);
    return res.end(message);
}

function rewriteDirectiveUri(line, baseUrl, req, headers) {
    return String(line || '').replace(/\bURI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/ig, (full, dq, sq, bare) => {
        const uri = dq || sq || bare || '';
        const absolute = safeUrl(uri, baseUrl);
        const rewritten = absolute ? buildProxyUrl(getRequestOrigin(req), absolute, headers, getRouteForTarget(absolute)) : null;
        if (!rewritten) return full;
        if (dq != null) return `URI="${rewritten}"`;
        if (sq != null) return `URI='${rewritten}'`;
        return `URI=${rewritten}`;
    });
}

function rewriteManifest(manifestText, baseUrl, req, headers) {
    const lines = String(manifestText || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
        const rawLine = String(lines[i] || '');
        const line = rawLine.trim();
        if (!line) {
            out.push('');
            continue;
        }
        if (line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
            out.push(rewriteDirectiveUri(rawLine, baseUrl, req, headers));
            const nextLine = String(lines[i + 1] || '').trim();
            if (nextLine && !nextLine.startsWith('#')) {
                const absolute = safeUrl(nextLine, baseUrl);
                out.push(absolute ? (buildProxyUrl(getRequestOrigin(req), absolute, headers, CC_MANIFEST_ROUTE) || nextLine) : nextLine);
                i += 1;
            }
            continue;
        }
        if (line.startsWith('#EXT-X-') && /\bURI=/i.test(line)) {
            out.push(rewriteDirectiveUri(rawLine, baseUrl, req, headers));
            continue;
        }
        if (line.startsWith('#')) {
            out.push(rawLine);
            continue;
        }
        const absolute = safeUrl(line, baseUrl);
        out.push(absolute ? (buildProxyUrl(getRequestOrigin(req), absolute, headers, getRouteForTarget(absolute)) || line) : rawLine);
    }
    const result = out.join('\n');
    return result.endsWith('\n') ? result : `${result}\n`;
}

function getProxyPathname(req) {
    try { return new URL(req.originalUrl || req.url || req.path || '/', 'http://localhost').pathname; } catch { return String(req.path || '/'); }
}

function resolveProxySource(req) {
    const pathname = getProxyPathname(req);
    const routeBinding = pathname === CC_STREAM_ROUTE ? CC_STREAM_ROUTE : CC_MANIFEST_ROUTE;
    const payload = unpackToken((req.query || {}).d);
    if (!payload?.u || payload.r !== routeBinding || !isSafeRemoteUrl(payload.u)) return null;
    return {
        sourceUrl: payload.u,
        headers: buildRequestHeaders(payload.u, payload.h && typeof payload.h === 'object' ? payload.h : {}),
        meta: payload.m || null
    };
}

function buildAbortSignal(req, res) {
    const controller = new AbortController();
    const abort = () => {
        if (!res.writableEnded) controller.abort();
    };
    req.on('aborted', abort);
    res.on('close', abort);
    return controller.signal;
}

async function fetchUpstream(sourceUrl, headers, req, signal, { allowRange = true } = {}) {
    const prepared = prepareProxyTarget(sourceUrl, headers || {}, {
        userAgent: DEFAULT_UA,
        acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
        allowRange,
        forceIdentityEncoding: true,
        fillReferer: true,
        fillOrigin: true
    });
    const requestHeaders = { ...(prepared.headers || {}) };
    const range = normalizeRangeHeader(req?.headers?.range);
    if (allowRange && range) requestHeaders.Range = range;
    else delete requestHeaders.Range;
    maybeLogProxyHeaderDecision(prepared, sourceUrl);
    return proxyHttpClient.get(sourceUrl, {
        headers: requestHeaders,
        signal
    });
}

async function fetchUpstreamWithRetry(sourceUrl, headers, req, signal, options = {}) {
    const attempts = Math.max(1, Math.min(UPSTREAM_RETRY_ATTEMPTS, Number(options.attempts || UPSTREAM_RETRY_ATTEMPTS) || UPSTREAM_RETRY_ATTEMPTS));
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const upstream = await fetchUpstream(sourceUrl, headers, req, signal, options);
            const status = Number(upstream?.status || 0);
            if (!isRetryableUpstreamStatus(status) || attempt >= attempts - 1) return upstream;
            destroyUpstream(upstream);
            await sleep(retryDelay(attempt));
        } catch (error) {
            lastError = error;
            if (isCanceledProxyError(error, signal)) throw error;
            if (attempt >= attempts - 1 || !isRetryableProxyError(error)) throw error;
            await sleep(retryDelay(attempt));
        }
    }

    throw lastError || new Error('Upstream request failed');
}

async function fetchRewrittenManifestPayload({ sourceUrl, headers, req, signal }) {
    const upstream = await fetchUpstreamWithRetry(sourceUrl, headers, req, signal, { allowRange: false, attempts: UPSTREAM_RETRY_ATTEMPTS });
    const status = Number(upstream.status || 0);
    const contentType = String(upstream.headers['content-type'] || '');

    if (status >= 300) {
        destroyUpstream(upstream);
        return {
            ok: false,
            status: status >= 400 ? status : 502,
            code: `upstream-${status}`,
            message: `CinemaCity upstream error ${status}`
        };
    }

    const manifestText = await readStreamLimited(upstream.data, MANIFEST_MAX_BYTES);
    if (!/^\ufeff?\s*#EXTM3U/i.test(manifestText)) {
        return {
            ok: false,
            status: 502,
            code: looksLikeHtmlBlock(Buffer.from(manifestText.slice(0, 1024)), contentType) ? 'html-or-block-page' : 'invalid-manifest',
            message: 'CinemaCity upstream did not return a valid HLS manifest'
        };
    }

    return {
        ok: true,
        body: rewriteManifest(manifestText, sourceUrl, req, headers),
        etag: upstream.headers?.etag || null,
        lastModified: upstream.headers?.['last-modified'] || null
    };
}


async function writeStreamWithSniff({ upstream, res, req, sourceUrl, contentType }) {
    const iterator = upstream.data?.[Symbol.asyncIterator]?.();
    if (!iterator) throw new Error('Invalid upstream stream');

    const first = await iterator.next();
    const firstBuffer = first.done ? Buffer.alloc(0) : (Buffer.isBuffer(first.value) ? first.value : Buffer.from(first.value || Buffer.alloc(0)));
    if (looksLikeHtmlBlock(firstBuffer, contentType)) {
        res.status(502);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-CC-Proxy-Error', 'html-or-block-page');
        return res.end('CinemaCity upstream returned HTML/block page instead of media');
    }

    const status = Number(upstream.status || 200) === 206 ? 206 : 200;
    res.status(status);
    res.setHeader('Content-Type', fallbackContentType(sourceUrl, contentType));
    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=300');
    res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
    copyUsefulHeaders(upstream, res, false);
    if (req.method === 'HEAD') return res.end();
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const writeChunk = async (chunk) => {
        if (!chunk || chunk.length === 0) return;
        if (!res.write(chunk)) await once(res, 'drain');
    };

    if (!first.done) await writeChunk(firstBuffer);
    for await (const chunk of iterator) {
        await writeChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return res.end();
}

async function handleCinemaCityProxy(req, res) {
    const proxyPathname = getProxyPathname(req);
    setPlaybackHeaders(res);
    res.setHeader('X-CC-Proxy', '1');
    if (req.method === 'OPTIONS') {
        res.status(204);
        return res.end();
    }
    if (req.method && !['GET', 'HEAD'].includes(String(req.method).toUpperCase())) {
        res.status(405);
        return res.end('Method Not Allowed');
    }

    const resolved = resolveProxySource(req);
    if (!resolved?.sourceUrl) {
        res.status(400);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-CC-Proxy-Error', 'invalid-token');
        return res.end('Invalid CinemaCity proxy token');
    }

    const signal = buildAbortSignal(req, res);
    try {
        if (proxyPathname === CC_MANIFEST_ROUTE) {
            const manifestKey = buildManifestCacheKey(req, resolved.sourceUrl, resolved.headers);
            const cached = manifestCache.get(manifestKey);
            if (cached) return sendManifestResponse(res, req, cached, 'HIT');

            const payload = await singleFlight(`manifest:${manifestKey}`, async () => {
                const existing = manifestCache.get(manifestKey);
                if (existing) return existing;
                const fresh = await fetchRewrittenManifestPayload({
                    sourceUrl: resolved.sourceUrl,
                    headers: resolved.headers,
                    req,
                    signal
                });
                if (fresh?.ok) manifestCache.set(manifestKey, fresh);
                return fresh;
            });

            if (!payload?.ok) {
                return sendProxyError(
                    res,
                    payload?.status || 502,
                    payload?.code || 'invalid-manifest',
                    payload?.message || 'CinemaCity upstream did not return a valid HLS manifest'
                );
            }
            return sendManifestResponse(res, req, payload, 'MISS');
        }

        const upstream = await fetchUpstreamWithRetry(resolved.sourceUrl, resolved.headers, req, signal, { allowRange: true });
        const contentType = String(upstream.headers['content-type'] || '');
        if (upstream.status >= 300) {
            destroyUpstream(upstream);
            return sendProxyError(
                res,
                upstream.status >= 400 ? upstream.status : 502,
                `upstream-${upstream.status}`,
                `CinemaCity upstream error ${upstream.status}`
            );
        }

        if (isHlsUrl(resolved.sourceUrl, contentType)) {
            const manifestText = await readStreamLimited(upstream.data, MANIFEST_MAX_BYTES);
            if (!/^\ufeff?\s*#EXTM3U/i.test(manifestText)) {
                return sendProxyError(res, 502, 'invalid-manifest', 'CinemaCity upstream did not return a valid HLS manifest');
            }
            const rewritten = rewriteManifest(manifestText, resolved.sourceUrl, req, resolved.headers);
            return sendManifestResponse(res, req, {
                ok: true,
                body: rewritten,
                etag: upstream.headers?.etag || null,
                lastModified: upstream.headers?.['last-modified'] || null
            }, 'BYPASS');
        }

        return writeStreamWithSniff({ upstream, res, req, sourceUrl: resolved.sourceUrl, contentType });
    } catch (error) {
        if (isCanceledProxyError(error, signal)) return null;
        if (!res.headersSent) {
            return sendProxyError(
                res,
                error?.code === 'MANIFEST_TOO_LARGE' ? 413 : 502,
                error?.code === 'MANIFEST_TOO_LARGE' ? 'manifest-too-large' : 'proxy-error',
                error?.code === 'MANIFEST_TOO_LARGE' ? 'CinemaCity manifest too large' : 'CinemaCity proxy error'
            );
        }
        try { res.destroy(error); } catch (_) {}
        return null;
    }
}

module.exports = {
    CC_MANIFEST_ROUTE,
    CC_STREAM_ROUTE,
    buildCinemaCityProxyUrl,
    handleCinemaCityProxy
};
