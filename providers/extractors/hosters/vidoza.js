'use strict';

const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractMediaUrl,
    fetchText,
    probeStreamQuality
} = require('./shared');

const VIDOZA_REGEX = /vidoza/i;
const SOURCE_PATTERNS = [
    /sources:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i,
    /<source[^>]+src=["']([^"']+)["']/i,
    /file\s*:\s*["']([^"']+)["']/i
];

function isVidozaUrl(url) {
    return VIDOZA_REGEX.test(String(url || ''));
}

async function extractVidoza(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    const client = options?.client;
    if (!playerUrl || !isVidozaUrl(playerUrl) || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: options?.requestReferer || playerUrl
    });
    const { status, text } = await fetchText(client, playerUrl, { headers });
    if (status < 200 || status >= 400 || !text) return null;

    const streamUrl = extractMediaUrl(text, SOURCE_PATTERNS, playerUrl);
    if (!streamUrl) return null;

    const playbackHeaders = {
        Referer: playerUrl,
        'User-Agent': headers['User-Agent']
    };
    const quality = await probeStreamQuality(client, streamUrl, {
        headers: playbackHeaders,
        fallback: 'Unknown'
    });

    return {
        url: streamUrl,
        headers: playbackHeaders,
        extractor: 'Vidoza',
        name: 'Vidoza',
        quality,
        priority: 8
    };
}

module.exports = {
    extractVidoza,
    isVidozaUrl
};
