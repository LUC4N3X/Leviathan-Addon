'use strict';

const vm = require('vm');
const { normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractMediaUrl,
    fetchText,
    probeStreamQuality
} = require('./shared');

const VIDGUARD_RE = /(?:listeamed\.net|vidguard|vgfplay|vgembed)/i;
const DIRECT_PATTERNS = [
    /["']stream["']\s*:\s*["']([^"']+)["']/i,
    /["']file["']\s*:\s*["']([^"']+)["']/i,
    /["']url["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i
];

function isVidguardUrl(url) {
    return VIDGUARD_RE.test(String(url || ''));
}

function decodeSig(url) {
    const source = String(url || '');
    let parsed;
    try {
        parsed = new URL(source);
    } catch (_) {
        return source;
    }

    const sig = parsed.searchParams.get('sig');
    if (!sig) return source;

    try {
        const xored = String(sig).match(/.{1,2}/g)
            .map((chunk) => String.fromCharCode((Number.parseInt(chunk, 16) || 0) ^ 2))
            .join('');
        const padded = xored + (xored.length % 4 === 2 ? '==' : (xored.length % 4 === 3 ? '=' : ''));
        let decoded = Buffer.from(padded, 'base64').toString('utf8');
        decoded = decoded.slice(0, Math.max(0, decoded.length - 5));
        const chars = decoded.split('').reverse();
        for (let index = 0; index < chars.length; index += 2) {
            if (index + 1 < chars.length) {
                const tmp = chars[index];
                chars[index] = chars[index + 1];
                chars[index + 1] = tmp;
            }
        }
        const cleanSig = chars.join('').slice(0, Math.max(0, chars.length - 5));
        if (!cleanSig) return source;
        parsed.searchParams.set('sig', cleanSig);
        return parsed.toString();
    } catch (_) {
        return source;
    }
}

function runSandboxedScript(script) {
    if (!script || script.length > 250_000) return null;

    const context = {
        window: {},
        document: {},
        navigator: { userAgent: DEFAULT_USER_AGENT },
        location: { href: 'https://listeamed.net/' },
        atob: (value) => Buffer.from(String(value || ''), 'base64').toString('binary'),
        btoa: (value) => Buffer.from(String(value || ''), 'binary').toString('base64'),
        decodeURIComponent,
        encodeURIComponent,
        unescape,
        svg: undefined
    };
    context.window = context;

    try {
        vm.createContext(context);
        vm.runInContext(script, context, { timeout: 1200, displayErrors: false });
        const svg = context.svg || context.window?.svg;
        if (!svg) return null;
        if (typeof svg === 'string') return svg;
        return JSON.stringify(svg);
    } catch (_) {
        return null;
    }
}

function extractScriptCandidates(html) {
    const text = String(html || '');
    const scripts = [];
    for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        const body = String(match[1] || '').trim();
        if (!body) continue;
        if (/eval\s*\(|\bsvg\b|stream\s*:/i.test(body)) scripts.push(body);
    }
    return scripts.sort((a, b) => scoreScript(b) - scoreScript(a)).slice(0, 4);
}

function scoreScript(script) {
    const text = String(script || '').toLowerCase();
    let score = 0;
    if (text.includes('eval(')) score += 4;
    if (text.includes('svg')) score += 3;
    if (text.includes('stream')) score += 2;
    if (text.includes('sig=')) score += 2;
    if (text.includes('.m3u8')) score += 3;
    return score;
}

function normalizeVidguardStreamUrl(value, baseUrl) {
    const direct = normalizeRemoteUrl(value, baseUrl);
    if (!direct) return null;
    return decodeSig(direct);
}

async function extractVidguard(url, options = {}) {
    const playerUrl = normalizeRemoteUrl(url);
    const client = options?.client;
    if (!playerUrl || !isVidguardUrl(playerUrl) || !client || typeof client.get !== 'function') return null;

    const headers = buildRequestHeaders(playerUrl, {
        userAgent: options?.userAgent || DEFAULT_USER_AGENT,
        referer: options?.requestReferer || options?.referer || playerUrl,
        origin: 'https://listeamed.net'
    });

    const { status, text } = await fetchText(client, playerUrl, { headers, timeout: options?.timeout || 12_000 });
    if (status < 200 || status >= 400 || !text) return null;

    let streamUrl = extractMediaUrl(text, DIRECT_PATTERNS, playerUrl);
    if (!streamUrl) {
        for (const script of extractScriptCandidates(text)) {
            const decoded = runSandboxedScript(script);
            if (!decoded) continue;
            streamUrl = extractMediaUrl(decoded, DIRECT_PATTERNS, playerUrl);
            if (streamUrl) break;
        }
    }

    streamUrl = normalizeVidguardStreamUrl(streamUrl, playerUrl);
    if (!streamUrl) return null;

    const playbackHeaders = {
        Referer: playerUrl,
        Origin: 'https://listeamed.net',
        'User-Agent': headers['User-Agent']
    };
    const quality = await probeStreamQuality(client, streamUrl, {
        headers: playbackHeaders,
        timeout: options?.probeTimeout || 5000,
        fallback: 'Unknown'
    }) || 'Unknown';

    return {
        url: streamUrl,
        headers: playbackHeaders,
        extractor: 'VidGuard',
        name: 'VidGuard',
        quality,
        priority: 2
    };
}

module.exports = {
    extractVidguard,
    isVidguardUrl
};
