'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let axios = null;
try { axios = require('axios'); } catch (_) { axios = null; }
let Tesseract = null;
try { Tesseract = require('tesseract.js'); } catch (_) { Tesseract = null; }
let setCookieParser = null;
try { setCookieParser = require('set-cookie-parser'); } catch (_) { setCookieParser = null; }
const { getOrigin, normalizeRemoteUrl } = require('../common');
const { captchaOrchestrator } = require('../../../core/captcha_orchestrator');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractFirstUrl,
    fetchText,
    probeStreamQuality,
    responseText
} = require('./shared');

const UPROT_HOST_RE = /(?:^|\.)(?:uprot|uproat)\.(?:net|pro)$/i;
const UPROT_URL_RE = /^https?:\/\/(?:www\.)?(?:uprot|uproat)\.(?:net|pro)\//i;
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

const UPROT_AUTO_STATE_DEFAULTS = Object.freeze({
    enabled: true,
    bootstrapUrl: 'https://uprot.net/msf/r4hcq47tarq8',
    generatedStateFile: path.resolve(process.cwd(), 'config', 'uprot_state.json'),
    stateTtlMs: 45 * 60_000,
    // Longer failure cooldown: when FlareSolverr's IP is Cloudflare-banned on
    // uprot, or the captcha image is canvas-rendered and OCR can't read it,
    // there is nothing the next request can do differently for a while.
    // 10 minutes keeps user-facing latency low; the cooldown is global per host.
    failureTtlMs: 10 * 60_000,
    // Single attempt per request: each attempt already iterates 5+ bootstrap
    // candidates (uprot.net/.pro/uproat aliases × /e/, /msf/, /mse/ paths).
    // A second pass within the same request just doubles the wasted time.
    retryBudget: 1,
    captchaMinDigits: 3,
    captchaMaxDigits: 8,
    ocrMinConfidence: 0,
    ocrCacheTtlMs: 10 * 60_000,
    imageTimeoutMs: 10_000,
    bootstrapTimeoutMs: 12_000,
    postTimeoutMs: 12_000,
    manualMode: false,
    manualSessionTtlMs: 10 * 60_000
});

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

