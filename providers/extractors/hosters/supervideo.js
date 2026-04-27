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

const SUPERVIDEO_REGEX = /supervideo/i;
const SOURCE_PATTERNS = [
    /sources:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i,
    /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /<source[^>]+src=["']([^"']+)["']/i
];

function isSupervideoUrl(url) {
    return SUPERVIDEO_REGEX.test(String(url || ''));
}

function normalizeSupervideoUrl(url) {
    const absolute = normalizeRemoteUrl(url);
    if (!absolute || !isSupervideoUrl(absolute)) return null;
    if (/\/e\//i.test(absolute)) return absolute;
    try {
        const parsed = new URL(absolute);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const id = parts[parts.length - 1];
        if (!id) return absolute;
        parsed.pathname = `/e/${id}`;
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return absolute;
    }
}

async function extractSupervideo(url, options = {}) {
    const playerUrl = normalizeSupervideoUrl(url);
    const client = options?.client;
    if (!playerUrl || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: options?.requestReferer || 'https://supervideo.tv/'
    });
    const { status, text } = await fetchText(client, playerUrl, { headers });
    if (status !== 200 || !text) return null;

    const streamUrl = extractFirstUrl(unpackDeanEdwards(text) || text, SOURCE_PATTERNS, playerUrl);
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
        extractor: 'SuperVideo',
        name: 'SuperVideo',
        quality,
        priority: 0
    };
}

module.exports = {
    extractSupervideo,
    isSupervideoUrl
};
