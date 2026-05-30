'use strict';

const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractMediaUrl,
    fetchText,
    probeStreamQuality
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
    if (status < 200 || status >= 400 || !text) return null;

    const streamUrl = extractMediaUrl(text, SOURCE_PATTERNS, playerUrl);
    if (!streamUrl) return null;

    const playbackHeaders = {
        Referer: 'https://uqload.io/',
        Origin: 'https://uqload.io',
        'User-Agent': headers['User-Agent']
    };
    const quality = await probeStreamQuality(client, streamUrl, {
        headers: playbackHeaders,
        fallback: 'Unknown'
    });

    return {
        url: streamUrl,
        headers: playbackHeaders,
        extractor: 'Uqload',
        name: 'Uqload',
        quality,
        priority: 6
    };
}

module.exports = {
    extractUqload,
    isUqloadUrl
};
