'use strict';

const { getOrigin, normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractFirstUrl,
    fetchText,
    probeStreamQuality,
    unpackDeanEdwards
} = require('./shared');

const MAXSTREAM_REGEX = /(?:uprot\.net|maxstream\.video|stayonline\.pro)/i;
const FINAL_HOST_RE = /https?:\/\/(?:www\.)?(?:maxstream\.video|stayonline\.pro)[^"'\s<>\\]+/i;
const SOURCE_PATTERNS = [
    /sources\s*:\s*\[\s*\{\s*(?:src|file)\s*:\s*["']([^"']+)["']/i,
    /(?:src|file)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["'](https?:\/\/[^"']+host-cdn\.net\/hls\/[^"']+master\.m3u8[^"']*)["']/i
];

function isMaxstreamUrl(url) {
    return MAXSTREAM_REGEX.test(String(url || ''));
}

function normalizeMaxstreamInput(url) {
    const absolute = normalizeRemoteUrl(url);
    if (!absolute || !isMaxstreamUrl(absolute)) return null;
    return absolute.replace('/msf/', '/mse/');
}

function compactCandidate(value, baseUrl = null) {
    if (!value) return null;
    return normalizeRemoteUrl(String(value).replace(/\\\//g, '/').replace(/\\/g, ''), baseUrl);
}

function extractRedirectCandidate(html, baseUrl) {
    const text = String(html || '');
    const direct = compactCandidate(text.match(FINAL_HOST_RE)?.[0], baseUrl);
    if (direct) return direct;

    const patterns = [
        /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
        /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
        /href=["']([^"']*(?:maxstream|stayonline)[^"']*)["']/i,
        /data-(?:href|url|link)=["']([^"']*(?:maxstream|stayonline)[^"']*)["']/i
    ];
    for (const pattern of patterns) {
        const candidate = compactCandidate(text.match(pattern)?.[1], baseUrl);
        if (candidate && /(?:maxstream\.video|stayonline\.pro)/i.test(candidate)) return candidate;
    }
    return null;
}

function extractCanonicalUrl(html, fallbackUrl) {
    const text = String(html || '');
    const fileCode = text.match(/[?&]file_code=([a-z0-9]+)/i)?.[1]
        || text.match(/\bfile_code["']?\s*[:=]\s*["']?([a-z0-9]+)/i)?.[1]
        || text.match(/\$\.cookie\(["']file_id["'],\s*["']([a-z0-9]+)["']/i)?.[1]
        || text.match(/\b(?:file|id)["']?\s*[:=]\s*["']([a-z0-9]{8,})["']/i)?.[1];

    if (fileCode) return `https://maxstream.video/emhuih/${fileCode}`;
    return fallbackUrl;
}

function parseDeanEdwardsParts(html) {
    const match = String(html || '').match(/eval\(function\(p,a,c,k,e,?[rd]?\)\s*\{.*?\}\s*\('(.*?)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('\|'\).*?\)\)/s);
    if (!match) return null;
    return {
        payload: match[1],
        base: Number.parseInt(match[2], 10),
        count: Number.parseInt(match[3], 10),
        dictionary: String(match[4] || '').split('|')
    };
}

function reconstructHostCdnMaster(parts) {
    const dict = Array.isArray(parts?.dictionary) ? [...parts.dictionary] : [];
    if (!dict.length) return null;

    const urlsetIdx = dict.indexOf('urlset');
    const hlsIdx = dict.indexOf('hls');
    const sourcesIdx = dict.indexOf('sources');
    if (urlsetIdx < 0 || hlsIdx < 0 || sourcesIdx < 0 || !(urlsetIdx < hlsIdx && hlsIdx < sourcesIdx)) return null;

    const pathTokens = dict.slice(urlsetIdx + 1, hlsIdx).filter(Boolean).reverse();
    const hostTokens = dict.slice(hlsIdx + 1, sourcesIdx).filter(Boolean).reverse();
    if (!pathTokens.length || !hostTokens.length) return null;

    const hostPrefix = hostTokens
        .map((token) => /0/.test(token) ? token : `${token}-`)
        .join('')
        .replace(/-+$/, '')
        .replace(/^-+/, '');
    if (!hostPrefix) return null;

    const filePart = pathTokens.length === 1
        ? `,${pathTokens[0]}.urlset/master.m3u8`
        : `${pathTokens.join(',')}.urlset/master.m3u8`;

    return `https://${hostPrefix}.host-cdn.net/hls/${filePart}`;
}

function buildPlaybackHeaders(playerUrl, userAgent, referer = null) {
    const origin = getOrigin(playerUrl, 'https://maxstream.video');
    return {
        Referer: referer || `${origin}/`,
        Origin: origin,
        'User-Agent': userAgent || DEFAULT_USER_AGENT,
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };
}

async function resolveUprotLanding(client, landingUrl, options = {}) {
    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const referer = options?.requestReferer || options?.referer || 'https://uprot.net/';
    const headers = buildRequestHeaders(landingUrl, { userAgent, referer });
    const { status, text } = await fetchText(client, landingUrl, {
        headers,
        timeout: Number(options?.landingTimeout || 12_000)
    });
    if (status < 200 || status >= 400 || !text) return null;

    const directStream = extractFirstUrl(text, SOURCE_PATTERNS, landingUrl);
    if (directStream) return { streamUrl: directStream, playerUrl: landingUrl, sourceUrl: landingUrl, via: 'uprot-direct' };

    const redirected = extractRedirectCandidate(text, landingUrl);
    if (!redirected) return null;
    return { playerUrl: redirected, sourceUrl: landingUrl, via: 'uprot-redirect' };
}

async function extractMaxstream(url, options = {}) {
    const inputUrl = normalizeMaxstreamInput(url);
    const client = options?.client;
    if (!inputUrl || !client || typeof client.get !== 'function') return null;

    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    let playerUrl = inputUrl;
    let sourceUrl = inputUrl;
    let via = 'direct';

    try {
        if (/uprot\.net/i.test(playerUrl)) {
            const resolved = await resolveUprotLanding(client, playerUrl, options);
            if (!resolved) return null;
            if (resolved.streamUrl) {
                const headers = buildPlaybackHeaders(resolved.playerUrl, userAgent, sourceUrl);
                const quality = await probeStreamQuality(client, resolved.streamUrl, { headers, fallback: 'Unknown' });
                return {
                    url: resolved.streamUrl,
                    sourceUrl: resolved.sourceUrl,
                    headers,
                    extractor: 'MaxStream',
                    name: 'MaxStream',
                    quality,
                    priority: 0,
                    via: resolved.via
                };
            }
            playerUrl = resolved.playerUrl;
            sourceUrl = resolved.sourceUrl || sourceUrl;
            via = resolved.via || via;
        }

        const pageReferer = /uprot\.net/i.test(sourceUrl) ? 'https://uprot.net/' : (options?.requestReferer || options?.referer || `${getOrigin(playerUrl)}/`);
        const headers = buildRequestHeaders(playerUrl, {
            userAgent,
            referer: pageReferer,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        });
        const { status, text } = await fetchText(client, playerUrl, {
            headers,
            timeout: Number(options?.timeout || 12_000)
        });
        if (status < 200 || status >= 400 || !text) return null;

        const canonicalUrl = extractCanonicalUrl(text, playerUrl);
        const unpacked = unpackDeanEdwards(text) || '';
        const searchSpace = `${text}\n${unpacked}`;
        let streamUrl = extractFirstUrl(searchSpace, SOURCE_PATTERNS, playerUrl);

        if (!streamUrl) {
            streamUrl = reconstructHostCdnMaster(parseDeanEdwardsParts(text));
        }
        if (!streamUrl) return null;

        const playbackHeaders = buildPlaybackHeaders(playerUrl, userAgent);
        const quality = await probeStreamQuality(client, streamUrl, {
            headers: playbackHeaders,
            fallback: 'Unknown'
        });

        return {
            url: streamUrl,
            sourceUrl: canonicalUrl || playerUrl,
            headers: playbackHeaders,
            extractor: 'MaxStream',
            name: 'MaxStream',
            quality,
            priority: 0,
            via
        };
    } catch (_) {
        return null;
    }
}

module.exports = {
    extractMaxstream,
    isMaxstreamUrl,
    normalizeMaxstreamInput
};
