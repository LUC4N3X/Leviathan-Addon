'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const {
    buildBrowserHeaders,
    createDomainCookieJar,
    getGotScraping,
    getGotScrapingHeaderOptions,
    getRandomFingerprint,
    isCloudflareChallenge,
    responseText
} = require('../utils/bypass');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const animeIdentity = require('../anime/anime_identity');
const kitsuProvider = require('../animeworld/kitsu_provider');
const { buildCinemaCityProxyUrl } = require('./cc_proxy');
const {
    buildWebStream,
    dedupeStreamsByUrl,
    normalizeRemoteUrl,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistQuality,
    qualityRank
} = require('../extractors/common');

const CC_HOME = 'https://cinemacity.cc';
const CC_SITEMAP = `${CC_HOME}/news_pages.xml`;
const CC_MAPPING_BASE = 'https://anime.questoleviatanormio.dpdns.org';
const CC_BOOTSTRAP_SESSION = Buffer.from(
    'ZGxlX3VzZXJfaWQ9MzI3Mjk7IGRsZV9wYXNzd29yZD04OTQxNzFjNmE4ZGFiMThlZTU5NGQ1YzY1MjAwOWEzNTs=',
    'base64'
).toString('utf8');

const FETCH_TIMEOUT_MS = 4500;
const GOT_REQUEST_TIMEOUT_MS = 2500;
const NETWORK_RETRIES = 3;
const CATALOG_PAGE_LIMIT = 8;
const CATALOG_SCAN_LIMIT = 24;
const CACHE = Object.freeze({
    search: 20 * 60 * 1000,
    resolved: 45 * 60 * 1000,
    stream: 10 * 60 * 1000,
    metadata: 60 * 60 * 1000,
    tmdb: 6 * 60 * 60 * 1000,
    kitsu: 6 * 60 * 60 * 1000,
    quality: 20 * 60 * 1000,
    sitemap: 30 * 60 * 1000,
    negative: 30 * 1000
});

const { updateCookiesFromResponse, getCookieHeaderForUrl } = createDomainCookieJar();

const httpClient = axios.create({
    timeout: FETCH_TIMEOUT_MS,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    proxy: false,
    validateStatus: () => true
});

class MemoryTtlMap {
    constructor({ ttlMs = 600000, max = 500 } = {}) {
        this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 600000;
        this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 500;
        this.items = new Map();
    }

    get(key) {
        if (!key) return null;
        const hit = this.items.get(key);
        if (!hit) return null;
        if (hit.until < Date.now()) {
            this.items.delete(key);
            return null;
        }
        this.items.delete(key);
        this.items.set(key, hit);
        return hit.value;
    }

    set(key, value) {
        if (!key) return;
        if (this.items.has(key)) this.items.delete(key);
        this.items.set(key, { value, until: Date.now() + this.ttlMs });
        while (this.items.size > this.max) {
            const oldest = this.items.keys().next().value;
            if (oldest === undefined) break;
            this.items.delete(oldest);
        }
    }

    delete(key) {
        if (key) this.items.delete(key);
    }

    clear() {
        this.items.clear();
    }
}

const inFlight = new Map();
const cache = Object.freeze({
    metadata: new MemoryTtlMap({ ttlMs: CACHE.metadata, max: 1000 }),
    search: new MemoryTtlMap({ ttlMs: CACHE.search, max: 800 }),
    resolved: new MemoryTtlMap({ ttlMs: CACHE.resolved, max: 800 }),
    stream: new MemoryTtlMap({ ttlMs: CACHE.stream, max: 600 }),
    tmdb: new MemoryTtlMap({ ttlMs: CACHE.tmdb, max: 1200 }),
    tmdbImdb: new MemoryTtlMap({ ttlMs: CACHE.tmdb, max: 1200 }),
    kitsu: new MemoryTtlMap({ ttlMs: CACHE.kitsu, max: 1600 }),
    quality: new MemoryTtlMap({ ttlMs: CACHE.quality, max: 800 }),
    negative: new MemoryTtlMap({ ttlMs: CACHE.negative, max: 2000 })
});

const sitemapState = {
    at: 0,
    urls: null
};

function ccSessionCookie() {
    return String(process.env.CINEMACITY_COOKIE || '').trim() || CC_BOOTSTRAP_SESSION;
}

function htmlRoot(html) {
    return cheerio.load(String(html || ''), { decodeEntities: false });
}

function safeText(value) {
    return he.decode(String(value || ''))
        .replace(/\u2013|\u2014/g, '-')
        .replace(/&ndash;|&mdash;/gi, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function listUnique(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values])
        .map((value) => safeText(value))
        .filter(Boolean))];
}

function simpleKey(value) {
    return safeText(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function tokenSet(value) {
    return new Set(
        safeText(value)
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\([^)]*\)/g, ' ')
            .split(/[^a-z0-9]+/g)
            .filter((token) => token.length >= 2)
    );
}

function imdbFrom(value) {
    const match = String(value || '').match(/\btt\d{5,}\b/i);
    return match ? match[0].toLowerCase() : null;
}

function tmdbFrom(value) {
    const raw = String(value || '').trim();
    const tagged = raw.match(/^tmdb:(\d+)/i);
    if (tagged) return tagged[1];
    return /^\d+$/.test(raw) ? raw : null;
}

function kitsuFrom(value) {
    const raw = String(value || '').trim();
    if (/^\d+$/.test(raw)) return raw;
    const match = raw.match(/^kitsu:(\d+)/i);
    return match ? match[1] : null;
}

function yearFrom(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function numericId(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function numberPlan(values = []) {
    const seen = new Set();
    const out = [];
    for (const value of Array.isArray(values) ? values : [values]) {
        const parsed = numericId(value);
        if (!parsed || seen.has(parsed)) continue;
        seen.add(parsed);
        out.push(parsed);
    }
    return out;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function keyedTask(key, fn) {
    if (!key) return fn();
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve().then(fn).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}

function ccUrl(pathOrUrl, base = CC_HOME) {
    if (!pathOrUrl) return null;
    try {
        return new URL(pathOrUrl, base).toString();
    } catch (_) {
        return null;
    }
}

function urlOrigin(url) {
    try {
        return new URL(url).origin;
    } catch (_) {
        return CC_HOME;
    }
}

function ccKind(url) {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname.startsWith('/movies/')) return 'movie';
        if (pathname.startsWith('/anime/')) return 'anime';
        if (pathname.startsWith('/tv-series/') || pathname.startsWith('/series/')) return 'tv';
        return null;
    } catch (_) {
        return null;
    }
}

function ccUrlMatchesKind(url, wantedKind) {
    const kind = ccKind(url);
    if (wantedKind === 'movie') return kind === 'movie';
    if (wantedKind === 'anime') return kind === 'anime' || kind === 'tv';
    return kind === 'tv' || kind === 'anime';
}

function slugTitle(url) {
    try {
        const tail = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
        return safeText(tail.replace(/\.html?$/i, '').replace(/^\d+-/, '').replace(/-/g, ' '));
    } catch (_) {
        return '';
    }
}

async function gotText(url, extraHeaders = {}, requestTimeout = GOT_REQUEST_TIMEOUT_MS) {
    const gotScraping = await getGotScraping();
    if (!gotScraping) return null;

    const fp = getRandomFingerprint();
    const cookie = getCookieHeaderForUrl(url, extraHeaders.Cookie || '');
    const headers = buildBrowserHeaders(fp, {
        ...extraHeaders,
        ...(cookie ? { Cookie: cookie } : {})
    });

    try {
        const response = await gotScraping({
            url,
            headers,
            useHeaderGenerator: true,
            headerGeneratorOptions: getGotScrapingHeaderOptions(fp, { minVersion: 120 }),
            retry: { limit: 0 },
            timeout: { request: requestTimeout },
            followRedirect: true,
            maxRedirects: 6,
            responseType: 'text',
            decompress: true
        });
        const status = Number(response?.statusCode || 0);
        const body = String(response?.body || '');
        updateCookiesFromResponse(url, response.headers);
        if (isCloudflareChallenge(body, status)) return null;
        return status >= 200 && status < 400 ? body : null;
    } catch (_) {
        return null;
    }
}

async function axiosText(url, extraHeaders = {}, requestTimeout = FETCH_TIMEOUT_MS) {
    const fp = getRandomFingerprint();
    const cookie = getCookieHeaderForUrl(url, extraHeaders.Cookie || '');
    const headers = buildBrowserHeaders(fp, {
        ...extraHeaders,
        ...(cookie ? { Cookie: cookie } : {})
    });

    try {
        const response = await httpClient.get(url, {
            headers,
            timeout: requestTimeout,
            responseType: 'text'
        });
        const status = Number(response?.status || 0);
        const body = responseText(response?.data);
        updateCookiesFromResponse(url, response.headers);
        if (isCloudflareChallenge(body, status)) return null;
        return status >= 200 && status < 400 ? body : null;
    } catch (_) {
        return null;
    }
}

async function ccText(url, extraHeaders = {}, options = {}) {
    const normalized = normalizeRemoteUrl(url) || url;
    const negativeKey = `net:${normalized}`;
    if (cache.negative.get(negativeKey)) return null;

    const timeout = Number.parseInt(String(options.timeout || FETCH_TIMEOUT_MS), 10) || FETCH_TIMEOUT_MS;
    const attempts = Math.max(1, Math.min(NETWORK_RETRIES, Number.parseInt(String(options.attempts || NETWORK_RETRIES), 10) || NETWORK_RETRIES));

    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await wait(Math.min(4000, 180 * Math.pow(2, attempt)) + Math.floor(Math.random() * 220));
        const body = await gotText(url, extraHeaders, timeout);
        if (body) return body;
    }

    if (options.axiosFallback !== false) {
        const body = await axiosText(url, extraHeaders, timeout);
        if (body) return body;
    }

    cache.negative.set(negativeKey, true);
    return null;
}

