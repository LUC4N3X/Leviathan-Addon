const axios = require('axios');
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
const MAX_UPSTREAM_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = Math.max(10000, Number.parseInt(process.env.VIX_PROXY_TIMEOUT_MS || '18000', 10) || 18000);
const HLS_PLAYBACK_TOKEN_TTL_MS = Math.max(10 * 60 * 1000, Number.parseInt(process.env.VIX_HLS_TOKEN_TTL_MS || String(2 * 60 * 60 * 1000), 10) || (2 * 60 * 60 * 1000));
const VIX_STRICT_HOST_BINDING = String(process.env.VIX_STRICT_HOST_BINDING || '').trim() === '1';

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

function buildRequestHeaders(targetUrl, explicitReferer, overrides = null) {
    const target = new URL(targetUrl);
    let referer = explicitReferer || `${target.origin}/`;
    let origin = target.origin;

    try {
        if (explicitReferer) {
            origin = new URL(explicitReferer).origin;
            referer = explicitReferer;
        }
    } catch {}

    return normalizeRequestHeaders({
        'User-Agent': DEFAULT_UA,
        Accept: '*/*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Referer: referer,
        Origin: origin,
        ...(overrides || {})
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

function selectVariant(variants, policy = 'auto') {
    if (!variants.length) return null;
    const sorted = [...variants].sort((a, b) => b.score - a.score);
    if (policy === 'max' || sorted.length === 1) return sorted[0];
    if (policy === 'mid') {
        const mid = sorted.find((variant) => variant.score > 400000 && variant.score < 2000000 && variant.score !== sorted[0].score);
        return mid || sorted[1] || sorted[0];
    }
    return sorted[0];
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
        if (line.startsWith('#EXT-X-MEDIA')) {
            output.push(rewriteDirectiveUri(line, baseUrl, req, pageReferer));
            continue;
        }
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const nextLine = String(lines[i + 1] || '').trim();
            const absolute = safeUrl(nextLine, baseUrl);
            variants.push({ info: line, url: absolute, score: getResolutionScore(line) });
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

    const selected = selectVariant(variants, variantPolicy);
    if (!selected || !selected.url) return output.join('\n');

    output.push(selected.info);
    output.push(buildProxyUrl(req, selected.url, pageReferer) || selected.url);
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

async function fetchUpstream(targetUrl, referer, upstreamHeaders = null, req = null) {
    const headers = { ...(upstreamHeaders || buildRequestHeaders(targetUrl, referer)) };
    const range = String(req?.headers?.range || '').trim();
    if (range && /^bytes=\d*-\d*(?:,\d*-\d*)*$/i.test(range)) headers.Range = range;

    return axios.get(targetUrl, {
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
        maxRedirects: MAX_UPSTREAM_REDIRECTS,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        proxy: false,
        decompress: true
    });
}

function resolveProxySource(req) {
    const tokenPayload = resolveTransitKey(req.query.d, {
        kind: TRANSIT_KIND,
        hostBinding: VIX_STRICT_HOST_BINDING ? getSelfBase(req) : null,
        routeBinding: MANIFEST_ROUTE
    });

    if (tokenPayload?.url && isSafeRemoteUrl(tokenPayload.url)) {
        return {
            sourceUrl: tokenPayload.url,
            pageReferer: safeUrl(tokenPayload.referer, DEFAULT_REFERER) || DEFAULT_REFERER,
            upstreamHeaders: tokenPayload.headers || buildRequestHeaders(tokenPayload.url, tokenPayload.referer || DEFAULT_REFERER),
            variantPolicy: String(tokenPayload?.meta?.syntheticVariant || 'auto').toLowerCase()
        };
    }

    const sourceUrl = safeUrl(req.query.src);
    const pageReferer = safeUrl(req.query.referer, DEFAULT_REFERER) || DEFAULT_REFERER;
    if (!sourceUrl || !isSafeRemoteUrl(sourceUrl)) return null;

    return {
        sourceUrl,
        pageReferer,
        upstreamHeaders: buildRequestHeaders(sourceUrl, pageReferer),
        variantPolicy: String(req.query.variant || 'auto').toLowerCase()
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
    if (!resolved?.sourceUrl) return res.status(400).send('Invalid or unsafe src');

    const { sourceUrl, pageReferer, upstreamHeaders, variantPolicy } = resolved;

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
            if (req.method === 'HEAD') return res.end();
            return res.end(buffer);
        }

        const manifestText = buffer.toString('utf8');
        const lines = manifestText.replace(/\r\n/g, '\n').split('\n');
        const hasVariants = lines.some((line) => String(line).trim().startsWith('#EXT-X-STREAM-INF'));

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
