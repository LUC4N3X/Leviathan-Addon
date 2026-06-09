'use strict';

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getRequestOrigin, isSafeRemoteUrl } = require('../../core/utils/url');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const { buildForwardProxyUrl, getForwardProxyBase } = require('../../core/proxy/forward_proxy_config');
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
const SECRET_FILE = path.join(__dirname, '..', 'config', 'cinemacity_proxy_secret.key');
const PROCESS_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');
let cachedSecret = null;

const PROXY_URL_CACHE_TTL_MS = Math.max(60 * 1000, Math.min(PLAYBACK_TOKEN_TTL_MS - 60 * 1000, Number.parseInt(process.env.CC_PROXY_URL_CACHE_TTL_MS || String(45 * 60 * 1000), 10) || (45 * 60 * 1000)));
const PROXY_URL_CACHE_MAX = Math.max(500, Math.min(10000, Number.parseInt(process.env.CC_PROXY_URL_CACHE_MAX || '5000', 10) || 5000));
const MANIFEST_CACHE_TTL_MS = Math.max(1500, Math.min(60 * 1000, Number.parseInt(process.env.CC_PROXY_MANIFEST_CACHE_TTL_MS || '12000', 10) || 12000));
const MANIFEST_CACHE_MAX = Math.max(50, Math.min(1000, Number.parseInt(process.env.CC_PROXY_MANIFEST_CACHE_MAX || '300', 10) || 300));
const STREAM_RETRY_ATTEMPTS = Math.max(1, Math.min(3, Number.parseInt(process.env.CC_PROXY_STREAM_RETRY_ATTEMPTS || '2', 10) || 2));
const STREAM_RETRY_BASE_DELAY_MS = Math.max(50, Math.min(1000, Number.parseInt(process.env.CC_PROXY_STREAM_RETRY_BASE_DELAY_MS || '160', 10) || 160));
const MANIFEST_STALE_TTL_MS = Math.max(60 * 1000, Math.min(15 * 60 * 1000, Number.parseInt(process.env.CC_PROXY_MANIFEST_STALE_TTL_MS || String(6 * 60 * 1000), 10) || (6 * 60 * 1000)));
const SMALL_OBJECT_CACHE_TTL_MS = Math.max(60 * 1000, Math.min(30 * 60 * 1000, Number.parseInt(process.env.CC_PROXY_SMALL_CACHE_TTL_MS || String(15 * 60 * 1000), 10) || (15 * 60 * 1000)));
const SMALL_OBJECT_CACHE_MAX = Math.max(50, Math.min(2000, Number.parseInt(process.env.CC_PROXY_SMALL_CACHE_MAX || '500', 10) || 500));
const SMALL_OBJECT_CACHE_MAX_BYTES = Math.max(16 * 1024, Math.min(512 * 1024, Number.parseInt(process.env.CC_PROXY_SMALL_CACHE_MAX_BYTES || String(192 * 1024), 10) || (192 * 1024)));
const STREAM_IDLE_TIMEOUT_MS = Math.max(8000, Math.min(90 * 1000, Number.parseInt(process.env.CC_PROXY_STREAM_IDLE_TIMEOUT_MS || '28000', 10) || 28000));
const RESUME_BOOTSTRAP_ENABLED = String(process.env.CC_PROXY_RESUME_BOOTSTRAP || '1') !== '0';
const RESUME_BOOTSTRAP_BYTES = Math.max(512 * 1024, Math.min(64 * 1024 * 1024, Number.parseInt(process.env.CC_PROXY_RESUME_BOOTSTRAP_BYTES || String(8 * 1024 * 1024), 10) || (8 * 1024 * 1024)));
const RESUME_BOOTSTRAP_MIN_OFFSET_BYTES = Math.max(0, Math.min(256 * 1024 * 1024, Number.parseInt(process.env.CC_PROXY_RESUME_BOOTSTRAP_MIN_OFFSET_BYTES || String(2 * 1024 * 1024), 10) || (2 * 1024 * 1024)));
const RANGE_RETRY_ATTEMPTS = Math.max(1, Math.min(2, Number.parseInt(process.env.CC_PROXY_RANGE_RETRY_ATTEMPTS || '1', 10) || 1));
const PLAYBACK_PREWARM_ENABLED = String(process.env.CC_PROXY_PLAYBACK_PREWARM || '1') !== '0';
const PLAYBACK_PREWARM_TIMEOUT_MS = Math.max(800, Math.min(8000, Number.parseInt(process.env.CC_PROXY_PLAYBACK_PREWARM_TIMEOUT_MS || '2600', 10) || 2600));
const CC_PROXY_MASTER_FILTER_PATCH = 'ccproxy-master-filter-1080-v1';
const CC_PROXY_FORCE_QUALITY_ENABLED = String(process.env.CC_PROXY_FORCE_QUALITY || process.env.CC_PROXY_MASTER_FILTER || '1') !== '0';
const CC_PROXY_FORCE_QUALITY_VALUE = Math.max(360, Math.min(4320, Number.parseInt(process.env.CC_PROXY_FORCE_QUALITY_VALUE || '1080', 10) || 1080));
const proxyUrlCache = new Map();
const manifestCache = new Map();
const smallObjectCache = new Map();
const inFlightTasks = new Map();



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
        || preview.includes('cf-browser-verification')
        || preview.includes('cf-challenge')
        || preview.includes('checking your browser')
        || preview.includes('ddos-guard')
        || preview.includes('captcha')
        || preview.includes('access denied')
        || preview.includes('forbidden')
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
        
        cachedSecret = PROCESS_FALLBACK_SECRET;
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
    const prepared = prepareProxyTarget(targetUrl, sourceHeaders, {
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


function getCinemaCityForwardProxyBase() {
    try {
        return getForwardProxyBase({ context: 'cinemacity_cc_proxy' });
    } catch (_) {
        return '';
    }
}

function buildForwardHeaderParams(headers = {}) {
    const params = {};
    for (const [rawName, rawValue] of Object.entries(headers || {})) {
        if (rawValue === undefined || rawValue === null || rawValue === '') continue;
        const name = String(rawName || '').trim().toLowerCase();
        if (!name || !/^[a-z0-9-]+$/i.test(name)) continue;
        params[`h_${name}`] = String(rawValue);
    }
    return params;
}

function buildCinemaCityForwardProxyUrl(targetUrl, headers = {}) {
    const base = getCinemaCityForwardProxyBase();
    if (!base) return null;
    try {
        return buildForwardProxyUrl(targetUrl, {
            base,
            context: 'cinemacity_cc_proxy',
            params: buildForwardHeaderParams(headers)
        });
    } catch (_) {
        return null;
    }
}

function isHlsUrl(targetUrl, contentType = '') {
    return /mpegurl|x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(contentType || '') || /\.m3u8(?:$|[?#])/i.test(String(targetUrl || ''));
}

function getRouteForTarget(targetUrl, contentType = '') {
    return isHlsUrl(targetUrl, contentType) ? CC_MANIFEST_ROUTE : CC_STREAM_ROUTE;
}


function stableStringify(value) {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Base64Url(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url');
}

function pruneExpiringMap(map, maxSize) {
    if (!map || map.size <= maxSize) return;
    const current = Date.now();
    for (const [key, item] of map.entries()) {
        if (!item || Number(item.expiresAt || 0) <= current || map.size > Math.floor(maxSize * 0.9)) {
            map.delete(key);
        }
    }
}

function getProxyUrlCacheKey(baseUrl, targetUrl, headers, routePath, meta) {
    return sha256Base64Url([
        normalizeAddonBase(baseUrl),
        String(targetUrl || ''),
        String(routePath || ''),
        stableStringify(headers || {}),
        stableStringify(meta || {})
    ].join('\n'));
}

function getCachedProxyUrl(key) {
    const entry = proxyUrlCache.get(key);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
        proxyUrlCache.delete(key);
        return null;
    }
    return entry.url || null;
}

function setCachedProxyUrl(key, url, ttlMs = PROXY_URL_CACHE_TTL_MS) {
    if (!key || !url) return url;
    proxyUrlCache.set(key, {
        url,
        expiresAt: Date.now() + Math.max(30 * 1000, Number(ttlMs) || PROXY_URL_CACHE_TTL_MS)
    });
    pruneExpiringMap(proxyUrlCache, PROXY_URL_CACHE_MAX);
    return url;
}

function getRequestBase(req) {
    if (req?.__ccProxyBase) return normalizeAddonBase(req.__ccProxyBase);
    return getRequestOrigin(req) || normalizeAddonBase(null);
}

function getManifestCacheKey(req, sourceUrl, headers = {}) {
    return sha256Base64Url([
        getRequestBase(req),
        String(sourceUrl || ''),
        stableStringify(headers || {}),
        CC_PROXY_FORCE_QUALITY_ENABLED ? `q${CC_PROXY_FORCE_QUALITY_VALUE}:${CC_PROXY_MASTER_FILTER_PATCH}` : 'qoff'
    ].join('\n'));
}

function getCachedManifest(key, options = {}) {
    const entry = manifestCache.get(key);
    if (!entry) return null;

    const current = Date.now();
    const fresh = Number(entry.expiresAt || 0) > current;
    const staleAllowed = options.allowStale === true && Number(entry.staleUntil || 0) > current;

    if (fresh) return { ...entry, stale: false };
    if (staleAllowed) return { ...entry, stale: true };

    if (Number(entry.staleUntil || 0) <= current) manifestCache.delete(key);
    return null;
}

function refreshManifestEntry(key, entry) {
    if (!key || !entry?.body) return entry || null;
    const refreshed = {
        ...entry,
        expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS,
        staleUntil: Date.now() + MANIFEST_CACHE_TTL_MS + MANIFEST_STALE_TTL_MS,
        refreshedAt: Date.now(),
        stale: false
    };
    manifestCache.set(key, refreshed);
    pruneExpiringMap(manifestCache, MANIFEST_CACHE_MAX);
    return refreshed;
}

function setCachedManifest(key, body, upstreamHeaders = {}) {
    if (!key || !body) return null;
    const etag = `W/"ccp-${sha256Base64Url(body).slice(0, 24)}"`;
    const entry = {
        body,
        etag,
        upstreamEtag: upstreamHeaders['etag'] || null,
        lastModified: upstreamHeaders['last-modified'] || null,
        expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS,
        staleUntil: Date.now() + MANIFEST_CACHE_TTL_MS + MANIFEST_STALE_TTL_MS,
        createdAt: Date.now(),
        refreshedAt: Date.now(),
        stale: false
    };
    manifestCache.set(key, entry);
    pruneExpiringMap(manifestCache, MANIFEST_CACHE_MAX);
    return entry;
}

function isSmallObjectCacheable(sourceUrl = '', contentType = '') {
    const url = String(sourceUrl || '').split('?')[0].toLowerCase();
    const type = String(contentType || '').toLowerCase();
    return /\.(key|vtt|srt|ass|ssa)(?:$|[?#])/i.test(url)
        || /text\/(vtt|plain)/i.test(type)
        || (/application\/octet-stream/i.test(type) && /\.key$/i.test(url));
}

function getSmallObjectCacheKey(sourceUrl, headers = {}) {
    return sha256Base64Url([String(sourceUrl || ''), stableStringify(headers || {})].join('\n'));
}

function getCachedSmallObject(key) {
    const entry = smallObjectCache.get(key);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
        smallObjectCache.delete(key);
        return null;
    }
    return entry;
}

function setCachedSmallObject(key, buffer, headers = {}, contentType = '') {
    if (!key || !Buffer.isBuffer(buffer) || buffer.length <= 0 || buffer.length > SMALL_OBJECT_CACHE_MAX_BYTES) return null;
    const entry = {
        buffer,
        contentType,
        etag: `W/"ccp-small-${sha256Base64Url(buffer).slice(0, 24)}"`,
        lastModified: headers['last-modified'] || null,
        expiresAt: Date.now() + SMALL_OBJECT_CACHE_TTL_MS,
        createdAt: Date.now()
    };
    smallObjectCache.set(key, entry);
    pruneExpiringMap(smallObjectCache, SMALL_OBJECT_CACHE_MAX);
    return entry;
}

async function readStreamBufferLimited(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            const error = new Error('Small object too large');
            error.code = 'SMALL_OBJECT_TOO_LARGE';
            throw error;
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function writeSmallObjectResponse({ req, res, entry, sourceUrl, cacheState = 'hit' }) {
    const buffer = Buffer.isBuffer(entry?.buffer) ? entry.buffer : Buffer.alloc(0);
    const contentType = entry?.contentType || fallbackContentType(sourceUrl, '');
    const ifNoneMatch = String(req.headers?.['if-none-match'] || '').trim();

    res.status(ifNoneMatch && entry?.etag && ifNoneMatch === entry.etag ? 304 : 200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', `public, max-age=${Math.max(1, Math.floor(SMALL_OBJECT_CACHE_TTL_MS / 1000))}, immutable`);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('X-CC-Proxy-Small-Cache', cacheState);
    if (entry?.etag) res.setHeader('ETag', entry.etag);
    if (entry?.lastModified) res.setHeader('Last-Modified', entry.lastModified);
    if (res.statusCode === 304 || req.method === 'HEAD') return res.end();
    res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
}

async function singleFlight(key, fn) {
    const existing = inFlightTasks.get(key);
    if (existing) return existing;
    const task = Promise.resolve()
        .then(fn)
        .finally(() => inFlightTasks.delete(key));
    inFlightTasks.set(key, task);
    return task;
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

    const cacheKey = getProxyUrlCacheKey(normalizedBase, normalizedTarget, prepared.headers, selectedRoute, meta);
    const cachedUrl = getCachedProxyUrl(cacheKey);
    if (cachedUrl) return cachedUrl;

    // Minute bucketing keeps tokens stable long enough for Stremio resume/seek and segment cache reuse.
    const issuedAt = Math.floor(Date.now() / 60_000) * 60_000;
    const token = packToken({
        u: normalizedTarget,
        h: prepared.headers,
        r: selectedRoute,
        e: issuedAt + PLAYBACK_TOKEN_TTL_MS,
        i: issuedAt,
        m: meta || null
    });
    const proxyUrl = token ? `${normalizedBase}${selectedRoute}?d=${encodeURIComponent(token)}` : null;
    return setCachedProxyUrl(cacheKey, proxyUrl);
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
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Content-Type,ETag,Last-Modified');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
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

function isCinemaCityCccdnUrl(value = '') {
    try {
        const parsed = new URL(String(value || ''));
        const host = String(parsed.hostname || '').toLowerCase();
        const pathName = String(parsed.pathname || '').toLowerCase();
        return host.includes('cccdn.net') || (pathName.includes('/public_files/') && pathName.includes('.urlset/'));
    } catch (_) {
        return /cccdn\.net|\/public_files\/.*\.urlset\//i.test(String(value || ''));
    }
}

function getAttributeValue(line = '', name = '') {
    const pattern = new RegExp(`(?:^|,)${String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=("[^"]*"|[^,]*)`, 'i');
    const match = String(line || '').match(pattern);
    if (!match) return '';
    return String(match[1] || '').replace(/^"|"$/g, '').trim();
}

function inferHlsVariantQuality(streamInfLine = '', uriLine = '') {
    const resolution = getAttributeValue(streamInfLine, 'RESOLUTION');
    const resMatch = String(resolution || '').match(/(\d{3,5})\s*x\s*(\d{3,5})/i);
    if (resMatch) {
        const width = Number.parseInt(resMatch[1], 10) || 0;
        const height = Number.parseInt(resMatch[2], 10) || 0;
        if (width >= 3800 || height >= 2000) return 2160;
        if (width >= 2500 || height >= 1300) return 1440;
        if (width >= 1900 || height >= 1000) return 1080;
        if (width >= 1200 || height >= 650) return 720;
        if (width >= 900 || height >= 520) return 576;
        if (width >= 700 || height >= 430) return 480;
        return height || width || 0;
    }
    const qualityMatch = `${streamInfLine} ${uriLine}`.match(/(?:^|[^0-9])(2160|1440|1080|720|576|480|360)p(?:[^0-9]|$)/i);
    if (qualityMatch) return Number.parseInt(qualityMatch[1], 10) || 0;
    const bandwidth = Number.parseInt(getAttributeValue(streamInfLine, 'BANDWIDTH') || '0', 10) || 0;
    if (bandwidth >= 7000000) return 1080;
    if (bandwidth >= 2500000) return 720;
    if (bandwidth >= 1200000) return 480;
    return 0;
}

function filterCinemaCityMasterManifest(manifestText, sourceUrl = '') {
    const body = String(manifestText || '');
    if (!CC_PROXY_FORCE_QUALITY_ENABLED || !isCinemaCityCccdnUrl(sourceUrl) || !body.includes('#EXT-X-STREAM-INF')) {
        return { body, changed: false };
    }

    const lines = body.replace(/\r\n/g, '\n').split('\n');
    const variants = [];

    for (let i = 0; i < lines.length; i += 1) {
        const line = String(lines[i] || '').trim();
        if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
        let uriIndex = -1;
        for (let j = i + 1; j < lines.length; j += 1) {
            const next = String(lines[j] || '').trim();
            if (!next) continue;
            if (next.startsWith('#')) break;
            uriIndex = j;
            break;
        }
        if (uriIndex < 0) continue;
        variants.push({
            streamIndex: i,
            uriIndex,
            quality: inferHlsVariantQuality(lines[i], lines[uriIndex]),
            bandwidth: Number.parseInt(getAttributeValue(lines[i], 'BANDWIDTH') || '0', 10) || 0,
            uri: String(lines[uriIndex] || '').trim()
        });
    }

    if (variants.length <= 1) return { body, changed: false, variantsBefore: variants.length };

    const exact = variants
        .filter((variant) => variant.quality === CC_PROXY_FORCE_QUALITY_VALUE)
        .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const selected = exact || variants
        .slice()
        .sort((a, b) => (b.quality || 0) - (a.quality || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))[0];

    if (!selected) return { body, changed: false, variantsBefore: variants.length };

    const keep = new Set([selected.streamIndex, selected.uriIndex]);
    const drop = new Set();
    for (const variant of variants) {
        if (variant === selected) continue;
        drop.add(variant.streamIndex);
        drop.add(variant.uriIndex);
    }

    const filtered = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (drop.has(i) && !keep.has(i)) continue;
        filtered.push(lines[i]);
    }

    const result = filtered.join('\n');
    return {
        body: result.endsWith('\n') ? result : `${result}\n`,
        changed: true,
        patch: CC_PROXY_MASTER_FILTER_PATCH,
        selectedQuality: selected.quality || 0,
        selectedUri: selected.uri,
        variantsBefore: variants.length,
        variantsAfter: 1,
        removed: Math.max(0, variants.length - 1)
    };
}

function rewriteDirectiveUri(line, baseUrl, req, headers) {
    const requestBase = getRequestBase(req);
    return String(line || '').replace(/URI=("([^"]*)"|'([^']*)'|([^,\s]+))/ig, (full, rawValue, doubleQuoted, singleQuoted, bareValue) => {
        const uri = doubleQuoted || singleQuoted || bareValue || '';
        const absolute = safeUrl(uri, baseUrl);
        const rewritten = absolute ? buildProxyUrl(requestBase, absolute, headers, getRouteForTarget(absolute)) : null;
        if (!rewritten) return full;
        if (rawValue.startsWith('"')) return `URI="${rewritten}"`;
        if (rawValue.startsWith("'")) return `URI='${rewritten}'`;
        return `URI=${rewritten}`;
    });
}

function rewriteManifest(manifestText, baseUrl, req, headers) {
    const requestBase = getRequestBase(req);
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
                out.push(absolute ? (buildProxyUrl(requestBase, absolute, headers, CC_MANIFEST_ROUTE) || nextLine) : nextLine);
                i += 1;
            }
            continue;
        }
        if (
            line.startsWith('#EXT-X-KEY')
            || line.startsWith('#EXT-X-MAP')
            || line.startsWith('#EXT-X-MEDIA')
            || line.startsWith('#EXT-X-PART')
            || line.startsWith('#EXT-X-PRELOAD-HINT')
            || line.startsWith('#EXT-X-RENDITION-REPORT')
            || line.startsWith('#EXT-X-SESSION-KEY')
            || line.startsWith('#EXT-X-SESSION-DATA')
        ) {
            out.push(rewriteDirectiveUri(rawLine, baseUrl, req, headers));
            continue;
        }
        if (line.startsWith('#')) {
            out.push(rawLine);
            continue;
        }
        const absolute = safeUrl(line, baseUrl);
        out.push(absolute ? (buildProxyUrl(requestBase, absolute, headers, getRouteForTarget(absolute)) || line) : rawLine);
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
    const payload = unpackToken(req.query.d);
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


function isSafeSingleRange(value = '') {
    const raw = String(value || '').trim();
    const match = raw.match(/^bytes=(\d*)-(\d*)$/i);
    if (!match) return false;
    const start = match[1] ? Number(match[1]) : null;
    const end = match[2] ? Number(match[2]) : null;
    if (start == null && end == null) return false;
    if (start != null && !Number.isSafeInteger(start)) return false;
    if (end != null && !Number.isSafeInteger(end)) return false;
    if (start != null && end != null && end < start) return false;
    return true;
}

function parseSingleRange(value = '') {
    const raw = String(value || '').trim();
    const match = raw.match(/^bytes=(\d*)-(\d*)$/i);
    if (!match) return null;
    const start = match[1] ? Number(match[1]) : null;
    const end = match[2] ? Number(match[2]) : null;
    if (start == null && end == null) return null;
    if (start != null && !Number.isSafeInteger(start)) return null;
    if (end != null && !Number.isSafeInteger(end)) return null;
    if (start != null && end != null && end < start) return null;
    return { start, end, raw };
}

function isLikelyHlsSegmentUrl(sourceUrl = '') {
    return /\.(ts|m4s|aac|key|vtt|srt|ass|ssa)(?:$|[?#])/i.test(String(sourceUrl || ''));
}

function getResumeBootstrapRange(req, sourceUrl = '') {
    if (!RESUME_BOOTSTRAP_ENABLED || !req || String(req.method || 'GET').toUpperCase() === 'HEAD') return null;
    const parsed = parseSingleRange(req.headers?.range);
    if (!parsed || parsed.start == null || parsed.end != null) return null;
    if (parsed.start < RESUME_BOOTSTRAP_MIN_OFFSET_BYTES) return null;
    if (isLikelyHlsSegmentUrl(sourceUrl)) return null;
    const end = Math.min(Number.MAX_SAFE_INTEGER, parsed.start + RESUME_BOOTSTRAP_BYTES - 1);
    return {
        clientRange: parsed.raw,
        upstreamRange: `bytes=${parsed.start}-${end}`,
        start: parsed.start,
        end,
        bytes: end - parsed.start + 1
    };
}

function isKnownMediaUrl(sourceUrl = '') {
    return /\.(ts|m4s|mp4|mkv|webm|mov|m4v|aac|mp3|key)(?:$|[?#])/i.test(String(sourceUrl || ''));
}

function isMediaContentType(contentType = '') {
    return /^(video|audio)\//i.test(String(contentType || ''))
        || /application\/octet-stream/i.test(String(contentType || ''))
        || /application\/dash\+xml/i.test(String(contentType || ''))
        || /application\/vnd\.apple\.mpegurl/i.test(String(contentType || ''));
}

function shouldFastPipeWithoutSniff({ req, upstream, sourceUrl, contentType }) {
    const status = Number(upstream?.status || 0);
    const hasRange = Boolean(req?.headers?.range);
    const type = String(contentType || '').toLowerCase();

    
    if (status === 206 && hasRange) return true;

    
    if (status === 200 && !hasRange && isKnownMediaUrl(sourceUrl) && isMediaContentType(type) && !type.includes('text/html')) return true;

    return false;
}

function getMediaCacheControl(sourceUrl = '') {
    if (/\.(ts|m4s|aac|mp4|m4v|key)(?:$|[?#])/i.test(String(sourceUrl || ''))) {
        return 'public, max-age=7200, stale-while-revalidate=1800';
    }
    return 'public, max-age=1800, stale-while-revalidate=300';
}

function isRetryableUpstreamStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(Number(status || 0));
}

function destroyUpstreamQuietly(upstream) {
    try { upstream?.data?.destroy?.(); } catch (_) {}
}

function getAgentForUrl(sourceUrl) {
    return /^https:/i.test(String(sourceUrl || '')) ? HTTPS_AGENT : HTTP_AGENT;
}

function tunePlaybackSockets(req, res) {
    
    try { req?.socket?.setNoDelay?.(true); } catch (_) {}
    try { res?.socket?.setNoDelay?.(true); } catch (_) {}
}

function pipeUpstreamFast(upstream, res, req, sourceUrl, mode = 'fast-pipe') {
    tunePlaybackSockets(req, res);
    res.setHeader('X-CC-Proxy-Pipe', mode);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const clearWatchdog = armIdleWatchdog(upstream.data, res, sourceUrl);
    upstream.data.on('error', (error) => {
        clearWatchdog();
        try { res.destroy(error); } catch (_) {}
    });
    upstream.data.on('end', clearWatchdog);
    upstream.data.on('close', clearWatchdog);
    return upstream.data.pipe(res);
}

async function peekAndRestoreFirstChunk(stream) {
    if (!stream || typeof stream.once !== 'function') throw new Error('Invalid upstream stream');
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
        };
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };
        const onData = (chunk) => {
            try { stream.pause?.(); } catch (_) {}
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || Buffer.alloc(0));
            if (buffer.length > 0 && typeof stream.unshift === 'function') {
                try { stream.unshift(buffer); } catch (_) {}
            }
            finish(resolve, buffer);
        };
        const onEnd = () => finish(resolve, Buffer.alloc(0));
        const onError = (error) => finish(reject, error);
        stream.once('data', onData);
        stream.once('end', onEnd);
        stream.once('error', onError);
        try { stream.resume?.(); } catch (_) {}
    });
}

async function fetchUpstream(sourceUrl, headers, req, signal, { allowRange = true, extraHeaders = null } = {}) {
    const prepared = prepareProxyTarget(sourceUrl, headers || {}, {
        userAgent: DEFAULT_UA,
        acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
        allowRange,
        forceIdentityEncoding: true,
        fillReferer: true,
        fillOrigin: true
    });
    const requestHeaders = { ...(prepared.headers || {}), ...(extraHeaders || {}) };
    const range = String(req?.headers?.range || '').trim();
    const resumeBootstrap = allowRange && range && isSafeSingleRange(range) ? getResumeBootstrapRange(req, sourceUrl) : null;
    if (allowRange && range && isSafeSingleRange(range)) requestHeaders.Range = resumeBootstrap?.upstreamRange || range;
    else delete requestHeaders.Range;
    maybeLogProxyHeaderDecision(prepared, sourceUrl);
    const requestUrl = buildCinemaCityForwardProxyUrl(sourceUrl, requestHeaders) || sourceUrl;
    const response = await axios.get(requestUrl, {
        headers: requestHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
        maxRedirects: MAX_UPSTREAM_REDIRECTS,
        responseType: 'stream',
        validateStatus: () => true,
        proxy: false,
        decompress: false,
        httpAgent: getAgentForUrl(requestUrl),
        httpsAgent: getAgentForUrl(requestUrl),
        signal
    });
    if (resumeBootstrap) response.ccRangeBootstrap = resumeBootstrap;
    return response;
}

async function fetchUpstreamWithRetry(sourceUrl, headers, req, signal, options = {}) {
    const attempts = Math.max(1, Math.min(STREAM_RETRY_ATTEMPTS, Number(options.attempts || STREAM_RETRY_ATTEMPTS) || STREAM_RETRY_ATTEMPTS));
    let lastError = null;
    let lastResponse = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (signal?.aborted) throw lastError || new Error('Proxy request aborted');
        if (attempt > 0) {
            const delay = STREAM_RETRY_BASE_DELAY_MS * attempt + Math.floor(Math.random() * 120);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        try {
            const upstream = await fetchUpstream(sourceUrl, headers, req, signal, options);
            const status = Number(upstream?.status || 0);
            if (!isRetryableUpstreamStatus(status) || attempt >= attempts - 1) return upstream;
            lastResponse = upstream;
            destroyUpstreamQuietly(upstream);
        } catch (error) {
            lastError = error;
            if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED' || signal?.aborted || attempt >= attempts - 1) throw error;
        }
    }

    if (lastResponse) return lastResponse;
    throw lastError || new Error('CinemaCity upstream retry failed');
}


function armIdleWatchdog(stream, res, label = 'stream') {
    let timer = null;
    const clear = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };
    const refresh = () => {
        clear();
        timer = setTimeout(() => {
            const error = new Error(`CinemaCity proxy idle timeout on ${label}`);
            error.code = 'STREAM_IDLE_TIMEOUT';
            try { stream?.destroy?.(error); } catch (_) {}
            try { res?.destroy?.(error); } catch (_) {}
        }, STREAM_IDLE_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
    };

    refresh();
    stream?.on?.('data', refresh);
    stream?.on?.('end', clear);
    stream?.on?.('close', clear);
    stream?.on?.('error', clear);
    res?.on?.('close', clear);
    return clear;
}


async function writeStreamWithSniff({ upstream, res, req, sourceUrl, contentType }) {
    const status = Number(upstream.status || 200) === 206 ? 206 : 200;
    const fastPipe = shouldFastPipeWithoutSniff({ req, upstream, sourceUrl, contentType });

    if (req.method === 'HEAD') {
        tunePlaybackSockets(req, res);
        res.status(status);
        res.setHeader('Content-Type', fallbackContentType(sourceUrl, contentType));
        res.setHeader('Cache-Control', getMediaCacheControl(sourceUrl));
        res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
        copyUsefulHeaders(upstream, res, false);
        destroyUpstreamQuietly(upstream);
        return res.end();
    }

    res.status(status);
    res.setHeader('Content-Type', fallbackContentType(sourceUrl, contentType));
    res.setHeader('Cache-Control', getMediaCacheControl(sourceUrl));
    res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
    copyUsefulHeaders(upstream, res, false);

    if (fastPipe) {
        res.setHeader('X-CC-Proxy-Resume', upstream.ccRangeBootstrap ? 'bootstrap-range' : (req?.headers?.range ? 'fast-range' : 'fast-start'));
        if (upstream.ccRangeBootstrap) {
            res.setHeader('X-CC-Proxy-Resume-Bootstrap', `${upstream.ccRangeBootstrap.bytes}`);
            res.setHeader('X-CC-Proxy-Upstream-Range', upstream.ccRangeBootstrap.upstreamRange);
        }
        return pipeUpstreamFast(upstream, res, req, sourceUrl, upstream.ccRangeBootstrap ? 'bootstrap-range-pipe' : (req?.headers?.range ? 'range-fast-pipe' : 'start-fast-pipe'));
    }

    // Slow/suspicious path: read only the first chunk to detect HTML/CF/DDOS pages,
    // push it back into the readable, then return to native pipe. The previous manual
    // for-await writer was safe but noticeably slower on Stremio seek/open.
    const firstBuffer = await peekAndRestoreFirstChunk(upstream.data);
    if (looksLikeHtmlBlock(firstBuffer, contentType)) {
        destroyUpstreamQuietly(upstream);
        res.status(502);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-CC-Proxy-Error', 'html-or-block-page');
        return res.end('CinemaCity upstream returned HTML/block page instead of media');
    }

    res.setHeader('X-CC-Proxy-Resume', upstream.ccRangeBootstrap ? 'sniffed-bootstrap-range' : (req?.headers?.range ? 'sniffed-range-pipe' : 'sniffed-start-pipe'));
    if (upstream.ccRangeBootstrap) {
        res.setHeader('X-CC-Proxy-Resume-Bootstrap', `${upstream.ccRangeBootstrap.bytes}`);
        res.setHeader('X-CC-Proxy-Upstream-Range', upstream.ccRangeBootstrap.upstreamRange);
    }
    return pipeUpstreamFast(upstream, res, req, sourceUrl, upstream.ccRangeBootstrap ? 'sniffed-bootstrap-fast-pipe' : 'sniffed-fast-pipe');
}

function writeManifestResponse({ req, res, manifestEntry, cacheState = 'miss' }) {
    const body = String(manifestEntry?.body || '');
    const etag = manifestEntry?.etag || `W/"ccp-${sha256Base64Url(body).slice(0, 24)}"`;
    const ifNoneMatch = String(req.headers?.['if-none-match'] || '').trim();

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${Math.max(1, Math.floor(MANIFEST_CACHE_TTL_MS / 1000))}, stale-while-revalidate=20`);
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('ETag', etag);
    res.setHeader('X-CC-Proxy-Manifest-Cache', cacheState);
    if (manifestEntry?.lastModified) res.setHeader('Last-Modified', manifestEntry.lastModified);

    if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304);
        return res.end();
    }

    res.status(200);
    res.setHeader('Content-Length', Buffer.byteLength(body));
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
}

async function getRewrittenManifestEntry({ req, sourceUrl, headers, signal }) {
    const manifestKey = getManifestCacheKey(req, sourceUrl, headers);
    const cached = getCachedManifest(manifestKey);
    if (cached) return { entry: cached, state: 'hit' };

    const staleCandidate = getCachedManifest(manifestKey, { allowStale: true });

    try {
        const entry = await singleFlight(`manifest:${manifestKey}`, async () => {
            const fresh = getCachedManifest(manifestKey);
            if (fresh) return fresh;

            const stale = getCachedManifest(manifestKey, { allowStale: true });
            const conditionalHeaders = {};
            if (stale?.upstreamEtag) conditionalHeaders['If-None-Match'] = stale.upstreamEtag;
            if (stale?.lastModified) conditionalHeaders['If-Modified-Since'] = stale.lastModified;

            const upstream = await fetchUpstreamWithRetry(sourceUrl, headers, req, signal, {
                allowRange: false,
                attempts: STREAM_RETRY_ATTEMPTS,
                extraHeaders: conditionalHeaders
            });
            const status = Number(upstream?.status || 0);

            if (status === 304 && stale?.body) {
                destroyUpstreamQuietly(upstream);
                return refreshManifestEntry(manifestKey, stale);
            }

            if (status >= 300) {
                const error = new Error(`CinemaCity upstream error ${status}`);
                error.status = status;
                destroyUpstreamQuietly(upstream);
                throw error;
            }
            const manifestText = await readStreamLimited(upstream.data, MANIFEST_MAX_BYTES);
            if (!/^\ufeff?\s*#EXTM3U/i.test(manifestText)) {
                const error = new Error('Invalid CinemaCity manifest');
                error.code = 'INVALID_MANIFEST';
                throw error;
            }
            const filtered = filterCinemaCityMasterManifest(manifestText, sourceUrl);
            if (filtered.changed) {
                console.log(`[CinemaCity] ccproxy.master_filter | patch=${filtered.patch} | desired=${CC_PROXY_FORCE_QUALITY_VALUE} | selected=${filtered.selectedQuality} | variants_before=${filtered.variantsBefore} | variants_after=${filtered.variantsAfter} | removed=${filtered.removed} | uri=${String(filtered.selectedUri || '').slice(0, 180)}`);
            }
            const rewritten = rewriteManifest(filtered.body, sourceUrl, req, headers);
            return setCachedManifest(manifestKey, rewritten, upstream.headers || {});
        });

        return { entry, state: entry?.stale ? 'stale' : 'miss' };
    } catch (error) {
        const stale = staleCandidate || getCachedManifest(manifestKey, { allowStale: true });
        if (stale?.body) return { entry: stale, state: 'stale-if-error' };
        throw error;
    }
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
        const allowRange = proxyPathname !== CC_MANIFEST_ROUTE;
        if (proxyPathname === CC_MANIFEST_ROUTE) {
            const { entry, state } = await getRewrittenManifestEntry({
                req,
                sourceUrl: resolved.sourceUrl,
                headers: resolved.headers,
                signal
            });
            return writeManifestResponse({ req, res, manifestEntry: entry, cacheState: state });
        }

        const hasRange = Boolean(req.headers?.range);
        const smallCacheKey = !hasRange && isSmallObjectCacheable(resolved.sourceUrl)
            ? getSmallObjectCacheKey(resolved.sourceUrl, resolved.headers)
            : null;
        const cachedSmallObject = smallCacheKey ? getCachedSmallObject(smallCacheKey) : null;
        if (cachedSmallObject) {
            return writeSmallObjectResponse({
                req,
                res,
                entry: cachedSmallObject,
                sourceUrl: resolved.sourceUrl,
                cacheState: 'hit'
            });
        }

        const upstream = await fetchUpstreamWithRetry(resolved.sourceUrl, resolved.headers, req, signal, {
            allowRange,
            attempts: hasRange ? RANGE_RETRY_ATTEMPTS : STREAM_RETRY_ATTEMPTS
        });
        const contentType = String(upstream.headers['content-type'] || '');
        if (upstream.status >= 300) {
            res.status(upstream.status >= 400 ? upstream.status : 502);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-CC-Proxy-Error', `upstream-${upstream.status}`);
            destroyUpstreamQuietly(upstream);
            return res.end(`CinemaCity upstream error ${upstream.status}`);
        }

        const manifest = isHlsUrl(resolved.sourceUrl, contentType);
        if (manifest) {
            destroyUpstreamQuietly(upstream);
            const { entry, state } = await getRewrittenManifestEntry({
                req,
                sourceUrl: resolved.sourceUrl,
                headers: resolved.headers,
                signal
            });
            return writeManifestResponse({ req, res, manifestEntry: entry, cacheState: state });
        }

        if (smallCacheKey && isSmallObjectCacheable(resolved.sourceUrl, contentType)) {
            const buffer = await readStreamBufferLimited(upstream.data, SMALL_OBJECT_CACHE_MAX_BYTES);
            if (looksLikeHtmlBlock(buffer, contentType)) {
                res.status(502);
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('X-CC-Proxy-Error', 'html-or-block-page');
                return res.end('CinemaCity upstream returned HTML/block page instead of media');
            }
            const entry = setCachedSmallObject(smallCacheKey, buffer, upstream.headers || {}, fallbackContentType(resolved.sourceUrl, contentType));
            return writeSmallObjectResponse({
                req,
                res,
                entry: entry || { buffer, contentType: fallbackContentType(resolved.sourceUrl, contentType) },
                sourceUrl: resolved.sourceUrl,
                cacheState: entry ? 'miss' : 'bypass'
            });
        }

        return writeStreamWithSniff({ upstream, res, req, sourceUrl: resolved.sourceUrl, contentType });
    } catch (error) {
        if (error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED' || signal.aborted) return null;
        if (!res.headersSent) {
            const upstreamStatus = Number(error?.status || 0);
            const statusCode = error?.code === 'MANIFEST_TOO_LARGE' || error?.code === 'SMALL_OBJECT_TOO_LARGE' ? 413 : upstreamStatus >= 400 ? upstreamStatus : 502;
            res.status(statusCode);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-CC-Proxy-Error', error?.code === 'MANIFEST_TOO_LARGE' ? 'manifest-too-large' : error?.code === 'SMALL_OBJECT_TOO_LARGE' ? 'small-object-too-large' : error?.code === 'INVALID_MANIFEST' ? 'invalid-manifest' : upstreamStatus ? `upstream-${upstreamStatus}` : 'proxy-error');
            if (error?.code === 'MANIFEST_TOO_LARGE') return res.end('CinemaCity manifest too large');
            if (error?.code === 'SMALL_OBJECT_TOO_LARGE') return res.end('CinemaCity small object too large');
            if (error?.code === 'INVALID_MANIFEST') return res.end('CinemaCity upstream did not return a valid HLS manifest');
            return res.end(upstreamStatus ? `CinemaCity upstream error ${upstreamStatus}` : 'CinemaCity proxy error');
        }
        try { res.destroy(error); } catch (_) {}
        return null;
    }
}

function createWarmupRequest(baseUrl, pathname = CC_MANIFEST_ROUTE) {
    return {
        method: 'GET',
        headers: {},
        query: {},
        originalUrl: pathname,
        url: pathname,
        path: pathname,
        __ccProxyBase: normalizeAddonBase(baseUrl)
    };
}

function prewarmCinemaCityPlayback(streamUrl, headers = {}, reqHost = null, options = {}) {
    if (!PLAYBACK_PREWARM_ENABLED) return false;
    const sourceUrl = safeUrl(streamUrl);
    if (!sourceUrl) return false;

    const requestBase = normalizeAddonBase(reqHost);
    const isHls = options?.isHls === true || isHlsUrl(sourceUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLAYBACK_PREWARM_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    Promise.resolve().then(async () => {
        try {
            if (isHls) {
                await getRewrittenManifestEntry({
                    req: createWarmupRequest(requestBase, CC_MANIFEST_ROUTE),
                    sourceUrl,
                    headers: buildRequestHeaders(sourceUrl, headers || {}),
                    signal: controller.signal
                });
                return;
            }

            const warmReq = createWarmupRequest(requestBase, CC_STREAM_ROUTE);
            warmReq.headers.range = 'bytes=0-0';
            const upstream = await fetchUpstreamWithRetry(sourceUrl, buildRequestHeaders(sourceUrl, headers || {}), warmReq, controller.signal, {
                allowRange: true,
                attempts: 1
            });
            destroyUpstreamQuietly(upstream);
        } catch (_) {
            
        } finally {
            clearTimeout(timer);
        }
    }).catch(() => null);

    return true;
}

module.exports = {
    CC_MANIFEST_ROUTE,
    CC_STREAM_ROUTE,
    buildCinemaCityProxyUrl,
    prewarmCinemaCityPlayback,
    handleCinemaCityProxy,
    __private: {
        buildCinemaCityForwardProxyUrl,
        buildForwardHeaderParams,
        filterCinemaCityMasterManifest
    }
};

