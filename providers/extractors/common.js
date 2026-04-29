'use strict';

const QUALITY_PATTERNS = [
    { value: '4K', regex: /\b(?:4k|2160p|uhd)\b/i },
    { value: '1440p', regex: /\b(?:1440p|2k|qhd)\b/i },
    { value: '1080p', regex: /\b(?:1080p|fullhd|fhd)\b/i },
    { value: '720p', regex: /\b(?:720p|hd)\b/i },
    { value: '576p', regex: /\b576p\b/i },
    { value: '480p', regex: /\b(?:480p|sd)\b/i },
    { value: '360p', regex: /\b360p\b/i },
    { value: '240p', regex: /\b240p\b/i }
];

const PLAYLIST_RESOLUTION_RE = /RESOLUTION=\d+x(\d+)/ig;
const PLAYLIST_NAME_HEIGHT_RE = /NAME\s*=\s*"?(?:.*?)(\d{3,4})p/ig;

const QUALITY_RANK = {
    Unknown: 0,
    '240p': 240,
    '360p': 360,
    '480p': 480,
    '576p': 576,
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '4K': 2160
};

function normalizeRemoteUrl(rawUrl, baseUrl = null) {
    let value = String(rawUrl || '').trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!value || value.startsWith('data:')) return null;

    try {
        if (value.startsWith('//')) return `https:${value}`;
        if (/^https?:\/\//i.test(value)) return new URL(value).toString();
        if (baseUrl) return new URL(value, baseUrl).toString();
    } catch (_) {
        return null;
    }

    return null;
}

function getOrigin(url, fallback = '') {
    try {
        return new URL(String(url || '')).origin;
    } catch (_) {
        return String(fallback || '').replace(/\/$/, '');
    }
}

function detectStreamQuality(value, fallback = 'Unknown') {
    const text = String(value || '');
    for (const pattern of QUALITY_PATTERNS) {
        if (pattern.regex.test(text)) return pattern.value;
    }
    return fallback;
}

function extractSizeText(value) {
    const match = String(value || '').match(/([\d.,]+\s?(?:KB|MB|GB|TB))/i);
    if (!match?.[1]) return 'N/A';
    return match[1].replace(/\s+/g, ' ').toUpperCase();
}

function normalizeQuality(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || ['all', 'auto', 'unknown', 'unknow'].includes(raw)) return 'Unknown';
    if (['4k', '2160p', '2160', 'uhd'].includes(raw)) return '4K';
    if (['1440p', '1440', '2k', 'qhd'].includes(raw)) return '1440p';
    if (['1080p', '1080', 'fhd', 'fullhd'].includes(raw)) return '1080p';
    if (['720p', '720', 'hd'].includes(raw)) return '720p';
    if (['576p', '576'].includes(raw)) return '576p';
    if (['480p', '480', 'sd'].includes(raw)) return '480p';
    if (['360p', '360'].includes(raw)) return '360p';
    if (['240p', '240'].includes(raw)) return '240p';

    const detected = detectStreamQuality(raw, 'Unknown');
    return detected === 'Unknown' ? String(value || 'Unknown') : detected;
}

function qualityRank(value) {
    return QUALITY_RANK[normalizeQuality(value)] || 0;
}

function pickBetterQuality(first, second) {
    const normalizedFirst = normalizeQuality(first);
    const normalizedSecond = normalizeQuality(second);
    return qualityRank(normalizedFirst) >= qualityRank(normalizedSecond)
        ? normalizedFirst
        : normalizedSecond;
}

function extractPlaylistQuality(value) {
    const text = String(value || '');
    const heights = [];

    for (const match of text.matchAll(PLAYLIST_RESOLUTION_RE)) {
        heights.push(Number(match[1]));
    }

    if (heights.length === 0) {
        for (const match of text.matchAll(PLAYLIST_NAME_HEIGHT_RE)) {
            heights.push(Number(match[1]));
        }
    }

    if (heights.length === 0) return detectStreamQuality(text, 'Unknown');

    const top = Math.max(...heights.filter(Number.isFinite));
    if (top >= 2160) return '4K';
    if (top >= 1440) return '1440p';
    if (top >= 1080) return '1080p';
    if (top >= 720) return '720p';
    if (top >= 576) return '576p';
    if (top >= 480) return '480p';
    if (top >= 360) return '360p';
    if (top >= 240) return '240p';
    return 'Unknown';
}

