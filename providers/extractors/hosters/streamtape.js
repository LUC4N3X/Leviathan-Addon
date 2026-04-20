'use strict';

const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    fetchText
} = require('./shared');

const STREAMTAPE_REGEX = /streamtape/i;
const ROBOTLINK_RE = /document\.getElementById\(['"]robotlink['"]\)\.(?:innerHTML|href)\s*=\s*(.*?);/is;
const ROBOTLINK_TAG_RE = /<a[^>]+id=["']robotlink["'][^>]+href=["']([^"']+)["']/i;
const RAW_DIRECT_RE = /["'](https?:\/\/[^"']*\/get_video[^"']+)["']/i;

function isStreamtapeUrl(url) {
    return STREAMTAPE_REGEX.test(String(url || ''));
}

function resolveExpressionToUrl(expression, baseUrl) {
    const pieces = String(expression || '').match(/["']([^"']+)["']/g) || [];
    const joined = pieces.map((part) => part.replace(/^["']|["']$/g, '')).join('');
    return normalizeRemoteUrl(joined, baseUrl);
}

async function extractStreamtape(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    const client = options?.client;
    if (!playerUrl || !isStreamtapeUrl(playerUrl) || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: options?.requestReferer || options?.pageUrl || playerUrl
    });

    const { status, text } = await fetchText(client, playerUrl, { headers });
    if (status !== 200 || !text) return null;

    let streamUrl = null;
    const robotMatch = text.match(ROBOTLINK_RE);
    if (robotMatch?.[1]) {
        streamUrl = resolveExpressionToUrl(robotMatch[1], playerUrl);
    }

    if (!streamUrl) {
        streamUrl = normalizeRemoteUrl(text.match(ROBOTLINK_TAG_RE)?.[1], playerUrl);
    }

    if (!streamUrl) {
        streamUrl = normalizeRemoteUrl(text.match(RAW_DIRECT_RE)?.[1], playerUrl);
    }

    if (!streamUrl) return null;

    return {
        url: streamUrl,
        headers: {
            Referer: playerUrl,
            'User-Agent': headers['User-Agent']
        },
        extractor: 'StreamTape',
        name: 'StreamTape',
        quality: 'Unknown',
        priority: 7
    };
}

module.exports = {
    extractStreamtape,
    isStreamtapeUrl
};
