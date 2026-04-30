'use strict';

const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    fetchText
} = require('./shared');

const UQLOAD_REGEX = /uqload/i;
const SOURCE_PATTERNS = [
    /sources:\s*\[\s*["']([^"']+)["']\s*\]/i,
    /file\s*:\s*["']([^"']+)["']/i
];

function isUqloadUrl(url) {
    return UQLOAD_REGEX.test(String(url || ''));
}

async function extractUqload(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    const client = options?.client;
    if (!playerUrl || !isUqloadUrl(playerUrl) || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: 'https://uqload.io/'
    });
    const { status, text } = await fetchText(client, playerUrl, { headers });
    if (status !== 200 || !text) return null;

    let streamUrl = null;
    for (const pattern of SOURCE_PATTERNS) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        streamUrl = normalizeRemoteUrl(match[1], playerUrl);
        if (streamUrl) break;
    }

    if (!streamUrl) return null;

    return {
        url: streamUrl,
        headers: {
            Referer: 'https://uqload.io/',
            Origin: 'https://uqload.io',
            'User-Agent': headers['User-Agent']
        },
        extractor: 'Uqload',
        name: 'Uqload',
        quality: 'Unknown',
        priority: 6
    };
}

module.exports = {
    extractUqload,
    isUqloadUrl
};
