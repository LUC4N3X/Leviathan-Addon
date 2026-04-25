'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const animeIdentity = require('../anime/anime_identity');
const kitsuProvider = require('../animeworld/kitsu_provider');
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
const SESSION_COOKIE = Buffer.from(
    'ZGxlX3VzZXJfaWQ9MzI3Mjk7IGRsZV9wYXNzd29yZD04OTQxNzFjNmE4ZGFiMThlZTU5NGQ1YzY1MjAwOWEzNTs=',
    'base64'
).toString('utf8');
const FETCH_TIMEOUT = 14000;
const GOT_TIMEOUT = 16000;
const MAX_LISTING_PAGES = 8;
const MAX_LISTING_CANDIDATES_PER_PAGE = 24;
const MAPPING_API_BASE = 'https://anime.questoleviatanormio.dpdns.org';
const NEWS_SITEMAP_URL = `${BASE_URL}/news_pages.xml`;
const NEWS_SITEMAP_TTL_MS = 30 * 60 * 1000;

const FINGERPRINT_POOL = [
    {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
        browserType: 'edge',
        secChUa: '"Microsoft Edge";v="134", "Chromium";v="134", "Not:A-Brand";v="99"',
        secChUaPlatform: '"Windows"',
        acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8'
    },
    {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"macOS"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
        browserType: 'firefox',
        secChUa: null,
        secChUaPlatform: null,
        acceptLanguage: 'it-IT,it;q=0.8,en-US;q=0.5,en;q=0.3'
    },
    {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        browserType: 'chrome',
        secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        secChUaPlatform: '"Linux"',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    }
];

let fingerprintIndex = Math.floor(Math.random() * FINGERPRINT_POOL.length);

function getNextFingerprint() {
    const fp = FINGERPRINT_POOL[fingerprintIndex % FINGERPRINT_POOL.length];
    fingerprintIndex += 1;
    return fp;
}

function buildBrowserHeaders(fp, extra = {}) {
    const headers = {
        'User-Agent': fp.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': fp.acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };

    if (fp.browserType !== 'firefox') {
        Object.assign(headers, {
            'sec-ch-ua': fp.secChUa,
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': fp.secChUaPlatform,
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
        });
    } else {
        Object.assign(headers, {
            'TE': 'trailers'
        });
    }

    return Object.assign(headers, extra);
}

let gotScrapingInstance = null;
let gotScrapingLoadError = null;

async function getGotScraping() {
    if (gotScrapingInstance) return gotScrapingInstance;
    if (gotScrapingLoadError) return null;
    try {
        const module = await import('got-scraping');
        gotScrapingInstance = module.gotScraping;
        return gotScrapingInstance;
    } catch (err) {
        gotScrapingLoadError = err;
        return null;
    }
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

function responseText(data) {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data); }
}

function isCloudflareChallenge(body, status) {
    if (status === 403 || status === 429 || status === 503) return true;
    const text = String(body || '');
    return (
        /just a moment|checking your browser|cloudflare ray id|cf-browser-verification/i.test(text)
        || (/challenge-platform|_cf_chl_opt|cf_clearance/i.test(text) && text.length < 20000)
    );
}

/**
 * Primary fetch: got-scraping with full TLS impersonation.
 * Rotates fingerprints on retry for max bypass capability.
 */
async function fetchHtmlWithGot(url, extraHeaders = {}, attempt = 0) {
    const gotScraping = await getGotScraping();
    if (!gotScraping) return null;

    const fp = FINGERPRINT_POOL[(fingerprintIndex + attempt) % FINGERPRINT_POOL.length];
    const mergedHeaders = buildBrowserHeaders(fp, extraHeaders);

    try {
        const response = await gotScraping({
            url,
            headers: mergedHeaders,
            headerGeneratorOptions: {
                browsers: [{ name: fp.browserType === 'firefox' ? 'firefox' : 'chrome', minVersion: 120 }],
                operatingSystems: ['windows', 'macos', 'linux'],
                devices: ['desktop'],
                locales: ['it-IT', 'en-US']
            },
            retry: { limit: 0 },
            timeout: { request: GOT_TIMEOUT },
            followRedirect: true,
            responseType: 'text',
            decompress: true
        });

        const status = Number(response?.statusCode || 0);
        const body = response?.body || '';

        if (isCloudflareChallenge(body, status)) {
            return null;
        }

        if (status >= 200 && status < 400) return body;
        return null;
    } catch (_) {
        return null;
    }
}

