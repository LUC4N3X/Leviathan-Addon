'use strict';

const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractFirstUrl,
    fetchText,
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
    if (status !== 200 || !text) return null;

    const streamUrl = extractFirstUrl(unpackDeanEdwards(text) || text, FILE_PATTERNS, playerUrl);
    if (!streamUrl) return null;

    return {
        url: streamUrl,
        headers: {
            Referer: 'https://upstream.to/',
            Origin: 'https://upstream.to',
            'User-Agent': headers['User-Agent']
        },
        extractor: 'Upstream',
        name: 'Upstream',
        quality: 'Unknown',
        priority: 5
    };
}

module.exports = {
    extractUpstream,
    isUpstreamUrl
};
