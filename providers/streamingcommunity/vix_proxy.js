const axios = require('axios');
const http = require('http');
const https = require('https');
const { getRequestOrigin, isSafeRemoteUrl } = require('../../core/utils/url');
const {
    buildForwardProxyUrl: buildSharedForwardProxyUrl,
    normalizeForwardProxyBase: normalizeSharedForwardProxyBase
} = require('../../core/proxy/forward_proxy_config');
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
const MAX_UPSTREAM_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = Math.max(12000, Number.parseInt(process.env.VIX_PROXY_TIMEOUT_MS || '25000', 10) || 25000);
const HLS_PLAYBACK_TOKEN_TTL_MS = Math.max(30 * 60 * 1000, Number.parseInt(process.env.VIX_HLS_TOKEN_TTL_MS || String(4 * 60 * 60 * 1000), 10) || (4 * 60 * 60 * 1000));
const UPSTREAM_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const KEEP_ALIVE_HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: UPSTREAM_TIMEOUT_MS + 5000 });
const KEEP_ALIVE_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: UPSTREAM_TIMEOUT_MS + 5000 });
const VIX_STRICT_HOST_BINDING = String(process.env.VIX_STRICT_HOST_BINDING || '').trim() === '1';

const SC_FORWARD_PROXY_CONTEXT = 'streamingcommunity-playback';

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

function getScForwardProxyBase() {
    const raw = String(
        process.env.SC_FORWARD_PROXY
        || process.env.STREAMINGCOMMUNITY_FORWARD_PROXY
        || process.env.STREAMINGCOMMUNITY_FORWARD_PROXY_URL
        || process.env.VIXSRC_FORWARD_PROXY
        || process.env.VIX_FORWARD_PROXY
        || process.env.FORWARD_PROXY
        || ''
    ).trim();

    if (!raw) return '';
    try {
        return normalizeSharedForwardProxyBase(raw, SC_FORWARD_PROXY_CONTEXT);
    } catch (error) {
        console.error(`[VIX PROXY] Invalid StreamingCommunity forward proxy: ${error.message}`);
        return '';
    }
}

function isScForwardProxyEnabled(kind = 'media') {
    const base = getScForwardProxyBase();
    if (!base) return false;
    if (!envFlag('SC_FORWARD_PROXY_ENABLED', envFlag('STREAMINGCOMMUNITY_FORWARD_PROXY_ENABLED', true))) return false;
    if (kind === 'media') {
        return envFlag('SC_FORWARD_PROXY_STREAMS', envFlag('STREAMINGCOMMUNITY_FORWARD_PROXY_STREAMS', true));
    }
    return true;
}

function shouldFallbackDirectAfterForward() {
    return envFlag('SC_FORWARD_PROXY_DIRECT_FALLBACK', envFlag('STREAMINGCOMMUNITY_FORWARD_PROXY_DIRECT_FALLBACK', false));
}

function buildScForwardProxyUrl(targetUrl, kind = 'media') {
    if (!isScForwardProxyEnabled(kind)) return null;
    const base = getScForwardProxyBase();
    if (!base) return null;
    try {
        const proxied = buildSharedForwardProxyUrl(targetUrl, { base, context: SC_FORWARD_PROXY_CONTEXT });
        return proxied && proxied !== targetUrl ? proxied : null;
    } catch (error) {
        console.error(`[VIX PROXY] Forward proxy url build failed: ${error.message}`);
        return null;
    }
}

function safeLogHost(value) {
    try {
        return new URL(String(value || '')).host;
    } catch {
        return '';
    }
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
    if (routeBinding && routeBinding !== MANIFEST_ROUTE) return null;

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

    return normalizeRequestHeaders({
        'User-Agent': DEFAULT_UA,
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, video/mp2t, video/*, */*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...cleanOverrides,
        Referer: referer,
        Origin: origin
    });
}

function isManifest(targetUrl, contentType) {
    return /mpegurl|x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(contentType || '')
        || /\.m3u8($|\?)/i.test(targetUrl || '');
}

function getResolutionScore(infoLine) {
    const resMatch = String(infoLine || '').match(/RESOLUTION=(\d+)x(\d+)/i);
    if (resMatch) return Number(resMatch[1]) * Number(resMatch[2]);
    const bandwidthMatch = String(infoLine || '').match(/BANDWIDTH=(\d+)/i);
    return bandwidthMatch ? Number(bandwidthMatch[1]) : 0;
}

function normalizeVariantPolicy(policy = 'auto') {
    const raw = String(policy || 'auto').trim().toLowerCase();
    if (['auto', 'all', 'adaptive'].includes(raw)) return 'auto';
    if (['max', 'best', 'high'].includes(raw)) return 'max';
    if (['mid', 'safe', 'balanced'].includes(raw)) return 'mid';
    if (['min', 'low'].includes(raw)) return 'min';
    return 'auto';
}

function selectVariant(variants, policy = 'auto') {
    if (!variants.length) return null;
    const normalizedPolicy = normalizeVariantPolicy(policy);
    const sorted = [...variants].sort((a, b) => b.score - a.score);
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

function buildProxyUrl(req, absoluteUrl, pageReferer, extraHeaders = null, extraMeta = null) {
    const selfBase = getSelfBase(req);
    const token = issueHlsTransitKey(absoluteUrl, {
        kind: TRANSIT_KIND,
        referer: pageReferer,
        headers: buildRequestHeaders(absoluteUrl, pageReferer, extraHeaders),
        hostBinding: VIX_STRICT_HOST_BINDING ? selfBase : null,
        routeBinding: MANIFEST_ROUTE,
        issuer: 'vix-proxy',
        profile: 'hls-proxy',
        meta: extraMeta || null,
        tokenTtlMs: HLS_PLAYBACK_TOKEN_TTL_MS,
        tokenMaxUses: 0,
        maxUses: 0
    });
    return token ? buildTransitUrl(selfBase, MANIFEST_ROUTE, token) : null;
}

function rewriteDirectiveUri(line, baseUrl, req, pageReferer) {
    return String(line || '').replace(/URI="([^"]+)"/ig, (_, uri) => {
        const absolute = safeUrl(uri, baseUrl);
        const rewritten = absolute ? buildProxyUrl(req, absolute, pageReferer) : null;
        return rewritten ? `URI="${rewritten}"` : `URI="${uri}"`;
    });
}

