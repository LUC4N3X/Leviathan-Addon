'use strict';

const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const {
    buildWebStream,
    dedupeStreamsByUrl
} = require('../extractors/common');
const { getMediaflowBase } = require('../../core/proxy/mediaflow_gateway');

const HTTP_FETCH_TIMEOUT = 30000;

function createTimeoutSignal(timeoutMs) {
    const parsed = Number.parseInt(String(timeoutMs), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return { signal: undefined, cleanup: null, timed: false };
    }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return { signal: AbortSignal.timeout(parsed), cleanup: null, timed: true };
    }
    if (typeof AbortController !== 'undefined' && typeof setTimeout === 'function') {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), parsed);
        return {
            signal: controller.signal,
            cleanup: () => clearTimeout(timeoutId),
            timed: true
        };
    }
    return { signal: undefined, cleanup: null, timed: false };
}

async function fetchWithTimeout(url, options = {}) {
    if (typeof fetch !== 'function') {
        throw new Error('No fetch implementation found!');
    }

    const { timeout, ...fetchOptions } = options;
    const requestTimeout = timeout || HTTP_FETCH_TIMEOUT;
    const timeoutConfig = createTimeoutSignal(requestTimeout);
    const requestOptions = { ...fetchOptions };

    if (timeoutConfig.signal) {
        if (requestOptions.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
            requestOptions.signal = AbortSignal.any([requestOptions.signal, timeoutConfig.signal]);
        } else if (!requestOptions.signal) {
            requestOptions.signal = timeoutConfig.signal;
        }
    }

    try {
        return await fetch(url, requestOptions);
    } catch (error) {
        if (error && error.name === 'AbortError' && timeoutConfig.timed) {
            throw new Error(`Request to ${url} timed out after ${requestTimeout}ms`);
        }
        throw error;
    } finally {
        if (typeof timeoutConfig.cleanup === 'function') {
            timeoutConfig.cleanup();
        }
    }
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

function base64Decode(str) {
    try {
        if (typeof atob === 'function') {
            return decodeURIComponent(escape(atob(str)));
        }
    } catch (_) {}

    try {
        let output = '';
        let buffer = 0;
        let bits = 0;
        const input = String(str || '').replace(/[^A-Za-z0-9+/=]/g, '');
        for (let i = 0; i < input.length; i++) {
            const char = input.charAt(i);
            if (char === '=') break;
            const value = BASE64_CHARS.indexOf(char);
            if (value < 0) continue;
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                output += String.fromCharCode((buffer >> bits) & 0xff);
            }
        }
        try {
            return decodeURIComponent(escape(output));
        } catch (_) {
            return output;
        }
    } catch (e) {
        console.error('[CinemaCity] Base64 decode error:', e);
        return '';
    }
}

const BASE_URL = base64Decode('aHR0cHM6Ly9jaW5lbWFjaXR5LmNj');
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const FETCH_TIMEOUT = 10000;
const TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';
const SITEMAP_URL = `${BASE_URL}/news_pages.xml`;
const SITEMAP_CACHE_MS = 60 * 60 * 1000;
const WORKER_HOST = base64Decode('Y2MubGVhbmhodTA2MTIwNi53b3JrZXJzLmRldg==');

let sitemapCache = null;

function getMappingApiUrl() {
    return 'https://anime.questoleviatanormio.dpdns.org';
}

function normalizeConfigBoolean(value) {
    if (value === true) return true;
    const normalized = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled', 'checked'].includes(normalized);
}

function getMappingLanguage(providerContext = null) {
    const explicit = String(providerContext?.mappingLanguage || '').trim().toLowerCase();
    if (explicit === 'it') return 'it';
    return normalizeConfigBoolean(providerContext?.easyCatalogsLangIt) ? 'it' : null;
}

async function fetchViaWorker(url) {
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    const targetUrl = (`https://${WORKER_HOST}`).replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
    const response = await fetchWithTimeout(targetUrl, {
        timeout: FETCH_TIMEOUT,
        headers: { 'User-Agent': USER_AGENT }
    });
    if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
    return await response.text();
}

