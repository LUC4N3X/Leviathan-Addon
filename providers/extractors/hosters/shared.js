'use strict';

const {
    extractPlaylistQuality,
    getOrigin,
    normalizeRemoteUrl,
    pickBetterQuality,
    probePlaylistQuality
} = require('../common');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEAN_EDWARDS_RE = /eval\(function\(p,a,c,k,e,?[rd]?\).*?\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('(.*?)'\).*?\)\)/s;

function responseText(response) {
    if (!response) return '';
    if (typeof response.data === 'string') return response.data;
    if (Buffer.isBuffer(response.data)) return response.data.toString('utf8');
    if (response.data == null) return '';
    try {
        return JSON.stringify(response.data);
    } catch (_) {
        return String(response.data || '');
    }
}

function buildRequestHeaders(targetUrl, {
    userAgent = DEFAULT_USER_AGENT,
    referer = null,
    origin = null,
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
} = {}) {
    const targetOrigin = getOrigin(targetUrl, 'https://example.com');
    const finalReferer = referer || `${targetOrigin}/`;
    const finalOrigin = origin || getOrigin(finalReferer, targetOrigin) || targetOrigin;

    return {
        'User-Agent': userAgent,
        'Accept': accept,
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': finalReferer,
        'Origin': finalOrigin
    };
}

async function fetchText(client, targetUrl, { headers = {}, timeout = 10_000 } = {}) {
    if (!client || typeof client.get !== 'function') {
        return { status: 0, text: '', response: null };
    }

    try {
        const response = await client.get(targetUrl, {
            headers,
            timeout,
            responseType: 'text'
        });
        return {
            status: Number(response?.status ?? response?.statusCode ?? 0) || 0,
            text: responseText(response),
            response
        };
    } catch (_) {
        return { status: 0, text: '', response: null };
    }
}

function unpackDeanEdwards(html) {
    if (!html || typeof html !== 'string') return null;

    try {
        const packedMatch = html.match(DEAN_EDWARDS_RE);
        if (!packedMatch) return null;

        let [, payload, base, count, dictionary, separator] = packedMatch;
        base = Number.parseInt(base, 10);
        count = Number.parseInt(count, 10);
        dictionary = String(dictionary || '').split(separator || '|');

        const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const encode = (value) => {
            if (value === 0) return alphabet[0];
            let output = '';
            let current = value;
            while (current > 0) {
                output = alphabet[current % base] + output;
                current = Math.floor(current / base);
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

function extractFirstUrl(searchSpace, patterns, baseUrl = null) {
    for (const pattern of patterns) {
        const match = String(searchSpace || '').match(pattern);
        if (!match?.[1]) continue;
        const normalized = normalizeRemoteUrl(match[1], baseUrl);
        if (normalized) return normalized;
    }
    return null;
}

function combineQuality(baseQuality, values = []) {
    let current = baseQuality || 'Unknown';
    for (const value of values) {
        current = pickBetterQuality(value, current);
    }
    return current;
}

async function probeStreamQuality(client, streamUrl, { headers = {}, timeout = 5000, fallback = 'Unknown' } = {}) {
    if (!/\.m3u8($|\?)/i.test(String(streamUrl || ''))) return fallback;
    const probed = await probePlaylistQuality(client, streamUrl, { headers, timeout });
    return combineQuality(fallback, [probed || extractPlaylistQuality(streamUrl)]);
}

module.exports = {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    combineQuality,
    extractFirstUrl,
    fetchText,
    probeStreamQuality,
    responseText,
    unpackDeanEdwards
};
