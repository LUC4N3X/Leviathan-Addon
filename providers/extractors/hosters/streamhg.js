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

const STREAMHG_REGEX = /dhcplay|vibuxer/i;

// Prefer hls2 > hls4 > generic file/m3u8 — mirrors easystreams extraction order
const SOURCE_PATTERNS = [
    /"hls2"\s*:\s*"([^"]+)"/i,
    /\bhls2\s*[:=,]\s*["']([^"']+)["']/i,
    /"hls4"\s*:\s*"([^"]+)"/i,
    /\bhls4\s*[:=,]\s*["']([^"']+)["']/i,
    /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i
];

function isStreamhgUrl(url) {
    return STREAMHG_REGEX.test(String(url || ''));
}

function extractEmbedId(url) {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        return parts[parts.length - 1] || null;
    } catch (_) {
        return null;
    }
}

function buildCandidateUrls(url) {
    let normalized = String(url || '').trim();
    if (normalized.startsWith('//')) normalized = `https:${normalized}`;

    const candidates = [normalized];
    const id = extractEmbedId(normalized);
    if (id) {
        if (normalized.includes('dhcplay')) {
            candidates.push(`https://vibuxer.com/e/${id}`);
        } else if (normalized.includes('vibuxer')) {
            candidates.push(`https://dhcplay.com/e/${id}`);
        }
    }
    return candidates;
}

async function extractStreamhg(url, options = {}) {
    const client = options?.client;
    if (!client || typeof client.get !== 'function') return null;

    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const candidates = buildCandidateUrls(url);

    for (const candidate of candidates) {
        try {
            const origin = new URL(candidate).origin;
            const headers = buildRequestHeaders(candidate, {
                userAgent,
                referer: options?.requestReferer || options?.referer || `${origin}/`
            });

            const { status, text } = await fetchText(client, candidate, {
                headers,
                timeout: Number(options?.timeout || 12000)
            });

            if (status < 200 || status >= 400 || !text) continue;

            const unpacked = unpackDeanEdwards(text) || '';
            const streamUrl = extractMediaUrl(`${text}\n${unpacked}`, SOURCE_PATTERNS, candidate);
            if (!streamUrl) continue;

            const playbackHeaders = {
                Referer: `${origin}/`,
                Origin: origin,
                'User-Agent': userAgent
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

    return null;
}

module.exports = {
    extractStreamhg,
    isStreamhgUrl
};
