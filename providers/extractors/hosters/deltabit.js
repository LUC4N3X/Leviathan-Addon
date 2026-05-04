'use strict';

const { getOrigin, normalizeRemoteUrl } = require('../common');
const {
    DEFAULT_USER_AGENT,
    buildRequestHeaders,
    extractFirstUrl,
    fetchText,
    probeStreamQuality,
    responseText
} = require('./shared');

const DELTABIT_REGEX = /(?:deltabit|safego|clicka)\.[a-z]+/i;
const DELTABIT_FINAL_RE = /https?:\/\/(?:www\.)?(?:deltabit)\.[a-z]+\/[^"'\s<>\\]+/i;
const REDIRECTOR_RE = /https?:\/\/(?:www\.)?(?:deltabit|safego|clicka)\.[a-z]+\/[^"'\s<>\\]+/ig;
const SOURCE_PATTERNS = [
    /sources\s*:\s*\[\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /sources\s*:\s*\[\s*\{\s*(?:src|file)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /(?:src|file)\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i
];
const FORM_FIELD_RE = /<input\b[^>]*name=["']([^"']+)["'][^>]*>/ig;
const VALUE_RE = /value=["']([^"']*)["']/i;
const CAPTCHA_RE = /<img\b[^>]+src=["']([^"']*captcha[^"']*)["']/i;

function isDeltabitUrl(url) {
    return DELTABIT_REGEX.test(String(url || ''));
}

function normalizeDeltabitInput(url, baseUrl = null) {
    const normalized = normalizeRemoteUrl(url, baseUrl);
    if (!normalized || !isDeltabitUrl(normalized)) return null;
    return normalized;
}

function compactCandidate(value, baseUrl = null) {
    if (!value) return null;
    return normalizeRemoteUrl(String(value).replace(/\\\//g, '/').replace(/\\/g, ''), baseUrl);
}

function extractRedirectCandidate(html, baseUrl) {
    const text = String(html || '');
    const direct = compactCandidate(text.match(DELTABIT_FINAL_RE)?.[0], baseUrl);
    if (direct) return direct;

    for (const match of text.matchAll(REDIRECTOR_RE)) {
        const candidate = compactCandidate(match?.[0], baseUrl);
        if (candidate) return candidate;
    }

    const patterns = [
        /url=(https?:\/\/[^"'<>\s]+)/i,
        /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
        /location\.replace\(\s*["']([^"']+)["']\s*\)/i,
        /href=["']([^"']*(?:deltabit|safego|clicka)[^"']*)["']/i,
        /data-(?:href|url|link)=["']([^"']*(?:deltabit|safego|clicka)[^"']*)["']/i
    ];

    for (const pattern of patterns) {
        const candidate = compactCandidate(text.match(pattern)?.[1], baseUrl);
        if (candidate && isDeltabitUrl(candidate)) return candidate;
    }
    return null;
}

async function postForm(client, targetUrl, body, headers, timeout) {
    if (!client || typeof client.post !== 'function') return { status: 0, text: '' };
    try {
        const response = await client.post(targetUrl, body, {
            headers,
            timeout,
            responseType: 'text'
        });
        return {
            status: Number(response?.status ?? response?.statusCode ?? 0) || 0,
            text: responseText(response),
            response
        };
    } catch (_) {
        return { status: 0, text: '', response: null };
    }
}

function extractFormFields(html) {
    const form = new URLSearchParams();
    const text = String(html || '');
    for (const match of text.matchAll(FORM_FIELD_RE)) {
        const full = match?.[0] || '';
        const name = match?.[1];
        if (!name) continue;
        const value = full.match(VALUE_RE)?.[1] || '';
        form.set(name, value);
    }
    return form;
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function resolveRedirectors(client, initialUrl, options = {}) {
    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const referer = options?.requestReferer || options?.referer || 'https://eurostreamings.help/';
    let targetUrl = initialUrl;

    for (let attempt = 0; attempt < Number(options?.redirectHops || 3); attempt += 1) {
        if (/deltabit\./i.test(targetUrl)) break;
        if (!/(?:safego|clicka)\./i.test(targetUrl)) break;

        const headers = buildRequestHeaders(targetUrl, { userAgent, referer });
        const { status, text } = await fetchText(client, targetUrl, {
            headers,
            timeout: Number(options?.redirectTimeout || 10_000)
        });
        if (status < 200 || status >= 400 || !text) break;

        const nextUrl = extractRedirectCandidate(text, targetUrl);
        if (!nextUrl || nextUrl === targetUrl) break;
        targetUrl = nextUrl;
    }

    return targetUrl;
}

function buildPlaybackHeaders(playerUrl, userAgent) {
    const origin = getOrigin(playerUrl, 'https://deltabit.co');
    return {
        Referer: playerUrl,
        Origin: origin,
        'User-Agent': userAgent || DEFAULT_USER_AGENT,
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };
}

async function extractDeltabit(url, options = {}) {
    const client = options?.client;
    const normalized = normalizeDeltabitInput(url);
    if (!normalized || !client || typeof client.get !== 'function') return null;

    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const referer = options?.requestReferer || options?.referer || 'https://eurostreamings.help/';

    try {
        const targetUrl = await resolveRedirectors(client, normalized, { ...options, userAgent, referer });
        if (!targetUrl || !/deltabit\./i.test(targetUrl)) return null;

        const pageHeaders = buildRequestHeaders(targetUrl, { userAgent, referer });
        const { status, text } = await fetchText(client, targetUrl, {
            headers: pageHeaders,
            timeout: Number(options?.timeout || 12_000)
        });
        if (status < 200 || status >= 400 || !text) return null;

        const directStream = extractFirstUrl(text, SOURCE_PATTERNS, targetUrl);
        if (directStream) {
            const headers = buildPlaybackHeaders(targetUrl, userAgent);
            const quality = await probeStreamQuality(client, directStream, { headers, fallback: 'Unknown' });
            return {
                url: directStream,
                sourceUrl: targetUrl,
                headers,
                extractor: 'DeltaBit',
                name: 'DeltaBit',
                quality,
                priority: 1,
                via: 'direct'
            };
        }

        const form = extractFormFields(text);
        if (!form.has('op') || !form.has('id')) return null;

        const captchaMatch = text.match(CAPTCHA_RE);
        if (captchaMatch && !options?.deltabitCaptchaCode) {
            return {
                unresolved: true,
                sourceUrl: targetUrl,
                extractor: 'DeltaBit',
                name: 'DeltaBit',
                reason: 'captcha_required'
            };
        }
        if (options?.deltabitCaptchaCode) form.set('code', String(options.deltabitCaptchaCode));

        await sleep(Number(options?.deltabitWaitMs ?? 3500));

        const postHeaders = {
            ...pageHeaders,
            Referer: targetUrl,
            Origin: getOrigin(targetUrl, getOrigin(referer)),
            'Content-Type': 'application/x-www-form-urlencoded'
        };
        const posted = await postForm(client, targetUrl, form.toString(), postHeaders, Number(options?.postTimeout || 12_000));
        if (posted.status < 200 || posted.status >= 400 || !posted.text) return null;

        const finalStream = extractFirstUrl(posted.text, SOURCE_PATTERNS, targetUrl);
        if (!finalStream) return null;

        const headers = buildPlaybackHeaders(targetUrl, userAgent);
        const quality = await probeStreamQuality(client, finalStream, { headers, fallback: 'Unknown' });
        return {
            url: finalStream,
            sourceUrl: targetUrl,
            headers,
            extractor: 'DeltaBit',
            name: 'DeltaBit',
            quality,
            priority: 1,
            via: 'form-post'
        };
    } catch (_) {
        return null;
    }
}

module.exports = {
    extractDeltabit,
    isDeltabitUrl,
    normalizeDeltabitInput
};
