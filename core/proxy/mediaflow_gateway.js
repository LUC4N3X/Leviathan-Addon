'use strict';

const { buildForwardProxyUrl } = require('./forward_proxy_config');

function envDebugFlag(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    return /^(?:1|true|yes|on)$/i.test(String(raw).trim());
}

function safeUrlPart(value, part = 'host') {
    try {
        const parsed = new URL(String(value || ''));
        return part === 'path' ? parsed.pathname : parsed.hostname;
    } catch (_) {
        return '';
    }
}

function mfpDebug(level, message, payload = null) {
    const normalizedLevel = String(level || 'info').toLowerCase();
    const enabled = envDebugFlag('MEDIAFLOW_DEBUG', false) || envDebugFlag('MFP_DEBUG', false) || envDebugFlag('CB01_DEBUG', false);
    const alwaysShow = /^(warn|error)$/i.test(normalizedLevel);
    if (!alwaysShow && !enabled) return;
    const logger = console[normalizedLevel] || console.info;
    if (payload && typeof payload === 'object') {
        try { logger(`[MFP:debug] ${message} ${JSON.stringify(payload)}`); }
        catch (_) { logger(`[MFP:debug] ${message}`); }
    } else {
        logger(`[MFP:debug] ${message}`);
    }
}
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

function trimBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function getMediaflowBase(config = {}) {
    return trimBaseUrl(
        config?.mediaflow?.url
        || config?.mfp?.url
        || config?.kraken?.url
        || process.env.MEDIAFLOW_URL
        || process.env.MEDIAFLOW_PROXY_URL
        || process.env.MFP_URL
        || process.env.MFP_BASE_URL
        || process.env.KRAKEN_URL
        || process.env.KRAKEN_BASE_URL
        || ''
    );
}

function getMediaflowPassword(config = {}) {
    return String(
        config?.mediaflow?.pass
        || config?.mfp?.pass
        || config?.kraken?.pass
        || process.env.MEDIAFLOW_API_PASSWORD
        || process.env.MEDIAFLOW_PASS
        || process.env.MEDIAFLOW_PROXY_PASSWORD
        || process.env.MFP_API_PASSWORD
        || process.env.KRAKEN_API_PASSWORD
        || process.env.KRAKEN_PASS
        || ''
    ).trim();
}

function normalizeExtractorPath(rawPath, fallback = '/extractor/video') {
    const raw = String(rawPath || fallback).trim();
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    return path.includes('/extractor/video') ? path : fallback;
}

function boolString(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback ? 'true' : 'false';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return /^(?:1|true|yes|on)$/i.test(String(value).trim()) ? 'true' : 'false';
}

function defaultExtractorPath(host = '', options = {}) {
    if (options?.extractorPath) return normalizeExtractorPath(options.extractorPath);

    const hostName = String(host || '').trim().toLowerCase();

    if (/maxstream|uprot/i.test(hostName)) {
        return normalizeExtractorPath(process.env.MEDIAFLOW_MAXSTREAM_EXTRACTOR_PATH || '/extractor/video.m3u8');
    }

    if (/turbovid|turbovideo|turbovidplay|turboviplay/i.test(hostName)) {
        return normalizeExtractorPath(process.env.MEDIAFLOW_TURBOVID_EXTRACTOR_PATH || '/extractor/video.m3u8');
    }

    if (/^(?:city|cccdn|cinemacity)$/i.test(hostName) || /cinemacity|cccdn|\bcity\b/i.test(hostName)) {
        return normalizeExtractorPath(
            process.env.MEDIAFLOW_CCCDN_EXTRACTOR_PATH
            || process.env.MEDIAFLOW_CITY_EXTRACTOR_PATH
            || process.env.MEDIAFLOW_CINEMACITY_EXTRACTOR_PATH
            || '/extractor/video.m3u8'
        );
    }

    const hlsHosts = String(process.env.MEDIAFLOW_EXTRACTOR_HLS_HOSTS || '').toLowerCase()
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    if (hlsHosts.some((item) => hostName.includes(item))) {
        return normalizeExtractorPath(process.env.MEDIAFLOW_EXTRACTOR_HLS_PATH || '/extractor/video.m3u8');
    }

    return normalizeExtractorPath(process.env.MEDIAFLOW_EXTRACTOR_PATH || '/extractor/video');
}

function defaultRedirectStream(host = '', options = {}) {
    if (options?.redirectStream !== undefined) return boolString(options.redirectStream, true);

    const hostName = String(host || '').trim().toLowerCase();
    if (/maxstream|uprot/i.test(hostName)) return 'true';

    return boolString(process.env.MEDIAFLOW_REDIRECT_STREAM || 'true', true);
}


