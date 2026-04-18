'use strict';

const QUALITY_PATTERNS = [
    { value: '4K', regex: /\b(?:4k|2160p|uhd)\b/i },
    { value: '1080p', regex: /\b(?:1080p|fullhd|fhd)\b/i },
    { value: '720p', regex: /\b(?:720p|hd)\b/i },
    { value: '480p', regex: /\b(?:480p|sd)\b/i }
];

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
    cleanHostLabel,
    buildWebStream,
    buildMediaflowUrl,
    dedupeStreamsByUrl
};
