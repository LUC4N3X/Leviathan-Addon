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

const BASE_URL = Buffer.from('aHR0cHM6Ly9jaW5lbWFjaXR5LmNj', 'base64').toString('utf8');
const DEFAULT_SESSION_COOKIE = Buffer.from(
    'ZGxlX3VzZXJfaWQ9MzI3Mjk7IGRsZV9wYXNzd29yZD04OTQxNzFjNmE4ZGFiMThlZTU5NGQ1YzY1MjAwOWEzNTs=',
    'base64'
).toString('utf8');
const FETCH_TIMEOUT = 4500;
const GOT_TIMEOUT = 2500;
const GOT_ATTEMPTS = 3;
const MAX_LISTING_PAGES = 8;
const MAX_LISTING_CANDIDATES_PER_PAGE = 24;
const SEARCH_CACHE_TTL_MS = 20 * 60 * 1000;
const RESOLVED_SEARCH_CACHE_TTL_MS = 45 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;
const TMDB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const KITSU_MAPPING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const QUALITY_PROBE_CACHE_TTL_MS = 20 * 60 * 1000;
const MAPPING_API_BASE = 'https://anime.questoleviatanormio.dpdns.org';
const NEWS_SITEMAP_URL = `${BASE_URL}/news_pages.xml`;
const NEWS_SITEMAP_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const { updateCookiesFromResponse, getCookieHeaderForUrl } = createDomainCookieJar();

function getCinemaCitySessionCookie() {
    return String(process.env.CINEMACITY_COOKIE || '').trim() || DEFAULT_SESSION_COOKIE;
}

const httpClient = axios.create({
    timeout: FETCH_TIMEOUT,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    proxy: false,
    validateStatus: () => true
});

const newsSitemapCache = {
    fetchedAt: 0,
    entries: null,
    pending: null
};

class TtlLruCache {
    constructor({ ttlMs = 600000, max = 500 } = {}) {
        this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 600000;
        this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 500;
        this.map = new Map();
    }

    has(key) {
        if (!key) return false;
        const item = this.map.get(key);
        if (!item) return false;
        if (Date.now() > item.expiresAt) {
            this.map.delete(key);
            return false;
        }
        return true;
    }

    get(key) {
        if (!key) return null;
        const item = this.map.get(key);
        if (!item) return null;
        if (Date.now() > item.expiresAt) {
            this.map.delete(key);
            return null;
        }
        this.map.delete(key);
        this.map.set(key, item);
        return item.value;
    }

    set(key, value) {
        if (!key) return;
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, {
            value,
            expiresAt: Date.now() + this.ttlMs
        });
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
        }
    }

    delete(key) {
        if (!key) return;
        this.map.delete(key);
    }

    clear() {
        this.map.clear();
    }

    get size() {
        return this.map.size;
    }
}

const pendingTasks = new Map();

async function singleFlight(key, fn) {
    if (!key) return fn();
    if (pendingTasks.has(key)) return pendingTasks.get(key);
    const task = Promise.resolve()
        .then(fn)
        .finally(() => pendingTasks.delete(key));
    pendingTasks.set(key, task);
    return task;
}

function loadHtml(html) {
    return cheerio.load(String(html || ''), { decodeEntities: false });
}

function normalizeSectionLabel(value) {
    return decodeHtmlEntities(value)
        .replace(/\s+/g, ' ')
        .replace(/:$/g, '')
        .trim()
        .toLowerCase();
}

function cleanSectionValue(value) {
    return decodeHtmlEntities(value)
        .replace(/\s+/g, ' ')
        .replace(/^[,;:|\-]+|[,;:|\-]+$/g, '')
        .trim();
}

function attrSelectorValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const pageMetadataCache = new TtlLruCache({
    ttlMs: 60 * 60 * 1000,
    max: 1000
});

const searchCandidatesCache = new TtlLruCache({
    ttlMs: SEARCH_CACHE_TTL_MS,
    max: 800
});

const resolvedSearchCache = new TtlLruCache({
    ttlMs: RESOLVED_SEARCH_CACHE_TTL_MS,
    max: 800
});

const streamResultCache = new TtlLruCache({
    ttlMs: STREAM_CACHE_TTL_MS,
    max: 600
});

const tmdbMetadataCache = new TtlLruCache({
    ttlMs: TMDB_CACHE_TTL_MS,
    max: 1200
});

const tmdbImdbCache = new TtlLruCache({
    ttlMs: TMDB_CACHE_TTL_MS,
    max: 1200
});

const kitsuMappingCache = new TtlLruCache({
    ttlMs: KITSU_MAPPING_CACHE_TTL_MS,
    max: 1600
});

const qualityProbeCache = new TtlLruCache({
    ttlMs: QUALITY_PROBE_CACHE_TTL_MS,
    max: 800
});

const fetchFailureCache = new TtlLruCache({
    ttlMs: NEGATIVE_CACHE_TTL_MS,
    max: 2000
});