async function ccFormText(url, formBody, extraHeaders = {}) {
    const gotScraping = await getGotScraping();
    const fp = getRandomFingerprint();
    const cookie = getCookieHeaderForUrl(url, extraHeaders.Cookie || ccSessionCookie());
    const headers = buildBrowserHeaders(fp, {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: CC_HOME,
        Referer: `${CC_HOME}/`,
        ...extraHeaders,
        ...(cookie ? { Cookie: cookie } : {})
    });

    if (gotScraping) {
        try {
            const response = await gotScraping({
                url,
                method: 'POST',
                body: formBody,
                headers,
                useHeaderGenerator: true,
                headerGeneratorOptions: getGotScrapingHeaderOptions(fp, { minVersion: 120 }),
                retry: { limit: 0 },
                timeout: { request: GOT_REQUEST_TIMEOUT_MS },
                followRedirect: true,
                maxRedirects: 6,
                responseType: 'text',
                decompress: true
            });
            const status = Number(response?.statusCode || 0);
            const body = String(response?.body || '');
            updateCookiesFromResponse(url, response.headers);
            if (!isCloudflareChallenge(body, status) && status >= 200 && status < 400) return body;
        } catch (_) {}
    }

    try {
        const response = await httpClient.post(url, formBody, { headers, responseType: 'text' });
        const status = Number(response?.status || 0);
        const body = responseText(response?.data);
        updateCookiesFromResponse(url, response.headers);
        if (!isCloudflareChallenge(body, status) && status >= 200 && status < 400) return body;
    } catch (_) {}

    return null;
}

async function ccJson(url, options = {}) {
    const fp = getRandomFingerprint();
    const headers = {
        'User-Agent': fp.userAgent,
        Accept: 'application/json,*/*;q=0.8',
        'Accept-Language': fp.acceptLanguage,
        ...(options.headers || {})
    };
    const response = await httpClient.get(url, { ...options, headers });
    const status = Number(response?.status || 0);
    if (status >= 200 && status < 400) return response.data;
    throw new Error(`HTTP ${status || 500}`);
}