function enc(value) {
    return encodeURIComponent(String(value ?? ''));
}

function appendParam(parts, key, value) {
    if (value === undefined || value === null || value === '') return;
    parts.push(`${enc(key)}=${enc(value)}`);
}

function addPassword(params, config = {}) {
    const pass = getMediaflowPassword(config);
    if (pass) params.set('api_password', pass);
}

function extractorHeaderParamName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return '';
    if (key === 'referer' || key === 'referrer') return 'h_referer';
    if (key === 'origin') return 'h_origin';
    if (key === 'user-agent' || key === 'useragent') return 'h_user-agent';
    if (key === 'cookie') return 'h_cookie';
    return `h_${key}`;
}

function appendExtractorExtras(parts, options = {}) {
    const headers = options?.headers || options?.requestHeaders || {};
    for (const [name, value] of Object.entries(headers)) {
        const paramName = extractorHeaderParamName(name);
        if (!paramName || value === undefined || value === null || value === '') continue;
        appendParam(parts, paramName, value);
    }

    const extraParams = options?.extraParams || options?.params || {};
    for (const [name, value] of Object.entries(extraParams)) {
        if (!name || value === undefined || value === null || value === '') continue;
        appendParam(parts, name, value);
    }
}

function buildExtractorUrl(config = {}, targetUrl, host = 'Mixdrop', options = {}) {
    const base = getMediaflowBase(config);
    const normalizedTarget = normalizeRemoteUrl(targetUrl);
    if (!base || !normalizedTarget) {
        mfpDebug('warn', 'extractor url skipped', {
            reason: !base ? 'missing_base' : 'invalid_target',
            host,
            targetHost: safeUrlPart(targetUrl),
            targetPath: safeUrlPart(targetUrl, 'path')
        });
        return normalizedTarget;
    }

    const parts = [];
    appendParam(parts, 'host', String(host || 'Mixdrop'));
    const pass = getMediaflowPassword(config);
    if (pass) appendParam(parts, 'api_password', pass);
    appendParam(parts, 'd', normalizedTarget);
    appendParam(parts, 'redirect_stream', defaultRedirectStream(host, options));
    appendExtractorExtras(parts, options);

    const path = defaultExtractorPath(host, options);
    const out = `${base}${path}?${parts.join('&')}`;
    mfpDebug('info', 'extractor url built', {
        host,
        targetHost: safeUrlPart(normalizedTarget),
        targetPath: safeUrlPart(normalizedTarget, 'path'),
        mfpHost: safeUrlPart(base),
        extractorPath: path,
        redirectStream: defaultRedirectStream(host, options),
        headerParams: parts.filter((part) => /^h_/i.test(decodeURIComponent(String(part).split('=')[0] || ''))).map((part) => decodeURIComponent(String(part).split('=')[0] || '')).slice(0, 12)
    });
    return out;
}

function buildHlsUrl(config = {}, targetUrl) {
    const base = getMediaflowBase(config);
    const normalizedTarget = normalizeRemoteUrl(targetUrl);
    if (!base || !normalizedTarget) return normalizedTarget;

    const params = new URLSearchParams();
    params.set('url', normalizedTarget);
    addPassword(params, config);
    params.set('ext', '.m3u8');
    return `${base}/hls?${params.toString()}`;
}

function proxyHeaderParamName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (key === 'referer' || key === 'referrer') return 'h_referer';
    if (key === 'origin') return 'h_origin';
    if (key === 'cookie') return 'h_cookie';
    if (key === 'user-agent' || key === 'useragent') return 'h_user-agent';
    return '';
}


function appendForwardExtras(params, config = {}, headers = {}, options = {}) {
    addPassword(params, config);

    const allowCookie = options.allowCookie === true;
    for (const [rawName, rawValue] of Object.entries(headers || {})) {
        const paramName = proxyHeaderParamName(rawName);
        if (!paramName || rawValue === undefined || rawValue === null || rawValue === '') continue;
        if (paramName === 'h_cookie' && !allowCookie) continue;
        params.set(paramName, String(rawValue));
    }

    const extraParams = options?.extraParams || options?.params || {};
    for (const [name, value] of Object.entries(extraParams)) {
        if (!name || value === undefined || value === null || value === '') continue;
        params.set(String(name), String(value));
    }
}

