'use strict';

const { getOrigin, normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    fetchText,
    probeStreamQuality
} = require('./shared');

const VIXCLOUD_REGEX = /vixcloud/i;
const TOKEN_PATTERNS = [
    /["']token["']\s*:\s*["']([^"']+)["']/i,
    /\btoken\s*[:=]\s*["']([^"']+)["']/i,
    /[?&]token=([^&\s"']+)/i
];
const EXPIRES_PATTERNS = [
    /["']expires["']\s*:\s*["']?(\d+)["']?/i,
    /\bexpires\s*[:=]\s*["']?(\d+)["']?/i,
    /[?&]expires=(\d+)/i
];
const URL_PATTERNS = [
    /["']url["']\s*:\s*["']([^"']+)["']/i,
    /["']src["']\s*:\s*["']([^"']+)["']/i,
    /["']hls["']\s*:\s*["']([^"']+)["']/i,
    /["']file["']\s*:\s*["']([^"']+)["']/i,
    /\burl\s*:\s*["']([^"']+)["']/i
];
const FHD_RE = /(?:window\.)?canPlayFHD\s*[:=]\s*(?:true|!0|1)|["']canPlayFHD["']\s*:\s*true/i;
const B_FLAG_RE = /(?:[?&]|^)b=1(?:&|$)/i;

function isVixcloudUrl(url) {
    return VIXCLOUD_REGEX.test(String(url || ''));
}

function normalizeEscapedUrl(value) {
    let out = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    let previous = null;
    for (let index = 0; index < 4; index += 1) {
        if (out === previous) break;
        previous = out;
        out = out
            .replace(/&amp;/g, '&')
            .replace(/\\u002F/gi, '/')
            .replace(/\\u0026/gi, '&')
            .replace(/\\\//g, '/');
        out = out.replace(/^(https?):\/{3,}/i, '$1://');
        out = out.replace(/^(https?):\/([^/])/i, '$1://$2');
    }
    if (out.startsWith('//')) return `https:${out}`;
    return out;
}

function extractFirst(patterns, searchSpace) {
    for (const pattern of patterns) {
        const match = String(searchSpace || '').match(pattern);
        if (!match) continue;
        const value = normalizeEscapedUrl(match[1] || match[0]);
        if (value) return value;
    }
    return null;
}

function normalizeMediaBaseUrl(url) {
    const value = normalizeEscapedUrl(url);
    if (!value) return '';
    try {
        const parsed = new URL(value);
        parsed.search = '';
        parsed.hash = '';
        const output = parsed.toString();
        return output.endsWith('.m3u8') ? output : `${output}.m3u8`;
    } catch (_) {
        const clean = value.split('?')[0].split('#')[0];
        return clean.endsWith('.m3u8') ? clean : `${clean}.m3u8`;
    }
}

function buildMasterUrl(base, token, expires, forceFhd, hasBFlag) {
    const normalizedBase = normalizeMediaBaseUrl(base);
    if (!normalizedBase) return null;

    const parsed = new URL(normalizedBase);
    parsed.search = '';
    if (hasBFlag) parsed.searchParams.set('b', '1');
    parsed.searchParams.set('token', String(token));
    parsed.searchParams.set('expires', String(expires));
    if (forceFhd) parsed.searchParams.set('h', '1');
    return parsed.toString();
}

async function extractVixcloud(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    const client = options?.client;
    if (!playerUrl || !isVixcloudUrl(playerUrl) || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: options?.requestReferer || `${getOrigin(playerUrl)}/`
    });
    const { status, text } = await fetchText(client, playerUrl, { headers });
    if (status !== 200 || !text) return null;

    const token = extractFirst(TOKEN_PATTERNS, text);
    const expires = extractFirst(EXPIRES_PATTERNS, text);
    const mediaBase = extractFirst(URL_PATTERNS, text);
    if (!(token && expires && mediaBase)) return null;

    const streamUrl = buildMasterUrl(mediaBase, token, expires, FHD_RE.test(text), B_FLAG_RE.test(mediaBase));
    if (!streamUrl) return null;

    const playbackHeaders = {
        Referer: playerUrl,
        Origin: getOrigin(playerUrl),
        'User-Agent': headers['User-Agent']
    };
    const quality = await probeStreamQuality(client, streamUrl, {
        headers: playbackHeaders,
        fallback: 'Unknown'
    });

    return {
        url: streamUrl,
        headers: playbackHeaders,
        extractor: 'VixCloud',
        name: 'VixCloud',
        quality,
        priority: 1
    };
}

module.exports = {
    extractVixcloud,
    isVixcloudUrl
};
