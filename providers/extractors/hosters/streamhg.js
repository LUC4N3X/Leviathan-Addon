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

const STREAMHG_REGEX = /(?:^|\/|\.)(?:dhcplay|vibuxer)\./i;

const SOURCE_PATTERNS = [
    // StreamHG-specific: hls2 > hls4 priority
    /"hls2"\s*:\s*"([^"]+)"/i,
    /\bhls2\s*[:=]\s*["']([^"']+)["']/i,
    /"hls4"\s*:\s*"([^"]+)"/i,
    /\bhls4\s*[:=]\s*["']([^"']+)["']/i,
    // Common player patterns
    /sources\s*:\s*\[\s*\{[\s\S]{0,500}?file\s*:\s*["']([^"']+)["']/i,
    /["']?file["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["']?src["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["']?hls["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /<source[^>]+src=["']([^"']+\.m3u8[^"']*)["']/i,
    /(https?:\\?\/\\?\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i
];

function isStreamhgUrl(url) {
    return STREAMHG_REGEX.test(String(url || ''));
}

function buildStreamhgCandidates(url) {
    let normalized = String(url || '').trim();
    if (normalized.startsWith('//')) normalized = `https:${normalized}`;

    let parsed;
    try {
        parsed = new URL(normalized);
    } catch (_) {
        return [normalized];
    }

    const host = parsed.hostname;
    const id = parsed.pathname.split('/').filter(Boolean).pop();
    if (!id) return [normalized];

    const mirrorHost = /dhcplay/i.test(host) ? 'vibuxer.com' : 'dhcplay.com';
    const candidates = [normalized];

    // Try embed path variants on same domain
    for (const prefix of ['/e/', '/embed/', '/v/']) {
        const variant = new URL(parsed.toString());
        variant.pathname = `${prefix}${id}`;
        variant.search = '';
        variant.hash = '';
        candidates.push(variant.toString());
    }

    // Try same variants on mirror domain
    for (const prefix of ['/e/', '/embed/', '/v/']) {
        candidates.push(`https://${mirrorHost}${prefix}${id}`);
    }

    return [...new Set(candidates)];
}

function extractStreamUrl(html, playerUrl) {
    const text = String(html || '');
    const unpacked = unpackDeanEdwards(text);
    const searchSpace = [unpacked, text]
        .filter(Boolean)
        .join('\n');
    return extractMediaUrl(searchSpace, SOURCE_PATTERNS, playerUrl);
}

async function extractStreamhg(url, options = {}) {
    const client = options?.client;
    if (!client || typeof client.get !== 'function') return null;

    const candidates = buildStreamhgCandidates(url);
    if (!candidates.length) return null;

    for (const playerUrl of candidates) {
        try {
            const origin = new URL(playerUrl).origin;
            const headers = buildRequestHeaders(playerUrl, {
                userAgent: options?.userAgent || DEFAULT_USER_AGENT,
                referer: options?.requestReferer || options?.referer || `${origin}/`
            });

            const { status, text } = await fetchText(client, playerUrl, {
                headers,
                timeout: Number(options?.timeout || 12000)
            });

            if (status < 200 || status >= 400 || !text) continue;

            const streamUrl = extractStreamUrl(text, playerUrl);
            if (!streamUrl) continue;

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
                extractor: 'StreamHG',
                name: 'StreamHG',
                quality,
                priority: 1
            };
        } catch (_) {
            continue;
        }
    }

    if (process.env.STREAMHG_DEBUG === '1') {
        console.warn(`[StreamHG] extract empty url=${url} tried=${candidates.length}`);
    }
    return null;
}

module.exports = {
    extractStreamhg,
    isStreamhgUrl
};