function safePathForUprot(value) {
    try { return new URL(String(value || '')).pathname; } catch (_) { return ''; }
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
    return envFlag('UPROT_FLARE_ENABLED', envFlag('EUROSTREAMING_UPROT_FLARE_ENABLED', true));
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

// Tracks hosts where FlareSolverr has reported a hard Cloudflare IP ban so we
// stop wasting 2-5s per request hammering the same dead endpoint. Cleared on
// process restart; cooldown is intentionally long because the ban itself is.
const flareHostBanCooldown = new Map();
const FLARE_HOST_BAN_COOLDOWN_MS = 15 * 60_000;

function getFlareTargetHost(targetUrl) {
    try { return new URL(String(targetUrl || '')).hostname.toLowerCase(); } catch (_) { return ''; }
}

function isFlareIpBanError(response) {
    const body = response?.data;
    const text = typeof body === 'string' ? body : (body && typeof body === 'object' ? (body.message || JSON.stringify(body)) : '');
    return /cloudflare\s+has\s+blocked\s+this\s+request|your\s+ip\s+is\s+banned/i.test(String(text || ''));
}

async function fetchWithFlareSolverr(targetUrl, options = {}) {
    const endpoint = getFlareEndpoint(options);
    if (!flareEnabled(options) || !endpoint) return null;

    // Route the request through the CB01/Kraken forward proxy when configured
    // so FlareSolverr's egress IP is replaced by the proxy's IP. uprot.net's
    // Cloudflare blocklist commonly bans FlareSolverr container IPs, but the
    // Kraken proxy IP is generally accepted. The proxy URL pattern matches
    // CB01_FORWARD_PROXY (https://krakenproxy.../forward?url=).
    const proxyUrl = buildUprotForwardRequestUrl(targetUrl, options);
    const fetchUrl = proxyUrl || targetUrl;
    const flareViaProxy = Boolean(proxyUrl && proxyUrl !== targetUrl);

    const host = getFlareTargetHost(targetUrl);
    const bannedUntil = host ? flareHostBanCooldown.get(host) : 0;
    if (bannedUntil && bannedUntil > Date.now() && !flareViaProxy) {
        uprotDebug('warn', 'flare host in ip-ban cooldown; skipping', { host, remainingMs: bannedUntil - Date.now() });
        return null;
    }

    const client = getFlareClient(options);
    if (!client || typeof client.post !== 'function') return null;
    const timeout = envNumber('UPROT_FLARE_TIMEOUT_MS', Number(options.uprotFlareTimeoutMs || 25_000), 8_000, 60_000);
    const maxTimeout = envNumber('UPROT_FLARE_MAX_TIMEOUT_MS', Number(options.uprotFlareMaxTimeoutMs || timeout), 8_000, 90_000);
    const waitInSeconds = envNumber('UPROT_FLARE_WAIT_SECONDS', Number(options.uprotFlareWaitSeconds || 2), 0, 15);

    if (flareViaProxy) {
        uprotDebug('info', 'flare fetch via forward proxy', { targetHost: host, proxyHost: getFlareTargetHost(fetchUrl) });
    }

    try {
        const payload = {
            cmd: 'request.get',
            url: fetchUrl,
            maxTimeout,
            returnOnlyCookies: false
        };
        if (waitInSeconds) payload.waitInSeconds = waitInSeconds;

        const response = await client.post(endpoint, payload, {
            timeout: maxTimeout + 7_000,
            validateStatus: () => true
        });
        const status = Number(response?.status || 0);
        if (status && status >= 400) {
            if (host && isFlareIpBanError(response)) {
                flareHostBanCooldown.set(host, Date.now() + FLARE_HOST_BAN_COOLDOWN_MS);
                uprotDebug('warn', 'flare reports cloudflare ip-ban; cooldown set', { host, cooldownMs: FLARE_HOST_BAN_COOLDOWN_MS, status });
            }
            return null;
        }
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
        return /\/m(?:sf|se)i\//i.test(new URL(String(url || '')).pathname);
    } catch (_) {
        return /\/m(?:sf|se)i\//i.test(String(url || ''));
    }
}

function toMsfCaptchaUrl(url) {
    const normalized = normalizeRemoteUrl(url);
    if (!normalized || !isUprotUrl(normalized)) return null;
    try {
        const parsed = new URL(normalized);
        parsed.pathname = parsed.pathname.replace(/\/(?:mse|msei|msfi|e)\//i, '/msf/');
        return parsed.toString();
    } catch (_) {
        return normalized.replace(/\/(?:mse|msei|msfi|e)\//i, '/msf/');
    }
}

function extractUprotPathCode(url) {
    const normalized = normalizeRemoteUrl(url);
    if (!normalized || !isUprotUrl(normalized)) return null;
    try {
        const parts = new URL(normalized).pathname.split('/').filter(Boolean);
        const prefix = String(parts[0] || '').toLowerCase();
        if (!/^(?:mse|msei|msf|msfi|e)$/.test(prefix)) return null;
        return parts[1] || null;
    } catch (_) {
        const match = String(normalized).match(/\/(?:mse|msei|msf|msfi|e)\/([^/?#]+)/i);
        return match?.[1] || null;
    }
}

function decodeUprotPathCodeCandidates(code) {
    const out = [];
    const push = (value) => {
        const clean = String(value || '').trim();
        if (!clean || clean.length < 4 || clean.length > 256 || out.includes(clean)) return;
        // Keep only URL-path-safe-ish values. Uprot sometimes returns /msei/<b64>
        // where the first decode is the real encrypted /e/<token> code.
        if (!/^[A-Za-z0-9._~+=-]+$/.test(clean)) return;
        out.push(clean);
    };
    push(code);
    let current = String(code || '').replace(/-/g, '+').replace(/_/g, '/');
    for (let i = 0; i < 2; i += 1) {
        try {
            const padded = current + '='.repeat((4 - (current.length % 4)) % 4);
            const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
            if (!decoded || decoded === current) break;
            push(decoded);
            current = decoded.replace(/-/g, '+').replace(/_/g, '/');
        } catch (_) {
            break;
        }
    }
    return out;
}


function uprotHostAliasesFor(url) {
    const aliases = [];
    const push = (host) => {
        const clean = String(host || '').trim().toLowerCase().replace(/^www\./, '');
        if (!clean || !UPROT_HOST_RE.test(clean) || aliases.includes(clean)) return;
        aliases.push(clean);
    };
    try { push(new URL(String(url || '')).hostname); } catch (_) {}
    // Some Uprot deployments expose the captcha/encrypter page only on one
    // alias while the CB01/stayonline embed points at another. Try the known
    // aliases, but keep them behind the same path candidates and de-duplicate.
    push('uprot.net');
    push('uprot.pro');
    push('uproat.pro');
    push('uproat.net');
    return aliases;
}

function withUprotHost(url, host) {
    const normalized = normalizeRemoteUrl(url);
    if (!normalized || !host) return null;
    try {
        const parsed = new URL(normalized);
        parsed.hostname = String(host).replace(/^www\./, '');
        return parsed.toString();
    } catch (_) {
        return null;
    }
}

function withUprotCodePrefix(url, prefix, code) {
    const normalized = normalizeRemoteUrl(url);
    if (!normalized || !code) return null;
    try {
        const parsed = new URL(normalized);
        const cleanPrefix = String(prefix || '').replace(/^\/+|\/+$/g, '').toLowerCase();
        const safeCode = encodeURIComponent(String(code)).replace(/%3D/gi, '=');
        parsed.pathname = cleanPrefix === 'e' ? `/e/${safeCode}/` : `/${cleanPrefix}/${safeCode}`;
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return null;
    }
}

function withUprotPathPrefix(url, prefix) {
    const normalized = normalizeRemoteUrl(url);
    const code = extractUprotPathCode(normalized);
    if (!normalized || !code) return null;
    try {
        const parsed = new URL(normalized);
        const cleanPrefix = String(prefix || '').replace(/^\/+|\/+$/g, '').toLowerCase();
        parsed.pathname = cleanPrefix === 'e' ? `/e/${code}/` : `/${cleanPrefix}/${code}`;
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return null;
    }
}

function buildUprotBootstrapCandidates(targetUrl, options = {}) {
    const normalized = normalizeRemoteUrl(targetUrl);
    const configured = getUprotBootstrapUrl(options);
    const candidates = [];
    const push = (value) => {
        const url = normalizeRemoteUrl(value);
        if (!url || !isUprotUrl(url) || candidates.includes(url)) return;
        candidates.push(url);
    };
    const pushAliases = (value, aliasMode = 'all') => {
        const url = normalizeRemoteUrl(value);
        if (!url || !isUprotUrl(url)) return;
        push(url);
        const aliases = uprotHostAliasesFor(url);
        for (const host of aliases) {
            const aliasUrl = withUprotHost(url, host);
            if (!aliasUrl) continue;
            // Alias probing is most useful for the /e/<code>/ captcha/encrypter
            // page. For legacy /msf|mse paths, only try aliases when requested;
            // otherwise we would multiply pointless 8122-byte placeholders.
            if (aliasMode === 'e-only' && !/\/e\//i.test(safePathForUprot(aliasUrl))) continue;
            push(aliasUrl);
        }
    };

    // Uprot/Uproat can expose the captcha on /e/<id>/ and sometimes only on a
    // sibling host alias (e.g. uproat.pro) while uprot.net returns the small
    // URL-Encrypter placeholder (~8 KB). Prefer aliased /e routes before legacy
    // /msf and landing variants.
    const pathCode = normalized ? extractUprotPathCode(normalized) : null;
    if (normalized && pathCode) {
        const decodedCodes = decodeUprotPathCodeCandidates(pathCode);
        for (const code of decodedCodes) pushAliases(withUprotCodePrefix(normalized, 'e', code), 'all');
        pushAliases(withUprotPathPrefix(normalized, 'e'), 'all');
        push(withUprotPathPrefix(normalized, 'msf'));
        push(normalized);
        push(withUprotPathPrefix(normalized, 'mse'));
        push(withUprotPathPrefix(normalized, 'msei'));
        push(withUprotPathPrefix(normalized, 'msfi'));
    } else {
        pushAliases(normalized, 'e-only');
    }
    push(configured);
    return candidates;
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


function parseUprotStateFile(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const jsonState = parseObjectLike(raw);
    if (jsonState) {
        const cookies = parseCookieState(jsonState.cookies || jsonState.cookie || jsonState.cookieState || null);
        const captchaData = parseObjectLike(jsonState.captchaData || jsonState.data || jsonState.captcha || null);
        if (cookies || captchaData) return { cookies, captchaData };
    }
    return parseUprotTxtState(raw);
}

function getUprotGeneratedStateFile(options = {}) {
    return options.uprotGeneratedStateFile
        || options.uprotStateFile
        || process.env.UPROT_GENERATED_STATE_FILE
        || process.env.UPROT_STATE_FILE
        || UPROT_AUTO_STATE_DEFAULTS.generatedStateFile;
}

function saveUprotStateToFile(state, options = {}) {
    const filePath = getUprotGeneratedStateFile(options);
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const payload = {
            cookies: state?.cookies || {},
            captchaData: state?.captchaData || {},
            generatedAt: new Date().toISOString(),
            source: state?.source || 'auto'
        };
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
        uprotDebug('info', 'auto-state saved', { path: filePath, cookieKeys: Object.keys(payload.cookies || {}).length, formKeys: Object.keys(payload.captchaData || {}) });
        return true;
    } catch (error) {
        uprotDebug('warn', 'auto-state save failed', { error: error?.message || String(error) });
        return false;
    }
}

function loadUprotStateFromFile(options = {}) {
    const candidates = [
        options.uprotStateFile,
        process.env.UPROT_STATE_FILE,
        process.env.UPROT_GENERATED_STATE_FILE,
        UPROT_AUTO_STATE_DEFAULTS.generatedStateFile,
        path.join(__dirname, 'uprot.txt'),
        path.join(__dirname, '..', 'uprot.txt')
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            const filePath = path.resolve(String(candidate));
            if (!fs.existsSync(filePath)) continue;
            const parsed = parseUprotStateFile(fs.readFileSync(filePath, 'utf8'));
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
        // Only accept real player paths that start with "/em" (e.g. /emb/, /emhuih/,
        // /emvvv/). The anchor stops false-positives such as /uprotem/<token>, which
        // is a maxstream-hosted captcha mirror, not a playable embed.
        if (isMaxstreamHost && /^\/em[^/]*\//i.test(parsed.pathname)) return normalized;

        const code = extractWatchfreeCode(normalized);
        if (code) return `https://maxstream.video/emvvv/${code}`;

        return null;
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

// Baked-in default: the Kraken forward proxy is what CB01 already uses to
// bypass Cloudflare IP bans, so uprot.net (which bans FlareSolverr's container
// IP) gets the same treatment without requiring env config.
const UPROT_FORWARD_PROXY_DEFAULT = 'https://krakenproxy.questoleviatanormio.dpdns.org/forward?url=';

function getUprotForwardProxy(options = {}) {
    const raw = String(
        options.uprotForwardProxy
        || process.env.UPROT_FORWARD_PROXY
        || process.env.UPROT_FORWARDPROXY
        || process.env.CB01_FORWARD_PROXY
        || process.env.FORWARDPROXY
        || UPROT_FORWARD_PROXY_DEFAULT
    ).trim();
    if (!raw || /^(?:0|false|off|no)$/i.test(raw)) return '';
    return raw;
}

function buildUprotForwardRequestUrl(targetUrl, options = {}) {
    const normalized = normalizeRemoteUrl(targetUrl);
    const forwardProxy = getUprotForwardProxy(options);
    if (!normalized || !forwardProxy) return normalized;
    try {
        if (forwardProxy.includes('{url}')) return forwardProxy.replace('{url}', encodeURIComponent(normalized));
        if (/[?&][^=]+=\s*$/i.test(forwardProxy)) return `${forwardProxy}${encodeURIComponent(normalized)}`;
        const parsed = new URL(forwardProxy);
        if (!parsed.searchParams.has('url')) parsed.searchParams.set('url', normalized);
        return parsed.toString();
    } catch (_) {
        return normalized;
    }
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
    const posted = await postText(client, buildUprotForwardRequestUrl(targetUrl, options), body, headers, Number(options.postTimeout || 12_000));
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
    const { cookies } = loadUprotState(options);
    const cookieHeader = cookieHeaderFromState(cookies);
    if (cookieHeader) headers.Cookie = cookieHeader;
    const { status, text } = await fetchText(client, buildUprotForwardRequestUrl(targetUrl, options), {
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


const uprotOcrCache = new Map();
const uprotManualSessions = new Map();

function getUprotBootstrapUrl(options = {}) {
    return normalizeRemoteUrl(options.uprotBootstrapUrl || process.env.UPROT_BOOTSTRAP_URL || UPROT_AUTO_STATE_DEFAULTS.bootstrapUrl) || UPROT_AUTO_STATE_DEFAULTS.bootstrapUrl;
}

function uprotCaptchaContext(targetUrl, options = {}) {
    return {
        provider: options.provider || 'web',
        hoster: 'uprot',
        captchaType: 'image-ocr-state',
        scope: safeHost(targetUrl) || 'uprot.net'
    };
}

function uprotAutoStateEnabled(options = {}) {
    if (options.uprotAutoStateEnabled !== undefined) return Boolean(options.uprotAutoStateEnabled);
    return envFlag('UPROT_AUTO_STATE_ENABLED', UPROT_AUTO_STATE_DEFAULTS.enabled);
}

function uprotMammaMiaMode(options = {}) {
    if (options.uprotMammaMiaMode !== undefined) return Boolean(options.uprotMammaMiaMode);
    if (options.uprotManualMode !== undefined) return Boolean(options.uprotManualMode);
    return envFlag('UPROT_MAMMAMIA_MODE', UPROT_AUTO_STATE_DEFAULTS.manualMode);
}

function uprotManualSessionTtlMs(options = {}) {
    return envNumber('UPROT_MANUAL_SESSION_TTL_MS', Number(options.uprotManualSessionTtlMs || UPROT_AUTO_STATE_DEFAULTS.manualSessionTtlMs), 60_000, 60 * 60_000);
}

function uprotStateTtlMs(options = {}) {
    return envNumber('UPROT_STATE_TTL_MS', Number(options.uprotStateTtlMs || UPROT_AUTO_STATE_DEFAULTS.stateTtlMs), 60_000, 24 * 60 * 60_000);
}

function uprotFailureTtlMs(options = {}) {
    return envNumber('UPROT_FAILURE_TTL_MS', Number(options.uprotFailureTtlMs || UPROT_AUTO_STATE_DEFAULTS.failureTtlMs), 10_000, 30 * 60_000);
}

function mergeSetCookieHeaders(existingCookies, response) {
    const merged = { ...(typeof existingCookies === 'object' && !Array.isArray(existingCookies) ? existingCookies : {}) };
    const rawHeaders = response?.headers?.['set-cookie'] || response?.headers?.['Set-Cookie'];
    if (!rawHeaders) return merged;

    if (setCookieParser) {
        const parsed = setCookieParser.parse(Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders], { decodeValues: true });
        for (const cookie of parsed) {
            if (cookie.name) merged[cookie.name] = cookie.value;
        }
        return merged;
    }

    const list = Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders];
    for (const raw of list) {
        const pair = String(raw || '').split(';')[0]?.trim();
        const eq = pair.indexOf('=');
        if (eq > 0) merged[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return merged;
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function cleanInlineDataImage(value) {
    const text = decodeHtmlEntities(value).trim();
    const match = text.match(/data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=_\s-]+)/i);
    if (!match) return null;
    const payload = String(match[1] || '').replace(/\s+/g, '');
    if (!payload || payload.length < 32) return null;
    const mime = (text.match(/data:image\/[a-z0-9.+-]+;base64,/i) || ['data:image/png;base64,'])[0];
    return `${mime}${payload}`;
}

function summarizeUprotPage(html) {
    const text = String(html || '');
    const imgs = [];
    for (const match of text.matchAll(/<img\b[\s\S]*?>/ig)) {
        if (imgs.length >= 5) break;
        const tag = match[0];
        const quoted = tag.match(/\bsrc\s*=\s*(["'])([\s\S]*?)\1/i);
        const bare = quoted ? null : tag.match(/\bsrc\s*=\s*([^\s>]+)/i);
        const src = (quoted ? quoted[2] : bare?.[1]) || '';
        imgs.push({
            src: src.length > 80 ? `${src.slice(0, 77)}...` : src,
            id: htmlAttr(tag, 'id') || undefined,
            cls: htmlAttr(tag, 'class') || undefined,
            alt: htmlAttr(tag, 'alt') || undefined
        });
    }
    return {
        bytes: text.length,
        imgCount: (text.match(/<img\b/ig) || []).length,
        canvasCount: (text.match(/<canvas\b/ig) || []).length,
        scriptCount: (text.match(/<script\b/ig) || []).length,
        hasCaptchaKeyword: /captcha|capcha|verification|security[_-]?code/i.test(text),
        hasInlineDataImage: /data:image\/[^;]+;base64,/i.test(text),
        firstImgs: imgs
    };
}

function extractCaptchaImageSrc(html, baseUrl = null) {
    const text = String(html || '');
    const candidates = [];
    const push = (src, score = 0, why = '') => {
        const clean = cleanInlineDataImage(src) || decodeHtmlEntities(src).trim();
        if (!clean) return;
        candidates.push({ src: normalizeRemoteUrl(clean, baseUrl) || clean, score, why });
    };

    // Uprot/Uproat can embed the captcha directly as data:image/png;base64,...
    // Scan the whole document first because a huge data URI can make tag-level
    // regexes brittle when the upstream changes whitespace/quoting.
    const inlineImage = cleanInlineDataImage(text);
    if (inlineImage) push(inlineImage, 100, 'inline-data-image');

    for (const match of text.matchAll(/<img\b[\s\S]*?>/ig)) {
        const tag = match[0];
        const quoted = tag.match(/\bsrc\s*=\s*(["'])([\s\S]*?)\1/i);
        const bare = quoted ? null : tag.match(/\bsrc\s*=\s*([^\s>]+)/i);
        const src = quoted ? quoted[2] : bare?.[1];
        const haystack = `${src || ''} ${htmlAttr(tag, 'id')} ${htmlAttr(tag, 'class')} ${htmlAttr(tag, 'alt')} ${htmlAttr(tag, 'name')}`;
        const bad = /avatar|logo|icon|banner|poster|cover|thumb|favicon|sprite/i.test(haystack);
        const good = /captcha|capcha|base64|data:image|verify|verification|security|code/i.test(haystack);
        // Only accept images with an explicit captcha tell. Previously we
        // accepted any non-"bad" image with score 1, which caused OCR to run on
        // decorative graphics and report confidence:0. False positives waste
        // time and pollute the orchestrator's failure cache.
        if (src && good) push(src, 20, 'img-tag-captcha-hint');
    }

    for (const match of text.matchAll(/url\((["']?)(data:image\/[^)'" ]+|[^)'" ]+)\1\)/ig)) {
        const src = match[2];
        const good = /captcha|capcha|data:image|verify|verification|security|code/i.test(src);
        if (good) push(src, 15, 'css-url-captcha-hint');
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.src || null;
}

function extractBase64Image(value) {
    const dataImage = cleanInlineDataImage(value);
    if (!dataImage) return null;
    const inline = dataImage.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=_-]+)/i);
    return inline ? inline[1] : null;
}

function htmlAttr(tag, name) {
    const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i');
    const quoted = String(tag || '').match(re);
    if (quoted) return quoted[2];
    const bare = String(tag || '').match(new RegExp(`${escaped}\\s*=\\s*([^\\s>]+)`, 'i'));
    return bare ? bare[1] : '';
}

function extractFormInputs(html) {
    const fields = {};
    for (const match of String(html || '').matchAll(/<input\b[^>]*>/ig)) {
        const tag = match[0];
        const name = htmlAttr(tag, 'name');
        if (!name) continue;
        const type = String(htmlAttr(tag, 'type') || 'text').toLowerCase();
        if (/^(?:submit|button|reset|image|file)$/i.test(type)) continue;
        fields[name] = htmlAttr(tag, 'value') || '';
    }
    return fields;
}

function extractCaptchaFormAction(html, baseUrl = null) {
    const text = String(html || '');
    for (const match of text.matchAll(/<form\b[\s\S]*?>/ig)) {
        const tag = match[0];
        const action = htmlAttr(tag, 'action');
        const method = String(htmlAttr(tag, 'method') || 'get').toLowerCase();
        const haystack = `${tag} ${text.slice(match.index, Math.min(text.length, match.index + 2000))}`;
        if (method === 'post' || /captcha|capcha|verification|security/i.test(haystack)) {
            if (!action) return baseUrl;
            return normalizeRemoteUrl(decodeHtmlEntities(action), baseUrl) || baseUrl;
        }
    }
    return baseUrl;
}

function detectCaptchaFieldName(html, fields = {}) {
    const names = Object.keys(fields || {});
    const fromExisting = names.find((name) => /captcha|capcha|code|verify|verification|security/i.test(name));
    if (fromExisting) return fromExisting;
    for (const match of String(html || '').matchAll(/<input\b[^>]*>/ig)) {
        const tag = match[0];
        const name = htmlAttr(tag, 'name');
        if (name && /captcha|capcha|code|verify|verification|security/i.test(`${name} ${htmlAttr(tag, 'id')} ${htmlAttr(tag, 'placeholder')}`)) return name;
    }
    return 'captcha';
}

function hasCaptchaCandidate(html, baseUrl = null) {
    return Boolean(extractCaptchaImageSrc(html, baseUrl) || /captcha|capcha|verification|security/i.test(String(html || '')));
}

async function fetchCaptchaImageBase64(client, imageSrc, baseUrl, options = {}) {
    const inline = extractBase64Image(imageSrc);
    if (inline) return inline;
    const imageUrl = normalizeRemoteUrl(imageSrc, baseUrl);
    if (!imageUrl || !client || typeof client.get !== 'function') return null;

    try {
        const response = await client.get(imageUrl, {
            headers: buildUprotHeaders(imageUrl, { ...options, referer: baseUrl, requestReferer: baseUrl, accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8' }),
            responseType: 'arraybuffer',
            timeout: Number(options.imageTimeout || UPROT_AUTO_STATE_DEFAULTS.imageTimeoutMs),
            maxRedirects: 5,
            validateStatus: () => true
        });
        const status = Number(response?.status || response?.statusCode || 0);
        if (status && status >= 400) return null;
        const data = response?.data ?? response?.body;
        if (Buffer.isBuffer(data)) return data.toString('base64');
        if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64');
        if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer).toString('base64');
        const text = typeof data === 'string' ? data : responseText(response);
        return extractBase64Image(text) || (text ? Buffer.from(text, 'binary').toString('base64') : null);
    } catch (error) {
        uprotDebug('warn', 'captcha image fetch failed', { imageHost: safeHost(imageUrl), error: error?.message || String(error) });
        return null;
    }
}

function validateUprotCaptchaDigits(value) {
    const digits = String(value || '').replace(/\D/g, '').trim();
    const minDigits = envNumber('UPROT_CAPTCHA_MIN_DIGITS', UPROT_AUTO_STATE_DEFAULTS.captchaMinDigits, 1, 12);
    const maxDigits = envNumber('UPROT_CAPTCHA_MAX_DIGITS', UPROT_AUTO_STATE_DEFAULTS.captchaMaxDigits, minDigits, 16);
    if (digits.length < minDigits || digits.length > maxDigits) return null;
    return digits;
}

function maybeSaveCaptchaSample(base64Data, hash) {
    if (!envFlag('UPROT_DEBUG_SAVE_CAPTCHA', true)) return null;
    try {
        const dir = path.resolve(process.cwd(), 'config', 'uprot-debug');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `captcha-${hash.slice(0, 12)}.png`);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, Buffer.from(String(base64Data || ''), 'base64'));
        }
        return filePath;
    } catch (_) {
        return null;
    }
}

async function solveUprotCaptchaOCR(base64Data, options = {}) {
    if (!Tesseract) {
        uprotDebug('warn', 'tesseract.js not available, cannot generate auto-state');
        return null;
    }
    const hash = crypto.createHash('sha1').update(String(base64Data || '')).digest('hex');
    const cached = uprotOcrCache.get(hash);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    // Persist a copy of the first time we see each captcha image so a human can
    // inspect what uprot is actually serving (digits? letters? canvas render?
    // distorted noise?). Defaults on; disable with UPROT_DEBUG_SAVE_CAPTCHA=0.
    const samplePath = maybeSaveCaptchaSample(base64Data, hash);

    // Allow operators to broaden the whitelist when uprot serves alphanumeric
    // captchas. Defaults to digit-only because that's the historical format.
    const alphaMode = envFlag('UPROT_CAPTCHA_ALPHA', false);
    const whitelist = alphaMode
        ? '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
        : '0123456789';

    let worker = null;
    try {
        worker = await Tesseract.createWorker('eng');
        await worker.setParameters({
            tessedit_char_whitelist: whitelist,
            tessedit_pageseg_mode: '7'
        });
        const { data: { text, confidence } } = await worker.recognize(Buffer.from(base64Data, 'base64'));
        const cleanText = String(text || '').replace(/\s+/g, '').slice(0, 32);
        const digits = validateUprotCaptchaDigits(text);
        uprotDebug('info', 'auto-state OCR result', {
            digits: Boolean(digits),
            confidence,
            rawText: cleanText,
            rawLen: cleanText.length,
            alphaMode,
            samplePath: samplePath || undefined
        });
        if (!digits) return null;
        const minConfidence = envNumber('UPROT_OCR_MIN_CONFIDENCE', Number(options.uprotOcrMinConfidence ?? UPROT_AUTO_STATE_DEFAULTS.ocrMinConfidence), 0, 100);
        if (minConfidence > 0 && Number.isFinite(confidence) && confidence < minConfidence) return null;
        uprotOcrCache.set(hash, { value: digits, expiresAt: Date.now() + envNumber('UPROT_OCR_CACHE_TTL_MS', UPROT_AUTO_STATE_DEFAULTS.ocrCacheTtlMs, 1_000, 30 * 60_000) });
        return digits;
    } catch (error) {
        uprotDebug('warn', 'auto-state OCR failed', { error: error?.message || String(error) });
        return null;
    } finally {
        if (worker && typeof worker.terminate === 'function') {
            try { await worker.terminate(); } catch (_) {}
        }
    }
}

async function requestUprotBootstrapPage(client, bootstrapUrl, headers, options = {}) {
    const timeout = Number(options.bootstrapTimeout || UPROT_AUTO_STATE_DEFAULTS.bootstrapTimeoutMs);
    const pages = [];

    if (client && typeof client.get === 'function') {
        const requestUrl = buildUprotForwardRequestUrl(bootstrapUrl, options);
        const fetched = await fetchText(client, requestUrl, { headers, timeout });
        if (fetched?.text) {
            pages.push({
                status: fetched.status,
                text: fetched.text,
                response: fetched.response || null,
                finalUrl: normalizeRemoteUrl(responseFinalUrl(fetched.response, bootstrapUrl)) && isUprotUrl(responseFinalUrl(fetched.response, bootstrapUrl)) ? responseFinalUrl(fetched.response, bootstrapUrl) : bootstrapUrl,
                method: 'GET'
            });
        }
    }

    if (client && typeof client.post === 'function') {
        const posted = await postText(client, buildUprotForwardRequestUrl(bootstrapUrl, options), '', { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout);
        if (posted?.text) pages.push({ ...posted, finalUrl: (posted.finalUrl && isUprotUrl(posted.finalUrl)) ? posted.finalUrl : bootstrapUrl, method: 'POST' });
    }

    const directHit = pages.find((page) => hasCaptchaCandidate(page.text, page.finalUrl || bootstrapUrl));
    if (directHit) return directHit;

    // Direct fetches did not yield a captcha image (typical when uprot/uproat
    // serves the small URL-Encrypter placeholder or sits behind Cloudflare).
    // Fall back to FlareSolverr to fetch the real captcha page so MammaMia-style
    // auto-state generation can complete without human help.
    if (flareEnabled(options) && getFlareEndpoint(options)) {
        const flare = await fetchWithFlareSolverr(bootstrapUrl, options);
        if (flare?.text && hasCaptchaCandidate(flare.text, flare.finalUrl || bootstrapUrl)) {
            uprotDebug('info', 'auto-state bootstrap rescued via FlareSolverr', {
                bootstrapHost: safeHost(bootstrapUrl),
                bootstrapPath: safePathForUprot(bootstrapUrl),
                bytes: String(flare.text || '').length
            });
            const flareCookies = String(flare.cookies || '').trim();
            const flareResponse = flareCookies ? { headers: { 'set-cookie': flareCookies.split(/;\s*/).filter(Boolean) } } : null;
            return {
                status: Number(flare.status) || 200,
                text: flare.text,
                response: flareResponse,
                finalUrl: (flare.finalUrl && isUprotUrl(flare.finalUrl)) ? flare.finalUrl : bootstrapUrl,
                method: 'FLARE'
            };
        }
    }

    if (!pages.length) return null;
    return pages[0];
}

async function generateUprotAutoState(client, targetUrl, options = {}) {
    if (!client || typeof client.post !== 'function') return null;

    const bootstrapUrls = buildUprotBootstrapCandidates(targetUrl, options);

    for (const bootstrapUrl of bootstrapUrls) {
        const headers = buildUprotHeaders(bootstrapUrl, options);
        const page = await requestUprotBootstrapPage(client, bootstrapUrl, headers, options);
        if (!page?.text) {
            uprotDebug('warn', 'auto-state bootstrap page missing', { bootstrapHost: safeHost(bootstrapUrl), bootstrapPath: safePathForUprot(bootstrapUrl), status: page?.status || 0 });
            continue;
        }

        let cookies = mergeSetCookieHeaders({}, page.response);
        const pageUrl = page.finalUrl || bootstrapUrl;
        const imageSrc = extractCaptchaImageSrc(page.text, pageUrl);
        if (!imageSrc) {
            uprotDebug('warn', 'auto-state captcha image missing', {
                bootstrapHost: safeHost(bootstrapUrl),
                bootstrapPath: safePathForUprot(bootstrapUrl),
                method: page.method || 'unknown',
                page: summarizeUprotPage(page.text)
            });
            continue;
        }
        const imageBase64 = await fetchCaptchaImageBase64(client, imageSrc, pageUrl, options);
        if (!imageBase64) {
            uprotDebug('warn', 'auto-state captcha image decode failed', { bootstrapHost: safeHost(bootstrapUrl), bootstrapPath: safePathForUprot(bootstrapUrl), inline: /^data:image/i.test(String(imageSrc || '')) });
            continue;
        }

        const captchaCode = await solveUprotCaptchaOCR(imageBase64, options);
        if (!captchaCode) continue;

        const formFields = extractFormInputs(page.text);
        const captchaField = detectCaptchaFieldName(page.text, formFields);
        const captchaData = { ...formFields, [captchaField]: captchaCode };
        const formUrl = extractCaptchaFormAction(page.text, pageUrl) || pageUrl;
        const postHeaders = {
            ...buildUprotHeaders(formUrl, { ...options, referer: pageUrl, requestReferer: pageUrl }),
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieHeaderFromState(cookies)
        };
        const posted = await postText(client, formUrl, buildFormBody(captchaData), postHeaders, Number(options.postTimeout || UPROT_AUTO_STATE_DEFAULTS.postTimeoutMs));
        if (posted.status < 200 || posted.status >= 400) {
            uprotDebug('warn', 'auto-state captcha post failed', { status: posted.status, finalHost: safeHost(posted.finalUrl), bootstrapPath: safePathForUprot(bootstrapUrl) });
            continue;
        }
        cookies = mergeSetCookieHeaders(cookies, posted.response);

        const redirectedPlayer = toMaxstreamPlayerUrl(posted.finalUrl);
        const continueUrl = extractContinueLink(posted.text, formUrl);
        const fallbackUrl = extractFirstUrl(posted.text, PLAYER_LINK_PATTERNS, formUrl);
        const playerUrl = redirectedPlayer
            || (continueUrl ? await followContinueLink(client, continueUrl, { ...options, sourceUrl: formUrl, requestReferer: pageUrl, referer: pageUrl }) : null)
            || toMaxstreamPlayerUrl(fallbackUrl);

        if (!cookieHeaderFromState(cookies) && !playerUrl) continue;

        const state = {
            cookies,
            captchaData,
            source: `auto:${safeHost(bootstrapUrl) || 'uprot'}:${safePathForUprot(bootstrapUrl) || '/'}`,
            targetHost: safeHost(targetUrl),
            captchaPageUrl: pageUrl,
            formUrl
        };
        if (playerUrl) {
            state.playerUrl = playerUrl;
            state.sourceUrl = formUrl;
        }
        saveUprotStateToFile(state, options);
        uprotDebug('info', 'auto-state captcha accepted', { bootstrapHost: safeHost(bootstrapUrl), bootstrapPath: safePathForUprot(bootstrapUrl), playerHost: safeHost(playerUrl), formHost: safeHost(formUrl) });
        return state;
    }

    return null;
}


function cleanupUprotManualSessions(now = Date.now()) {
    for (const [token, session] of uprotManualSessions.entries()) {
        if (!session || Number(session.expiresAt || 0) <= now) uprotManualSessions.delete(token);
    }
}

function htmlEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderUprotSetupHtml(payload = {}) {
    const token = htmlEscape(payload.token || '');
    const imageSrc = htmlEscape(payload.imageSrc || '');
    const error = payload.error ? `<div class="msg err">${htmlEscape(payload.error)}</div>` : '';
    const success = payload.success ? `<div class="msg ok">${htmlEscape(payload.success)}</div>` : '';
    const detail = payload.detail ? `<p class="detail">${htmlEscape(payload.detail)}</p>` : '';
    const stateFile = htmlEscape(payload.stateFile || getUprotGeneratedStateFile());
    const form = imageSrc ? `
        <div class="captcha-card">
            <img src="${imageSrc}" alt="Uprot captcha" />
            <form method="post" action="/uprot" autocomplete="off">
                <input type="hidden" name="token" value="${token}" />
                <label for="captcha">Codice Uprot</label>
                <input id="captcha" name="captcha" inputmode="numeric" pattern="[0-9]{3,8}" maxlength="8" required autofocus />
                <button type="submit">Salva state Uprot</button>
            </form>
        </div>` : `
        <div class="captcha-card muted">
            <p>Non sono riuscito a ottenere l'immagine captcha da Uprot. Riprova tra poco oppure controlla proxy/WARP.</p>
            <a class="button" href="/uprot">Riprova</a>
        </div>`;
    return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Leviathan · Uprot setup</title>
<style>
:root{color-scheme:dark;--bg:#07111f;--panel:rgba(255,255,255,.09);--line:rgba(255,255,255,.16);--text:#eef6ff;--muted:#9db2c8;--accent:#37d7ff;--ok:#63e6be;--err:#ff8a8a}
*{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 15% 10%,rgba(55,215,255,.24),transparent 36%),radial-gradient(circle at 90% 80%,rgba(124,92,255,.22),transparent 34%),var(--bg);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--text);padding:22px}
.wrap{width:min(520px,100%);background:var(--panel);border:1px solid var(--line);border-radius:28px;box-shadow:0 28px 80px rgba(0,0,0,.35);padding:28px;backdrop-filter:blur(18px)}
h1{margin:0 0 8px;font-size:clamp(26px,6vw,38px);letter-spacing:-.04em} p{color:var(--muted);line-height:1.55}.captcha-card{margin-top:22px;padding:20px;border:1px solid var(--line);border-radius:22px;background:rgba(0,0,0,.22);display:grid;gap:18px}.captcha-card img{max-width:100%;justify-self:center;border-radius:12px;background:#fff;padding:8px}label{display:block;margin-bottom:8px;color:#dcecff;font-weight:700}input{width:100%;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.1);color:var(--text);font-size:20px;letter-spacing:.12em;text-align:center}button,.button{display:inline-flex;justify-content:center;width:100%;margin-top:14px;padding:14px 18px;border:0;border-radius:14px;background:linear-gradient(135deg,var(--accent),#7c5cff);color:#00121d;font-weight:900;text-decoration:none;cursor:pointer}.msg{padding:12px 14px;border-radius:14px;margin:14px 0}.ok{background:rgba(99,230,190,.14);border:1px solid rgba(99,230,190,.4);color:var(--ok)}.err{background:rgba(255,138,138,.14);border:1px solid rgba(255,138,138,.4);color:var(--err)}code{word-break:break-all;background:rgba(255,255,255,.08);padding:2px 6px;border-radius:6px}.detail{font-size:14px}.muted{opacity:.9}
</style>
</head>
<body><main class="wrap"><h1>Uprot setup</h1><p>Come MammaMia: prepara una volta lo state Uprot, poi CB01/MaxStream lo riusa senza provare captcha live durante lo stream.</p>${success}${error}${form}${detail}<p class="detail">State file: <code>${stateFile}</code></p></main></body></html>`;
}

async function prepareUprotManualChallenge(options = {}) {
    cleanupUprotManualSessions();
    const client = options.client || axios;
    if (!client || typeof client.post !== 'function') {
        return { ok: false, html: renderUprotSetupHtml({ error: 'Client HTTP non disponibile: impossibile preparare Uprot.' }) };
    }

    const bootstrapUrl = normalizeRemoteUrl(options.uprotBootstrapUrl || process.env.UPROT_BOOTSTRAP_URL || UPROT_AUTO_STATE_DEFAULTS.bootstrapUrl) || UPROT_AUTO_STATE_DEFAULTS.bootstrapUrl;
    const headers = {
        ...buildUprotHeaders(bootstrapUrl, {
            ...options,
            referer: bootstrapUrl,
            requestReferer: bootstrapUrl,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        DNT: '1'
    };

    let page = await postText(client, buildUprotForwardRequestUrl(bootstrapUrl, options), '', headers, Number(options.bootstrapTimeout || UPROT_AUTO_STATE_DEFAULTS.bootstrapTimeoutMs));
    let pageText = page?.text || '';
    let pageUrl = (page?.finalUrl && isUprotUrl(page.finalUrl)) ? page.finalUrl : bootstrapUrl;
    let cookies = mergeSetCookieHeaders({}, page?.response);
    let imageSrc = extractCaptchaImageSrc(pageText, pageUrl);

    if (!imageSrc) {
        const fallback = await requestUprotBootstrapPage(client, bootstrapUrl, headers, options);
        pageText = fallback?.text || pageText;
        pageUrl = fallback?.finalUrl || pageUrl;
        cookies = mergeSetCookieHeaders(cookies, fallback?.response);
        imageSrc = extractCaptchaImageSrc(pageText, pageUrl);
    }

    if (!imageSrc) {
        uprotDebug('warn', 'manual setup captcha image missing', { bootstrapHost: safeHost(bootstrapUrl), status: page?.status || 0, bytes: String(pageText || '').length, hasInlineDataImage: /data:image\/[^;]+;base64,/i.test(pageText) });
        return {
            ok: false,
            html: renderUprotSetupHtml({
                error: 'Captcha Uprot non trovato nella pagina ricevuta.',
                detail: `bootstrap=${bootstrapUrl} status=${page?.status || 0} bytes=${String(pageText || '').length}`
            })
        };
    }

    const imageBase64 = await fetchCaptchaImageBase64(client, imageSrc, pageUrl, options);
    const dataUri = imageBase64 ? `data:image/png;base64,${imageBase64}` : imageSrc;
    const formFields = extractFormInputs(pageText);
    const captchaField = detectCaptchaFieldName(pageText, formFields);
    const formUrl = extractCaptchaFormAction(pageText, pageUrl) || pageUrl;
    const token = crypto.randomBytes(18).toString('hex');
    uprotManualSessions.set(token, {
        cookies,
        formFields,
        captchaField,
        formUrl,
        pageUrl,
        bootstrapUrl,
        createdAt: Date.now(),
        expiresAt: Date.now() + uprotManualSessionTtlMs(options)
    });
    uprotDebug('info', 'manual setup ready', { bootstrapHost: safeHost(bootstrapUrl), formHost: safeHost(formUrl), cookieKeys: Object.keys(cookies || {}).length, captchaField });
    return { ok: true, html: renderUprotSetupHtml({ token, imageSrc: dataUri }) };
}

async function submitUprotManualChallenge({ token, captcha }, options = {}) {
    cleanupUprotManualSessions();
    const cleanToken = String(token || '').trim();
    const digits = validateUprotCaptchaDigits(captcha);
    const session = cleanToken ? uprotManualSessions.get(cleanToken) : null;
    if (!session) {
        return { ok: false, html: renderUprotSetupHtml({ error: 'Sessione Uprot scaduta. Riapri /uprot e riprova.' }) };
    }
    if (!digits) {
        return { ok: false, html: renderUprotSetupHtml({ error: 'Codice captcha non valido. Usa solo le cifre mostrate.' }) };
    }

    const client = options.client || axios;
    if (!client || typeof client.post !== 'function') {
        return { ok: false, html: renderUprotSetupHtml({ error: 'Client HTTP non disponibile: impossibile salvare Uprot.' }) };
    }

    const captchaData = { ...(session.formFields || {}), [session.captchaField || 'captcha']: digits };
    const headers = {
        ...buildUprotHeaders(session.formUrl, { ...options, referer: session.pageUrl, requestReferer: session.pageUrl }),
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeaderFromState(session.cookies)
    };
    const posted = await postText(client, buildUprotForwardRequestUrl(session.formUrl, options), buildFormBody(captchaData), headers, Number(options.postTimeout || UPROT_AUTO_STATE_DEFAULTS.postTimeoutMs));
    if (posted.status < 200 || posted.status >= 400) {
        return { ok: false, html: renderUprotSetupHtml({ error: `Uprot ha rifiutato il captcha. Status ${posted.status || 0}.` }) };
    }

    const mergedCookies = mergeSetCookieHeaders(session.cookies || {}, posted.response);
    const state = {
        cookies: mergedCookies,
        captchaData,
        source: 'manual:/uprot',
        targetHost: safeHost(session.bootstrapUrl),
        captchaPageUrl: session.pageUrl,
        formUrl: session.formUrl
    };
    saveUprotStateToFile(state, options);
    uprotManualSessions.delete(cleanToken);
    captchaOrchestrator.markSuccess(uprotCaptchaContext(session.bootstrapUrl, options), { cookieState: state, reason: 'manual_uprot_setup' }, uprotStateTtlMs(options));
    uprotDebug('info', 'manual setup saved', { stateFile: getUprotGeneratedStateFile(options), cookieKeys: Object.keys(mergedCookies || {}).length, formKeys: Object.keys(captchaData || {}).length });
    return {
        ok: true,
        html: renderUprotSetupHtml({
            success: 'State Uprot salvato. Ora CB01 | MaxStream può riusarlo come MammaMia.',
            detail: 'Riavvia lo stream o svuota la cache del titolo se avevi già aperto la scheda.'
        })
    };
}

async function ensureUprotAutoState(client, targetUrl, options = {}) {
    const existing = loadUprotState(options);
    if (cookieHeaderFromState(existing.cookies) && buildFormBody(existing.captchaData)) return existing;
    if (!uprotAutoStateEnabled(options)) return null;
    if (uprotMammaMiaMode(options)) {
        uprotDebug('info', 'manual state mode active; skipping live OCR auto-state', { targetHost: safeHost(targetUrl), stateReady: false });
        return null;
    }

    const context = uprotCaptchaContext(targetUrl, options);
    const ensured = await captchaOrchestrator.ensureState(
        context,
        () => generateUprotAutoState(client, targetUrl, options),
        {
            ttlMs: uprotStateTtlMs(options),
            failureTtlMs: uprotFailureTtlMs(options),
            retryBudget: envNumber('UPROT_AUTO_STATE_RETRY_BUDGET', UPROT_AUTO_STATE_DEFAULTS.retryBudget, 1, 10),
            metadata: { bootstrapHost: safeHost(getUprotBootstrapUrl(options)) }
        }
    );
    if (!ensured) return null;
    return ensured;
}

function withUprotStateOptions(options = {}, state = null) {
    if (!state) return options;
    return {
        ...options,
        uprotCookies: state.cookies || options.uprotCookies,
        uprotCaptchaData: state.captchaData || options.uprotCaptchaData
    };
}

async function resolveUprotToMaxstream(client, url, options = {}) {
    const originalUrl = normalizeRemoteUrl(url);
    const targetUrl = normalizeUprotInput(url);
    if (!targetUrl || !client) return null;

    const captchaUrl = toMsfCaptchaUrl(originalUrl || targetUrl);
    let activeOptions = options;
    let stateReady = hasUprotState(activeOptions);

    if (isMsfiUrl(targetUrl)) {
        uprotDebug('info', 'resolve start', { path: 'msfi', stateReady, autoState: uprotAutoStateEnabled(options), flareEnabled: flareEnabled(options), targetHost: safeHost(targetUrl) });
        if (!stateReady) {
            const generated = await ensureUprotAutoState(client, targetUrl, activeOptions);
            if (generated?.playerUrl) return { playerUrl: generated.playerUrl, sourceUrl: generated.sourceUrl || targetUrl, via: 'uprot-auto-captcha' };
            activeOptions = withUprotStateOptions(activeOptions, generated);
            stateReady = hasUprotState(activeOptions);
        }
        if (stateReady) {
            const posted = await resolveMsfi(client, targetUrl, activeOptions);
            if (posted) {
                captchaOrchestrator.markSuccess(uprotCaptchaContext(targetUrl, activeOptions), {
                    cookieState: loadUprotState(activeOptions),
                    reason: 'msfi_resolved'
                }, uprotStateTtlMs(activeOptions));
                return posted;
            }
            captchaOrchestrator.markFailure(uprotCaptchaContext(targetUrl, activeOptions), 'msfi_post_failed', uprotFailureTtlMs(activeOptions));
        }
        if (typeof client.get === 'function') {
            const landing = await resolveLanding(client, targetUrl, activeOptions);
            if (landing) return landing;
        }
        const fallback = stateReady ? null : await resolveMsfi(client, targetUrl, activeOptions);
        if (!fallback) uprotDebug('warn', 'resolve returned null', { path: 'msfi', stateReady, autoState: uprotAutoStateEnabled(options), flareEnabled: flareEnabled(options) });
        return fallback;
    }

    if (typeof client.get !== 'function') return null;
    uprotDebug('info', 'resolve start', { path: 'landing', stateReady, autoState: uprotAutoStateEnabled(options), targetHost: safeHost(targetUrl) });
    const landing = await resolveLanding(client, targetUrl, activeOptions);
    if (landing) return landing;

    if (!stateReady && captchaUrl) {
        const generated = await ensureUprotAutoState(client, captchaUrl, activeOptions);
        if (generated?.playerUrl) return { playerUrl: generated.playerUrl, sourceUrl: generated.sourceUrl || captchaUrl, via: 'uprot-auto-captcha' };
        activeOptions = withUprotStateOptions(activeOptions, generated);
        stateReady = hasUprotState(activeOptions);
    }

    if (stateReady) {
        const stateLanding = await resolveLanding(client, targetUrl, activeOptions);
        if (stateLanding) return stateLanding;
    }

    if (stateReady && captchaUrl) {
        uprotDebug('info', 'landing failed; trying captcha state', { targetHost: safeHost(captchaUrl), autoState: uprotAutoStateEnabled(options) });
        const posted = await resolveMsfi(client, captchaUrl, activeOptions);
        if (posted) {
            captchaOrchestrator.markSuccess(uprotCaptchaContext(captchaUrl, activeOptions), {
                cookieState: loadUprotState(activeOptions),
                reason: 'stored_or_auto_state_resolved'
            }, uprotStateTtlMs(activeOptions));
            return posted;
        }
        captchaOrchestrator.markFailure(uprotCaptchaContext(captchaUrl, activeOptions), 'stored_or_auto_state_failed', uprotFailureTtlMs(activeOptions));
    }

    uprotDebug('warn', 'resolve returned null', { path: 'landing', stateReady, autoState: uprotAutoStateEnabled(options) });
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
    prepareUprotManualChallenge,
    submitUprotManualChallenge,
    extractUprot,
    isUprotUrl,
    normalizeUprotInput,
    resolveUprotToMaxstream,
    toMaxstreamPlayerUrl,
    _test: {
        buildFormBody,
        cleanInlineDataImage,
        cookieHeaderFromState,
        extractBase64Image,
        extractCaptchaFormAction,
        extractCaptchaImageSrc,
        extractContinueLink,
        loadUprotState,
        prepareUprotManualChallenge,
        submitUprotManualChallenge,
        parseUprotTxtState,
        toMsfCaptchaUrl,
        buildUprotBootstrapCandidates,
        extractUprotPathCode,
        buildUprotForwardRequestUrl,
        withUprotPathPrefix,
        UPROT_AUTO_STATE_DEFAULTS
    }
};
