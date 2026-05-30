'use strict';

const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractMediaUrl,
    fetchText,
    probeStreamQuality,
    unpackDeanEdwards
} = require('./shared');

const UPSTREAM_REGEX = /upstream/i;
const FILE_PATTERNS = [
    /file\s*:\s*["']([^"']+)["']/i,
    /sources:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i
];

function isUpstreamUrl(url) {
    return UPSTREAM_REGEX.test(String(url || ''));
}

async function extractUpstream(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    const client = options?.client;
    if (!playerUrl || !isUpstreamUrl(playerUrl) || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: 'https://upstream.to/'
    });
    const { status, text } = await fetchText(client, playerUrl, { headers });
    if (status < 200 || status >= 400 || !text) return null;

    const streamUrl = extractMediaUrl(`${text}\n${unpackDeanEdwards(text) || ''}`, FILE_PATTERNS, playerUrl);
    if (!streamUrl) return null;

    const playbackHeaders = {
        Referer: 'https://upstream.to/',
        Origin: 'https://upstream.to',
        'User-Agent': headers['User-Agent']
    };
    const quality = await probeStreamQuality(client, streamUrl, {
        headers: playbackHeaders,
        fallback: 'Unknown'
    });

    return {
        url: streamUrl,
        headers: playbackHeaders,
        extractor: 'Upstream',
        name: 'Upstream',
        quality,
        priority: 5
    };
}

module.exports = {
    extractUpstream,
    isUpstreamUrl
};
