const axios = require('axios');
const { getRequestOrigin, isSafeRemoteUrl } = require('../../core/utils/url');
const { decodeProxyToken, makeProxyToken, normalizeHeaders } = require('./proxy_tokens');

const DEFAULT_REFERER = 'https://vixsrc.to/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

    return normalizeHeaders({
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
    const resMatch = infoLine.match(/RESOLUTION=(\d+)x(\d+)/i);
    if (resMatch) {
        return Number(resMatch[1]) * Number(resMatch[2]);
    }
    const bandwidthMatch = infoLine.match(/BANDWIDTH=(\d+)/i);
    return bandwidthMatch ? Number(bandwidthMatch[1]) : 0;
}

function selectVariant(variants, forceMax) {
    if (!variants.length) return null;

    const sorted = [...variants].sort((a, b) => b.score - a.score);
    if (forceMax || sorted.length === 1) return sorted[0];

    const target = sorted.find((v) => v.score > 400000 && v.score < 2000000 && v.score !== sorted[0].score);
    return target || sorted[1] || sorted[0];
}

function buildProxyUrl(req, absoluteUrl, pageReferer, extraHeaders = null) {
    const selfBase = getSelfBase(req);
    const url = new URL(`${selfBase}/vixsynthetic.m3u8`);
    const token = makeProxyToken(absoluteUrl, {
        referer: pageReferer,
        headers: buildRequestHeaders(absoluteUrl, pageReferer, extraHeaders)
    });
    if (token) url.searchParams.set('d', token);
    else url.searchParams.set('src', absoluteUrl);
    if (pageReferer) {
        url.searchParams.set('referer', pageReferer);
    }
    return url.toString();
}

function rewriteDirectiveUri(line, baseUrl, req, pageReferer) {
    return line.replace(/URI="([^"]+)"/i, (_, uri) => {
        const absolute = safeUrl(uri, baseUrl);
        return absolute ? `URI="${buildProxyUrl(req, absolute, pageReferer)}"` : `URI="${uri}"`;
    });
}

function rewriteLeafManifest(lines, baseUrl, req, pageReferer) {
    const out = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
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
        out.push(absolute ? buildProxyUrl(req, absolute, pageReferer) : line);
    }

    return out.join('\n');
}

function rewriteMasterManifest(lines, baseUrl, req, pageReferer, forceMax) {
    const output = [];
    const variants = [];

    for (let i = 0; i < lines.length; i += 1) {
        const line = (lines[i] || '').trim();
        if (!line) {
            output.push('');
            continue;
        }

        if (line.startsWith('#EXT-X-MEDIA')) {
            output.push(rewriteDirectiveUri(line, baseUrl, req, pageReferer));
            continue;
        }

        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const nextLine = (lines[i + 1] || '').trim();
            const absolute = safeUrl(nextLine, baseUrl);
            variants.push({
                info: line,
                url: absolute,
                score: getResolutionScore(line)
            });
            i += 1;
            continue;
        }

        if (!line.startsWith('#')) {
            const absolute = safeUrl(line, baseUrl);
            output.push(absolute ? buildProxyUrl(req, absolute, pageReferer) : line);
            continue;
        }

        output.push(line);
    }

    if (!variants.length) {
        return output.join('\n');
    }

    const selected = selectVariant(variants, forceMax);
    if (!selected || !selected.url) {
        return output.join('\n');
    }

    output.push(selected.info);
    output.push(buildProxyUrl(req, selected.url, pageReferer));
    return output.join('\n');
}

async function fetchUpstream(targetUrl, referer, upstreamHeaders = null) {
    return axios.get(targetUrl, {
        headers: upstreamHeaders || buildRequestHeaders(targetUrl, referer),
        timeout: 10000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        proxy: false
    });
}

function resolveProxySource(req) {
    const tokenPayload = decodeProxyToken(req.query.d);
    if (tokenPayload?.url && isSafeRemoteUrl(tokenPayload.url)) {
        return {
            sourceUrl: tokenPayload.url,
            pageReferer: safeUrl(tokenPayload.referer, DEFAULT_REFERER) || DEFAULT_REFERER,
            upstreamHeaders: tokenPayload.headers || buildRequestHeaders(tokenPayload.url, tokenPayload.referer || DEFAULT_REFERER)
        };
    }

    const sourceUrl = safeUrl(req.query.src);
    const pageReferer = safeUrl(req.query.referer, DEFAULT_REFERER) || DEFAULT_REFERER;
    if (!sourceUrl || !isSafeRemoteUrl(sourceUrl)) return null;

    return {
        sourceUrl,
        pageReferer,
        upstreamHeaders: buildRequestHeaders(sourceUrl, pageReferer)
    };
}

async function handleVixSynthetic(req, res) {
    const resolved = resolveProxySource(req);
    const forceMax = req.query.max === '1';

    if (!resolved?.sourceUrl) {
        return res.status(400).send('Invalid or unsafe src');
    }

    const { sourceUrl, pageReferer, upstreamHeaders } = resolved;

    try {
        const upstream = await fetchUpstream(sourceUrl, pageReferer, upstreamHeaders);
        if (upstream.status >= 400) {
            console.error(`[VIX PROXY] Upstream ${upstream.status} for ${sourceUrl}`);
            return res.status(upstream.status).send(`Vix upstream error ${upstream.status}`);
        }

        const contentType = String(upstream.headers['content-type'] || '');
        const buffer = Buffer.isBuffer(upstream.data) ? upstream.data : Buffer.from(upstream.data || '');

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=30');

        if (!isManifest(sourceUrl, contentType)) {
            if (contentType) res.setHeader('Content-Type', contentType);
            return res.send(buffer);
        }

        const manifest = buffer.toString('utf8');
        const lines = manifest.replace(/\r\n/g, '\n').split('\n');
        const hasVariants = lines.some((line) => String(line).trim().startsWith('#EXT-X-STREAM-INF'));

        const rewritten = hasVariants
            ? rewriteMasterManifest(lines, sourceUrl, req, pageReferer, forceMax)
            : rewriteLeafManifest(lines, sourceUrl, req, pageReferer);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(rewritten);
    } catch (error) {
        console.error('Vix Proxy Error:', error.message);
        return res.status(500).send('Vix Proxy Error');
    }
}

module.exports = {
    buildRequestHeaders,
    buildProxyUrl,
    handleVixSynthetic
};