function rewriteLeafManifest(lines, baseUrl, req, pageReferer) {
    const out = [];
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
        out.push(absolute ? (buildProxyUrl(req, absolute, pageReferer) || line) : line);
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
            variants.push({ info: line, url: absolute, rawUrl: nextLine, score: getResolutionScore(line) });
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
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function fallbackContentType(targetUrl, upstreamContentType = '') {
    const contentType = String(upstreamContentType || '').split(';')[0].trim();
    if (contentType) return upstreamContentType;
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

    const forwardUrl = buildScForwardProxyUrl(targetUrl, 'media');
    const attempts = [];
    if (forwardUrl) attempts.push({ requestUrl: forwardUrl, forwarded: true });
    if (!forwardUrl || shouldFallbackDirectAfterForward()) attempts.push({ requestUrl: targetUrl, forwarded: false });

    let lastResponse = null;
    let lastError = null;

    for (const attempt of attempts) {
        try {
            const response = await axios.get(attempt.requestUrl, {
                headers,
                timeout: attempt.forwarded
                    ? envInt('SC_FORWARD_PROXY_STREAM_TIMEOUT_MS', UPSTREAM_TIMEOUT_MS, 1000, 120000)
                    : UPSTREAM_TIMEOUT_MS,
                maxRedirects: MAX_UPSTREAM_REDIRECTS,
                responseType: 'arraybuffer',
                validateStatus: () => true,
                proxy: false,
                decompress: true,
                httpAgent: KEEP_ALIVE_HTTP_AGENT,
                httpsAgent: KEEP_ALIVE_HTTPS_AGENT,
                transitional: { clarifyTimeoutError: true }
            });
            response._scForwarded = attempt.forwarded;
            response._scTargetUrl = targetUrl;
            response._scRequestUrl = attempt.requestUrl;
            lastResponse = response;

            const status = Number(response?.status || 0);
            if (!attempt.forwarded || !UPSTREAM_RETRY_STATUSES.has(status) || !shouldFallbackDirectAfterForward()) return response;
            console.warn(`[VIX PROXY] Forward proxy retryable status ${status}; trying direct fallback for ${safeLogHost(targetUrl)}`);
        } catch (error) {
            lastError = error;
            if (!attempt.forwarded || !shouldFallbackDirectAfterForward()) throw error;
            console.warn(`[VIX PROXY] Forward proxy error; trying direct fallback for ${safeLogHost(targetUrl)} via=${safeLogHost(attempt.requestUrl)} error=${error.message}`);
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
            lastError = new Error(`retryable upstream status ${upstream.status}`);
        } catch (error) {
            lastError = error;
            if (attempt >= 2) throw error;
        }
    }

    throw lastError || new Error('Vix upstream request failed');
}


function resolveProxySource(req) {
    const rawToken = String(req.query.d || '').trim();
    if (rawToken) {
        const tokenPayload = resolveTransitKey(rawToken, {
            kind: TRANSIT_KIND,
            hostBinding: VIX_STRICT_HOST_BINDING ? getSelfBase(req) : null,
            routeBinding: MANIFEST_ROUTE
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
        const upstream = await fetchUpstream(sourceUrl, pageReferer, upstreamHeaders, req);
        if (upstream.status >= 400) {
            console.error(`[VIX PROXY] Upstream ${upstream.status} for ${sourceUrl}`);
            res.status(upstream.status);
            res.setHeader('Cache-Control', 'no-store');
            return res.end(`Vix upstream error ${upstream.status}`);
        }

        const contentType = String(upstream.headers['content-type'] || '');
        const buffer = Buffer.isBuffer(upstream.data) ? upstream.data : Buffer.from(upstream.data || '');
        const manifest = isManifest(sourceUrl, contentType);

        if (!manifest) {
            const status = Number(upstream.status || 200) === 206 ? 206 : 200;
            res.status(status);
            res.setHeader('Content-Type', fallbackContentType(sourceUrl, contentType));
            res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
            res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
            copyUsefulUpstreamHeaders(upstream, res, { manifest: false });
            res.setHeader('Content-Length', buffer.length);
            if (req.method === 'HEAD') return res.end();
            return res.end(buffer);
        }

        const manifestText = buffer.toString('utf8');
        const lines = manifestText.replace(/\r\n/g, '\n').split('\n');
        const hasVariants = lines.some((line) => String(line).trim().startsWith('#EXT-X-STREAM-INF'));
        if (hasVariants && isSeriesFlow) {
            const variantCount = lines.filter((line) => String(line).trim().startsWith('#EXT-X-STREAM-INF')).length;
            console.info(`[VIX PROXY] Series-safe HLS master variants=${variantCount} policy=${variantPolicy} url=${sourceUrl}`);
        }

        const rewritten = hasVariants
            ? rewriteMasterManifest(lines, sourceUrl, req, pageReferer, variantPolicy)
            : rewriteLeafManifest(lines, sourceUrl, req, pageReferer);

        const out = rewritten.endsWith('\n') ? rewritten : `${rewritten}\n`;
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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
    buildRequestHeaders,
    buildProxyUrl,
    handleVixSynthetic
};

