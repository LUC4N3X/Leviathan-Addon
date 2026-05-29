'use strict';

const crypto = require('crypto');
const path = require('path');
const { buildMediaflowUrl, buildWebStream, normalizeRemoteUrl } = require('../extractors/common');
const { captchaOrchestrator } = require('../../core/security/captcha_orchestrator');
const { createMediaflowGateway, getMediaflowBase } = require('../../core/proxy/mediaflow_gateway');
const { isUprotUrl, resolveUprotToMaxstream } = require('../extractors/hosters/uprot');
const { extractMaxstream } = require('../extractors/hosters/maxstream');
const { extractMixdrop } = require('../extractors/hosters/mixdrop');
const {
    buildProviderHtmlHeaders,
    createProviderCache,
    createProviderEnv,
    createProviderLogger,
    normalizeProviderBaseUrl
} = require('../utils/provider_toolkit');

let Tesseract = null;
try { Tesseract = require('tesseract.js'); } catch (_) {}

let setCookieParser = null;
try { setCookieParser = require('set-cookie-parser'); } catch (_) {}

const SAFEGO_FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';

const DEFAULT_BASE_URL = 'https://eurostream.ing';
const PROVIDER = 'Eurostreaming';
const PROVIDER_CODE = 'ES';
const SEARCH_TTL_FALLBACK_MS = 12_000;

const ES_CACHE_LIMIT = 900;
const ES_CACHE_TTL = Object.freeze({
    wpSearch: 30 * 60_000,
    siteSearch: 15 * 60_000,
    post: 30 * 60_000,
    directPage: 30 * 60_000,
    redirect: 20 * 60_000,
    deltabitSource: 10 * 60_000,
    safegoOcr: 10 * 60_000,
    safegoResolve: 20_000
});
const SAFEGO_CAPTCHA_DEFAULTS = Object.freeze({
    cookieFile: path.resolve(process.cwd(), 'config', 'safego_cookies.json'),
    captchaMinDigits: 3,
    captchaMaxDigits: 8,
    ocrMinConfidence: 0,
    ocrCacheTtlMs: ES_CACHE_TTL.safegoOcr,
    orchestratorTtlMs: 30 * 60_000,
    failureTtlMs: 90_000,
    retryBudget: 2
});
const esEnv = createProviderEnv();
const esCache = createProviderCache({
    providerName: 'eurostreaming',
    maxEntries: ES_CACHE_LIMIT,
    inflightMaxEntries: 700,
    ttlByNamespace: ES_CACHE_TTL,
    logger: (level, message, payload) => esDebug(level, message, payload)
});
const esLogger = createProviderLogger({
    prefix: 'Eurostreaming',
    enabled: true,
    debugPrefix: '[Eurostreaming:debug]'
});

function cacheNamespaceKey(namespace, parts = []) {
    return esCache.key(namespace, parts);
}

function cloneCacheValue(value) {
    return esCache.clone(value);
}

function getEsCache(namespace, parts = []) {
    return esCache.get(namespace, parts);
}

function setEsCache(namespace, parts = [], value, ttlMs) {
    return esCache.set(namespace, parts, value, ttlMs);
}

async function withEsCoalescing(namespace, parts = [], worker) {
    return esCache.withCoalescing(namespace, parts, worker);
}

function getBaseUrl() {
    return normalizeProviderBaseUrl(process.env.EUROSTREAMING_URL || process.env.ES_DOMAIN || DEFAULT_BASE_URL, DEFAULT_BASE_URL) || DEFAULT_BASE_URL;
}

function getDefaultClient() {
    try {
        const axios = require('axios');
        return axios.create({
            timeout: Number.parseInt(process.env.ES_PROVIDER_TIMEOUT || String(SEARCH_TTL_FALLBACK_MS), 10) || SEARCH_TTL_FALLBACK_MS,
            maxRedirects: 5,
            proxy: false,
            validateStatus: () => true
        });
    } catch (_) {
        return null;
    }
}

function envFlag(name, defaultValue = false) {
    return esEnv.flag(name, defaultValue);
}

function isDeltabitMfpFallbackEnabled() {

    return envFlag('EUROSTREAMING_DELTABIT_MFP_FALLBACK', false);
}

function isDeltabitMfpFirstEnabled() {

    return envFlag('EUROSTREAMING_DELTABIT_MFP_FIRST', false);
}

function getDeltabitMfpHost() {
    return String(process.env.EUROSTREAMING_DELTABIT_MFP_HOST || process.env.ES_DELTABIT_MFP_HOST || 'Deltabit').trim() || 'Deltabit';
}

function getDeltabitMfpPath() {
    return String(process.env.EUROSTREAMING_DELTABIT_MFP_PATH || process.env.ES_DELTABIT_MFP_PATH || process.env.MEDIAFLOW_EXTRACTOR_VIDEO_PATH || '/extractor/video').trim() || '/extractor/video';
}

function getMaxstreamMfpPath() {

    return '/extractor/video.m3u8';
}

function getMaxstreamRedirectStream() {

    return true;
}

function responseData(response) {
    return response?.data ?? response?.body ?? response;
}

function responseText(response) {
    const data = responseData(response);
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data || ''); }
}

