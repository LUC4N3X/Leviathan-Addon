'use strict';

const cheerio = require('cheerio');
const { fetchMappingPayload } = require('../anime/mapping');
const { SingleFlight, TtlLruCache } = require('../utils/provider_runtime');
const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const {
    USER_AGENT,
    FETCH_TIMEOUT,
    uniqueStrings,
    parsePositiveInt,
    normalizeRequestedEpisode,
    toAbsoluteUrl,
    fetchResource,
    mapLimit
} = require('../anime/shared');
const kitsuProvider = require('../animeworld/kitsu_provider');

const SATURN_BASE_URL = 'https://www.animesaturn.cx';
const BLOCKED_DOMAINS = [
    'jujutsukaisenanime.com',
    'onepunchman.it',
    'dragonballhd.it',
    'narutolegend.it'
];
const TTL = {
    page: 15 * 60 * 1000,
    watch: 5 * 60 * 1000,
    search: 10 * 60 * 1000,
    mapping: 45 * 60 * 1000
};
const MONTHS = {
    gennaio: 0,
    febbraio: 1,
    marzo: 2,
    aprile: 3,
    maggio: 4,
    giugno: 5,
    luglio: 6,
    agosto: 7,
    settembre: 8,
    ottobre: 9,
    novembre: 10,
    dicembre: 11
};

const NEGATIVE_TTL_MS = 90 * 1000;
const STREAM_CACHE_TTL_MS = 4 * 60 * 1000;
const STREAM_CACHE_STALE_MS = 30 * 60 * 1000;
const SEARCH_PATHS_TTL_MS = 10 * 60 * 1000;
const SEARCH_PATHS_STALE_MS = 2 * 60 * 60 * 1000;
const MAX_WATCH_PAGES = 12;

const TITLE_FIXES = new Map([
    ['shingeki no kyojin', ["L'attacco dei Giganti", 'Attack on Titan']],
    ['attack on titan', ["L'attacco dei Giganti", 'Shingeki no Kyojin']],
    ['boku no hero academia', ['My Hero Academia']],
    ['ore dake level up na ken', ['Solo Leveling']],
    ['kimetsu no yaiba', ['Demon Slayer']],
    ['oshi no ko', ['Oshi no Ko']],
    ['jujutsu kaisen ii', ['Jujutsu Kaisen Season 2']],
    ['jujutsu kaisen 2', ['Jujutsu Kaisen Season 2']],
    ['one piece fan letter', ['ONE PIECE FAN LETTER']]
]);

const localCache = {
    searchPaths: new TtlLruCache({ name: 'animesaturn:searchPaths', max: 700, staleMode: 'extension' }),
    streams: new TtlLruCache({ name: 'animesaturn:streams', max: 1200, staleMode: 'extension' }),
    parsedPages: new TtlLruCache({ name: 'animesaturn:parsedPages', max: 1000, staleMode: 'extension' }),
    watchUrls: new TtlLruCache({ name: 'animesaturn:watchUrls', max: 1800, staleMode: 'extension' }),
    inflight: new SingleFlight('animesaturn')
};

async function singleFlight(key, worker) {
    return localCache.inflight.do(key, worker);
}

function getFilterValue(config, key, fallback) {
    const filters = config?.filters || {};
    return Object.prototype.hasOwnProperty.call(filters, key) ? filters[key] : fallback;
}

function buildSaturnUrl(pathOrUrl) {
    const text = String(pathOrUrl || '').trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith('/')) return `${SATURN_BASE_URL}${text}`;
    return `${SATURN_BASE_URL}/${text}`;
}