/**
 * Axios fallback with randomized fingerprint headers.
 */
async function fetchHtmlWithAxios(url, extraHeaders = {}) {
    const fp = getNextFingerprint();
    const mergedHeaders = buildBrowserHeaders(fp, extraHeaders);

    try {
        const response = await httpClient.get(url, {
            headers: mergedHeaders,
            responseType: 'text'
        });
        const status = Number(response?.status || 0);
        const body = responseText(response?.data);

        if (isCloudflareChallenge(body, status)) return null;
        if (status >= 200 && status < 400) return body;
        return null;
    } catch (_) {
        return null;
    }
}

/**
 * Main HTML fetch with:
 *  1. got-scraping (attempt 0 → primary fingerprint)
 *  2. got-scraping (attempt 1 → rotated fingerprint)
 *  3. got-scraping (attempt 2 → another fingerprint)
 *  4. axios fallback
 * Throws only if all attempts fail.
 */
async function fetchHtml(url, extraHeaders = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const body = await fetchHtmlWithGot(url, extraHeaders, attempt);
        if (body) return body;
        if (attempt < 2) await sleep(400 + attempt * 300);
    }

    const axiosBody = await fetchHtmlWithAxios(url, extraHeaders);
    if (axiosBody) return axiosBody;

    throw new Error(`HTTP fetch failed for ${url} — all bypass strategies exhausted`);
}