function decodeHtmlEntities(str) {
    return String(str || '')
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&ndash;|&mdash;/g, '-')
        .replace(/\u2013|\u2014/g, '-');
}

function getHttpStatusFromError(error) {
    const responseStatus = Number.parseInt(String(error?.response?.status || ''), 10);
    if (Number.isInteger(responseStatus)) return responseStatus;
    const match = String(error && error.message ? error.message : error).match(/HTTP\s+(\d+)/i);
    return match ? Number.parseInt(match[1], 10) : null;
}

function isCloudflareBlockedError(error) {
    const message = [error?.message, error?.response?.data?.message, error?.response?.data].filter(Boolean).join(' ');
    return /Cloudflare has blocked this request|Error solving the challenge/i.test(message);
}

function normalizeTitle(value) {
    return decodeHtmlEntities(String(value || ''))
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function compactTitle(value) {
    return normalizeTitle(value).replace(/\s+/g, '');
}

function extractYearFromMetadata(metadata) {
    const date = metadata?.release_date || metadata?.first_air_date || '';
    const year = Number.parseInt(String(date).slice(0, 4), 10);
    return Number.isInteger(year) ? year : null;
}

function getSignificantTokens(value) {
    const stopwords = new Set([
        'the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'at', 'by', 'is', 'it',
        'il', 'lo', 'la', 'gli', 'le', 'un', 'uno', 'una', 'di', 'da', 'del', 'della',
        'dei', 'e', 'o', 'con', 'per', 'su', 'tra', 'fra'
    ]);
    return normalizeTitle(value)
        .split(/\s+/)
        .filter((token) => token.length > 1 && !stopwords.has(token));
}

function parseSitemapEntries(xml) {
    const entries = [];
    const regex = /<loc>(https:\/\/cinemacity\.cc\/(movies|tv-series)\/\d+-([a-z0-9-]+)\.html)<\/loc>/gi;
    let match;

    while ((match = regex.exec(String(xml || ''))) !== null) {
        const url = match[1];
        const kind = match[2];
        const slug = match[3];
        const yearMatch = slug.match(/-(\d{4})$/);
        const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;
        const titleSlug = yearMatch ? slug.slice(0, -5) : slug;
        const title = titleSlug.replace(/-/g, ' ');
        entries.push({
            url,
            kind,
            title,
            normalizedTitle: normalizeTitle(title),
            compactTitle: compactTitle(title),
            tokens: getSignificantTokens(title),
            year: Number.isInteger(year) ? year : null
        });
    }

    return entries;
}

async function fetchSitemapEntries(providerContext = null) {
    if (sitemapCache && sitemapCache.expiresAt > Date.now()) {
        return sitemapCache.entries;
    }

    console.log('[CinemaCity] Fetching sitemap catalog...');
    const sitemapProxy = `https://${WORKER_HOST}`;
    const sitemapPath = SITEMAP_URL.startsWith('http') ? new URL(SITEMAP_URL).pathname : SITEMAP_URL;

    const firstPageUrl = sitemapProxy.endsWith('/')
        ? `${sitemapProxy.slice(0, -1)}${sitemapPath}?page=1&perPage=500`
        : `${sitemapProxy}${sitemapPath}?page=1&perPage=500`;
    console.log(`[CinemaCity] Fetching sitemap page 1 via CF Proxy: ${firstPageUrl}`);
    const firstResp = await fetchWithTimeout(firstPageUrl, {
        timeout: FETCH_TIMEOUT,
        headers: { 'User-Agent': USER_AGENT }
    });

    if (firstResp.ok) {
        const totalEntries = parseInt(firstResp.headers.get('x-total-entries') || '0', 10);
        const firstXml = await firstResp.text();
        let allEntries = parseSitemapEntries(firstXml);

        if (totalEntries > 0) {
            const perPage = 500;
            const totalPages = Math.ceil(totalEntries / perPage);
            const pageFetches = [];
            for (let p = 2; p <= totalPages; p++) {
                const pageUrl = sitemapProxy.endsWith('/')
                    ? `${sitemapProxy.slice(0, -1)}${sitemapPath}?page=${p}&perPage=500`
                    : `${sitemapProxy}${sitemapPath}?page=${p}&perPage=500`;
                pageFetches.push(
                    fetchWithTimeout(pageUrl, { timeout: FETCH_TIMEOUT, headers: { 'User-Agent': USER_AGENT } })
                        .then((r) => (r.ok ? r.text() : ''))
                        .then((xml) => {
                            if (xml) allEntries = allEntries.concat(parseSitemapEntries(xml));
                        })
                        .catch(() => {})
                );
            }
            await Promise.all(pageFetches);
        } else if (allEntries.length >= 1800) {
            console.log(`[CinemaCity] Full sitemap received (${allEntries.length} entries)`);
            sitemapCache = { entries: allEntries, expiresAt: Date.now() + SITEMAP_CACHE_MS };
            return allEntries;
        }

        if (allEntries.length > 0) {
            sitemapCache = { entries: allEntries, expiresAt: Date.now() + SITEMAP_CACHE_MS };
            console.log(`[CinemaCity] Sitemap catalog loaded: ${allEntries.length} entries`);
            return allEntries;
        }
    }

    const targetUrl = sitemapProxy.endsWith('/')
        ? `${sitemapProxy}${sitemapPath.replace(/^\//, '')}`
        : `${sitemapProxy}${sitemapPath}`;
    console.log(`[CinemaCity] Fetching sitemap via CF Proxy (full): ${targetUrl}`);
    const response = await fetchWithTimeout(targetUrl, {
        timeout: FETCH_TIMEOUT,
        headers: { 'User-Agent': USER_AGENT }
    });
    if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
    const xml = await response.text();
    const entries = parseSitemapEntries(xml);
    sitemapCache = { entries, expiresAt: Date.now() + SITEMAP_CACHE_MS };
    console.log(`[CinemaCity] Sitemap catalog loaded: ${entries.length} entries`);
    return entries;
}

function scoreSitemapEntry(entry, expectedTitles, expectedYear) {
    let bestScore = 0;

    for (const title of expectedTitles) {
        const normalized = normalizeTitle(title);
        const compact = compactTitle(title);
        if (!normalized || !compact) continue;

        let score = 0;
        if (entry.normalizedTitle === normalized || entry.compactTitle === compact) {
            score = 1000;
        } else if (entry.normalizedTitle.startsWith(normalized) || normalized.startsWith(entry.normalizedTitle)) {
            score = 500;
        } else if (entry.compactTitle.includes(compact) || compact.includes(entry.compactTitle)) {
            score = 420;
        } else {
            const expectedTokens = getSignificantTokens(title);
            if (expectedTokens.length > 0 && entry.tokens.length > 0) {
                let hits = 0;
                const entryTokenSet = new Set(entry.tokens);
                for (const token of expectedTokens) {
                    if (entryTokenSet.has(token)) hits++;
                }
                const coverage = hits / expectedTokens.length;
                const extraTokens = Math.max(0, entry.tokens.length - expectedTokens.length);
                score = coverage * 300 - extraTokens * 20 - Math.abs(entry.tokens.length - expectedTokens.length) * 2;
            }
        }

        if (expectedYear && entry.year) {
            score += entry.year === expectedYear ? 50 : -Math.abs(entry.year - expectedYear) * 3;
        }

        bestScore = Math.max(bestScore, score);
    }

    return bestScore;
}

function extractImdbIdFromHtml(html) {
    const matches = String(html || '').match(/\btt\d{5,}\b/gi) || [];
    for (const match of matches) {
        if (/^tt\d{5,}$/i.test(match)) {
            return match.toLowerCase();
        }
    }
    return null;
}

async function verifyCandidateImdb(candidateUrl, expectedImdbId) {
    const normalizedExpected = String(expectedImdbId || '').trim().toLowerCase();
    if (!/^tt\d{5,}$/.test(normalizedExpected)) {
        return null;
    }

    try {
        const html = await fetchViaWorker(candidateUrl);
        const imdbId = extractImdbIdFromHtml(html);
        if (imdbId) {
            console.log(`[CinemaCity] IMDb check ${candidateUrl}: ${imdbId}`);
        }
        return imdbId;
    } catch (e) {
        const status = getHttpStatusFromError(e);
        if (status !== 403 && status !== 503 && !isCloudflareBlockedError(e)) {
            console.error(`[CinemaCity] IMDb check error for ${candidateUrl}:`, e);
        }
        return null;
    }
}

async function searchBySitemap(id, providerType, providerContext = null) {
    const expectedImdbId = /^tt\d{5,}$/i.test(String(id || '').trim())
        ? String(id).trim().toLowerCase()
        : null;
    const metadata = await getTmdbMetadata(id, providerType);
    const expectedTitles = Array.from(new Set([
        metadata?.title,
        metadata?.name,
        metadata?.original_title,
        metadata?.original_name
    ].filter(Boolean)));

    if (expectedTitles.length === 0) {
        return null;
    }

    const expectedYear = extractYearFromMetadata(metadata);
    const expectedKind = providerType === 'movie' ? 'movies' : 'tv-series';

    let entries;
    try {
        entries = await fetchSitemapEntries(providerContext);
    } catch (e) {
        const status = getHttpStatusFromError(e);
        if (status === 403 || status === 404 || status === 503 || isCloudflareBlockedError(e)) {
            console.warn(`[CinemaCity] Sitemap fetch failed: HTTP ${status || 'unknown/Cloudflare'}`);
        } else {
            console.warn(`[CinemaCity] Sitemap fetch failed: ${e.message || e}`);
        }
        return null;
    }

    let bestEntry = null;
    let bestScore = -Infinity;
    const ranked = [];

    for (const entry of entries) {
        if (entry.kind !== expectedKind) continue;
        const score = scoreSitemapEntry(entry, expectedTitles, expectedYear);
        if (score >= 250) {
            ranked.push({ entry, score });
        }
        if (score > bestScore) {
            bestScore = score;
            bestEntry = entry;
        }
    }

    if (!bestEntry || bestScore < 250) {
        console.log(`[CinemaCity] Sitemap no confident match for ${expectedTitles.join(' / ')} (best=${Math.round(bestScore)})`);
        return null;
    }

    if (expectedImdbId) {
        ranked.sort((a, b) => b.score - a.score);
        const candidatesToVerify = ranked.slice(0, 3);
        for (const candidate of candidatesToVerify) {
            const candidateImdbId = await verifyCandidateImdb(candidate.entry.url, expectedImdbId);
            if (candidateImdbId === expectedImdbId) {
                console.log(`[CinemaCity] Sitemap IMDb verified: ${expectedTitles[0]} -> ${candidate.entry.url}`);
                return {
                    url: candidate.entry.url,
                    title: expectedTitles[0] || candidate.entry.title
                };
            }
            if (candidateImdbId && candidateImdbId !== expectedImdbId) {
                console.log(`[CinemaCity] Sitemap IMDb mismatch: ${candidate.entry.url} has ${candidateImdbId}, expected ${expectedImdbId}`);
            }
        }

        const isHighConfidence = bestScore >= 950;
        if (!isHighConfidence) {
            console.log(`[CinemaCity] Sitemap match not IMDb verified for ${expectedTitles.join(' / ')} (best=${Math.round(bestScore)})`);
            return null;
        }
    }

    console.log(`[CinemaCity] Sitemap match: ${expectedTitles[0]} -> ${bestEntry.url} [score=${Math.round(bestScore)}]`);
    return {
        url: bestEntry.url,
        title: expectedTitles[0] || bestEntry.title
    };
}

async function getTmdbMetadata(id, providerType) {
    try {
        let metadataUrl = null;
        const normalizedId = String(id || '').trim();
        const normalizedType = providerType === 'movie' ? 'movie' : 'tv';

        if (/^tt\d+$/i.test(normalizedId)) {
            metadataUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(normalizedId)}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=en-US`;
        } else if (/^\d+$/.test(normalizedId)) {
            metadataUrl = `https://api.themoviedb.org/3/${normalizedType}/${normalizedId}?api_key=${TMDB_API_KEY}&language=en-US`;
        }

        if (!metadataUrl) return null;

        const response = await fetchWithTimeout(metadataUrl, { timeout: FETCH_TIMEOUT });
        if (!response.ok) return null;

        const payload = await response.json();
        if (/^tt\d+$/i.test(normalizedId)) {
            const results = normalizedType === 'movie' ? payload?.movie_results : payload?.tv_results;
            return Array.isArray(results) && results.length > 0 ? results[0] : null;
        }

        return payload;
    } catch (e) {
        console.error('[CinemaCity] TMDB metadata error:', e);
        return null;
    }
}