function normalizeAnimeSaturnPath(pathOrUrl) {
    if (!pathOrUrl) return null;
    let value = String(pathOrUrl).trim();
    if (!value) return null;

    if (/^https?:\/\//i.test(value)) {
        try {
            value = new URL(value).pathname;
        } catch (_) {
            return null;
        }
    }

    if (!value.startsWith('/')) value = `/${value}`;
    value = value.replace(/\/+$/, '');
    const match = value.match(/^\/anime\/[^/?#]+/i);
    return match ? match[0] : null;
}

function normalizeEpisodePath(pathOrUrl) {
    if (!pathOrUrl) return null;
    let value = String(pathOrUrl).trim();
    if (!value) return null;

    if (/^https?:\/\//i.test(value)) {
        try {
            value = new URL(value).pathname;
        } catch (_) {
            return null;
        }
    }

    if (!value.startsWith('/')) value = `/${value}`;
    value = value.replace(/\/+$/, '');
    const match = value.match(/^\/ep\/[^/?#]+/i);
    return match ? match[0] : null;
}

function sanitizeAnimeTitle(rawTitle) {
    let text = String(rawTitle || '').trim();
    if (!text) return null;

    text = text
        .replace(/^\s*AnimeSaturn\s*-\s*/i, '')
        .replace(/\s*-\s*AnimeSaturn.*$/i, '')
        .replace(/\s+Streaming.*$/i, '')
        .replace(/\s+Episodi.*$/i, '')
        .replace(/\s+episodio\s*\d+(?:[.,]\d+)?\b/gi, '')
        .replace(/\s+episode\s*\d+(?:[.,]\d+)?\b/gi, '')
        .replace(/\s*[\[(]\s*(?:SUB\s*ITA|ITA|SUB|DUB(?:BED)?|DOPPIATO)\s*[\])]\s*/gi, ' ')
        .replace(/\s*[-–_|:]\s*(?:SUB\s*ITA|ITA|SUB|DUB(?:BED)?|DOPPIATO)\s*$/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s*[-–_|:]\s*$/g, '')
        .trim();

    return text || null;
}

function inferSourceTag(title, animePath) {
    const titleText = String(title || '').toLowerCase();
    const pathText = String(animePath || '').toLowerCase();
    if (/(?:^|[^\w])ita(?:[^\w]|$)/i.test(titleText)) return 'ITA';
    if (/(?:^|[-_/])ita(?:[-_/]|$)/i.test(pathText)) return 'ITA';
    return 'SUB';
}

function resolveLanguageLine(sourceTag) {
    return String(sourceTag || '').toUpperCase() === 'ITA'
        ? '🇮🇹 ITA • Dub'
        : '🇯🇵 JPN • Sub ITA';
}

function resolveStreamLanguage(sourceTag) {
    return String(sourceTag || '').toUpperCase() === 'ITA' ? 'ita' : 'jpn';
}

function streamLanguageRank(stream = {}) {
    return String(stream?.language || '').toLowerCase() === 'ita' ? 0 : 1;
}

function parseEpisodeNumber(value, fallbackNum) {
    const raw = String(value || '').trim();
    if (!raw) return fallbackNum;

    const patterns = [
        /(?:^|[^a-z])episodio[-_\s]*(\d{1,5})(?:$|[^a-z])/i,
        /(?:^|[^a-z])episode[-_\s]*(\d{1,5})(?:$|[^a-z])/i,
        /(?:^|[^a-z])ep[-_\s]*(\d{1,5})(?:$|[^a-z])/i,
        /-ep-(\d{1,5})(?:-|$)/i,
        /\/ep\/[^/?#]*?(\d{1,5})(?:-|$)/i
    ];

    for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (!match?.[1]) continue;
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }

    const cleanText = raw.replace(/https?:\/\/\S+/gi, ' ');
    const compact = cleanText.match(/(?:^|\s)(\d{1,5})(?:\s|$)/);
    if (compact?.[1]) {
        const parsed = Number.parseInt(compact[1], 10);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }

    return fallbackNum;
}

function isDirectMediaPath(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (!/^https?:\/\//i.test(text)) return /\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(text);

    try {
        const parsed = new URL(text);
        const path = String(parsed.pathname || '').toLowerCase();
        return path.endsWith('.mp4') || path.endsWith('.m3u8');
    } catch (_) {
        return /\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(text);
    }
}

function normalizePlayableMediaUrl(rawUrl, depth = 0) {
    const absolute = toAbsoluteUrl(rawUrl, SATURN_BASE_URL);
    if (!absolute) return null;
    if (isDirectMediaPath(absolute)) return absolute;
    if (depth >= 1) return null;

    let parsed;
    try {
        parsed = new URL(absolute);
    } catch (_) {
        return null;
    }

    const path = String(parsed.pathname || '').toLowerCase();
    if (path.endsWith('.mp4') || path.endsWith('.m3u8')) return parsed.toString();

    for (const key of ['url', 'src', 'file', 'link', 'stream', 'id']) {
        const nested = parsed.searchParams.get(key);
        if (!nested) continue;
        let decoded = nested;
        try {
            decoded = decodeURIComponent(nested);
        } catch (_) {}
        const nestedUrl = normalizePlayableMediaUrl(decoded, depth + 1);
        if (nestedUrl) return nestedUrl;
    }

    return null;
}

function extractQualityHint(value) {
    const text = String(value || '');
    const match = text.match(/(?:^|[^0-9])(2160p|1440p|1080p|720p|576p|480p|360p)(?:[^0-9]|$)/i);
    if (match?.[1]) return match[1].toLowerCase().replace(/^./, (c) => c.toUpperCase());
    if (/\b4k\b|2160/i.test(text)) return '2160p';
    if (/1080|fullhd|fhd/i.test(text)) return '1080p';
    if (/720|hd/i.test(text)) return '720p';
    return '720p';
}

function qualityRank(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('2160') || text.includes('4k')) return 2160;
    if (text.includes('1440')) return 1440;
    if (text.includes('1080')) return 1080;
    if (text.includes('720')) return 720;
    if (text.includes('576')) return 576;
    if (text.includes('480')) return 480;
    return 0;
}

function normalizeHostLabel(rawUrl) {
    try {
        const host = new URL(String(rawUrl || '')).hostname.replace(/^www\./i, '').toLowerCase();
        if (!host) return '';
        const first = host.split('.')[0] || host;
        return first.charAt(0).toUpperCase() + first.slice(1);
    } catch (_) {
        return '';
    }
}

function extractWatchUrlsFromHtml(html, expectedFileId = null) {
    const text = String(html || '');
    const values = new Set();
    let match;

    const absoluteRegex = /https?:\/\/[^\s"'<>\\]+\/watch\?file=[^"'<>\\\s]+/gi;
    while ((match = absoluteRegex.exec(text)) !== null) values.add(match[0]);

    const relativeRegex = /\/watch\?file=[^"'<>\\\s]+/gi;
    while ((match = relativeRegex.exec(text)) !== null) values.add(buildSaturnUrl(match[0]));

    const output = [];
    const seen = new Set();

    for (const candidate of values) {
        const absolute = toAbsoluteUrl(candidate, SATURN_BASE_URL);
        if (!absolute || seen.has(absolute)) continue;

        try {
            const parsed = new URL(absolute);
            if (parsed.pathname !== '/watch') continue;
            const fileParam = parsed.searchParams.get('file');
            if (!fileParam) continue;
            if (expectedFileId && fileParam !== expectedFileId) continue;

            seen.add(absolute);
            output.push(absolute);

            if (!parsed.searchParams.has('s')) {
                parsed.searchParams.set('s', 'alt');
                const altUrl = parsed.toString();
                if (!seen.has(altUrl)) {
                    seen.add(altUrl);
                    output.push(altUrl);
                }
            }
        } catch (_) {}
    }

    return output;
}

function parseAnimeSaturnPage(html, fallback = {}) {
    const $ = cheerio.load(html);
    const pageTitle = $('h1').first().text().trim()
        || $('meta[property="og:title"]').attr('content')
        || $('title').first().text().trim()
        || null;
    const title = sanitizeAnimeTitle(fallback.title) || sanitizeAnimeTitle(pageTitle) || null;
    const animePath = normalizeAnimeSaturnPath(fallback.animePath || null);
    const sourceTag = inferSourceTag(title, animePath);

    const episodes = [];
    const seenEpisodePath = new Set();
    $('a[href*="/ep/"]').each((index, element) => {
        const anchor = $(element);
        const href = normalizeEpisodePath(anchor.attr('href'));
        if (!href || seenEpisodePath.has(href)) return;
        seenEpisodePath.add(href);

        const probe = `${href} ${anchor.text() || ''} ${anchor.attr('title') || ''}`;
        episodes.push({
            num: parseEpisodeNumber(probe, index + 1),
            token: href,
            episodePath: href,
            watchUrl: null
        });
    });

    if (episodes.length === 0) {
        const watchUrls = extractWatchUrlsFromHtml(html);
        if (watchUrls.length > 0) {
            episodes.push({
                num: 1,
                token: 'watch-1',
                episodePath: null,
                watchUrl: watchUrls[0]
            });
        }
    }

    const relatedAnimePaths = [];
    const seenRelated = new Set();
    $('a[href*="/anime/"]').each((_, element) => {
        const anchor = $(element);
        const relatedPath = normalizeAnimeSaturnPath(anchor.attr('href'));
        if (!relatedPath || seenRelated.has(relatedPath) || (animePath && relatedPath === animePath)) return;

        const probe = `${anchor.text() || ''} ${anchor.attr('title') || ''} ${relatedPath}`.toLowerCase();
        if (!probe.includes('ita')) return;

        seenRelated.add(relatedPath);
        relatedAnimePaths.push(relatedPath);
    });

    episodes.sort((a, b) => a.num - b.num);
    return { title, animePath, sourceTag, episodes, relatedAnimePaths };
}

function normalizeEpisodesList(sourceEpisodes = []) {
    if (!Array.isArray(sourceEpisodes) || sourceEpisodes.length === 0) return [];
    const output = [];
    const seen = new Set();

    for (let index = 0; index < sourceEpisodes.length; index += 1) {
        const entry = sourceEpisodes[index] || {};
        const num = Number.parseInt(String(entry.num ?? index + 1), 10);
        const normalizedNum = Number.isFinite(num) && num > 0 ? num : index + 1;
        const episodePath = normalizeEpisodePath(entry.episodePath || entry.href || entry.token || null);
        const watchUrl = toAbsoluteUrl(entry.watchUrl || null, SATURN_BASE_URL);
        const token = String(entry.token || episodePath || watchUrl || `ep-${normalizedNum}`).trim();
        const key = `${normalizedNum}|${episodePath || ''}|${watchUrl || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({ num: normalizedNum, token, episodePath, watchUrl });
    }

    output.sort((a, b) => a.num - b.num);
    return output;
}

function mergeEpisodeLists(existingEpisodes = [], nextEpisodes = []) {
    const map = new Map();
    for (const entry of [...normalizeEpisodesList(existingEpisodes), ...normalizeEpisodesList(nextEpisodes)]) {
        const current = map.get(entry.num) || { num: entry.num, token: null, episodePath: null, watchUrl: null };
        map.set(entry.num, {
            num: entry.num,
            token: entry.token || current.token || null,
            episodePath: entry.episodePath || current.episodePath || null,
            watchUrl: entry.watchUrl || current.watchUrl || null
        });
    }
    return [...map.values()].sort((a, b) => a.num - b.num);
}

function pickEpisodeEntry(episodes, requestedEpisode, mediaType = 'tv') {
    const list = normalizeEpisodesList(episodes);
    if (list.length === 0) return null;
    if (mediaType === 'movie') return list[0];

    const episode = normalizeRequestedEpisode(requestedEpisode);
    return list.find((entry) => entry.num === episode) || (episode === 1 ? list[0] : null);
}

function collectMediaLinksFromWatchHtml(html) {
    const $ = cheerio.load(String(html || ''));
    const links = [];
    const seen = new Set();

    function addLink(href) {
        const playable = normalizePlayableMediaUrl(href);
        if (!playable || seen.has(playable)) return;
        seen.add(playable);
        links.push(playable);
    }

    $('source[src], video source[src]').each((_, element) => addLink($(element).attr('src')));

    const rawHtml = String(html || '');
    for (const text of [rawHtml, rawHtml.replace(/\\\//g, '/')]) {
        let match;
        const directRegex = /https?:\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)(?:[^\s"'<>\\]*)?/gi;
        while ((match = directRegex.exec(text)) !== null) addLink(match[0]);

        const encodedRegex = /https%3A%2F%2F[^\s"'<>\\]+/gi;
        while ((match = encodedRegex.exec(text)) !== null) {
            try {
                addLink(decodeURIComponent(match[0]));
            } catch (_) {}
        }

        const sourceRegex = /(?:file|src|url|link)\s*[:=]\s*["']([^"']+)["']/gi;
        while ((match = sourceRegex.exec(text)) !== null) addLink(match[1]);
    }

    const decodeCandidates = [];
    for (const pattern of [
        /atob\(["']([^"']{16,})["']\)/gi,
        /Base64\.decode\(["']([^"']{16,})["']\)/gi,
        /decodeURIComponent\(["']([^"']{16,})["']\)/gi
    ]) {
        let match;
        while ((match = pattern.exec(rawHtml)) !== null) decodeCandidates.push(match[1]);
    }

    for (const candidate of decodeCandidates) {
        try {
            const decoded = candidate.includes('%')
                ? decodeURIComponent(candidate)
                : Buffer.from(candidate, 'base64').toString('utf8');
            addLink(decoded);
            let nested;
            const directRegex = /https?:\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)(?:[^\s"'<>\\]*)?/gi;
            while ((nested = directRegex.exec(decoded)) !== null) addLink(nested[0]);
        } catch (_) {}
    }

    return links;
}

async function resolveWatchUrlsForEpisodeEntry(source, episodeEntry) {
    const cacheKey = `watchurls:${source?.animePath || 'na'}:${episodeEntry?.num || 'na'}:${episodeEntry?.episodePath || ''}:${episodeEntry?.watchUrl || ''}`;
    const cached = localCache.watchUrls.get(cacheKey);
    if (cached !== undefined) return cached;

    const urls = [];
    const hasEpisodePath = Boolean(episodeEntry?.episodePath);

    if (episodeEntry?.watchUrl) urls.push(...extractWatchUrlsFromHtml(episodeEntry.watchUrl));

    if (urls.length === 0 && episodeEntry?.episodePath) {
        const episodeUrl = buildSaturnUrl(episodeEntry.episodePath);
        if (episodeUrl) {
            try {
                const html = await fetchResource(episodeUrl, {
                    ttlMs: TTL.watch,
                    cacheKey: `animesaturn-episode:${episodeEntry.episodePath}`,
                    timeoutMs: FETCH_TIMEOUT
                });
                urls.push(...extractWatchUrlsFromHtml(html));
            } catch (error) {
                console.error('[AnimeSaturn] episode page request failed:', error.message);
            }
        }
    }

    if (hasEpisodePath && urls.length === 0) return [];

    if (urls.length === 0 && source?.animePath) {
        const animeUrl = buildSaturnUrl(source.animePath);
        if (animeUrl) {
            try {
                const html = await fetchResource(animeUrl, {
                    ttlMs: TTL.watch,
                    cacheKey: `animesaturn-fallback:${source.animePath}`,
                    timeoutMs: FETCH_TIMEOUT
                });
                urls.push(...extractWatchUrlsFromHtml(html));
            } catch (error) {
                console.error('[AnimeSaturn] anime watch fallback failed:', error.message);
            }
        }
    }

    return localCache.watchUrls.set(
        cacheKey,
        uniqueStrings(urls.map((url) => toAbsoluteUrl(url, SATURN_BASE_URL))).filter(Boolean),
        TTL.watch,
        STREAM_CACHE_STALE_MS
    );
}

async function extractStreamsFromAnimePath(animePath, requestedEpisode, mediaType = 'tv', originalEpisode = null, includeRelatedIta = false) {
    const normalizedPath = normalizeAnimeSaturnPath(animePath);
    if (!normalizedPath) return [];

    const normalizedEpisodeForKey = normalizeRequestedEpisode(requestedEpisode);
    const streamCacheKey = `streams:${normalizedPath}:ep=${normalizedEpisodeForKey}:type=${mediaType}:rel=${includeRelatedIta ? 1 : 0}`;
    const cachedStreams = localCache.streams.get(streamCacheKey);
    if (cachedStreams !== undefined) return cachedStreams;

    return singleFlight(`as:${streamCacheKey}`, async () => {
        const second = localCache.streams.get(streamCacheKey);
        if (second !== undefined) return second;

        const animeUrl = buildSaturnUrl(normalizedPath);
        if (!animeUrl) return localCache.streams.set(streamCacheKey, [], NEGATIVE_TTL_MS, STREAM_CACHE_STALE_MS);

        let parsedPage = localCache.parsedPages.get(normalizedPath);
        if (!parsedPage) {
            try {
                const html = await fetchResource(animeUrl, {
                    ttlMs: TTL.page,
                    cacheKey: `animesaturn-page:${normalizedPath}`,
                    timeoutMs: FETCH_TIMEOUT
                });
                parsedPage = parseAnimeSaturnPage(html, { animePath: normalizedPath });
                localCache.parsedPages.set(normalizedPath, parsedPage, TTL.page, STREAM_CACHE_STALE_MS);
            } catch (error) {
                const stale = localCache.parsedPages.get(normalizedPath, true);
                if (!stale) {
                    console.error('[AnimeSaturn] anime page request failed:', error.message);
                    return localCache.streams.set(streamCacheKey, [], NEGATIVE_TTL_MS, STREAM_CACHE_STALE_MS);
                }
                parsedPage = stale;
            }
        }

    const normalizedEpisode = normalizeRequestedEpisode(requestedEpisode);
    const normalizedOriginalEpisode = normalizeRequestedEpisode(
        originalEpisode === null || originalEpisode === undefined ? normalizedEpisode : originalEpisode
    );

    let episodes = normalizeEpisodesList(parsedPage.episodes);
    let selected = pickEpisodeEntry(episodes, normalizedEpisode, mediaType);

    if (
        String(parsedPage.sourceTag || '').toUpperCase() !== 'ITA'
        && (!selected || episodes.length === 0)
        && Array.isArray(parsedPage.relatedAnimePaths)
        && parsedPage.relatedAnimePaths.length > 0
    ) {
        for (const related of parsedPage.relatedAnimePaths.slice(0, 4)) {
            try {
                const relatedUrl = buildSaturnUrl(related);
                if (!relatedUrl) continue;
                const html = await fetchResource(relatedUrl, {
                    ttlMs: TTL.page,
                    cacheKey: `animesaturn-related:${related}`,
                    timeoutMs: FETCH_TIMEOUT
                });
                const relatedParsed = parseAnimeSaturnPage(html, { animePath: related, title: parsedPage.title });
                episodes = mergeEpisodeLists(episodes, relatedParsed.episodes);
            } catch (_) {}
        }
        selected = pickEpisodeEntry(episodes, normalizedEpisode, mediaType);
    }

    if (!selected && normalizedOriginalEpisode !== normalizedEpisode) {
        selected = pickEpisodeEntry(episodes, normalizedOriginalEpisode, mediaType);
    }

    if (!selected) {
        const available = episodes.map((entry) => entry.num).slice(0, 40).join(',') || 'none';
        console.log(`[AnimeSaturn] miss episode | path=${normalizedPath} wanted=${normalizedOriginalEpisode} mapped=${normalizedEpisode} available=${available}`);
        return localCache.streams.set(streamCacheKey, [], NEGATIVE_TTL_MS, STREAM_CACHE_STALE_MS);
    }

    const resolvedEpisode = parsePositiveInt(selected.num) || normalizedEpisode;
    if (mediaType !== 'movie' && resolvedEpisode !== normalizedOriginalEpisode && resolvedEpisode !== normalizedEpisode) {
        const available = episodes.map((entry) => entry.num).slice(0, 40).join(',') || 'none';
        console.log(`[AnimeSaturn] skip wrong episode | path=${normalizedPath} wanted=${normalizedOriginalEpisode} mapped=${normalizedEpisode} got=${resolvedEpisode} available=${available}`);
        return localCache.streams.set(streamCacheKey, [], NEGATIVE_TTL_MS, STREAM_CACHE_STALE_MS);
    }

    const baseTitle = sanitizeAnimeTitle(parsedPage.title) || 'Anime';
    const displayTitle = mediaType === 'movie' ? baseTitle : `${baseTitle} - Ep ${resolvedEpisode}`;
    const watchUrls = await resolveWatchUrlsForEpisodeEntry({
        animePath: normalizedPath,
        title: parsedPage.title,
        sourceTag: parsedPage.sourceTag,
        episodes
    }, selected);
    if (watchUrls.length === 0) return [];

    const queue = [...watchUrls];
    const visited = new Set();
    const seenMedia = new Set();
    const streams = [];
    const streamLanguage = resolveStreamLanguage(parsedPage.sourceTag);
    const expectedFileId = (() => {
        try {
            return new URL(watchUrls[0]).searchParams.get('file');
        } catch (_) {
            return null;
        }
    })();

    let processed = 0;
    while (queue.length > 0 && processed < MAX_WATCH_PAGES) {
        const watchUrl = queue.shift();
        if (!watchUrl || visited.has(watchUrl)) continue;
        visited.add(watchUrl);
        processed += 1;

        let html = '';
        try {
            html = await fetchResource(watchUrl, {
                ttlMs: TTL.watch,
                cacheKey: `animesaturn-watch:${watchUrl}`,
                timeoutMs: FETCH_TIMEOUT
            });
        } catch (error) {
            console.error('[AnimeSaturn] watch page request failed:', error.message);
            continue;
        }

        for (const mediaUrl of collectMediaLinksFromWatchHtml(html)) {
            const normalizedUrl = normalizePlayableMediaUrl(mediaUrl);
            if (!normalizedUrl || seenMedia.has(normalizedUrl)) continue;

            const lowerUrl = normalizedUrl.toLowerCase();
            if (lowerUrl.endsWith('.mkv.mp4') || BLOCKED_DOMAINS.some((domain) => lowerUrl.includes(domain))) continue;

            seenMedia.add(normalizedUrl);
            const quality = extractQualityHint(normalizedUrl);
            const hostLabel = normalizeHostLabel(normalizedUrl) || 'Direct';

            streams.push({
                name: `🪐 AnimeSaturn | ${quality}`,
                title: `${displayTitle}
${resolveLanguageLine(parsedPage.sourceTag)} • ${quality}
☁️ ${hostLabel} • AnimeSaturn`,
                url: normalizedUrl,
                language: streamLanguage,
                extractor: hostLabel,
                behaviorHints: {
                    notWebReady: false,
                    extractor: hostLabel,
                    bingieGroup: `animesaturn|${String(parsedPage.sourceTag || 'sub').toLowerCase()}`,
                    proxyHeaders: {
                        request: {
                            'User-Agent': USER_AGENT,
                            Referer: watchUrl,
                            Origin: SATURN_BASE_URL
                        }
                    }
                }
            });
        }

        for (const extra of extractWatchUrlsFromHtml(html, expectedFileId)) {
            if (!visited.has(extra)) queue.push(extra);
        }
    }

    if (
        includeRelatedIta
        && String(parsedPage.sourceTag || '').toUpperCase() !== 'ITA'
        && Array.isArray(parsedPage.relatedAnimePaths)
        && parsedPage.relatedAnimePaths.length > 0
    ) {
        const relatedStreams = await mapLimit(parsedPage.relatedAnimePaths.slice(0, 4), 1, (relatedPath) =>
            extractStreamsFromAnimePath(relatedPath, normalizedEpisode, mediaType, normalizedOriginalEpisode, false)
        );
        streams.push(...relatedStreams.flat().filter(Boolean));
    }

        return localCache.streams.set(
            streamCacheKey,
            streams.sort((a, b) => {
                const lang = streamLanguageRank(a) - streamLanguageRank(b);
                if (lang !== 0) return lang;
                return qualityRank(b?.title || b?.name || '') - qualityRank(a?.title || a?.name || '');
            }),
            streams.length > 0 ? STREAM_CACHE_TTL_MS : NEGATIVE_TTL_MS,
            STREAM_CACHE_STALE_MS
        );
    });
}

function normalizeAnimeSaturnCandidatePath(pathOrUrl) {
    const direct = normalizeAnimeSaturnPath(pathOrUrl);
    if (direct) return direct;

    const value = String(pathOrUrl || '').trim().replace(/^\/+/, '');
    if (!value) return null;
    return normalizeAnimeSaturnPath(`/anime/${value}`);
}

function normalizeForMatch(value) {
    return String(value || '')
        .replace(/½/g, '1/2')
        .replace(/['’`]/g, '')
        .replace(/\b(?:ita|sub|cr|dub|dubbed|doppiato|streaming|episodio|episode|episodi|anime|saturn)\b/gi, ' ')
        .replace(/[^a-z0-9]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function buildSearchTitleVariants(searchContext = {}) {
    const raw = uniqueStrings([
        searchContext?.title,
        ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles.map((title) => kitsuProvider.normalizeTitle(title)) : [])
    ]).filter(Boolean);

    const expanded = [];
    for (const title of raw) {
        expanded.push(title);
        const normalized = normalizeForMatch(title);
        const fixes = TITLE_FIXES.get(normalized);
        if (Array.isArray(fixes)) expanded.push(...fixes);
        expanded.push(
            String(title).replace(/\b(?:season|stagione)\s*(\d+)\b/gi, 'S$1'),
            String(title).replace(/\bS(\d+)\b/gi, 'Season $1')
        );
    }

    return uniqueStrings(expanded.map((title) => String(title || '').trim()).filter(Boolean)).slice(0, 8);
}

function extractSeasonMarker(value) {
    const text = ` ${normalizeForMatch(value)} `;
    const patterns = [
        /\bseason\s+(\d+)\b/i,
        /\bstagione\s+(\d+)\b/i,
        /\bs(\d+)\b/i,
        /\bpart\s+(\d+)\b/i,
        /\b(\d+)(?:nd|rd|th)\s+season\b/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            const parsed = Number.parseInt(match[1], 10);
            if (Number.isInteger(parsed) && parsed > 0) return parsed;
        }
    }

    if (/\bii\b/i.test(text)) return 2;
    if (/\biii\b/i.test(text)) return 3;
    if (/\biv\b/i.test(text)) return 4;
    if (/\bv\b/i.test(text)) return 5;

    const tailMatch = text.match(/\b([2-9])\b\s*$/);
    if (!tailMatch?.[1]) return null;

    const parsed = Number.parseInt(tailMatch[1], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function removeSeasonMarkers(value) {
    return ` ${normalizeForMatch(value)} `
        .replace(/\bseason\s+\d+\b/gi, ' ')
        .replace(/\bstagione\s+\d+\b/gi, ' ')
        .replace(/\b\d+(?:nd|rd|th)\s+season\b/gi, ' ')
        .replace(/\bs\d+\b/gi, ' ')
        .replace(/\bpart\s+\d+\b/gi, ' ')
        .replace(/\b(?:ii|iii|iv|v)\b/gi, ' ')
        .replace(/\b[2-9]\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasMovieMarker(value) {
    return /\b(?:movie|film|the movie|gekijouban)\b/i.test(normalizeForMatch(value));
}

function removeMovieMarkers(value) {
    return ` ${normalizeForMatch(value)} `
        .replace(/\b(?:movie|film|the movie|gekijouban)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasSpecialMarker(value) {
    return /\b(?:special|ova|oad|ona|recap|fan letter|spin off|spinoff)\b/i.test(normalizeForMatch(value));
}

function candidateLanguage(value) {
    return /\b(?:ita|doppiato|cr)\b/i.test(String(value || '')) ? 'ita' : 'jp';
}

function animeSaturnScore(queryTitle, candidateTitle, isMovie) {
    const queryRoot = removeMovieMarkers(removeSeasonMarkers(queryTitle));
    const candidateRoot = removeMovieMarkers(removeSeasonMarkers(candidateTitle));
    const querySeason = extractSeasonMarker(queryTitle);
    const candidateSeason = extractSeasonMarker(candidateTitle);
    const candidateIsMovie = hasMovieMarker(candidateTitle);

    let score = 0;
    if (queryRoot && candidateRoot) {
        if (queryRoot === candidateRoot) {
            score += 6;
        } else if (candidateRoot.includes(queryRoot) || queryRoot.includes(candidateRoot)) {
            score += 3.5;
        }

        const queryTokens = new Set(queryRoot.split(' ').filter((token) => token.length >= 3));
        const candidateTokens = new Set(candidateRoot.split(' ').filter((token) => token.length >= 3));
        const overlap = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
        score += overlap * 0.6;
    }

    if (querySeason === null && candidateSeason !== null) score -= 3.5;
    if (querySeason !== null && candidateSeason === null) score -= 2;
    if (querySeason !== null && candidateSeason !== null) {
        score += querySeason === candidateSeason ? 3 : -5;
    }

    if (isMovie && candidateIsMovie) score += 2;
    if (isMovie && !candidateIsMovie) score -= 1.5;
    if (!isMovie && candidateIsMovie) score -= 5.5;
    if (!hasSpecialMarker(queryTitle) && hasSpecialMarker(candidateTitle)) score -= 3.5;

    if (candidateLanguage(candidateTitle) === 'ita') score += 0.1;
    return score;
}

function clusterKey(name) {
    return [
        removeMovieMarkers(removeSeasonMarkers(name)),
        extractSeasonMarker(name) || 0,
        hasMovieMarker(name) ? 'movie' : 'series'
    ].join('|');
}

function rankAnimeSaturnCandidates(query, candidates, isMovie, strict = false) {
    const scored = candidates
        .map((candidate) => ({
            candidate,
            score: animeSaturnScore(query, candidate?.name || '', isMovie)
        }))
        .sort((left, right) => right.score - left.score);

    const bestCluster = scored[0]?.candidate?.name ? clusterKey(scored[0].candidate.name) : null;
    const selected = [];
    let itaChoice = null;
    let jpChoice = null;

    for (const entry of scored) {
        if (entry.score < (strict ? 2.25 : 1.25)) continue;

        const name = entry?.candidate?.name || '';
        if (bestCluster && clusterKey(name) !== bestCluster) continue;

        const querySeason = extractSeasonMarker(query);
        const candidateSeason = extractSeasonMarker(name);
        if (querySeason === null && candidateSeason !== null) continue;
        if (querySeason !== null && candidateSeason !== null && querySeason !== candidateSeason) continue;
        if (querySeason !== null && candidateSeason === null) continue;
        if (!isMovie && hasMovieMarker(name)) continue;

        if (candidateLanguage(name) === 'ita' && !itaChoice) {
            itaChoice = entry.candidate;
            continue;
        }

        if (candidateLanguage(name) === 'jp' && !jpChoice) {
            jpChoice = entry.candidate;
            continue;
        }

        selected.push(entry.candidate);
    }

    const output = [];
    if (itaChoice && itaChoice !== jpChoice) output.push(itaChoice);
    if (jpChoice) output.push(jpChoice);

    for (const candidate of selected) {
        if (output.find((entry) => entry.link === candidate.link)) continue;
        output.push(candidate);
        if (output.length >= 3) break;
    }

    if (output.length > 0) return output;
    if (strict) return [];
    return scored.slice(0, 3).map((entry) => entry.candidate);
}

function parseIsoDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;

    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10) - 1;
    const day = Number.parseInt(match[3], 10);
    const date = new Date(Date.UTC(year, month, day));
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseAnimeSaturnDateValue(value) {
    const cleaned = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!cleaned) return null;

    let match = cleaned.match(/^(\d{1,2})\s+([a-zà-ÿ]+)\s+(\d{4})$/i);
    if (match) {
        const day = Number.parseInt(match[1], 10);
        const monthIndex = MONTHS[String(match[2] || '').trim().toLowerCase()];
        const year = Number.parseInt(match[3], 10);
        if (Number.isInteger(day) && Number.isInteger(monthIndex) && Number.isInteger(year)) {
            const date = new Date(Date.UTC(year, monthIndex, day));
            if (!Number.isNaN(date.getTime())) return { date, exact: true };
        }
    }

    match = cleaned.match(/^([a-zà-ÿ]+)\s+(\d{4})$/i);
    if (match) {
        const monthIndex = MONTHS[String(match[1] || '').trim().toLowerCase()];
        const year = Number.parseInt(match[2], 10);
        if (Number.isInteger(monthIndex) && Number.isInteger(year)) {
            const date = new Date(Date.UTC(year, monthIndex, 1));
            if (!Number.isNaN(date.getTime())) return { date, exact: false };
        }
    }

    return null;
}

function matchesAnimeSaturnDate(candidateDate, targetDate) {
    if (!candidateDate?.date || !targetDate) return false;

    if (candidateDate.exact) {
        const diffMs = Math.abs(candidateDate.date.getTime() - targetDate.getTime());
        return diffMs <= (2 * 24 * 60 * 60 * 1000);
    }

    return candidateDate.date.getUTCFullYear() === targetDate.getUTCFullYear()
        && candidateDate.date.getUTCMonth() === targetDate.getUTCMonth();
}

async function searchAnimeSaturnCandidates(query) {
    const encodedQuery = encodeURIComponent(String(query || '').trim()).replace(/%20/g, '+');
    if (!encodedQuery) return [];

    try {
        const payload = await fetchResource(`${SATURN_BASE_URL}/index.php?search=1&key=${encodedQuery}&page=1`, {
            as: 'json',
            ttlMs: TTL.search,
            cacheKey: `animesaturn-search:${encodedQuery}`,
            timeoutMs: FETCH_TIMEOUT,
            headers: {
                referer: `${SATURN_BASE_URL}/animelist`,
                accept: 'application/json, text/javascript, */*; q=0.01',
                'x-requested-with': 'XMLHttpRequest'
            }
        });

        if (!Array.isArray(payload)) return [];

        return payload
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
                name: String(item.name || '').trim(),
                link: String(item.link || '').trim(),
                release: String(item.release || '').trim()
            }))
            .filter((item) => item.name && item.link);
    } catch (error) {
        console.error('[AnimeSaturn] search request failed:', error.message);
        return [];
    }
}

async function resolveAnimeSaturnPaths(searchContext, config = {}) {
    const targetDate = parseIsoDate(searchContext?.date);
    const strictKitsu = Boolean(searchContext?.strictKitsu);
    const searchQueries = buildSearchTitleVariants(searchContext);
    const isMovie = Boolean(searchContext?.isMovie);
    const maxQueries = Math.max(1, Math.min(Number.parseInt(getFilterValue(config, 'animeSaturnMaxSearchQueries', 8), 10) || 8, 8));
    const maxPaths = Math.max(1, Math.min(Number.parseInt(getFilterValue(config, 'animeSaturnMaxPaths', 8), 10) || 8, 8));
    const cacheKey = `paths:${searchQueries.join('|')}:movie=${isMovie ? 1 : 0}:strict=${strictKitsu ? 1 : 0}:date=${searchContext?.date || 'na'}:max=${maxPaths}`;
    const cached = localCache.searchPaths.get(cacheKey);
    if (cached !== undefined) return cached;

    return singleFlight(`as:${cacheKey}`, async () => {
        const second = localCache.searchPaths.get(cacheKey);
        if (second !== undefined) return second;

        const buckets = await mapLimit(searchQueries.slice(0, maxQueries), 3, async (query) => {
            const candidates = await searchAnimeSaturnCandidates(query);
            if (candidates.length === 0) return { query, paths: [], fallback: [] };

            const dateMatched = targetDate
                ? candidates.filter((candidate) => matchesAnimeSaturnDate(parseAnimeSaturnDateValue(candidate?.release), targetDate))
                : [];
            const candidatePool = dateMatched.length > 0 ? dateMatched : (targetDate && strictKitsu ? [] : candidates);
            const ranked = rankAnimeSaturnCandidates(query, candidatePool, isMovie, strictKitsu);
            const paths = uniqueStrings(
                ranked
                    .map((candidate) => normalizeAnimeSaturnCandidatePath(candidate?.link))
                    .filter(Boolean)
            );
            const fallback = uniqueStrings(
                candidates
                    .map((candidate) => normalizeAnimeSaturnCandidatePath(candidate?.link))
                    .filter(Boolean)
            );
            return { query, paths, fallback };
        });

        const primary = uniqueStrings(buckets.flatMap((bucket) => bucket.paths)).slice(0, maxPaths);
        if (primary.length > 0) {
            console.log(`[AnimeSaturn] paths match | title=${searchContext?.title || searchQueries[0] || 'n/a'} | paths=${primary.length} | strict=${strictKitsu}`);
            return localCache.searchPaths.set(cacheKey, primary, SEARCH_PATHS_TTL_MS, SEARCH_PATHS_STALE_MS);
        }

        const fallbackPaths = uniqueStrings(buckets.flatMap((bucket) => bucket.fallback)).slice(0, Math.min(strictKitsu ? 2 : 4, maxPaths));
        if (strictKitsu && fallbackPaths.length > 0) {
            console.log(`[AnimeSaturn] strict fallback paths | title=${searchContext?.title || searchQueries[0] || 'n/a'} | paths=${fallbackPaths.length}`);
        }
        if (strictKitsu && fallbackPaths.length === 0) {
            return localCache.searchPaths.set(cacheKey, [], NEGATIVE_TTL_MS, SEARCH_PATHS_STALE_MS);
        }

        return localCache.searchPaths.set(cacheKey, fallbackPaths, fallbackPaths.length ? SEARCH_PATHS_TTL_MS : NEGATIVE_TTL_MS, SEARCH_PATHS_STALE_MS);
    });
}

function resolveExplicitKitsuRequestId(requestId, meta = {}) {
    const taggedCandidates = uniqueStrings([
        requestId,
        meta?.id,
        meta?.requestedId,
        meta?.originalId,
        meta?.kitsu_id,
        meta?.kitsuId,
        meta?.kitsu
    ]).filter((value) => /kitsu/i.test(String(value || '')));

    for (const candidate of taggedCandidates) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) return candidate;
    }

    for (const candidate of [meta?.kitsu_id, meta?.kitsuId, meta?.kitsu]) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) return `kitsu:${parsed.kitsuId}`;
    }

    return null;
}

function buildStrictKitsuContext(context = {}) {
    const info = context?.info || {};
    const rawTitles = uniqueStrings([
        ...(Array.isArray(info?.titles) ? info.titles : []),
        info?.canonicalTitle,
        info?.title
    ]);
    const strictRawTitles = rawTitles;
    const searchTitles = uniqueStrings([
        ...kitsuProvider.buildTitleVariants(strictRawTitles),
        ...strictRawTitles
    ]);

    return {
        ...context,
        rawTitles: strictRawTitles,
        searchTitles,
        title: searchTitles[0] || strictRawTitles[0] || null,
        strictKitsu: true
    };
}

function resolveRequestedAnimeEpisode(searchContext = {}, meta = {}) {
    return normalizeRequestedEpisode(
        meta?.requested_kitsu_episode
        || meta?.anime_absolute_episode
        || meta?.anime_episode
        || searchContext?.episodeNumber
        || searchContext?.requestedEpisode
        || meta?.episode
    );
}

async function fetchAnimeSaturnMapping(searchContext = {}, requestedEpisode = 1) {
    const kitsuId = parsePositiveInt(searchContext?.kitsuId || searchContext?.kitsu_id || searchContext?.kitsu);
    if (!kitsuId) return null;

    const episode = normalizeRequestedEpisode(requestedEpisode);
    const season = Number.parseInt(String(searchContext?.seasonNumber ?? searchContext?.season ?? ''), 10);

    try {
        return await fetchMappingPayload({
            provider: 'kitsu',
            externalId: String(kitsuId),
            season: Number.isInteger(season) && season >= 0 ? season : null,
            episode,
            contentType: 'anime'
        }, {
            ...searchContext,
            providerName: 'AnimeSaturn',
            mappingLanguage: 'it',
            mappingTtlMs: TTL.mapping,
            mappingStaleMs: 36 * 60 * 60 * 1000,
            mappingTimeoutMs: FETCH_TIMEOUT,
            mappingRetries: 2,
            mappingOriginConcurrency: 6
        });
    } catch (error) {
        console.error('[AnimeSaturn] mapping request failed:', error.message);
        return null;
    }
}

function extractAnimeSaturnPathsFromMapping(mappingPayload) {
    const raw = mappingPayload?.mappings?.animesaturn;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const paths = [];

    for (const item of list) {
        const candidate = typeof item === 'string'
            ? item
            : item && typeof item === 'object'
                ? item.path || item.url || item.href || item.playPath
                : null;
        const normalized = normalizeAnimeSaturnPath(candidate);
        if (normalized) paths.push(normalized);
    }

    return uniqueStrings(paths);
}

function resolveEpisodeFromMappingPayload(mappingPayload, fallbackEpisode) {
    const fromKitsu = parsePositiveInt(mappingPayload?.kitsu?.episode);
    if (fromKitsu) return fromKitsu;

    const fromRequested = parsePositiveInt(mappingPayload?.requested?.episode);
    if (fromRequested) return fromRequested;

    const fromTmdbRaw = parsePositiveInt(
        mappingPayload?.mappings?.tmdb_episode?.rawEpisodeNumber
        || mappingPayload?.mappings?.tmdb_episode?.raw_episode_number
        || mappingPayload?.mappings?.tmdbEpisode?.rawEpisodeNumber
        || mappingPayload?.tmdb_episode?.rawEpisodeNumber
        || mappingPayload?.tmdbEpisode?.rawEpisodeNumber
    );
    if (fromTmdbRaw) return fromTmdbRaw;

    return normalizeRequestedEpisode(fallbackEpisode);
}

async function resolveAnimeSaturnStreamsFromPaths(animePaths = [], requestedEpisode = 1, originalRequestedEpisode = 1, mediaType = 'tv', includeRelatedIta = false, config = {}) {
    const maxPaths = Math.max(1, Math.min(Number.parseInt(getFilterValue(config, 'animeSaturnMaxPaths', 8), 10) || 8, 8));
    const paths = uniqueStrings(animePaths).slice(0, maxPaths);
    if (paths.length === 0) return [];

    const concurrency = Math.max(1, Math.min(Number.parseInt(getFilterValue(config, 'animeSaturnConcurrency', 3), 10) || 3, 5));
    const perPathStreams = await mapLimit(paths, concurrency, (path) =>
        extractStreamsFromAnimePath(path, requestedEpisode, mediaType, originalRequestedEpisode, includeRelatedIta)
    );

    const deduped = [];
    const seen = new Set();
    for (const stream of perPathStreams.flat().filter(Boolean)) {
        const url = String(stream?.url || '').trim();
        if (!url) continue;
        const key = url
            .replace(/([?&])token=[^&]+/gi, '$1token=*')
            .replace(/([?&])expires=[^&]+/gi, '$1expires=*')
            .replace(/([?&])e=[^&]+/gi, '$1e=*');
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(stream);
    }

    return normalizeStreams(deduped.sort((a, b) => {
        const lang = streamLanguageRank(a) - streamLanguageRank(b);
        if (lang !== 0) return lang;
        return qualityRank(b?.title || '') - qualityRank(a?.title || '');
    }), {
        provider: 'animesaturn',
        providerLabel: 'AnimeSaturn',
        providerCode: 'AS',
        sort: false,
        debug: process.env.ANIMESATURN_DEBUG === '1'
    });
}

function shouldRunAnimeSaturn(requestId, meta = {}, searchContext = {}, config = {}) {
    if (getFilterValue(config, 'animeSaturnStrictAnimeOnly', true) === false) return true;
    if (searchContext?.strictKitsu || searchContext?.kitsuId) return true;

    const text = [
        requestId,
        meta?.id,
        meta?.requestedId,
        meta?.originalId,
        meta?.type,
        meta?.genres,
        meta?.genre,
        meta?.country,
        meta?.originalLanguage,
        meta?.title,
        meta?.name,
        searchContext?.title,
        ...(Array.isArray(searchContext?.identitySources) ? searchContext.identitySources : []),
        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
        ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : [])
    ].flat().filter(Boolean).join(' ').toLowerCase();

    if (/kitsu|anilist|myanimelist|mal|anime|animazione|animation|japan|japanese|giappone|nippon/.test(text)) return true;
    if (searchContext?.isAnime === true || meta?.isAnime === true) return true;
    return false;
}

async function searchAnimeSaturnImpl(requestId, meta = {}, config = {}) {
    if (!config?.filters?.enableAnimeSaturn) return [];

    try {
        const kitsuRequestId = resolveExplicitKitsuRequestId(requestId, meta);
        const searchContext = kitsuRequestId
            ? buildStrictKitsuContext(await kitsuProvider.buildSearchContext(kitsuRequestId, meta))
            : await kitsuProvider.buildSearchContext(requestId, meta);

        if (!shouldRunAnimeSaturn(requestId, meta, searchContext, config)) {
            console.log(`[AnimeSaturn] gate skip non-anime | id=${requestId} | title=${meta?.title || meta?.name || searchContext?.title || 'n/a'}`);
            return [];
        }

        const requestedFromContext = resolveRequestedAnimeEpisode(searchContext, meta);
        let requestedEpisode = requestedFromContext;
        let animePaths = [];
        let mappingUsed = false;

        const mappingAllowed = getFilterValue(config, 'animeSaturnUseMapping', true) !== false;
        const hasKitsuMappingId = Boolean(parsePositiveInt(searchContext?.kitsuId || searchContext?.kitsu_id || searchContext?.kitsu));
        if (mappingAllowed && hasKitsuMappingId) {
            const mappingPayload = await fetchAnimeSaturnMapping(searchContext, requestedFromContext);
            const mappingPaths = extractAnimeSaturnPathsFromMapping(mappingPayload);
            if (mappingPaths.length > 0) {
                animePaths = mappingPaths;
                mappingUsed = true;
                requestedEpisode = resolveEpisodeFromMappingPayload(mappingPayload, requestedFromContext);
            }
        }

        if (animePaths.length === 0) animePaths = await resolveAnimeSaturnPaths(searchContext, config);
        animePaths = uniqueStrings(animePaths);
        if (animePaths.length === 0) return [];

        const originalRequestedEpisode = requestedFromContext;
        const mediaType = searchContext?.isMovie ? 'movie' : 'tv';
        const includeRelatedIta = getFilterValue(config, 'animeSaturnIncludeRelatedIta', false) === true;

        console.log(`[AnimeSaturn] start | title=${searchContext?.title || meta?.title || meta?.name || requestId} | ep=${requestedEpisode} | paths=${animePaths.length} | movie=${mediaType === 'movie'} | strict=${Boolean(searchContext?.strictKitsu)} | mapping=${mappingUsed}`);

        let deduped = await resolveAnimeSaturnStreamsFromPaths(animePaths, requestedEpisode, originalRequestedEpisode, mediaType, includeRelatedIta, config);

        if (deduped.length === 0 && mappingUsed && getFilterValue(config, 'animeSaturnFallbackSearchAfterMapping', true) !== false) {
            const fallbackPaths = uniqueStrings(await resolveAnimeSaturnPaths(searchContext, config))
                .filter((path) => !animePaths.includes(path));
            if (fallbackPaths.length > 0) {
                console.log(`[AnimeSaturn] mapping produced no streams, trying search fallback | paths=${fallbackPaths.length}`);
                deduped = await resolveAnimeSaturnStreamsFromPaths(fallbackPaths, requestedFromContext, originalRequestedEpisode, mediaType, includeRelatedIta, config);
            }
        }

        console.log(`[AnimeSaturn] done | streams=${deduped.length}`);
        return deduped;
    } catch (error) {
        console.error('[AnimeSaturn] error:', error.message);
        return [];
    }
}

async function searchAnimeSaturn(requestId, meta = {}, config = {}) {
    return withProviderHealth('animesaturn', () => searchAnimeSaturnImpl(requestId, meta, config), {
        swallowErrors: true,
        fallbackValue: []
    });
}

module.exports = { searchAnimeSaturn };
