'use strict';

const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractFirstUrl,
    fetchText,
    probeStreamQuality,
    unpackDeanEdwards
} = require('./shared');

const DROPLOAD_REGEX = /dropload|dr0pstream/i;
const SOURCE_PATTERNS = [
    /sources:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i,
    /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i
];

function isDroploadUrl(url) {
    return DROPLOAD_REGEX.test(String(url || ''));
}

async function extractDropload(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    const client = options?.client;
    if (!playerUrl || !isDroploadUrl(playerUrl) || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: options?.requestReferer || `${new URL(playerUrl).origin}/`
    });
    const { status, text } = await fetchText(client, playerUrl, { headers });
    if (status !== 200 || !text) return null;

    const searchSpace = unpackDeanEdwards(text) || text;
    const streamUrl = extractFirstUrl(searchSpace, SOURCE_PATTERNS, playerUrl);
    if (!streamUrl) return null;

    const playbackHeaders = {
        Referer: `${new URL(playerUrl).origin}/`,
        Origin: new URL(playerUrl).origin,
        'User-Agent': headers['User-Agent']
    };
    const quality = await probeStreamQuality(client, streamUrl, {
        headers: playbackHeaders,
        fallback: 'Unknown'
    });

    return {
        url: streamUrl,
        headers: playbackHeaders,
        extractor: 'DropLoad',
        name: 'DropLoad',
        quality,
        priority: 2
    };
}

module.exports = {
    extractDropload,
    isDroploadUrl
};