function responseJson(response) {
    const data = responseData(response);
    if (data && typeof data === 'object' && !Buffer.isBuffer(data)) return data;
    try { return JSON.parse(responseText(response)); } catch (_) { return null; }
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&#215;|&#x0?d7;/gi, 'x')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTitle(value) {
    return decodeHtml(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function similarity(a, b) {
    const left = normalizeTitle(a);
    const right = normalizeTitle(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.98;

    const leftTokens = new Set(left.split(' ').filter(Boolean));
    const rightTokens = right.split(' ').filter(Boolean);
    if (!leftTokens.size || !rightTokens.length) return 0;
    const matches = rightTokens.filter((token) => leftTokens.has(token)).length;
    return matches / Math.max(leftTokens.size, rightTokens.length);
}

function extractYear(value) {
    const match = String(value || '').match(/(?<!\/)(?:19|20)\d{2}(?!\/)/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function stripYearTokens(value) {
    return normalizeTitle(value)
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleMatches(postTitle, expectedTitle, content, expectedYear) {
    const actual = normalizeTitle(postTitle);
    const expected = normalizeTitle(expectedTitle);
    if (!actual || !expected) return false;

    if (actual === expected) return true;

    const actualNoYear = stripYearTokens(postTitle);
    if (actualNoYear === expected) return true;

    if (expectedYear) {
        const year = extractYear(postTitle) || extractYear(content);
        if (year && Math.abs(Number(year) - Number(expectedYear)) <= 1 && actualNoYear === expected) return true;
    }

    return false;
}

function splitEpisodeSegments(description) {
    const raw = String(description || '');
    const withBreaks = raw
        .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '<br>')
        .replace(/<(?:p|div|li|tr|h[1-6])\b[^>]*>/gi, '<br>')
        .replace(/\r?\n/g, '<br>');

    let segments = withBreaks
        .split(/<br\s*\/?\s*>/i)
        .map((segment) => segment.trim())
        .filter(Boolean);

    if (segments.length <= 1) {
        segments = raw
            .replace(/\r?\n/g, ' ')
            .split(/(?=(?:^|\s)\d{1,2}\s*(?:x|&#215;|&#x0?d7;|\u00d7)\s*\d{1,4}(?:\b|\D))/i)
            .map((segment) => segment.trim())
            .filter(Boolean);
    }

    return segments;
}

function detectEpisodeLanguage(segment, index, previousText = '') {
    const haystack = decodeHtml(`${previousText} ${segment}`).toLowerCase();
    if (/sub\s*[- ]?ita|sottotitol/i.test(haystack)) return 'SUB-ITA';
    if (/\bita\b|italian[ao]/i.test(haystack)) return 'ITA';
    return index === 0 ? 'ITA' : 'SUB-ITA';
}

function extractEurostreamingEpisodeBlocks(description, season, episode) {
    const safeSeason = Math.max(1, Number.parseInt(String(season || 1), 10) || 1);
    const safeEpisode = Math.max(1, Number.parseInt(String(episode || 1), 10) || 1);
    const markerPatterns = [

        `(?:^|\\b)0*${safeSeason}\\s*(?:x|&#215;|&#x0?d7;|\\u00d7|×)\\s*0*${safeEpisode}(?:\\b|\\D)`,

        `(?:^|\\b)s\\s*0*${safeSeason}\\s*[-_. ]*e\\s*0*${safeEpisode}(?:\\b|\\D)`,

        `(?:^|\\b)(?:episodio|episode|ep\\.?)\\s*0*${safeEpisode}(?:\\b|\\D)`,

        `(?:^|[>\\s])0*${safeEpisode}\\s*(?:[).:-]|-)`
    ];
    const markerRes = markerPatterns.map((pattern) => new RegExp(pattern, 'i'));
    const anyEpisodeRe = /(?:^|\b)(?:s\s*\d{1,2}\s*[-_. ]*e\s*\d{1,4}|\d{1,2}\s*(?:x|&#215;|&#x0?d7;|\u00d7|×)\s*\d{1,4}|(?:episodio|episode|ep\.?)\s*\d{1,4})(?:\b|\D)/i;
    const blocks = [];
    const segments = splitEpisodeSegments(description);
    let previousText = '';

    for (const segment of segments) {
        const marker = markerRes.find((re) => re.test(segment));
        if (!marker) {
            if (!anyEpisodeRe.test(segment)) previousText = `${previousText} ${decodeHtml(segment)}`.slice(-500);
            continue;
        }

        const html = segment.replace(marker, '').replace(/^\s*[\-–—:).]+\s*/, '').trim() || segment;

        if (!extractAnchors(html).some((anchor) => /delta\s*bit|mix\s*drop|max\s*stream|uprot|adelta|amix|amax/i.test(`${anchor.label} ${anchor.href}`))) {
            if (!markerPatterns.slice(0, 3).some((pattern) => new RegExp(pattern, 'i').test(segment)) && !/x|episodio|episode|ep\.?/i.test(segment)) continue;
        }
        blocks.push({
            html,
            language: detectEpisodeLanguage(segment, blocks.length, previousText)
        });
    }

    if (!blocks.length) {
        const anchors = extractAnchors(description);
        const hostAnchors = anchors.filter((anchor) => /delta\s*bit|mix\s*drop|max\s*stream|uprot|adelta|amix|amax/i.test(`${anchor.label} ${anchor.href}`));
        if (hostAnchors.length && !anyEpisodeRe.test(decodeHtml(description))) {
            blocks.push({ html: description, language: detectEpisodeLanguage(description, 0, '') });
        }
    }

    return blocks;
}
function extractAnchors(html) {
    const anchors = [];
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig;
    for (const match of String(html || '').matchAll(re)) {
        const href = normalizeRemoteUrl(match?.[1]);
        const label = decodeHtml(match?.[2]);
        if (!href || !label) continue;
        anchors.push({ href, label });
    }
    return anchors;
}

function findFirstUprotAnchor(anchors = []) {
    return anchors.find((anchor) => isUprotUrl(anchor?.href)) || null;
}

function pickHostLinks(blockHtml) {
    const anchors = extractAnchors(blockHtml);
    const deltabitLinks = [];
    const mixdropLinks = [];
    const maxstreamLinks = [];
    const seen = new Set();
    const companionUprot = findFirstUprotAnchor(anchors);
    const pushLink = (bucket, link) => {
        const key = `${link.host}:${link.href}`;
        if (seen.has(key)) return;
        seen.add(key);
        bucket.push(link);
    };

    for (const anchor of anchors) {
        const href = anchor.href;
        const label = anchor.label;
        const labelSaysDeltabit = /delta\s*bit/i.test(label) || /turbovid/i.test(label);
        const looksLikeDeltabit = labelSaysDeltabit || /\/adelta\//i.test(href) || /\/delta\//i.test(href) || isDeltabitLikeUrl(href);
        const looksLikeMixdrop = /mix\s*drop/i.test(label) || /\/amix\//i.test(href) || /\/mix\//i.test(href) || /mixdrop|m1xdrop|mxcontent|mixdrp/i.test(href);
        const looksLikeMaxstream = /max\s*stream|uprot/i.test(label) || /\/amax\//i.test(href) || /uprot\.net|maxstream\.video|stayonline\.pro/i.test(href);

        if (looksLikeDeltabit) {

            if (labelSaysDeltabit ? /^https?:\/\//i.test(href) : (isDeltabitLikeUrl(href) || REDIRECTOR_RE.test(href))) {
                pushLink(deltabitLinks, { host: 'deltabit', label: 'DeltaBit', href });
            }
            continue;
        }

        if (looksLikeMixdrop) {
            if (isMixdropUrl(href) || REDIRECTOR_RE.test(href)) {
                pushLink(mixdropLinks, { host: 'mixdrop', label: 'MixDrop', href });
            }
            continue;
        }

        if (looksLikeMaxstream) {
            if (envFlag('EUROSTREAMING_SKIP_MAXSTREAM_LINK', false)) continue;
            const maxstreamHref = (isUprotUrl(href) || isMaxstreamLikeUrl(href) || REDIRECTOR_RE.test(href))
                ? href
                : companionUprot?.href;
            if (maxstreamHref) {
                pushLink(maxstreamLinks, { host: 'maxstream', label: 'MaxStream', href: maxstreamHref });
            }
        }
    }

    return [...deltabitLinks, ...mixdropLinks, ...maxstreamLinks];
}

const CLICKA_RE = /clicka\./i;
const SAFEGO_RE = /safego\./i;
const REDIRECTOR_RE = /(?:safego|clicka)\./i;
const MIXDROP_URL_RE = /https?:\/\/(?:www\.)?(?:mixdrop|m1xdrop|mxcontent|mixdrp)[^"'<>\s\\]+/i;
const DELTABIT_URL_RE = /https?:\/\/(?:www\.)?(?:deltabit\.[a-z.]+|loadm\.cam|turbovid\.[a-z.]+)[^"'<>\s\\]+/i;
const MAXSTREAM_URL_RE = /https?:\/\/(?:www\.)?(?:uprot\.net|maxstream\.video|stayonline\.pro|maxstream)[^"'<>\s\\]+/i;
const HOSTER_URL_RE = /https?:\/\/(?:www\.)?(?:mixdrop|m1xdrop|mxcontent|mixdrp|deltabit\.[a-z.]+|loadm\.cam|turbovid\.[a-z.]+|uprot\.net|maxstream\.video|stayonline\.pro|maxstream)[^"'<>\s\\]+/i;
const DIRECT_MEDIA_URL_RE = /https?:\/\/[^"'<>\s\\]+\.(?:m3u8|mp4|mkv|webm)(?:\?[^"'<>\s\\]*)?/i;
const REDIRECTOR_URL_RE = /https?:\/\/(?:www\.)?(?:safego|clicka)\.[^"'<>\s\\]+/i;
const STATIC_ASSET_RE = /(?:^|\/)(?:assets?|css|fonts?|images?|img|js|scripts?|static)\//i;
const STATIC_EXTENSION_RE = /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|txt|xml)(?:$|[?#])/i;

function isStaticAssetUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        const path = decodeURIComponent(parsed.pathname || '');
        return STATIC_ASSET_RE.test(path) || STATIC_EXTENSION_RE.test(path);
    } catch (_) {
        return false;
    }
}

function isMixdropUrl(value) {
    return MIXDROP_URL_RE.test(String(value || ''));
}

function normalizeMixdropForExtractor(value) {
    const normalized = normalizeRemoteUrl(value);
    if (!normalized || !isMixdropUrl(normalized)) return null;
    try {
        const parsed = new URL(normalized);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const fileId = parts.length >= 2 && /^(?:e|emb|embed|f|file|watch|video)$/i.test(parts[0])
            ? parts[1]
            : parts.length === 1 ? parts[0] : '';
        if (!fileId) return normalized;
        parsed.pathname = `/e/${fileId}`;
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return normalized
            .replace('/emb/', '/e/')
            .replace('/embed/', '/e/')
            .replace('/f/', '/e/')
            .replace('/file/', '/e/')
            .replace('/watch/', '/e/')
            .replace('/video/', '/e/');
    }
}

function isDeltabitLikeUrl(value) {
    return DELTABIT_URL_RE.test(String(value || ''));
}

function isDirectMediaUrl(value) {
    return DIRECT_MEDIA_URL_RE.test(String(value || ''));
}

function isProbablyPlayableMediaUrl(value) {
    const normalized = normalizeRemoteUrl(value);
    if (!normalized || !/^https?:\/\//i.test(normalized)) return false;
    if (isStaticAssetUrl(normalized)) return false;
    try {
        const parsed = new URL(normalized);
        const pathname = decodeURIComponent(parsed.pathname || '');
        if (/(?:site\.webmanifest|manifest\.json|favicon|apple-touch-icon)/i.test(pathname)) return false;
        if (/(?:^|\/)(?:images?|img|assets?|static|css|js|fonts?)\//i.test(pathname)) return false;
    } catch (_) {
        return false;
    }
    return isDirectMediaUrl(normalized);
}

function isMaxstreamLikeUrl(value) {
    return MAXSTREAM_URL_RE.test(String(value || ''));
}

function isUsableRedirectCandidate(value) {
    const normalized = normalizeRemoteUrl(value);
    if (!normalized) return false;
    return !isStaticAssetUrl(normalized);
}

function parseLooseObject(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    const raw = String(value || '').trim();
    if (!raw) return null;
    const attempts = [
        raw,
        raw.replace(/'/g, '"'),
        raw.replace(/([{,]\s*)([A-Za-z0-9_.$-]+)\s*:/g, '$1"$2":').replace(/'/g, '"')
    ];
    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_) {}
    }
    return null;
}

function cookiesToHeader(cookies) {
    if (!cookies) return '';
    if (typeof cookies === 'string') return cookies.trim();
    if (typeof cookies !== 'object') return '';
    return Object.entries(cookies)
        .filter(([key, value]) => key && value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
}

function loadJsonLikeFile(filePath) {
    const fs = require('fs');
    const targetPath = String(filePath || '').trim();
    if (!targetPath) return null;
    try {
        if (!fs.existsSync(targetPath)) return null;
        return fs.readFileSync(targetPath, 'utf8');
    } catch (_) {
        return null;
    }
}

function getSafegoCookiePath(options = {}) {
    return options.safegoCookieFile
        || process.env.SAFEGO_COOKIE_FILE
        || SAFEGO_CAPTCHA_DEFAULTS.cookieFile;
}

function loadSafegoState(options = {}) {
    let cookies = options.safegoCookies
        || parseLooseObject(process.env.SAFEGO_COOKIES_JSON)
        || parseLooseObject(process.env.SAFEGO_COOKIES);
    let captchaData = options.safegoCaptchaData
        || parseLooseObject(process.env.SAFEGO_CAPTCHA_DATA_JSON)
        || parseLooseObject(process.env.SAFEGO_CAPTCHA_DATA);

    const stateJson = options.safegoStateJson || process.env.SAFEGO_STATE_JSON;
    const state = parseLooseObject(stateJson);
    if (state) {
        cookies = cookies || state.cookies || state.cookie || state;
        captchaData = captchaData || state.captchaData || state.data || state.captcha || null;
    }

    const stateFile = options.safegoStateFile || process.env.SAFEGO_STATE_FILE;
    const fileText = loadJsonLikeFile(stateFile);
    if (fileText) {
        const full = parseLooseObject(fileText);
        if (full) {
            cookies = cookies || full.cookies || full.cookie || full;
            captchaData = captchaData || full.captchaData || full.data || full.captcha || null;
        } else {
            const lines = fileText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            cookies = cookies || parseLooseObject(lines[0]);
            captchaData = captchaData || parseLooseObject(lines[1]);
        }
    }

    const cookieFile = getSafegoCookiePath(options);
    const cookieText = loadJsonLikeFile(cookieFile);
    if (!cookies && cookieText) cookies = parseLooseObject(cookieText) || cookieText.trim();

    if (captchaData && typeof captchaData === 'object' && !Array.isArray(captchaData)) {
        if (captchaData.captcha && !captchaData.captch5) captchaData = { ...captchaData, captch5: captchaData.captcha };
    }

    return { cookies: cookies || {}, captchaData };
}

function saveSafegoState(cookies, options = {}) {
    const fs = require('fs');
    const filePath = getSafegoCookiePath(options);
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(cookies, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
        esDebug('info', 'safego cookies saved', { path: filePath, cookieKeys: Object.keys(cookies || {}).length });
    } catch (err) {
        esDebug('warn', 'failed to save safego cookies', { error: err?.message || String(err) });
    }
}

function mergeCookieHeader(headers, cookies) {
    const cookieHeader = cookiesToHeader(cookies);
    if (!cookieHeader) return headers;
    return { ...headers, Cookie: cookieHeader };
}

function mergeSetCookieHeaders(existingCookies, response) {
    const merged = { ...(existingCookies || {}) };
    const rawHeaders = response?.headers?.['set-cookie'] || response?.headers?.['Set-Cookie'];
    if (!rawHeaders) return merged;

    if (setCookieParser) {
        const parsed = setCookieParser.parse(
            Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders],
            { decodeValues: true }
        );
        for (const cookie of parsed) {
            if (cookie.name) merged[cookie.name] = cookie.value;
        }
    } else {
        const list = Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders];
        for (const raw of list) {
            const pair = String(raw || '').split(';')[0]?.trim();
            const eq = pair.indexOf('=');
            if (eq > 0) merged[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
    }
    return merged;
}

function extractAnchorHref(html) {
    const match = String(html || '').match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    return match?.[1] ? normalizeRemoteUrl(match[1]) : null;
}

function extractCaptchaBase64(html) {
    const match = String(html || '').match(/<img\b[^>]+src=["'](data:image\/[^;]+;base64,([^"']+))["']/i);
    if (!match) return null;
    return { dataUri: match[1], base64: match[2] };
}

function sha1(value) {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function numberFromEnv(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const raw = process.env[name];
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function validateSafegoCaptchaDigits(value) {
    const digits = String(value || '').replace(/\D/g, '').trim();
    const minDigits = numberFromEnv('SAFEGO_CAPTCHA_MIN_DIGITS', SAFEGO_CAPTCHA_DEFAULTS.captchaMinDigits, 1, 12);
    const maxDigits = numberFromEnv('SAFEGO_CAPTCHA_MAX_DIGITS', SAFEGO_CAPTCHA_DEFAULTS.captchaMaxDigits, minDigits, 16);
    if (digits.length < minDigits || digits.length > maxDigits) {
        esDebug('warn', 'OCR captcha rejected by length guard', { length: digits.length, minDigits, maxDigits });
        return null;
    }
    return digits;
}

async function solveCaptchaOCR(base64Data) {
    if (!Tesseract) {
        esDebug('warn', 'tesseract.js not available, cannot solve SafeGo CAPTCHA');
        return null;
    }

    const hash = sha1(base64Data);
    const cached = getEsCache('safegoOcr', [hash]);
    if (cached) {
        esDebug('info', 'OCR captcha cache hit', { hash: hash.slice(0, 10), digits: cached });
        return cached;
    }

    let worker = null;
    try {
        const imageBuffer = Buffer.from(base64Data, 'base64');
        worker = await Tesseract.createWorker('eng');
        await worker.setParameters({
            tessedit_char_whitelist: '0123456789',
            tessedit_pageseg_mode: '7'
        });
        const { data: { text, confidence } } = await worker.recognize(imageBuffer);
        const digits = validateSafegoCaptchaDigits(text);
        esDebug('info', 'OCR captcha result', { raw: text?.trim(), digits, confidence });
        if (!digits) return null;

        const minConfidence = numberFromEnv('SAFEGO_OCR_MIN_CONFIDENCE', SAFEGO_CAPTCHA_DEFAULTS.ocrMinConfidence, 0, 100);
        if (minConfidence > 0 && Number.isFinite(confidence) && confidence < minConfidence) {
            esDebug('warn', 'OCR captcha rejected by confidence guard', { confidence, minConfidence });
            return null;
        }

        setEsCache('safegoOcr', [hash], digits, numberFromEnv('SAFEGO_OCR_CACHE_TTL_MS', SAFEGO_CAPTCHA_DEFAULTS.ocrCacheTtlMs, 1_000, 30 * 60_000));
        return digits;
    } catch (err) {
        esDebug('warn', 'OCR captcha failed', { error: err?.message || String(err) });
        return null;
    } finally {
        if (worker && typeof worker.terminate === 'function') {
            try { await worker.terminate(); } catch (_) {}
        }
    }
}

function buildSafegoHeaders(safegoUrl) {
    const origin = (() => { try { return new URL(safegoUrl).origin; } catch (_) { return 'https://safego.cc'; } })();
    return buildProviderHtmlHeaders({
        userAgent: SAFEGO_FIREFOX_UA,
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        origin,
        referer: safegoUrl
    });
}


function safegoCaptchaContext(safegoUrl) {
    return {
        provider: 'eurostreaming',
        hoster: 'safego',
        captchaType: 'image-ocr',
        scope: normalizeRemoteUrl(safegoUrl) || safeHost(safegoUrl) || 'safego'
    };
}

function safegoOrchestratorTtl() {
    return numberFromEnv('SAFEGO_ORCHESTRATOR_TTL_MS', SAFEGO_CAPTCHA_DEFAULTS.orchestratorTtlMs, 5_000, 24 * 60 * 60_000);
}

function markSafegoCaptchaSuccess(context, cookies, reason = 'resolved', options = {}) {
    captchaOrchestrator.markSuccess(context, {
        cookieState: {
            cookies: cookies || {},
            captchaData: null
        },
        reason,
        retryBudget: numberFromEnv('SAFEGO_RETRY_BUDGET', SAFEGO_CAPTCHA_DEFAULTS.retryBudget, 1, 10)
    }, Number(options.safegoStateTtlMs || safegoOrchestratorTtl()));
}

function markSafegoCaptchaFailure(context, reason = 'failed') {
    captchaOrchestrator.markFailure(context, reason, numberFromEnv('SAFEGO_FAILURE_TTL_MS', SAFEGO_CAPTCHA_DEFAULTS.failureTtlMs, 5_000, 15 * 60_000));
}

function returnSafegoSuccess(context, cookies, result, reason, options = {}) {
    saveSafegoState(cookies, options);
    markSafegoCaptchaSuccess(context, cookies, reason, options);
    return result;
}

async function postSafegoWithCookies(client, url, headers, cookies) {
    if (!client || typeof client.post !== 'function') return null;
    const postHeaders = mergeCookieHeader(headers, cookies);
    try {
        return await client.post(url, '', {
            headers: { ...postHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true
        });
    } catch (_) {
        return null;
    }
}

async function getSafegoPage(client, url, headers) {
    if (!client || typeof client.get !== 'function') return null;
    try {
        return await client.get(url, {
            headers,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true
        });
    } catch (_) {
        return null;
    }
}

async function postSafegoCaptcha(client, url, headers, cookies, captchaCode) {
    if (!client || typeof client.post !== 'function') return null;
    const postHeaders = mergeCookieHeader(headers, cookies);

    const body = `captch5=${encodeURIComponent(captchaCode)}`;
    try {
        return await client.post(url, body, {
            headers: { ...postHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true
        });
    } catch (_) {
        return null;
    }
}

async function resolveSafegoPage(client, safegoUrl, _headers, options = {}) {
    const context = safegoCaptchaContext(safegoUrl);
    if (!options.__safegoCoalesced) {
        return captchaOrchestrator.singleFlight(context, () => resolveSafegoPage(client, safegoUrl, _headers, { ...options, __safegoCoalesced: true }));
    }

    const budget = captchaOrchestrator.shouldAttempt(context, numberFromEnv('SAFEGO_RETRY_BUDGET', SAFEGO_CAPTCHA_DEFAULTS.retryBudget, 1, 10));
    if (!budget.ok) {
        esDebug('warn', 'safego skipped by captcha orchestrator', { reason: budget.reason, failures: budget.record?.failures || 0 });
        return null;
    }

    const state = loadSafegoState(options);
    let cookies = state.cookies || {};
    const orchestratedState = captchaOrchestrator.get(context);
    if (!Object.keys(cookies || {}).length && orchestratedState?.cookieState?.cookies) {
        cookies = orchestratedState.cookieState.cookies;
    }
    const headers = buildSafegoHeaders(safegoUrl);

    esDebug('info', 'safego step 1: POST with saved cookies', { url: safegoUrl, hasCookies: Object.keys(cookies).length > 0 });
    const response1 = await postSafegoWithCookies(client, safegoUrl, headers, cookies);
    if (response1) {
        cookies = mergeSetCookieHeaders(cookies, response1);

        const finalUrl1 = finalResponseUrl(response1, safegoUrl);
        if (finalUrl1 && finalUrl1 !== safegoUrl && !SAFEGO_RE.test(finalUrl1)) {
            return returnSafegoSuccess(context, cookies, finalUrl1, 'saved_cookies_redirect', options);
        }

        const html1 = responseText(response1);
        const anchor1 = extractAnchorHref(html1);
        if (anchor1 && !SAFEGO_RE.test(anchor1)) {
            esDebug('info', 'safego resolved via anchor (saved cookies)', { anchor: anchor1 });
            return returnSafegoSuccess(context, cookies, anchor1, 'saved_cookies_anchor', options);
        }

        if (/The requested URL was not found on this server/i.test(html1)) {
            esDebug('warn', 'safego: URL not found on server');
            markSafegoCaptchaFailure(context, 'url_not_found');
            return null;
        }
    }

    esDebug('info', 'safego step 2: GET for CAPTCHA page');
    const getHeaders = {
        'User-Agent': SAFEGO_FIREFOX_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };
    const getCaptchaResponse = await getSafegoPage(client, safegoUrl, getHeaders);
    if (!getCaptchaResponse) {
        saveSafegoState(cookies, options);
        markSafegoCaptchaFailure(context, 'captcha_page_missing');
        return null;
    }

    const getCookies = mergeSetCookieHeaders({}, getCaptchaResponse);
    esDebug('info', 'safego GET cookies', { cookieKeys: Object.keys(getCookies) });

    const captchaHtml = responseText(getCaptchaResponse);
    const captchaData = extractCaptchaBase64(captchaHtml);
    if (!captchaData) {

        const candidate = extractRedirectCandidate(captchaHtml, safegoUrl);
        if (candidate && !SAFEGO_RE.test(candidate)) {
            return returnSafegoSuccess(context, cookies, candidate, 'captcha_page_candidate', options);
        }
        const anchor = extractAnchorHref(captchaHtml);
        if (anchor && !SAFEGO_RE.test(anchor)) {
            return returnSafegoSuccess(context, cookies, anchor, 'captcha_page_anchor', options);
        }
        esDebug('warn', 'safego: no CAPTCHA image found on GET page');
        saveSafegoState(cookies, options);
        markSafegoCaptchaFailure(context, 'captcha_image_missing');
        return null;
    }

    esDebug('info', 'safego step 3: OCR CAPTCHA');
    const captchaCode = await solveCaptchaOCR(captchaData.base64);
    if (!captchaCode) {
        esDebug('warn', 'safego: OCR failed or returned empty');
        saveSafegoState(cookies, options);
        markSafegoCaptchaFailure(context, 'ocr_failed');
        return null;
    }

    esDebug('info', 'safego step 4: POST captch5', { code: captchaCode, cookieKeys: Object.keys(getCookies) });
    const captchaPostHeaders = {
        ...headers,
        'Origin': 'https://safego.cc',
        'Referer': safegoUrl
    };
    const response2 = await postSafegoCaptcha(client, safegoUrl, captchaPostHeaders, getCookies, captchaCode);
    if (response2) {

        const updatedCookies = mergeSetCookieHeaders(getCookies, response2);

        Object.assign(cookies, updatedCookies);
        saveSafegoState(cookies, options);

        const finalUrl2 = finalResponseUrl(response2, safegoUrl);
        if (finalUrl2 && finalUrl2 !== safegoUrl && !SAFEGO_RE.test(finalUrl2)) {
            return returnSafegoSuccess(context, cookies, finalUrl2, 'ocr_redirect', options);
        }

        const html2 = responseText(response2);
        const anchor2 = extractAnchorHref(html2);
        if (anchor2 && !SAFEGO_RE.test(anchor2)) {
            esDebug('info', 'safego resolved via anchor (post-captcha)', { anchor: anchor2 });
            return returnSafegoSuccess(context, cookies, anchor2, 'ocr_anchor', options);
        }
        const candidate2 = extractRedirectCandidate(html2, safegoUrl);
        if (candidate2 && !SAFEGO_RE.test(candidate2)) {
            return returnSafegoSuccess(context, cookies, candidate2, 'ocr_candidate', options);
        }

        esDebug('warn', 'safego: captch5 POST did not yield a link, attempting retry with merged cookies');

        const response3 = await postSafegoWithCookies(client, safegoUrl, headers, cookies);
        if (response3) {
            cookies = mergeSetCookieHeaders(cookies, response3);
            saveSafegoState(cookies, options);

            const finalUrl3 = finalResponseUrl(response3, safegoUrl);
            if (finalUrl3 && finalUrl3 !== safegoUrl && !SAFEGO_RE.test(finalUrl3)) {
                return returnSafegoSuccess(context, cookies, finalUrl3, 'ocr_retry_redirect', options);
            }

            const html3 = responseText(response3);
            const anchor3 = extractAnchorHref(html3);
            if (anchor3 && !SAFEGO_RE.test(anchor3)) {
                esDebug('info', 'safego resolved via anchor (post-captcha retry)', { anchor: anchor3 });
                return returnSafegoSuccess(context, cookies, anchor3, 'ocr_retry_anchor', options);
            }
            const candidate3 = extractRedirectCandidate(html3, safegoUrl);
            if (candidate3 && !SAFEGO_RE.test(candidate3)) {
                return returnSafegoSuccess(context, cookies, candidate3, 'ocr_retry_candidate', options);
            }
        }
    }

    saveSafegoState(cookies, options);
    markSafegoCaptchaFailure(context, 'resolved_link_missing');
    return null;
}

function safeDecodeUriComponent(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch (_) {
        return String(value || '');
    }
}

function compactRedirectCandidate(value, baseUrl) {
    if (!value) return null;
    const cleaned = String(value)
        .replace(/&amp;/g, '&')
        .replace(/\\\//g, '/')
        .replace(/\\u0026/g, '&')
        .replace(/\\/g, '')
        .trim();
    const attempts = Array.from(new Set([cleaned, safeDecodeUriComponent(cleaned)]));
    for (const attempt of attempts) {
        const normalized = normalizeRemoteUrl(attempt, baseUrl);
        if (isUsableRedirectCandidate(normalized)) return normalized;
    }
    return null;
}

function decodeBase64Maybe(value) {
    const raw = String(value || '').trim();
    if (!raw || !/^[A-Za-z0-9+/=_-]{8,}$/.test(raw)) return null;
    try {
        const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
        const padding = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
        const decoded = Buffer.from(normalized + padding, 'base64').toString('utf8').trim();
        return /^(?:https?:\/\/|\/)/i.test(decoded) ? decoded : null;
    } catch (_) {
        return null;
    }
}

function redirectParamCandidate(targetUrl) {
    try {
        const parsed = new URL(String(targetUrl || ''));
        for (const key of ['url', 'u', 'link']) {
            const value = parsed.searchParams.get(key);
            if (!value) continue;
            const direct = /^(?:https?:\/\/|\/)/i.test(value)
                ? compactRedirectCandidate(value, parsed.origin)
                : null;
            if (direct && direct !== parsed.toString()) return direct;
            const decoded = decodeBase64Maybe(value);
            const fromBase64 = compactRedirectCandidate(decoded, parsed.origin);
            if (fromBase64 && fromBase64 !== parsed.toString()) return fromBase64;
        }
    } catch (_) {
        return null;
    }
    return null;
}

function firstRedirectCandidate(text, pattern, baseUrl) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    for (const match of String(text || '').matchAll(re)) {
        const candidate = compactRedirectCandidate(match?.[1], baseUrl);
        if (candidate) return candidate;
    }
    return null;
}

function extractRedirectCandidate(html, baseUrl) {
    const text = String(html || '');
    const directHoster = compactRedirectCandidate(text.match(HOSTER_URL_RE)?.[0], baseUrl);
    if (directHoster) return directHoster;

    const patterns = [
        /<meta\b[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)["']/i,
        /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
        /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
        /data-(?:href|url|link)=["']([^"']+)["']/i,
        /href=["']([^"']+)["']/i,
        /(?:url|u|link)=((?:https?:|%68%74%74%70)[^"'<>\s]+)/i
    ];

    for (const pattern of patterns) {
        const candidate = firstRedirectCandidate(text, pattern, baseUrl);
        if (candidate) return candidate;
    }

    return compactRedirectCandidate(text.match(REDIRECTOR_URL_RE)?.[0], baseUrl);
}

function finalResponseUrl(response, fallback) {
    return normalizeRemoteUrl(
        response?.headers?.location
        || response?.request?.res?.responseUrl
        || response?.request?._redirectable?._currentUrl
        || response?.url,
        fallback
    );
}

async function resolveRedirectLink(client, href, referer, options = {}) {
    const normalized = normalizeRemoteUrl(href);
    if (!normalized || !REDIRECTOR_RE.test(normalized)) return normalized;
    if (!client || typeof client.get !== 'function') return normalized;

    let current = normalized;
    const headers = {
        Referer: referer || getBaseUrl(),
        'User-Agent': SAFEGO_FIREFOX_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    for (let hop = 0; hop < 6; hop += 1) {
        const paramCandidate = redirectParamCandidate(current);
        if (paramCandidate && paramCandidate !== current) {
            current = paramCandidate;
            if (!REDIRECTOR_RE.test(current)) return current;
        }

        if (SAFEGO_RE.test(current)) {
            const origin = (() => { try { return new URL(current).origin; } catch (_) { return ''; } })();
            const safegoCandidate = await resolveSafegoPage(client, current, { ...headers, Origin: origin, Referer: current }, options);
            if (safegoCandidate) {
                if (!REDIRECTOR_RE.test(safegoCandidate)) return safegoCandidate;
                current = safegoCandidate;
                continue;
            }
        }

        try {
            const attempts = CLICKA_RE.test(current)
                ? [
                    { ...headers, Range: 'bytes=0-0' },
                    headers
                ]
                : [headers];

            let advanced = false;
            for (const requestHeaders of attempts) {
                const response = await client.get(current, {
                    headers: requestHeaders,
                    maxRedirects: 5,
                    responseType: 'text',
                    validateStatus: () => true
                });
                const finalUrl = finalResponseUrl(response, current);
                if (finalUrl && finalUrl !== current) {
                    current = finalUrl.replace(/%20/g, '');
                    advanced = true;
                    if (!REDIRECTOR_RE.test(current)) return current;
                    if (SAFEGO_RE.test(current)) {
                        const origin = (() => { try { return new URL(current).origin; } catch (_) { return ''; } })();
                        const safegoCandidate = await resolveSafegoPage(client, current, { ...headers, Origin: origin, Referer: current }, options);
                        if (safegoCandidate) {
                            current = safegoCandidate.replace(/%20/g, '');
                            advanced = true;
                            if (!REDIRECTOR_RE.test(current)) return current;
                            break;
                        }
                    }
                    break;
                }

                const nextUrl = extractRedirectCandidate(responseText(response), current);
                if (nextUrl && nextUrl !== current) {
                    current = nextUrl.replace(/%20/g, '');
                    advanced = true;
                    if (!REDIRECTOR_RE.test(current)) return current;
                    break;
                }
            }
            if (!advanced) break;
        } catch (error) {
            const finalUrl = finalResponseUrl(error?.response, current);
            if (finalUrl && finalUrl !== current) return finalUrl;
            break;
        }
    }

    return current;
}

async function resolveRedirectLinkCached(client, href, referer, options = {}) {
    const normalized = normalizeRemoteUrl(href);
    if (!normalized || !REDIRECTOR_RE.test(normalized)) return normalized;
    const cacheKey = [safeHost(normalized), safePath(normalized), normalized, safeHost(referer || getBaseUrl())];
    const cached = getEsCache('redirect', cacheKey);
    if (cached) {
        esDebug('info', 'redirect cache hit', { fromHost: safeHost(normalized), toHost: safeHost(cached), toPath: safePath(cached) });
        return cached;
    }
    const resolved = await withEsCoalescing('redirect', cacheKey, () => resolveRedirectLink(client, normalized, referer, options));
    if (resolved && resolved !== normalized && !REDIRECTOR_RE.test(resolved)) {
        setEsCache('redirect', cacheKey, resolved, ES_CACHE_TTL.redirect);
        esDebug('info', 'redirect cache saved', { fromHost: safeHost(normalized), toHost: safeHost(resolved), toPath: safePath(resolved) });
    }
    return resolved;
}

function extractFormFields(html) {
    const fields = {};
    const inputRe = /<input\b[^>]*>/ig;
    for (const input of String(html || '').match(inputRe) || []) {
        const name = input.match(/\bname=["']([^"']+)["']/i)?.[1];
        if (!name) continue;
        const value = input.match(/\bvalue=["']([^"']*)["']/i)?.[1] || '';
        fields[name] = decodeHtml(value);
    }
    return fields;
}

function extractDeltabitSource(html, baseUrl = null) {
    const text = String(html || '').replace(/\x00/g, '');

    const primary = text.match(/sources\s*:\s*\[\s*["']([^"']+)["']/is);
    const primaryUrl = compactRedirectCandidate(primary?.[1], baseUrl);
    if (isProbablyPlayableMediaUrl(primaryUrl)) return primaryUrl;

    const fallbackPatterns = [
        /sources\s*:\s*\[\s*\{[\s\S]{0,300}?(?:file|src)\s*:\s*["']([^"']+)["']/i,
        /(?:file|src)\s*:\s*["']([^"']+)["']/i,
        /<source\b[^>]+src=["']([^"']+)["']/i,
        /["'](https?:\/\/[^"']+\.(?:m3u8|mp4|mkv|webm)[^"']*)["']/i
    ];
    for (const pattern of fallbackPatterns) {
        const candidate = compactRedirectCandidate(text.match(pattern)?.[1], baseUrl);
        if (isProbablyPlayableMediaUrl(candidate)) return candidate;
    }
    const direct = compactRedirectCandidate(text.match(DIRECT_MEDIA_URL_RE)?.[0], baseUrl);
    return isProbablyPlayableMediaUrl(direct) ? direct : null;
}

function extractFormFieldsRaw(html) {

    const fields = {};
    const inputRe = /<input\b[^>]*>/ig;
    for (const input of String(html || '').match(inputRe) || []) {
        const name = input.match(/\bname=["']([^"']+)["']/i)?.[1];
        if (!name) continue;
        const raw = input.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? '';
        fields[name] = raw
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;|&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
    }
    return fields;
}

function isHosterPageUrl(value) {
    return isDeltabitLikeUrl(value) && !REDIRECTOR_RE.test(String(value || ''));
}

function isDeltabitClickaEntry(value) {
    const text = String(value || '');
    return CLICKA_RE.test(text) && /\/(?:a)?delta\//i.test(text);
}

function isDeltabitEntryUrl(value) {
    return isHosterPageUrl(value) || isDeltabitClickaEntry(value);
}

async function chaseToHosterPage(client, href, referer, options = {}) {
    let current = normalizeRemoteUrl(href);
    if (!current || !client || typeof client.get !== 'function') return null;
    if (isDeltabitEntryUrl(current)) return current;

    if (REDIRECTOR_RE.test(current)) {
        const resolved = await resolveRedirectLinkCached(client, current, referer || getBaseUrl(), options);

        if (resolved && isDeltabitEntryUrl(resolved)) return resolved;
        esDebug('warn', 'deltabit redirect chain did not reach hoster', { fromHost: safeHost(current), toHost: safeHost(resolved), toPath: safePath(resolved) });
        return null;
    }

    const headers = {
        Referer: referer || getBaseUrl(),
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    for (let hop = 0; hop < 5; hop += 1) {
        if (isHosterPageUrl(current)) return current;
        if (REDIRECTOR_RE.test(current)) {
            const resolved = await resolveRedirectLinkCached(client, current, referer || getBaseUrl(), options);
            if (resolved && isDeltabitEntryUrl(resolved)) return resolved;
            esDebug('warn', 'deltabit redirect chain did not reach hoster', { fromHost: safeHost(current), toHost: safeHost(resolved), toPath: safePath(resolved) });
            return null;
        }
        const paramCandidate = redirectParamCandidate(current);
        if (paramCandidate && paramCandidate !== current) { current = paramCandidate; continue; }

        let response;
        try {
            response = await client.get(current, {
                headers: { ...headers, Range: 'bytes=0-0' },
                maxRedirects: 5, responseType: 'text', validateStatus: () => true
            });
        } catch (error) {
            const failUrl = finalResponseUrl(error?.response, current);
            if (failUrl && failUrl !== current) { current = failUrl.replace(/%20/g, ''); continue; }
            return null;
        }
        const finalUrl = finalResponseUrl(response, current);
        if (finalUrl && finalUrl !== current) { current = finalUrl.replace(/%20/g, ''); continue; }
        const body = responseText(response);
        const next = extractRedirectCandidate(body, current) || extractAnchorHref(body);
        if (next && next !== current && !isStaticAssetUrl(next)) { current = next; continue; }
        break;
    }

    return isDeltabitEntryUrl(current) ? current : null;
}

function encodeFormBody(data) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data || {})) {
        if (key === undefined || key === null) continue;
        params.append(String(key), value == null ? '' : String(value));
    }
    return params.toString();
}

function extractSubmitButtons(html) {
    const buttons = [];
    const text = String(html || '');
    const tagRe = /<(?:input|button)\b[^>]*>/ig;
    for (const tag of text.match(tagRe) || []) {
        const type = tag.match(/\btype=["']?([^"'\s>]+)/i)?.[1]?.toLowerCase() || '';
        if (type && type !== 'submit' && !/^<button/i.test(tag)) continue;
        const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1] || tag.match(/\bname=([^\s>]+)/i)?.[1] || '';
        let value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1];
        if (value == null) value = tag.match(/\bvalue=([^\s>]+)/i)?.[1] || '';
        const label = decodeHtml(value || tag.replace(/<[^>]+>/g, ''));
        if (!name && !label) continue;
        buttons.push({ name: decodeHtml(name), value: decodeHtml(value || ''), label });
    }
    return buttons;
}

function buildDeltabitPostPayloads(fields, html, extractor, pageUrl, options = {}) {
    const base = { ...fields, referer: pageUrl };
    const submitButtons = extractSubmitButtons(html);
    const seen = new Set();
    const payloads = [];
    const addPayload = (data, reason) => {
        const normalized = { ...base, ...data };
        const key = JSON.stringify(Object.keys(normalized).sort().map((k) => [k, normalized[k]]));
        if (seen.has(key)) return;
        seen.add(key);
        payloads.push({ data: normalized, reason });
    };

    addPayload({ imhuman: extractor === 'Turbovid' ? 'Proceed+to+video' : (options.deltabitImhuman ?? '') }, 'mammamia-imhuman');

    const preferred = submitButtons.filter((button) => /guarda|stream|watch|video/i.test(`${button.name} ${button.value} ${button.label}`));
    const others = submitButtons.filter((button) => !preferred.includes(button));
    for (const button of [...preferred, ...others].slice(0, 4)) {
        if (!button.name) continue;
        addPayload({ [button.name]: button.value || button.label || '', imhuman: fields.imhuman ?? '' }, `submit:${button.name}`);
    }

    for (const value of ['', 'Guarda lo streaming', 'GUARDA LO STREAMING', 'Watch video']) {
        addPayload({ imhuman: value }, `imhuman:${value || 'empty'}`);
    }
    addPayload({ method_free: '', imhuman: fields.imhuman ?? '' }, 'method_free-empty');
    addPayload({ method_free: 'Guarda lo streaming', imhuman: fields.imhuman ?? '' }, 'method_free-streaming');

    return payloads.slice(0, 7);
}

async function resolveDeltabitDirectStream(client, href, referer, options = {}, attempt = 0) {
    if (!client || typeof client.get !== 'function' || typeof client.post !== 'function') return null;
    if (!options.__skipEsDeltabitCoalescing) {
        const key = [normalizeRemoteUrl(href), safeHost(referer || getBaseUrl()), attempt];
        return withEsCoalescing('deltabitDirect', key, () => resolveDeltabitDirectStream(client, href, referer, {
            ...options,
            __skipEsDeltabitCoalescing: true
        }, attempt));
    }

    let pageUrl = await chaseToHosterPage(client, href, referer || getBaseUrl(), options);
    if (!pageUrl && isHosterPageUrl(normalizeRemoteUrl(href))) pageUrl = normalizeRemoteUrl(href);
    if (!pageUrl || !isDeltabitEntryUrl(pageUrl)) {
        esDebug('warn', 'deltabit direct resolve failed before hoster page', { hrefHost: safeHost(href), hrefPath: safePath(href), pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl) });
        return null;
    }

    const cachedResolved = getEsCache('deltabitSource', getDeltabitSourceCacheKey(pageUrl));
    if (cachedResolved?.streamUrl) {
        if (isProbablyPlayableMediaUrl(cachedResolved.streamUrl)) {
            esDebug('info', 'deltabit source cache hit', { pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), sourceHost: safeHost(cachedResolved.streamUrl), sourcePath: safePath(cachedResolved.streamUrl) });
            return cachedResolved;
        }
        esDebug('warn', 'deltabit source cache ignored non-playable', { pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), sourceHost: safeHost(cachedResolved.streamUrl), sourcePath: safePath(cachedResolved.streamUrl) });
    }

    const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
    let extractor = options.deltabitExtractor === 'Turbovid' ? 'Turbovid' : 'Deltabit';

    let deltabitCookies = {};
    const withDeltabitCookies = (headers = {}) => mergeCookieHeader(headers, deltabitCookies);
    const rememberDeltabitCookies = (response) => {
        const next = mergeSetCookieHeaders(deltabitCookies, response);
        if (Object.keys(next).length !== Object.keys(deltabitCookies).length) {
            esDebug('info', 'deltabit cookies updated', { cookieKeys: Object.keys(next) });
        }
        deltabitCookies = next;
    };

    const rangeHeaders = () => withDeltabitCookies({
        Referer: 'https://safego.cc/',
        'User-Agent': userAgent,
        Range: 'bytes=0-0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    });
    const pageHeaders = () => withDeltabitCookies({
        Referer: 'https://safego.cc/',
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    const rangeSettle = async (settleHop) => {
        const probe = await client.get(pageUrl, {
            headers: rangeHeaders(),
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true
        });
        rememberDeltabitCookies(probe);
        const settled = finalResponseUrl(probe, pageUrl)
            || extractRedirectCandidate(responseText(probe), pageUrl)
            || extractAnchorHref(responseText(probe));
        if (settled) pageUrl = settled.replace(/%20/g, '');
        esDebug('info', 'deltabit entry settled via range', { pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), fromClicka: isDeltabitClickaEntry(href), settleHop });
        return probe;
    };

    try {
        await rangeSettle(0);
    } catch (error) {
        esDebug('warn', 'deltabit range settle failed', { pageHost: safeHost(pageUrl), error: error?.message || String(error) });
    }

    for (let settleHop = 1; settleHop < 5 && !isHosterPageUrl(pageUrl); settleHop += 1) {
        try {
            if (REDIRECTOR_RE.test(pageUrl)) {
                const redirected = await resolveRedirectLinkCached(client, pageUrl, 'https://safego.cc/', options);
                if (redirected && redirected !== pageUrl) {
                    pageUrl = redirected.replace(/%20/g, '');
                    esDebug('info', 'deltabit safego/clicka re-resolved', { pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), settleHop });
                }
            }
            if (!isHosterPageUrl(pageUrl)) await rangeSettle(settleHop);
        } catch (error) {
            esDebug('warn', 'deltabit range settle failed', { pageHost: safeHost(pageUrl), error: error?.message || String(error) });
            break;
        }
    }

    if (!isHosterPageUrl(pageUrl)) {
        esDebug('warn', 'deltabit stopped before full GET because entry did not reach hoster', { pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), attempt });
        return null;
    }

    let response;
    try {
        response = await client.get(pageUrl, {
            headers: pageHeaders(),
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true
        });
        rememberDeltabitCookies(response);
    } catch (error) {
        esDebug('warn', 'deltabit full GET failed', { pageHost: safeHost(pageUrl), error: error?.message || String(error) });
        return null;
    }
    const settled2 = finalResponseUrl(response, pageUrl);
    if (settled2) pageUrl = settled2.replace(/%20/g, '');

    let html = responseText(response);
    if (!isHosterPageUrl(pageUrl)) {
        const next = extractRedirectCandidate(html, pageUrl) || extractAnchorHref(html);
        if (next && next !== pageUrl) {
            pageUrl = next.replace(/%20/g, '');
            try {
                response = await client.get(pageUrl, {
                    headers: pageHeaders(),
                    maxRedirects: 5,
                    responseType: 'text',
                    validateStatus: () => true
                });
                rememberDeltabitCookies(response);
                const settled3 = finalResponseUrl(response, pageUrl);
                if (settled3) pageUrl = settled3.replace(/%20/g, '');
                html = responseText(response);
            } catch (_) {}
        }
    }

    if (!isHosterPageUrl(pageUrl)) {
        const chasedBeforePost = await chaseToHosterPage(client, pageUrl, referer || getBaseUrl(), options);
        if (chasedBeforePost && isHosterPageUrl(chasedBeforePost)) {
            pageUrl = chasedBeforePost;
            try {
                response = await client.get(pageUrl, {
                    headers: pageHeaders(),
                    maxRedirects: 5,
                    responseType: 'text',
                    validateStatus: () => true
                });
                rememberDeltabitCookies(response);
                html = responseText(response);
            } catch (_) {}
        }
    }

    if (!isHosterPageUrl(pageUrl)) {
        esDebug('warn', 'deltabit stopped before form POST because page is not hoster', { pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), attempt });
        return null;
    }

    if (/turbovid\./i.test(pageUrl)) {
        extractor = 'Turbovid';
        esDebug('info', 'deltabit switched extractor to Turbovid after redirect', { pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl) });
    }

    const origin = (() => { try { return new URL(pageUrl).origin; } catch (_) { return ''; } })();

    const directSource = extractDeltabitSource(html, pageUrl);
    const earlyFields = extractFormFieldsRaw(html);
    if (directSource) {
        return cacheDeltabitResolved(pageUrl, {
            streamUrl: directSource,
            pageUrl,
            fileName: earlyFields.fname || 'DeltaBit',
            headers: buildDeltabitPlaybackHeaders(pageUrl, userAgent, deltabitCookies, directSource)
        });
    }

    const fields = extractFormFieldsRaw(html);
    if (!Object.keys(fields).length) {
        esDebug('warn', 'deltabit page has no playable source and no form fields', { pageHost: safeHost(pageUrl), attempt });
        if (attempt < getDeltabitMaxRetries(options)) return resolveDeltabitDirectStream(client, pageUrl, referer, options, attempt + 1);
        return null;
    }

    const fileName = fields.fname || 'DeltaBit';
    const payloads = buildDeltabitPostPayloads(fields, html, extractor, pageUrl, options);
    esDebug('info', 'deltabit form prepared', {
        pageHost: safeHost(pageUrl),
        fieldKeys: Object.keys(fields).filter((key) => !/hash|token|sess|pass|key/i.test(key)).slice(0, 12),
        submitCount: extractSubmitButtons(html).length,
        payloads: payloads.map((payload) => payload.reason).slice(0, 7)
    });

    const waitMs = extractor === 'Turbovid' ? 5000 : getDeltabitWaitMs(options);
    await delay(waitMs);

    let source = null;
    let lastStatus = null;
    let lastPostError = null;
    for (let postAttempt = 0; postAttempt < payloads.length; postAttempt += 1) {
        const payload = payloads[postAttempt];
        try {
            response = await client.post(pageUrl, encodeFormBody(payload.data), {
                headers: withDeltabitCookies({
                    Origin: origin,
                    Referer: pageUrl,
                    'User-Agent': userAgent,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
                }),
                maxRedirects: 5,
                responseType: 'text',
                validateStatus: () => true
            });
            rememberDeltabitCookies(response);
            lastStatus = response?.status;
            const postUrl = finalResponseUrl(response, pageUrl) || pageUrl;
            source = extractDeltabitSource(responseText(response), postUrl);
            if (source) {
                esDebug('info', 'deltabit source extracted after post', { pageHost: safeHost(postUrl), postAttempt, payload: payload.reason });
                break;
            }
            const next = extractRedirectCandidate(responseText(response), postUrl) || extractAnchorHref(responseText(response));
            if (next && next !== postUrl && isHosterPageUrl(next)) {
                const follow = await client.get(next, {
                    headers: withDeltabitCookies({ Referer: postUrl, 'User-Agent': userAgent }),
                    maxRedirects: 5,
                    responseType: 'text',
                    validateStatus: () => true
                });
                rememberDeltabitCookies(follow);
                source = extractDeltabitSource(responseText(follow), finalResponseUrl(follow, next) || next);
                if (source) {
                    pageUrl = finalResponseUrl(follow, next) || next;
                    esDebug('info', 'deltabit source extracted after follow-up', { pageHost: safeHost(pageUrl), postAttempt, payload: payload.reason });
                    break;
                }
            }
        } catch (error) {
            lastPostError = error;
            esDebug('warn', 'deltabit form POST failed', { pageHost: safeHost(pageUrl), postAttempt, payload: payload.reason, error: error?.message || String(error) });
        }
    }

    if (!source) {
        esDebug('warn', 'deltabit form POST returned no source', { pageHost: safeHost(pageUrl), attempt, status: lastStatus, error: lastPostError?.message });
        if (attempt < getDeltabitMaxRetries(options)) return resolveDeltabitDirectStream(client, pageUrl, referer, options, attempt + 1);
        return null;
    }

    return cacheDeltabitResolved(pageUrl, {
        streamUrl: source,
        pageUrl,
        fileName,
        headers: buildDeltabitPlaybackHeaders(pageUrl, userAgent, deltabitCookies, directSource)
    });
}

function getDeltabitWaitMs(options = {}) {
    const raw = options.deltabitWaitMs ?? process.env.ES_DELTABIT_WAIT_MS ?? '2500';
    const waitMs = Number.parseInt(String(raw), 10);
    return Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 8000) : 0;
}

function getDeltabitSourceCacheKey(pageUrl) {
    return [safeHost(pageUrl), safePath(pageUrl)];
}

function cacheDeltabitResolved(pageUrl, resolved) {
    if (pageUrl && resolved?.streamUrl) {
        if (!isProbablyPlayableMediaUrl(resolved.streamUrl)) {
            esDebug('warn', 'deltabit extracted source rejected as non-playable', {
                pageHost: safeHost(pageUrl),
                pagePath: safePath(pageUrl),
                sourceHost: safeHost(resolved.streamUrl),
                sourcePath: safePath(resolved.streamUrl)
            });
            return null;
        }
        setEsCache('deltabitSource', getDeltabitSourceCacheKey(pageUrl), resolved, ES_CACHE_TTL.deltabitSource);
        esDebug('info', 'deltabit source cache saved', { pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), sourceHost: safeHost(resolved.streamUrl), sourcePath: safePath(resolved.streamUrl) });
    }
    return resolved;
}

function delay(ms) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label = 'operation') {
    const timeoutMs = Number.parseInt(String(ms || 0), 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return esEnv.int(name, fallback, min, max);
}

function getHostResolveTimeoutMs(host) {
    if (host === 'deltabit') return envInt('ES_DELTABIT_HOST_TIMEOUT_MS', 10000, 1000, 20000);
    if (host === 'maxstream') return envInt('ES_MAXSTREAM_HOST_TIMEOUT_MS', 15000, 1000, 30000);
    if (host === 'mixdrop') return envInt('ES_MIXDROP_HOST_TIMEOUT_MS', 4500, 1000, 15000);
    return envInt('ES_HOST_TIMEOUT_MS', 5000, 1000, 20000);
}

function getDeltabitMaxRetries(options = {}) {
    const raw = options.deltabitMaxRetries ?? process.env.ES_DELTABIT_MAX_RETRIES ?? '1';
    const value = Number.parseInt(String(raw), 10);
    return Number.isFinite(value) ? Math.max(0, Math.min(value, 2)) : 1;
}

function streamPriority(label) {
    if (/delta/i.test(label)) return 1;
    if (/mix/i.test(label)) return 2;
    if (/max/i.test(label)) return 3;
    return 9;
}

function urlOrigin(value, fallback = '') {
    try { return new URL(String(value || '')).origin; } catch (_) { return fallback; }
}

function extractorHeadersFor(targetUrl, kind = '') {
    const origin = urlOrigin(targetUrl);
    const headers = { 'User-Agent': SAFEGO_FIREFOX_UA };
    if (/mix/i.test(kind)) {
        headers.Referer = origin ? `${origin}/` : 'https://mixdrop.vip/';
        headers.Origin = origin || 'https://mixdrop.vip';
        return headers;
    }
    if (/max|uprot/i.test(kind)) {
        const isUprot = /uprot\.net/i.test(String(targetUrl || ''));
        headers.Referer = isUprot ? 'https://uprot.net/' : (origin ? `${origin}/` : 'https://uprot.net/');
        headers.Origin = isUprot ? 'https://uprot.net' : (origin || 'https://uprot.net');
        return headers;
    }
    if (origin) {
        headers.Referer = `${origin}/`;
        headers.Origin = origin;
    }
    return headers;
}

function isHlsStreamUrl(value) {
    return /\.m3u8(?:$|[?#])/i.test(String(value || ''));
}

function isDeltabitDirectCdnUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname.toLowerCase();
        return /(?:^|\.)host-cdn\.net$/i.test(host)
            || /(?:^|\.)deltabit(?:cdn|dl)?\./i.test(host)
            || /\/(?:v|video)\.mp4$/i.test(path);
    } catch (_) {
        return false;
    }
}

function buildDeltabitPlaybackHeaders(pageUrl, userAgent, cookies = {}, sourceUrl = null, { forProxy = false } = {}) {
    const headers = {
        Referer: pageUrl,
        'User-Agent': userAgent || SAFEGO_FIREFOX_UA
    };

    if (sourceUrl && isDeltabitDirectCdnUrl(sourceUrl)) return headers;
    try {
        const origin = new URL(String(pageUrl || '')).origin;
        if (origin) headers.Origin = origin;
    } catch (_) {}
    if (!forProxy) return mergeCookieHeader(headers, cookies);
    if (envFlag('ES_DELTABIT_PROXY_COOKIE', false)) return mergeCookieHeader(headers, cookies);
    return headers;
}

function shouldAddDeltabitDirectFallback(value) {
    return envFlag('EUROSTREAMING_DELTABIT_DIRECT_FALLBACK', true)
        && isDeltabitDirectCdnUrl(value);
}


function buildMfpProxyUrl(config = {}, targetUrl, headers = {}, { isHls = false, allowCookie = null } = {}) {
    const gateway = createMediaflowGateway(config);
    const proxied = gateway.buildProxyUrl(targetUrl, headers, {
        isHls,
        allowCookie: allowCookie == null ? envFlag('ES_DELTABIT_PROXY_COOKIE', false) : allowCookie
    });
    return proxied && proxied !== targetUrl ? proxied : null;
}

function buildDirectExtractorStream({ targetUrl, label, title, language, headers = null, fileName = '', mediaflowUrl = null, via = 'direct' }) {
    return buildWebStream({
        name: `🌍 ${PROVIDER} | ${label}`,
        title: `${title}\n☁️ ${label} • ${language === 'SUB-ITA' ? '🇮🇹 SUB-ITA' : '🇮🇹 ITA'}${fileName ? `\n${fileName}` : ''}`,
        url: targetUrl,
        extractor: label,
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers,
        mediaflowUrl,
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                language,
                audioLanguages: language === 'SUB-ITA' ? [] : ['ita'],
                subtitleLanguages: language === 'SUB-ITA' ? ['ita'] : [],
                via
            }
        },
        extra: { _priority: streamPriority(label) }
    });
}


function shouldProxyMaxstreamExtracted() {
    return envFlag('EUROSTREAMING_MAXSTREAM_PROXY_EXTRACTED', true);
}

function shouldTryMaxstreamLocalFirst() {
    return envFlag('EUROSTREAMING_MAXSTREAM_LOCAL_FIRST', true);
}

function shouldResolveUprotLocally(options = {}) {
    if (options.uprotLocalResolve !== undefined) return options.uprotLocalResolve === true;
    return envFlag('EUROSTREAMING_UPROT_LOCAL_RESOLVE', false);
}

function getMaxstreamLocalTimeoutMs() {
    return envInt('ES_MAXSTREAM_LOCAL_TIMEOUT_MS', 30000, 1000, 60000);
}

function isMaxstreamExtractedPlayable(value) {
    const normalized = normalizeRemoteUrl(value);
    if (!normalized || !/^https?:\/\//i.test(normalized)) return false;
    if (isStaticAssetUrl(normalized)) return false;
    return isDirectMediaUrl(normalized) || /\/hls\/[^?#]+(?:master|index)\.m3u8(?:$|[?#])/i.test(normalized);
}

async function buildLocalMaxstreamStream({ client, config, targetUrl, originalUprotUrl = null, title, language, options = {} }) {
    if (!targetUrl || !shouldTryMaxstreamLocalFirst()) return null;
    const extracted = await withTimeout(
        extractMaxstream(targetUrl, {
            ...options,
            client,
            mediaflowBase: getMediaflowBase(config),
            mediaflowApiPassword: config?.mediaflowApiPassword || config?.mediaFlowApiPassword || config?.mfpPassword || '',
            requestReferer: originalUprotUrl || options?.baseUrl || getBaseUrl(),
            referer: originalUprotUrl || options?.baseUrl || getBaseUrl(),
            timeout: envInt('ES_MAXSTREAM_PAGE_TIMEOUT_MS', 12000, 1000, 30000),
            forwardTimeout: envInt('ES_MAXSTREAM_FORWARD_TIMEOUT_MS', 12000, 1000, 30000)
        }),
        getMaxstreamLocalTimeoutMs(),
        'Eurostreaming MaxStream local'
    );
    if (!extracted?.url) return null;
    if (!isMaxstreamExtractedPlayable(extracted.url)) {
        esDebug('warn', 'maxstream local source rejected as non-playable', { sourceHost: safeHost(extracted.url), sourcePath: safePath(extracted.url), via: extracted.via || null });
        return null;
    }

    const isHls = isHlsStreamUrl(extracted.url);
    const headers = extracted.headers || extractorHeadersFor(extracted.sourceUrl || targetUrl, 'maxstream');
    if (getMediaflowBase(config) && shouldProxyMaxstreamExtracted()) {
        const proxied = buildMfpProxyUrl(config, extracted.url, headers, { isHls });
        if (proxied && proxied !== extracted.url) {
            esDebug('info', 'maxstream source proxied via MFP/Kraken', {
                sourceHost: safeHost(extracted.url),
                sourcePath: safePath(extracted.url),
                proxyPath: safePath(proxied),
                isHls,
                via: extracted.via || (originalUprotUrl ? 'uprot-local' : 'maxstream-local')
            });
            return buildDirectExtractorStream({
                targetUrl: proxied,
                label: 'MaxStream',
                title,
                language,
                headers: null,
                mediaflowUrl: getMediaflowBase(config),
                via: originalUprotUrl ? 'uprot-mammamia-maxstream-proxy' : 'maxstream-local-proxy'
            });
        }
    }

    esDebug('info', 'maxstream local stream built', { sourceHost: safeHost(extracted.url), sourcePath: safePath(extracted.url), via: extracted.via || null });
    return buildDirectExtractorStream({
        targetUrl: extracted.url,
        label: 'MaxStream',
        title,
        language,
        headers: envFlag('ES_MAXSTREAM_DIRECT_HEADERS', false) ? headers : null,
        via: originalUprotUrl ? 'uprot-mammamia-maxstream-direct' : 'maxstream-local-direct'
    });
}

function buildDeltabitMfpStream({ config, targetUrl, title, language, via = 'deltabit-mfp' }) {
    if (!targetUrl || !getMediaflowBase(config)) return null;
    return buildMfpExtractorStream({
        config,
        targetUrl,
        host: getDeltabitMfpHost(),
        label: 'DeltaBit',
        title,
        language,
        via,
        mediaflowOptions: {
            extractorPath: getDeltabitMfpPath(),
            redirectStream: envFlag('EUROSTREAMING_DELTABIT_MFP_REDIRECT_STREAM', false)
        },
        streamKind: 'video'
    });
}

function buildMfpExtractorStream({ config, targetUrl, host, label, title, language, via = 'mfp', mediaflowOptions = null, streamKind = 'video' }) {
    if (!getMediaflowBase(config)) return null;
    const mfpUrl = buildMediaflowUrl(config, targetUrl, 'extractor', host, mediaflowOptions || {});
    if (!mfpUrl || mfpUrl === targetUrl) return null;

    esDebug('info', 'mfp extractor stream built', {
        label,
        host,
        via,
        targetHost: safeHost(targetUrl),
        targetPath: safePath(targetUrl),
        mfpPath: safePath(mfpUrl),
        redirectStream: /[?&]redirect_stream=true(?:&|$)/i.test(mfpUrl),
        hasHeaderParams: /[?&]h_[^=]+=/.test(mfpUrl),
        forcePlaylistProxy: /[?&]force_playlist_proxy=true(?:&|$)/i.test(mfpUrl),
        streamKind
    });
    return buildWebStream({
        name: `🌍 ${PROVIDER} | ${label}`,
        title: `${title}\n☁️ ${label} • ${language === 'SUB-ITA' ? '🇮🇹 SUB-ITA' : '🇮🇹 ITA'}`,
        url: mfpUrl,
        extractor: label,
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers: null,
        mediaflowUrl: getMediaflowBase(config),
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                language,
                audioLanguages: language === 'SUB-ITA' ? [] : ['ita'],
                subtitleLanguages: language === 'SUB-ITA' ? ['ita'] : [],
                via,
                streamKind
            }
        },
        extra: { _priority: streamPriority(label) }
    });
}

function shouldForwardMaxstreamViaKraken(options = {}) {
    if (options?.maxstreamForwardProxy !== undefined) return options.maxstreamForwardProxy === true;
    return envFlag('EUROSTREAMING_MAXSTREAM_FORWARD_PROXY', false);
}

function buildForwardedMaxstreamTarget(config = {}, targetUrl, kind = 'maxstream', options = {}) {
    const normalized = normalizeRemoteUrl(targetUrl);
    const headers = extractorHeadersFor(normalized, kind);
    if (!normalized || !getMediaflowBase(config) || !shouldForwardMaxstreamViaKraken(options)) {
        return { targetUrl: normalized, headers, forwarded: false };
    }

    const gateway = createMediaflowGateway(config);
    const forwarded = gateway.buildForwardUrl(normalized, headers, { allowCookie: false });
    const changed = Boolean(forwarded && forwarded !== normalized);
    esDebug(changed ? 'info' : 'warn', 'maxstream forward target built', {
        kind,
        sourceHost: safeHost(normalized),
        sourcePath: safePath(normalized),
        forwardHost: safeHost(forwarded),
        forwardPath: safePath(forwarded),
        forwarded: changed
    });
    return { targetUrl: changed ? forwarded : normalized, headers, forwarded: changed };
}

function buildKrakenUprotMaxstreamStream({ config, targetUrl, title, language = 'ITA', options = {} }) {
    const normalized = normalizeRemoteUrl(targetUrl);
    if (!normalized || !isUprotUrl(normalized) || !getMediaflowBase(config)) return null;
    const headers = extractorHeadersFor(normalized, 'uprot');
    return buildMfpExtractorStream({
        config,
        targetUrl: normalized,
        host: 'Maxstream',
        label: 'MaxStream',
        title,
        language,
        via: 'uprot-kraken',
        mediaflowOptions: {
            extractorPath: getMaxstreamMfpPath(),
            redirectStream: getMaxstreamRedirectStream(),
            headers
        },
        streamKind: 'hls'
    });
}

async function buildHostStream(link, context) {
    const { client, config, title, language, options } = context;
    if (link.host === 'deltabit') {
        let targetUrl = normalizeRemoteUrl(link.href);

        let mfpTargetUrl = targetUrl;
        if (mfpTargetUrl && !isHosterPageUrl(mfpTargetUrl)) {
            const chased = await chaseToHosterPage(client, mfpTargetUrl, options?.baseUrl || getBaseUrl(), options);
            if (chased) mfpTargetUrl = chased;
        }
        if (mfpTargetUrl && getMediaflowBase(config) && isDeltabitMfpFallbackEnabled() && isDeltabitMfpFirstEnabled()) {
            const stream = buildDeltabitMfpStream({ config, targetUrl: mfpTargetUrl, title, language, via: 'deltabit-mfp-first' });
            if (stream) {
                esDebug('info', 'deltabit sent to MFP/Kraken first', { hrefHost: safeHost(link.href), targetHost: safeHost(mfpTargetUrl), targetPath: safePath(mfpTargetUrl), host: getDeltabitMfpHost(), path: getDeltabitMfpPath() });
                return stream;
            }
        }

        const resolved = await resolveDeltabitDirectStream(client, targetUrl, options?.baseUrl || getBaseUrl(), options);
        if (resolved?.streamUrl) {
            const isHls = isHlsStreamUrl(resolved.streamUrl);
            const shouldProxyExtracted = envFlag('EUROSTREAMING_DELTABIT_PROXY_EXTRACTED', true);
            if (!isProbablyPlayableMediaUrl(resolved.streamUrl)) {
                esDebug('warn', 'deltabit resolved source skipped because non-playable', { sourceHost: safeHost(resolved.streamUrl), sourcePath: safePath(resolved.streamUrl) });
                return null;
            }
            const directFallback = buildDirectExtractorStream({
                targetUrl: resolved.streamUrl,
                label: 'DeltaBit Direct',
                title,
                language,
                headers: envFlag('ES_DELTABIT_DIRECT_HEADERS', false) ? resolved.headers : null,
                fileName: resolved.fileName,
                via: 'deltabit-direct'
            });

            if (getMediaflowBase(config) && shouldProxyExtracted) {
                const proxyHeaders = buildDeltabitPlaybackHeaders(resolved.pageUrl || targetUrl, SAFEGO_FIREFOX_UA, {}, resolved.streamUrl, { forProxy: true });
                const allowCookie = !isDeltabitDirectCdnUrl(resolved.streamUrl) && envFlag('ES_DELTABIT_PROXY_COOKIE', false);
                const mfpProxyUrl = buildMfpProxyUrl(config, resolved.streamUrl, proxyHeaders, { isHls, allowCookie });
                if (mfpProxyUrl && mfpProxyUrl !== resolved.streamUrl) {
                    esDebug('info', 'deltabit source proxied via MFP/Kraken', {
                        sourceHost: safeHost(resolved.streamUrl),
                        sourcePath: safePath(resolved.streamUrl),
                        proxyPath: safePath(mfpProxyUrl),
                        isHls,
                        directCdn: isDeltabitDirectCdnUrl(resolved.streamUrl),
                        hasCookie: Boolean((proxyHeaders || {}).Cookie || (proxyHeaders || {}).cookie)
                    });
                    const proxiedStream = buildDirectExtractorStream({
                        targetUrl: mfpProxyUrl,
                        label: 'DeltaBit',
                        title,
                        language,
                        headers: null,
                        fileName: resolved.fileName,
                        mediaflowUrl: getMediaflowBase(config),
                        via: isHls ? 'deltabit-mfp-proxy-hls' : 'deltabit-mfp-proxy-stream'
                    });
                    return shouldAddDeltabitDirectFallback(resolved.streamUrl)
                        ? [proxiedStream, directFallback]
                        : proxiedStream;
                }
            }

            return directFallback;
        }

        if (targetUrl && REDIRECTOR_RE.test(targetUrl)) {
            const redirected = await resolveRedirectLinkCached(client, targetUrl, options?.baseUrl || getBaseUrl(), options);
            if (redirected && redirected !== targetUrl) targetUrl = redirected;
        }

        if (targetUrl && getMediaflowBase(config) && isDeltabitMfpFallbackEnabled()) {
            esDebug('warn', 'deltabit direct resolve failed; using MFP/Kraken fallback', { hrefHost: safeHost(link.href), targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl), host: getDeltabitMfpHost(), path: getDeltabitMfpPath() });
            return buildDeltabitMfpStream({ config, targetUrl, title, language, via: 'deltabit-fallback' });
        }
        if (targetUrl && getMediaflowBase(config)) {
            esDebug('warn', 'deltabit direct resolve failed; MFP fallback disabled by env', { hrefHost: safeHost(link.href), targetHost: safeHost(targetUrl) });
        }
        return null;
    }

    if (link.host === 'mixdrop') {
        let targetUrl = normalizeRemoteUrl(link.href);
        if (targetUrl && !isMixdropUrl(targetUrl) && REDIRECTOR_RE.test(targetUrl)) {
            targetUrl = await resolveRedirectLinkCached(client, targetUrl, options?.baseUrl || getBaseUrl(), options);
        }
        if (!targetUrl || !isMixdropUrl(targetUrl)) return null;
        const normalizedMixdrop = normalizeMixdropForExtractor(targetUrl);
        if (!normalizedMixdrop) return null;
        if (normalizedMixdrop !== targetUrl) {
            esDebug('info', 'mixdrop canonicalized for MFP', { fromPath: safePath(targetUrl), toPath: safePath(normalizedMixdrop), host: safeHost(normalizedMixdrop) });
        }

        if (getMediaflowBase(config) && envFlag('EUROSTREAMING_MIXDROP_LOCAL_PROXY_FIRST', true)) {
            try {
                const extracted = await withTimeout(
                    extractMixdrop(normalizedMixdrop, { client, userAgent: SAFEGO_FIREFOX_UA }),
                    envInt('ES_MIXDROP_LOCAL_TIMEOUT_MS', 3500, 800, 8000),
                    'Eurostreaming MixDrop local'
                );
                if (extracted?.url) {
                    const isHls = isHlsStreamUrl(extracted.url);
                    const proxied = buildMfpProxyUrl(config, extracted.url, extracted.headers || extractorHeadersFor(normalizedMixdrop, 'mixdrop'), { isHls });
                    if (proxied && proxied !== extracted.url) {
                        esDebug('info', 'mixdrop source proxied via MFP/Kraken', {
                            sourceHost: safeHost(extracted.url),
                            sourcePath: safePath(extracted.url),
                            proxyPath: safePath(proxied),
                            isHls,
                            hasHeaders: Boolean(extracted.headers)
                        });
                        return buildDirectExtractorStream({
                            targetUrl: proxied,
                            label: 'MixDrop',
                            title,
                            language,
                            headers: null,
                            mediaflowUrl: getMediaflowBase(config),
                            via: isHls ? 'mixdrop-local-mfp-hls' : 'mixdrop-local-mfp-stream'
                        });
                    }
                }
            } catch (error) {
                esDebug('warn', 'mixdrop local proxy failed; using MFP extractor fallback', { error: error?.message || String(error) });
            }
        }

        return buildMfpExtractorStream({
            config,
            targetUrl: normalizedMixdrop,
            host: 'Mixdrop',
            label: 'MixDrop',
            title,
            language,
            mediaflowOptions: {
                redirectStream: envFlag('EUROSTREAMING_MIXDROP_REDIRECT_STREAM', true),
                headers: extractorHeadersFor(normalizedMixdrop, 'mixdrop')
            },
            streamKind: 'video'
        });
    }

    if (link.host === 'maxstream') {
        let targetUrl = normalizeRemoteUrl(link.href);
        if (targetUrl && REDIRECTOR_RE.test(targetUrl)) {
            const redirected = await resolveRedirectLinkCached(client, targetUrl, options?.baseUrl || getBaseUrl(), options);
            if (redirected && redirected !== targetUrl) targetUrl = redirected;
        }

        const originalUprotUrl = isUprotUrl(targetUrl) ? targetUrl : null;
        if (originalUprotUrl) {
            const krakenStream = buildKrakenUprotMaxstreamStream({
                config,
                targetUrl: originalUprotUrl,
                title,
                language,
                options
            });
            if (krakenStream) {
                esDebug('info', 'uprot sent to Kraken MaxStream extractor; Kraken handles WARP internally', { hrefHost: safeHost(originalUprotUrl), hrefPath: safePath(originalUprotUrl) });
                return krakenStream;
            }

            if (!shouldResolveUprotLocally(options)) {
                esDebug('warn', 'uprot local resolve disabled; MaxStream requires Kraken/MediaFlow', {
                    hrefHost: safeHost(originalUprotUrl),
                    configure: 'KRAKEN_URL or config.mediaflow.url',
                    optInLocalEnv: 'EUROSTREAMING_UPROT_LOCAL_RESOLVE=1'
                });
                return null;
            }

            const resolved = await withEsCoalescing('uprotLocalMammaMia', [originalUprotUrl], () => resolveUprotToMaxstream(client, targetUrl, {
                ...options,
                uprotMammaMiaStrict: true
            }));
            if (resolved?.streamUrl) {
                const isHls = isHlsStreamUrl(resolved.streamUrl);
                const headers = extractorHeadersFor(resolved.sourceUrl || originalUprotUrl, 'maxstream');
                if (getMediaflowBase(config) && shouldProxyMaxstreamExtracted()) {
                    const proxied = buildMfpProxyUrl(config, resolved.streamUrl, headers, { isHls });
                    if (proxied && proxied !== resolved.streamUrl) {
                        esDebug('info', 'uprot direct stream proxied via MFP/Kraken', { sourceHost: safeHost(resolved.streamUrl), sourcePath: safePath(resolved.streamUrl), proxyPath: safePath(proxied), via: resolved.via });
                        return buildDirectExtractorStream({
                            targetUrl: proxied,
                            label: 'MaxStream',
                            title,
                            language,
                            headers: null,
                            mediaflowUrl: getMediaflowBase(config),
                            via: 'uprot-mammamia-direct-proxy'
                        });
                    }
                }
                return buildDirectExtractorStream({
                    targetUrl: resolved.streamUrl,
                    label: 'MaxStream',
                    title,
                    language,
                    headers: envFlag('ES_MAXSTREAM_DIRECT_HEADERS', false) ? headers : null,
                    via: 'uprot-mammamia-direct'
                });
            }
            targetUrl = resolved?.playerUrl || null;
            const local = await buildLocalMaxstreamStream({ client, config, targetUrl, originalUprotUrl, title, language, options });
            if (local) return local;
            if (!targetUrl) {
                if (!envFlag('EUROSTREAMING_MAXSTREAM_BROKEN_UPROT_FALLBACK', false)) {
                    esDebug('warn', 'uprot local resolve failed; skipping broken MFP fallback', {
                        hrefHost: safeHost(originalUprotUrl),
                        reason: 'uprot_state_required',
                        hint: 'open /uprot once or set UPROT_STATE_FILE like MammaMia uprot.txt'
                    });
                    return null;
                }
                if (getMediaflowBase(config)) {
                    esDebug('warn', 'uprot local resolve failed; using MFP fallback', { hrefHost: safeHost(originalUprotUrl) });
                    {
                        const forwardedTarget = buildForwardedMaxstreamTarget(config, originalUprotUrl, 'uprot', options);
                        return buildMfpExtractorStream({
                            config,
                            targetUrl: forwardedTarget.targetUrl,
                            host: 'Maxstream',
                            label: 'MaxStream',
                            title,
                            language,
                            via: forwardedTarget.forwarded ? 'uprot-fallback-forward-kraken' : 'uprot-fallback',
                            mediaflowOptions: {
                                extractorPath: getMaxstreamMfpPath(),
                                redirectStream: getMaxstreamRedirectStream(),
                                headers: forwardedTarget.headers
                            },
                            streamKind: 'hls'
                        });
                    }
                }
            }
        }
        if (!targetUrl || !isMaxstreamLikeUrl(targetUrl)) return null;

        if (getMediaflowBase(config)) {
            const forwardedTarget = buildForwardedMaxstreamTarget(config, targetUrl, 'maxstream', options);
            const krakenStream = buildMfpExtractorStream({
                config,
                targetUrl: forwardedTarget.targetUrl,
                host: 'Maxstream',
                label: 'MaxStream',
                title,
                language,
                via: forwardedTarget.forwarded ? 'maxstream-forward-kraken' : 'maxstream-kraken',
                mediaflowOptions: {
                    extractorPath: getMaxstreamMfpPath(),
                    redirectStream: getMaxstreamRedirectStream(),
                    headers: forwardedTarget.headers
                },
                streamKind: 'hls'
            });
            if (krakenStream) return krakenStream;
        }

        const local = await buildLocalMaxstreamStream({ client, config, targetUrl, originalUprotUrl, title, language, options });
        if (local) return local;

        if (originalUprotUrl && !envFlag('EUROSTREAMING_MAXSTREAM_BROKEN_UPROT_FALLBACK', false)) {
            esDebug('warn', 'maxstream local extractor failed; skipping broken UProt fallback', {
                targetHost: safeHost(targetUrl),
                targetPath: safePath(targetUrl),
                originalUprot: true,
                hint: 'open /uprot once or set UPROT_STATE_FILE like MammaMia uprot.txt'
            });
            return null;
        }

        esDebug('warn', 'maxstream local extractor failed; using MFP extractor fallback', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl), originalUprot: Boolean(originalUprotUrl) });
        const fallbacks = [];
        const playerFallback = buildMfpExtractorStream({
            config,
            targetUrl,
            host: 'Maxstream',
            label: 'MaxStream',
            title,
            language,
            via: originalUprotUrl ? 'uprot-local-fallback-player' : 'maxstream-fallback',
            mediaflowOptions: {
                extractorPath: getMaxstreamMfpPath(),
                redirectStream: getMaxstreamRedirectStream(),
                headers: extractorHeadersFor(targetUrl, 'maxstream')
            },
            streamKind: 'hls'
        });
        if (playerFallback) fallbacks.push(playerFallback);
        if (originalUprotUrl && originalUprotUrl !== targetUrl && envFlag('EUROSTREAMING_MAXSTREAM_ADD_UPROT_FALLBACK', true)) {
            const uprotFallback = buildMfpExtractorStream({
                config,
                targetUrl: originalUprotUrl,
                host: 'Maxstream',
                label: 'MaxStream UProt',
                title,
                language,
                via: 'uprot-original-fallback',
                mediaflowOptions: {
                    extractorPath: getMaxstreamMfpPath(),
                    redirectStream: getMaxstreamRedirectStream(),
                    headers: extractorHeadersFor(originalUprotUrl, 'maxstream')
                },
                streamKind: 'hls'
            });
            if (uprotFallback) fallbacks.push(uprotFallback);
        }
        return fallbacks.length > 1 ? fallbacks : (fallbacks[0] || null);
    }

    return null;
}

function getMetaTitle(meta = {}) {
    return decodeHtml(meta?.title || meta?.name || meta?.originalTitle || meta?.seriesName || '').trim();
}

function getMetaYear(meta = {}) {
    return Number.parseInt(String(meta?.year || meta?.releaseYear || meta?.released || meta?.firstAirDate || '').slice(0, 4), 10) || null;
}

function getSeasonEpisode(meta = {}) {
    const season = Number.parseInt(String(meta?.season || meta?.s || meta?.seasonNumber || meta?.tmdbSeason || 0), 10);
    const episode = Number.parseInt(String(meta?.episode || meta?.e || meta?.episodeNumber || meta?.tmdbEpisode || 0), 10);
    return { season, episode };
}

function getSearchCandidateTitle(candidate = {}) {
    const title = candidate?.title;
    if (typeof title === 'string') return decodeHtml(title);
    if (title && typeof title === 'object') return decodeHtml(title.rendered || title.raw || '');
    return decodeHtml(candidate?.name || '');
}

function getSearchCandidateUrl(candidate = {}) {
    return normalizeRemoteUrl(candidate?.url || candidate?.link || candidate?.href || '');
}

function directSlugFromUrl(value, baseUrl = '') {
    try {
        const parsed = new URL(String(value || ''), baseUrl || getBaseUrl());
        const base = new URL(baseUrl || getBaseUrl());
        if (parsed.hostname.replace(/^www\./i, '') !== base.hostname.replace(/^www\./i, '')) return '';
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length !== 1) return '';
        const slug = decodeURIComponent(parts[0] || '').trim();
        if (!slug || /^(?:wp-json|tag|category|author|page|feed|comment-page|aggiornamento-episodi|serie-tv|film|anime)$/i.test(slug)) return '';
        return slug;
    } catch (_) {
        return '';
    }
}

function scoreEurostreamingSearchCandidate(candidate = {}, title = '', baseUrl = '') {
    const expectedSlug = slugifyEurostreamingTitle(title);
    const candidateTitle = getSearchCandidateTitle(candidate);
    const candidateUrl = getSearchCandidateUrl(candidate);
    const slug = directSlugFromUrl(candidateUrl, baseUrl);
    const normalizedCandidateTitle = normalizeTitle(candidateTitle);
    const normalizedExpectedTitle = normalizeTitle(title);
    let score = similarity(candidateTitle || slug, title) * 100;

    if (normalizedCandidateTitle && normalizedCandidateTitle === normalizedExpectedTitle) score += 120;
    if (slug && expectedSlug) {
        if (slug === expectedSlug) score += 90;
        else if (new RegExp(`^${expectedSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`, 'i').test(slug)) score += 85;
        else if (slug.startsWith(`${expectedSlug}-`)) score += 55;
        else if (slug.includes(expectedSlug)) score += 25;
    }
    if (candidate?.subtype === 'post') score += 10;
    if (!slug && candidateUrl) score -= 30;
    if (/\b(?:trailer|news|aggiornamento|episodi|classifica|contatti|dmca|disclaimer)\b/i.test(`${candidateTitle} ${candidateUrl}`)) score -= 80;
    return score;
}

function normalizeSearchResults(results = [], title = '', baseUrl = '') {
    const seen = new Set();
    return (Array.isArray(results) ? results : [])
        .map((item) => ({
            ...item,
            titleText: getSearchCandidateTitle(item),
            url: getSearchCandidateUrl(item),
            score: scoreEurostreamingSearchCandidate(item, title, baseUrl)
        }))
        .filter((item) => {
            const key = item?.id ? `id:${item.id}` : item?.url ? `url:${item.url}` : '';
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return item.score > 35;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
}

async function fetchSearchResults(client, title, baseUrl) {
    const cacheKey = [baseUrl, normalizeTitle(title)];
    const cached = getEsCache('wpSearch', cacheKey);
    if (cached) {
        esDebug('info', 'wp search cache hit', { title, count: cached.length });
        return cached;
    }

    return withEsCoalescing('wpSearch', cacheKey, async () => {
        const afterWait = getEsCache('wpSearch', cacheKey);
        if (afterWait) return afterWait;
        const url = `${baseUrl}/wp-json/wp/v2/search?search=${encodeURIComponent(title)}&per_page=12&_fields=id,title,url,type,subtype`;
        const json = responseJson(await client.get(url, { responseType: 'json', validateStatus: () => true }));
        const results = normalizeSearchResults(json, title, baseUrl);
        if (results.length) setEsCache('wpSearch', cacheKey, results, ES_CACHE_TTL.wpSearch);
        return results;
    });
}

async function fetchPost(client, id, baseUrl) {
    const cacheKey = [baseUrl, id];
    const cached = getEsCache('post', cacheKey);
    if (cached) {
        esDebug('info', 'post cache hit', { id });
        return cached;
    }
    return withEsCoalescing('post', cacheKey, async () => {
        const afterWait = getEsCache('post', cacheKey);
        if (afterWait) return afterWait;
        const url = `${baseUrl}/wp-json/wp/v2/posts/${encodeURIComponent(String(id))}?_fields=content,title,link,slug`;
        const post = responseJson(await client.get(url, { responseType: 'json', validateStatus: () => true }));
        if (post?.content || post?.title) setEsCache('post', cacheKey, post, ES_CACHE_TTL.post);
        return post;
    });
}

function slugifyEurostreamingTitle(value) {
    return normalizeTitle(value)
        .replace(/\b(?:stagione|season)\b.*$/i, '')
        .replace(/\b(?:19|20)\d{2}\b/g, '')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '')
        .trim();
}

function buildDirectPageSlugs(meta = {}, title = '') {
    const candidates = [
        title,
        meta?.originalTitle,
        meta?.originalName,
        meta?.name,
        meta?.seriesName
    ];
    const out = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const slug = slugifyEurostreamingTitle(candidate);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        out.push(slug);
    }
    return out.slice(0, 4);
}

function extractPageTitle(html, fallback = '') {
    const text = String(html || '');
    const patterns = [
        /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
        /<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
        /<title\b[^>]*>([\s\S]*?)<\/title>/i
    ];
    for (const pattern of patterns) {
        const title = decodeHtml(text.match(pattern)?.[1] || '');
        if (title) return title.replace(/\s*[-|:]\s*eurostreaming.*$/i, '').trim();
    }
    return fallback;
}

async function fetchDirectPage(client, slug, baseUrl, title) {
    const safeSlug = String(slug || '').replace(/^\/+|\/+$/g, '');
    if (!safeSlug) return null;
    const cacheKey = [baseUrl, safeSlug];
    const cached = getEsCache('directPage', cacheKey);
    if (cached) {
        esDebug('info', 'direct page cache hit', { slug: safeSlug });
        return cached;
    }

    return withEsCoalescing('directPage', cacheKey, async () => {
        const afterWait = getEsCache('directPage', cacheKey);
        if (afterWait) return afterWait;
        const url = `${baseUrl}/${encodeURIComponent(safeSlug).replace(/%2F/gi, '/')}/`;
        const response = await client.get(url, {
            responseType: 'text',
            maxRedirects: 5,
            validateStatus: () => true
        });
        const status = Number(response?.status || 0);
        if (status && (status < 200 || status >= 400)) return null;
        const html = responseText(response);
        if (!html || !/<a\b/i.test(html)) return null;
        const post = {
            title: { rendered: extractPageTitle(html, title) },
            content: { rendered: html },
            sourceUrl: finalResponseUrl(response, url) || url
        };
        setEsCache('directPage', cacheKey, post, ES_CACHE_TTL.directPage);
        return post;
    });
}

function extractSiteSearchSlugs(html, title, baseUrl) {
    const expectedSlug = slugifyEurostreamingTitle(title);
    const candidates = [];
    const seen = new Set();
    for (const anchor of extractAnchors(html)) {
        const slug = directSlugFromUrl(anchor.href, baseUrl);
        if (!slug || seen.has(slug)) continue;
        const score = scoreEurostreamingSearchCandidate({ title: anchor.label, url: anchor.href, subtype: 'post' }, title, baseUrl);
        if (score < 65 && !(expectedSlug && (slug === expectedSlug || slug.startsWith(`${expectedSlug}-`)))) continue;
        seen.add(slug);
        candidates.push({ slug, label: anchor.label, score });
    }
    return candidates.sort((a, b) => b.score - a.score).slice(0, 8);
}

async function fetchSiteSearchSlugs(client, title, baseUrl) {
    const cacheKey = [baseUrl, normalizeTitle(title)];
    const cached = getEsCache('siteSearch', cacheKey);
    if (cached) {
        esDebug('info', 'site search cache hit', { title, count: cached.length });
        return cached;
    }
    return withEsCoalescing('siteSearch', cacheKey, async () => {
        const afterWait = getEsCache('siteSearch', cacheKey);
        if (afterWait) return afterWait;
        const url = `${baseUrl}/?s=${encodeURIComponent(title)}`;
        const response = await client.get(url, {
            responseType: 'text',
            maxRedirects: 5,
            validateStatus: () => true
        });
        const status = Number(response?.status || 0);
        if (status && (status < 200 || status >= 400)) return [];
        const slugs = extractSiteSearchSlugs(responseText(response), title, baseUrl);
        if (slugs.length) setEsCache('siteSearch', cacheKey, slugs, ES_CACHE_TTL.siteSearch);
        return slugs;
    });
}

function esDebug(level, message, payload = null) {
    esLogger.log(level, message, payload);
}

function safeHost(value) {
    try { return new URL(String(value || '')).hostname; } catch (_) { return ''; }
}

function safePath(value) {
    try { return new URL(String(value || '')).pathname; } catch (_) { return ''; }
}

async function appendStreamsFromPost(post, context) {
    const { client, config, title, expectedYear, season, episode, reqHost, options, streams, seen, source } = context;
    const postTitle = post?.title?.rendered || post?.title || '';
    const content = post?.content?.rendered || post?.content || responseText(post);
    if (!content) return false;
    if (!titleMatches(postTitle, title, content, expectedYear)) {
        esDebug('info', 'candidate skipped title mismatch', { source, postTitle: decodeHtml(postTitle).slice(0, 120), title });
        return false;
    }

    const blocks = extractEurostreamingEpisodeBlocks(content, season, episode);
    esDebug('info', 'candidate parsed', { source, postTitle: decodeHtml(postTitle).slice(0, 120), blocks: blocks.length, season, episode });

    for (const block of blocks) {
        const links = pickHostLinks(block.html);
        esDebug('info', 'episode block links', { source, language: block.language, links: links.map((link) => link.label || link.host) });
        const resolveAll = String(options?.resolveAllHosts ?? process.env.ES_RESOLVE_ALL_HOSTS ?? 'true').toLowerCase() === 'true';
        const linksToResolve = resolveAll ? links : links.slice(0, 1);
        const tasks = linksToResolve.map(async (link) => {
            try {
                const timeoutMs = getHostResolveTimeoutMs(link?.host);
                const stream = await withTimeout(buildHostStream(link, {
                    client,
                    config,
                    title: `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
                    language: block.language,
                    reqHost,
                    options
                }), timeoutMs, `Eurostreaming ${link?.label || link?.host || 'host'}`);
                return { link, stream };
            } catch (error) {
                esDebug('warn', 'host stream failed', { source, host: link?.host, label: link?.label, error: error?.message || String(error) });
                return { link, stream: null };
            }
        });

        const results = await Promise.allSettled(tasks);
        for (const result of results) {
            const value = result.status === 'fulfilled' ? result.value : null;
            const link = value?.link;
            const streamList = Array.isArray(value?.stream) ? value.stream : (value?.stream ? [value.stream] : []);
            if (!streamList.length) {
                esDebug('warn', 'host stream returned null', { source, host: link?.host, label: link?.label, hrefHost: safeHost(link?.href) });
                continue;
            }
            for (const stream of streamList) {
                const key = stream?.url;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                streams.push(stream);
            }
        }
    }

    return streams.length > 0;
}

async function searchEurostreaming(meta = {}, config = {}, reqHost = null, options = {}) {
    if (config?.filters?.enableEs !== true) return [];
    const { season, episode } = getSeasonEpisode(meta);
    if (!season || !episode) return [];

    const title = getMetaTitle(meta);
    if (!title) return [];

    const client = options.client || getDefaultClient();
    if (!client || typeof client.get !== 'function') return [];

    const baseUrl = String(options.baseUrl || getBaseUrl()).replace(/\/+$/, '');
    const expectedYear = getMetaYear(meta);
    const streams = [];
    const seen = new Set();
    const context = { client, config, title, expectedYear, season, episode, reqHost, options, streams, seen };

    try {
        esDebug('info', 'search start', { title, season, episode, baseUrl });
        const results = await fetchSearchResults(client, title, baseUrl);
        esDebug('info', 'wp search results', { title, count: results.length });
        for (const result of results) {
            const postId = result?.id;
            if (!postId) continue;
            const post = await fetchPost(client, postId, baseUrl);
            await appendStreamsFromPost(post, { ...context, source: `wp:${postId}` });
            if (streams.length) break;
        }

        if (!streams.length) {
            const siteCandidates = await fetchSiteSearchSlugs(client, title, baseUrl);
            if (siteCandidates.length) {
                esDebug('info', 'site search candidates', { title, slugs: siteCandidates.map((item) => item.slug).slice(0, 6) });
                for (const candidate of siteCandidates) {
                    try {
                        const post = await fetchDirectPage(client, candidate.slug, baseUrl, title);
                        if (!post) continue;
                        await appendStreamsFromPost(post, { ...context, source: `site-search:${candidate.slug}` });
                        if (streams.length) break;
                    } catch (error) {
                        esDebug('warn', 'site search direct page failed', { slug: candidate.slug, error: error?.message || String(error) });
                    }
                }
            }
        }

        if (!streams.length) {
            const slugs = buildDirectPageSlugs(meta, title);
            esDebug('info', 'direct page fallback start', { title, slugs });
            for (const slug of slugs) {
                try {
                    const post = await fetchDirectPage(client, slug, baseUrl, title);
                    if (!post) {
                        esDebug('info', 'direct page empty', { slug });
                        continue;
                    }
                    await appendStreamsFromPost(post, { ...context, source: `direct:${slug}` });
                    if (streams.length) break;
                } catch (error) {
                    esDebug('warn', 'direct page failed', { slug, error: error?.message || String(error) });
                }
            }
        }
    } catch (error) {
        esDebug('warn', 'search failed', { title, season, episode, error: error?.message || String(error) });
        return streams.sort((a, b) => (a?._priority ?? 9) - (b?._priority ?? 9));
    }

    if (!streams.length) esDebug('warn', 'search returned no streams', { title, season, episode, baseUrl });
    return streams.sort((a, b) => (a?._priority ?? 9) - (b?._priority ?? 9));
}

module.exports = {
    extractEurostreamingEpisodeBlocks,
    pickHostLinks,
    searchEurostreaming,
    __private: {
        decodeHtml,
        normalizeTitle,
        titleMatches,
        isDeltabitLikeUrl,
        SAFEGO_CAPTCHA_DEFAULTS,
        validateSafegoCaptchaDigits,
        extractDeltabitSource,
        isProbablyPlayableMediaUrl,
        buildHostStream,
        buildKrakenUprotMaxstreamStream,
        buildForwardedMaxstreamTarget,
        buildLocalMaxstreamStream,
        isMaxstreamExtractedPlayable,
        isDeltabitDirectCdnUrl,
        buildDeltabitPlaybackHeaders
    }
};