function buildForwardUrl(config = {}, targetUrl, headers = {}, options = {}) {
    const normalizedTarget = normalizeRemoteUrl(targetUrl);

    if (!normalizedTarget) {
        mfpDebug('warn', 'forward url skipped', { reason: 'invalid_target', targetHost: safeUrlPart(targetUrl), targetPath: safeUrlPart(targetUrl, 'path') });
        return normalizedTarget;
    }

    const params = new URLSearchParams();
    appendForwardExtras(params, config, headers, options);

    const urlParam = String(options?.urlParam || 'url').trim() || 'url';
    const forwardOptions = {
        context: 'mediaflow',
        params: Object.fromEntries(params.entries()),
        urlParam
    };
    if (Object.prototype.hasOwnProperty.call(options, 'forwardProxy')) {
        forwardOptions.base = options.forwardProxy;
    }
    const out = buildForwardProxyUrl(normalizedTarget, forwardOptions);

    mfpDebug('info', 'forward url built', {
        targetHost: safeUrlPart(normalizedTarget),
        targetPath: safeUrlPart(normalizedTarget, 'path'),
        forwardHost: safeUrlPart(out),
        forwardPath: safeUrlPart(out, 'path'),
        headerParams: [...params.keys()].filter((key) => /^h_/i.test(key))
    });
    return out;
}

function buildProxyUrl(config = {}, targetUrl, headers = {}, options = {}) {
    const base = getMediaflowBase(config);
    const normalizedTarget = normalizeRemoteUrl(targetUrl);
    if (!base || !normalizedTarget) {
        mfpDebug('warn', 'proxy url skipped', {
            reason: !base ? 'missing_base' : 'invalid_target',
            targetHost: safeUrlPart(targetUrl),
            targetPath: safeUrlPart(targetUrl, 'path'),
            isHls: Boolean(options?.isHls)
        });
        return normalizedTarget;
    }

    const params = new URLSearchParams();
    params.set('d', normalizedTarget);
    addPassword(params, config);

    const allowCookie = options.allowCookie !== false;
    for (const [rawName, rawValue] of Object.entries(headers || {})) {
        const paramName = proxyHeaderParamName(rawName);
        if (!paramName || rawValue === undefined || rawValue === null || rawValue === '') continue;
        if (paramName === 'h_cookie' && !allowCookie) continue;
        params.set(paramName, String(rawValue));
    }

    const extraParams = options?.extraParams || options?.params || {};
    for (const [name, value] of Object.entries(extraParams)) {
        if (!name || value === undefined || value === null || value === '') continue;
        params.set(String(name), String(value));
    }

    const path = options.isHls ? '/proxy/hls/manifest.m3u8' : '/proxy/stream';
    const out = `${base}${path}?${params.toString()}`;
    mfpDebug('info', 'proxy url built', {
        targetHost: safeUrlPart(normalizedTarget),
        targetPath: safeUrlPart(normalizedTarget, 'path'),
        mfpHost: safeUrlPart(base),
        proxyPath: path,
        isHls: Boolean(options?.isHls),
        allowCookie,
        inputHeaders: Object.keys(headers || {}),
        outputHeaderParams: [...params.keys()].filter((key) => /^h_/i.test(key))
    });
    return out;
}

function buildMediaflowUrl(config, targetUrl, type = 'hls', host = 'Mixdrop', options = {}) {
    if (type === 'extractor') return buildExtractorUrl(config, targetUrl, host, options);
    return buildHlsUrl(config, targetUrl);
}

function createMediaflowGateway(config = {}) {
    return {
        isConfigured: Boolean(getMediaflowBase(config)),
        baseUrl: getMediaflowBase(config),
        buildExtractorUrl: (targetUrl, host = 'Mixdrop', options = {}) => buildExtractorUrl(config, targetUrl, host, options),
        buildHlsUrl: (targetUrl) => buildHlsUrl(config, targetUrl),
        buildProxyUrl: (targetUrl, headers = {}, options = {}) => buildProxyUrl(config, targetUrl, headers, options),
        buildForwardUrl: (targetUrl, headers = {}, options = {}) => buildForwardUrl(config, targetUrl, headers, options),
        buildMediaflowUrl: (targetUrl, type = 'hls', host = 'Mixdrop', options = {}) => buildMediaflowUrl(config, targetUrl, type, host, options)
    };
}

module.exports = {
    buildExtractorUrl,
    buildHlsUrl,
    buildMediaflowUrl,
    buildProxyUrl,
    buildForwardUrl,
    createMediaflowGateway,
    defaultExtractorPath,
    defaultRedirectStream,
    getMediaflowBase,
    getMediaflowPassword,
    normalizeRemoteUrl
};
