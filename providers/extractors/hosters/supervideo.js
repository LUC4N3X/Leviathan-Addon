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

const SUPERVIDEO_REGEX = /(?:^|\/|\.)supervideo\./i;
const SOURCE_PATTERNS = [
    /sources\s*:\s*\[\s*\{[\s\S]{0,500}?file\s*:\s*["']([^"']+)["']/i,
    /["']?sources?["']?\s*[:=]\s*\[[\s\S]{0,800}?["']?file["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["']?file["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["']?hls["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["']?src["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /<source[^>]+src=["']([^"']+\.m3u8[^"']*)["']/i,
    /(https?:\\?\/\\?\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i,
    /(\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i
];

function isSupervideoUrl(url) {
    return SUPERVIDEO_REGEX.test(String(url || ''));
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&#038;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#039;/gi, "'")
        .replace(/&apos;/gi, "'");
}

function cleanCandidateUrl(value, baseUrl = null) {
    const raw = decodeHtmlEntities(value)
        .replace(/\\\//g, '/')
        .replace(/^['"]+|['"]+$/g, '')
        .trim();
    return normalizeRemoteUrl(raw, baseUrl);
}

function getVideoId(url) {
    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[parts.length - 1] || '';
    } catch (_) {
        return '';
    }
}

function buildSupervideoCandidates(url) {
    const absolute = cleanCandidateUrl(url);
    if (!absolute || !isSupervideoUrl(absolute)) return [];

    let parsed;
    try {
        parsed = new URL(absolute);
    } catch (_) {
        return [absolute];
    }

    const id = getVideoId(absolute);
    const candidates = [absolute];
    if (id) {
        for (const prefix of ['/v/', '/e/', '/embed/', '/embed-']) {
            const next = new URL(parsed.toString());
            next.pathname = `${prefix}${id}`;
            next.search = '';
            next.hash = '';
            candidates.push(next.toString());
        }
    }

    return [...new Set(candidates)];
}

function extractStreamUrl(html, playerUrl) {
    const text = String(html || '');
    const unpacked = unpackDeanEdwards(text);
    const spaces = [unpacked, text]
        .filter(Boolean)
        .map((value) => decodeHtmlEntities(value).replace(/\\\//g, '/'));

    for (const space of spaces) {
        const found = extractFirstUrl(space, SOURCE_PATTERNS, playerUrl);
        if (found) return found;
    }

    return null;
}

async function extractSupervideo(url, options = {}) {
    const client = options?.client;
    if (!client || typeof client.get !== 'function') return null;

    const candidates = buildSupervideoCandidates(url);
    if (!candidates.length) return null;

    let lastHeaders = null;
    let lastPlayerUrl = candidates[0];
    for (const playerUrl of candidates) {
        const headers = buildRequestHeaders(playerUrl, {
            userAgent: options?.userAgent || DEFAULT_USER_AGENT,
            referer: options?.requestReferer || options?.referer || `${new URL(playerUrl).origin}/`
        });
        lastHeaders = headers;
        lastPlayerUrl = playerUrl;

        const { status, text } = await fetchText(client, playerUrl, { headers, timeout: options?.timeout || 10_000 });
        if (status && status !== 200) continue;
        if (!text) continue;

        const streamUrl = extractStreamUrl(text, playerUrl);
        if (!streamUrl) continue;

        const origin = new URL(playerUrl).origin;
        const playbackHeaders = {
            Referer: `${origin}/`,
            Origin: origin,
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
            priority: 2
        };
    }

    if (process.env.SUPERVIDEO_DEBUG === '1') {
        console.warn(`[SuperVideo] extract empty url=${url} tried=${candidates.length} last=${lastPlayerUrl} referer=${lastHeaders?.Referer || ''}`);
    }
    return null;
}

module.exports = {
    buildSupervideoCandidates,
    extractSupervideo,
    extractStreamUrl,
    isSupervideoUrl
};