function selectorEscape(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function labelKey(value) {
    return safeText(value).replace(/:$/g, '').toLowerCase();
}

function fieldValues(html, label) {
    const $ = htmlRoot(html);
    const wanted = labelKey(label);
    const out = [];
    $('li').each((_, li) => {
        const spans = $(li).children('span');
        if (spans.length < 2) return;
        if (labelKey($(spans[0]).text()) !== wanted) return;
        const valueNode = $(spans[1]);
        const linked = [];
        valueNode.find('a').each((__, a) => {
            const value = safeText($(a).text()).replace(/^[,;:|\-]+|[,;:|\-]+$/g, '');
            if (value) linked.push(value);
        });
        const raw = safeText(valueNode.text()).replace(/^[,;:|\-]+|[,;:|\-]+$/g, '');
        const pieces = linked.length ? linked : raw.split(/[,;|]/g);
        for (const piece of pieces) {
            const clean = safeText(piece).replace(/^[,;:|\-]+|[,;:|\-]+$/g, '');
            if (clean) out.push(clean);
        }
    });
    return listUnique(out);
}

function metaContent(html, name) {
    const $ = htmlRoot(html);
    const key = selectorEscape(name);
    return safeText(
        $(`meta[property="${key}"]`).first().attr('content')
        || $(`meta[name="${key}"]`).first().attr('content')
        || ''
    );
}

function pageHeading(html) {
    const $ = htmlRoot(html);
    return safeText($('h1').first().text());
}

function strongestResolution(values = []) {
    let best = 'Unknown';
    for (const value of values) {
        best = pickBetterQuality(best, normalizeQuality(value));
    }
    return normalizeQuality(best);
}

const LANGUAGE_ALIASES = Object.freeze({
    italian: ['italian', 'ita', 'it', 'italiano'],
    english: ['english', 'eng', 'en', 'inglese'],
    japanese: ['japanese', 'jpn', 'ja', 'giapponese'],
    multi: ['multi', 'multiaudio', 'multi audio', 'dual audio', 'dual-audio']
});

function langToken(value) {
    const raw = safeText(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';

    const words = raw.split(' ').filter(Boolean);
    const compact = raw.replace(/\s+/g, '');
    for (const [name, aliases] of Object.entries(LANGUAGE_ALIASES)) {
        for (const alias of aliases) {
            const cleanAlias = String(alias || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (!cleanAlias) continue;
            const aliasCompact = cleanAlias.replace(/\s+/g, '');
            if (raw === cleanAlias || compact === aliasCompact) return name;
            if (cleanAlias.length <= 3 && words.includes(cleanAlias)) return name;
            if (cleanAlias.length > 3 && (words.includes(cleanAlias) || compact.includes(aliasCompact))) return name;
        }
    }
    return raw;
}

function langList(values = []) {
    return listUnique((Array.isArray(values) ? values : [values])
        .flatMap((value) => String(value || '').split(/[,;/|]+/g))
        .map(langToken)
        .filter(Boolean));
}

function downloadLanguages(html) {
    const $ = htmlRoot(html);
    const found = [];
    $('.dar-tr_item').each((_, item) => {
        const title = safeText($(item).find('.dar-tr_title').text());
        const langLine = safeText($(item).find('li').filter((__, li) => {
            return /language/i.test($(li).find('span').first().text() || '');
        }).text());
        const text = `${title} ${langLine}`;
        if (/\bItalian\b|\.Italian\.|\bITA\b/i.test(text)) found.push('italian');
        if (/\bEnglish\b|\.English\.|\bENG\b/i.test(text)) found.push('english');
        if (/\bMulti\b|Dual[-\s]?Audio|Multiaudio/i.test(text)) found.push('multi');
    });
    return langList(found);
}

function parsePageFacts(html, pageUrl = '') {
    const body = String(html || '');
    const $ = htmlRoot(body);
    const title = pageHeading(body)
        || metaContent(body, 'og:title')
        || metaContent(body, 'twitter:title')
        || slugTitle(pageUrl);
    const genres = fieldValues(body, 'Genre');
    const audioLanguages = fieldValues(body, 'Audio language');
    const fileLanguages = downloadLanguages(body);
    const subtitleLanguages = fieldValues(body, 'Subtitle language');
    const resolutions = fieldValues(body, 'Resolution')
        .map((value) => normalizeQuality(value))
        .filter((value) => value !== 'Unknown');
    const uploadedLine = body.match(/Uploaded\s+([^<\n]+)/i)?.[1] || '';
    const qualityNames = listUnique([...fieldValues(body, 'Quality'), uploadedLine]);

    let tmdbId = null;
    $('a[href*="themoviedb.org"], link[href*="themoviedb.org"]').each((_, node) => {
        if (tmdbId) return;
        const href = String($(node).attr('href') || '');
        const match = href.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
        if (match?.[1]) tmdbId = tmdbFrom(match[1]);
    });
    if (!tmdbId) {
        const match = body.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
        if (match?.[1]) tmdbId = tmdbFrom(match[1]);
    }

    const quality = strongestResolution(resolutions);
    const qualityTag = qualityNames.find((value) => /web[- ]?dl|webrip|bluray|hdrip|cam[- ]?rip|\bts\b/i.test(String(value || ''))) || '';
    const multiAudio = audioLanguages.length > 1
        || fileLanguages.includes('multi')
        || /multi|dual[-\s]?audio|multiaudio/i.test(qualityNames.join(' '));
    const anime = genres.some((value) => /\banime\b|\banimation\b/i.test(String(value))) || ccKind(pageUrl) === 'anime';

    return {
        title,
        year: yearFrom(title) || yearFrom(body),
        imdbId: imdbFrom(body),
        tmdbId,
        genres,
        audioLanguages,
        downloadLanguages: fileLanguages,
        subtitleLanguages,
        listedResolutions: resolutions,
        quality,
        qualityTag,
        isMultiAudio: multiAudio,
        isAnime: anime
    };
}

async function pageFacts(pageUrl) {
    const normalized = normalizeRemoteUrl(pageUrl);
    if (!normalized) return null;
    const hit = cache.metadata.get(normalized);
    if (hit) return hit;
    return keyedTask(`facts:${normalized}`, async () => {
        const again = cache.metadata.get(normalized);
        if (again) return again;
        const html = await ccText(normalized, {
            Referer: `${CC_HOME}/`,
            Cookie: ccSessionCookie(),
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1'
        });
        if (!html) return null;
        const facts = parsePageFacts(html, normalized);
        cache.metadata.set(normalized, facts);
        return facts;
    });
}

function wantedLang(config = {}) {
    const raw = String(config?.filters?.language || config?.language || config?.preferredLanguage || '').trim().toLowerCase();
    if (['ita', 'it', 'italian', 'italiano'].includes(raw)) return 'italian';
    if (['eng', 'en', 'english', 'inglese'].includes(raw)) return 'english';
    if (['jpn', 'ja', 'japanese', 'giapponese'].includes(raw)) return 'japanese';
    return raw || null;
}

function strictLangMode(config = {}) {
    const wanted = wantedLang(config);
    if (!wanted) return false;
    const raw = String(config?.filters?.language || config?.language || '').trim().toLowerCase();
    return ['ita', 'it', 'italian', 'italiano'].includes(raw)
        || config?.filters?.strictLanguage === true
        || config?.strictLanguage === true;
}

function pageAudioOk(facts = {}, config = {}) {
    const wanted = wantedLang(config);
    if (!wanted || !strictLangMode(config)) return true;

    const pageAudio = langList(facts.audioLanguages || []);
    const fileAudio = langList(facts.downloadLanguages || []);
    const qualityLang = langToken(facts.qualityTag || '');
    const pageWanted = pageAudio.includes(wanted);
    const fileWanted = fileAudio.includes(wanted);
    const pageMulti = pageAudio.includes('multi') || qualityLang === 'multi' || facts.isMultiAudio === true || /multi|dual[-\s]?audio|multiaudio/i.test(String(facts.qualityTag || ''));
    const fileMulti = fileAudio.includes('multi');
    const fileOnlyEnglish = fileAudio.length > 0 && fileAudio.every((lang) => lang === 'english');

    if (wanted === 'italian') {
        if (pageWanted || fileWanted) return true;
        if ((pageMulti || fileMulti) && config?.filters?.allowMultiWhenItalianOnly === true) return true;
        if (pageAudio.length > 0 || fileOnlyEnglish) return false;
        return false;
    }

    if (pageWanted || fileWanted) return true;
    if (pageMulti || fileMulti) return true;
    return pageAudio.length === 0 && fileAudio.length === 0;
}

function languageRejectLog(facts = {}, config = {}) {
    return `[CC V2] language rejected | wanted=${wantedLang(config) || 'unknown'} | page=${langList(facts.audioLanguages || []).join(',') || 'unknown'} | download=${langList(facts.downloadLanguages || []).join(',') || 'unknown'} | title=${facts.title || 'unknown'}`;
}

function streamLanguageRejected(streamUrl = '', config = {}) {
    const wanted = wantedLang(config);
    if (!wanted || !strictLangMode(config)) return false;

    const text = decodeURIComponent(String(streamUrl || '')).replace(/[._-]+/g, ' ');
    const hasIta = /(?:^|[^a-z0-9])(ita|it|italian|italiano)(?:[^a-z0-9]|$)/i.test(text);
    const hasEng = /(?:^|[^a-z0-9])(eng|en|english|inglese)(?:[^a-z0-9]|$)/i.test(text);
    const hasMulti = /(?:^|[^a-z0-9])(multi|multiaudio|dual audio|dual)(?:[^a-z0-9]|$)/i.test(text);

    if (wanted === 'italian') return hasEng && !hasIta && !hasMulti;
    return hasEng && !langToken(text).includes(wanted);
}

function languageBadge(facts = {}, config = {}) {
    const pageAudio = langList(facts?.audioLanguages || []);
    const fileAudio = langList(facts?.downloadLanguages || []);
    const wantsIta = wantedLang(config) === 'italian';
    const hasIta = pageAudio.includes('italian') || fileAudio.includes('italian');
    const hasEng = pageAudio.includes('english') || fileAudio.includes('english');
    const hasMulti = pageAudio.includes('multi') || fileAudio.includes('multi') || facts?.isMultiAudio === true;

    if (hasIta && hasMulti) return '🇮🇹 ITA+MULTI';
    if (hasIta) return '🇮🇹 ITA';
    if (wantsIta && hasMulti && config?.filters?.allowMultiWhenItalianOnly === true) return '🌍 MULTI';
    if (hasEng && pageAudio.length <= 1 && fileAudio.length <= 1) return '🇬🇧 ENG';
    if (hasMulti || pageAudio.length > 1 || fileAudio.length > 1) return '🌍 MULTI';
    return '🌐 WEB';
}

function filterByLanguage(streams = [], config = {}) {
    const wanted = wantedLang(config);
    if (!wanted || !strictLangMode(config)) return streams;

    return streams.filter((stream) => {
        const text = [
            stream.name,
            stream.title,
            stream.description,
            stream.behaviorHints?.filename,
            stream.filename,
            stream.url
        ].filter(Boolean).join(' ');

        if (wanted === 'italian') {
            if (/(?:^|[^a-z0-9])(ita|it|italian|italiano)(?:[^a-z0-9]|$)/i.test(text)) return true;
            if (/(?:^|[^a-z0-9])(multi|multiaudio|dual[-\s]?audio)(?:[^a-z0-9]|$)/i.test(text)
                && config?.filters?.allowMultiWhenItalianOnly === true) return true;
            if (/(?:^|[^a-z0-9])(eng|en|english|inglese)(?:[^a-z0-9]|$)/i.test(text)) return false;
            return false;
        }

        return langToken(text).includes(wanted);
    });
}

function metaTitles(meta = {}) {
    return listUnique([
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.originalName,
        meta?.canonicalTitle,
        meta?.seriesTitle,
        ...(Array.isArray(meta?.titles) ? meta.titles : []),
        ...(Array.isArray(meta?.aliases) ? meta.aliases : []),
        ...(Array.isArray(meta?.aka_titles) ? meta.aka_titles : [])
    ]);
}

function animeLike(meta = {}) {
    const type = String(meta?.type || meta?.kind || meta?.mediaType || '').toLowerCase();
    if (/(^|[^a-z])(anime|animation)([^a-z]|$)/i.test(type)) return true;
    if ((Array.isArray(meta?.genres) ? meta.genres : []).some((value) => /(anime|animation|animazione)/i.test(String(value)))) return true;
    const haystack = listUnique([
        meta?.id,
        meta?.requestedId,
        meta?.originalId,
        meta?.kitsu_id,
        meta?.kitsuId,
        ...metaTitles(meta)
    ]).join(' | ').toLowerCase();
    return /(anime-kitsu|kitsu:|\banime\b|\banimazione\b)/i.test(haystack);
}

function plainSeriesTitle(value) {
    return safeText(value)
        .replace(/\b(?:season|stagione|episode|episodio|episodi|ep\.?)\s*\d+\b/gi, ' ')
        .replace(/\bS\s*\d+\s*E\s*\d+\b/gi, ' ')
        .replace(/\bS\s*\d+\b/gi, ' ')
        .replace(/\bE\s*\d+\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titlePlanFromOne(title) {
    const clean = plainSeriesTitle(title);
    if (!clean) return [];
    const out = [clean];
    const splitters = [
        /\s+[\\/|]\s+/g,
        /\s+(?:aka|a\.k\.a\.|also known as|conosciuto come)\s+/ig,
        /\s*[:：]\s+/g
    ];
    for (const splitter of splitters) {
        const parts = clean.split(splitter).map((value) => value.trim()).filter(Boolean);
        if (parts.length > 1) out.push(...parts);
    }
    const ascii = clean.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (ascii !== clean) out.push(ascii);
    if (/\bone\s*piece\b/i.test(clean) || /\bwan\s*p[îi]?su\b/i.test(clean) || /\bwan\s*pi+su\b/i.test(ascii)) {
        out.push('One Piece', 'Wan Pisu', 'Wan piisu');
    }
    return listUnique(out).filter((value) => value.length >= 2);
}

function queryPlan(titles = []) {
    const seen = new Set();
    const out = [];
    for (const title of listUnique(titles)) {
        for (const alias of titlePlanFromOne(title)) {
            const normalized = kitsuProvider.normalizeTitle(alias);
            const noYear = alias.replace(/\s*\((?:19|20)\d{2}.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
            for (const value of listUnique([alias, normalized, noYear])) {
                const clean = safeText(value);
                const key = simpleKey(clean);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(clean);
            }
        }
    }
    return out;
}

function expectedTitles(tmdbData = {}, meta = {}) {
    return listUnique([
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.original_title,
        meta?.originalName,
        meta?.original_name,
        tmdbData?.title,
        tmdbData?.name,
        tmdbData?.original_title,
        tmdbData?.original_name
    ]);
}

function expectedYear(tmdbData = {}, meta = {}) {
    return yearFrom(tmdbData?.release_date)
        || yearFrom(tmdbData?.first_air_date)
        || yearFrom(meta?.year)
        || yearFrom(meta?.releaseInfo)
        || null;
}

function sitemapLocs(xml) {
    return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/gi)]
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);
}

async function sitemapUrls() {
    if (Array.isArray(sitemapState.urls) && (Date.now() - sitemapState.at) < CACHE.sitemap) return sitemapState.urls;
    return keyedTask('cc:sitemap', async () => {
        if (Array.isArray(sitemapState.urls) && (Date.now() - sitemapState.at) < CACHE.sitemap) return sitemapState.urls;
        const xml = await ccText(CC_SITEMAP, {
            Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
            Referer: `${CC_HOME}/`
        }, { timeout: 1800, attempts: 1 });
        const urls = sitemapLocs(xml).filter((url) => /^https:\/\/cinemacity\.cc\//i.test(url));
        if (urls.length) {
            sitemapState.urls = urls;
            sitemapState.at = Date.now();
            return urls;
        }
        return sitemapState.urls || [];
    });
}

async function kitsuBridgeIds(kitsuId, season, episode, config = {}) {
    if (!kitsuId) return null;
    const ep = numericId(episode) || 1;
    const s = numericId(season) || null;
    const lang = String(config?.filters?.language || '').trim().toLowerCase() === 'ita' ? 'it' : '';
    const key = `kitsu:${kitsuId}:${s || ''}:${ep}:${lang}`;
    const cached = cache.kitsu.get(key);
    if (cached !== null) return cached;

    return keyedTask(key, async () => {
        const again = cache.kitsu.get(key);
        if (again !== null) return again;
        try {
            const params = new URLSearchParams();
            params.set('ep', String(ep));
            if (s) params.set('s', String(s));
            if (lang) params.set('lang', lang);
            const payload = await ccJson(`${CC_MAPPING_BASE}/kitsu/${encodeURIComponent(String(kitsuId).trim())}?${params.toString()}`);
            const ids = payload?.mappings?.ids || {};
            const tmdbEpisode = payload?.mappings?.tmdb_episode || payload?.mappings?.tmdbEpisode || payload?.tmdb_episode || payload?.tmdbEpisode || null;
            const mappedSeason = Number.parseInt(String(tmdbEpisode?.season || tmdbEpisode?.seasonNumber || tmdbEpisode?.season_number || ''), 10);
            const mappedEpisode = Number.parseInt(String(tmdbEpisode?.episode || tmdbEpisode?.episodeNumber || tmdbEpisode?.episode_number || ''), 10);
            const rawEpisode = Number.parseInt(String(tmdbEpisode?.rawEpisodeNumber || tmdbEpisode?.raw_episode_number || tmdbEpisode?.rawEpisode || ''), 10);
            const result = {
                imdbId: imdbFrom(ids.imdb),
                tmdbId: tmdbFrom(ids.tmdb),
                mappedSeason: Number.isInteger(mappedSeason) && mappedSeason > 0 ? mappedSeason : null,
                mappedEpisode: Number.isInteger(mappedEpisode) && mappedEpisode > 0 ? mappedEpisode : null,
                rawEpisodeNumber: Number.isInteger(rawEpisode) && rawEpisode > 0 ? rawEpisode : null
            };
            cache.kitsu.set(key, result);
            return result;
        } catch (error) {
            console.error('[CC V2] Kitsu bridge error:', error.message);
            cache.kitsu.set(key, null);
            return null;
        }
    });
}

async function tmdbMetadata(id, kind) {
    const cleanId = String(id || '').trim();
    const tmdbKind = kind === 'movie' ? 'movie' : 'tv';
    if (!cleanId) return null;
    const key = `tmdb:${tmdbKind}:${cleanId}`;
    const cached = cache.tmdb.get(key);
    if (cached !== null) return cached;

    return keyedTask(key, async () => {
        const again = cache.tmdb.get(key);
        if (again !== null) return again;
        try {
            let result = null;
            if (imdbFrom(cleanId)) {
                const payload = await tmdbHelper.fetchTmdbJson(`/find/${encodeURIComponent(cleanId)}`, {
                    params: { external_source: 'imdb_id', language: 'en-US' }
                });
                const results = tmdbKind === 'movie' ? payload?.movie_results : payload?.tv_results;
                result = Array.isArray(results) && results.length > 0 ? results[0] : null;
            } else {
                const idOnly = tmdbFrom(cleanId);
                if (idOnly) {
                    result = await tmdbHelper.fetchTmdbJson(`/${tmdbKind}/${idOnly}`, { params: { language: 'en-US' } });
                }
            }
            cache.tmdb.set(key, result);
            return result;
        } catch (error) {
            console.error('[CC V2] TMDB metadata error:', error.message);
            cache.tmdb.set(key, null);
            return null;
        }
    });
}

async function imdbFromTmdb(tmdbId, kind) {
    const idOnly = tmdbFrom(tmdbId);
    if (!idOnly) return null;
    const tmdbKind = kind === 'movie' ? 'movie' : 'tv';
    const key = `tmdb-imdb:${tmdbKind}:${idOnly}`;
    const cached = cache.tmdbImdb.get(key);
    if (cached !== null) return cached;

    return keyedTask(key, async () => {
        const again = cache.tmdbImdb.get(key);
        if (again !== null) return again;
        try {
            const value = imdbFrom(await tmdbHelper.getImdbFromTmdb(idOnly, tmdbKind));
            cache.tmdbImdb.set(key, value);
            return value;
        } catch (error) {
            console.error('[CC V2] TMDB IMDb error:', error.message);
            cache.tmdbImdb.set(key, null);
            return null;
        }
    });
}

function cardLinksFromListing(html, wantedKind) {
    const $ = htmlRoot(html);
    const results = [];
    $('a[href]').each((_, anchor) => {
        const href = String($(anchor).attr('href') || '').trim();
        const url = ccUrl(href, CC_HOME);
        if (!url || !/\.html(?:$|[?#])/i.test(url)) return;
        if (!/^https?:\/\/cinemacity\.cc\//i.test(url)) return;
        if (!ccUrlMatchesKind(url, wantedKind)) return;
        const title = safeText($(anchor).attr('title') || $(anchor).text() || slugTitle(url));
        if (!title) return;
        results.push({ url, title });
    });
    return Array.from(new Map(results.map((item) => [item.url, item])).values());
}

function cardsFromSearchPage(html) {
    const body = String(html || '');
    if (/site search yielded no results|ricerca non ha prodotto risultati/i.test(body)) return [];
    const $ = htmlRoot(body);
    const scope = $('#dle-content').length ? $('#dle-content') : $('body');
    const results = [];
    scope.find('a[href]').each((_, anchor) => {
        const url = ccUrl(String($(anchor).attr('href') || '').trim(), CC_HOME);
        if (!url) return;
        if (!/^https?:\/\/cinemacity\.cc\/(?:movies|anime|series|tv-series)\/\d+-[^?#]+\.html(?:$|[?#])/i.test(url)) return;
        const title = safeText($(anchor).attr('title') || $(anchor).text() || slugTitle(url));
        if (!title) return;
        results.push({ url, title });
    });
    return Array.from(new Map(results.map((item) => [item.url, item])).values());
}

function titleScore(candidateTitle, titles = []) {
    const candidateKey = simpleKey(candidateTitle);
    if (!candidateKey) return 0;
    let best = 0;
    const candidateTokens = tokenSet(candidateTitle);
    for (const title of titles) {
        const expectedKey = simpleKey(title);
        if (!expectedKey) continue;
        if (candidateKey === expectedKey) return 48;
        if (candidateKey.includes(expectedKey) || expectedKey.includes(candidateKey)) best = Math.max(best, 38);
        const expectedTokens = tokenSet(title);
        if (candidateTokens.size && expectedTokens.size) {
            let overlap = 0;
            for (const token of expectedTokens) if (candidateTokens.has(token)) overlap++;
            const ratio = overlap / Math.max(1, expectedTokens.size);
            if (ratio >= 0.9) best = Math.max(best, 36);
            else if (ratio >= 0.75) best = Math.max(best, 30);
            else if (ratio >= 0.55) best = Math.max(best, 22);
        }
    }
    return best;
}

function kindScore(url, wantedKind) {
    const kind = ccKind(url);
    if (wantedKind === 'movie') return kind === 'movie' ? 12 : -50;
    if (wantedKind === 'anime') {
        if (kind === 'anime') return 18;
        if (kind === 'tv') return 8;
        return -50;
    }
    if (kind === 'tv') return 12;
    if (kind === 'anime') return 4;
    return -50;
}

function rankCard(card, titles, targetYear, wantedKind) {
    if (!card?.url) return 0;
    const displayName = card.title || slugTitle(card.url);
    let score = titleScore(displayName, titles);
    if (score <= 0) return 0;
    score += kindScore(card.url, wantedKind);
    const cardYear = yearFrom(displayName) || yearFrom(card.url);
    if (targetYear && cardYear) {
        if (targetYear === cardYear) score += 10;
        else if (Math.abs(targetYear - cardYear) === 1) score += 4;
        else score -= 22;
    }
    return score;
}

async function cardImdb(cardUrl) {
    try {
        const facts = await pageFacts(cardUrl);
        return facts?.imdbId || null;
    } catch (_) {
        return null;
    }
}

async function chooseCard(candidates, titles, { requestedImdbId = null, targetYear = null, wantedKind = 'tv', quick = false } = {}) {
    const ranked = (candidates || [])
        .map((candidate) => ({ ...candidate, score: rankCard(candidate, titles, targetYear, wantedKind) }))
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score);

    if (!ranked.length) return null;

    const expectedImdb = imdbFrom(requestedImdbId);
    if (expectedImdb) {
        const inspection = ranked.slice(0, quick ? 4 : 8).filter((candidate) => candidate.score >= 48);
        const checked = await Promise.all(inspection.map((candidate) => cardImdb(candidate.url)));
        const firstVerified = inspection.find((_, index) => checked[index] === expectedImdb);
        if (firstVerified) return { ...firstVerified, verified: true, score: firstVerified.score + 42 };
        const wrong = new Set();
        inspection.forEach((candidate, index) => {
            if (checked[index] && checked[index] !== expectedImdb) wrong.add(candidate.url);
        });
        const safe = ranked.find((candidate) => candidate.score >= 58 && !wrong.has(candidate.url));
        return safe || null;
    }

    if (wantedKind === 'anime') {
        const enriched = [];
        for (const card of ranked.slice(0, quick ? 4 : 8)) {
            const facts = await pageFacts(card.url);
            let score = card.score;
            if (facts?.isAnime) score += 18;
            if (facts?.title) score += Math.min(12, Math.floor(titleScore(facts.title, titles) / 4));
            if (targetYear && facts?.year) score += facts.year === targetYear ? 8 : (Math.abs(facts.year - targetYear) === 1 ? 3 : -10);
            enriched.push({ ...card, pageMetadata: facts, score });
        }
        const best = [...enriched, ...ranked.slice(quick ? 4 : 8)].sort((a, b) => b.score - a.score)[0];
        return best?.score >= 58 ? best : null;
    }

    return ranked[0]?.score >= 58 ? ranked[0] : null;
}

async function searchCards(query) {
    const clean = safeText(query);
    if (!clean) return [];
    const key = `q:${clean.toLowerCase()}`;
    const cached = cache.search.get(key);
    if (cached) return cached;

    return keyedTask(key, async () => {
        const again = cache.search.get(key);
        if (again) return again;
        const commonHeaders = {
            Referer: `${CC_HOME}/`,
            Cookie: ccSessionCookie(),
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'navigate'
        };
        const parse = (html) => {
            const cards = cardsFromSearchPage(html);
            if (cards.length) {
                cache.search.set(key, cards);
                return cards;
            }
            return null;
        };

        let reachedSite = false;
        const getUrl = `${CC_HOME}/index.php?do=search&subaction=search&story=${encodeURIComponent(clean)}`;
        const getHtml = await ccText(getUrl, commonHeaders);
        if (getHtml) {
            reachedSite = true;
            const parsed = parse(getHtml);
            if (parsed) return parsed;
        }

        const body = new URLSearchParams({ do: 'search', subaction: 'search', story: clean }).toString();
        const postHtml = await ccFormText(`${CC_HOME}/index.php`, body, commonHeaders);
        if (postHtml) {
            reachedSite = true;
            const parsed = parse(postHtml);
            if (parsed) return parsed;
        }

        if (reachedSite) cache.search.set(key, []);
        return [];
    });
}

async function searchByTitles(titles, wantedKind, expected, requestedImdbId, targetYear) {
    const plan = queryPlan(titles).slice(0, wantedKind === 'anime' ? 10 : 6);
    if (!plan.length) return null;
    const collected = [];
    const seen = new Set();

    for (let i = 0; i < plan.length; i += 3) {
        const batch = plan.slice(i, i + 3);
        const results = await Promise.all(batch.map((query) => searchCards(query)));
        for (const cards of results) {
            for (const card of cards) {
                if (!card?.url || seen.has(card.url)) continue;
                seen.add(card.url);
                collected.push(card);
            }
        }
        const current = await chooseCard(collected, expected, { requestedImdbId, targetYear, wantedKind, quick: true });
        if (current?.score >= 90 || current?.verified) return current;
    }

    return chooseCard(collected, expected, { requestedImdbId, targetYear, wantedKind, quick: true });
}

async function searchSitemap(wantedKind, titles, { requestedImdbId = null, targetYear = null, quick = true } = {}) {
    try {
        const urls = await sitemapUrls();
        const cards = urls
            .filter((url) => ccUrlMatchesKind(url, wantedKind))
            .map((url) => ({ url, title: slugTitle(url) }))
            .filter((card) => titleScore(card.title, titles) > 0);
        return chooseCard(cards, titles, { requestedImdbId, targetYear, wantedKind, quick });
    } catch (_) {
        return null;
    }
}

async function searchImdb(imdbId) {
    const id = imdbFrom(imdbId);
    if (!id) return null;
    const byFullId = (await searchCards(id))[0] || null;
    if (byFullId) return byFullId;
    const numeric = id.replace(/\D/g, '');
    return numeric ? ((await searchCards(numeric))[0] || null) : null;
}

function listingRoots(wantedKind) {
    if (wantedKind === 'movie') return [`${CC_HOME}/movies/`];
    if (wantedKind === 'anime') return [`${CC_HOME}/anime/`, `${CC_HOME}/tv-series/`];
    return [`${CC_HOME}/tv-series/`, `${CC_HOME}/anime/`];
}

async function resolveCatalog(id, wantedKind, meta = {}, options = {}) {
    const tmdbKind = wantedKind === 'movie' ? 'movie' : 'tv';
    const tmdbData = options?.tmdbData || await tmdbMetadata(id, tmdbKind);
    const titles = listUnique([
        ...(Array.isArray(options?.expectedTitles) ? options.expectedTitles : []),
        ...expectedTitles(tmdbData, meta)
    ]);
    if (!titles.length) return null;

    const requestedImdbId = imdbFrom(options?.requestedImdbId || id);
    const targetYear = options?.expectedYear || expectedYear(tmdbData, meta);
    const quick = options?.fast !== false;
    const key = `resolve:${wantedKind}:${requestedImdbId || ''}:${tmdbFrom(id) || ''}:${targetYear || ''}:${quick ? 'quick' : 'deep'}:${queryPlan(titles).slice(0, 10).map(simpleKey).join('|')}`;
    const cached = cache.resolved.get(key);
    if (cached !== null) return cached;

    const save = (value) => {
        cache.resolved.set(key, value || null);
        return value || null;
    };

    const fromSitemap = await searchSitemap(wantedKind, titles, { requestedImdbId, targetYear, quick });
    if (fromSitemap?.url) return save(fromSitemap);

    const fromSearch = await searchByTitles(titles, wantedKind, titles, requestedImdbId, targetYear);
    if (fromSearch?.url) return save(fromSearch);

    if (quick) return save(null);

    let best = null;
    for (const root of listingRoots(wantedKind)) {
        const pages = Array.from({ length: CATALOG_PAGE_LIMIT }, (_, index) => index + 1);
        for (let i = 0; i < pages.length; i += 3) {
            const batch = pages.slice(i, i + 3);
            const groups = await Promise.all(batch.map(async (page) => {
                const url = page === 1 ? root : `${root}page/${page}/`;
                const html = await ccText(url, {
                    Referer: `${CC_HOME}/`,
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-Mode': 'navigate'
                }, { timeout: 2000 });
                const cards = cardLinksFromListing(html, wantedKind);
                return cards.slice(0, CATALOG_SCAN_LIMIT);
            }));
            const cards = groups.flat().filter(Boolean);
            if (!cards.length) break;
            const candidate = await chooseCard(cards, titles, { requestedImdbId, targetYear, wantedKind, quick: false });
            if (candidate && (!best || candidate.score > best.score)) best = candidate;
            if (best?.score >= 90 || best?.verified) return save(best);
        }
    }

    return save(best?.score >= 58 ? best : null);
}

function idCandidates(meta = {}, originalId, finalId) {
    return [
        originalId,
        finalId,
        meta?.requestedId,
        meta?.originalId,
        meta?.id,
        meta?.imdb_id,
        meta?.imdbId,
        meta?.tmdb_id,
        meta?.tmdbId,
        meta?.kitsu_id ? `kitsu:${meta.kitsu_id}` : null,
        meta?.kitsuId ? `kitsu:${meta.kitsuId}` : null,
        meta?.kitsu ? (/^\d+$/.test(String(meta.kitsu).trim()) ? `kitsu:${meta.kitsu}` : meta.kitsu) : null
    ].filter(Boolean);
}

function kitsuCandidates(meta = {}, originalId, finalId) {
    const raw = [
        originalId,
        finalId,
        meta?.requestedId,
        meta?.originalId,
        meta?.id,
        meta?.sourceId,
        meta?.source_id,
        meta?.stremioId,
        meta?.stremio_id,
        meta?.canonicalId,
        meta?.canonical_id,
        meta?.kitsu_id,
        meta?.kitsuId,
        meta?.kitsu
    ].filter((value) => /kitsu/i.test(String(value || '')));
    const dedicated = [meta?.kitsu_id, meta?.kitsuId, meta?.kitsu]
        .map((value) => {
            const text = String(value || '').trim();
            if (!text) return null;
            return /^\d+$/.test(text) ? `kitsu:${text}` : text;
        })
        .filter(Boolean);
    return [...raw, ...dedicated].filter(Boolean);
}

function canBridgeAnime(meta = {}) {
    if (!meta || meta?.isSeries === false || String(meta?.type || '').toLowerCase() === 'movie') return false;
    if (meta?.kitsu_id || meta?.kitsuId || meta?.kitsu) return true;
    if (meta?.tmdbAnimeCandidate === true) return true;
    return meta?.isAnime === true && Boolean(meta?.tmdb_id || meta?.tmdbId || meta?.imdb_id || meta?.imdbId);
}

async function animeSearchProfile(meta = {}, originalId, finalId, config = {}, season = null, episode = null) {
    let kitsuToken = null;
    for (const candidate of kitsuCandidates(meta, originalId, finalId)) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) {
            kitsuToken = /^\d+$/.test(String(candidate || '').trim()) ? `kitsu:${candidate}` : String(candidate);
            break;
        }
    }

    if (kitsuToken) {
        try {
            const context = await kitsuProvider.buildSearchContext(kitsuToken, meta);
            if (context?.kitsuId) {
                return {
                    ...context,
                    searchTitles: queryPlan([
                        ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
                        ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                        ...metaTitles(meta)
                    ]),
                    rawTitles: listUnique([
                        ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                        ...metaTitles(meta)
                    ]),
                    strictKitsu: true
                };
            }
        } catch (_) {}
    }

    if (!canBridgeAnime(meta)) return null;

    try {
        const safeSeason = numericId(season || meta?.season) || 1;
        const safeEpisode = numericId(episode || meta?.episode) || 1;
        const context = await animeIdentity.buildAnimeSearchContextForProvider({
            requestId: originalId || finalId || meta?.id || (meta?.imdb_id ? `${meta.imdb_id}:${safeSeason}:${safeEpisode}` : meta?.tmdb_id ? `tmdb:${meta.tmdb_id}:${safeSeason}:${safeEpisode}` : null),
            finalId: finalId || originalId || meta?.id || null,
            meta: {
                ...meta,
                type: 'series',
                isSeries: true,
                season: safeSeason,
                episode: safeEpisode
            },
            config,
            season: safeSeason,
            episode: safeEpisode,
            providerName: 'CinemaCityAnimeBridge',
            language: 'it-IT',
            mappingTimeoutMs: FETCH_TIMEOUT_MS,
            kitsuTimeoutMs: 1400,
            debug: false
        });

        if (!context?.kitsuId) return null;
        return {
            ...context,
            searchTitles: queryPlan([
                ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
                ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                ...metaTitles(meta)
            ]),
            rawTitles: listUnique([
                ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                ...metaTitles(meta)
            ]),
            strictKitsu: false,
            mappedKitsu: true
        };
    } catch (_) {}

    return null;
}

function parseMediaId(rawId, season, episode) {
    const result = {
        id: String(rawId || '').trim(),
        season: Number.isInteger(season) ? season : (Number.parseInt(season, 10) || 1),
        episode: Number.isInteger(episode) ? episode : (Number.parseInt(episode, 10) || 1)
    };

    const kitsuTriplet = result.id.match(/^kitsu:(\d+):(\d+):(\d+)$/i);
    if (kitsuTriplet) {
        result.id = `kitsu:${kitsuTriplet[1]}`;
        result.season = Number.parseInt(kitsuTriplet[2], 10) || result.season;
        result.episode = Number.parseInt(kitsuTriplet[3], 10) || result.episode;
        return result;
    }

    const kitsuEpisode = result.id.match(/^kitsu:(\d+):(\d+)$/i);
    if (kitsuEpisode) {
        result.id = `kitsu:${kitsuEpisode[1]}`;
        result.season = 1;
        result.episode = Number.parseInt(kitsuEpisode[2], 10) || result.episode;
        return result;
    }

    const regular = result.id.match(/^(tt\d+|\d+|tmdb:\d+):(\d+):(\d+)$/i);
    if (regular) {
        result.id = regular[1];
        result.season = Number.parseInt(regular[2], 10) || result.season;
        result.episode = Number.parseInt(regular[3], 10) || result.episode;
    }
    return result;
}

async function requestProfile(meta = {}, originalId, finalId, config = {}) {
    const isSeries = Boolean(meta?.isSeries);
    const fallbackSeason = numericId(meta?.season) || 1;
    const fallbackEpisode = numericId(meta?.episode) || 1;
    const ids = idCandidates(meta, originalId, finalId);
    const parsed = parseMediaId(ids[0] || '', fallbackSeason, fallbackEpisode);

    let workingId = parsed.id;
    let season = parsed.season;
    let episode = parsed.episode;
    let kind = isSeries ? 'tv' : 'movie';
    let resolvedTmdbId = ids.map(tmdbFrom).find(Boolean) || tmdbFrom(workingId) || null;
    let rawEpisodeNumber = null;
    let episodeCandidates = numberPlan([episode]);

    const contextImdbId = ids.map(imdbFrom).find(Boolean) || null;
    const contextTmdbId = ids.map(tmdbFrom).find(Boolean) || null;
    const contextKitsuId = [meta?.kitsu_id, meta?.kitsuId, ...ids.filter((id) => /^kitsu:/i.test(String(id || '').trim()))]
        .map(kitsuFrom)
        .find(Boolean) || null;

    if (!workingId) workingId = contextImdbId || contextTmdbId || (contextKitsuId ? `kitsu:${contextKitsuId}` : '');

    let animeContext = null;
    const canTryAnime = isSeries && String(meta?.type || '').toLowerCase() !== 'movie' && Boolean(
        contextKitsuId
        || ids.some((id) => /^kitsu:/i.test(String(id || '').trim()))
        || meta?.tmdbAnimeCandidate === true
        || (meta?.isAnime === true && (contextImdbId || contextTmdbId || meta?.tmdb_id || meta?.imdb_id))
    );

    if (canTryAnime) {
        animeContext = await animeSearchProfile(meta, originalId, finalId, config, season, episode);
        if (animeContext?.kitsuId) {
            if (animeContext?.seasonNumber) season = animeContext.seasonNumber;
            if (animeContext?.requestedEpisode) episode = animeContext.requestedEpisode;
            kind = 'anime';
        }
    }

    const applyMapping = (mapped) => {
        if (!mapped) return false;
        if (mapped.tmdbId) resolvedTmdbId = mapped.tmdbId;
        if (mapped.imdbId) workingId = mapped.imdbId;
        else if (mapped.tmdbId && !imdbFrom(workingId)) workingId = mapped.tmdbId;
        if (mapped.rawEpisodeNumber) rawEpisodeNumber = mapped.rawEpisodeNumber;
        if (mapped.mappedSeason && mapped.mappedEpisode) {
            season = mapped.mappedSeason;
            episode = mapped.mappedEpisode;
        } else if (mapped.rawEpisodeNumber) {
            episode = mapped.rawEpisodeNumber;
        }
        episodeCandidates = numberPlan([episode, rawEpisodeNumber, ...(episodeCandidates || [])]);
        return Boolean(mapped.imdbId || mapped.tmdbId || mapped.mappedSeason || mapped.mappedEpisode || mapped.rawEpisodeNumber);
    };

    const usedSharedMap = applyMapping(animeContext?.mappedIds || null);
    if (!usedSharedMap && (String(workingId || '').startsWith('kitsu:') || contextKitsuId)) {
        const mapped = await kitsuBridgeIds(contextKitsuId || kitsuFrom(workingId), isSeries ? season : null, isSeries ? episode : 1, config);
        applyMapping(mapped);
    }

    if (!imdbFrom(workingId) && contextImdbId) workingId = contextImdbId;
    else if (!tmdbFrom(workingId) && contextTmdbId) workingId = contextTmdbId;

    if (!imdbFrom(workingId)) {
        const tmdbId = tmdbFrom(workingId) || resolvedTmdbId || contextTmdbId;
        const resolvedImdb = await imdbFromTmdb(tmdbId, kind === 'movie' ? 'movie' : 'tv');
        if (resolvedImdb) workingId = resolvedImdb;
    }

    return {
        imdbId: imdbFrom(workingId),
        tmdbId: tmdbFrom(workingId) || resolvedTmdbId || contextTmdbId || null,
        isAnime: kind === 'anime',
        searchTitles: Array.isArray(animeContext?.searchTitles) ? animeContext.searchTitles : [],
        rawTitles: Array.isArray(animeContext?.rawTitles) ? animeContext.rawTitles : [],
        expectedYear: animeContext?.year || yearFrom(meta?.year || meta?.releaseInfo || ''),
        season,
        episode,
        rawEpisodeNumber,
        episodeCandidates: numberPlan([episode, rawEpisodeNumber, ...(episodeCandidates || [])]),
        providerType: kind
    };
}

function seasonFromLabel(text) {
    const match = String(text || '').match(/(?:season|stagione)\s*0*(\d+)\b|(?:^|\b)s\s*0*(\d+)\b/i);
    const value = Number.parseInt(String(match?.[1] || match?.[2] || ''), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
}

function episodeFromLabel(text) {
    const source = String(text || '');
    const patterns = [
        /\bS\d{1,2}E0*(\d{1,4})\b/i,
        /\b\d{1,2}x0*(\d{1,4})\b/i,
        /(?:episode|episodio|ep\.?)\s*0*(\d{1,4})\b/i,
        /(?:^|[^a-z0-9])E0*(\d{1,4})(?:[^a-z0-9]|$)/i,
        /^\s*0*(\d{1,4})\s*[-–.]/
    ];
    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match) return Number.parseInt(match[1], 10) || null;
    }
    return null;
}

function looksLikeCompactUrlToken(value) {
    const text = safeText(value).replace(/\//g, '/').trim();
    if (!text || text.startsWith('data:')) return false;
    if (text.length > 4096) return false;

    // Hard guard: never allow JavaScript source/body text to become a fake relative URL.
    if (/^(?:function|class|const|let|var|return|if|for|while|switch)\b/i.test(text)) return false;
    if (/[{}<>;]/.test(text)) return false;
    if (/(?:=>|document\.|window\[|callbacks\.|Hls\.|DefaultConfig|Playerjs|Math\.floor|replace\s*\()/i.test(text)) return false;

    // Media URLs should be URL-like tokens, not arbitrary script chunks with spaces/newlines.
    if (/[\r\n\t]/.test(text)) return false;
    if (/\s/.test(text) && !/%[0-9A-F]{2}/i.test(text)) return false;

    return /^(?:https?:\/\/|\/\/|\/|\.\.?\/|[A-Za-z0-9._~!$&'()*+,=:@%-]+(?:\/|\.))/i.test(text);
}

function isLikelyMediaUrl(value) {
    const text = safeText(value).replace(/\//g, '/').trim();
    if (!looksLikeCompactUrlToken(text)) return false;

    // Do not classify iframe/player/page URLs as playable media.
    // cc_proxy must receive a real media endpoint, not CinemaCity HTML.
    if (/\.(?:m3u8|mp4|mkv|webm|m4a|aac|ts|m4s)(?:$|[?#,])/i.test(text)) return true;
    if (/\b(?:public_files|playlist|manifest|master|hls|dash)\b/i.test(text)
        && /(?:m3u8|mp4|mkv|webm|m4a|aac|ts|m4s)/i.test(text)) return true;

    return false;
}

function decodeBase64Text(value) {
    try {
        return Buffer.from(String(value || ''), 'base64').toString('utf8');
    } catch (_) {
        return '';
    }
}

function scriptPayloadInputs(html) {
    const body = String(html || '');
    const $ = htmlRoot(body);
    const out = [];

    $('script').each((_, script) => {
        const text = $(script).html() || '';
        if (text) out.push({ kind: 'script', value: text });
    });

    $('[data-file], [data-src], [data-url], [data-player], source[src], iframe[src]').each((_, node) => {
        const attrs = node.attribs || {};
        for (const key of ['data-file', 'data-src', 'data-url', 'data-player', 'src']) {
            if (attrs[key]) out.push({ kind: 'attr', value: attrs[key] });
        }
    });

    for (const match of body.matchAll(/atob\s*\(\s*['"]([^'"]{30,})['"]\s*\)/gi)) {
        out.push({ kind: 'b64', value: match[1] });
    }

    return out;
}

function firstBalancedFragment(text, startIndex) {
    const source = String(text || '');
    const open = source[startIndex];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = startIndex; index < source.length; index++) {
        const char = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === open) depth++;
        if (char === close) depth--;
        if (depth === 0) return source.slice(startIndex, index + 1);
    }
    return null;
}

function jsonFragments(text) {
    const source = String(text || '');
    const fragments = [];
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (char !== '[' && char !== '{') continue;
        const fragment = firstBalancedFragment(source, index);
        if (!fragment || fragment.length < 4) continue;
        fragments.push(fragment);
        index += fragment.length - 1;
    }
    return fragments.slice(0, 40);
}

function parseJsonish(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const attempts = [raw, raw.replace(/\\(.)/g, '$1')];
    for (const candidate of attempts) {
        try {
            return JSON.parse(candidate);
        } catch (_) {}
    }
    return null;
}

function sourceAssignments(text) {
    const source = String(text || '').replace(/\\\//g, '/');
    const out = [];
    const mediaExt = 'm3u8|mp4|mkv|webm|m4a|aac|ts|m4s';
    const patterns = [
        new RegExp("(?:file|url|src)\\s*[:=]\\s*['\"]([^'\"]+\\.(?:" + mediaExt + ")(?:\\?[^'\"]*)?)['\"]", 'gi'),
        new RegExp("(?:sources|playlist)\\s*[:=]\\s*['\"]([^'\"]+)['\"]", 'gi'),
        new RegExp("(https?:\\/\\/[^\\s'\"<>]+\\.(?:" + mediaExt + ")(?:\\?[^\\s'\"<>]+)?)", 'gi'),
        new RegExp("((?:\\/[^\\s'\"<>]+)+\\.(?:" + mediaExt + ")(?:\\?[^\\s'\"<>]+)?)", 'gi')
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const url = safeText(match[1]);
            if (url && isLikelyMediaUrl(url)) out.push(url);
        }
    }
    return listUnique(out);
}

function payloadObjectsFromHtml(html) {
    const objects = [];
    const seen = new Set();
    const push = (value) => {
        if (value == null) return;
        const key = typeof value === 'string' ? value : JSON.stringify(value).slice(0, 1000);
        if (seen.has(key)) return;
        seen.add(key);
        objects.push(value);
    };

    for (const input of scriptPayloadInputs(html)) {
        const direct = safeText(input.value);
        const decoded = input.kind === 'b64' ? decodeBase64Text(input.value) : '';
        for (const text of [direct, decoded, decoded ? he.decode(decoded) : ''].filter(Boolean)) {
            if (isLikelyMediaUrl(text)) push(text);
            for (const url of sourceAssignments(text)) push(url);
            const asJson = parseJsonish(text);
            if (asJson) push(asJson);
            for (const fragment of jsonFragments(text)) {
                const parsed = parseJsonish(fragment);
                if (parsed) push(parsed);
            }
        }
    }

    return objects;
}

function makeAsset(kind, data = {}) {
    return {
        kind,
        title: safeText(data.title || data.label || data.name || ''),
        season: numericId(data.season || data.seasonNumber || data.season_number) || null,
        episode: numericId(data.episode || data.episodeNumber || data.episode_number) || null,
        url: data.url || data.file || data.src || null,
        children: Array.isArray(data.children) ? data.children : []
    };
}

function assetTree(value, context = {}) {
    if (!value) return null;
    if (typeof value === 'string') {
        return isLikelyMediaUrl(value) ? makeAsset('source', { url: value, title: context.title }) : null;
    }
    if (Array.isArray(value)) {
        const children = value.map((item, index) => assetTree(item, { ...context, index: index + 1 })).filter(Boolean);
        return children.length ? makeAsset('group', { title: context.title || 'root', children }) : null;
    }
    if (typeof value !== 'object') return null;

    const title = safeText(value.title || value.label || value.name || value.text || context.title || '');
    const folder = Array.isArray(value.folder) ? value.folder : (Array.isArray(value.children) ? value.children : null);
    const directUrl = value.file || value.url || value.src || value.source;

    if (directUrl && isLikelyMediaUrl(directUrl)) {
        return makeAsset('source', {
            title,
            url: directUrl,
            season: value.season || value.seasonNumber || seasonFromLabel(title),
            episode: value.episode || value.episodeNumber || episodeFromLabel(title)
        });
    }

    if (folder) {
        const children = folder.map((item, index) => assetTree(item, { title, index: index + 1 })).filter(Boolean);
        const season = numericId(value.season || value.seasonNumber) || seasonFromLabel(title);
        return makeAsset(season ? 'season' : 'group', { title, season, children });
    }

    const nested = [];
    for (const key of ['sources', 'playlist', 'files', 'items']) {
        if (Array.isArray(value[key])) nested.push(...value[key]);
    }
    if (nested.length) {
        const children = nested.map((item, index) => assetTree(item, { title, index: index + 1 })).filter(Boolean);
        return children.length ? makeAsset('group', { title, children }) : null;
    }

    return null;
}

function flattenAssets(node, state = {}, out = []) {
    if (!node) return out;
    const title = node.title || state.title || '';
    const season = node.season || state.season || seasonFromLabel(title) || null;
    const episode = node.episode || state.episode || episodeFromLabel(title) || null;
    if (node.url) {
        out.push({
            url: node.url,
            title,
            season,
            episode,
            path: [...(state.path || []), title].filter(Boolean)
        });
    }
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child, index) => {
        flattenAssets(child, {
            title: child.title || title,
            season,
            episode,
            path: [...(state.path || []), title].filter(Boolean),
            index: index + 1
        }, out);
    });
    return out;
}

function selectPlayableAsset(payloads, request = {}) {
    const type = request.type === 'movie' ? 'movie' : 'series';
    const wantedSeason = numericId(request.season) || 1;
    const wantedEpisodes = numberPlan([
        request.episode,
        ...(Array.isArray(request.episodeCandidates) ? request.episodeCandidates : []),
        request.rawEpisodeNumber
    ]);
    const seasonPlan = numberPlan([wantedSeason, ...(Array.isArray(request.seasonCandidates) ? request.seasonCandidates : []), 1]);

    const sources = [];
    for (const payload of payloads) {
        const tree = assetTree(payload);
        if (!tree) continue;
        sources.push(...flattenAssets(tree));
    }
    if (!sources.length) return null;

    if (type === 'movie') return sources[0]?.url || null;

    const scored = sources.map((source, index) => {
        let score = 0;
        if (source.season && seasonPlan.includes(source.season)) score += 30;
        else if (!source.season && seasonPlan.includes(1)) score += 8;
        if (source.episode && wantedEpisodes.includes(source.episode)) score += 45;
        if (!source.episode && wantedEpisodes.includes(index + 1)) score += 18;
        if (request.looseAnime && source.episode && wantedEpisodes.includes(source.episode)) score += 12;
        const text = [source.title, ...(source.path || [])].join(' ');
        for (const ep of wantedEpisodes) {
            if (new RegExp(`(?:^|[^0-9])0*${ep}(?:[^0-9]|$)`).test(text)) score += 8;
        }
        return { ...source, index, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best?.score >= 45) return best.url;

    const hasExplicitEpisodeNumbers = sources.some((source) => Number.isInteger(source.episode));
    if (!hasExplicitEpisodeNumbers && wantedEpisodes.length) {
        const byIndex = sources[wantedEpisodes[0] - 1]?.url || null;
        if (byIndex && sources.length >= wantedEpisodes[0]) return byIndex;
    }

    return null;
}

function playbackFrameUrl(html, pageUrl) {
    const $ = htmlRoot(html);
    const buckets = [[], [], []];

    $('iframe[src]').each((_, node) => {
        const value = node.attribs?.src || '';
        const absolute = ccUrl(value, pageUrl);
        if (!absolute) return;
        if (/player\.php/i.test(value)) buckets[0].push(absolute);
        else if (/embed|watch|play/i.test(value)) buckets[1].push(absolute);
    });

    $('[data-player], [data-url], [data-src], button[data-src]').each((_, node) => {
        const attrs = node.attribs || {};
        for (const key of ['data-player', 'data-url', 'data-src']) {
            const value = attrs[key];
            if (!value || !/player\.php|embed|watch|play/i.test(value)) continue;
            const absolute = ccUrl(value, pageUrl);
            if (absolute) buckets[2].push(absolute);
        }
    });

    return listUnique([...buckets[0], ...buckets[1], ...buckets[2]])[0] || pageUrl;
}

async function parsePlayablePage(pageUrl, meta = {}) {
    const html = await ccText(pageUrl, {
        Referer: `${CC_HOME}/`,
        Cookie: ccSessionCookie(),
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1'
    }, { timeout: 2500, attempts: 1 });
    if (!html) return null;

    const facts = parsePageFacts(html, pageUrl);
    cache.metadata.set(normalizeRemoteUrl(pageUrl), facts);

    const playerUrl = playbackFrameUrl(html, pageUrl);
    let payloads = payloadObjectsFromHtml(html);

    if (playerUrl && playerUrl !== pageUrl) {
        const playerHtml = await ccText(playerUrl, {
            Referer: pageUrl,
            Cookie: ccSessionCookie(),
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'navigate'
        }, { timeout: 2500, attempts: 1, axiosFallback: true });
        if (playerHtml) payloads = [...payloads, ...payloadObjectsFromHtml(playerHtml)];
    }

    const selected = selectPlayableAsset(payloads, {
        type: meta?.isSeries ? 'series' : 'movie',
        season: meta?.season || 1,
        episode: meta?.episode || 1,
        rawEpisodeNumber: meta?.rawEpisodeNumber,
        episodeCandidates: Array.isArray(meta?.episodeCandidates) ? meta.episodeCandidates : [],
        looseAnime: meta?.providerType === 'anime' || meta?.isAnime === true
    });
    const cleanedSource = cleanPlayableSource(selected);
    if (!cleanedSource || !isLikelyMediaUrl(cleanedSource)) {
        if (process.env.DEBUG_CINEMACITY === '1') {
            console.warn('[CC V2] playable source rejected before resolve | value=%s', String(selected || '').slice(0, 180));
        }
        return null;
    }
    const streamUrl = ccUrl(cleanedSource, playerUrl || pageUrl) || ccUrl(cleanedSource, pageUrl);
    if (!streamUrl || !isLikelyMediaUrl(streamUrl)) {
        if (process.env.DEBUG_CINEMACITY === '1') {
            console.warn('[CC V2] playable source rejected after resolve | value=%s target=%s', String(selected || '').slice(0, 180), String(streamUrl || '').slice(0, 180));
        }
        return null;
    }

    const fp = getRandomFingerprint();
    return {
        streamUrl,
        pageMetadata: facts,
        headers: normalizePlaybackHeaders({
            'User-Agent': fp.userAgent,
            Referer: playerUrl || pageUrl,
            Origin: urlOrigin(pageUrl),
            Accept: isProbablyHls(streamUrl) ? 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*' : '*/*',
            'Accept-Language': fp.acceptLanguage,
            Cookie: ccSessionCookie()
        }, streamUrl, pageUrl)
    };
}

async function parsedStream(pageUrl, meta = {}) {
    const normalized = normalizeRemoteUrl(pageUrl);
    if (!normalized) return null;
    const cacheKey = `stream:${normalized}:${meta?.isSeries ? 'series' : 'movie'}:${meta?.season || 1}:${meta?.episode || 1}:${meta?.rawEpisodeNumber || ''}:${(meta?.episodeCandidates || []).join(',')}`;
    const cached = cache.stream.get(cacheKey);
    if (cached !== null) return cached;

    return keyedTask(cacheKey, async () => {
        const again = cache.stream.get(cacheKey);
        if (again !== null) return again;
        const result = await parsePlayablePage(normalized, meta);
        cache.stream.set(cacheKey, result || null);
        return result || null;
    });
}


function legacyPickStreamCompat(fileData, type, season = 1, episode = 1, options = {}) {
    const payloads = Array.isArray(fileData) ? fileData : [fileData];
    return selectPlayableAsset(payloads, {
        isSeries: type !== 'movie',
        season,
        episode,
        rawEpisodeNumber: options?.rawEpisodeNumber,
        episodeCandidates: options?.episodeCandidates || []
    });
}

function displayName(meta = {}, fallbackTitle, season, episode) {
    const title = safeText(meta?.title || meta?.name || meta?.originalTitle || fallbackTitle || 'CinemaCity')
        .replace(/\s*\(.*?\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (meta?.isSeries) return `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    return title;
}

function cleanPlayableSource(value) {
    return safeText(value)
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/^['"]+|['"]+$/g, '')
        .trim();
}

function isProbablyHls(value) {
    const text = cleanPlayableSource(value);
    return /\.m3u8(?:$|[?#,])/i.test(text) || /(?:^|[/?&])(?:hls|manifest|playlist|master)(?:[=/_-]|$)/i.test(text);
}

function headerValue(headers = {}, wanted) {
    const target = String(wanted || '').toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (String(key || '').toLowerCase() === target && value != null && value !== '') return String(value);
    }
    return '';
}

function normalizePlaybackHeaders(headers = {}, streamUrl = '', pageUrl = CC_HOME) {
    const fp = getRandomFingerprint();
    const referer = headerValue(headers, 'referer') || pageUrl || CC_HOME;
    const origin = headerValue(headers, 'origin') || urlOrigin(referer) || CC_HOME;
    return {
        'User-Agent': headerValue(headers, 'user-agent') || fp.userAgent,
        Accept: headerValue(headers, 'accept') || (isProbablyHls(streamUrl) ? 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*' : '*/*'),
        'Accept-Language': headerValue(headers, 'accept-language') || fp.acceptLanguage || 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: referer,
        Origin: origin,
        ...(headerValue(headers, 'cookie') ? { Cookie: headerValue(headers, 'cookie') } : {})
    };
}

function buildCcProxyPlaybackUrl(streamUrl, headers = {}, reqHost = null) {
    const target = normalizeRemoteUrl(cleanPlayableSource(streamUrl));
    if (!target || !isLikelyMediaUrl(target)) return null;
    const proxyHeaders = normalizePlaybackHeaders(headers, target);
    return buildCinemaCityProxyUrl(target, proxyHeaders, reqHost, { isHls: isProbablyHls(target) });
}

function mediaflowUrl(config = {}, streamUrl, headers = {}, hls = false) {
    const base = String(config?.mediaflow?.url || '').trim().replace(/\/$/, '');
    const target = normalizeRemoteUrl(streamUrl);
    if (!base || !target) return null;
    const password = config?.mediaflow?.pass ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';
    const referer = headers?.Referer ? `&h_Referer=${encodeURIComponent(headers.Referer)}` : '';
    const origin = headers?.Origin ? `&h_Origin=${encodeURIComponent(headers.Origin)}` : '';
    if (hls) return `${base}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(target)}${password}${referer}${origin}`;
    return `${base}/proxy/stream?d=${encodeURIComponent(target)}${password}${referer}${origin}`;
}

async function searchCinemaCity(originalId, finalId, meta, config = {}, reqHost = null) {
    try {
        const resolved = await requestProfile(meta, originalId, finalId, config);
        if (!resolved.imdbId && !resolved.tmdbId && (!resolved.isAnime || resolved.searchTitles.length === 0)) return [];

        const catalogOptions = {
            expectedTitles: listUnique([
                ...(Array.isArray(resolved.searchTitles) ? resolved.searchTitles : []),
                ...(Array.isArray(resolved.rawTitles) ? resolved.rawTitles : [])
            ]),
            requestedImdbId: resolved.imdbId,
            expectedYear: resolved.expectedYear,
            fast: config?.filters?.cinemacityFast !== false
        };

        let catalogItem = await resolveCatalog(
            resolved.tmdbId || resolved.imdbId || originalId,
            resolved.providerType,
            meta,
            catalogOptions
        );
        if (!catalogItem?.url && resolved.imdbId) catalogItem = await searchImdb(resolved.imdbId);
        if (!catalogItem?.url) return [];

        const enrichedMeta = {
            ...meta,
            season: resolved.season,
            episode: resolved.episode,
            rawEpisodeNumber: resolved.rawEpisodeNumber,
            episodeCandidates: resolved.episodeCandidates,
            providerType: resolved.providerType
        };
        const extracted = await parsedStream(catalogItem.url, enrichedMeta);
        if (!extracted?.streamUrl) return [];

        const facts = extracted.pageMetadata || {};
        if (!pageAudioOk(facts, config)) {
            if (config?.debug || process.env.DEBUG_CINEMACITY === '1') console.warn(languageRejectLog(facts, config));
            return [];
        }
        if (streamLanguageRejected(extracted.streamUrl, config)) {
            if (config?.debug || process.env.DEBUG_CINEMACITY === '1') console.warn('[CC V2] stream rejected by language policy:', extracted.streamUrl);
            return [];
        }

        let quality = normalizeQuality(facts.quality || '1080p');
        const hls = isProbablyHls(extracted.streamUrl);
        if (hls) {
            try {
                const qualityKey = `quality:${normalizeRemoteUrl(extracted.streamUrl)}`;
                const cachedQuality = cache.quality.get(qualityKey);
                const detected = cachedQuality || await keyedTask(qualityKey, async () => {
                    const again = cache.quality.get(qualityKey);
                    if (again) return again;
                    const probed = await probePlaylistQuality(httpClient, extracted.streamUrl, {
                        headers: extracted.headers,
                        timeout: 6000
                    });
                    cache.quality.set(qualityKey, probed || 'Unknown');
                    return probed || 'Unknown';
                });
                quality = pickBetterQuality(detected || 'Unknown', quality);
            } catch (_) {}
        }

        const extractor = /cccdn/i.test(extracted.streamUrl) ? 'CCCDN' : (hls ? 'HLS' : 'Direct');
        const title = displayName(meta, facts.title || catalogItem.title, resolved.season, resolved.episode);
        const lang = languageBadge(facts, config);
        const proxyHeaders = normalizePlaybackHeaders(extracted.headers, extracted.streamUrl, catalogItem.url);
        const internalProxy = buildCcProxyPlaybackUrl(extracted.streamUrl, proxyHeaders, reqHost);
        const viaMfp = mediaflowUrl(config, extracted.streamUrl, proxyHeaders, hls);
        // Same policy as the previous CinemaCity handler:
        // if MediaFlow/MFP is configured, use it; otherwise fall back to the internal cc_proxy.
        const proxied = viaMfp || internalProxy;
        const mode = viaMfp ? 'MFP' : 'CCCDN';
        const behavior = {
            bingeWatching: true,
            vortexMeta: {
                pageTitle: facts.title || '',
                imdbId: facts.imdbId || resolved.imdbId || '',
                tmdbId: facts.tmdbId || resolved.tmdbId || '',
                qualityTag: facts.qualityTag || '',
                audioLanguages: Array.isArray(facts.audioLanguages) ? facts.audioLanguages : [],
                subtitleLanguages: Array.isArray(facts.subtitleLanguages) ? facts.subtitleLanguages : [],
                genres: Array.isArray(facts.genres) ? facts.genres : [],
                isMultiAudio: facts.isMultiAudio === true,
                isAnime: facts.isAnime === true
            }
        };

        const streams = [];
        if (proxied) {
            streams.push(buildWebStream({
                name: `🎟️ CinemaCity | ${mode}`,
                title: `${title}\n☁️ ${mode} • ${lang}`,
                url: proxied,
                extractor: mode,
                provider: 'CinemaCity',
                providerCode: 'CC',
                quality,
                headers: null,
                notWebReady: false,
                extraBehaviorHints: behavior
            }));
        }

        if (streams.length === 0) {
            streams.push(buildWebStream({
                name: '🎟️ CinemaCity | Direct',
                title: `${title}\n☁️ ${extractor} • ${lang}`,
                url: extracted.streamUrl,
                extractor,
                provider: 'CinemaCity',
                providerCode: 'CC',
                quality,
                headers: extracted.headers,
                notWebReady: true,
                extraBehaviorHints: behavior
            }));
        }

        return filterByLanguage(dedupeStreamsByUrl(streams), config)
            .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    } catch (error) {
        console.error('[CC V2] Error:', error?.stack || error?.message || error);
        return [];
    }
}

module.exports = {
    searchCinemaCity,
    __private: {
        animeLike,
        ccUrlMatchesKind,
        cardLinksFromListing,
        queryPlan,
        slugTitle,
        titleScore,
        titlePlanFromOne,
        listingRoots,
        selectPlayableAsset,
        parsePageFacts,
        downloadLanguages,
        languageBadge,
        langToken,
        langList,
        wantedLang,
        strictLangMode,
        pageAudioOk,
        languageRejectLog,
        streamLanguageRejected,
        filterByLanguage,
        // Backward-compatible aliases used by Leviathan tests and older imports.
        looksLikeAnimeMeta: animeLike,
        isCinemaCityContentUrlForType: ccUrlMatchesKind,
        extractCandidateLinksFromListing: cardLinksFromListing,
        buildSearchQueryVariants: queryPlan,
        scoreTitleMatch: titleScore,
        getListingBaseUrls: listingRoots,
        pickStream: legacyPickStreamCompat,
        parseCinemaCityPageMetadata: parsePageFacts,
        extractDownloadLanguagesFromPage: downloadLanguages,
        buildCinemaCityLanguageLabel: languageBadge,
        normalizeLanguageToken: langToken,
        normalizeLanguageList: langList,
        getWantedLanguage: wantedLang,
        isStrictSingleLanguageMode: strictLangMode,
        pageHasRequestedAudio: pageAudioOk,
        buildLanguageRejectReason: languageRejectLog,
        streamUrlHasForbiddenLanguage: streamLanguageRejected,
        hardFilterStreamsByLanguage: filterByLanguage,
        payloadObjectsFromHtml,
        assetTree,
        flattenAssets
    }
};
