'use strict';

const {
    detectStreamQuality,
    extractSizeText,
    getOrigin,
    normalizeRemoteUrl
} = require('../common');
const {
    DEFAULT_USER_AGENT,
    extractMediaUrl,
    fetchText,
    probeStreamQuality,
    unpackDeanEdwards
} = require('./shared');
const MIXDROP_REGEX = /mixdrop|m1xdrop|mxcontent|mixdrp/i;
const NOT_FOUND_REGEX = /can't find the (?:file|video)|deleted|expired/i;
const DIRECT_URL_REGEX = /(?:MDCore|Core|wurl)\s*(?:\.wurl)?\s*=\s*["']([^"']+)["']/i;
const M3U8_REGEX = /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i;

function isMixdropUrl(url) {
    return MIXDROP_REGEX.test(String(url || ''));
}

function normalizeMixdropUrl(url) {
    const absolute = normalizeRemoteUrl(url);
    if (!absolute || !isMixdropUrl(absolute)) return null;
    try {
        const parsed = new URL(absolute);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const fileId = parts.length >= 2 && /^(?:e|emb|embed|f|file|watch|video)$/i.test(parts[0])
            ? parts[1]
            : parts.length === 1 ? parts[0] : '';
        if (fileId) {
            parsed.pathname = `/e/${fileId}`;
            parsed.search = '';
            parsed.hash = '';
            return parsed.toString();
        }
    } catch (_) {}
    return absolute
        .replace('/emb/', '/e/')
        .replace('/embed/', '/e/')
        .replace('/f/', '/e/')
        .replace('/file/', '/e/')
        .replace('/watch/', '/e/')
        .replace('/video/', '/e/');
}

function buildMixdropHeaders(embedUrl, userAgent) {
    const origin = getOrigin(embedUrl, 'https://m1xdrop.net');
    return {
        Referer: `${origin}/`,
        Origin: origin,
        'User-Agent': userAgent || DEFAULT_USER_AGENT
    };
}

function extractDirectUrl(html, baseUrl) {
    if (!html) return null;
    const directMatch = html.match(DIRECT_URL_REGEX)?.[1] || html.match(M3U8_REGEX)?.[1];
    return normalizeRemoteUrl(directMatch, baseUrl);
}

async function extractMixdrop(url, options = {}) {
    const embedUrl = normalizeMixdropUrl(url);
    const client = options?.client;
    if (!embedUrl || !client || typeof client.get !== 'function') return null;

    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const requestHeaders = {
        ...buildMixdropHeaders(embedUrl, userAgent),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    let quality = 'Unknown';
    let size = 'N/A';

    try {
        const filePageUrl = embedUrl.replace('/e/', '/f/');
        const { text: fileHtml } = await fetchText(client, filePageUrl, {
            headers: requestHeaders,
            timeout: Number(options?.metadataTimeout || 7000)
        });
        if (fileHtml && !NOT_FOUND_REGEX.test(fileHtml)) {
            quality = detectStreamQuality(fileHtml, quality);
            size = extractSizeText(fileHtml);
        }
    } catch (_) {}

    try {
        const { status, text: html } = await fetchText(client, embedUrl, {
            headers: requestHeaders,
            timeout: Number(options?.timeout || 10000)
        });
        if (status < 200 || status >= 400 || !html) return null;
        const unpacked = unpackDeanEdwards(html);
        const streamUrl = extractDirectUrl(`${html}\n${unpacked || ''}`, embedUrl)
            || extractMediaUrl(`${html}\n${unpacked || ''}`, [], embedUrl);
        if (!streamUrl) return null;

        const playbackHeaders = buildMixdropHeaders(embedUrl, userAgent);
        const probedQuality = await probeStreamQuality(client, streamUrl, {
            headers: playbackHeaders,
            fallback: detectStreamQuality(streamUrl, quality)
        });

        return {
            url: streamUrl,
            headers: playbackHeaders,
            extractor: 'MixDrop',
            name: 'MixDrop',
            quality: probedQuality,
            size,
            priority: 1
        };
    } catch (_) {
        return null;
    }
}

module.exports = {
    isMixdropUrl,
    extractMixdrop
};
