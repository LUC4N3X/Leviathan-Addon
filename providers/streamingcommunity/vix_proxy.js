const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { getRequestOrigin, isSafeRemoteUrl } = require('../../core/utils/url');
const {
    resolveTransitKey,
    issueHlsTransitKey,
    normalizeRequestHeaders,
    TRANSIT_KIND,
    buildTransitUrl
} = require('./stream_transit.js');

const DEFAULT_REFERER = 'https://vixsrc.to/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MANIFEST_ROUTE = '/vixsynthetic.m3u8';
const MEDIA_ROUTES = Object.freeze({
    ts: '/vixsegment.ts',
    m4s: '/vixsegment.m4s',
    mp4: '/vixsegment.mp4',
    m4a: '/vixaudio.m4a',
    aac: '/vixaudio.aac',
    key: '/vixkey.key',
    vtt: '/vixsubtitle.vtt',
    bin: '/vixmedia.bin'
});
const PLAYBACK_ROUTES = Object.freeze([MANIFEST_ROUTE, ...Object.values(MEDIA_ROUTES)]);
const MAX_UPSTREAM_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = Math.max(12000, Number.parseInt(process.env.VIX_PROXY_TIMEOUT_MS || '25000', 10) || 25000);
const HLS_PLAYBACK_TOKEN_TTL_MS = Math.max(30 * 60 * 1000, Number.parseInt(process.env.VIX_HLS_TOKEN_TTL_MS || String(4 * 60 * 60 * 1000), 10) || (4 * 60 * 60 * 1000));
const UPSTREAM_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const KEEP_ALIVE_HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: UPSTREAM_TIMEOUT_MS + 5000 });
const KEEP_ALIVE_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: UPSTREAM_TIMEOUT_MS + 5000 });
const VIX_STRICT_HOST_BINDING = String(process.env.VIX_STRICT_HOST_BINDING || '').trim() === '1';
const MANIFEST_URL_RE = /\.m3u8(?:$|[?#])/i;
const STREAMABLE_MEDIA_URL_RE = /\.(?:ts|m4s|mp4|m4v|m4a|aac|ac3|vtt|key)(?:$|[?#])/i;

function isVixPlaylistUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (MANIFEST_URL_RE.test(raw)) return true;
    try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        const path = url.pathname.toLowerCase();
        const type = String(url.searchParams.get('type') || '').toLowerCase();
        return /(^|\.)vixsrc\.to$/.test(host)
            && /^\/playlist\/[^/]+(?:\.m3u8)?$/i.test(path)
            && (!type || ['video', 'audio', 'subtitle', 'subtitles', 'subs'].includes(type));
    } catch {
        return /\/playlist\/[^/?#]+(?:\.m3u8)?(?:[?#]|$)/i.test(raw)
            && !/\.(?:ts|m4s|mp4|m4v|m4a|aac|ac3|vtt|key)(?:$|[?#])/i.test(raw);
    }
}
const HLS_MANIFEST_CACHE_CONTROL = String(process.env.SC_HLS_MANIFEST_CACHE_CONTROL || 'public, max-age=15, stale-while-revalidate=60').trim();
const HLS_MEDIA_CACHE_CONTROL = String(process.env.SC_HLS_MEDIA_CACHE_CONTROL || 'public, max-age=300, stale-while-revalidate=120').trim();
const SC_INTERNAL_HLS_PREFETCH_ENABLED = envFlag('SC_INTERNAL_HLS_PREFETCH', envFlag('STREAMINGCOMMUNITY_INTERNAL_HLS_PREFETCH', false));
const SC_INTERNAL_HLS_CACHE_ENABLED = envFlag('SC_INTERNAL_HLS_CACHE', envFlag('STREAMINGCOMMUNITY_INTERNAL_HLS_CACHE', true));
const SC_HLS_PREFETCH_INITIAL_SEGMENTS = envInt('SC_HLS_PREFETCH_INITIAL_SEGMENTS', 4, 0, 16);
const SC_HLS_PREFETCH_SEGMENTS = envInt('SC_HLS_PREFETCH_SEGMENTS', 6, 0, 24);
const SC_HLS_PREFETCH_WAIT_MS = envInt('SC_HLS_PREFETCH_WAIT_MS', 900, 0, 5000);
const SC_HLS_SEGMENT_CACHE_TTL_MS = envInt('SC_HLS_SEGMENT_CACHE_TTL_MS', 10 * 60 * 1000, 15 * 1000, 60 * 60 * 1000);
const SC_HLS_SEGMENT_CACHE_MAX_BYTES = envInt('SC_HLS_SEGMENT_CACHE_MB', 192, 16, 1024) * 1024 * 1024;
const SC_HLS_SEGMENT_CACHE_MAX_ITEM_BYTES = envInt('SC_HLS_SEGMENT_CACHE_MAX_ITEM_MB', 24, 1, 128) * 1024 * 1024;
const SC_HLS_SEGMENT_FOLLOWER_TTL_MS = envInt('SC_HLS_SEGMENT_FOLLOWER_TTL_MS', 20 * 60 * 1000, 60 * 1000, 2 * 60 * 60 * 1000);


function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = String(raw).trim();
    if (/^(1|true|yes|y|on)$/i.test(value)) return true;
    if (/^(0|false|no|n|off)$/i.test(value)) return false;
    return fallback;
}

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(String(process.env[name] || ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function isVixProxyDebugEnabled() {
    return envFlag('VIX_PROXY_DEBUG', envFlag('SC_HLS_DEBUG', false));
}

function debugVixProxy(message) {
    if (!isVixProxyDebugEnabled()) return;
    console.info(`[VIX PROXY] ${message}`);
}

function shouldStreamUpstreamBody(targetUrl) {
    if (!envFlag('SC_HLS_STREAM_SEGMENTS', envFlag('STREAMINGCOMMUNITY_HLS_STREAM_SEGMENTS', true))) return false;
    const value = String(targetUrl || '').trim();
    if (!value || isVixPlaylistUrl(value)) return false;
    return STREAMABLE_MEDIA_URL_RE.test(value);
}

function isVixPlaybackRoute(value) {
    const pathname = String(value || '').split('?')[0];
    return PLAYBACK_ROUTES.includes(pathname);
}

function getRequestRouteBinding(req) {
    const pathname = String(req?.path || req?.url || MANIFEST_ROUTE).split('?')[0];
    return isVixPlaybackRoute(pathname) ? pathname : MANIFEST_ROUTE;
}

function getPlaybackRouteForTarget(targetUrl) {
    if (isVixPlaylistUrl(targetUrl)) return MANIFEST_ROUTE;
    const clean = String(targetUrl || '').split('?')[0].toLowerCase();
    if (clean.endsWith('.m3u8')) return MANIFEST_ROUTE;
    if (clean.endsWith('.ts')) return MEDIA_ROUTES.ts;
    if (clean.endsWith('.m4s')) return MEDIA_ROUTES.m4s;
    if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return MEDIA_ROUTES.mp4;
    if (clean.endsWith('.m4a')) return MEDIA_ROUTES.m4a;
    if (clean.endsWith('.aac') || clean.endsWith('.ac3')) return MEDIA_ROUTES.aac;
    if (clean.endsWith('.vtt')) return MEDIA_ROUTES.vtt;
    if (clean.endsWith('.key')) return MEDIA_ROUTES.key;
    return isVixPlaylistUrl(targetUrl) ? MANIFEST_ROUTE : MEDIA_ROUTES.bin;
}

function destroyUpstreamBody(upstream) {
    const body = upstream?.data;
    if (body && typeof body.destroy === 'function') {
        try { body.destroy(); } catch {}
    }
}

function getManifestCacheControl() {
    return HLS_MANIFEST_CACHE_CONTROL || 'public, max-age=15, stale-while-revalidate=60';
}

function getMediaCacheControl() {
    return HLS_MEDIA_CACHE_CONTROL || 'public, max-age=300, stale-while-revalidate=120';
}

function safeLogHost(value) {
    try {
        return new URL(String(value || '')).host;
    } catch {
        return '';
    }
}

const scHlsSegmentCache = new Map();
const scHlsSegmentInflight = new Map();
const scHlsSegmentFollowers = new Map();
let scHlsSegmentCacheBytes = 0;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function stableSegmentKey(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function nowMs() {
    return Date.now();
}

function pruneSegmentFollowers() {
    const ts = nowMs();
    for (const [key, record] of scHlsSegmentFollowers.entries()) {
        if (!record || Number(record.expiresAt || 0) <= ts) scHlsSegmentFollowers.delete(key);
    }
}

function evictExpiredSegmentCache() {
    const ts = nowMs();
    for (const [key, entry] of scHlsSegmentCache.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= ts) {
            scHlsSegmentCache.delete(key);
            scHlsSegmentCacheBytes = Math.max(0, scHlsSegmentCacheBytes - Number(entry?.size || 0));
        }
    }
}

function trimSegmentCache() {
    evictExpiredSegmentCache();
    while (scHlsSegmentCacheBytes > SC_HLS_SEGMENT_CACHE_MAX_BYTES && scHlsSegmentCache.size) {
        const oldestKey = scHlsSegmentCache.keys().next().value;
        const oldest = scHlsSegmentCache.get(oldestKey);
        scHlsSegmentCache.delete(oldestKey);
        scHlsSegmentCacheBytes = Math.max(0, scHlsSegmentCacheBytes - Number(oldest?.size || 0));
    }
}

function getCachedSegment(targetUrl) {
    if (!SC_INTERNAL_HLS_CACHE_ENABLED) return null;
    const key = stableSegmentKey(targetUrl);
    const cached = scHlsSegmentCache.get(key);
    if (!cached) return null;
    if (Number(cached.expiresAt || 0) <= nowMs()) {
        scHlsSegmentCache.delete(key);
        scHlsSegmentCacheBytes = Math.max(0, scHlsSegmentCacheBytes - Number(cached.size || 0));
        return null;
    }
    scHlsSegmentCache.delete(key);
    scHlsSegmentCache.set(key, cached);
    return cached;
}

function putCachedSegment(targetUrl, response, buffer) {
    if (!SC_INTERNAL_HLS_CACHE_ENABLED) return false;
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (!body.length || body.length > SC_HLS_SEGMENT_CACHE_MAX_ITEM_BYTES) return false;

    const key = stableSegmentKey(targetUrl);
    const previous = scHlsSegmentCache.get(key);
    if (previous) scHlsSegmentCacheBytes = Math.max(0, scHlsSegmentCacheBytes - Number(previous.size || 0));

    const headers = response?.headers || {};
    const entry = {
        buffer: body,
        size: body.length,
        status: Number(response?.status || 200) || 200,
        contentType: fallbackContentType(targetUrl, headers['content-type'] || ''),
        headers: {
            etag: headers.etag || '',
            'last-modified': headers['last-modified'] || '',
            'accept-ranges': headers['accept-ranges'] || 'bytes'
        },
        createdAt: nowMs(),
        expiresAt: nowMs() + SC_HLS_SEGMENT_CACHE_TTL_MS
    };

    scHlsSegmentCache.set(key, entry);
    scHlsSegmentCacheBytes += entry.size;
    trimSegmentCache();
    return true;
}

function parseRangeHeader(rangeHeader, totalLength) {
    const raw = String(rangeHeader || '').trim();
    const match = raw.match(/^bytes=(\d*)-(\d*)$/i);
    if (!match || !Number.isFinite(totalLength) || totalLength <= 0) return null;

    let start = match[1] === '' ? null : Number.parseInt(match[1], 10);
    let end = match[2] === '' ? null : Number.parseInt(match[2], 10);

    if (start == null && end == null) return null;
    if (start == null) {
        const suffix = Math.max(0, end || 0);
        start = Math.max(0, totalLength - suffix);
        end = totalLength - 1;
    } else if (end == null) {
        end = totalLength - 1;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= totalLength) return null;
    return { start, end: Math.min(end, totalLength - 1) };
}

function sendCachedSegment(req, res, cached, sourceUrl) {
    const totalLength = Number(cached?.buffer?.length || 0);
    if (!totalLength) return false;

    const range = parseRangeHeader(req?.headers?.range, totalLength);
    const body = range ? cached.buffer.subarray(range.start, range.end + 1) : cached.buffer;
    const status = range ? 206 : 200;

    res.status(status);
    res.setHeader('Content-Type', cached.contentType || fallbackContentType(sourceUrl));
    res.setHeader('Cache-Control', getMediaCacheControl());
    res.setHeader('Accept-Ranges', cached.headers?.['accept-ranges'] || 'bytes');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Leviathan-Transit-Cache', 'hit');
    if (cached.headers?.etag) res.setHeader('ETag', cached.headers.etag);
    if (cached.headers?.['last-modified']) res.setHeader('Last-Modified', cached.headers['last-modified']);
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalLength}`);
    res.setHeader('Content-Length', body.length);

    debugVixProxy(`cache hit status=${status} bytes=${body.length}/${totalLength} range=${range ? `${range.start}-${range.end}` : 'none'} host=${safeLogHost(sourceUrl)}`);

    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    res.end(body);
    return true;
}

async function getCachedSegmentWithShortWait(sourceUrl) {
    const cached = getCachedSegment(sourceUrl);
    if (cached) return cached;

    if (!SC_HLS_PREFETCH_WAIT_MS) return null;
    const inflight = scHlsSegmentInflight.get(stableSegmentKey(sourceUrl));
    if (!inflight) return null;

    try {
        await Promise.race([inflight.catch(() => null), sleep(SC_HLS_PREFETCH_WAIT_MS)]);
    } catch {}
    return getCachedSegment(sourceUrl);
}

function rememberSegmentFollowers(segmentUrls, pageReferer) {
    if (!SC_INTERNAL_HLS_PREFETCH_ENABLED || !Array.isArray(segmentUrls) || !segmentUrls.length) return;
    pruneSegmentFollowers();
    const unique = segmentUrls.filter(Boolean);
    const expiresAt = nowMs() + SC_HLS_SEGMENT_FOLLOWER_TTL_MS;
    for (let i = 0; i < unique.length; i += 1) {
        const current = unique[i];
        const followers = unique.slice(i + 1, i + 1 + SC_HLS_PREFETCH_SEGMENTS);
        if (!followers.length) continue;
        scHlsSegmentFollowers.set(stableSegmentKey(current), { followers, pageReferer, expiresAt });
    }
}

async function fetchSegmentBufferForCache(targetUrl, referer, upstreamHeaders = null) {
    const headers = { ...(upstreamHeaders || buildRequestHeaders(targetUrl, referer)) };
    delete headers.Range;
    delete headers.range;

    const attempts = [{ requestUrl: targetUrl, forwarded: false }];

    let lastError = null;
    let lastResponse = null;

    for (const attempt of attempts) {
        try {
            const response = await axios.get(attempt.requestUrl, {
                headers,
                timeout: UPSTREAM_TIMEOUT_MS,
                maxRedirects: MAX_UPSTREAM_REDIRECTS,
                responseType: 'arraybuffer',
                validateStatus: () => true,
                proxy: false,
                decompress: true,
                httpAgent: KEEP_ALIVE_HTTP_AGENT,
                httpsAgent: KEEP_ALIVE_HTTPS_AGENT,
                maxContentLength: SC_HLS_SEGMENT_CACHE_MAX_ITEM_BYTES,
                maxBodyLength: SC_HLS_SEGMENT_CACHE_MAX_ITEM_BYTES,
                transitional: { clarifyTimeoutError: true }
            });
            response._scForwarded = attempt.forwarded;
            response._scTargetUrl = targetUrl;
            response._scRequestUrl = attempt.requestUrl;
            lastResponse = response;

            const status = Number(response?.status || 0);
            if (status >= 200 && status < 300) return response;
            if (!attempt.forwarded || !UPSTREAM_RETRY_STATUSES.has(status)) return response;
        } catch (error) {
            lastError = error;
            if (!attempt.forwarded) throw error;
        }
    }

    if (lastResponse) return lastResponse;
    throw lastError || new Error('Vix segment prefetch failed');
}

function scheduleSegmentPrefetch(segmentUrls, pageReferer, reason = 'playlist') {
    if (!SC_INTERNAL_HLS_PREFETCH_ENABLED || !SC_INTERNAL_HLS_CACHE_ENABLED) return;
    const urls = Array.isArray(segmentUrls) ? segmentUrls.filter(Boolean) : [segmentUrls].filter(Boolean);
    for (const targetUrl of urls) {
        const key = stableSegmentKey(targetUrl);
        if (getCachedSegment(targetUrl) || scHlsSegmentInflight.has(key)) continue;

        const job = (async () => {
            try {
                const response = await fetchSegmentBufferForCache(targetUrl, pageReferer, buildRequestHeaders(targetUrl, pageReferer));
                const status = Number(response?.status || 0);
                if (status >= 200 && status < 300) {
                    const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || '');
                    putCachedSegment(targetUrl, response, buffer);
                    console.info(`[VIX PROXY] HLS prefetch cached reason=${reason} bytes=${buffer.length} host=${safeLogHost(targetUrl)}`);
                }
            } catch (error) {
                console.warn(`[VIX PROXY] HLS prefetch skipped reason=${reason} host=${safeLogHost(targetUrl)} error=${error.message}`);
            } finally {
                scHlsSegmentInflight.delete(key);
            }
        })();
        scHlsSegmentInflight.set(key, job);
    }
}

function scheduleFollowersForSegment(sourceUrl, pageReferer) {
    if (!SC_INTERNAL_HLS_PREFETCH_ENABLED) return;
    const key = stableSegmentKey(sourceUrl);
    const record = scHlsSegmentFollowers.get(key);
    if (!record || Number(record.expiresAt || 0) <= nowMs()) {
        if (record) scHlsSegmentFollowers.delete(key);
        return;
    }
    scheduleSegmentPrefetch(record.followers || [], record.pageReferer || pageReferer, 'follower');
}

function getSelfBase(req) {
    return getRequestOrigin(req);
}

function safeUrl(value, base) {
    try {
        if (!value) return null;
        let resolved = null;
        if (/^https?:\/\//i.test(value)) resolved = new URL(value).toString();
        else if (String(value).startsWith('//')) resolved = `https:${value}`;
        else resolved = new URL(value, base).toString();
        return isSafeRemoteUrl(resolved) ? resolved : null;
    } catch {
        return null;
    }
}


function decodeBase64UrlJson(value) {
    try {
        const raw = String(value || '').trim();
        if (!raw) return null;
        const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
        const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function extractTransitPayloadUnsafe(token) {
    const raw = String(token || '').trim();
    const modern = raw.match(/^lvt\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (modern) return decodeBase64UrlJson(modern[3]);
    const legacy = raw.match(/^lvt\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (legacy) return decodeBase64UrlJson(legacy[2]);
    return null;
}

function isAllowedVixHost(value) {
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === 'vixsrc.to' || host.endsWith('.vixsrc.to');
    } catch {
        return false;
    }
}

function isExpiredUrlToken(value, graceSeconds = 30) {
    try {
        const parsed = new URL(value);
        const expires = Number(parsed.searchParams.get('expires') || 0);
        return Number.isFinite(expires) && expires > 0 && expires <= Math.floor(Date.now() / 1000) + graceSeconds;
    } catch {
        return false;
    }
}

function normalizePlaybackReferer(value) {
    const referer = safeUrl(value, DEFAULT_REFERER) || DEFAULT_REFERER;
    // Some Vix embed URLs have a very short-lived `expires` query. When stream
    // responses are cached, that referer can expire before playback starts.
    // The playlist URL itself usually carries the durable playback token, so
    // falling back to the plain origin avoids poisoning otherwise valid HLS URLs.
    if (isAllowedVixHost(referer) && isExpiredUrlToken(referer, 60)) return DEFAULT_REFERER;
    return referer;
}

function resolveEmbeddedTransitRescue(rawToken, req) {
    const payload = extractTransitPayloadUnsafe(rawToken);
    const ctx = payload && typeof payload.ctx === 'object' ? payload.ctx : null;
    if (!payload || !ctx || ctx.embedded !== true) return null;
    if (payload.typ && payload.typ !== 'transit') return null;
    if (ctx.kind && String(ctx.kind) !== TRANSIT_KIND) return null;

    const exp = Number(payload.exp || ctx.exp || 0);
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;

    const routeBinding = String(ctx.routeBinding || '').trim();
    if (routeBinding && !isVixPlaybackRoute(routeBinding)) return null;

    const sourceUrl = safeUrl(ctx.url);
    if (!sourceUrl || !isSafeRemoteUrl(sourceUrl) || !isAllowedVixHost(sourceUrl)) return null;

    const pageReferer = normalizePlaybackReferer(ctx.referer || DEFAULT_REFERER);
    if (pageReferer && !isAllowedVixHost(pageReferer)) return null;

    const headers = buildRequestHeaders(sourceUrl, pageReferer, ctx.headers || null);
    console.warn('[VIX PROXY] Embedded transit rescue accepted for Vix HLS token');
    return {
        sourceUrl,
        pageReferer,
        upstreamHeaders: headers,
        variantPolicy: pickVariantPolicy(ctx?.meta?.syntheticVariant, sourceUrl, pageReferer, ctx.meta || null, req),
        isSeriesFlow: isLikelySeriesFlow(sourceUrl, pageReferer, ctx.meta || null, req),
        recoveredFromEmbedded: true,
        rescuedInvalidToken: true
    };
}

function buildRequestHeaders(targetUrl, explicitReferer, overrides = null) {
    const target = new URL(targetUrl);
    let referer = normalizePlaybackReferer(explicitReferer || `${target.origin}/`);
    let origin = target.origin;

    try {
        if (referer) origin = new URL(referer).origin;
    } catch {}

    const cleanOverrides = { ...(overrides || {}) };
    for (const key of Object.keys(cleanOverrides)) {
        if (/^(referer|origin)$/i.test(key)) delete cleanOverrides[key];
    }

    const isPlaylist = isVixPlaylistUrl(targetUrl);

    return normalizeRequestHeaders({
        'User-Agent': DEFAULT_UA,
        Accept: isPlaylist ? 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' : 'video/mp2t, video/iso.segment, video/*, application/octet-stream, */*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': isPlaylist ? 'empty' : 'video',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        ...cleanOverrides,
        Referer: referer,
        Origin: origin
    });
}

function isManifest(targetUrl, contentType) {
    return /mpegurl|x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(contentType || '')
        || isVixPlaylistUrl(targetUrl);
}

function getResolutionInfo(infoLine) {
    const resMatch = String(infoLine || '').match(/RESOLUTION=(\d+)x(\d+)/i);
    if (resMatch) {
        const width = Number(resMatch[1]) || 0;
        const height = Number(resMatch[2]) || 0;
        return { width, height, score: width * height };
    }

    const bandwidthMatch = String(infoLine || '').match(/BANDWIDTH=(\d+)/i);
    const bandwidth = bandwidthMatch ? Number(bandwidthMatch[1]) || 0 : 0;
    return { width: 0, height: 0, score: bandwidth };
}

function getResolutionScore(infoLine) {
    return getResolutionInfo(infoLine).score;
}

function normalizeVariantPolicy(policy = 'auto') {
    const raw = String(policy || 'auto').trim().toLowerCase();
    if (['auto', 'all', 'adaptive'].includes(raw)) return 'auto';
    if (['1080', '1080p', 'fhd', 'fullhd'].includes(raw)) return '1080';
    if (['720', '720p', 'hd'].includes(raw)) return '720';
    if (['max', 'best', 'high'].includes(raw)) return 'max';
    if (['mid', 'safe', 'balanced'].includes(raw)) return 'mid';
    if (['min', 'low'].includes(raw)) return 'min';
    return 'auto';
}

function selectFixedHeightVariant(variants, targetHeight) {
    const withHeight = [...variants]
        .filter((variant) => Number.isFinite(variant.height) && variant.height > 0)
        .sort((a, b) => b.height - a.height || b.score - a.score);

    if (!withHeight.length) return null;

    const exact = withHeight.find((variant) => variant.height === targetHeight);
    if (exact) return exact;

    const belowOrEqual = withHeight.find((variant) => variant.height <= targetHeight);
    if (belowOrEqual) return belowOrEqual;

    return withHeight[withHeight.length - 1] || null;
}

function selectVariant(variants, policy = 'auto') {
    if (!variants.length) return null;
    const normalizedPolicy = normalizeVariantPolicy(policy);
    const sorted = [...variants].sort((a, b) => b.score - a.score);
    if (normalizedPolicy === '1080') return selectFixedHeightVariant(sorted, 1080) || sorted[0];
    if (normalizedPolicy === '720') return selectFixedHeightVariant(sorted, 720) || sorted[Math.min(1, sorted.length - 1)] || sorted[0];
    if (normalizedPolicy === 'max' || sorted.length === 1) return sorted[0];
    if (normalizedPolicy === 'min') return sorted[sorted.length - 1];
    if (normalizedPolicy === 'mid') {
        const mid = sorted.find((variant) => variant.score > 400000 && variant.score < 2500000 && variant.score !== sorted[0].score);
        return mid || sorted[Math.min(1, sorted.length - 1)] || sorted[0];
    }
    return null;
}

function isLikelySeriesFlow(sourceUrl = '', pageReferer = '', meta = null, req = null) {
    const parts = [sourceUrl, pageReferer, meta?.type, meta?.mediaType, meta?.kind, meta?.imdbType, req?.query?.type]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());

    const joined = parts.join(' ');
    if (/\b(movie|film)\b/.test(joined) || /\/movie\//i.test(joined)) return false;

    return /\b(series|serie|tv|show|episode|episodio)\b/.test(joined)
        || /\/(tv|series|serie|show|episode|episodio)\//i.test(joined)
        || /[?&](season|s)=\d+/i.test(joined)
        || /[?&](episode|e)=\d+/i.test(joined)
        || /\/tt\d+\/\d+\/\d+(?:$|[/?#])/i.test(joined);
}

function pickVariantPolicy(rawPolicy, sourceUrl, pageReferer, meta = null, req = null) {
    const explicit = String(rawPolicy || '').trim();
    if (explicit) return normalizeVariantPolicy(explicit);

    // Le serie Vix spesso passano da master -> variant -> leaf -> segmenti.
    // Forzare una variante media evita switch casuali di qualità che su ExoPlayer
    // possono causare "passaggio a libVLC", mentre i film restano adaptive/auto.
    return isLikelySeriesFlow(sourceUrl, pageReferer, meta, req) ? 'mid' : 'auto';
}

function buildProxyUrl(req, absoluteUrl, pageReferer, extraHeaders = null, extraMeta = null, routeOverride = null) {
    const selfBase = getSelfBase(req);
    const route = routeOverride || getPlaybackRouteForTarget(absoluteUrl);
    const safeRoute = isVixPlaybackRoute(route) ? route : MANIFEST_ROUTE;
    const token = issueHlsTransitKey(absoluteUrl, {
        kind: TRANSIT_KIND,
        referer: pageReferer,
        headers: buildRequestHeaders(absoluteUrl, pageReferer, extraHeaders),
        hostBinding: VIX_STRICT_HOST_BINDING ? selfBase : null,
        routeBinding: safeRoute,
        issuer: 'vix-proxy',
        profile: 'hls-proxy',
        meta: extraMeta || null,
        tokenTtlMs: HLS_PLAYBACK_TOKEN_TTL_MS,
        tokenMaxUses: 0,
        maxUses: 0
    });
    return token ? buildTransitUrl(selfBase, safeRoute, token) : null;
}

function rewriteDirectiveUri(line, baseUrl, req, pageReferer) {
    return String(line || '').replace(/URI="([^"]+)"/ig, (_, uri) => {
        const absolute = safeUrl(uri, baseUrl);
        const rewritten = absolute ? buildProxyUrl(req, absolute, pageReferer, null, null, getPlaybackRouteForTarget(absolute)) : null;
        return rewritten ? `URI="${rewritten}"` : `URI="${uri}"`;
    });
}

function rewriteLeafManifest(lines, baseUrl, req, pageReferer) {
    const out = [];
    const segmentUrls = [];
    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) {
            out.push('');
            continue;
        }
        if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP') || line.startsWith('#EXT-X-MEDIA')) {
            out.push(rewriteDirectiveUri(line, baseUrl, req, pageReferer));
            continue;
        }
        if (line.startsWith('#')) {
            out.push(line);
            continue;
        }
        const absolute = safeUrl(line, baseUrl);
        if (absolute) segmentUrls.push(absolute);
        out.push(absolute ? (buildProxyUrl(req, absolute, pageReferer) || line) : line);
    }

    if (segmentUrls.length) {
        rememberSegmentFollowers(segmentUrls, pageReferer);
        scheduleSegmentPrefetch(segmentUrls.slice(0, SC_HLS_PREFETCH_INITIAL_SEGMENTS), pageReferer, 'initial');
    }

    return out.join('\n');
}

function rewriteMasterManifest(lines, baseUrl, req, pageReferer, variantPolicy = 'auto') {
    const output = [];
    const variants = [];

    for (let i = 0; i < lines.length; i += 1) {
        const line = String(lines[i] || '').trim();
        if (!line) {
            output.push('');
            continue;
        }
        if (line.startsWith('#EXT-X-MEDIA') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
            output.push(rewriteDirectiveUri(line, baseUrl, req, pageReferer));
            continue;
        }
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const nextLine = String(lines[i + 1] || '').trim();
            const absolute = safeUrl(nextLine, baseUrl);
            const resolution = getResolutionInfo(line);
            variants.push({ info: line, url: absolute, rawUrl: nextLine, score: resolution.score, height: resolution.height });
            i += 1;
            continue;
        }
        if (!line.startsWith('#')) {
            const absolute = safeUrl(line, baseUrl);
            output.push(absolute ? (buildProxyUrl(req, absolute, pageReferer) || line) : line);
            continue;
        }
        output.push(line);
    }

    if (!variants.length) return output.join('\n');

    const normalizedPolicy = normalizeVariantPolicy(variantPolicy);
    const selected = selectVariant(variants, normalizedPolicy);

    if (selected) {
        output.push(selected.info);
        output.push(selected.url ? (buildProxyUrl(req, selected.url, pageReferer) || selected.url) : selected.rawUrl);
        return output.join('\n');
    }

    for (const variant of variants) {
        output.push(variant.info);
        output.push(variant.url ? (buildProxyUrl(req, variant.url, pageReferer) || variant.url) : variant.rawUrl);
    }

    return output.join('\n');
}


function setPlaybackCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range,Origin,Accept,Content-Type,User-Agent,Referer,Cache-Control,Pragma');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Content-Type,Cache-Control,ETag,Last-Modified');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function fallbackContentType(targetUrl, upstreamContentType = '') {
    const contentType = String(upstreamContentType || '').split(';')[0].trim();
    if (contentType) return upstreamContentType;
    const clean = String(targetUrl || '').split('?')[0].toLowerCase();
    if (isVixPlaylistUrl(targetUrl)) return 'application/vnd.apple.mpegurl; charset=utf-8';
    if (clean.endsWith('.ts')) return 'video/mp2t';
    if (clean.endsWith('.m4s')) return 'video/iso.segment';
    if (clean.endsWith('.mp4')) return 'video/mp4';
    if (clean.endsWith('.aac')) return 'audio/aac';
    if (clean.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
    if (clean.endsWith('.key')) return 'application/octet-stream';
    return 'application/octet-stream';
}

function copyUsefulUpstreamHeaders(upstream, res, { manifest = false } = {}) {
    if (!upstream?.headers) return;
    const allowed = manifest
        ? ['etag', 'last-modified']
        : ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    for (const name of allowed) {
        const value = upstream.headers[name];
        if (value != null && value !== '') res.setHeader(name.split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join('-'), value);
    }
}

async function fetchUpstreamOnce(targetUrl, referer, upstreamHeaders = null, req = null) {
    const headers = { ...(upstreamHeaders || buildRequestHeaders(targetUrl, referer)) };
    const range = String(req?.headers?.range || '').trim();
    if (range && /^bytes=\d*-\d*(?:,\d*-\d*)*$/i.test(range)) headers.Range = range;

    const streamBody = shouldStreamUpstreamBody(targetUrl);
    const attempts = [{ requestUrl: targetUrl, forwarded: false }];

    let lastResponse = null;
    let lastError = null;

    for (const attempt of attempts) {
        try {
            const response = await axios.get(attempt.requestUrl, {
                headers,
                timeout: UPSTREAM_TIMEOUT_MS,
                maxRedirects: MAX_UPSTREAM_REDIRECTS,
                responseType: streamBody ? 'stream' : 'arraybuffer',
                validateStatus: () => true,
                proxy: false,
                decompress: !streamBody,
                httpAgent: KEEP_ALIVE_HTTP_AGENT,
                httpsAgent: KEEP_ALIVE_HTTPS_AGENT,
                transitional: { clarifyTimeoutError: true }
            });
            response._scForwarded = attempt.forwarded;
            response._scTargetUrl = targetUrl;
            response._scRequestUrl = attempt.requestUrl;
            response._scStreamedBody = streamBody;
            lastResponse = response;

            const status = Number(response?.status || 0);
            if (!attempt.forwarded || !UPSTREAM_RETRY_STATUSES.has(status)) return response;
            destroyUpstreamBody(response);
        } catch (error) {
            lastError = error;
            if (!attempt.forwarded) throw error;
        }
    }

    if (lastResponse) return lastResponse;
    throw lastError || new Error('Vix upstream request failed');
}

async function fetchUpstream(targetUrl, referer, upstreamHeaders = null, req = null) {
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const upstream = await fetchUpstreamOnce(targetUrl, referer, upstreamHeaders, req);
            if (!UPSTREAM_RETRY_STATUSES.has(Number(upstream.status || 0)) || attempt >= 2) return upstream;
            destroyUpstreamBody(upstream);
            lastError = new Error(`retryable upstream status ${upstream.status}`);
        } catch (error) {
            lastError = error;
            if (attempt >= 2) throw error;
        }
    }

    throw lastError || new Error('Vix upstream request failed');
}



function isReadableStream(value) {
    return value && typeof value.pipe === 'function';
}

function streamToBuffer(readable, maxBytes = envInt('SC_HLS_MANIFEST_MAX_BYTES', 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024)) {
    if (!isReadableStream(readable)) return Promise.resolve(Buffer.isBuffer(readable) ? readable : Buffer.from(readable || ''));

    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        const cleanup = () => {
            readable.off('data', onData);
            readable.off('end', onEnd);
            readable.off('error', onError);
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onEnd = () => {
            cleanup();
            resolve(Buffer.concat(chunks, total));
        };
        const onData = (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
            total += buf.length;
            if (total > maxBytes) {
                cleanup();
                try { readable.destroy(); } catch {}
                reject(new Error(`Vix manifest exceeded ${maxBytes} bytes`));
                return;
            }
            chunks.push(buf);
        };
        readable.on('data', onData);
        readable.once('end', onEnd);
        readable.once('error', onError);
    });
}

function sendStreamedUpstream(req, res, upstream, sourceUrl, contentType) {
    const status = Number(upstream.status || 200);
    const safeStatus = status >= 200 && status < 400 ? status : 200;
    const body = upstream.data;

    res.status(safeStatus === 206 ? 206 : safeStatus);
    res.setHeader('Content-Type', fallbackContentType(sourceUrl, contentType));
    res.setHeader('Cache-Control', getMediaCacheControl());
    res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Leviathan-Transit-Cache', 'miss');
    copyUsefulUpstreamHeaders(upstream, res, { manifest: false });

    if (req.method === 'HEAD') {
        destroyUpstreamBody(upstream);
        return res.end();
    }

    if (!isReadableStream(body)) {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
        res.setHeader('Content-Length', buffer.length);
        debugVixProxy(`direct buffer status=${safeStatus} bytes=${buffer.length} host=${safeLogHost(sourceUrl)}`);
        return res.end(buffer);
    }

    let cleaned = false;
    let completed = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        res.off('close', onResponseClose);
        res.off('finish', onResponseFinish);
        body.off('end', onBodyEnd);
        body.off('error', onBodyError);
    };
    const onResponseFinish = () => {
        completed = true;
        cleanup();
    };
    const onBodyEnd = () => {
        completed = true;
        cleanup();
    };
    const onResponseClose = () => {
        // Do not listen to req.close here: for GET/HEAD requests Node can emit it
        // once the inbound request is complete, while the outbound HLS segment is
        // still being piped. Destroying upstream on req.close cuts playback after
        // a couple of seconds on Stremio/ExoPlayer. res.close is the real signal
        // that the player went away before the response finished.
        if (!completed && !res.writableEnded) {
            debugVixProxy(`client closed before finish; destroying upstream host=${safeLogHost(sourceUrl)}`);
            try { body.destroy(); } catch {}
        }
        cleanup();
    };
    const onBodyError = (error) => {
        cleanup();
        console.warn(`[VIX PROXY] upstream stream error host=${safeLogHost(sourceUrl)} error=${error.message}`);
        if (!res.headersSent) {
            res.status(502);
            res.setHeader('Cache-Control', 'no-store');
            res.end('Vix Proxy Stream Error');
            return;
        }
        try { res.destroy(error); } catch {}
    };

    res.once('close', onResponseClose);
    res.once('finish', onResponseFinish);
    body.once('end', onBodyEnd);
    body.once('error', onBodyError);
    debugVixProxy(`stream miss status=${safeStatus} range=${req.headers?.range || 'none'} host=${safeLogHost(sourceUrl)} len=${upstream.headers['content-length'] || 'unknown'}`);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    return body.pipe(res);
}

function resolveProxySource(req) {
    const rawToken = String(req.query.d || '').trim();
    if (rawToken) {
        const tokenPayload = resolveTransitKey(rawToken, {
            kind: TRANSIT_KIND,
            hostBinding: VIX_STRICT_HOST_BINDING ? getSelfBase(req) : null,
            routeBinding: getRequestRouteBinding(req)
        });

        if (tokenPayload?.url && isSafeRemoteUrl(tokenPayload.url)) {
            return {
                sourceUrl: tokenPayload.url,
                pageReferer: normalizePlaybackReferer(tokenPayload.referer || DEFAULT_REFERER),
                upstreamHeaders: buildRequestHeaders(tokenPayload.url, normalizePlaybackReferer(tokenPayload.referer || DEFAULT_REFERER), tokenPayload.headers || null),
                variantPolicy: pickVariantPolicy(tokenPayload?.meta?.syntheticVariant, tokenPayload.url, normalizePlaybackReferer(tokenPayload.referer || DEFAULT_REFERER), tokenPayload.meta || null, req),
                isSeriesFlow: isLikelySeriesFlow(tokenPayload.url, normalizePlaybackReferer(tokenPayload.referer || DEFAULT_REFERER), tokenPayload.meta || null, req),
                recoveredFromEmbedded: Boolean(tokenPayload.recoveredFromEmbedded)
            };
        }

        const rescued = resolveEmbeddedTransitRescue(rawToken, req);
        if (rescued?.sourceUrl) return rescued;
        return { invalidToken: true };
    }

    const sourceUrl = safeUrl(req.query.src);
    const pageReferer = normalizePlaybackReferer(req.query.referer || DEFAULT_REFERER);
    if (!sourceUrl || !isSafeRemoteUrl(sourceUrl)) return null;

    return {
        sourceUrl,
        pageReferer,
        upstreamHeaders: buildRequestHeaders(sourceUrl, pageReferer),
        variantPolicy: pickVariantPolicy(req.query.variant, sourceUrl, pageReferer, null, req),
        isSeriesFlow: isLikelySeriesFlow(sourceUrl, pageReferer, null, req)
    };
}

async function handleVixSynthetic(req, res) {
    setPlaybackCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.status(204);
        return res.end();
    }

    if (req.method && !['GET', 'HEAD'].includes(String(req.method).toUpperCase())) {
        res.status(405);
        return res.end('Method Not Allowed');
    }

    const resolved = resolveProxySource(req);
    if (resolved?.invalidToken) {
        console.warn('[VIX PROXY] Invalid transit token (not recoverable from embedded Vix context)');
        res.status(410);
        res.setHeader('Cache-Control', 'no-store');
        return res.end('Expired Vix transit token');
    }
    if (!resolved?.sourceUrl) return res.status(400).send('Invalid or unsafe src');

    const { sourceUrl, pageReferer, upstreamHeaders, variantPolicy, isSeriesFlow } = resolved;

    try {
        const cachedSegment = await getCachedSegmentWithShortWait(sourceUrl);
        if (cachedSegment) {
            scheduleFollowersForSegment(sourceUrl, pageReferer);
            return sendCachedSegment(req, res, cachedSegment, sourceUrl);
        }

        scheduleFollowersForSegment(sourceUrl, pageReferer);
        debugVixProxy(`cache miss method=${req.method} host=${safeLogHost(sourceUrl)} manifest=${MANIFEST_URL_RE.test(sourceUrl) ? '1' : '0'}`);
        const upstream = await fetchUpstream(sourceUrl, pageReferer, upstreamHeaders, req);
        if (upstream.status >= 400) {
            console.error(`[VIX PROXY] Upstream ${upstream.status} for ${sourceUrl}`);
            destroyUpstreamBody(upstream);
            res.status(upstream.status);
            res.setHeader('Cache-Control', 'no-store');
            return res.end(`Vix upstream error ${upstream.status}`);
        }

        const contentType = String(upstream.headers['content-type'] || '');
        const manifest = isManifest(sourceUrl, contentType);

        if (!manifest) {
            return sendStreamedUpstream(req, res, upstream, sourceUrl, contentType);
        }

        const buffer = Buffer.isBuffer(upstream.data) ? upstream.data : await streamToBuffer(upstream.data);
        const manifestText = buffer.toString('utf8');
        const lines = manifestText.replace(/\r\n/g, '\n').split('\n');
        const hasVariants = lines.some((line) => String(line).trim().startsWith('#EXT-X-STREAM-INF'));
        if (hasVariants && isSeriesFlow) {
            const variantCount = lines.filter((line) => String(line).trim().startsWith('#EXT-X-STREAM-INF')).length;
            console.info(`[VIX PROXY] Series-safe HLS master variants=${variantCount} policy=${variantPolicy} url=${sourceUrl}`);
        }

        debugVixProxy(`manifest rewrite host=${safeLogHost(sourceUrl)} variants=${hasVariants ? '1' : '0'} lines=${lines.length} policy=${variantPolicy}`);
        const rewritten = hasVariants
            ? rewriteMasterManifest(lines, sourceUrl, req, pageReferer, variantPolicy)
            : rewriteLeafManifest(lines, sourceUrl, req, pageReferer);

        const out = rewritten.endsWith('\n') ? rewritten : `${rewritten}\n`;
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', getManifestCacheControl());
        res.setHeader('Content-Length', Buffer.byteLength(out));
        copyUsefulUpstreamHeaders(upstream, res, { manifest: true });
        if (req.method === 'HEAD') return res.end();
        return res.end(out);
    } catch (error) {
        console.error('Vix Proxy Error:', error.message);
        res.status(502);
        res.setHeader('Cache-Control', 'no-store');
        return res.end('Vix Proxy Error');
    }
}

module.exports = {
    MANIFEST_ROUTE,
    MEDIA_ROUTES,
    PLAYBACK_ROUTES,
    buildRequestHeaders,
    buildProxyUrl,
    handleVixSynthetic
};