async function getIdsFromKitsu(kitsuId, season, episode, providerContext = null) {
    try {
        if (!kitsuId) return null;

        const params = new URLSearchParams();
        const parsedEpisode = Number.parseInt(String(episode || ''), 10);
        const parsedSeason = Number.parseInt(String(season || ''), 10);
        params.set('ep', Number.isInteger(parsedEpisode) && parsedEpisode > 0 ? String(parsedEpisode) : '1');
        if (Number.isInteger(parsedSeason) && parsedSeason >= 0) {
            params.set('s', String(parsedSeason));
        }

        const mappingLanguage = getMappingLanguage(providerContext);
        if (mappingLanguage) {
            params.set('lang', mappingLanguage);
        }

        const url = `${getMappingApiUrl()}/kitsu/${encodeURIComponent(String(kitsuId).trim())}?${params.toString()}`;
        const response = await fetchWithTimeout(url, { timeout: FETCH_TIMEOUT });
        if (!response.ok) return null;

        const payload = await response.json();
        const ids = payload?.mappings?.ids || {};
        const tmdbEpisode =
            payload?.mappings?.tmdb_episode
            || payload?.mappings?.tmdbEpisode
            || payload?.tmdb_episode
            || payload?.tmdbEpisode
            || null;
        const tmdbId = ids && /^\d+$/.test(String(ids.tmdb || '').trim()) ? String(ids.tmdb).trim() : null;
        const imdbId = ids && /^tt\d+$/i.test(String(ids.imdb || '').trim()) ? String(ids.imdb).trim() : null;
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
            tmdbId,
            imdbId,
            mappedSeason: Number.isInteger(mappedSeason) && mappedSeason > 0 ? mappedSeason : null,
            mappedEpisode: Number.isInteger(mappedEpisode) && mappedEpisode > 0 ? mappedEpisode : null,
            rawEpisodeNumber: Number.isInteger(rawEpisodeNumber) && rawEpisodeNumber > 0 ? rawEpisodeNumber : null
        };
    } catch (e) {
        console.error('[CinemaCity] Kitsu mapping error:', e);
        return null;
    }
}

