'use strict';

const mediaflowGateway = require('../../core/proxy/mediaflow_gateway');

const { prepareProxyTarget } = require('../../core/lib/proxy_header_normalizer');
const {
    decorateStreamWithPlaylistIntelligence,
    probePlaylistIntelligence
} = require('../utils/playlist_intelligence');

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

async function probePlaylistQuality(client, targetUrl, { headers = {}, timeout = 5000, signal = undefined } = {}) {
    try {
        const intelligence = await probePlaylistIntelligence(client, targetUrl, { headers, timeout, signal });
        return intelligence?.quality || null;
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
    mediaflowUrl = null,
    addonBase = null,
    notWebReady = false,
    extraBehaviorHints = {},
    extra = {}
}) {
    const extractorName = String(extractor || '').trim() || 'Web';
    const providerName = String(provider || '').trim() || 'Web';
    const qualityName = String(quality || '').trim() || 'Unknown';
    const headerSource = headers || extraBehaviorHints?.proxyHeaders?.request || extraBehaviorHints?.headers || {};
    const preparedProxy = prepareProxyTarget(url, headerSource, {
        provider: providerName,
        service: 'web',
        fillReferer: true,
        fillOrigin: true,
        forceIdentityEncoding: true,
        mediaflowUrl,
        addonBase
    });
    const finalUrl = preparedProxy.url || url;
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

    const shouldAttachProxyHeaders = preparedProxy.shouldProxy && preparedProxy.headerCount > 0;
    if (shouldAttachProxyHeaders) {
        behaviorHints.proxyHeaders = {
            ...(behaviorHints.proxyHeaders || {}),
            request: preparedProxy.headers
        };
        behaviorHints.headers = preparedProxy.headers;
    }
    if (preparedProxy.basicAuthMoved && preparedProxy.shouldProxy) {
        behaviorHints.proxyHeaderNormalizer = {
            ...(behaviorHints.proxyHeaderNormalizer || {}),
            basicAuthMoved: true
        };
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
        url: finalUrl,
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

function getMediaflowPassword(config = {}) {
    return String(
        config?.mediaflow?.pass
        || process.env.MEDIAFLOW_API_PASSWORD
        || process.env.MEDIAFLOW_PASS
        || process.env.MEDIAFLOW_PROXY_PASSWORD
        || process.env.MFP_API_PASSWORD
        || ''
    ).trim();
}

function normalizeExtractorPath(rawPath, fallback = '/extractor/video') {
    const raw = String(rawPath || fallback).trim();
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    return path.includes('/extractor/video') ? path : fallback;
}

function getMediaflowExtractorPath(host = '', options = {}) {
    const explicitPath = options?.extractorPath || '';
    if (explicitPath) return normalizeExtractorPath(explicitPath);

    const hostName = String(host || '').trim().toLowerCase();

    // MaxStream/UPROT still need the HLS-looking extractor URL for legacy
    // playback compatibility. TurboVid is intentionally excluded here because
    // it resolves to a direct MP4 and Stremio can get stuck if the URL path
    // advertises .m3u8 while the response is video/mp4.
    if (/maxstream|uprot/i.test(hostName)) {
        return normalizeExtractorPath('/extractor/video.m3u8');
    }

    if (/turbovid|turbovideo|turbovidplay|turboviplay/i.test(hostName)) {
        if (/^(?:1|true|yes|on)$/i.test(String(process.env.MEDIAFLOW_TURBOVID_ALLOW_M3U8_PATH || '').trim())) {
            return normalizeExtractorPath('/extractor/video.m3u8');
        }
        return normalizeExtractorPath(process.env.MEDIAFLOW_TURBOVID_EXTRACTOR_PATH || '/extractor/video');
    }

    const hlsHosts = String(process.env.MEDIAFLOW_EXTRACTOR_HLS_HOSTS || '').toLowerCase()
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const wantsHlsPath = hlsHosts.some((item) => hostName.includes(item));

    if (wantsHlsPath) {
        return normalizeExtractorPath(process.env.MEDIAFLOW_EXTRACTOR_HLS_PATH || '/extractor/video.m3u8');
    }

    return normalizeExtractorPath(process.env.MEDIAFLOW_EXTRACTOR_PATH || '/extractor/video');
}

function getMediaflowRedirectStream(host = '', options = {}) {
    if (options?.redirectStream !== undefined) {
        return options.redirectStream ? 'true' : 'false';
    }

    const hostName = String(host || '').trim().toLowerCase();

    // Hardcoded safety for Android/Stremio: MaxStream/UPROT should keep
    // redirect_stream=true by default. No docker env needed.
    if (/maxstream|uprot/i.test(hostName)) {
        return 'true';
    }

    const raw = String(process.env.MEDIAFLOW_REDIRECT_STREAM || 'true').trim().toLowerCase();
    return /^(?:1|true|yes|on)$/i.test(raw) ? 'true' : 'false';
}

function mediaflowHeaderParamName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return '';
    if (key === 'referer' || key === 'referrer') return 'h_referer';
    if (key === 'origin') return 'h_origin';
    if (key === 'user-agent' || key === 'useragent') return 'h_user-agent';
    if (key === 'cookie') return 'h_cookie';
    return `h_${key}`;
}

function appendQueryParam(parts, key, value) {
    if (value === undefined || value === null || value === '') return;
    parts.push(`${encodeURIComponent(String(key))}=${encodeURIComponent(String(value))}`);
}

function appendMediaflowExtractorOptions(parts, options = {}) {
    const headers = options?.headers || options?.requestHeaders || {};
    for (const [name, value] of Object.entries(headers)) {
        const paramName = mediaflowHeaderParamName(name);
        if (!paramName || value === undefined || value === null || value === '') continue;
        appendQueryParam(parts, paramName, value);
    }

    const extraParams = options?.extraParams || options?.params || {};
    for (const [name, value] of Object.entries(extraParams)) {
        if (!name || value === undefined || value === null || value === '') continue;
        appendQueryParam(parts, name, value);
    }
}

function buildMediaflowUrl(config, targetUrl, type = 'hls', host = 'Mixdrop', options = {}) {
    // Legacy provider builder restored for extractor playback compatibility.
    // This is the exact style used before the global Gateway refactor, with
    // optional h_* request headers for hosts that changed anti-hotlink rules.
    if (!config?.mediaflow?.url) return normalizeRemoteUrl(targetUrl);

    const normalizedTarget = normalizeRemoteUrl(targetUrl);
    if (!normalizedTarget) return null;

    const mfp = String(config.mediaflow.url).replace(/\/$/, '');
    const encoded = encodeURIComponent(normalizedTarget);
    const password = getMediaflowPassword(config);

    if (type === 'extractor') {
        const extractorPath = getMediaflowExtractorPath(host, options);
        const redirectStream = getMediaflowRedirectStream(host, options);
        const parts = [];
        appendQueryParam(parts, 'host', host);
        if (password) appendQueryParam(parts, 'api_password', password);
        appendQueryParam(parts, 'd', normalizedTarget);
        appendQueryParam(parts, 'redirect_stream', redirectStream);
        appendMediaflowExtractorOptions(parts, options);
        return `${mfp}${extractorPath}?${parts.join('&')}`;
    }

    const pass = password ? `&api_password=${encodeURIComponent(password)}` : '';
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
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence,
    qualityRank
};
