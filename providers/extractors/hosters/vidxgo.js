'use strict';

const { getOrigin, normalizeRemoteUrl } = require('../common');
const { requestWithImpitRotating } = require('../../utils/bypass');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractMediaUrl,
    fetchText,
    normalizeEscapedText,
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
    const raw = normalizeEscapedText(value)
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
    const source = normalizeEscapedText(text);
    const patterns = [
        /currentSrc[^"']*["'](https?:\\?\/\\?\/[^"';\s<>]+)/i,
        /(?:stream_url|streamUrl|video_url|videoUrl|playlist|file|source|src)\s*[:=]\s*["'](https?:\\?\/\\?\/[^"'\s<>]+)["']/i,
        /(?:file|src)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
        /<source\b[^>]+src=["']([^"']+)["']/i,
        /data-(?:src|file|hls|url)=["']([^"']+\.m3u8[^"']*)["']/i
    ];

    for (const pattern of patterns) {
        const match = source.match(pattern);
        const normalized = cleanUrl(match?.[1], baseUrl);
        if (normalized) return normalized;
    }

    const generic = extractMediaUrl(source, patterns, baseUrl);
    if (generic) return generic;

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

    const escaped = normalizeEscapedText(source);
    const escapedStream = extractStreamUrlFromText(escaped, baseUrl);
    if (escapedStream) return escapedStream;

    for (const match of source.matchAll(/atob\(\s*['"]([A-Za-z0-9+/=]{24,})['"]\s*\)/ig)) {
        try {
            const decoded = Buffer.from(match[1], 'base64').toString('utf8');
            const streamUrl = extractStreamUrlFromText(decoded, baseUrl);
            if (streamUrl) return streamUrl;
        } catch (_) {}
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

async function bypassAndExtract(playerUrl, referer, options = {}) {
    if (typeof options.bypassExtractor === 'function') {
        const output = await options.bypassExtractor(playerUrl, referer, options).catch(() => null);
        if (typeof output === 'string') return normalizeRemoteUrl(output);
        if (output?.stream_url) return normalizeRemoteUrl(output.stream_url);
        if (output?.url) return normalizeRemoteUrl(output.url);
        return null;
    }

    const timeoutMs = Number.parseInt(options.bypassTimeoutMs || process.env.VIDXGO_IMPIT_TIMEOUT_MS || '12000', 10) || 12_000;
    const impitFetch = typeof options.impitFetcher === 'function'
        ? options.impitFetcher
        : requestWithImpitRotating;
    const headers = {
        'User-Agent': String(process.env.VIDXGO_IMPIT_USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-GPC': '1',
        'Alt-Used': 'v.vidxgo.co',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        DNT: '1',
        Referer: referer || 'https://vidxgo.example/',
        Priority: 'u=0, i'
    };

    const response = await impitFetch(playerUrl, {
        method: 'GET',
        headers,
        timeout: timeoutMs,
        totalTimeoutMs: timeoutMs + 1000,
        maxBrowserAttempts: Number.parseInt(process.env.VIDXGO_IMPIT_ATTEMPTS || '3', 10) || 3,
        browser: process.env.VIDXGO_IMPIT_BROWSER || 'firefox144',
        browserFallbacks: ['firefox144', 'chrome142'],
        retryOnStatuses: [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524],
        http3: /^(1|true|yes|on)$/i.test(String(process.env.VIDXGO_IMPIT_HTTP3 || '1')),
        failSoft: true
    }).catch(() => null);

    const html = typeof response?.body === 'string'
        ? response.body
        : typeof response?.data === 'string' ? response.data : '';
    return extractVidxgoStreamUrl(html, playerUrl);
}

async function extractVidxgo(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    if (!playerUrl || !isVidxgoUrl(playerUrl)) return null;

    const userAgent = String(options.userAgent || process.env.VIDXGO_USER_AGENT || DEFAULT_USER_AGENT);
    const referer = String(options.requestReferer || options.referer || options.pageUrl || process.env.VIDXGO_REFERER || 'https://vidxgo.example/');
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
    let streamUrl = extractVidxgoStreamUrl(html, playerUrl);
    if (!streamUrl) {
        streamUrl = await bypassAndExtract(playerUrl, referer, options);
    }
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
    extractVidxgoStreamUrl,
    isVidxgoUrl
};
