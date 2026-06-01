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

const TURBOVID_DOMAINS = [
    'turbovid.me',
    'turboviplay.com',
    'emturbovid.com',
    'tuborstb.co',
    'javggvideo.xyz',
    'stbturbo.xyz',
    'turbovidhls.com'
];

const TURBOVID_HINTS = [
    'turbovid',
    'turbovideo',
    'turbovidplay',
    'turboviplay',
    'emturbovid',
    'turbovidhls'
];

const TURBOVID_REGEX = /(?:^|\/|\.)(?:turbovid\.me|turboviplay\.com|emturbovid\.com|tuborstb\.co|javggvideo\.xyz|stbturbo\.xyz|turbovidhls\.com)(?:[/:?#]|$)/i;

const INTERMEDIATE_PATTERNS = [
    /(?:var\s+|let\s+|const\s+)?urlPlay\s*=\s*['"]([^'"]+)['"]/i,
    /(?:var\s+|let\s+|const\s+)?videoPlay\s*=\s*['"]([^'"]+)['"]/i,
    /(?:var\s+|let\s+|const\s+)?playerUrl\s*=\s*['"]([^'"]+)['"]/i,
    /["']urlPlay["']\s*[:=]\s*["']([^"']+)["']/i,
    /["']video["']\s*[:=]\s*["']([^"']+)["']/i,
    /["']hash["']\s*[:=]\s*["']([^"']+)["']/i,
    /\b(?:playUrl|videoUrl|streamUrl|sourceUrl|playerUrl)\b\s*[:=]\s*["']([^"']+)["']/i,
    /data-(?:hash|url|video|href|src|link|play)=["']([^"']+)["']/i,
    /(?:fetch|ajax)\s*\(\s*["']([^"']+)["']/i,
    /\$\.get(?:JSON)?\s*\(\s*["']([^"']+)["']/i,
    /\$\.post\s*\(\s*["']([^"']+)["']/i
];

const SOURCE_PATTERNS = [
    /["'](?:file|src|source|url|hls|playlist|stream|video_url|videoUrl|stream_url|streamUrl|master|link)["']?\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i,
    /<source\b[^>]+src=["']([^"']+\.m3u8[^"']*)["']/i,
    /(https?:\\?\/\\?\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i
];

const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form>/ig;
const INPUT_RE = /<input\b[^>]*>/ig;
const BUTTON_RE = /<(?:input|button)\b[^>]*>(?:[\s\S]*?<\/button>)?/ig;

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;|&#038;|&#38;/gi, '&')
        .replace(/&quot;|&#034;|&#34;/gi, '"')
        .replace(/&#039;|&#39;|&apos;/gi, "'")
        .replace(/&lt;|&#060;|&#60;/gi, '<')
        .replace(/&gt;|&#062;|&#62;/gi, '>')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            try { return String.fromCodePoint(Number.parseInt(hex, 16)); } catch (_) { return _; }
        })
        .replace(/&#(\d+);/g, (_, dec) => {
            try { return String.fromCodePoint(Number.parseInt(dec, 10)); } catch (_) { return _; }
        });
}

function safeDecodeURIComponent(value) {
    try { return decodeURIComponent(String(value || '')); } catch (_) { return String(value || ''); }
}

function stripApiPassword(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';

    try {
        const parsed = new URL(raw);
        parsed.searchParams.delete('api_password');
        return parsed.toString();
    } catch (_) {
        return raw
            .split('?api_password')[0]
            .split('&api_password')[0]
            .replace(/([?&])api_password=[^&]+/ig, '$1')
            .replace(/[?&]$/g, '');
    }
}

function isTurbovidUrl(url) {
    const raw = String(url || '');
    try {
        const host = new URL(raw).hostname.replace(/^www\./i, '').toLowerCase();
        return TURBOVID_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch (_) {
        return TURBOVID_REGEX.test(raw);
    }
}

function looksLikeTurbovid(value) {
    const raw = String(value || '').toLowerCase();
    return isTurbovidUrl(raw) || TURBOVID_HINTS.some((hint) => raw.includes(hint));
}

function unwrapExtractorTarget(url) {
    let realUrl = String(url || '').trim();
    if (!realUrl) return '';

    try {
        const parsed = new URL(realUrl);
        for (const key of ['d', 'url', 'target', 'source']) {
            const values = parsed.searchParams.getAll(key).filter(Boolean);
            if (!values.length) continue;
            const candidate = safeDecodeURIComponent(values[values.length - 1]);
            if (looksLikeTurbovid(candidate)) {
                realUrl = candidate;
                break;
            }
        }
    } catch (_) {
        const matches = [...realUrl.matchAll(/[?&](?:d|url|target|source)=([^&]+)/ig)]
            .map((match) => match?.[1])
            .filter(Boolean);
        for (const encoded of matches.reverse()) {
            const candidate = safeDecodeURIComponent(encoded);
            if (looksLikeTurbovid(candidate)) {
                realUrl = candidate;
                break;
            }
        }
    }

    return stripApiPassword(realUrl);
}

function normalizeTurbovidUrl(url, baseUrl = null) {
    const unwrapped = unwrapExtractorTarget(url);
    const normalized = normalizeRemoteUrl(unwrapped, baseUrl);
    if (!normalized || !isTurbovidUrl(normalized)) return null;
    return normalized;
}

function cleanJsUrl(value) {
    return normalizeEscapedText(decodeHtmlEntities(value))
        .replace(/\\u0026/gi, '&')
        .replace(/&amp;/gi, '&')
        .replace(/\\\//g, '/')
        .trim();
}

function normalizeMaybeRelativeUrl(value, baseUrl) {
    const decoded = cleanJsUrl(value);
    if (!decoded || /^(?:javascript|data):/i.test(decoded)) return null;
    if (decoded.startsWith('//')) return normalizeRemoteUrl(`https:${decoded}`, baseUrl);
    return normalizeRemoteUrl(decoded, baseUrl);
}

function extractFirstMediaUrl(searchSpace, baseUrl) {
    return extractMediaUrl(normalizeEscapedText(searchSpace), SOURCE_PATTERNS, baseUrl);
}

function extractIntermediateUrl(html, baseUrl) {
    const text = normalizeEscapedText(html);
    for (const pattern of INTERMEDIATE_PATTERNS) {
        const match = text.match(pattern);
        const url = normalizeMaybeRelativeUrl(match?.[1], baseUrl);
        if (url) return url;
    }
    return null;
}

function getAttr(tag, name) {
    const match = String(tag || '').match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))
        || String(tag || '').match(new RegExp(`\\b${name}=([^\\s>]+)`, 'i'));
    return match?.[1] ? decodeHtmlEntities(match[1]).trim() : '';
}

function extractInputs(html) {
    const fields = {};
    for (const input of String(html || '').match(INPUT_RE) || []) {
        const type = getAttr(input, 'type').toLowerCase();
        if (['button', 'reset', 'image', 'file'].includes(type)) continue;
        const name = getAttr(input, 'name');
        if (!name) continue;
        fields[name] = getAttr(input, 'value');
    }
    return fields;
}

function extractSubmitButtons(html) {
    const buttons = [];
    for (const tag of String(html || '').match(BUTTON_RE) || []) {
        const type = getAttr(tag, 'type').toLowerCase();
        if (type && type !== 'submit' && !/^<button/i.test(tag)) continue;
        const name = getAttr(tag, 'name');
        const value = getAttr(tag, 'value') || decodeHtmlEntities(tag.replace(/<[^>]+>/g, ' ')).trim();
        if (name || value) buttons.push({ name, value });
    }
    return buttons;
}

function pickPlayableForms(html) {
    const forms = [];
    const fallback = [];

    for (const match of String(html || '').matchAll(FORM_RE)) {
        const attrs = match?.[1] || '';
        const body = match?.[2] || '';
        const form = {
            action: getAttr(attrs, 'action'),
            method: (getAttr(attrs, 'method') || 'POST').toUpperCase(),
            body
        };
        const haystack = `${attrs} ${body}`.replace(/<[^>]+>/g, ' ');
        if (/proceed|video|watch|play|imhuman|method_free|op\s*=|download|guarda|continua|stream/i.test(haystack)) forms.push(form);
        else fallback.push(form);
    }

    return [...forms, ...fallback].slice(0, 4);
}

function buildFormPayloads(fields, html) {
    const seen = new Set();
    const payloads = [];
    const addPayload = (extra = {}) => {
        const data = { ...fields, ...extra };
        const key = JSON.stringify(Object.keys(data).sort().map((field) => [field, data[field]]));
        if (seen.has(key)) return;
        seen.add(key);
        payloads.push(data);
    };

    addPayload();
    addPayload({ imhuman: 'Proceed to video' });
    addPayload({ imhuman: 'Watch video' });
    addPayload({ imhuman: 'Guarda lo streaming' });
    addPayload({ imhuman: 'GUARDA LO STREAMING' });
    addPayload({ method_free: '', imhuman: fields.imhuman || '' });
    addPayload({ method_free: 'streaming', imhuman: fields.imhuman || '' });
    addPayload({ op: fields.op || 'download1', imhuman: 'Proceed to video' });

    const buttons = extractSubmitButtons(html);
    for (const button of buttons.slice(0, 5)) {
        if (!button.name) continue;
        addPayload({ [button.name]: button.value || 'Proceed to video', imhuman: fields.imhuman || '' });
    }

    return payloads.slice(0, 10);
}

function responseText(response) {
    if (!response) return '';
    if (typeof response.data === 'string') return response.data;
    if (Buffer.isBuffer(response.data)) return response.data.toString('utf8');
    try { return JSON.stringify(response.data || ''); } catch (_) { return String(response.data || ''); }
}

function finalResponseUrl(response, fallbackUrl) {
    return response?.request?.res?.responseUrl
        || response?.request?._redirectable?._currentUrl
        || response?.config?.url
        || String(response?.url || fallbackUrl || '');
}

function buildTurbovidPageHeaders(playerUrl, { userAgent = DEFAULT_USER_AGENT, referer = null } = {}) {
    const origin = getOrigin(playerUrl, 'https://turbovid.me');
    return buildRequestHeaders(playerUrl, {
        userAgent,
        referer: referer || `${origin}/`,
        origin,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
}

function buildTurbovidPlaybackHeaders(playerUrl, userAgent = DEFAULT_USER_AGENT) {
    const origin = getOrigin(playerUrl, 'https://turbovid.me');
    return {
        'User-Agent': userAgent,
        Referer: playerUrl,
        Origin: origin,
        Accept: '*/*',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };
}

async function submitFormForVideo(client, playerUrl, html, headers, timeout) {
    if (!client || typeof client.get !== 'function') return null;

    const forms = pickPlayableForms(html);
    if (!forms.length) return null;

    const origin = getOrigin(playerUrl, 'https://turbovid.me');

    for (const form of forms) {
        const actionUrl = normalizeRemoteUrl(form.action || playerUrl, playerUrl);
        if (!actionUrl) continue;

        const fields = extractInputs(form.body);
        const payloads = buildFormPayloads(fields, form.body);
        const method = form.method === 'GET' ? 'GET' : 'POST';

        for (const payload of payloads) {
            try {
                const requestHeaders = {
                    ...headers,
                    Origin: origin,
                    Referer: playerUrl,
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                };

                let response;
                if (method === 'GET') {
                    response = await client.get(actionUrl, {
                        params: payload,
                        headers: requestHeaders,
                        timeout,
                        responseType: 'text',
                        maxRedirects: 5,
                        validateStatus: () => true
                    });
                } else if (typeof client.post === 'function') {
                    response = await client.post(actionUrl, new URLSearchParams(payload).toString(), {
                        headers: {
                            ...requestHeaders,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        timeout,
                        responseType: 'text',
                        maxRedirects: 5,
                        validateStatus: () => true
                    });
                }

                const status = Number(response?.status ?? response?.statusCode ?? 0) || 0;
                const text = responseText(response);
                if (status >= 200 && status < 400 && text) {
                    return { text, url: finalResponseUrl(response, actionUrl) || actionUrl };
                }
            } catch (_) {}
        }
    }

    return null;
}

async function resolveFinalStream(client, playerUrl, html, headers, options = {}) {
    const direct = extractFirstMediaUrl(html, playerUrl);
    if (direct) return direct;

    const intermediate = extractIntermediateUrl(html, playerUrl);
    if (!intermediate) return null;

    if (/\.m3u8(?:$|[?#])/i.test(intermediate)) return intermediate;

    const mediaHeaders = {
        ...headers,
        Referer: playerUrl,
        Origin: getOrigin(playerUrl, 'https://turbovid.me'),
        Accept: '*/*'
    };
    const { status, text } = await fetchText(client, intermediate, {
        headers: mediaHeaders,
        timeout: Number(options?.mediaTimeout || options?.timeout || 10_000)
    });
    if (status < 200 || status >= 400 || !text) return null;
    return extractFirstMediaUrl(text, intermediate);
}

async function extractTurbovid(url, options = {}) {
    const client = options?.client;
    const playerUrl = normalizeTurbovidUrl(url);
    if (!playerUrl || !client || typeof client.get !== 'function') return null;

    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const headers = buildTurbovidPageHeaders(playerUrl, {
        userAgent,
        referer: options?.requestReferer || options?.referer || `${getOrigin(playerUrl)}/`
    });

    const { status, text: html } = await fetchText(client, playerUrl, {
        headers,
        timeout: Number(options?.timeout || 12_000)
    });
    if (status < 200 || status >= 400 || !html) return null;

    let streamUrl = await resolveFinalStream(client, playerUrl, html, headers, options);
    if (!streamUrl) {
        const submitted = await submitFormForVideo(client, playerUrl, html, headers, Number(options?.postTimeout || options?.timeout || 12_000));
        if (submitted?.text) {
            streamUrl = await resolveFinalStream(client, submitted.url || playerUrl, submitted.text, headers, options)
                || extractFirstMediaUrl(submitted.text, submitted.url || playerUrl);
        }
    }
    if (!streamUrl || !/\.m3u8(?:$|[?#])/i.test(streamUrl)) return null;

    const playbackHeaders = buildTurbovidPlaybackHeaders(playerUrl, userAgent);
    const quality = await probeStreamQuality(client, streamUrl, {
        headers: playbackHeaders,
        timeout: Number(options?.playlistTimeoutMs || 5000),
        fallback: options?.quality || 'Unknown'
    });

    return {
        url: streamUrl,
        sourceUrl: playerUrl,
        headers: playbackHeaders,
        extractor: 'TurboVid',
        name: 'TurboVid',
        quality,
        priority: 3,
        via: 'turbovid-local'
    };
}

module.exports = {
    extractTurbovid,
    isTurbovidUrl,
    normalizeTurbovidUrl
};
