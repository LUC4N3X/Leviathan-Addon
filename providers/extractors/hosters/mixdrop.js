'use strict';

const {
    detectStreamQuality,
    extractSizeText,
    getOrigin,
    normalizeRemoteUrl
} = require('../common');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIXDROP_REGEX = /mixdrop|m1xdrop|mxcontent|mixdrp/i;
const NOT_FOUND_REGEX = /can't find the (?:file|video)|deleted|expired/i;
const DIRECT_URL_REGEX = /(?:MDCore|Core|wurl)\s*(?:\.wurl)?\s*=\s*["']([^"']+)["']/i;
const M3U8_REGEX = /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i;

function isMixdropUrl(url) {
    return MIXDROP_REGEX.test(String(url || ''));
}

function unpackDeanEdwards(html) {
    if (!html || typeof html !== 'string') return null;
    try {
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,?[rd]?\).*?\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'([^']+)'\.split\('\|'\).*?\)\)/s);
        if (!packedMatch) return null;

        let [_, payload, base, count, dictionary] = packedMatch;
        base = parseInt(base, 10);
        count = parseInt(count, 10);
        dictionary = dictionary.split('|');

        const encode = (value) => {
            const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
            if (value === 0) return alphabet[0];
            let output = '';
            while (value > 0) {
                output = alphabet[value % base] + output;
                value = Math.floor(value / base);
            }
            return output;
        };

        let unpacked = payload;
        for (let index = count - 1; index >= 0; index -= 1) {
            if (!dictionary[index]) continue;
            unpacked = unpacked.replace(new RegExp(`\\b${encode(index)}\\b`, 'g'), dictionary[index]);
        }
        return unpacked;
    } catch (_) {
        return null;
    }
}

function normalizeMixdropUrl(url) {
    const absolute = normalizeRemoteUrl(url);
    if (!absolute || !isMixdropUrl(absolute)) return null;
    try {
        const parsed = new URL(absolute);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const fileId = parts.length >= 2 && /^(?:e|emb|embed|f|file|watch|video)$/i.test(parts[0])
            ? parts[1]
            : parts.length === 1 ? parts[0] : '';
        if (fileId) {
            parsed.pathname = `/e/${fileId}`;
            parsed.search = '';
            parsed.hash = '';
            return parsed.toString();
        }
    } catch (_) {}
    return absolute
        .replace('/emb/', '/e/')
        .replace('/embed/', '/e/')
        .replace('/f/', '/e/')
        .replace('/file/', '/e/')
        .replace('/watch/', '/e/')
        .replace('/video/', '/e/');
}

function buildMixdropHeaders(embedUrl, userAgent) {
    const origin = getOrigin(embedUrl, 'https://m1xdrop.net');
    return {
        Referer: `${origin}/`,
        Origin: origin,
        'User-Agent': userAgent || DEFAULT_USER_AGENT
    };
}

function extractDirectUrl(html, baseUrl) {
    if (!html) return null;
    const directMatch = html.match(DIRECT_URL_REGEX)?.[1] || html.match(M3U8_REGEX)?.[1];
    return normalizeRemoteUrl(directMatch, baseUrl);
}

async function extractMixdrop(url, options = {}) {
    const embedUrl = normalizeMixdropUrl(url);
    const client = options?.client;
    if (!embedUrl || !client || typeof client.get !== 'function') return null;

    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const requestHeaders = {
        ...buildMixdropHeaders(embedUrl, userAgent),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    let quality = 'Unknown';
    let size = 'N/A';

    try {
        const filePageUrl = embedUrl.replace('/e/', '/f/');
        const fileResponse = await client.get(filePageUrl, { headers: requestHeaders });
        const fileHtml = typeof fileResponse?.data === 'string' ? fileResponse.data : '';
        if (fileHtml && !NOT_FOUND_REGEX.test(fileHtml)) {
            quality = detectStreamQuality(fileHtml, quality);
            size = extractSizeText(fileHtml);
        }
    } catch (_) {}

    try {
        const response = await client.get(embedUrl, { headers: requestHeaders });
        const html = typeof response?.data === 'string' ? response.data : '';
        const unpacked = unpackDeanEdwards(html);
        const streamUrl = extractDirectUrl(unpacked || html, embedUrl);
        if (!streamUrl) return null;

        return {
            url: streamUrl,
            headers: buildMixdropHeaders(embedUrl, userAgent),
            extractor: 'MixDrop',
            name: 'MixDrop',
            quality: detectStreamQuality(streamUrl, quality),
            size,
            priority: 1
        };
    } catch (_) {
        return null;
    }
}

module.exports = {
    isMixdropUrl,
    extractMixdrop
};
