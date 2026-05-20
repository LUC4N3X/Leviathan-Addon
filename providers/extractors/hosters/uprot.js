'use strict';

const fs = require('fs');
const path = require('path');

let axios = null;
try { axios = require('axios'); } catch (_) { axios = null; }
const { getOrigin, normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractFirstUrl,
    fetchText,
    probeStreamQuality,
    responseText
} = require('./shared');

const UPROT_HOST_RE = /(?:^|\.)uprot\.net$/i;
const UPROT_URL_RE = /^https?:\/\/(?:www\.)?uprot\.net\//i;
const SOURCE_PATTERNS = [
    /sources\s*:\s*\[\s*\{\s*(?:src|file)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /(?:src|file)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i
];
const WATCHFREE_URL_RE = /(https?:\/\/[^"'<>\s]+\/watchfree\/[^"'<>\s]+)/i;
const PLAYER_LINK_PATTERNS = [
    /href=["']([^"']*(?:watchfree|maxstream|stayonline)[^"']*)["']/i,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']*(?:watchfree|maxstream|stayonline)[^"']*)["']/i,
    /data-(?:url|href)=["']([^"']*(?:watchfree|maxstream|stayonline)[^"']*)["']/i,
    WATCHFREE_URL_RE
];

function uprotDebug(level, message, payload = null) {
    const enabled = envFlag('UPROT_DEBUG', envFlag('EUROSTREAMING_DEBUG', true));
    if (!enabled) return;
    const logger = console[level] || console.info;
    const prefix = '[UPROT:debug]';
    if (payload && typeof payload === 'object') {
        logger(`${prefix} ${message} ${JSON.stringify(payload)}`);
    } else {
        logger(`${prefix} ${message}`);
    }
}

function safeHost(value) {
    try { return new URL(String(value || '')).hostname; } catch (_) { return ''; }
}


function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === '') return fallback;
    return !/^(?:0|false|no|off)$/i.test(String(value).trim());
}

function envNumber(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const value = Number.parseInt(String(process.env[name] ?? ''), 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function normalizeFlareEndpoint(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    } catch (_) {
        return null;
    }
    return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

function getFlareEndpoint(options = {}) {
    return normalizeFlareEndpoint(
        options.uprotFlareEndpoint
        || process.env.UPROT_FLARESOLVERR_URL
        || process.env.FLARESOLVERR_URL
        || ''
    );
}

function flareEnabled(options = {}) {
    if (options.uprotFlareEnabled !== undefined) return Boolean(options.uprotFlareEnabled);
    return envFlag('UPROT_FLARE_ENABLED', envFlag('EUROSTREAMING_UPROT_FLARE_ENABLED', false));
}

function getFlareClient(options = {}) {
    if (options.flareClient && typeof options.flareClient.post === 'function') return options.flareClient;
    if (options.axios && typeof options.axios.post === 'function') return options.axios;
    return axios;
}

function extractFlareSolution(response) {
    const payload = response?.data || response || {};
    if (payload?.status && String(payload.status).toLowerCase() !== 'ok') return null;
    const solution = payload.solution || {};
    const text = solution.response || payload.response || '';
    const finalUrl = normalizeRemoteUrl(solution.url || payload.url || '');
    const userAgent = solution.userAgent || payload.userAgent || null;
    const cookies = Array.isArray(solution.cookies || payload.cookies)
        ? (solution.cookies || payload.cookies)
            .map((cookie) => cookie?.name ? `${cookie.name}=${cookie.value ?? ''}` : '')
            .filter(Boolean)
            .join('; ')
        : String(solution.cookies || payload.cookies || '').trim();
    return {
        status: Number(solution.status || payload.statusCode || response?.status || 0) || 0,
        text: typeof text === 'string' ? text : '',
        finalUrl,
        userAgent,
        cookies
    };
}

async function fetchWithFlareSolverr(targetUrl, options = {}) {
    const endpoint = getFlareEndpoint(options);
    if (!flareEnabled(options) || !endpoint) return null;

    const client = getFlareClient(options);
    if (!client || typeof client.post !== 'function') return null;
    const timeout = envNumber('UPROT_FLARE_TIMEOUT_MS', Number(options.uprotFlareTimeoutMs || 25_000), 8_000, 60_000);
    const maxTimeout = envNumber('UPROT_FLARE_MAX_TIMEOUT_MS', Number(options.uprotFlareMaxTimeoutMs || timeout), 8_000, 90_000);
    const waitInSeconds = envNumber('UPROT_FLARE_WAIT_SECONDS', Number(options.uprotFlareWaitSeconds || 2), 0, 15);

    try {
        const payload = {
            cmd: 'request.get',
            url: targetUrl,
            maxTimeout,
            returnOnlyCookies: false
        };
        if (waitInSeconds) payload.waitInSeconds = waitInSeconds;

        const response = await client.post(endpoint, payload, {
            timeout: maxTimeout + 7_000,
            validateStatus: () => true
        });
        const status = Number(response?.status || 0);
        if (status && status >= 400) return null;
        return extractFlareSolution(response);
    } catch (_) {
        return null;
    }
}

function isUprotUrl(url) {
    const value = String(url || '');
    try {
        return UPROT_HOST_RE.test(new URL(value).hostname);
    } catch (_) {
        return UPROT_URL_RE.test(value);
    }
}

function normalizeUprotInput(url) {
    const normalized = normalizeRemoteUrl(url);
    if (!normalized || !isUprotUrl(normalized)) return null;
    return normalized.replace(/\/msf\//i, '/mse/');
}

function isMsfiUrl(url) {
    try {
        return /\/msfi\//i.test(new URL(String(url || '')).pathname);
    } catch (_) {
        return /\/msfi\//i.test(String(url || ''));
    }
}

function toMsfCaptchaUrl(url) {
    const normalized = normalizeRemoteUrl(url);
    if (!normalized || !isUprotUrl(normalized)) return null;
    try {
        const parsed = new URL(normalized);
        parsed.pathname = parsed.pathname.replace(/\/(?:mse|msfi)\//i, '/msf/');
        return parsed.toString();
    } catch (_) {
        return normalized.replace(/\/(?:mse|msfi)\//i, '/msf/');
    }
}

function parseLooseObjectText(value) {
    const text = String(value || '').trim();
    if (!text) return null;

    // MammaMia stores uprot.txt as Python dict strings, for example:
    // {'xfss': 'cookie-value'} and {'captcha': '12345'}. Accept that form too.
    const normalized = text
        .replace(/^export\s+[^=]+=\s*/i, '')
        .replace(/^[A-Z0-9_]+=\s*/i, '')
        .replace(/'/g, '"');
    try {
        const parsed = JSON.parse(normalized);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function parseFormLikeObject(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const out = {};
    const append = (key, val) => {
        if (!key) return;
        out[String(key).trim()] = String(val ?? '').trim();
    };

    if (/^[^=;&]+=[^;&]*(?:[;&]\s*[^=;&]+=[^;&]*)*$/.test(text)) {
        const params = new URLSearchParams(text.replace(/;\s*/g, '&'));
        for (const [key, val] of params.entries()) append(key, val);
    } else {
        for (const match of text.matchAll(/([A-Za-z0-9_.-]+)\s*[:=]\s*["']?([^,"';&}\s]+)["']?/g)) {
            append(match[1], match[2]);
        }
    }

    return Object.keys(out).length ? out : null;
}

function parseObjectLike(value) {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    return parseLooseObjectText(value) || parseFormLikeObject(value);
}

function parseUprotTxtState(text) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (!lines.length) return null;

    const cookies = parseCookieState(lines[0]);
    const captchaData = parseObjectLike(lines[1]);
    if (!cookies && !captchaData) return null;
    return { cookies, captchaData };
}

function loadUprotStateFromFile(options = {}) {
    const candidates = [
        options.uprotStateFile,
        process.env.UPROT_STATE_FILE,
        path.join(__dirname, 'uprot.txt'),
        path.join(__dirname, '..', 'uprot.txt')
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            const filePath = path.resolve(String(candidate));
            if (!fs.existsSync(filePath)) continue;
            const parsed = parseUprotTxtState(fs.readFileSync(filePath, 'utf8'));
            if (parsed) return { ...parsed, source: filePath };
        } catch (_) {
            
        }
    }
    return null;
}

function parseCookieState(value) {
    if (!value) return null;
    const objectValue = parseObjectLike(value);
    if (objectValue) return objectValue;
    const text = String(value || '').trim();
    return text || null;
}

function loadUprotState(options = {}) {
    const state = parseObjectLike(options.uprotState || process.env.UPROT_STATE_JSON);
    const fileState = loadUprotStateFromFile(options);
    const cookies = parseCookieState(
        options.uprotCookies
        || state?.cookies
        || state?.cookie
        || process.env.UPROT_COOKIES_JSON
        || process.env.UPROT_COOKIES
        || process.env.UPROT_COOKIE_HEADER
        || fileState?.cookies
    );
    const captchaValue = options.uprotCaptcha || process.env.UPROT_CAPTCHA;
    const captchaData = parseObjectLike(
        options.uprotCaptchaData
        || state?.data
        || state?.captchaData
        || state?.captcha
        || process.env.UPROT_CAPTCHA_DATA
        || process.env.UPROT_CAPTCHA_DATA_JSON
        || fileState?.captchaData
    ) || (captchaValue ? { captcha: String(captchaValue) } : null);

    return { cookies, captchaData, source: state ? 'env:UPROT_STATE_JSON' : fileState?.source || 'env' };
}

function hasUprotState(options = {}) {
    const { cookies, captchaData } = loadUprotState(options);
    return Boolean(cookieHeaderFromState(cookies) && buildFormBody(captchaData));
}

function cookieHeaderFromState(cookies) {
    if (!cookies) return '';
    if (typeof cookies === 'string') return cookies.trim();
    return Object.entries(cookies)
        .filter(([key, value]) => key && value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
}

function buildFormBody(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;

    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        if (!key || value === undefined || value === null) continue;
        form.set(key, String(value));
    }
    return form.toString();
}

function stripTags(value) {
    return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractContinueLink(html, baseUrl) {
    const text = String(html || '');
    const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig;
    for (const match of text.matchAll(anchorRe)) {
        const label = stripTags(match?.[2]);
        if (!/continue|c\s*o\s*n\s*t\s*i\s*n\s*u\s*e/i.test(label)) continue;
        const href = normalizeRemoteUrl(match?.[1], baseUrl);
        if (href) return href;
    }
    return null;
}

function extractWatchfreeCode(url) {
    const normalized = normalizeRemoteUrl(url);
    if (!normalized) return null;

    try {
        const parts = new URL(normalized).pathname.split('/').filter(Boolean);
        const watchfreeIndex = parts.findIndex((part) => /^watchfree$/i.test(part));
        if (watchfreeIndex < 0) return null;
        return parts[watchfreeIndex + 2] || parts[watchfreeIndex + 1] || null;
    } catch (_) {
        return null;
    }
}

function toMaxstreamPlayerUrl(url) {
    const normalized = normalizeRemoteUrl(url);
    if (!normalized) return null;

    try {
        const parsed = new URL(normalized);
        const isMaxstreamHost = /(?:^|\.)(?:maxstream\.video|stayonline\.pro)$/i.test(parsed.hostname);
        if (isMaxstreamHost && /\/em[^/]*\//i.test(parsed.pathname)) return normalized;

        const code = extractWatchfreeCode(normalized);
        if (code) return `https://maxstream.video/emvvv/${code}`;

        return isMaxstreamHost ? normalized : null;
    } catch (_) {
        return null;
    }
}

function responseFinalUrl(response, fallbackUrl = null) {
    const candidate = response?.request?.res?.responseUrl
        || response?.request?._redirectable?._currentUrl
        || response?.url
        || response?.headers?.location;
    return normalizeRemoteUrl(candidate, fallbackUrl) || fallbackUrl;
}

async function postText(client, targetUrl, body, headers, timeout) {
    if (!client || typeof client.post !== 'function') return { status: 0, text: '', response: null, error: 'missing_post_client' };
    try {
        const response = await client.post(targetUrl, body, {
            headers,
            timeout,
            responseType: 'text',
            maxRedirects: 5,
            validateStatus: () => true
        });
        return {
            status: Number(response?.status ?? response?.statusCode ?? 0) || 0,
            text: responseText(response),
            response,
            finalUrl: responseFinalUrl(response, targetUrl)
        };
    } catch (error) {
        return {
            status: Number(error?.response?.status ?? 0) || 0,
            text: responseText(error?.response),
            response: error?.response || null,
            finalUrl: responseFinalUrl(error?.response, targetUrl),
            error: error?.message || String(error)
        };
    }
}

async function headFinalUrl(client, targetUrl, headers, timeout) {
    if (!client || typeof client.head !== 'function') return null;
    try {
        const response = await client.head(targetUrl, {
            headers,
            timeout,
            maxRedirects: 5
        });
        return responseFinalUrl(response, targetUrl);
    } catch (error) {
        return responseFinalUrl(error?.response, targetUrl);
    }
}

async function getFinalUrl(client, targetUrl, headers, timeout) {
    if (!client || typeof client.get !== 'function') return null;
    try {
        const response = await client.get(targetUrl, {
            headers: { ...headers, Range: 'bytes=0-0' },
            timeout,
            maxRedirects: 5,
            validateStatus: () => true
        });
        return responseFinalUrl(response, targetUrl);
    } catch (error) {
        return responseFinalUrl(error?.response, targetUrl);
    }
}

async function followContinueLink(client, continueUrl, options = {}) {
    const normalized = normalizeRemoteUrl(continueUrl, options.sourceUrl || null);
    if (!normalized) return null;

    let current = normalized;
    const userAgent = options.userAgent || DEFAULT_USER_AGENT;
    const maxHops = Math.max(1, Number(options.uprotRedirectHops || 10));
    for (let attempt = 0; attempt < maxHops; attempt += 1) {
        if (/(?:maxstream\.video|stayonline\.pro)/i.test(current)) {
            const playerUrl = toMaxstreamPlayerUrl(current);
            if (playerUrl) return playerUrl;
        }

        const headers = buildRequestHeaders(current, {
            userAgent,
            referer: options.sourceUrl || options.requestReferer || options.referer || 'https://uprot.net/'
        });
        let redirected = await headFinalUrl(client, current, headers, Number(options.headTimeout || 10_000));
        let playerUrl = toMaxstreamPlayerUrl(redirected);
        if (playerUrl) return playerUrl;

        if (!redirected || redirected === current) {
            redirected = await getFinalUrl(client, current, headers, Number(options.headTimeout || 10_000));
            playerUrl = toMaxstreamPlayerUrl(redirected);
            if (playerUrl) return playerUrl;
        }

        playerUrl = toMaxstreamPlayerUrl(current);
        if (playerUrl) return playerUrl;
        if (!redirected || redirected === current) break;
        current = redirected;
    }

    return toMaxstreamPlayerUrl(current);
}

function buildUprotHeaders(targetUrl, options = {}) {
    const userAgent = options.userAgent || DEFAULT_USER_AGENT;
    return buildRequestHeaders(targetUrl, {
        userAgent,
        referer: options.referer || options.requestReferer || targetUrl,
        origin: getOrigin(targetUrl, 'https://uprot.net'),
        accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
}

async function resolveMsfi(client, targetUrl, options = {}) {
    const { cookies, captchaData, source } = loadUprotState(options);
    const cookieHeader = cookieHeaderFromState(cookies);
    const body = buildFormBody(captchaData);
    if (!cookieHeader || !body) {
        uprotDebug('warn', 'msfi state missing', { targetHost: safeHost(targetUrl), hasCookies: Boolean(cookieHeader), hasCaptchaData: Boolean(body) });
        return null;
    }

    const headers = {
        ...buildUprotHeaders(targetUrl, options),
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader
    };
    uprotDebug('info', 'msfi post start', { targetHost: safeHost(targetUrl), stateSource: source, cookieKeys: typeof cookies === 'object' ? Object.keys(cookies).length : 'header', formKeys: typeof captchaData === 'object' ? Object.keys(captchaData) : 'raw' });
    const posted = await postText(client, targetUrl, body, headers, Number(options.postTimeout || 12_000));
    const finalPlayerFromRedirect = toMaxstreamPlayerUrl(posted.finalUrl);
    if (finalPlayerFromRedirect) {
        uprotDebug('info', 'msfi post redirected to player', { status: posted.status, finalHost: safeHost(posted.finalUrl) });
        return { playerUrl: finalPlayerFromRedirect, sourceUrl: targetUrl, via: 'uprot-msfi-redirect' };
    }
    if (posted.status < 200 || posted.status >= 400 || !posted.text) {
        uprotDebug('warn', 'msfi post failed', { status: posted.status, finalHost: safeHost(posted.finalUrl), hasText: Boolean(posted.text), error: posted.error || null });
        return null;
    }

    const continueUrl = extractContinueLink(posted.text, targetUrl);
    const fallbackUrl = extractFirstUrl(posted.text, PLAYER_LINK_PATTERNS, targetUrl);
    const playerUrl = continueUrl
        ? await followContinueLink(client, continueUrl, { ...options, sourceUrl: targetUrl })
        : toMaxstreamPlayerUrl(fallbackUrl);
    if (!playerUrl) {
        uprotDebug('warn', 'msfi player not found', { status: posted.status, hasContinue: Boolean(continueUrl), fallbackHost: safeHost(fallbackUrl), bytes: String(posted.text || '').length });
        return null;
    }

    uprotDebug('info', 'msfi resolved player', { playerHost: safeHost(playerUrl), viaContinue: Boolean(continueUrl) });
    return {
        playerUrl,
        sourceUrl: targetUrl,
        via: 'uprot-msfi'
    };
}

async function parseUprotLandingText(client, targetUrl, text, options = {}, via = 'uprot-landing') {
    if (!text) return null;

    const directStream = extractFirstUrl(text, SOURCE_PATTERNS, targetUrl);
    if (directStream) {
        return {
            streamUrl: directStream,
            playerUrl: targetUrl,
            sourceUrl: targetUrl,
            via: via === 'uprot-flare' ? 'uprot-flare-direct' : 'uprot-direct'
        };
    }

    const continueUrl = extractContinueLink(text, targetUrl);
    const fallbackUrl = extractFirstUrl(text, PLAYER_LINK_PATTERNS, targetUrl);
    const playerUrl = continueUrl
        ? await followContinueLink(client, continueUrl, { ...options, sourceUrl: targetUrl })
        : toMaxstreamPlayerUrl(fallbackUrl);
    if (!playerUrl) return null;

    return {
        playerUrl,
        sourceUrl: targetUrl,
        via
    };
}

async function resolveLanding(client, targetUrl, options = {}) {
    const headers = buildUprotHeaders(targetUrl, options);
    const { status, text } = await fetchText(client, targetUrl, {
        headers,
        timeout: Number(options.landingTimeout || 12_000)
    });

    if (status >= 200 && status < 400 && text) {
        const parsed = await parseUprotLandingText(client, targetUrl, text, options, 'uprot-landing');
        if (parsed) return parsed;
    }

    const flare = await fetchWithFlareSolverr(targetUrl, options);
    if (!flare?.text) return null;

    const flareClient = {
        ...client,
        async head(url, requestOptions = {}) {
            if (client && typeof client.head === 'function') return client.head(url, requestOptions);
            if (axios && typeof axios.head === 'function') return axios.head(url, requestOptions);
            return { status: 0, url };
        },
        async get(url, requestOptions = {}) {
            if (client && typeof client.get === 'function') return client.get(url, requestOptions);
            if (axios && typeof axios.get === 'function') return axios.get(url, requestOptions);
            return { status: 0, data: '' };
        }
    };
    return parseUprotLandingText(flareClient, flare.finalUrl || targetUrl, flare.text, {
        ...options,
        userAgent: flare.userAgent || options.userAgent,
        requestReferer: targetUrl,
        referer: targetUrl
    }, 'uprot-flare');
}

async function resolveUprotToMaxstream(client, url, options = {}) {
    const originalUrl = normalizeRemoteUrl(url);
    const targetUrl = normalizeUprotInput(url);
    if (!targetUrl || !client) return null;

    // MammaMia's protected path is driven by a pre-generated captcha cookie + form data.
    // Eurostreaming commonly exposes /msf/ links; normalizeUprotInput probes /mse/ first,
    // then falls back to posting the stored state back to the matching /msf/ URL.
    const stateReady = hasUprotState(options);
    const captchaUrl = toMsfCaptchaUrl(originalUrl || targetUrl);

    if (isMsfiUrl(targetUrl)) {
        uprotDebug('info', 'resolve start', { path: 'msfi', stateReady, flareEnabled: flareEnabled(options), targetHost: safeHost(targetUrl) });
        if (stateReady) {
            const posted = await resolveMsfi(client, targetUrl, options);
            if (posted) return posted;
        }
        if (typeof client.get === 'function') {
            const landing = await resolveLanding(client, targetUrl, options);
            if (landing) return landing;
        }
        const fallback = stateReady ? null : await resolveMsfi(client, targetUrl, options);
        if (!fallback) uprotDebug('warn', 'resolve returned null', { path: 'msfi', stateReady, flareEnabled: flareEnabled(options) });
        return fallback;
    }

    if (typeof client.get !== 'function') return null;
    uprotDebug('info', 'resolve start', { path: 'landing', stateReady, targetHost: safeHost(targetUrl) });
    const landing = await resolveLanding(client, targetUrl, options);
    if (landing) return landing;

    if (stateReady && captchaUrl) {
        uprotDebug('info', 'landing failed; trying stored captcha state', { targetHost: safeHost(captchaUrl), fromPath: safeHost(targetUrl) });
        const posted = await resolveMsfi(client, captchaUrl, options);
        if (posted) return posted;
    }

    uprotDebug('warn', 'resolve returned null', { path: 'landing', stateReady });
    return null;
}

function buildPlaybackHeaders(playerUrl, userAgent, referer = null) {
    const origin = getOrigin(playerUrl, 'https://uprot.net');
    return {
        Referer: referer || playerUrl,
        Origin: origin,
        'User-Agent': userAgent || DEFAULT_USER_AGENT,
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };
}

async function extractUprot(url, options = {}) {
    const client = options?.client;
    const resolved = await resolveUprotToMaxstream(client, url, options);
    if (!resolved) return null;

    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    if (resolved.streamUrl) {
        const headers = buildPlaybackHeaders(resolved.playerUrl || resolved.sourceUrl, userAgent, resolved.sourceUrl);
        const quality = await probeStreamQuality(client, resolved.streamUrl, { headers, fallback: 'Unknown' });
        return {
            url: resolved.streamUrl,
            sourceUrl: resolved.sourceUrl,
            headers,
            extractor: 'Uprot',
            name: 'Uprot',
            quality,
            priority: 0,
            via: resolved.via
        };
    }

    const { extractMaxstream } = require('./maxstream');
    const extracted = await extractMaxstream(resolved.playerUrl, {
        ...options,
        requestReferer: resolved.sourceUrl || options.requestReferer || options.referer,
        referer: resolved.sourceUrl || options.referer || options.requestReferer
    });
    if (!extracted?.url) return null;

    return {
        ...extracted,
        sourceUrl: resolved.sourceUrl || extracted.sourceUrl,
        extractor: 'Uprot',
        name: 'Uprot',
        via: `${resolved.via}${extracted.via ? `:${extracted.via}` : ''}`
    };
}

module.exports = {
    extractContinueLink,
    fetchWithFlareSolverr,
    loadUprotState,
    extractUprot,
    isUprotUrl,
    normalizeUprotInput,
    resolveUprotToMaxstream,
    toMaxstreamPlayerUrl,
    _test: {
        buildFormBody,
        cookieHeaderFromState,
        extractContinueLink,
        loadUprotState,
        parseUprotTxtState,
        toMsfCaptchaUrl
    }
};
