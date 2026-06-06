'use strict';

const { getOrigin, normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractMediaUrl,
    fetchText,
    normalizeEscapedText,
    probeStreamQuality
} = require('./shared');

const DOOD_RE = /(?:^|\.)(?:dood(?:stream)?\.(?:com|to|watch|so|pm|wf|sh|la|ws|re|yt)|ds2play\.com|doodcdn\.(?:com|co)|d0o0d\.(?:com|to|watch|so|pm|wf|sh|la|ws|re|yt))/i;
const DOOD_ORIGIN_FALLBACKS = [
    'https://doodstream.com',
    'https://dood.to',
    'https://dood.watch',
    'https://dood.la',
    'https://dood.ws',
    'https://dood.pm',
    'https://ds2play.com'
];
const PASS_MD5_RE = /['"]([^'"\s<>]*\/pass_md5\/[^'"\s<>]+)['"]/i;
const TOKEN_RE = /(?:[?&]token=|token\s*[:=]\s*['"]?)([A-Za-z0-9_-]{8,})/i;
const DIRECT_PATTERNS = [
    /['"]file['"]\s*:\s*['"]([^'"]+)['"]/i,
    /['"]src['"]\s*:\s*['"]([^'"]+)['"]/i,
    /video\.src\s*=\s*['"]([^'"]+)['"]/i,
    /https?:\/\/[^'"\s<>]+(?:\.mp4|\.m3u8)[^'"\s<>]*/i
];

function isDoodstreamUrl(url) {
    try {
        const parsed = new URL(String(url || ''));
        return DOOD_RE.test(parsed.hostname);
    } catch (_) {
        return DOOD_RE.test(String(url || ''));
    }
}

function normalizeDoodUrl(url) {
    const playerUrl = normalizeRemoteUrl(url);
    if (!playerUrl) return null;
    try {
        const parsed = new URL(playerUrl);
        parsed.pathname = parsed.pathname
            .replace(/^\/d\//i, '/e/')
            .replace(/^\/download\//i, '/e/');
        return parsed.toString();
    } catch (_) {
        return playerUrl;
    }
}


function extractDoodId(url) {
    try {
        const parsed = new URL(normalizeDoodUrl(url));
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts[parts.length - 1] || null;
    } catch (_) {
        const match = String(url || '').match(/\/(?:d|e|embed|download)\/([A-Za-z0-9_-]{6,})/i);
        return match?.[1] || null;
    }
}

function uniqueList(values) {
    return [...new Set(values.filter(Boolean))];
}

function buildDoodPlayerCandidates(url) {
    const normalized = normalizeDoodUrl(url);
    const id = extractDoodId(normalized || url);
    const candidates = [normalized];
    if (id) {
        for (const origin of DOOD_ORIGIN_FALLBACKS) {
            candidates.push(`${origin.replace(/\/+$/, '')}/e/${id}`);
        }
    }
    return uniqueList(candidates);
}

function buildDoodPassCandidates(passUrl, playerUrl) {
    const normalizedPass = normalizeRemoteUrl(passUrl, playerUrl);
    const candidates = [normalizedPass];
    if (!normalizedPass) return uniqueList(candidates);
    let passPath = '';
    try { passPath = new URL(normalizedPass).pathname; } catch (_) {}
    if (passPath) {
        for (const origin of DOOD_ORIGIN_FALLBACKS) {
            candidates.push(`${origin.replace(/\/+$/, '')}${passPath}`);
        }
    }
    return uniqueList(candidates);
}

function randomTail(length = 10) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
}

function buildDoodPlaybackUrl(passText, html, passUrl) {
    const base = normalizeRemoteUrl(String(passText || '').trim(), passUrl);
    if (!base) return null;
    if (/(?:\.mp4|\.m3u8)(?:[?#].*)?$/i.test(base)) return base;

    const token = String(html || '').match(TOKEN_RE)?.[1]
        || String(passUrl || '').match(TOKEN_RE)?.[1]
        || null;
    if (!token) return base;

    const separator = base.includes('?') ? '&' : '?';
    return `${base}${randomTail()}${separator}token=${encodeURIComponent(token)}&expiry=${Date.now()}`;
}

function extractPassMd5Url(html, baseUrl) {
    const normalized = normalizeEscapedText(html);
    const match = normalized.match(PASS_MD5_RE) || normalized.match(/(\/pass_md5\/[^'"\s<>]+)/i);
    if (!match?.[1]) return null;
    return normalizeRemoteUrl(match[1], baseUrl);
}

async function extractDoodstream(url, options = {}) {
    const client = options?.client;
    const playerCandidates = buildDoodPlayerCandidates(url);
    if (!playerCandidates.length || !client || typeof client.get !== 'function') return null;

    let playerUrl = null;
    let headers = null;
    let text = '';

    for (const candidate of playerCandidates) {
        if (!candidate || !isDoodstreamUrl(candidate)) continue;
        const candidateHeaders = buildRequestHeaders(candidate, {
            userAgent: options?.userAgent || DEFAULT_USER_AGENT,
            referer: options?.requestReferer || options?.pageUrl || candidate
        });
        const response = await fetchText(client, candidate, {
            headers: candidateHeaders,
            timeout: Number(options?.timeout || 12_000)
        });
        if (response.status >= 200 && response.status < 400 && response.text) {
            playerUrl = candidate;
            headers = candidateHeaders;
            text = response.text;
            break;
        }
    }

    if (!playerUrl || !headers || !text) return null;

    let streamUrl = extractMediaUrl(text, DIRECT_PATTERNS, playerUrl);
    const passUrl = extractPassMd5Url(text, playerUrl);
    if (!streamUrl && passUrl) {
        const passCandidates = buildDoodPassCandidates(passUrl, playerUrl);
        for (const passCandidate of passCandidates) {
            if (!passCandidate) continue;
            const passHeaders = {
                ...headers,
                Referer: playerUrl,
                'X-Requested-With': 'XMLHttpRequest'
            };
            const pass = await fetchText(client, passCandidate, {
                headers: passHeaders,
                timeout: Number(options?.timeout || 12_000)
            });
            if (pass.status >= 200 && pass.status < 400 && pass.text) {
                streamUrl = buildDoodPlaybackUrl(pass.text, text, passCandidate);
                if (streamUrl) break;
            }
        }
    }

    streamUrl = normalizeRemoteUrl(streamUrl, playerUrl);
    if (!streamUrl) return null;

    const playbackHeaders = {
        Referer: playerUrl,
        Origin: getOrigin(playerUrl),
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
        extractor: 'DoodStream',
        name: 'DoodStream',
        quality,
        priority: 6,
        liveReady: true,
        transport: 'direct-doodstream'
    };
}

module.exports = {
    buildDoodPassCandidates,
    buildDoodPlaybackUrl,
    buildDoodPlayerCandidates,
    extractDoodId,
    extractDoodstream,
    extractPassMd5Url,
    isDoodstreamUrl,
    normalizeDoodUrl
};