function parseCompositeSeriesId(rawId, season, episode) {
    const parsed = {
        normalizedId: String(rawId || '').trim(),
        season: Number.isInteger(season) ? season : (Number.parseInt(season, 10) || 1),
        episode: Number.isInteger(episode) ? episode : (Number.parseInt(episode, 10) || 1)
    };
    const match = parsed.normalizedId.match(/^(tt\d+|\d+|tmdb:\d+):(\d+):(\d+)$/i);
    if (match) {
        parsed.normalizedId = match[1];
        parsed.season = Number.parseInt(match[2], 10) || parsed.season;
        parsed.episode = Number.parseInt(match[3], 10) || parsed.episode;
    }
    return parsed;
}

function buildDownloadUrl(fileVal) {
    const baseEnd = fileVal.indexOf('/public_files/');
    if (baseEnd === -1) return null;
    const cdnBase = fileVal.substring(0, baseEnd + '/public_files/'.length);
    const rest = fileVal.substring(baseEnd + '/public_files/'.length);

    const parts = rest.split(',');
    const video = parts.find((p) => p.includes('1080p') && p.endsWith('.mp4')) || parts.find((p) => p.endsWith('.mp4'));
    if (!video) return null;

    const itaAudio = parts.find((p) => /italian|italiano/i.test(p) && p.endsWith('.m4a'));
    const m3u8Entry = parts.find((p) => p.includes('.m3u8'));
    const url = cdnBase + rest + (m3u8Entry ? '' : '.urlset/master.m3u8');
    return { url, hasItalian: !!itaAudio };
}

