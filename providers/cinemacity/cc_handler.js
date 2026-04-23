'use strict';

const axios = require('axios');
const he = require('he');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
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
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10000;
const MAX_LISTING_PAGES = 8;
const MAX_LISTING_CANDIDATES_PER_PAGE = 24;
const TMDB_API_KEY = String(process.env.TMDB_API_KEY || '4b9dfb8b1c9f1720b5cd1d7efea1d845').trim();
const MAPPING_API_BASE = 'https://anime.questoleviatanormio.dpdns.org';
const NEWS_SITEMAP_URL = `${BASE_URL}/news_pages.xml`;
const NEWS_SITEMAP_TTL_MS = 30 * 60 * 1000;
const BASE_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
};

const httpClient = axios.create({
    timeout: FETCH_TIMEOUT,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    proxy: false,
    validateStatus: () => true
});

let gotScrapingInstance = null;
const newsSitemapCache = {
    fetchedAt: 0,
    entries: null,
    pending: null
};

function responseText(data) {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try {
        return JSON.stringify(data);
    } catch (_) {
        return String(data);
    }
}

async function fetchHtmlWithGot(url, headers = {}) {
    try {
        if (!gotScrapingInstance) {
            const module = await import('got-scraping');
            gotScrapingInstance = module.gotScraping;
        }
        const response = await gotScrapingInstance({
            url,
            headers,
            retry: { limit: 1 },
            responseType: 'text'
        });
        return response?.body || '';
    } catch (_) {
        return '';
    }
}

function createHttpError(status) {
    return new Error(`HTTP ${status || 500}`);
}

async function fetchHtml(url, headers = {}) {
    const finalHeaders = {
        ...BASE_HEADERS,
        ...headers
    };

    const response = await httpClient.get(url, {
        headers: finalHeaders,
        responseType: 'text'
    });
    const status = Number(response?.status || 0);
    if (status >= 200 && status < 400) {
        return responseText(response.data);
    }

    const fallbackBody = await fetchHtmlWithGot(url, finalHeaders);
    if (fallbackBody) return fallbackBody;

    throw createHttpError(status);
}

async function fetchJson(url, options = {}) {
    const response = await httpClient.get(url, options);
    const status = Number(response?.status || 0);
    if (status >= 200 && status < 400) {
        return response.data;
    }
    throw createHttpError(status);
}

function decodeHtmlEntities(value) {
    return he.decode(String(value || ''))
        .replace(/\u2013|\u2014/g, '-')
        .replace(/&ndash;|&mdash;/gi, '-');
}

