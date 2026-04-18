'use strict';

const cheerio = require('cheerio');
const {
    USER_AGENT,
    FETCH_TIMEOUT,
    uniqueStrings,
    parsePositiveInt,
    normalizeRequestedEpisode,
    toAbsoluteUrl,
    fetchResource,
    resolveLookupRequest,
    fetchMappingPayload,
    extractTmdbIdFromMappingPayload,
    buildAnimeProviderContext,
    mapLimit
} = require('../anime/provider_utils');
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
    watch: 5 * 60 * 1000
};

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

function parseEpisodeNumber(value, fallbackNum) {
    const raw = String(value || '').trim();
    if (!raw) return fallbackNum;

    const byHref = raw.match(/-ep-(\d+)/i);
    if (byHref) {
        const parsed = Number.parseInt(byHref[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    const byLabel = raw.match(/episodio\s*(\d+)/i);
    if (byLabel) {
        const parsed = Number.parseInt(byLabel[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
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
    const match = String(value || '').match(/(\d{3,4}p)/i);
    return match ? match[1] : '720p';
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

    return links;
}

async function resolveWatchUrlsForEpisodeEntry(source, episodeEntry) {
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

    return uniqueStrings(urls.map((url) => toAbsoluteUrl(url, SATURN_BASE_URL))).filter(Boolean);
}

async function extractStreamsFromAnimePath(animePath, requestedEpisode, mediaType = 'tv', originalEpisode = null) {
    const normalizedPath = normalizeAnimeSaturnPath(animePath);
    if (!normalizedPath) return [];

    const animeUrl = buildSaturnUrl(normalizedPath);
    if (!animeUrl) return [];

    let parsedPage;
    try {
        const html = await fetchResource(animeUrl, {
            ttlMs: TTL.page,
            cacheKey: `animesaturn-page:${normalizedPath}`,
            timeoutMs: FETCH_TIMEOUT
        });
        parsedPage = parseAnimeSaturnPage(html, { animePath: normalizedPath });
    } catch (error) {
        console.error('[AnimeSaturn] anime page request failed:', error.message);
        return [];
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
        for (const related of parsedPage.relatedAnimePaths.slice(0, 2)) {
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

    if (!selected) return [];

    const resolvedEpisode = parsePositiveInt(selected.num) || normalizedEpisode;
    if (String(parsedPage.sourceTag || '').toUpperCase() === 'ITA' && resolvedEpisode !== normalizedOriginalEpisode) {
        return [];
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
    const expectedFileId = (() => {
        try {
            return new URL(watchUrls[0]).searchParams.get('file');
        } catch (_) {
            return null;
        }
    })();

    let processed = 0;
    while (queue.length > 0 && processed < 6) {
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
                extractor: hostLabel,
                behaviorHints: {
                    notWebReady: false,
                    extractor: hostLabel,
                    bingieGroup: `animesaturn|${String(parsedPage.sourceTag || 'sub').toLowerCase()}`,
                    proxyHeaders: {
                        request: {
                            'User-Agent': USER_AGENT,
                            Referer: watchUrl
                        }
                    }
                }
            });
        }

        for (const extra of extractWatchUrlsFromHtml(html, expectedFileId)) {
            if (!visited.has(extra)) queue.push(extra);
        }
    }

    return streams;
}

function extractAnimeSaturnPaths(mappingPayload) {
    if (!mappingPayload || typeof mappingPayload !== 'object') return [];
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

function resolveAnimeSaturnLookup(requestId, meta, providerContext) {
    const lookup = resolveLookupRequest(requestId, meta?.season, meta?.episode, providerContext);
    if (lookup) return lookup;

    const fallbackRawId = String(requestId || meta?.id || meta?.kitsu_id || '').trim();
    const parsed = kitsuProvider.parseKitsuId(fallbackRawId);
    if (!parsed?.kitsuId) return null;

    return {
        provider: 'kitsu',
        externalId: String(parsed.kitsuId),
        season: Number.isInteger(parsed.seasonNumber) ? parsed.seasonNumber : null,
        episode: Number.isInteger(parsed.episodeNumber) && parsed.episodeNumber > 0
            ? parsed.episodeNumber
            : normalizeRequestedEpisode(meta?.episode)
    };
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

async function searchAnimeSaturn(requestId, meta, config) {
    if (!config?.filters?.enableAnimeSaturn) return [];

    const providerContext = buildAnimeProviderContext(meta);
    const lookup = resolveAnimeSaturnLookup(requestId, meta, providerContext);
    if (!lookup) return [];

    let mappingPayload = await fetchMappingPayload(lookup, providerContext);
    let animePaths = extractAnimeSaturnPaths(mappingPayload);

    if (animePaths.length === 0) {
        const tmdbFromContext = /^\d+$/.test(String(providerContext?.tmdbId || '').trim())
            ? String(providerContext.tmdbId).trim()
            : null;
        const tmdbFromPayload = extractTmdbIdFromMappingPayload(mappingPayload);
        const fallbackTmdbId = tmdbFromContext || tmdbFromPayload;

        if (fallbackTmdbId) {
            const tmdbPayload = await fetchMappingPayload({
                provider: 'tmdb',
                externalId: fallbackTmdbId,
                season: lookup.season,
                episode: lookup.episode
            }, providerContext);
            const tmdbPaths = extractAnimeSaturnPaths(tmdbPayload);
            if (tmdbPaths.length > 0) {
                mappingPayload = tmdbPayload;
                animePaths = tmdbPaths;
            }
        }
    }

    if (animePaths.length === 0) return [];

    const requestedEpisode = resolveEpisodeFromMappingPayload(mappingPayload, lookup.episode);
    const originalRequestedEpisode = normalizeRequestedEpisode(lookup.episode);
    const mediaType = meta?.isSeries ? 'tv' : 'movie';

    const perPathStreams = await mapLimit(animePaths, 3, (path) =>
        extractStreamsFromAnimePath(path, requestedEpisode, mediaType, originalRequestedEpisode)
    );

    const deduped = [];
    const seen = new Set();
    for (const stream of perPathStreams.flat().filter(Boolean)) {
        if (!stream?.url || seen.has(stream.url)) continue;
        seen.add(stream.url);
        deduped.push(stream);
    }

    return deduped;
}

module.exports = { searchAnimeSaturn };