async function probePlaylistQuality(client, targetUrl, { headers = {}, timeout = 5000 } = {}) {
    if (!client || typeof client.get !== 'function') return null;
    if (!/\.m3u8($|\?)/i.test(String(targetUrl || ''))) return null;

    try {
        const response = await client.get(targetUrl, {
            headers,
            timeout,
            responseType: 'text'
        });
        const body = typeof response?.data === 'string'
            ? response.data
            : Buffer.isBuffer(response?.data)
                ? response.data.toString('utf8')
                : String(response?.data || '');
        return extractPlaylistQuality(body);
    } catch (_) {
        return null;
    }
}

function cleanHostLabel(rawUrl) {
    try {
        const host = new URL(String(rawUrl || '')).hostname.replace(/^www\./i, '').toLowerCase();
        if (!host) return '';
        const first = host.split('.')[0] || host;
        return first.charAt(0).toUpperCase() + first.slice(1);
    } catch (_) {
        return '';
    }
}

function buildWebStream({
    name,
    title,
    url,
    extractor,
    provider,
    providerCode,
    quality = 'Unknown',
    headers = null,
    notWebReady = false,
    extraBehaviorHints = {},
    extra = {}
}) {
    const extractorName = String(extractor || '').trim() || 'Web';
    const providerName = String(provider || '').trim() || 'Web';
    const qualityName = String(quality || '').trim() || 'Unknown';
    const behaviorHints = {
        notWebReady,
        extractor: extractorName,
        vortexExtractor: extractorName,
        vortexSource: providerName,
        vortexProviderCode: providerCode || providerName,
        vortexMeta: {
            extractor: extractorName,
            provider: providerName,
            source: providerName,
            site: providerName,
            providerCode: providerCode || providerName,
            quality: qualityName
        },
        ...extraBehaviorHints
    };

    if (headers && Object.keys(headers).length > 0) {
        behaviorHints.proxyHeaders = { request: headers };
    }

    if (extraBehaviorHints?.vortexMeta) {
        behaviorHints.vortexMeta = {
            ...behaviorHints.vortexMeta,
            ...extraBehaviorHints.vortexMeta
        };
    }

    return {
        name,
        title,
        url,
        extractor: extractorName,
        provider: providerName,
        source: providerName,
        site: providerName,
        host: extractorName,
        quality: qualityName,
        behaviorHints,
        ...extra
    };
}

function buildMediaflowUrl(config, targetUrl, type = 'hls', host = 'Mixdrop') {
    if (!config?.mediaflow?.url) return normalizeRemoteUrl(targetUrl);

    const normalizedTarget = normalizeRemoteUrl(targetUrl);
    if (!normalizedTarget) return null;

    const mfp = String(config.mediaflow.url).replace(/\/$/, '');
    const encoded = encodeURIComponent(normalizedTarget);
    const pass = config.mediaflow.pass ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';

    if (type === 'extractor') {
        return `${mfp}/extractor/video?host=${encodeURIComponent(host)}${pass}&d=${encoded}&redirect_stream=true`;
    }

    return `${mfp}/hls?url=${encoded}${pass}&ext=.m3u8`;
}

function dedupeStreamsByUrl(streams = []) {
    const out = [];
    const seen = new Set();

    for (const stream of streams) {
        const url = String(stream?.url || '').trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push(stream);
    }

    return out;
}

module.exports = {
    normalizeRemoteUrl,
    getOrigin,
    detectStreamQuality,
    extractSizeText,
    extractPlaylistQuality,
    cleanHostLabel,
    buildWebStream,
    buildMediaflowUrl,
    dedupeStreamsByUrl,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistQuality,
    qualityRank
};
