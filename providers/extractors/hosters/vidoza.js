'use strict';

const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractFirstUrl,
    fetchText
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
    if (status !== 200 || !text) return null;

    const streamUrl = extractFirstUrl(text, SOURCE_PATTERNS, playerUrl);
    if (!streamUrl) return null;

    return {
        url: streamUrl,
        headers: {
            Referer: playerUrl,
            'User-Agent': headers['User-Agent']
        },
        extractor: 'Vidoza',
        name: 'Vidoza',
        quality: 'Unknown',
        priority: 8
    };
}

module.exports = {
    extractVidoza,
    isVidozaUrl
};
