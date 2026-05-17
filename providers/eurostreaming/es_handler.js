'use strict';

const { buildMediaflowUrl, buildWebStream, normalizeRemoteUrl } = require('../extractors/common');
const { isUprotUrl, resolveUprotToMaxstream } = require('../extractors/hosters/uprot');

const DEFAULT_BASE_URL = 'https://eurostream.ing';
const PROVIDER = 'Eurostreaming';
const PROVIDER_CODE = 'ES';
const SEARCH_TTL_FALLBACK_MS = 12_000;

function getBaseUrl() {
    return String(process.env.EUROSTREAMING_URL || process.env.ES_DOMAIN || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
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
    const markerRe = new RegExp(`(?:^|\\b)0*${safeSeason}\\s*(?:x|&#215;|&#x0?d7;|\\u00d7)\\s*0*${safeEpisode}(?:\\b|\\D)`, 'i');
    const anyEpisodeRe = /(?:^|\b)\d{1,2}\s*(?:x|&#215;|&#x0?d7;|\u00d7)\s*\d{1,4}(?:\b|\D)/i;
    const blocks = [];
    const segments = splitEpisodeSegments(description);
    let previousText = '';

    for (const segment of segments) {
        if (!markerRe.test(segment)) {
            if (!anyEpisodeRe.test(segment)) previousText = `${previousText} ${decodeHtml(segment)}`.slice(-500);
            continue;
        }

        const html = segment.replace(markerRe, '').replace(/^\s*[\-–—:]+\s*/, '').trim() || segment;
        blocks.push({
            html,
            language: detectEpisodeLanguage(segment, blocks.length, previousText)
        });
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
        const looksLikeDeltabit = /delta\s*bit/i.test(label) || /\/delta\//i.test(href) || isDeltabitLikeUrl(href);
        const looksLikeMixdrop = /mix\s*drop/i.test(label) || /\/mix\//i.test(href) || /mixdrop|m1xdrop|mxcontent|mixdrp/i.test(href);
        const looksLikeMaxstream = /max\s*stream|uprot/i.test(label) || /uprot\.net|maxstream\.video|stayonline\.pro/i.test(href);

        if (looksLikeDeltabit) {
            if (isDeltabitLikeUrl(href) || REDIRECTOR_RE.test(href)) {
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
            const maxstreamHref = (isUprotUrl(href) || isMaxstreamLikeUrl(href)) ? href : companionUprot?.href;
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

function isDeltabitLikeUrl(value) {
    return DELTABIT_URL_RE.test(String(value || ''));
}

function isDirectMediaUrl(value) {
    return DIRECT_MEDIA_URL_RE.test(String(value || ''));
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

    const cookieFile = options.safegoCookieFile || process.env.SAFEGO_COOKIE_FILE;
    const cookieText = loadJsonLikeFile(cookieFile);
    if (!cookies && cookieText) cookies = parseLooseObject(cookieText) || cookieText.trim();

    if (captchaData && typeof captchaData === 'object' && !Array.isArray(captchaData)) {
        if (captchaData.captcha && !captchaData.captch5) captchaData = { ...captchaData, captch5: captchaData.captcha };
    }

    return { cookies, captchaData };
}

function mergeCookieHeader(headers, cookies) {
    const cookieHeader = cookiesToHeader(cookies);
    if (!cookieHeader) return headers;
    return { ...headers, Cookie: cookieHeader };
}

async function postSafego(client, url, headers, state, data = null) {
    if (!client || typeof client.post !== 'function') return null;
    const postHeaders = mergeCookieHeader(headers, state?.cookies);
    const body = data || state?.captchaData || {};
    try {
        return await client.post(url, body, {
            headers: postHeaders,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true
        });
    } catch (_) {
        return null;
    }
}

async function resolveSafegoPage(client, safegoUrl, headers, options = {}) {
    const state = loadSafegoState(options);
    const attempts = [];

    if (state.cookies) attempts.push({ kind: 'cookies', data: null });
    if (state.cookies && state.captchaData) attempts.push({ kind: 'captcha', data: state.captchaData });

    for (const attempt of attempts) {
        const response = await postSafego(client, safegoUrl, headers, state, attempt.data);
        const finalUrl = finalResponseUrl(response, safegoUrl);
        if (finalUrl && finalUrl !== safegoUrl && !SAFEGO_RE.test(finalUrl)) return finalUrl;
        const candidate = extractRedirectCandidate(responseText(response), safegoUrl);
        if (candidate && !SAFEGO_RE.test(candidate)) return candidate;
    }

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
            if (safegoCandidate) return safegoCandidate;
        }

        try {
            const requestHeaders = CLICKA_RE.test(current)
                ? { ...headers, Range: 'bytes=0-0' }
                : headers;
            const response = await client.get(current, {
                headers: requestHeaders,
                maxRedirects: 5,
                responseType: 'text',
                validateStatus: () => true
            });
            const finalUrl = finalResponseUrl(response, current);
            if (finalUrl && finalUrl !== current) {
                current = finalUrl;
                if (!REDIRECTOR_RE.test(current)) return current;
                if (SAFEGO_RE.test(current)) {
                    const origin = (() => { try { return new URL(current).origin; } catch (_) { return ''; } })();
                    const safegoCandidate = await resolveSafegoPage(client, current, { ...headers, Origin: origin, Referer: current }, options);
                    if (safegoCandidate) return safegoCandidate;
                }
            }

            const nextUrl = extractRedirectCandidate(responseText(response), current);
            if (!nextUrl || nextUrl === current) break;
            current = nextUrl;
            if (!REDIRECTOR_RE.test(current)) return current;
        } catch (error) {
            const finalUrl = finalResponseUrl(error?.response, current);
            if (finalUrl && finalUrl !== current) return finalUrl;
            break;
        }
    }

    return current;
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
    const patterns = [
        /sources\s*:\s*\[\s*["']([^"']+)["']/i,
        /file\s*:\s*["']([^"']+)["']/i,
        /source\s+src=["']([^"']+)["']/i
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        const candidate = compactRedirectCandidate(match?.[1], baseUrl);
        if (candidate && isDirectMediaUrl(candidate)) return candidate;
    }
    const direct = compactRedirectCandidate(text.match(DIRECT_MEDIA_URL_RE)?.[0], baseUrl);
    return direct && isDirectMediaUrl(direct) ? direct : null;
}

function getDeltabitWaitMs(options = {}) {
    const raw = options.deltabitWaitMs ?? process.env.ES_DELTABIT_WAIT_MS ?? '2500';
    const waitMs = Number.parseInt(String(raw), 10);
    return Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 8000) : 0;
}

function delay(ms) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveDeltabitDirectStream(client, href, referer, options = {}) {
    if (!client || typeof client.get !== 'function' || typeof client.post !== 'function') return null;
    let pageUrl = normalizeRemoteUrl(href);
    if (!pageUrl) return null;

    if (REDIRECTOR_RE.test(pageUrl)) {
        const resolved = await resolveRedirectLink(client, pageUrl, referer || getBaseUrl(), options);
        if (resolved && resolved !== pageUrl) pageUrl = resolved;
    }

    if (!pageUrl || REDIRECTOR_RE.test(pageUrl) || !isDeltabitLikeUrl(pageUrl)) return null;

    const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
    const warmHeaders = {
        Referer: 'https://safego.cc/',
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    let response = await client.get(pageUrl, {
        headers: warmHeaders,
        maxRedirects: 5,
        responseType: 'text',
        validateStatus: () => true
    });

    const finalUrl = finalResponseUrl(response, pageUrl);
    if (finalUrl) pageUrl = finalUrl;

    const html = responseText(response);
    const fields = extractFormFields(html);
    const directSource = extractDeltabitSource(html, pageUrl);
    const origin = (() => { try { return new URL(pageUrl).origin; } catch (_) { return ''; } })();
    if (directSource) {
        return {
            streamUrl: directSource,
            pageUrl,
            fileName: fields.fname || 'DeltaBit',
            headers: { Referer: pageUrl, Origin: origin, 'User-Agent': userAgent }
        };
    }

    if (!Object.keys(fields).length) return null;

    const data = {
        ...fields,
        imhuman: options.deltabitImhuman ?? '',
        referer: pageUrl
    };

    await delay(getDeltabitWaitMs(options));

    response = await client.post(pageUrl, data, {
        headers: {
            Origin: origin,
            Referer: pageUrl,
            'User-Agent': userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        maxRedirects: 5,
        responseType: 'text',
        validateStatus: () => true
    });

    const source = extractDeltabitSource(responseText(response), pageUrl);
    if (!source) return null;

    return {
        streamUrl: source,
        pageUrl,
        fileName: data.fname || 'DeltaBit',
        headers: { Referer: pageUrl, Origin: origin, 'User-Agent': userAgent }
    };
}

function streamPriority(label) {
    if (/delta/i.test(label)) return 1;
    if (/mix/i.test(label)) return 2;
    if (/max/i.test(label)) return 3;
    return 9;
}

function buildDirectExtractorStream({ targetUrl, label, title, language, headers = null, fileName = '' }) {
    return buildWebStream({
        name: `🌍 ${PROVIDER} | ${label}`,
        title: `${title}\n☁️ ${label} • ${language === 'SUB-ITA' ? '🇮🇹 SUB-ITA' : '🇮🇹 ITA'}${fileName ? `\n${fileName}` : ''}`,
        url: targetUrl,
        extractor: label,
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers,
        mediaflowUrl: null,
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                language,
                audioLanguages: language === 'SUB-ITA' ? [] : ['ita'],
                subtitleLanguages: language === 'SUB-ITA' ? ['ita'] : []
            }
        },
        extra: { _priority: streamPriority(label) }
    });
}

function buildMfpExtractorStream({ config, targetUrl, host, label, title, language }) {
    if (!config?.mediaflow?.url) return null;
    const mfpUrl = buildMediaflowUrl(config, targetUrl, 'extractor', host);
    if (!mfpUrl || mfpUrl === targetUrl) return null;

    return buildWebStream({
        name: `🌍 ${PROVIDER} | ${label}`,
        title: `${title}\n☁️ ${label} • ${language === 'SUB-ITA' ? '🇮🇹 SUB-ITA' : '🇮🇹 ITA'}`,
        url: mfpUrl,
        extractor: label,
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers: null,
        mediaflowUrl: config.mediaflow.url,
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                language,
                audioLanguages: language === 'SUB-ITA' ? [] : ['ita'],
                subtitleLanguages: language === 'SUB-ITA' ? ['ita'] : []
            }
        },
        extra: { _priority: streamPriority(label) }
    });
}

async function buildHostStream(link, context) {
    const { client, config, title, language, options } = context;
    if (link.host === 'deltabit') {
        const resolved = await resolveDeltabitDirectStream(client, link.href, options?.baseUrl || getBaseUrl(), options);
        if (!resolved?.streamUrl) return null;
        return buildDirectExtractorStream({
            targetUrl: resolved.streamUrl,
            label: 'DeltaBit',
            title,
            language,
            headers: resolved.headers,
            fileName: resolved.fileName
        });
    }

    if (link.host === 'mixdrop') {
        let targetUrl = normalizeRemoteUrl(link.href);
        if (targetUrl && !isMixdropUrl(targetUrl) && REDIRECTOR_RE.test(targetUrl)) {
            targetUrl = await resolveRedirectLink(client, targetUrl, options?.baseUrl || getBaseUrl(), options);
        }
        if (!targetUrl || !isMixdropUrl(targetUrl)) return null;
        return buildMfpExtractorStream({ config, targetUrl, host: 'Mixdrop', label: 'MixDrop', title, language });
    }

    if (link.host === 'maxstream') {
        let targetUrl = normalizeRemoteUrl(link.href);
        const originalUprotUrl = isUprotUrl(targetUrl) ? targetUrl : null;
        if (originalUprotUrl) {
            const resolved = await resolveUprotToMaxstream(client, targetUrl, options);
            targetUrl = resolved?.playerUrl || null;
            if (!targetUrl && config?.mediaflow?.url) {
                esDebug('warn', 'uprot local resolve failed; using MFP fallback', { hrefHost: safeHost(originalUprotUrl) });
                return buildMfpExtractorStream({ config, targetUrl: originalUprotUrl, host: 'Maxstream', label: 'MaxStream', title, language });
            }
        }
        if (!targetUrl || !isMaxstreamLikeUrl(targetUrl)) return null;
        return buildMfpExtractorStream({ config, targetUrl, host: 'Maxstream', label: 'MaxStream', title, language });
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

async function fetchSearchResults(client, title, baseUrl) {
    const url = `${baseUrl}/wp-json/wp/v2/search?search=${encodeURIComponent(title)}&_fields=id`;
    const json = responseJson(await client.get(url, { responseType: 'json' }));
    return Array.isArray(json) ? json : [];
}

async function fetchPost(client, id, baseUrl) {
    const url = `${baseUrl}/wp-json/wp/v2/posts/${encodeURIComponent(String(id))}?_fields=content,title`;
    return responseJson(await client.get(url, { responseType: 'json' }));
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
    const url = `${baseUrl}/${encodeURIComponent(slug).replace(/%2F/gi, '/')}/`;
    const response = await client.get(url, {
        responseType: 'text',
        maxRedirects: 5,
        validateStatus: () => true
    });
    const status = Number(response?.status || 0);
    if (status && (status < 200 || status >= 400)) return null;
    const html = responseText(response);
    if (!html || !/<a\b/i.test(html)) return null;
    return {
        title: { rendered: extractPageTitle(html, title) },
        content: { rendered: html },
        sourceUrl: finalResponseUrl(response, url) || url
    };
}

function esDebug(level, message, payload = null) {
    const logger = console[level] || console.info;
    const prefix = '[Eurostreaming:debug]';
    if (payload && typeof payload === 'object') {
        logger(`${prefix} ${message} ${JSON.stringify(payload)}`);
    } else {
        logger(`${prefix} ${message}`);
    }
}


function safeHost(value) {
    try { return new URL(String(value || '')).hostname; } catch (_) { return ''; }
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
        for (const link of links) {
            try {
                const stream = await buildHostStream(link, {
                    client,
                    config,
                    title: `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
                    language: block.language,
                    reqHost,
                    options
                });
                const key = stream?.url;
                if (!key) {
                    esDebug('warn', 'host stream returned null', { source, host: link?.host, label: link?.label, hrefHost: safeHost(link?.href) });
                    continue;
                }
                if (seen.has(key)) continue;
                seen.add(key);
                streams.push(stream);
                // Faster Eurostreaming resolution: if a lightweight clicka/safego
                // host resolved, do not spend the remaining provider budget on UPROT.
                // Set ES_RESOLVE_ALL_HOSTS=true to collect every available host.
                const resolveAll = String(options?.resolveAllHosts ?? process.env.ES_RESOLVE_ALL_HOSTS ?? 'false').toLowerCase() === 'true';
                if (!resolveAll && (link?.host === 'deltabit' || link?.host === 'mixdrop')) break;
            } catch (error) {
                esDebug('warn', 'host stream failed', { source, host: link?.host, label: link?.label, error: error?.message || String(error) });
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
        isDeltabitLikeUrl
    }
};