function extractStreamFromAtob(html, season, episode) {
    const atobRegex = /atob\s*\(\s*['"]([^"']{20,})['"]\s*\)/gi;
    let match;
    while ((match = atobRegex.exec(html)) !== null) {
        try {
            const decoded = base64Decode(match[1]);
            if (!decoded || decoded.length < 20) continue;

            const jsonMatch = decoded.match(/file\s*:\s*'(\[.*?\])'/s);
            if (!jsonMatch) continue;

            try {
                const parsed = JSON.parse(jsonMatch[1]);
                if (!Array.isArray(parsed) || parsed.length === 0) continue;

                if (parsed[0].folder && Array.isArray(parsed[0].folder)) {
                    const seasonIdx = (season || 1) - 1;
                    const s = parsed[seasonIdx];
                    if (s?.folder) {
                        const epIdx = (episode || 1) - 1;
                        const ep = s.folder[epIdx];
                        if (ep?.file) {
                            const dlUrl = buildDownloadUrl(ep.file);
                            if (dlUrl) return dlUrl;
                        }
                    }
                }

                const fileVal = parsed[0].file;
                if (fileVal && fileVal.startsWith('http')) {
                    const dlUrl = buildDownloadUrl(fileVal);
                    if (dlUrl) return dlUrl;
                }
            } catch (_) {}
        } catch (_) {}
    }
    return null;
}

function extractDownloadLinks(html) {
    const links = [];
    const anchorRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
        const href = match[1].trim();
        const innerText = match[2].replace(/<[^>]+>/g, '').trim();
        if (!/\.(mp4|m3u8|mkv|avi|mov|webm)([?#].*)?$/i.test(href)) continue;
        if (href.length < 10) continue;
        links.push({ url: href, text: innerText.toLowerCase() });
    }
    return links;
}

function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).toString();
    } catch (_) {
        return relative;
    }
}