function uniqueStrings(values = []) {
    return [...new Set((values || []).map((value) => decodeHtmlEntities(String(value || '')).trim()).filter(Boolean))];
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
        .map((match) => String(match[1] || '').trim())
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
    if (genres.some((value) => /(anime|animation|animazione)/i.test(String(value)))) return true;

    const haystack = uniqueStrings([
        meta?.id,
        meta?.requestedId,
        meta?.originalId,
        meta?.kitsu_id,
        meta?.kitsuId,
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
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.original_title,
        meta?.originalName,
        meta?.original_name,
        metadata?.title,
        metadata?.name,
        metadata?.original_title,
        metadata?.original_name
    ]
        .map((value) => decodeHtmlEntities(String(value || '')).trim())
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

    if (newsSitemapCache.pending) {
        return newsSitemapCache.pending;
    }

    newsSitemapCache.pending = (async () => {
        const xml = await fetchHtml(NEWS_SITEMAP_URL, {
            Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
            Referer: `${BASE_URL}/`
        });
        const entries = extractSitemapLocs(xml).filter((url) => /^https:\/\/cinemacity\.cc\//i.test(url));
        newsSitemapCache.entries = entries;
        newsSitemapCache.fetchedAt = Date.now();
        return entries;
    })();

    try {
        return await newsSitemapCache.pending;
    } finally {
        newsSitemapCache.pending = null;
    }
}

async function getIdsFromKitsu(kitsuId, season, episode, config = {}) {
    if (!kitsuId) return null;

    try {
        const params = new URLSearchParams();
        const parsedEpisode = Number.parseInt(String(episode || ''), 10);
        const parsedSeason = Number.parseInt(String(season || ''), 10);
        params.set('ep', Number.isInteger(parsedEpisode) && parsedEpisode > 0 ? String(parsedEpisode) : '1');
        if (Number.isInteger(parsedSeason) && parsedSeason >= 0) {
            params.set('s', String(parsedSeason));
        }
        const mappingLanguage = getMappingLanguage(config);
        if (mappingLanguage) params.set('lang', mappingLanguage);

        const payload = await fetchJson(`${MAPPING_API_BASE}/kitsu/${encodeURIComponent(String(kitsuId).trim())}?${params.toString()}`);
        const ids = payload?.mappings?.ids || {};
        const tmdbEpisode = payload?.mappings?.tmdb_episode
            || payload?.mappings?.tmdbEpisode
            || payload?.tmdb_episode
            || payload?.tmdbEpisode
            || null;

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

function extractCandidateLinksFromListing(html, sectionType) {
    const pathPrefix = sectionType === 'movie'
        ? 'movies'
        : (sectionType === 'anime' ? '(?:anime|series|tv-series)' : '(?:tv-series|series|anime)');
    const regex = new RegExp(
        `<a[^>]+href=["']((?:https?:\\/\\/cinemacity\\.cc)?\\/${pathPrefix}\\/[^"']+\\.html)["'][^>]*>([\\s\\S]*?)<\\/a>`,
        'gi'
    );
    const results = [];
    let match;

    while ((match = regex.exec(html)) !== null) {
        const href = String(match[1] || '').startsWith('/')
            ? `${BASE_URL}${match[1]}`
            : String(match[1] || '');
        const title = decodeHtmlEntities(String(match[2] || '').replace(/<[^>]+>/g, ' ')).trim();
        if (!href || !title) continue;
        results.push({ url: href, title });
    }

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
            normalizedExpected.length > 5
            && normalizedCandidate.length > 5
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
    const resultMatch = body.match(/Found\s+(\d+)\s+responses/i)
        || body.match(/Trovat[io]\s+(\d+)\s+risultat[io]/i)
        || body.match(/Query results\s*\d+\s*-\s*(\d+)/i);

    if ((!resultMatch || Number.parseInt(resultMatch[1], 10) === 0) && /site search yielded no results|ricerca non ha prodotto risultati/i.test(body)) {
        return [];
    }

    const markerIdx = resultMatch ? body.indexOf(resultMatch[0]) : body.indexOf('id="dle-content"');
    if (markerIdx === -1) return [];

    const contentEndStrings = ['id="side"', 'class="side"', '<footer', '<aside'];
    let contentEndIdx = body.length;
    for (const token of contentEndStrings) {
        const position = body.indexOf(token, markerIdx);
        if (position !== -1 && position < contentEndIdx) contentEndIdx = position;
    }

    const searchArea = body.substring(markerIdx, contentEndIdx);
    const links = [...searchArea.matchAll(
        /<a[^>]+href=["']((?:https?:\/\/cinemacity\.cc)?\/(?:movies|anime|series|tv-series)\/\d+-[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi
    )];

    const results = [];
    for (const match of links) {
        let href = String(match[1] || '');
        if (!href) continue;
        if (href.startsWith('/')) href = `${BASE_URL}${href}`;
        const title = decodeHtmlEntities(String(match[2] || '').replace(/<[^>]*>?/g, ' ').trim());
        if (!title) continue;
        results.push({ url: href, title });
    }

    return Array.from(new Map(results.map((item) => [item.url, item])).values());
}

async function pickBestCandidate(candidates, expectedTitles, { requestedImdbId = null, expectedYear = null, providerType = 'tv' } = {}) {
    const scoredCandidates = (candidates || [])
        .map((candidate) => ({
            ...candidate,
            score: scoreCandidateEntry(candidate, expectedTitles, expectedYear, providerType)
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);

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

        return scoredCandidates.find((candidate) => candidate.score >= 80 && !mismatchedUrls.has(candidate.url)) || null;
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
                Referer: `${BASE_URL}/`,
                Cookie: SESSION_COOKIE
            });
            const candidates = extractSearchCandidates(html);
            for (const candidate of candidates) {
                if (!candidate?.url || seen.has(candidate.url)) continue;
                seen.add(candidate.url);
                collected.push(candidate);
            }
        } catch (_) {}
    }

    return pickBestCandidate(collected, expectedTitles, {
        requestedImdbId,
        expectedYear,
        providerType
    });
}

function extractImdbIdFromHtml(html) {
    const matches = String(html || '').match(/\btt\d{5,}\b/gi) || [];
    for (const match of matches) {
        if (/^tt\d{5,}$/i.test(match)) return match.toLowerCase();
    }
    return null;
}

async function verifyCandidateImdb(candidateUrl, expectedImdbId) {
    const normalizedExpected = extractImdbId(expectedImdbId);
    if (!normalizedExpected) return null;

    try {
        const html = await fetchHtml(candidateUrl, {
            Referer: `${BASE_URL}/`,
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1'
        });
        return extractImdbIdFromHtml(html);
    } catch (_) {
        return null;
    }
}

async function getTmdbMetadata(id, providerType) {
    const normalizedId = String(id || '').trim();
    const normalizedType = providerType === 'movie' ? 'movie' : 'tv';
    let metadataUrl = null;

    if (extractImdbId(normalizedId)) {
        metadataUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(normalizedId)}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=en-US`;
    } else if (extractTmdbId(normalizedId)) {
        metadataUrl = `https://api.themoviedb.org/3/${normalizedType}/${extractTmdbId(normalizedId)}?api_key=${TMDB_API_KEY}&language=en-US`;
    }

    if (!metadataUrl) return null;

    try {
        const payload = await fetchJson(metadataUrl, {
            headers: {
                Accept: 'application/json'
            }
        });

        if (extractImdbId(normalizedId)) {
            const results = normalizedType === 'movie' ? payload?.movie_results : payload?.tv_results;
            return Array.isArray(results) && results.length > 0 ? results[0] : null;
        }

        return payload;
    } catch (error) {
        console.error('[CinemaCity] TMDB metadata error:', error.message);
        return null;
    }
}

async function resolveImdbFromTmdb(tmdbId, providerType) {
    const cleanTmdbId = extractTmdbId(tmdbId);
    if (!cleanTmdbId) return null;

    try {
        if (providerType === 'movie') {
            const payload = await fetchJson(`https://api.themoviedb.org/3/movie/${cleanTmdbId}?api_key=${TMDB_API_KEY}`, {
                headers: {
                    Accept: 'application/json'
                }
            });
            return extractImdbId(payload?.imdb_id);
        }

        const payload = await fetchJson(`https://api.themoviedb.org/3/tv/${cleanTmdbId}/external_ids?api_key=${TMDB_API_KEY}`, {
            headers: {
                Accept: 'application/json'
            }
        });
        return extractImdbId(payload?.imdb_id);
    } catch (error) {
        console.error('[CinemaCity] TMDB to IMDb resolution error:', error.message);
        return null;
    }
}

async function searchByImdb(imdbId) {
    const normalizedImdbId = extractImdbId(imdbId);
    if (!normalizedImdbId) return null;

    const trySearch = async (query) => {
        const searchUrl = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
        try {
            const html = await fetchHtml(searchUrl, {
                Referer: `${BASE_URL}/`,
                Cookie: SESSION_COOKIE
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

async function buildAnimeSearchContext(meta = {}, originalId, finalId) {
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
            .filter((candidate) => scoreTitleMatch(candidate.title, expectedTitles) > 0);

        const bestSitemap = await pickBestCandidate(sitemapCandidates, expectedTitles, {
            requestedImdbId,
            expectedYear,
            providerType
        });
        if (bestSitemap?.url) {
            return bestSitemap;
        }
    } catch (_) {}

    let bestResult = null;
    let bestScore = 0;
    for (const listingBase of getListingBaseUrls(providerType)) {
        for (let page = 1; page <= MAX_LISTING_PAGES; page += 1) {
            const pageUrl = page === 1 ? listingBase : `${listingBase}page/${page}/`;

            try {
                const html = await fetchHtml(pageUrl, {
                    Referer: `${BASE_URL}/`,
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-User': '?1'
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

function extractJsonArray(decoded) {
    let start = decoded.indexOf('file:');
    if (start === -1) start = decoded.indexOf('sources:');
    if (start === -1) return null;

    start = decoded.indexOf('[', start);
    if (start === -1) return null;

    let depth = 0;
    for (let index = start; index < decoded.length; index += 1) {
        if (decoded[index] === '[') depth += 1;
        else if (decoded[index] === ']') depth -= 1;
        if (depth === 0) return decoded.substring(start, index + 1);
    }

    return null;
}

function resolveUrl(baseUrl, relativeOrAbsoluteUrl) {
    try {
        return new URL(relativeOrAbsoluteUrl, baseUrl).toString();
    } catch (_) {
        return relativeOrAbsoluteUrl;
    }
}

function getOrigin(url) {
    try {
        return new URL(url).origin;
    } catch (_) {
        return BASE_URL;
    }
}

function extractPlayerReferer(html, pageUrl) {
    const iframeMatch = String(html || '').match(/<iframe[^>]+src=["']([^"']*player\.php[^"']*)["']/i);
    if (!iframeMatch || !iframeMatch[1]) return pageUrl;
    return resolveUrl(pageUrl, iframeMatch[1]);
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

function pickStream(fileData, type, season = 1, episode = 1) {
    if (typeof fileData === 'string') return fileData;

    if (Array.isArray(fileData)) {
        if (
            type === 'movie'
            || fileData.every((entry) => entry && typeof entry === 'object' && 'file' in entry && !('folder' in entry))
        ) {
            return fileData[0]?.file || null;
        }

        let selectedSeasonFolder = null;
        for (const seasonEntry of fileData) {
            if (!seasonEntry || typeof seasonEntry !== 'object' || !seasonEntry.folder) continue;
            const title = String(seasonEntry.title || '').toLowerCase();
            const seasonRegex = new RegExp(`(?:season|stagione|s)\\s*0*${season}\\b`, 'i');
            if (seasonRegex.test(title)) {
                selectedSeasonFolder = seasonEntry.folder;
                break;
            }
        }

        if (!selectedSeasonFolder) {
            selectedSeasonFolder = fileData.find((entry) => entry && entry.folder)?.folder || null;
        }
        if (!selectedSeasonFolder) return null;

        let selectedEpisodeFile = null;
        for (const episodeEntry of selectedSeasonFolder) {
            if (!episodeEntry || typeof episodeEntry !== 'object' || !episodeEntry.file) continue;
            const title = String(episodeEntry.title || '').toLowerCase();
            const episodeRegex = new RegExp(`(?:episode|episodio|e)\\s*0*${episode}\\b`, 'i');
            if (episodeRegex.test(title)) {
                selectedEpisodeFile = episodeEntry.file;
                break;
            }
        }

        if (!selectedEpisodeFile) {
            const index = Math.max(0, episode - 1);
            const episodeEntry = selectedSeasonFolder[index] || selectedSeasonFolder[0];
            selectedEpisodeFile = episodeEntry?.file || null;
        }

        return selectedEpisodeFile;
    }

    return null;
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
        meta?.kitsu_id ? `kitsu:${meta.kitsu_id}` : null,
        meta?.kitsuId ? `kitsu:${meta.kitsuId}` : null
    ].filter(Boolean);
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

    if (isSeries && (contextKitsuId || looksLikeAnimeMeta(meta))) {
        animeContext = await buildAnimeSearchContext(meta, originalId, finalId);
        if (animeContext?.seasonNumber) season = animeContext.seasonNumber;
        if (animeContext?.requestedEpisode) episode = animeContext.requestedEpisode;
        providerType = 'anime';
    }

    if (String(workingId || '').startsWith('kitsu:') || contextKitsuId) {
        const kitsuId = contextKitsuId || extractKitsuId(workingId);
        const mapped = await getIdsFromKitsu(kitsuId, isSeries ? season : null, isSeries ? episode : 1, config);
        if (mapped) {
            if (mapped.tmdbId) resolvedTmdbId = mapped.tmdbId;
            if (mapped.imdbId) {
                workingId = mapped.imdbId;
            } else if (mapped.tmdbId) {
                workingId = mapped.tmdbId;
            }

            if (mapped.mappedSeason && mapped.mappedEpisode) {
                season = mapped.mappedSeason;
                episode = mapped.mappedEpisode;
            } else if (mapped.rawEpisodeNumber) {
                episode = mapped.rawEpisodeNumber;
            }
        }
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

function buildDisplayTitle(meta = {}, fallbackTitle, season, episode) {
    const baseTitle = decodeHtmlEntities(
        meta?.title
        || meta?.name
        || meta?.originalTitle
        || fallbackTitle
        || 'CinemaCity'
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
        ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}`
        : '';
    const refererQuery = headers?.Referer ? `&h_Referer=${encodeURIComponent(headers.Referer)}` : '';
    const originQuery = headers?.Origin ? `&h_Origin=${encodeURIComponent(headers.Origin)}` : '';

    if (isHls) {
        return `${mfpBase}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(normalizedTarget)}${passwordQuery}${refererQuery}${originQuery}`;
    }

    return `${mfpBase}/proxy/stream?d=${encodeURIComponent(normalizedTarget)}${passwordQuery}${refererQuery}${originQuery}`;
}

async function parseCinemaCityStream(pageUrl, meta = {}) {
    const html = await fetchHtml(pageUrl, {
        Referer: `${BASE_URL}/`,
        Cookie: SESSION_COOKIE
    });
    const playerReferer = extractPlayerReferer(html, pageUrl);
    const atobRegex = /atob\s*\(\s*['"](.*?)['"]\s*\)/gi;
    let match;
    let fileData = null;

    while ((match = atobRegex.exec(html)) !== null) {
        const encoded = match[1];
        if (!encoded || encoded.length < 50) continue;

        let decoded = '';
        try {
            decoded = Buffer.from(encoded, 'base64').toString('utf8');
        } catch (_) {
            continue;
        }
        if (!decoded) continue;

        if (decoded.trim().startsWith('[')) {
            try {
                fileData = JSON.parse(decoded);
            } catch (_) {}
        }

        if (!fileData) {
            const rawJson = extractJsonArray(decoded);
            if (rawJson) {
                try {
                    fileData = JSON.parse(rawJson.replace(/\\(.)/g, '$1'));
                } catch (_) {
                    try {
                        fileData = JSON.parse(rawJson);
                    } catch (_) {}
                }
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

    return {
        streamUrl,
        headers: {
            'User-Agent': USER_AGENT,
            Referer: playerReferer,
            Origin: getOrigin(pageUrl),
            Accept: '*/*',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            Cookie: SESSION_COOKIE
        }
    };
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
                resolved.providerType,
                meta,
                titleFallbackOptions
            );
        }

        if (!searchResult?.url && resolved.imdbId) {
            searchResult = await searchByImdb(resolved.imdbId);
        }
        if (!searchResult?.url) {
            searchResult = await searchByTitleFallback(
                resolved.tmdbId || resolved.imdbId || originalId,
                resolved.providerType,
                meta,
                titleFallbackOptions
            );
        }
        if (!searchResult?.url) return [];

        const enrichedMeta = {
            ...meta,
            season: resolved.season,
            episode: resolved.episode
        };
        const extracted = await parseCinemaCityStream(searchResult.url, enrichedMeta);
        if (!extracted?.streamUrl) return [];

        let quality = normalizeQuality('1080p');
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
        const displayTitle = buildDisplayTitle(meta, searchResult.title, resolved.season, resolved.episode);
        const mediaflowProxyUrl = buildCinemaCityProxyUrl(config, extracted.streamUrl, extracted.headers, isHlsStream);

        const streams = [];

        if (mediaflowProxyUrl) {
            streams.push(buildWebStream({
                name: '🏙️ CinemaCity | CCCDN',
                title: `${displayTitle}\n☁️ CCCDN • 🇮🇹 ITA`,
                url: mediaflowProxyUrl,
                extractor: 'CCCDN',
                provider: 'CinemaCity',
                providerCode: 'CC',
                quality,
                headers: null,
                notWebReady: false,
                extraBehaviorHints: {
                    bingeWatching: true
                }
            }));
        }

        if (streams.length === 0) {
            streams.push(buildWebStream({
                name: '🏙️ CinemaCity | Direct',
                title: `${displayTitle}\n☁️ ${extractorLabel} • 🇮🇹 ITA`,
                url: extracted.streamUrl,
                extractor: extractorLabel,
                provider: 'CinemaCity',
                providerCode: 'CC',
                quality,
                headers: extracted.headers,
                notWebReady: true,
                extraBehaviorHints: {
                    bingeWatching: true
                }
            }));
        }

        return dedupeStreamsByUrl(streams).sort((left, right) => qualityRank(right.quality) - qualityRank(left.quality));
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
        getListingBaseUrls
    }
};
