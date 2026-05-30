'use strict';

const { getOrigin, normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractMediaUrl,
    fetchText,
    normalizeEscapedText
} = require('./shared');

const STREAMTAPE_REGEX = /streamtape/i;
const ROBOTLINK_RE = /document\.getElementById\(['"]robotlink['"]\)\.(?:innerHTML|href)\s*=\s*(.*?);/is;
const ROBOTLINK_TAG_RE = /<a[^>]+id=["']robotlink["'][^>]+href=["']([^"']+)["']/i;
const RAW_DIRECT_RE = /["'](https?:\/\/[^"']*\/get_video[^"']+)["']/i;

function isStreamtapeUrl(url) {
    return STREAMTAPE_REGEX.test(String(url || ''));
}

function resolveExpressionToUrl(expression, baseUrl) {
    const source = normalizeEscapedText(expression);
    const pieces = source.match(/["'`]([^"'`]+)["'`]/g) || [];
    const joined = pieces.map((part) => part.replace(/^["'`]|["'`]$/g, '')).join('');
    return normalizeRemoteUrl(joined, baseUrl);
}

function extractRobotLink(text, playerUrl) {
    const html = normalizeEscapedText(text);
    const robotMatch = html.match(ROBOTLINK_RE);
    if (robotMatch?.[1]) {
        const resolved = resolveExpressionToUrl(robotMatch[1], playerUrl);
        if (resolved) return resolved;
    }

    const tag = normalizeRemoteUrl(html.match(ROBOTLINK_TAG_RE)?.[1], playerUrl);
    if (tag) return tag;

    const raw = normalizeRemoteUrl(html.match(RAW_DIRECT_RE)?.[1], playerUrl);
    if (raw) return raw;

    return extractMediaUrl(html, [], playerUrl);
}

async function extractStreamtape(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    const client = options?.client;
    if (!playerUrl || !isStreamtapeUrl(playerUrl) || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: options?.requestReferer || options?.pageUrl || playerUrl
    });

    const { status, text } = await fetchText(client, playerUrl, {
        headers,
        timeout: Number(options?.timeout || 10_000)
    });
    if (status < 200 || status >= 400 || !text) return null;

    const streamUrl = extractRobotLink(text, playerUrl);
    if (!streamUrl) return null;

    return {
        url: streamUrl,
        headers: {
            Referer: playerUrl,
            Origin: getOrigin(playerUrl),
            'User-Agent': headers['User-Agent']
        },
        extractor: 'StreamTape',
        name: 'StreamTape',
        quality: 'Unknown',
        priority: 7
    };
}

module.exports = {
    extractRobotLink,
    extractStreamtape,
    isStreamtapeUrl,
    resolveExpressionToUrl
};