async function fetchHtmlWithGot(url, extraHeaders = {}, attempt = 0, requestTimeout = GOT_TIMEOUT) {
    const gotScraping = await getGotScraping();
    if (!gotScraping) return null;

    const fp = getRandomFingerprint();
    const cookieHeader = getCookieHeaderForUrl(url, extraHeaders.Cookie || '');
    const mergedHeaders = buildBrowserHeaders(fp, { ...extraHeaders, ...(cookieHeader ? { Cookie: cookieHeader } : {}) });

    try {
        const response = await gotScraping({
            url,
            headers: mergedHeaders,
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
        const body = response?.body || '';
        updateCookiesFromResponse(url, response.headers);

        if (isCloudflareChallenge(body, status)) return null;
        if (status >= 200 && status < 400) return body;
        return null;
    } catch (_) {
        return null;
    }
}

async function fetchHtmlWithAxios(url, extraHeaders = {}, requestTimeout = FETCH_TIMEOUT) {
    const fp = getRandomFingerprint();
    const cookieHeader = getCookieHeaderForUrl(url, extraHeaders.Cookie || '');
    const mergedHeaders = buildBrowserHeaders(fp, { ...extraHeaders, ...(cookieHeader ? { Cookie: cookieHeader } : {}) });

    try {
        const response = await httpClient.get(url, {
            headers: mergedHeaders,
            responseType: 'text',
            timeout: requestTimeout
        });
        const status = Number(response?.status || 0);
        const body = responseText(response?.data);
        updateCookiesFromResponse(url, response.headers);

        if (isCloudflareChallenge(body, status)) return null;
        if (status >= 200 && status < 400) return body;
        return null;
    } catch (_) {
        return null;
    }
}

async function fetchHtmlPostWithGot(url, formBody, extraHeaders = {}) {
    const gotScraping = await getGotScraping();
    if (!gotScraping) return null;

    const fp = getRandomFingerprint();
    const cookieHeader = getCookieHeaderForUrl(url, extraHeaders.Cookie || getCinemaCitySessionCookie());
    const baseHeaders = buildBrowserHeaders(fp, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/`,
        ...extraHeaders,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
    });

    try {
        const response = await gotScraping({
            url,
            method: 'POST',
            body: formBody,
            headers: baseHeaders,
            useHeaderGenerator: true,
            headerGeneratorOptions: getGotScrapingHeaderOptions(fp, { minVersion: 120 }),
            retry: { limit: 0 },
            timeout: { request: GOT_TIMEOUT },
            followRedirect: true,
            maxRedirects: 6,
            responseType: 'text',
            decompress: true
        });

        const status = Number(response?.statusCode || 0);
        const body = response?.body || '';
        updateCookiesFromResponse(url, response.headers);

        if (isCloudflareChallenge(body, status)) return null;
        if (status >= 200 && status < 400) return body;
        return null;
    } catch (_) {
        return null;
    }
}

async function fetchHtml(url, extraHeaders = {}, options = {}) {
    const cacheKey = `url:${url}`;
    if (fetchFailureCache.get(cacheKey)) return null;

    const timeout = options.timeout || FETCH_TIMEOUT;
    const attempts = Math.max(1, Math.min(GOT_ATTEMPTS, Number.parseInt(String(options.attempts || GOT_ATTEMPTS), 10) || GOT_ATTEMPTS));
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
            const baseDelay = Math.min(4000, 200 * Math.pow(2, attempt));
            const jitter = Math.floor(Math.random() * 200);
            await sleep(baseDelay + jitter);
        }
        const gotBody = await fetchHtmlWithGot(url, extraHeaders, attempt, timeout);
        if (gotBody) return gotBody;
    }

    if (options.axiosFallback !== false) {
        const axiosBody = await fetchHtmlWithAxios(url, extraHeaders, timeout);
        if (axiosBody) return axiosBody;
    }

    fetchFailureCache.set(cacheKey, true);
    return null;
}

async function fetchJson(url, options = {}) {
    const fp = getRandomFingerprint();
    const defaultHeaders = {
        'User-Agent': fp.userAgent,
        'Accept': 'application/json,*/*;q=0.8',
        'Accept-Language': fp.acceptLanguage
    };
    const response = await httpClient.get(url, {
        ...options,
        headers: { ...defaultHeaders, ...(options.headers || {}) }
    });
    const status = Number(response?.status || 0);
    if (status >= 200 && status < 400) return response.data;
    throw new Error(`HTTP ${status || 500}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value) {
    return he.decode(String(value || ''))
        .replace(/\u2013|\u2014/g, '-')
        .replace(/&ndash;|&mdash;/gi, '-');
}

function uniqueStrings(values = []) {
    return [...new Set((values || []).map((v) => decodeHtmlEntities(String(v || '')).trim()).filter(Boolean))];
}

function normalizeTitle(value) {
    return decodeHtmlEntities(String(value || ''))
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function extractImdbId(value) {
    const match = String(value || '').trim().match(/\btt\d{5,}\b/i);
    return match ? match[0].toLowerCase() : null;
}

function extractTmdbId(value) {
    const raw = String(value || '').trim();
    const tagged = raw.match(/^tmdb:(\d+)/i);
    if (tagged) return tagged[1];
    return /^\d+$/.test(raw) ? raw : null;
}

function extractKitsuId(value) {
    const raw = String(value || '').trim();
    if (/^\d+$/.test(raw)) return raw;
    const match = raw.match(/^kitsu:(\d+)/i);
    return match ? match[1] : null;
}

function getMappingLanguage(config = {}) {
    const lang = String(config?.filters?.language || '').trim().toLowerCase();
    return lang === 'ita' ? 'it' : null;
}

function extractSitemapLocs(xml) {
    return [...String(xml || '').matchAll(/<loc>([^<]+)<\/loc>/gi)]
        .map((m) => String(m[1] || '').trim())
        .filter(Boolean);
}

function getCinemaCitySectionType(url) {
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

function isCinemaCityContentUrlForType(url, providerType) {
    const sectionType = getCinemaCitySectionType(url);
    if (providerType === 'movie') return sectionType === 'movie';
    if (providerType === 'anime') return sectionType === 'anime' || sectionType === 'tv';
    return sectionType === 'tv' || sectionType === 'anime';
}

function getCinemaCityTypeBoost(url, providerType) {
    const sectionType = getCinemaCitySectionType(url);
    if (providerType === 'movie') return sectionType === 'movie' ? 18 : -40;
    if (providerType === 'anime') {
        if (sectionType === 'anime') return 24;
        if (sectionType === 'tv') return 10;
        return -40;
    }
    if (sectionType === 'tv') return 16;
    if (sectionType === 'anime') return 4;
    return -40;
}

function titleFromContentUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const slug = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
        return decodeHtmlEntities(
            slug
                .replace(/\.html?$/i, '')
                .replace(/^\d+-/, '')
                .replace(/-/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
        );
    } catch (_) {
        return '';
    }
}

function extractYear(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function extractSectionValues(html, sectionLabel) {
    const $ = loadHtml(html);
    const wanted = normalizeSectionLabel(sectionLabel);
    const values = [];

    $('li').each((_, li) => {
        const spans = $(li).children('span');
        if (spans.length < 2) return;
        const label = normalizeSectionLabel($(spans[0]).text());
        if (label !== wanted) return;

        const valueNode = $(spans[1]);
        const linked = [];
        valueNode.find('a').each((__, a) => {
            const value = cleanSectionValue($(a).text());
            if (value) linked.push(value);
        });

        const rawText = cleanSectionValue(valueNode.text());
        const sourceValues = linked.length > 0 ? linked : rawText.split(/[,;|]/g);
        for (const value of sourceValues) {
            const cleaned = cleanSectionValue(value);
            if (cleaned) values.push(cleaned);
        }
    });

    return uniqueStrings(values);
}

function extractMetaContent(html, property) {
    const $ = loadHtml(html);
    const key = attrSelectorValue(property);
    const value = $(`meta[property="${key}"]`).first().attr('content')
        || $(`meta[name="${key}"]`).first().attr('content')
        || '';
    return decodeHtmlEntities(value).trim();
}

function extractHeadingTitle(html) {
    const $ = loadHtml(html);
    const value = $('h1').first().text();
    return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
}

function pickHighestResolution(resolutions = []) {
    let best = 'Unknown';
    for (const r of resolutions) {
        best = pickBetterQuality(best, normalizeQuality(r));
    }
    return normalizeQuality(best);
}

function extractDownloadLanguagesFromPage(html) {
    const $ = loadHtml(html);
    const languages = [];

    $('.dar-tr_item').each((_, item) => {
        const title = decodeHtmlEntities($(item).find('.dar-tr_title').text() || '');
        const langLine = decodeHtmlEntities($(item).find('li').filter((__, li) => {
            return /language/i.test($(li).find('span').first().text() || '');
        }).text() || '');

        const combined = `${title} ${langLine}`;
        if (/\bItalian\b|\.Italian\.|\bITA\b/i.test(combined)) languages.push('italian');
        if (/\bEnglish\b|\.English\.|\bENG\b/i.test(combined)) languages.push('english');
        if (/\bMulti\b|Dual[-\s]?Audio|Multiaudio/i.test(combined)) languages.push('multi');
    });

    return normalizeLanguageList(languages);
}

function parseCinemaCityPageMetadata(html, pageUrl = '') {
    const body = String(html || '');
    const $ = loadHtml(body);
    const pageTitle = extractHeadingTitle(body)
        || extractMetaContent(body, 'og:title')
        || extractMetaContent(body, 'twitter:title')
        || titleFromContentUrl(pageUrl);
    const genres = extractSectionValues(body, 'Genre');
    const audioLanguages = extractSectionValues(body, 'Audio language');
    const downloadLanguages = extractDownloadLanguagesFromPage(body);
    const subtitleLanguages = extractSectionValues(body, 'Subtitle language');
    const listedResolutions = extractSectionValues(body, 'Resolution')
        .map((v) => normalizeQuality(v))
        .filter((v) => v !== 'Unknown');
    const uploadedQuality = body.match(/Uploaded\s+([^<\n]+)/i)?.[1] || '';
    const listedQualities = uniqueStrings([
        ...extractSectionValues(body, 'Quality'),
        uploadedQuality
    ]);

    let tmdbId = null;
    $('a[href*="themoviedb.org"], link[href*="themoviedb.org"]').each((_, node) => {
        if (tmdbId) return;
        const href = String($(node).attr('href') || '');
        const match = href.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
        if (match?.[1]) tmdbId = extractTmdbId(match[1]);
    });
    if (!tmdbId) {
        const tmdbMatch = body.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
        tmdbId = tmdbMatch?.[1] ? extractTmdbId(tmdbMatch[1]) : null;
    }

    const imdbId = extractImdbId(body);
    const quality = pickHighestResolution(listedResolutions);
    const qualityTag = listedQualities.find((v) => /web[- ]?dl|webrip|bluray|hdrip/i.test(String(v)));
    const isMultiAudio = audioLanguages.length > 1
        || downloadLanguages.includes('multi')
        || /multi|dual[-\s]?audio|multiaudio/i.test(listedQualities.join(' '));
    const isAnime = genres.some((v) => /\banime\b|\banimation\b/i.test(String(v)))
        || getCinemaCitySectionType(pageUrl) === 'anime';

    return {
        title: pageTitle,
        year: extractYear(pageTitle) || extractYear(body),
        imdbId,
        tmdbId,
        genres,
        audioLanguages,
        downloadLanguages,
        subtitleLanguages,
        listedResolutions,
        quality,
        qualityTag: qualityTag || '',
        isMultiAudio,
        isAnime
    };
}

async function fetchCinemaCityPageMetadata(pageUrl) {
    const normalizedUrl = normalizeRemoteUrl(pageUrl);
    if (!normalizedUrl) return null;

    const cached = pageMetadataCache.get(normalizedUrl);
    if (cached) return cached;

    return singleFlight(`metadata:${normalizedUrl}`, async () => {
        const existing = pageMetadataCache.get(normalizedUrl);
        if (existing) return existing;

        try {
            const html = await fetchHtml(normalizedUrl, {
                'Referer': `${BASE_URL}/`,
                'Cookie': getCinemaCitySessionCookie(),
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1'
            });
            const metadata = parseCinemaCityPageMetadata(html, normalizedUrl);
            pageMetadataCache.set(normalizedUrl, metadata);
            return metadata;
        } catch (_) {
            return null;
        }
    });
}

const LANGUAGE_ALIASES = {
    italian: ['italian', 'ita', 'it', 'italiano'],
    english: ['english', 'eng', 'en', 'inglese'],
    japanese: ['japanese', 'jpn', 'ja', 'giapponese'],
    multi: ['multi', 'multiaudio', 'multi audio', 'dual audio', 'dual-audio']
};

function normalizeLanguageToken(value) {
    const raw = decodeHtmlEntities(String(value || ''))
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!raw) return '';

    const tokens = raw.split(' ').filter(Boolean);
    const compact = raw.replace(/\s+/g, '');

    for (const [canonical, aliases] of Object.entries(LANGUAGE_ALIASES)) {
        if (aliases.some((alias) => {
            const cleanAlias = String(alias || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (!cleanAlias) return false;
            const aliasCompact = cleanAlias.replace(/\s+/g, '');
            if (raw === cleanAlias || compact === aliasCompact) return true;
            if (cleanAlias.length <= 3) return tokens.includes(cleanAlias);
            return tokens.includes(cleanAlias) || compact.includes(aliasCompact);
        })) {
            return canonical;
        }
    }

    return raw;
}

function normalizeLanguageList(values = []) {
    return uniqueStrings(
        (Array.isArray(values) ? values : [values])
            .flatMap((value) => String(value || '').split(/[,;/|]+/g))
            .map(normalizeLanguageToken)
            .filter(Boolean)
    );
}

function getWantedLanguage(config = {}) {
    const raw = String(
        config?.filters?.language
        || config?.language
        || config?.preferredLanguage
        || ''
    ).trim().toLowerCase();

    if (['ita', 'it', 'italian', 'italiano'].includes(raw)) return 'italian';
    if (['eng', 'en', 'english', 'inglese'].includes(raw)) return 'english';
    if (['jpn', 'ja', 'japanese', 'giapponese'].includes(raw)) return 'japanese';

    return raw || null;
}

function isStrictSingleLanguageMode(config = {}) {
    const wanted = getWantedLanguage(config);
    if (!wanted) return false;

    const raw = String(config?.filters?.language || config?.language || '').trim().toLowerCase();

    return (
        raw === 'ita'
        || raw === 'it'
        || raw === 'italian'
        || raw === 'italiano'
        || config?.filters?.strictLanguage === true
        || config?.strictLanguage === true
    );
}

function pageHasRequestedAudio(pageMetadata = {}, config = {}) {
    const wanted = getWantedLanguage(config);
    if (!wanted) return true;

    const strict = isStrictSingleLanguageMode(config);
    if (!strict) return true;

    const pageAudio = normalizeLanguageList(pageMetadata.audioLanguages || []);
    const downloadAudio = normalizeLanguageList(pageMetadata.downloadLanguages || []);
    const qualityTag = normalizeLanguageToken(pageMetadata.qualityTag || '');
    const pageHasWanted = pageAudio.includes(wanted);
    const pageHasMulti = pageAudio.includes('multi')
        || qualityTag === 'multi'
        || pageMetadata.isMultiAudio === true
        || /\bmulti\b|dual[-\s]?audio|multiaudio/i.test(String(pageMetadata.qualityTag || ''));
    const downloadHasWanted = downloadAudio.includes(wanted);
    const downloadHasMulti = downloadAudio.includes('multi');
    const pageOnlyEnglish = pageAudio.length === 1 && pageAudio[0] === 'english';
    const downloadOnlyEnglish = downloadAudio.length > 0 && downloadAudio.every((lang) => lang === 'english');

    if (wanted === 'italian') {
        if (pageHasWanted) return true;
        if (pageHasMulti && config?.filters?.allowMultiWhenItalianOnly === true) return true;

        if (pageAudio.length > 0) return false;

        if (downloadHasWanted) return true;
        if (downloadHasMulti && config?.filters?.allowMultiWhenItalianOnly === true) return true;
        if (downloadOnlyEnglish) return false;

        return false;
    }

    if (pageHasWanted || downloadHasWanted) return true;
    if (pageHasMulti || downloadHasMulti) return true;
    if (pageOnlyEnglish && wanted !== 'english') return false;

    return pageAudio.length === 0 && downloadAudio.length === 0;
}

function buildLanguageRejectReason(pageMetadata = {}, config = {}) {
    const wanted = getWantedLanguage(config) || 'unknown';
    const foundPage = normalizeLanguageList(pageMetadata.audioLanguages || []);
    const foundDownload = normalizeLanguageList(pageMetadata.downloadLanguages || []);
    return `[CinemaCity] Skip lingua: richiesta=${wanted}, pagina=${foundPage.join(',') || 'unknown'}, download=${foundDownload.join(',') || 'unknown'}, titolo=${pageMetadata.title || 'unknown'}`;
}

function streamUrlHasForbiddenLanguage(streamUrl = '', config = {}) {
    const wanted = getWantedLanguage(config);
    if (!wanted || !isStrictSingleLanguageMode(config)) return false;

    const text = decodeURIComponent(String(streamUrl || '')).replace(/[._-]+/g, ' ');
    const hasItalian = /(?:^|[^a-z0-9])(ita|it|italian|italiano)(?:[^a-z0-9]|$)/i.test(text);
    const hasEnglish = /(?:^|[^a-z0-9])(eng|en|english|inglese)(?:[^a-z0-9]|$)/i.test(text);
    const hasMulti = /(?:^|[^a-z0-9])(multi|multiaudio|dual audio|dual)(?:[^a-z0-9]|$)/i.test(text);

    if (wanted === 'italian') {
        return hasEnglish && !hasItalian && !hasMulti;
    }

    const normalized = normalizeLanguageToken(text);
    return hasEnglish && !normalized.includes(wanted);
}

function buildCinemaCityLanguageLabel(pageMetadata = {}, config = {}) {
    const languages = normalizeLanguageList(pageMetadata?.audioLanguages || []);
    const downloadLanguages = normalizeLanguageList(pageMetadata?.downloadLanguages || []);
    const wantsItalian = getWantedLanguage(config) === 'italian';

    const hasItalian = languages.includes('italian') || downloadLanguages.includes('italian');
    const hasEnglish = languages.includes('english') || downloadLanguages.includes('english');
    const hasMulti = languages.includes('multi') || downloadLanguages.includes('multi') || pageMetadata?.isMultiAudio === true;

    if (hasItalian && hasMulti) return '🇮🇹 ITA+MULTI';
    if (hasItalian) return '🇮🇹 ITA';

    if (wantsItalian && hasMulti && config?.filters?.allowMultiWhenItalianOnly === true) {
        return '🌍 MULTI';
    }

    if (hasEnglish && languages.length <= 1 && downloadLanguages.length <= 1) return '🇬🇧 ENG';
    if (hasMulti || languages.length > 1 || downloadLanguages.length > 1) return '🌍 MULTI';

    return '🌐 WEB';
}

function hardFilterStreamsByLanguage(streams = [], config = {}) {
    const wanted = getWantedLanguage(config);
    if (!wanted || !isStrictSingleLanguageMode(config)) return streams;

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

        return normalizeLanguageToken(text).includes(wanted);
    });
}

function collectMetaTitles(meta = {}) {
    return uniqueStrings([
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

function looksLikeAnimeMeta(meta = {}) {
    const directType = String(meta?.type || meta?.kind || meta?.mediaType || '').toLowerCase();
    if (/(^|[^a-z])(anime|animation)([^a-z]|$)/i.test(directType)) return true;
    const genres = Array.isArray(meta?.genres) ? meta.genres : [];
    if (genres.some((v) => /(anime|animation|animazione)/i.test(String(v)))) return true;
    const haystack = uniqueStrings([
        meta?.id, meta?.requestedId, meta?.originalId,
        meta?.kitsu_id, meta?.kitsuId,
        ...collectMetaTitles(meta)
    ]).join(' | ').toLowerCase();
    return /(anime-kitsu|kitsu:|\banime\b|\banimazione\b)/i.test(haystack);
}

function normalizeEpisodeNumber(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getExpectedYear(metadata = {}, meta = {}) {
    return extractYear(metadata?.release_date)
        || extractYear(metadata?.first_air_date)
        || extractYear(meta?.year)
        || extractYear(meta?.releaseInfo)
        || null;
}

function collectExpectedTitles(metadata = {}, meta = {}) {
    return Array.from(new Set([
        meta?.title, meta?.name, meta?.originalTitle, meta?.original_title,
        meta?.originalName, meta?.original_name,
        metadata?.title, metadata?.name, metadata?.original_title, metadata?.original_name
    ]
        .map((v) => decodeHtmlEntities(String(v || '')).trim())
        .filter(Boolean)));
}

function stripEpisodeDecorations(value) {
    return decodeHtmlEntities(value)
        .replace(/\b(?:season|stagione|episode|episodio|episodi|ep\.?)\s*\d+\b/gi, ' ')
        .replace(/\bS\s*\d+\s*E\s*\d+\b/gi, ' ')
        .replace(/\bS\s*\d+\b/gi, ' ')
        .replace(/\bE\s*\d+\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleAliasesFromOneTitle(title) {
    const cleaned = stripEpisodeDecorations(title);
    if (!cleaned) return [];

    const aliases = [cleaned];
    const slashParts = cleaned.split(/\s+[\\/|]\s+/g).map((v) => v.trim()).filter(Boolean);
    if (slashParts.length > 1) aliases.push(...slashParts);

    const akaParts = cleaned.split(/\s+(?:aka|a\.k\.a\.|also known as|conosciuto come)\s+/ig).map((v) => v.trim()).filter(Boolean);
    if (akaParts.length > 1) aliases.push(...akaParts);

    for (const part of [...aliases]) {
        const colon = part.split(/\s*[:：]\s+/g).map((v) => v.trim()).filter(Boolean);
        if (colon.length > 1) {
            aliases.push(colon[0]);
            aliases.push(colon.slice(1).join(' '));
        }
    }

    const ascii = cleaned.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (ascii !== cleaned) aliases.push(ascii);

    if (/\bone\s*piece\b/i.test(cleaned) || /\bwan\s*p[îi]?su\b/i.test(cleaned) || /\bwan\s*pi+su\b/i.test(ascii)) {
        aliases.push('One Piece');
        aliases.push('Wan Pisu');
        aliases.push('Wan piisu');
    }

    return uniqueStrings(aliases).filter((v) => v.length >= 2);
}

function buildSearchQueryVariants(titles = []) {
    const seen = new Set();
    const out = [];
    for (const title of uniqueStrings(titles)) {
        const aliases = titleAliasesFromOneTitle(title);
        for (const alias of aliases) {
            const normalized = kitsuProvider.normalizeTitle(alias);
            const compact = stripEpisodeDecorations(alias);
            const noYear = compact.replace(/\s*\((?:19|20)\d{2}.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
            for (const variant of uniqueStrings([alias, normalized, compact, noYear])) {
                const cleanVariant = String(variant || '').replace(/\s+/g, ' ').trim();
                if (!cleanVariant) continue;
                const key = normalizeTitle(cleanVariant);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(cleanVariant);
            }
        }
    }
    return out;
}

async function getNewsSitemapEntries() {
    const now = Date.now();
    if (Array.isArray(newsSitemapCache.entries) && (now - newsSitemapCache.fetchedAt) < NEWS_SITEMAP_TTL_MS) {
        return newsSitemapCache.entries;
    }

    return singleFlight('sitemap:news_pages', async () => {
        const current = Date.now();
        if (Array.isArray(newsSitemapCache.entries) && (current - newsSitemapCache.fetchedAt) < NEWS_SITEMAP_TTL_MS) {
            return newsSitemapCache.entries;
        }
        const xml = await fetchHtml(NEWS_SITEMAP_URL, {
            'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8',
            'Referer': `${BASE_URL}/`
        }, { timeout: 1800, attempts: 1 });
        const entries = extractSitemapLocs(xml).filter((url) => /^https:\/\/cinemacity\.cc\//i.test(url));
        if (entries.length === 0) return Array.isArray(newsSitemapCache.entries) ? newsSitemapCache.entries : [];
        newsSitemapCache.entries = entries;
        newsSitemapCache.fetchedAt = Date.now();
        return entries;
    });
}

async function getIdsFromKitsu(kitsuId, season, episode, config = {}) {
    if (!kitsuId) return null;

    const parsedEpisode = Number.parseInt(String(episode || ''), 10);
    const parsedSeason = Number.parseInt(String(season || ''), 10);
    const mappingLanguage = getMappingLanguage(config) || '';
    const cacheKey = `kitsu-map:${String(kitsuId).trim()}:${Number.isInteger(parsedSeason) ? parsedSeason : ''}:${Number.isInteger(parsedEpisode) ? parsedEpisode : '1'}:${mappingLanguage}`;
    const cached = kitsuMappingCache.get(cacheKey);
    if (cached) return cached.value;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = kitsuMappingCache.get(cacheKey);
        if (alreadyCached) return alreadyCached.value;

        try {
            const params = new URLSearchParams();
            params.set('ep', Number.isInteger(parsedEpisode) && parsedEpisode > 0 ? String(parsedEpisode) : '1');
            if (Number.isInteger(parsedSeason) && parsedSeason >= 0) params.set('s', String(parsedSeason));
            if (mappingLanguage) params.set('lang', mappingLanguage);

            const payload = await fetchJson(`${MAPPING_API_BASE}/kitsu/${encodeURIComponent(String(kitsuId).trim())}?${params.toString()}`);
            const ids = payload?.mappings?.ids || {};
            const tmdbEpisode = payload?.mappings?.tmdb_episode || payload?.mappings?.tmdbEpisode
                || payload?.tmdb_episode || payload?.tmdbEpisode || null;

            const mappedSeason = Number.parseInt(String(
                tmdbEpisode?.season || tmdbEpisode?.seasonNumber || tmdbEpisode?.season_number || ''
            ), 10);
            const mappedEpisode = Number.parseInt(String(
                tmdbEpisode?.episode || tmdbEpisode?.episodeNumber || tmdbEpisode?.episode_number || ''
            ), 10);
            const rawEpisodeNumber = Number.parseInt(String(
                tmdbEpisode?.rawEpisodeNumber || tmdbEpisode?.raw_episode_number || tmdbEpisode?.rawEpisode || ''
            ), 10);

            const result = {
                imdbId: extractImdbId(ids.imdb),
                tmdbId: extractTmdbId(ids.tmdb),
                mappedSeason: Number.isInteger(mappedSeason) && mappedSeason > 0 ? mappedSeason : null,
                mappedEpisode: Number.isInteger(mappedEpisode) && mappedEpisode > 0 ? mappedEpisode : null,
                rawEpisodeNumber: Number.isInteger(rawEpisodeNumber) && rawEpisodeNumber > 0 ? rawEpisodeNumber : null
            };
            kitsuMappingCache.set(cacheKey, { value: result });
            return result;
        } catch (error) {
            console.error('[CinemaCity] Kitsu mapping error:', error.message);
            kitsuMappingCache.set(cacheKey, { value: null });
            return null;
        }
    });
}

async function getTmdbMetadata(id, providerType) {
    const normalizedId = String(id || '').trim();
    const normalizedType = providerType === 'movie' ? 'movie' : 'tv';
    if (!normalizedId) return null;

    const cacheKey = `tmdb-meta:${normalizedType}:${normalizedId}`;
    const cached = tmdbMetadataCache.get(cacheKey);
    if (cached) return cached.value;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = tmdbMetadataCache.get(cacheKey);
        if (alreadyCached) return alreadyCached.value;

        try {
            let result = null;
            if (extractImdbId(normalizedId)) {
                const payload = await tmdbHelper.fetchTmdbJson(`/find/${encodeURIComponent(normalizedId)}`, {
                    params: { external_source: 'imdb_id', language: 'en-US' }
                });
                const results = normalizedType === 'movie' ? payload?.movie_results : payload?.tv_results;
                result = Array.isArray(results) && results.length > 0 ? results[0] : null;
            } else {
                const cleanTmdbId = extractTmdbId(normalizedId);
                if (cleanTmdbId) {
                    result = await tmdbHelper.fetchTmdbJson(`/${normalizedType}/${cleanTmdbId}`, {
                        params: { language: 'en-US' }
                    });
                }
            }
            tmdbMetadataCache.set(cacheKey, { value: result });
            return result;
        } catch (error) {
            console.error('[CinemaCity] TMDB metadata error:', error.message);
            tmdbMetadataCache.set(cacheKey, { value: null });
            return null;
        }
    });
}

async function resolveImdbFromTmdb(tmdbId, providerType) {
    const cleanTmdbId = extractTmdbId(tmdbId);
    if (!cleanTmdbId) return null;

    const normalizedType = providerType === 'movie' ? 'movie' : 'tv';
    const cacheKey = `tmdb-imdb:${normalizedType}:${cleanTmdbId}`;
    const cached = tmdbImdbCache.get(cacheKey);
    if (cached) return cached.value;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = tmdbImdbCache.get(cacheKey);
        if (alreadyCached) return alreadyCached.value;

        try {
            const result = extractImdbId(await tmdbHelper.getImdbFromTmdb(cleanTmdbId, normalizedType));
            tmdbImdbCache.set(cacheKey, { value: result });
            return result;
        } catch (error) {
            console.error('[CinemaCity] TMDB→IMDb resolution error:', error.message);
            tmdbImdbCache.set(cacheKey, { value: null });
            return null;
        }
    });
}

function extractCandidateLinksFromListing(html, sectionType) {
    const $ = loadHtml(html);
    const results = [];

    $('a[href]').each((_, anchor) => {
        const href = String($(anchor).attr('href') || '').trim();
        if (!href) return;
        const absoluteUrl = resolveUrl(BASE_URL, href);
        if (!absoluteUrl || !/\.html(?:$|[?#])/i.test(absoluteUrl)) return;
        if (!/^https?:\/\/cinemacity\.cc\//i.test(absoluteUrl)) return;
        if (!isCinemaCityContentUrlForType(absoluteUrl, sectionType)) return;

        const title = decodeHtmlEntities(
            $(anchor).attr('title') || $(anchor).text() || titleFromContentUrl(absoluteUrl)
        ).replace(/\s+/g, ' ').trim();
        if (!title) return;
        results.push({ url: absoluteUrl, title });
    });

    return Array.from(new Map(results.map((item) => [item.url, item])).values());
}

function scoreTitleMatch(candidateTitle, expectedTitles) {
    const normalizedCandidate = normalizeTitle(candidateTitle);
    if (!normalizedCandidate) return 0;
    let best = 0;
    for (const title of expectedTitles) {
        const normalizedExpected = normalizeTitle(title);
        if (!normalizedExpected) continue;
        if (normalizedCandidate === normalizedExpected) return 100;
        if (normalizedCandidate.includes(normalizedExpected) || normalizedExpected.includes(normalizedCandidate)) {
            best = Math.max(best, 80);
        } else if (
            normalizedExpected.length > 5 && normalizedCandidate.length > 5
            && (normalizedCandidate.startsWith(normalizedExpected) || normalizedExpected.startsWith(normalizedCandidate))
        ) {
            best = Math.max(best, 60);
        }
    }
    return best;
}

function scoreCandidateEntry(candidate, expectedTitles, expectedYear, providerType) {
    if (!candidate?.url) return 0;
    const title = candidate.title || titleFromContentUrl(candidate.url);
    let score = scoreTitleMatch(title, expectedTitles);
    if (score <= 0) return 0;
    score += getCinemaCityTypeBoost(candidate.url, providerType);
    const candidateYear = extractYear(title) || extractYear(candidate.url);
    if (expectedYear && candidateYear) {
        if (candidateYear === expectedYear) score += 15;
        else if (Math.abs(candidateYear - expectedYear) === 1) score += 5;
        else score -= 20;
    }
    return score;
}

function extractSearchCandidates(html) {
    const body = String(html || '');
    if (/site search yielded no results|ricerca non ha prodotto risultati/i.test(body)) return [];

    const $ = loadHtml(body);
    const roots = $('#dle-content').length ? $('#dle-content') : $('body');
    const results = [];

    roots.find('a[href]').each((_, anchor) => {
        const href = String($(anchor).attr('href') || '').trim();
        if (!href) return;
        const absoluteUrl = resolveUrl(BASE_URL, href);
        if (!absoluteUrl) return;
        if (!/^https?:\/\/cinemacity\.cc\/(?:movies|anime|series|tv-series)\/\d+-[^?#]+\.html(?:$|[?#])/i.test(absoluteUrl)) return;

        const title = decodeHtmlEntities(
            $(anchor).attr('title') || $(anchor).text() || titleFromContentUrl(absoluteUrl)
        ).replace(/\s+/g, ' ').trim();
        if (!title) return;
        results.push({ url: absoluteUrl, title });
    });

    return Array.from(new Map(results.map((item) => [item.url, item])).values());
}

async function verifyCandidateImdb(candidateUrl, expectedImdbId) {
    const normalizedExpected = extractImdbId(expectedImdbId);
    if (!normalizedExpected) return null;
    try {
        const pageMetadata = await fetchCinemaCityPageMetadata(candidateUrl);
        return pageMetadata?.imdbId || null;
    } catch (_) {
        return null;
    }
}

async function pickBestCandidate(candidates, expectedTitles, { requestedImdbId = null, expectedYear = null, providerType = 'tv', fastMode = false } = {}) {
    const scoredCandidates = (candidates || [])
        .map((c) => ({ ...c, score: scoreCandidateEntry(c, expectedTitles, expectedYear, providerType) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scoredCandidates.length === 0) return null;

    if (fastMode === true && scoredCandidates[0]?.score >= 80) {
        return scoredCandidates[0];
    }

    const normalizedRequestedImdbId = extractImdbId(requestedImdbId);
    if (normalizedRequestedImdbId) {
        const candidatesToCheck = scoredCandidates.slice(0, 6).filter(c => c.score >= 80);
        const imdbResults = await Promise.all(
            candidatesToCheck.map(c => verifyCandidateImdb(c.url, normalizedRequestedImdbId))
        );
        const mismatchedUrls = new Set();
        candidatesToCheck.forEach((c, i) => {
            if (imdbResults[i] && imdbResults[i] !== normalizedRequestedImdbId) mismatchedUrls.add(c.url);
        });
        const firstMatch = candidatesToCheck.find((_, i) => imdbResults[i] === normalizedRequestedImdbId);
        if (firstMatch) return firstMatch;
        return scoredCandidates.find((c) => c.score >= 80 && !mismatchedUrls.has(c.url)) || null;
    }

    if (providerType === 'anime') {
        const enriched = [];
        for (const candidate of scoredCandidates.slice(0, 6)) {
            const pageMetadata = await fetchCinemaCityPageMetadata(candidate.url);
            let score = candidate.score;
            if (pageMetadata?.isAnime) score += 35;
            else if (pageMetadata) score -= 10;
            if (pageMetadata?.title) {
                const pageTitleScore = scoreTitleMatch(pageMetadata.title, expectedTitles);
                if (pageTitleScore >= 80) score += 12;
                else if (pageTitleScore === 0) score -= 10;
            }
            if (expectedYear && pageMetadata?.year) {
                if (pageMetadata.year === expectedYear) score += 12;
                else if (Math.abs(pageMetadata.year - expectedYear) === 1) score += 4;
                else score -= 15;
            }
            enriched.push({ ...candidate, pageMetadata, score });
        }
        const bestAnime = [...enriched, ...scoredCandidates.slice(6)].sort((a, b) => b.score - a.score)[0];
        return bestAnime?.score >= 80 ? bestAnime : null;
    }

    return scoredCandidates[0]?.score >= 80 ? scoredCandidates[0] : null;
}

async function fetchSearchCandidates(query) {
    const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();
    if (!cleanQuery) return [];

    const cacheKey = `search:${cleanQuery.toLowerCase()}`;
    const cached = searchCandidatesCache.get(cacheKey);
    if (cached) return cached.value;

    return singleFlight(cacheKey, async () => {
        const alreadyCached = searchCandidatesCache.get(cacheKey);
        if (alreadyCached) return alreadyCached.value;

        const searchGetUrl = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(cleanQuery)}`;
        const searchCommonHeaders = {
            'Referer': `${BASE_URL}/`,
            'Cookie': getCinemaCitySessionCookie(),
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'navigate'
        };

        const tryParse = (html) => {
            const candidates = extractSearchCandidates(html);
            if (candidates.length > 0) {
                searchCandidatesCache.set(cacheKey, { value: candidates });
                return candidates;
            }
            return null;
        };

        let networkFailed = true;

        try {
            const html = await fetchHtml(searchGetUrl, searchCommonHeaders);
            if (html) {
                networkFailed = false;
                const result = tryParse(html);
                if (result) return result;
            }
        } catch (_) {}

        const formBody = new URLSearchParams({
            do: 'search',
            subaction: 'search',
            story: cleanQuery
        }).toString();

        try {
            const postHtml = await fetchHtmlPostWithGot(`${BASE_URL}/index.php`, formBody, {
                'Cookie': getCinemaCitySessionCookie(),
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'navigate'
            });
            if (postHtml) {
                networkFailed = false;
                const result = tryParse(postHtml);
                if (result) return result;
            }
        } catch (_) {}

        if (!networkFailed) {
            searchCandidatesCache.set(cacheKey, { value: [] });
        }
        return [];
    });
}

async function searchByTitleQueries(queryTitles, providerType, expectedTitles, requestedImdbId, expectedYear) {
    const queries = buildSearchQueryVariants(queryTitles).slice(0, providerType === 'anime' ? 10 : 6);
    if (queries.length === 0) return null;

    const collected = [];
    const seen = new Set();
    const BATCH_SIZE = 3;

    for (let i = 0; i < queries.length; i += BATCH_SIZE) {
        const batch = queries.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map((q) => fetchSearchCandidates(q)));

        for (const candidates of batchResults) {
            for (const candidate of candidates) {
                if (!candidate?.url || seen.has(candidate.url)) continue;
                seen.add(candidate.url);
                collected.push(candidate);
            }
        }

        const interim = await pickBestCandidate(collected, expectedTitles, { requestedImdbId, expectedYear, providerType, fastMode: true });
        if (interim?.score >= 100) return interim;
    }

    return pickBestCandidate(collected, expectedTitles, { requestedImdbId, expectedYear, providerType, fastMode: true });
}

async function searchSitemapCandidates(providerType, expectedTitles, { requestedImdbId = null, expectedYear = null, fastMode = true } = {}) {
    try {
        const sitemapEntries = await getNewsSitemapEntries();
        const sitemapCandidates = sitemapEntries
            .filter((url) => isCinemaCityContentUrlForType(url, providerType))
            .map((url) => ({ url, title: titleFromContentUrl(url) }))
            .filter((c) => scoreTitleMatch(c.title, expectedTitles) > 0);

        return pickBestCandidate(sitemapCandidates, expectedTitles, {
            requestedImdbId, expectedYear, providerType, fastMode
        });
    } catch (_) {
        return null;
    }
}

async function searchByImdb(imdbId) {
    const normalizedImdbId = extractImdbId(imdbId);
    if (!normalizedImdbId) return null;

    let result = (await fetchSearchCandidates(normalizedImdbId))[0] || null;
    if (result) return result;

    const numericId = normalizedImdbId.replace(/\D/g, '');
    if (numericId && numericId !== normalizedImdbId) {
        result = (await fetchSearchCandidates(numericId))[0] || null;
    }
    return result;
}

function getListingBaseUrls(providerType) {
    if (providerType === 'movie') return [`${BASE_URL}/movies/`];
    if (providerType === 'anime') return [`${BASE_URL}/anime/`, `${BASE_URL}/tv-series/`];
    return [`${BASE_URL}/tv-series/`, `${BASE_URL}/anime/`];
}

async function searchByTitleFallback(id, providerType, meta = {}, options = {}) {
    const tmdbType = providerType === 'movie' ? 'movie' : 'tv';
    const metadata = options?.metadata || await getTmdbMetadata(id, tmdbType);
    const expectedTitles = uniqueStrings([
        ...(Array.isArray(options?.expectedTitles) ? options.expectedTitles : []),
        ...collectExpectedTitles(metadata, meta)
    ]);

    if (expectedTitles.length === 0) return null;

    const requestedImdbId = extractImdbId(options?.requestedImdbId || id);
    const expectedYear = options?.expectedYear || getExpectedYear(metadata, meta);
    const fastMode = options?.fast !== false;
    const cacheKey = `resolve:${providerType}:${requestedImdbId || ''}:${extractTmdbId(id) || ''}:${expectedYear || ''}:${fastMode ? 'fast' : 'deep'}:${buildSearchQueryVariants(expectedTitles).slice(0, 10).map(normalizeTitle).join('|')}`;
    const cached = resolvedSearchCache.get(cacheKey);
    if (cached) return cached.value;

    const saveResult = (value) => {
        resolvedSearchCache.set(cacheKey, { value: value || null });
        return value || null;
    };

    const bestSitemap = await searchSitemapCandidates(providerType, expectedTitles, {
        requestedImdbId, expectedYear, fastMode
    });
    if (bestSitemap?.url) return saveResult(bestSitemap);

    if (fastMode) {
        return saveResult(null);
    }

    const searched = await searchByTitleQueries(expectedTitles, providerType, expectedTitles, requestedImdbId, expectedYear);
    if (searched?.url) return saveResult(searched);

    let bestResult = null;
    let bestScore = 0;
    const PAGE_CONCURRENCY = 3;

    for (const listingBase of getListingBaseUrls(providerType)) {
        const pageNums = Array.from({ length: MAX_LISTING_PAGES }, (_, i) => i + 1);

        for (let i = 0; i < pageNums.length; i += PAGE_CONCURRENCY) {
            const pageBatch = pageNums.slice(i, i + PAGE_CONCURRENCY);

            const batchResults = await Promise.all(pageBatch.map(async (page) => {
                const pageUrl = page === 1 ? listingBase : `${listingBase}page/${page}/`;
                try {
                    const html = await fetchHtml(pageUrl, {
                        'Referer': `${BASE_URL}/`,
                        'Sec-Fetch-Site': 'same-origin',
                        'Sec-Fetch-Mode': 'navigate'
                    }, { timeout: 2000 });
                    const candidates = extractCandidateLinksFromListing(html, providerType);
                    if (candidates.length === 0) return null;
                    return candidates.slice(0, MAX_LISTING_CANDIDATES_PER_PAGE);
                } catch (_) {
                    return null;
                }
            }));

            let batchExhausted = true;
            for (const candidates of batchResults) {
                if (!candidates) continue;
                batchExhausted = false;
                const picked = await pickBestCandidate(candidates, expectedTitles, { requestedImdbId, expectedYear, providerType, fastMode });
                if (picked?.score > bestScore) {
                    bestScore = picked.score;
                    bestResult = picked;
                }
            }

            if (bestScore >= 100) return saveResult(bestResult);
            if (batchExhausted) break;
        }

        if (bestScore >= 100) break;
    }

    return saveResult(bestScore >= 80 ? bestResult : null);
}

function getIdCandidates(meta = {}, originalId, finalId) {
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
        meta?.kitsu_id ? 'kitsu:' + meta.kitsu_id : null,
        meta?.kitsuId ? 'kitsu:' + meta.kitsuId : null,
        meta?.kitsu ? (/^\d+$/.test(String(meta.kitsu).trim()) ? 'kitsu:' + meta.kitsu : meta.kitsu) : null
    ].filter(Boolean);
}

function getKitsuIdCandidates(meta = {}, originalId, finalId) {
    const taggedCandidates = [
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

    const dedicated = [meta?.kitsu_id, meta?.kitsuId, meta?.kitsu].map((value) => {
        const text = String(value || '').trim();
        if (!text) return null;
        return /^\d+$/.test(text) ? 'kitsu:' + text : text;
    });

    return [...taggedCandidates, ...dedicated].filter(Boolean);
}

function canTryCinemaCityAnimeMapping(meta = {}) {
    if (!meta || meta?.isSeries === false || String(meta?.type || '').toLowerCase() === 'movie') return false;
    if (meta?.kitsu_id || meta?.kitsuId || meta?.kitsu) return true;
    if (meta?.tmdbAnimeCandidate === true) return true;
    if (meta?.isAnime === true && (meta?.tmdb_id || meta?.tmdbId || meta?.imdb_id || meta?.imdbId)) return true;
    return false;
}

async function buildAnimeSearchContext(meta = {}, originalId, finalId, config = {}, season = null, episode = null) {
    const candidateIds = getKitsuIdCandidates(meta, originalId, finalId);
    let kitsuToken = null;

    for (const candidate of candidateIds) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) {
            kitsuToken = /^\d+$/.test(String(candidate || '').trim()) ? 'kitsu:' + candidate : String(candidate);
            break;
        }
    }

    if (kitsuToken) {
        try {
            const context = await kitsuProvider.buildSearchContext(kitsuToken, meta);
            if (context?.kitsuId) {
                return {
                    ...context,
                    searchTitles: buildSearchQueryVariants([
                        ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
                        ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                        ...collectMetaTitles(meta)
                    ]),
                    rawTitles: uniqueStrings([
                        ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                        ...collectMetaTitles(meta)
                    ]),
                    strictKitsu: true
                };
            }
        } catch (_) {}
    }

    if (!canTryCinemaCityAnimeMapping(meta)) return null;

    try {
        const safeSeason = Number.parseInt(String(season || meta?.season || 1), 10) || 1;
        const safeEpisode = Number.parseInt(String(episode || meta?.episode || 1), 10) || 1;
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
            mappingTimeoutMs: FETCH_TIMEOUT,
            kitsuTimeoutMs: 1400,
            debug: false
        });

        if (!context?.kitsuId) return null;

        return {
            ...context,
            searchTitles: buildSearchQueryVariants([
                ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
                ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                ...collectMetaTitles(meta)
            ]),
            rawTitles: uniqueStrings([
                ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
                ...collectMetaTitles(meta)
            ]),
            strictKitsu: false,
            mappedKitsu: true
        };
    } catch (_) {}

    return null;
}

async function resolveSearchState(meta = {}, originalId, finalId, config = {}) {
    const isSeries = Boolean(meta?.isSeries);
    const fallbackSeason = Number.parseInt(String(meta?.season || ''), 10) || 1;
    const fallbackEpisode = Number.parseInt(String(meta?.episode || ''), 10) || 1;
    const candidateIds = getIdCandidates(meta, originalId, finalId);
    const parsedRequest = parseCompositeSeriesId(candidateIds[0] || '', fallbackSeason, fallbackEpisode);

    let workingId = parsedRequest.normalizedId;
    let season = parsedRequest.season;
    let episode = parsedRequest.episode;
    let providerType = isSeries ? 'tv' : 'movie';

    const contextImdbId = candidateIds.map(extractImdbId).find(Boolean) || null;
    const contextTmdbId = candidateIds.map(extractTmdbId).find(Boolean) || null;
    const explicitKitsuCandidates = [
        meta?.kitsu_id,
        meta?.kitsuId,
        ...candidateIds.filter((id) => /^kitsu:/i.test(String(id || '').trim()))
    ];
    const explicitKitsuId = explicitKitsuCandidates.map(extractKitsuId).find(Boolean) || null;
    const contextKitsuId = explicitKitsuId || null;
    let resolvedTmdbId = contextTmdbId || extractTmdbId(workingId) || null;
    let rawEpisodeNumber = null;
    let episodeCandidates = numberCandidates([episode]);
    let animeContext = null;

    if (!workingId) {
        workingId = contextImdbId || contextTmdbId || (contextKitsuId ? `kitsu:${contextKitsuId}` : '');
    }

    const allowAnimeBridge = isSeries && String(meta?.type || '').toLowerCase() !== 'movie';

    const canTryAnime = allowAnimeBridge && Boolean(
        contextKitsuId
        || candidateIds.some((id) => /^kitsu:/i.test(String(id || '').trim()))
        || meta?.tmdbAnimeCandidate === true
        || (meta?.isAnime === true && (contextImdbId || contextTmdbId || meta?.tmdb_id || meta?.imdb_id))
    );
    if (canTryAnime) {
        animeContext = await buildAnimeSearchContext(meta, originalId, finalId, config, season, episode);
        if (animeContext?.kitsuId) {
            if (animeContext?.seasonNumber) season = animeContext.seasonNumber;
            if (animeContext?.requestedEpisode) episode = animeContext.requestedEpisode;
            providerType = 'anime';
        }
    }

    const applyMappedIds = (mapped) => {
        if (!mapped) return false;
        if (mapped.tmdbId) resolvedTmdbId = mapped.tmdbId;
        if (mapped.imdbId) workingId = mapped.imdbId;
        else if (mapped.tmdbId && !extractImdbId(workingId)) workingId = mapped.tmdbId;
        if (mapped.rawEpisodeNumber) rawEpisodeNumber = mapped.rawEpisodeNumber;
        if (mapped.mappedEpisode) episodeCandidates = numberCandidates([mapped.mappedEpisode, episode, rawEpisodeNumber]);
        if (mapped.mappedSeason && mapped.mappedEpisode) {
            season = mapped.mappedSeason;
            episode = mapped.mappedEpisode;
        } else if (mapped.rawEpisodeNumber) {
            episode = mapped.rawEpisodeNumber;
            episodeCandidates = numberCandidates([rawEpisodeNumber, episode]);
        }
        episodeCandidates = numberCandidates([episode, ...(episodeCandidates || []), rawEpisodeNumber]);
        return Boolean(mapped.imdbId || mapped.tmdbId || mapped.mappedSeason || mapped.mappedEpisode || mapped.rawEpisodeNumber);
    };

    const mappedFromSharedContext = animeContext?.mappedIds || null;
    const sharedApplied = applyMappedIds(mappedFromSharedContext);

    if (!sharedApplied && (String(workingId || '').startsWith('kitsu:') || contextKitsuId)) {
        const kitsuId = contextKitsuId || extractKitsuId(workingId);
        const mapped = await getIdsFromKitsu(kitsuId, isSeries ? season : null, isSeries ? episode : 1, config);
        applyMappedIds(mapped);
    }

    if (!extractImdbId(workingId) && contextImdbId) {
        workingId = contextImdbId;
    } else if (!extractTmdbId(workingId) && contextTmdbId) {
        workingId = contextTmdbId;
    }

    if (!extractImdbId(workingId)) {
        const tmdbId = extractTmdbId(workingId) || resolvedTmdbId || contextTmdbId;
        const resolvedImdbId = await resolveImdbFromTmdb(tmdbId, providerType === 'movie' ? 'movie' : 'tv');
        if (resolvedImdbId) workingId = resolvedImdbId;
    }

    return {
        imdbId: extractImdbId(workingId),
        tmdbId: extractTmdbId(workingId) || resolvedTmdbId || contextTmdbId || null,
        isAnime: providerType === 'anime',
        searchTitles: Array.isArray(animeContext?.searchTitles) ? animeContext.searchTitles : [],
        rawTitles: Array.isArray(animeContext?.rawTitles) ? animeContext.rawTitles : [],
        expectedYear: animeContext?.year || extractYear(meta?.year || meta?.releaseInfo || ''),
        season,
        episode,
        rawEpisodeNumber,
        episodeCandidates,
        providerType
    };
}

function parseCompositeSeriesId(rawId, season, episode) {
    const parsed = {
        normalizedId: String(rawId || '').trim(),
        season: Number.isInteger(season) ? season : (Number.parseInt(season, 10) || 1),
        episode: Number.isInteger(episode) ? episode : (Number.parseInt(episode, 10) || 1)
    };

    const kitsuSeasonEpMatch = parsed.normalizedId.match(/^kitsu:(\d+):(\d+):(\d+)$/i);
    if (kitsuSeasonEpMatch) {
        parsed.normalizedId = `kitsu:${kitsuSeasonEpMatch[1]}`;
        parsed.season = Number.parseInt(kitsuSeasonEpMatch[2], 10) || parsed.season;
        parsed.episode = Number.parseInt(kitsuSeasonEpMatch[3], 10) || parsed.episode;
        return parsed;
    }

    const kitsuEpMatch = parsed.normalizedId.match(/^kitsu:(\d+):(\d+)$/i);
    if (kitsuEpMatch) {
        parsed.normalizedId = `kitsu:${kitsuEpMatch[1]}`;
        parsed.season = 1;
        parsed.episode = Number.parseInt(kitsuEpMatch[2], 10) || parsed.episode;
        return parsed;
    }

    const match = parsed.normalizedId.match(/^(tt\d+|\d+|tmdb:\d+):(\d+):(\d+)$/i);
    if (!match) return parsed;
    parsed.normalizedId = match[1];
    parsed.season = Number.parseInt(match[2], 10) || parsed.season;
    parsed.episode = Number.parseInt(match[3], 10) || parsed.episode;
    return parsed;
}

function numberCandidates(values = []) {
    const seen = new Set();
    const out = [];
    for (const value of Array.isArray(values) ? values : [values]) {
        const parsed = normalizeEpisodeNumber(value);
        if (!parsed || seen.has(parsed)) continue;
        seen.add(parsed);
        out.push(parsed);
    }
    return out;
}

function extractSeasonNumberFromTitle(title) {
    const match = String(title || '').match(/(?:season|stagione)\s*0*(\d+)\b|(?:^|\b)s\s*0*(\d+)\b/i);
    const value = Number.parseInt(String(match?.[1] || match?.[2] || ''), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
}

function extractEpisodeNumberFromTitle(title) {
    const text = String(title || '');

    let match = text.match(/\bS\d{1,2}E0*(\d{1,4})\b/i);
    if (match) return Number.parseInt(match[1], 10) || null;

    match = text.match(/\b\d{1,2}x0*(\d{1,4})\b/i);
    if (match) return Number.parseInt(match[1], 10) || null;

    match = text.match(/(?:episode|episodio|ep\.?)\s*0*(\d{1,4})\b/i);
    if (match) return Number.parseInt(match[1], 10) || null;

    match = text.match(/(?:^|[^a-z0-9])E0*(\d{1,4})(?:[^a-z0-9]|$)/i);
    if (match) return Number.parseInt(match[1], 10) || null;

    match = text.match(/^\s*0*(\d{1,4})\s*[-–.]/);
    if (match) return Number.parseInt(match[1], 10) || null;

    return null;
}

function pickEpisodeFromFolder(folder = [], episodeCandidates = []) {
    const episodeEntries = folder
        .filter((e) => e && typeof e === 'object' && e.file)
        .map((e, index) => ({ entry: e, index, episodeNumber: extractEpisodeNumberFromTitle(e.title) }));

    if (episodeEntries.length === 0) return null;

    for (const wantedEpisode of episodeCandidates) {
        const exactEpisodeMatch = episodeEntries.find((e) => e.episodeNumber === wantedEpisode);
        if (exactEpisodeMatch?.entry?.file) return exactEpisodeMatch.entry.file;
    }

    const hasExplicitEpisodeNumbers = episodeEntries.some((e) => Number.isInteger(e.episodeNumber));
    if (hasExplicitEpisodeNumbers) return null;

    for (const wantedEpisode of episodeCandidates) {
        const byIndex = episodeEntries[wantedEpisode - 1]?.entry?.file || null;
        if (byIndex) return byIndex;
    }

    return null;
}

function flattenSeasonEpisodes(seasonEntries = []) {
    const flat = [];
    for (const seasonEntry of seasonEntries) {
        for (const item of seasonEntry?.entry?.folder || []) {
            if (item && typeof item === 'object' && item.file) flat.push(item);
        }
    }
    return flat;
}

function pickStream(fileData, type, season = 1, episode = 1, options = {}) {
    if (typeof fileData === 'string') return fileData;

    const episodeCandidates = numberCandidates([
        episode,
        ...(Array.isArray(options?.episodeCandidates) ? options.episodeCandidates : []),
        options?.rawEpisodeNumber
    ]);
    const seasonCandidates = numberCandidates([
        season,
        ...(Array.isArray(options?.seasonCandidates) ? options.seasonCandidates : []),
        1
    ]);

    if (Array.isArray(fileData)) {
        if (
            type === 'movie'
            || fileData.every((e) => e && typeof e === 'object' && 'file' in e && !('folder' in e))
        ) {
            if (type === 'movie') return fileData[0]?.file || null;
            return pickEpisodeFromFolder(fileData, episodeCandidates.length ? episodeCandidates : [1]) || fileData[0]?.file || null;
        }

        const seasonEntries = fileData
            .filter((e) => e && typeof e === 'object' && Array.isArray(e.folder))
            .map((e, index) => ({ entry: e, index, seasonNumber: extractSeasonNumberFromTitle(e.title) }));

        if (seasonEntries.length === 0) return null;

        const selectedSeasonEntries = [];
        for (const wantedSeason of seasonCandidates) {
            const exactSeasonMatch = seasonEntries.find((e) => e.seasonNumber === wantedSeason);
            if (exactSeasonMatch) selectedSeasonEntries.push(exactSeasonMatch);
        }

        const hasExplicitSeasonNumbers = seasonEntries.some((e) => Number.isInteger(e.seasonNumber));
        if (selectedSeasonEntries.length === 0 && !hasExplicitSeasonNumbers) {
            for (const wantedSeason of seasonCandidates) {
                const byIndex = seasonEntries[wantedSeason - 1] || null;
                if (byIndex) selectedSeasonEntries.push(byIndex);
            }
        }

        if (options?.looseAnime === true) {
            for (const seasonEntry of seasonEntries) {
                if (!selectedSeasonEntries.includes(seasonEntry)) selectedSeasonEntries.push(seasonEntry);
            }
        }

        for (const seasonEntry of selectedSeasonEntries) {
            const picked = pickEpisodeFromFolder(seasonEntry.entry.folder, episodeCandidates.length ? episodeCandidates : [1]);
            if (picked) return picked;
        }

        const rawEpisodeNumber = normalizeEpisodeNumber(options?.rawEpisodeNumber);
        if (rawEpisodeNumber && options?.looseAnime === true) {
            const flat = flattenSeasonEpisodes(seasonEntries);
            const byAbsoluteIndex = flat[rawEpisodeNumber - 1]?.file || null;
            if (byAbsoluteIndex) return byAbsoluteIndex;
        }
    }
    return null;
}

function extractJsonArray(decoded) {
    let start = decoded.indexOf('file:');
    if (start === -1) start = decoded.indexOf('sources:');
    if (start === -1) return null;
    start = decoded.indexOf('[', start);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < decoded.length; i += 1) {
        if (decoded[i] === '[') depth += 1;
        else if (decoded[i] === ']') depth -= 1;
        if (depth === 0) return decoded.substring(start, i + 1);
    }
    return null;
}

function resolveUrl(baseUrl, relativeOrAbsoluteUrl) {
    if (!relativeOrAbsoluteUrl) return null;
    try { return new URL(relativeOrAbsoluteUrl, baseUrl).toString(); } catch (_) { return relativeOrAbsoluteUrl; }
}

function getOrigin(url) {
    try { return new URL(url).origin; } catch (_) { return BASE_URL; }
}

function extractPlayerReferer(html, pageUrl) {
    const $ = loadHtml(html);
    const src = $('iframe[src*="player.php"]').first().attr('src') || '';
    return src ? resolveUrl(pageUrl, src) : pageUrl;
}

async function parseCinemaCityStream(pageUrl, meta = {}) {
    const html = await fetchHtml(pageUrl, {
        'Referer': `${BASE_URL}/`,
        'Cookie': getCinemaCitySessionCookie(),
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1'
    }, { timeout: 2500, attempts: 1 });

    const pageMetadata = parseCinemaCityPageMetadata(html, pageUrl);
    pageMetadataCache.set(normalizeRemoteUrl(pageUrl), pageMetadata);
    const playerReferer = extractPlayerReferer(html, pageUrl);

    const atobRegex = /atob\s*\(\s*['"](.*?)['"]\s*\)/gi;
    let match;
    let fileData = null;

    while ((match = atobRegex.exec(html)) !== null) {
        const encoded = match[1];
        if (!encoded || encoded.length < 50) continue;
        let decoded = '';
        try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch (_) { continue; }
        if (!decoded) continue;

        if (decoded.trim().startsWith('[')) {
            try { fileData = JSON.parse(decoded); } catch (_) {}
        }
        if (!fileData) {
            const rawJson = extractJsonArray(decoded);
            if (rawJson) {
                try { fileData = JSON.parse(rawJson.replace(/\\(.)/g, '$1')); }
                catch (_) { try { fileData = JSON.parse(rawJson); } catch (_) {} }
            }
        }
        if (!fileData) {
            const fileMatch = decoded.match(/(?:file|sources)\s*:\s*['"](.*?)['"]/i);
            if (fileMatch && (fileMatch[1].includes('.m3u8') || fileMatch[1].includes('.mp4'))) {
                fileData = fileMatch[1];
            }
        }
        if (fileData) break;
    }

    const streamUrl = resolveUrl(
        pageUrl,
        pickStream(fileData, meta?.isSeries ? 'tv' : 'movie', meta?.season || 1, meta?.episode || 1, {
            rawEpisodeNumber: meta?.rawEpisodeNumber,
            episodeCandidates: Array.isArray(meta?.episodeCandidates) ? meta.episodeCandidates : [],
            looseAnime: meta?.providerType === 'anime' || meta?.isAnime === true
        })
    );
    if (!streamUrl) return null;

    const activeFp = getRandomFingerprint();
    return {
        streamUrl,
        pageMetadata,
        headers: {
            'User-Agent': activeFp.userAgent,
            'Referer': playerReferer,
            'Origin': getOrigin(pageUrl),
            'Accept': '*/*',
            'Accept-Language': activeFp.acceptLanguage,
            'Cookie': getCinemaCitySessionCookie()
        }
    };
}

async function getParsedCinemaCityStream(pageUrl, meta = {}) {
    const normalizedUrl = normalizeRemoteUrl(pageUrl);
    if (!normalizedUrl) return null;

    const cacheKey = `stream-result:${normalizedUrl}:${meta?.season || 1}:${meta?.episode || 1}:${meta?.rawEpisodeNumber || ''}:${(meta?.episodeCandidates || []).join(',')}`;

    if (streamResultCache.has(cacheKey)) {
        return streamResultCache.get(cacheKey);
    }

    return singleFlight(cacheKey, async () => {
        if (streamResultCache.has(cacheKey)) {
            return streamResultCache.get(cacheKey);
        }

        const result = await parseCinemaCityStream(pageUrl, meta);
        streamResultCache.set(cacheKey, result || null);
        return result || null;
    });
}

function buildDisplayTitle(meta = {}, fallbackTitle, season, episode) {
    const baseTitle = decodeHtmlEntities(
        meta?.title || meta?.name || meta?.originalTitle || fallbackTitle || 'CinemaCity'
    )
        .replace(/\s*\(.*?\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (meta?.isSeries) {
        return `${baseTitle} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    }
    return baseTitle;
}

async function searchCinemaCity(originalId, finalId, meta, config = {}, reqHost = null) {
    try {
        const resolved = await resolveSearchState(meta, originalId, finalId, config);
        if (!resolved.imdbId && !resolved.tmdbId && (!resolved.isAnime || resolved.searchTitles.length === 0)) return [];

        const titleFallbackOptions = {
            expectedTitles: uniqueStrings([
                ...(Array.isArray(resolved.searchTitles) ? resolved.searchTitles : []),
                ...(Array.isArray(resolved.rawTitles) ? resolved.rawTitles : [])
            ]),
            requestedImdbId: resolved.imdbId,
            expectedYear: resolved.expectedYear,
            fast: config?.filters?.cinemacityFast !== false
        };

        let searchResult = null;
        searchResult = await searchByTitleFallback(
            resolved.tmdbId || resolved.imdbId || originalId,
            resolved.providerType, meta, titleFallbackOptions
        );
        if (!searchResult?.url && resolved.imdbId) {
            searchResult = await searchByImdb(resolved.imdbId);
        }
        if (!searchResult?.url) return [];

        const enrichedMeta = {
            ...meta,
            season: resolved.season,
            episode: resolved.episode,
            rawEpisodeNumber: resolved.rawEpisodeNumber,
            episodeCandidates: resolved.episodeCandidates,
            providerType: resolved.providerType
        };
        const extracted = await getParsedCinemaCityStream(searchResult.url, enrichedMeta);
        if (!extracted?.streamUrl) return [];

        const pageMetadata = extracted.pageMetadata || {};
        if (!pageHasRequestedAudio(pageMetadata, config)) {
            if (config?.debug || process.env.DEBUG_CINEMACITY === '1') {
                console.warn(buildLanguageRejectReason(pageMetadata, config));
            }
            return [];
        }
        if (streamUrlHasForbiddenLanguage(extracted.streamUrl, config)) {
            if (config?.debug || process.env.DEBUG_CINEMACITY === '1') {
                console.warn('[CinemaCity] Skip stream URL non-ITA strict:', extracted.streamUrl);
            }
            return [];
        }

        let quality = normalizeQuality(pageMetadata.quality || '1080p');
        if (/\.m3u8($|\?)/i.test(extracted.streamUrl)) {
            try {
                const qualityCacheKey = `quality:${normalizeRemoteUrl(extracted.streamUrl)}`;
                const cachedQuality = qualityProbeCache.get(qualityCacheKey);
                const probed = cachedQuality ? cachedQuality.value : await singleFlight(qualityCacheKey, async () => {
                    const alreadyCached = qualityProbeCache.get(qualityCacheKey);
                    if (alreadyCached) return alreadyCached.value;
                    const detected = await probePlaylistQuality(httpClient, extracted.streamUrl, {
                        headers: extracted.headers,
                        timeout: 6000
                    });
                    qualityProbeCache.set(qualityCacheKey, { value: detected || 'Unknown' });
                    return detected || 'Unknown';
                });
                quality = pickBetterQuality(probed || 'Unknown', quality);
            } catch (_) {}
        }

        const isHlsStream = /\.m3u8($|\?)/i.test(extracted.streamUrl);
        const extractorLabel = /cccdn/i.test(extracted.streamUrl) ? 'CCCDN' : (isHlsStream ? 'HLS' : 'Direct');
        const displayTitle = buildDisplayTitle(meta, pageMetadata.title || searchResult.title, resolved.season, resolved.episode);
        const languageLabel = buildCinemaCityLanguageLabel(pageMetadata, config);
        const cinemaCityProxyUrl = buildCinemaCityProxyUrl(extracted.streamUrl, extracted.headers, reqHost, { isHls: isHlsStream });
        const extraVortexMeta = {
            bingeWatching: true,
            vortexMeta: {
                pageTitle: pageMetadata.title || '',
                imdbId: pageMetadata.imdbId || resolved.imdbId || '',
                tmdbId: pageMetadata.tmdbId || resolved.tmdbId || '',
                qualityTag: pageMetadata.qualityTag || '',
                audioLanguages: Array.isArray(pageMetadata.audioLanguages) ? pageMetadata.audioLanguages : [],
                subtitleLanguages: Array.isArray(pageMetadata.subtitleLanguages) ? pageMetadata.subtitleLanguages : [],
                genres: Array.isArray(pageMetadata.genres) ? pageMetadata.genres : [],
                isMultiAudio: pageMetadata.isMultiAudio === true,
                isAnime: pageMetadata.isAnime === true
            }
        };

        const streams = [];
        if (cinemaCityProxyUrl) {
            streams.push(buildWebStream({
                name: '🎟️ CinemaCity | CCCDN',
                title: `${displayTitle}\n☁️ CCCDN • ${languageLabel}`,
                url: cinemaCityProxyUrl,
                extractor: 'CCCDN',
                provider: 'CinemaCity',
                providerCode: 'CC',
                quality,
                headers: null,
                notWebReady: false,
                extraBehaviorHints: extraVortexMeta
            }));
        }

        if (streams.length === 0) {
            streams.push(buildWebStream({
                name: '🎟️ CinemaCity | Direct',
                title: `${displayTitle}\n☁️ ${extractorLabel} • ${languageLabel}`,
                url: extracted.streamUrl,
                extractor: extractorLabel,
                provider: 'CinemaCity',
                providerCode: 'CC',
                quality,
                headers: extracted.headers,
                notWebReady: true,
                extraBehaviorHints: extraVortexMeta
            }));
        }

        const filteredStreams = hardFilterStreamsByLanguage(dedupeStreamsByUrl(streams), config);
        return filteredStreams.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
    } catch (error) {
        console.error('[CinemaCity] Error:', error.message);
        return [];
    }
}

module.exports = {
    searchCinemaCity,
    __private: {
        looksLikeAnimeMeta,
        isCinemaCityContentUrlForType,
        extractCandidateLinksFromListing,
        buildSearchQueryVariants,
        titleFromContentUrl,
        scoreTitleMatch,
        titleAliasesFromOneTitle,
        getListingBaseUrls,
        pickStream,
        parseCinemaCityPageMetadata,
        extractDownloadLanguagesFromPage,
        buildCinemaCityLanguageLabel,
        normalizeLanguageToken,
        normalizeLanguageList,
        getWantedLanguage,
        isStrictSingleLanguageMode,
        pageHasRequestedAudio,
        buildLanguageRejectReason,
        streamUrlHasForbiddenLanguage,
        hardFilterStreamsByLanguage
    }
};