async function fetchJson(url, options = {}) {
    const fp = getNextFingerprint();
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

function parseCinemaCityPageMetadata(html, pageUrl = '') {
    const body = String(html || '');
    const $ = loadHtml(body);
    const pageTitle = extractHeadingTitle(body)
        || extractMetaContent(body, 'og:title')
        || extractMetaContent(body, 'twitter:title')
        || titleFromContentUrl(pageUrl);
    const genres = extractSectionValues(body, 'Genre');
    const audioLanguages = extractSectionValues(body, 'Audio language');
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
    const isMultiAudio = audioLanguages.length > 1 || /multi/i.test(listedQualities.join(' '));
    const isAnime = genres.some((v) => /\banime\b|\banimation\b/i.test(String(v)))
        || getCinemaCitySectionType(pageUrl) === 'anime';

    return {
        title: pageTitle,
        year: extractYear(pageTitle) || extractYear(body),
        imdbId,
        tmdbId,
        genres,
        audioLanguages,
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
                'Cookie': SESSION_COOKIE,
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

function buildCinemaCityLanguageLabel(pageMetadata = {}, config = {}) {
    const languages = Array.isArray(pageMetadata?.audioLanguages)
        ? pageMetadata.audioLanguages.map((v) => String(v).trim().toLowerCase()).filter(Boolean)
        : [];
    const wantsItalian = String(config?.filters?.language || '').trim().toLowerCase() === 'ita';
    const hasItalian = languages.includes('italian');
    const hasEnglish = languages.includes('english');
    if (hasItalian && pageMetadata?.isMultiAudio) return '🌍 MULTI';
    if (hasItalian) return '🇮🇹 ITA';
    if (wantsItalian && pageMetadata?.isMultiAudio) return '🌍 MULTI';
    if (hasEnglish && languages.length === 1) return '🇬🇧 ENG';
    if (pageMetadata?.isMultiAudio || languages.length > 1) return '🌍 MULTI';
    return '🌐 WEB';
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

function buildSearchQueryVariants(titles = []) {
    const seen = new Set();
    const out = [];
    for (const title of uniqueStrings(titles)) {
        const normalized = kitsuProvider.normalizeTitle(title);
        const compact = decodeHtmlEntities(title)
            .replace(/\b(?:season|stagione|episode|episodio|ep\.?)\s*\d+\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        for (const variant of uniqueStrings([title, normalized, compact])) {
            const key = variant.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(variant);
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
        });
        const entries = extractSitemapLocs(xml).filter((url) => /^https:\/\/cinemacity\.cc\//i.test(url));
        newsSitemapCache.entries = entries;
        newsSitemapCache.fetchedAt = Date.now();
        return entries;
    });
}

async function getIdsFromKitsu(kitsuId, season, episode, config = {}) {
    if (!kitsuId) return null;
    try {
        const params = new URLSearchParams();
        const parsedEpisode = Number.parseInt(String(episode || ''), 10);
        const parsedSeason = Number.parseInt(String(season || ''), 10);
        params.set('ep', Number.isInteger(parsedEpisode) && parsedEpisode > 0 ? String(parsedEpisode) : '1');
        if (Number.isInteger(parsedSeason) && parsedSeason >= 0) params.set('s', String(parsedSeason));
        const mappingLanguage = getMappingLanguage(config);
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

        return {
            imdbId: extractImdbId(ids.imdb),
            tmdbId: extractTmdbId(ids.tmdb),
            mappedSeason: Number.isInteger(mappedSeason) && mappedSeason > 0 ? mappedSeason : null,
            mappedEpisode: Number.isInteger(mappedEpisode) && mappedEpisode > 0 ? mappedEpisode : null,
            rawEpisodeNumber: Number.isInteger(rawEpisodeNumber) && rawEpisodeNumber > 0 ? rawEpisodeNumber : null
        };
    } catch (error) {
        console.error('[CinemaCity] Kitsu mapping error:', error.message);
        return null;
    }
}

async function getTmdbMetadata(id, providerType) {
    const normalizedId = String(id || '').trim();
    const normalizedType = providerType === 'movie' ? 'movie' : 'tv';

    try {
        if (extractImdbId(normalizedId)) {
            const payload = await tmdbHelper.fetchTmdbJson(`/find/${encodeURIComponent(normalizedId)}`, {
                params: { external_source: 'imdb_id', language: 'en-US' }
            });
            const results = normalizedType === 'movie' ? payload?.movie_results : payload?.tv_results;
            return Array.isArray(results) && results.length > 0 ? results[0] : null;
        }

        const cleanTmdbId = extractTmdbId(normalizedId);
        if (cleanTmdbId) {
            return tmdbHelper.fetchTmdbJson(`/${normalizedType}/${cleanTmdbId}`, {
                params: { language: 'en-US' }
            });
        }
    } catch (error) {
        console.error('[CinemaCity] TMDB metadata error:', error.message);
    }

    return null;
}

async function resolveImdbFromTmdb(tmdbId, providerType) {
    const cleanTmdbId = extractTmdbId(tmdbId);
    if (!cleanTmdbId) return null;
    try {
        return extractImdbId(await tmdbHelper.getImdbFromTmdb(cleanTmdbId, providerType === 'movie' ? 'movie' : 'tv'));
    } catch (error) {
        console.error('[CinemaCity] TMDB→IMDb resolution error:', error.message);
        return null;
    }
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

async function pickBestCandidate(candidates, expectedTitles, { requestedImdbId = null, expectedYear = null, providerType = 'tv' } = {}) {
    const scoredCandidates = (candidates || [])
        .map((c) => ({ ...c, score: scoreCandidateEntry(c, expectedTitles, expectedYear, providerType) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scoredCandidates.length === 0) return null;

    const normalizedRequestedImdbId = extractImdbId(requestedImdbId);
    if (normalizedRequestedImdbId) {
        const mismatchedUrls = new Set();
        for (const candidate of scoredCandidates.slice(0, 6)) {
            if (candidate.score < 80) break;
            const candidateImdbId = await verifyCandidateImdb(candidate.url, normalizedRequestedImdbId);
            if (candidateImdbId && candidateImdbId === normalizedRequestedImdbId) return candidate;
            if (candidateImdbId && candidateImdbId !== normalizedRequestedImdbId) mismatchedUrls.add(candidate.url);
        }
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

async function searchByTitleQueries(queryTitles, providerType, expectedTitles, requestedImdbId, expectedYear) {
    const queries = buildSearchQueryVariants(queryTitles).slice(0, 6);
    if (queries.length === 0) return null;

    const collected = [];
    const seen = new Set();

    for (const query of queries) {
        const searchUrl = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
        try {
            const html = await fetchHtml(searchUrl, {
                'Referer': `${BASE_URL}/`,
                'Cookie': SESSION_COOKIE,
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'navigate'
            });
            const candidates = extractSearchCandidates(html);
            for (const candidate of candidates) {
                if (!candidate?.url || seen.has(candidate.url)) continue;
                seen.add(candidate.url);
                collected.push(candidate);
            }
        } catch (_) {}
    }

    return pickBestCandidate(collected, expectedTitles, { requestedImdbId, expectedYear, providerType });
}

async function searchByImdb(imdbId) {
    const normalizedImdbId = extractImdbId(imdbId);
    if (!normalizedImdbId) return null;

    const trySearch = async (query) => {
        const searchUrl = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
        try {
            const html = await fetchHtml(searchUrl, {
                'Referer': `${BASE_URL}/`,
                'Cookie': SESSION_COOKIE,
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'navigate'
            });
            return extractSearchCandidates(html)[0] || null;
        } catch (_) {
            return null;
        }
    };

    let result = await trySearch(normalizedImdbId);
    if (result) return result;

    const numericId = normalizedImdbId.replace(/\D/g, '');
    if (numericId && numericId !== normalizedImdbId) {
        result = await trySearch(numericId);
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

    if (providerType === 'anime') {
        const searched = await searchByTitleQueries(expectedTitles, providerType, expectedTitles, requestedImdbId, expectedYear);
        if (searched?.url) return searched;
    }

    try {
        const sitemapEntries = await getNewsSitemapEntries();
        const sitemapCandidates = sitemapEntries
            .filter((url) => isCinemaCityContentUrlForType(url, providerType))
            .map((url) => ({ url, title: titleFromContentUrl(url) }))
            .filter((c) => scoreTitleMatch(c.title, expectedTitles) > 0);

        const bestSitemap = await pickBestCandidate(sitemapCandidates, expectedTitles, {
            requestedImdbId, expectedYear, providerType
        });
        if (bestSitemap?.url) return bestSitemap;
    } catch (_) {}

    let bestResult = null;
    let bestScore = 0;
    for (const listingBase of getListingBaseUrls(providerType)) {
        for (let page = 1; page <= MAX_LISTING_PAGES; page += 1) {
            const pageUrl = page === 1 ? listingBase : `${listingBase}page/${page}/`;
            try {
                const html = await fetchHtml(pageUrl, {
                    'Referer': `${BASE_URL}/`,
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-Mode': 'navigate'
                });
                const candidates = extractCandidateLinksFromListing(html, providerType);
                if (candidates.length === 0) break;

                const picked = await pickBestCandidate(
                    candidates.slice(0, MAX_LISTING_CANDIDATES_PER_PAGE),
                    expectedTitles,
                    { requestedImdbId, expectedYear, providerType }
                );
                if (picked?.score > bestScore) {
                    bestScore = picked.score;
                    bestResult = picked;
                }
                if (bestScore >= 100) return bestResult;
            } catch (_) {
                break;
            }
        }
    }

    return bestScore >= 80 ? bestResult : null;
}

function getIdCandidates(meta = {}, originalId, finalId) {
    return [
        originalId, finalId, meta?.requestedId, meta?.originalId, meta?.id,
        meta?.imdb_id, meta?.imdbId, meta?.tmdb_id, meta?.tmdbId,
        meta?.kitsu_id ? `kitsu:${meta.kitsu_id}` : null,
        meta?.kitsuId ? `kitsu:${meta.kitsuId}` : null
    ].filter(Boolean);
}

async function buildAnimeSearchContext(meta = {}, originalId, finalId, config = {}, season = null, episode = null) {
    try {
        const context = await animeIdentity.buildAnimeSearchContextForProvider({
            requestId: originalId,
            originalId,
            finalId,
            meta,
            config,
            season,
            episode,
            providerName: 'CinemaCity',
            mappingApiBase: MAPPING_API_BASE
        });

        if (context?.isAnime || context?.kitsuId || context?.searchTitles?.length || context?.rawTitles?.length) {
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
                ])
            };
        }
    } catch (error) {
        console.warn('[CinemaCity] shared anime context failed:', error.message);
    }

    const candidateIds = getIdCandidates(meta, originalId, finalId);
    let kitsuToken = null;

    for (const candidate of candidateIds) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) {
            kitsuToken = String(candidate);
            break;
        }
    }

    if (kitsuToken) {
        try {
            const context = await kitsuProvider.buildSearchContext(kitsuToken, meta);
            if (context) {
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
                    ])
                };
            }
        } catch (_) {}
    }

    if (!looksLikeAnimeMeta(meta)) return null;

    const rawTitles = collectMetaTitles(meta);
    const searchTitles = buildSearchQueryVariants(rawTitles);
    return {
        kitsuId: null,
        rawTitles,
        searchTitles,
        title: searchTitles[0] || rawTitles[0] || null,
        year: extractYear(meta?.year || meta?.releaseInfo || ''),
        date: null,
        seasonNumber: normalizeEpisodeNumber(meta?.season),
        requestedEpisode: normalizeEpisodeNumber(meta?.episode) || 1,
        isMovie: meta?.isSeries === false
    };
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
    const contextKitsuId = [
        extractKitsuId(meta?.kitsu_id),
        extractKitsuId(meta?.kitsuId),
        ...candidateIds.map(extractKitsuId)
    ].find(Boolean) || null;
    let resolvedTmdbId = contextTmdbId || extractTmdbId(workingId) || null;
    let animeContext = null;

    if (!workingId) {
        workingId = contextImdbId || contextTmdbId || (contextKitsuId ? `kitsu:${contextKitsuId}` : '');
    }

    const animeLikely = contextKitsuId || looksLikeAnimeMeta(meta) || candidateIds.some((id) => /^kitsu:/i.test(String(id || '')));
    if (animeLikely) {
        animeContext = await buildAnimeSearchContext(meta, originalId, finalId, config, season, episode);
        if (animeContext?.seasonNumber) season = animeContext.seasonNumber;
        if (animeContext?.requestedEpisode) episode = animeContext.requestedEpisode;
        providerType = 'anime';
    }

    const applyMappedIds = (mapped) => {
        if (!mapped) return false;
        if (mapped.tmdbId) resolvedTmdbId = mapped.tmdbId;
        if (mapped.imdbId) workingId = mapped.imdbId;
        else if (mapped.tmdbId && !extractImdbId(workingId)) workingId = mapped.tmdbId;
        if (mapped.mappedSeason && mapped.mappedEpisode) {
            season = mapped.mappedSeason;
            episode = mapped.mappedEpisode;
        } else if (mapped.rawEpisodeNumber) {
            episode = mapped.rawEpisodeNumber;
        }
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
        providerType
    };
}

function parseCompositeSeriesId(rawId, season, episode) {
    const parsed = {
        normalizedId: String(rawId || '').trim(),
        season: Number.isInteger(season) ? season : (Number.parseInt(season, 10) || 1),
        episode: Number.isInteger(episode) ? episode : (Number.parseInt(episode, 10) || 1)
    };
    const match = parsed.normalizedId.match(/^(tt\d+|\d+|tmdb:\d+):(\d+):(\d+)$/i);
    if (!match) return parsed;
    parsed.normalizedId = match[1];
    parsed.season = Number.parseInt(match[2], 10) || parsed.season;
    parsed.episode = Number.parseInt(match[3], 10) || parsed.episode;
    return parsed;
}

function extractSeasonNumberFromTitle(title) {
    const match = String(title || '').match(/(?:season|stagione)\s*0*(\d+)\b|(?:^|\b)s\s*0*(\d+)\b/i);
    const value = Number.parseInt(String(match?.[1] || match?.[2] || ''), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
}

function extractEpisodeNumberFromTitle(title) {
    const match = String(title || '').match(/(?:episode|episodio)\s*0*(\d+)\b|(?:^|\b)e\s*0*(\d+)\b/i);
    const value = Number.parseInt(String(match?.[1] || match?.[2] || ''), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
}

function pickStream(fileData, type, season = 1, episode = 1) {
    if (typeof fileData === 'string') return fileData;

    if (Array.isArray(fileData)) {
        if (
            type === 'movie'
            || fileData.every((e) => e && typeof e === 'object' && 'file' in e && !('folder' in e))
        ) {
            return fileData[0]?.file || null;
        }

        const requestedSeason = normalizeEpisodeNumber(season) || 1;
        const requestedEpisode = normalizeEpisodeNumber(episode) || 1;
        const seasonEntries = fileData
            .filter((e) => e && typeof e === 'object' && Array.isArray(e.folder))
            .map((e) => ({ entry: e, seasonNumber: extractSeasonNumberFromTitle(e.title) }));

        const exactSeasonMatch = seasonEntries.find((e) => e.seasonNumber === requestedSeason);
        let selectedSeasonFolder = exactSeasonMatch?.entry?.folder || null;

        if (!selectedSeasonFolder) {
            const hasExplicitSeasonNumbers = seasonEntries.some((e) => Number.isInteger(e.seasonNumber));
            if (hasExplicitSeasonNumbers) return null;
            selectedSeasonFolder = seasonEntries[requestedSeason - 1]?.entry?.folder
                || seasonEntries[0]?.entry?.folder || null;
        }
        if (!selectedSeasonFolder) return null;

        const episodeEntries = selectedSeasonFolder
            .filter((e) => e && typeof e === 'object' && e.file)
            .map((e) => ({ entry: e, episodeNumber: extractEpisodeNumberFromTitle(e.title) }));

        const exactEpisodeMatch = episodeEntries.find((e) => e.episodeNumber === requestedEpisode);
        let selectedEpisodeFile = exactEpisodeMatch?.entry?.file || null;

        if (!selectedEpisodeFile) {
            const hasExplicitEpisodeNumbers = episodeEntries.some((e) => Number.isInteger(e.episodeNumber));
            if (hasExplicitEpisodeNumbers) return null;
            selectedEpisodeFile = episodeEntries[requestedEpisode - 1]?.entry?.file || null;
        }
        return selectedEpisodeFile;
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
        'Cookie': SESSION_COOKIE,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1'
    });

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
        pickStream(fileData, meta?.isSeries ? 'tv' : 'movie', meta?.season || 1, meta?.episode || 1)
    );
    if (!streamUrl) return null;

    const activeFp = FINGERPRINT_POOL[fingerprintIndex % FINGERPRINT_POOL.length];
    return {
        streamUrl,
        pageMetadata,
        headers: {
            'User-Agent': activeFp.userAgent,
            'Referer': playerReferer,
            'Origin': getOrigin(pageUrl),
            'Accept': '*/*',
            'Accept-Language': activeFp.acceptLanguage,
            'Cookie': SESSION_COOKIE
        }
    };
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

function buildCinemaCityProxyUrl(config = {}, streamUrl, headers = {}, isHls = false) {
    const mfpBase = String(config?.mediaflow?.url || '').trim().replace(/\/$/, '');
    const normalizedTarget = normalizeRemoteUrl(streamUrl);
    if (!mfpBase || !normalizedTarget) return null;

    const passwordQuery = config?.mediaflow?.pass
        ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';
    const refererQuery = headers?.Referer ? `&h_Referer=${encodeURIComponent(headers.Referer)}` : '';
    const originQuery = headers?.Origin ? `&h_Origin=${encodeURIComponent(headers.Origin)}` : '';

    if (isHls) {
        return `${mfpBase}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(normalizedTarget)}${passwordQuery}${refererQuery}${originQuery}`;
    }
    return `${mfpBase}/proxy/stream?d=${encodeURIComponent(normalizedTarget)}${passwordQuery}${refererQuery}${originQuery}`;
}

async function searchCinemaCity(originalId, finalId, meta, config = {}) {
    try {
        const resolved = await resolveSearchState(meta, originalId, finalId, config);
        if (!resolved.imdbId && !resolved.tmdbId && (!resolved.isAnime || resolved.searchTitles.length === 0)) return [];

        const titleFallbackOptions = {
            expectedTitles: uniqueStrings([
                ...(Array.isArray(resolved.searchTitles) ? resolved.searchTitles : []),
                ...(Array.isArray(resolved.rawTitles) ? resolved.rawTitles : [])
            ]),
            requestedImdbId: resolved.imdbId,
            expectedYear: resolved.expectedYear
        };

        let searchResult = null;
        if (resolved.isAnime && titleFallbackOptions.expectedTitles.length > 0) {
            searchResult = await searchByTitleFallback(
                resolved.tmdbId || resolved.imdbId || originalId,
                resolved.providerType, meta, titleFallbackOptions
            );
        }
        if (!searchResult?.url && resolved.imdbId) {
            searchResult = await searchByImdb(resolved.imdbId);
        }
        if (!searchResult?.url) {
            searchResult = await searchByTitleFallback(
                resolved.tmdbId || resolved.imdbId || originalId,
                resolved.providerType, meta, titleFallbackOptions
            );
        }
        if (!searchResult?.url) return [];

        const enrichedMeta = { ...meta, season: resolved.season, episode: resolved.episode };
        const extracted = await singleFlight(`stream:${normalizeRemoteUrl(searchResult.url)}:${resolved.season}:${resolved.episode}`, () => parseCinemaCityStream(searchResult.url, enrichedMeta));
        if (!extracted?.streamUrl) return [];

        const pageMetadata = extracted.pageMetadata || {};
        let quality = normalizeQuality(pageMetadata.quality || '1080p');
        if (/\.m3u8($|\?)/i.test(extracted.streamUrl)) {
            try {
                const probed = await probePlaylistQuality(httpClient, extracted.streamUrl, {
                    headers: extracted.headers,
                    timeout: 6000
                });
                quality = pickBetterQuality(probed || 'Unknown', quality);
            } catch (_) {}
        }

        const isHlsStream = /\.m3u8($|\?)/i.test(extracted.streamUrl);
        const extractorLabel = /cccdn/i.test(extracted.streamUrl) ? 'CCCDN' : (isHlsStream ? 'HLS' : 'Direct');
        const displayTitle = buildDisplayTitle(meta, pageMetadata.title || searchResult.title, resolved.season, resolved.episode);
        const languageLabel = buildCinemaCityLanguageLabel(pageMetadata, config);
        const mediaflowProxyUrl = buildCinemaCityProxyUrl(config, extracted.streamUrl, extracted.headers, isHlsStream);
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
        if (mediaflowProxyUrl) {
            streams.push(buildWebStream({
                name: '🏙️ CinemaCity | CCCDN',
                title: `${displayTitle}\n☁️ CCCDN • ${languageLabel}`,
                url: mediaflowProxyUrl,
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
                name: '🏙️ CinemaCity | Direct',
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

        return dedupeStreamsByUrl(streams).sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
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
        getListingBaseUrls,
        pickStream,
        parseCinemaCityPageMetadata,
        buildCinemaCityLanguageLabel
    }
};
