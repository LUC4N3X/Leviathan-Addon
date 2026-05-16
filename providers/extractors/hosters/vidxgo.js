'use strict';

const { getOrigin, normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    fetchText,
    probeStreamQuality
} = require('./shared');

const VIDXGO_RE = /(?:^|\.)(?:v\.)?vidxgo\.(?:co|com|net|to)$/i;
const STREAM_URL_RE = /https?:\\?\/\\?\/[^"'\s<>]+(?:\.m3u8|\/hls\/|\/playlist\/)[^"'\s<>]*/ig;

function isVidxgoUrl(url) {
    try {
        const host = new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
        return VIDXGO_RE.test(host);
    } catch (_) {
        return /vidxgo/i.test(String(url || ''));
    }
}

function cleanUrl(value, baseUrl = null) {
    const raw = String(value || '')
        .trim()
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/')
        .replace(/&amp;/gi, '&')
        .replace(/["'\s<>]+$/g, '');
    return normalizeRemoteUrl(raw, baseUrl);
}

function xorDecode(base64Text, key) {
    if (!base64Text || !key) return null;
    try {
        const input = Buffer.from(String(base64Text), 'base64');
        const output = Buffer.allocUnsafe(input.length);
        const keyText = String(key);
        for (let i = 0; i < input.length; i += 1) {
            output[i] = input[i] ^ keyText.charCodeAt(i % keyText.length);
        }
        return output.toString('utf8');
    } catch (_) {
        return null;
    }
}

function extractStreamUrlFromText(text, baseUrl = null) {
    const source = String(text || '');
    const patterns = [
        /currentSrc[^"']*["'](https?:\\?\/\\?\/[^"';\s<>]+)/i,
        /(?:file|source|src)\s*[:=]\s*["'](https?:\\?\/\\?\/[^"'\s<>]+)["']/i,
        /<source\b[^>]+src=["']([^"']+)["']/i
    ];

    for (const pattern of patterns) {
        const match = source.match(pattern);
        const normalized = cleanUrl(match?.[1], baseUrl);
        if (normalized) return normalized;
    }

    STREAM_URL_RE.lastIndex = 0;
    const direct = STREAM_URL_RE.exec(source)?.[0];
    return cleanUrl(direct, baseUrl);
}

function extractVidxgoStreamUrl(html, baseUrl = null) {
    const source = String(html || '');
    const decodedSpaces = [];
    const xorPattern = /var\s+\w+\s*=\s*['"]([^'"]+)['"]\s*,?\s*d\s*=\s*atob\s*\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/ig;
    let match;

    while ((match = xorPattern.exec(source)) !== null) {
        const decoded = xorDecode(match[2], match[1]);
        if (decoded) decodedSpaces.push(decoded);
    }

    for (const decoded of decodedSpaces) {
        const streamUrl = extractStreamUrlFromText(decoded, baseUrl);
        if (streamUrl) return streamUrl;
    }

    return extractStreamUrlFromText(source, baseUrl);
}

async function fetchVidxgoHtml(playerUrl, headers, options = {}) {
    const fetchers = Array.isArray(options?.fetchers) ? options.fetchers.filter(Boolean) : [];
    for (const fetcher of fetchers) {
        try {
            const result = await fetcher(playerUrl, headers);
            if (typeof result === 'string' && result.trim()) return result;
            if (result && typeof result === 'object') return JSON.stringify(result);
        } catch (_) {}
    }

    const client = options?.client;
    if (!client || typeof client.get !== 'function') return '';
    const response = await fetchText(client, playerUrl, {
        headers,
        timeout: Number.parseInt(options.timeoutMs || process.env.VIDXGO_TIMEOUT_MS || '12000', 10) || 12000
    });
    return response.text || '';
}

async function extractVidxgo(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    if (!playerUrl || !isVidxgoUrl(playerUrl)) return null;

    const userAgent = String(options.userAgent || process.env.VIDXGO_USER_AGENT || DEFAULT_USER_AGENT);
    const referer = String(options.requestReferer || options.referer || options.pageUrl || process.env.VIDXGO_REFERER || playerUrl);
    const origin = getOrigin(playerUrl);
    const host = (() => {
        try { return new URL(playerUrl).hostname; } catch (_) { return 'v.vidxgo.co'; }
    })();

    const pageHeaders = {
        ...buildRequestHeaders(playerUrl, { userAgent, referer, origin: getOrigin(referer, origin) }),
        'Alt-Used': host,
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Upgrade-Insecure-Requests': '1',
        DNT: '1'
    };

    const html = await fetchVidxgoHtml(playerUrl, pageHeaders, options);
    const streamUrl = extractVidxgoStreamUrl(html, playerUrl);
    if (!streamUrl) return null;

    const streamHeaders = {
        'User-Agent': userAgent,
        Referer: playerUrl,
        Origin: origin,
        Accept: '*/*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        DNT: '1'
    };

    const quality = await probeStreamQuality(options.client, streamUrl, {
        headers: streamHeaders,
        timeout: Number.parseInt(options.playlistTimeoutMs || process.env.VIDXGO_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000,
        fallback: options.quality || 'Unknown'
    });

    return {
        url: streamUrl,
        headers: streamHeaders,
        quality,
        extractor: 'VidxGo',
        name: 'VidxGo',
        priority: 0
    };
}

module.exports = {
    extractVidxgo,
    extractVidxGo: extractVidxgo,
    extractVidxGO: extractVidxgo,
    isVidxgoUrl
};