function buildProviderContext(meta = {}, config = {}) {
    const filters = config?.filters || {};
    const langIt = filters.language === 'ita'
        || filters.language === 'it'
        || filters.easyCatalogsLangIt === true
        || (filters.allowEng !== true && filters.language !== 'eng');

    let kitsuId = null;
    for (const candidate of [meta?.kitsu_id, meta?.kitsuId, meta?.id, meta?.imdb_id]) {
        const text = String(candidate || '').trim();
        const kitsuMatch = text.match(/^kitsu:(\d+)/i);
        if (kitsuMatch) {
            kitsuId = kitsuMatch[1];
            break;
        }
        if (/^\d+$/.test(text) && String(meta?.type || '').toLowerCase() === 'anime') {
            kitsuId = text;
            break;
        }
    }

    return {
        tmdbId: meta?.tmdb_id || meta?.tmdbId || null,
        imdbId: meta?.imdb_id || meta?.imdbId || null,
        kitsuId,
        seasonProvided: meta?.season !== undefined && meta?.season !== null,
        easyCatalogsLangIt: langIt,
        mappingLanguage: langIt ? 'it' : null
    };
}

async function getEasystreamsStreams(id, type, season, episode, providerContext = null) {
    const parsedRequest = parseCompositeSeriesId(id, season, episode);
    id = parsedRequest.normalizedId;
    season = parsedRequest.season;
    episode = parsedRequest.episode;

    let imdbId = String(id || '').trim();
    const providerType = (type === 'tv' || type === 'series' || type === 'anime') ? 'tv' : 'movie';
    const contextTmdbId = providerContext && /^\d+$/.test(String(providerContext.tmdbId || ''))
        ? String(providerContext.tmdbId)
        : null;
    const contextImdbId = providerContext && /^tt\d+$/i.test(String(providerContext.imdbId || ''))
        ? String(providerContext.imdbId)
        : null;
    const contextKitsuId = providerContext && /^\d+$/.test(String(providerContext.kitsuId || ''))
        ? String(providerContext.kitsuId)
        : null;
    const shouldIncludeSeasonHintForKitsu = providerContext && providerContext.seasonProvided === true;

    if (imdbId.startsWith('kitsu:') || contextKitsuId) {
        const kitsuId = contextKitsuId || ((imdbId.match(/^kitsu:(\d+)/i) || [])[1] || null);
        const seasonHintForKitsu = shouldIncludeSeasonHintForKitsu ? season : null;
        const mapped = kitsuId ? await getIdsFromKitsu(kitsuId, seasonHintForKitsu, episode, providerContext) : null;

        if (mapped) {
            if (mapped.imdbId) {
                imdbId = mapped.imdbId;
            } else if (mapped.tmdbId) {
                imdbId = mapped.tmdbId;
            }
            if (mapped.mappedSeason && mapped.mappedEpisode) {
                season = mapped.mappedSeason;
                episode = mapped.mappedEpisode;
            } else if (mapped.rawEpisodeNumber) {
                episode = mapped.rawEpisodeNumber;
            }
        }
    }

    if (!imdbId.startsWith('tt') && contextImdbId) {
        imdbId = contextImdbId;
    } else if (!/^\d+$/.test(imdbId) && contextTmdbId) {
        imdbId = contextTmdbId;
    }

    if (!imdbId.startsWith('tt')) {
        if (providerContext?.imdbId?.startsWith('tt')) {
            imdbId = providerContext.imdbId;
        } else {
            try {
                const tmdbId = imdbId.replace(/\D/g, '');
                if (tmdbId) {
                    const externalUrl = providerType === 'movie'
                        ? `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`
                        : `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
                    const response = await fetchWithTimeout(externalUrl, { timeout: FETCH_TIMEOUT });
                    if (response.ok) {
                        const data = await response.json();
                        if (data.imdb_id) {
                            imdbId = data.imdb_id;
                        }
                    }
                }
            } catch (e) {
                console.error('[CinemaCity] TMDB to IMDb resolution error:', e);
            }
        }
    }

    if (!imdbId.startsWith('tt')) {
        return [];
    }

    try {
        const searchResult = await searchBySitemap(imdbId, providerType, providerContext);
        if (!searchResult?.url) {
            return [];
        }

        const movieUrl = searchResult.url;
        const movieTitle = (searchResult.title || imdbId).replace(/\s*\(.*?\)\s*/g, '').trim();
        const title = (type === 'tv' || type === 'series')
            ? `${movieTitle} ${season}x${episode}`
            : movieTitle;

        let html;
        try {
            html = await fetchViaWorker(movieUrl);
        } catch (e) {
            console.warn(`[CinemaCity] Worker fetch failed: ${e.message}`);
            return [];
        }

        if (html.length < 500 || html.includes('Just a moment') || (html.includes('admin') && html.includes('Unlimited'))) {
            console.warn(`[CinemaCity] Page blocked or empty (${html.length} chars)`);
            return [];
        }

        const links = extractDownloadLinks(html);
        let hasItalian = false;
        if (links.length === 0) {
            const useSeason = providerType === 'tv' ? season : null;
            const useEpisode = providerType === 'tv' ? episode : null;
            const atobResult = extractStreamFromAtob(html, useSeason, useEpisode);
            if (atobResult) {
                links.push({ url: atobResult.url, text: '' });
                hasItalian = atobResult.hasItalian;
            }
        }

        if (links.length === 0) {
            console.log('[CinemaCity] No streams available');
            return [];
        }

        let selectedUrl = null;
        for (const link of links) {
            const text = link.text;
            if (text.includes('ita') || text.includes('italian') || text.includes('italiano')) {
                selectedUrl = link.url;
                hasItalian = true;
                break;
            }
        }
        if (!selectedUrl) {
            for (const link of links) {
                if (link.text.includes('eng') || link.text.includes('sub')) continue;
                selectedUrl = link.url;
                break;
            }
        }
        if (!selectedUrl) selectedUrl = links[0].url;

        const streamUrl = resolveUrl(movieUrl, selectedUrl);
        console.log(`[CinemaCity] Direct stream: ${streamUrl}`);

        return [{
            name: 'CinemaCity',
            title,
            url: streamUrl,
            quality: '1080p',
            type: 'hls',
            language: hasItalian ? 'Italian' : '',
            behaviorHints: { notWebReady: true },
            headers: {
                Referer: 'https://cinemacity.cc/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            }
        }];
    } catch (e) {
        console.error('[CinemaCity] Error:', e);
        return [];
    }
}

async function searchCinemaCityImpl(originalId, finalId, meta = {}, config = {}, reqHost = null) {
    try {
        const season = Number.parseInt(String(meta?.season ?? ''), 10) || 1;
        const episode = Number.parseInt(String(meta?.episode ?? ''), 10) || 1;
        const compositeId = meta?.imdb_id && (meta?.isSeries || String(meta?.type || '').toLowerCase() !== 'movie')
            ? `${meta.imdb_id}:${season}:${episode}`
            : null;
        const id = String(
            finalId
            || originalId
            || compositeId
            || meta?.id
            || meta?.imdb_id
            || meta?.tmdb_id
            || ''
        ).trim();
        if (!id) return [];

        const type = String(meta?.type || (meta?.isSeries ? 'series' : 'movie')).toLowerCase();
        const providerContext = buildProviderContext(meta, config);
        const esStreams = await getEasystreamsStreams(id, type, season, episode, providerContext);
        if (!esStreams.length) return [];

        const languageSuffix = esStreams[0].language === 'Italian' ? ' | ITA' : '';
        const streams = esStreams.map((stream) => buildWebStream({
            name: 'CinemaCity',
            title: `${stream.title || 'Stream'}${languageSuffix}`,
            url: stream.url,
            extractor: 'Direct',
            provider: 'CinemaCity',
            providerCode: 'CC',
            quality: stream.quality || '1080p',
            headers: stream.headers,
            mediaflowUrl: getMediaflowBase(config),
            addonBase: reqHost,
            notWebReady: stream.behaviorHints?.notWebReady !== false
        }));

        return normalizeStreams(dedupeStreamsByUrl(streams), {
            provider: 'cinemacity',
            providerLabel: 'CinemaCity',
            providerCode: 'CC'
        });
    } catch (error) {
        console.error('[CinemaCity] Error:', error.message);
        return [];
    }
}

async function searchCinemaCity(originalId, finalId, meta, config = {}, reqHost = null) {
    return withProviderHealth('cinemacity', () => searchCinemaCityImpl(originalId, finalId, meta, config, reqHost), {
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = {
    searchCinemaCity,
    buildProviderContext,
    __private: {
        parseSitemapEntries,
        scoreSitemapEntry,
        extractStreamFromAtob,
        extractDownloadLinks,
        buildDownloadUrl,
        normalizeTitle,
        base64Decode
    }
};
