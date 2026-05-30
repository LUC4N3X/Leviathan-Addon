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
const DIRECT_MEDIA_RE = /(?:https?:\\?\/\\?\/|\/\/|\/)[^"'\s<>]+(?:\.m3u8|\.mp4|\/hls\/|\/playlist\/|\/master\.m3u8|\/get_video)[^"'\s<>]*/ig;
const BASE64_RE = /(?:atob\(\s*|["'=:,\[]\s*)["']([A-Za-z0-9+/=]{28,})["']/g;
const JSON_URL_RE = /["']?(?:file|src|source|sources|url|hls|playlist|video_url|videoUrl|stream_url|streamUrl|master|link)["']?\s*[:=]\s*["']([^"']+)["']/i;

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

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;|&#038;|&#38;/gi, '&')
        .replace(/&quot;|&#034;|&#34;/gi, '"')
        .replace(/&#039;|&#39;|&apos;/gi, "'")
        .replace(/&lt;|&#060;|&#60;/gi, '<')
        .replace(/&gt;|&#062;|&#62;/gi, '>')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            try { return String.fromCodePoint(Number.parseInt(hex, 16)); } catch (_) { return _; }
        })
        .replace(/&#(\d+);/g, (_, dec) => {
            try { return String.fromCodePoint(Number.parseInt(dec, 10)); } catch (_) { return _; }
        });
}

function normalizeEscapedText(value) {
    let out = decodeHtmlEntities(value);
    let previous = null;
    for (let index = 0; index < 5; index += 1) {
        if (out === previous) break;
        previous = out;
        out = out
            .replace(/\\u0026/gi, '&')
            .replace(/\\u003d/gi, '=')
            .replace(/\\u003f/gi, '?')
            .replace(/\\u003a/gi, ':')
            .replace(/\\u002f/gi, '/')
            .replace(/\\x26/gi, '&')
            .replace(/\\x3d/gi, '=')
            .replace(/\\x3f/gi, '?')
            .replace(/\\x3a/gi, ':')
            .replace(/\\x2f/gi, '/')
            .replace(/\\\//g, '/')
            .replace(/\\\\\//g, '/')
            .replace(/\u0000/g, '')
            .replace(/%(?:25)+/g, '%');
        try {
            const decoded = decodeURIComponent(out);
            if (decoded && decoded !== out && /(?:https?:|\.m3u8|\.mp4|\/hls\/|\/playlist\/)/i.test(decoded)) out = decoded;
        } catch (_) {}
    }
    return out;
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
        'Origin': finalOrigin,
        'DNT': '1'
    };
}

async function fetchText(client, targetUrl, { headers = {}, timeout = 10_000, method = 'GET' } = {}) {
    if (!client || typeof client.get !== 'function') {
        return { status: 0, text: '', response: null };
    }

    try {
        const requestOptions = {
            headers,
            timeout,
            responseType: 'text',
            maxRedirects: 5,
            validateStatus: () => true
        };
        const response = method === 'HEAD' && typeof client.head === 'function'
            ? await client.head(targetUrl, requestOptions)
            : await client.get(targetUrl, requestOptions);
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
        return normalizeEscapedText(unpacked);
    } catch (_) {
        return null;
    }
}

function cleanCandidateUrl(value, baseUrl = null) {
    const raw = normalizeEscapedText(value)
        .replace(/^['"`]+|['"`;,)\]}\s]+$/g, '')
        .trim();
    if (!raw || /^(?:javascript|data):/i.test(raw)) return null;
    return normalizeRemoteUrl(raw, baseUrl);
}

function expandSearchSpaces(searchSpace) {
    const input = String(searchSpace || '');
    const spaces = [];
    const push = (value) => {
        const text = normalizeEscapedText(value);
        if (!text || spaces.includes(text)) return;
        spaces.push(text);
    };

    push(input);
    push(unpackDeanEdwards(input));

    for (const match of input.matchAll(BASE64_RE)) {
        const token = match?.[1];
        if (!token || token.length > 20000) continue;
        try {
            const decoded = Buffer.from(token, 'base64').toString('utf8');
            if (/(?:https?:|\.m3u8|\.mp4|\/hls\/|\/playlist\/|file|source|src|url)/i.test(decoded)) push(decoded);
        } catch (_) {}
    }

    const escapedJsonStrings = input.match(/"(?:[^"\\]|\\.){20,}"/g) || [];
    for (const quoted of escapedJsonStrings.slice(0, 40)) {
        if (!/(?:https?|m3u8|mp4|hls|playlist|file|source|src|url)/i.test(quoted)) continue;
        try {
            const decoded = JSON.parse(quoted);
            if (typeof decoded === 'string') push(decoded);
        } catch (_) {}
    }

    return spaces;
}

function extractFirstUrl(searchSpace, patterns = [], baseUrl = null) {
    const spaces = expandSearchSpaces(searchSpace);
    for (const space of spaces) {
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            const match = String(space || '').match(pattern);
            if (!match) continue;
            const candidate = match[1] || match[0];
            const normalized = cleanCandidateUrl(candidate, baseUrl);
            if (normalized) return normalized;
        }
    }
    return null;
}

function extractMediaUrl(searchSpace, patterns = [], baseUrl = null) {
    const patterned = extractFirstUrl(searchSpace, patterns, baseUrl);
    if (patterned && /(?:\.m3u8|\.mp4|\/hls\/|\/playlist\/|\/master\.m3u8|\/get_video)/i.test(patterned)) return patterned;

    for (const space of expandSearchSpaces(searchSpace)) {
        const jsonCandidate = extractFirstUrl(space, [JSON_URL_RE], baseUrl);
        if (jsonCandidate && /(?:\.m3u8|\.mp4|\/hls\/|\/playlist\/|\/master\.m3u8|\/get_video)/i.test(jsonCandidate)) return jsonCandidate;

        DIRECT_MEDIA_RE.lastIndex = 0;
        const matches = [...String(space || '').matchAll(DIRECT_MEDIA_RE)];
        for (const match of matches) {
            const normalized = cleanCandidateUrl(match?.[0], baseUrl);
            if (normalized) return normalized;
        }
    }

    return patterned;
}

function combineQuality(baseQuality, values = []) {
    let current = baseQuality || 'Unknown';
    for (const value of values) {
        current = pickBetterQuality(value, current);
    }
    return current;
}

async function probeStreamQuality(client, streamUrl, { headers = {}, timeout = 5000, fallback = 'Unknown' } = {}) {
    const urlQuality = extractPlaylistQuality(streamUrl);
    if (!/\.m3u8($|\?)/i.test(String(streamUrl || ''))) return combineQuality(fallback, [urlQuality]);
    const probed = await probePlaylistQuality(client, streamUrl, { headers, timeout });
    return combineQuality(fallback, [urlQuality, probed]);
}

module.exports = {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    cleanCandidateUrl,
    combineQuality,
    decodeHtmlEntities,
    expandSearchSpaces,
    extractFirstUrl,
    extractMediaUrl,
    fetchText,
    normalizeEscapedText,
    probeStreamQuality,
    responseText,
    unpackDeanEdwards
};
