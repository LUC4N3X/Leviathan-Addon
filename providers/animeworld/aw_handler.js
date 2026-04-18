'use strict';
const {
    USER_AGENT,
    FETCH_TIMEOUT,
    uniqueStrings,
    parsePositiveInt,
    normalizeRequestedEpisode,
    toAbsoluteUrl,
    fetchWithTimeout,
    fetchResource,
    resolveLookupRequest,
    fetchMappingPayload,
    extractTmdbIdFromMappingPayload,
    buildAnimeProviderContext,
    mapLimit
} = require('../anime/provider_utils');

const AW_DOMAIN = 'https://www.animeworld.ac';
const BLOCKED_DOMAINS = [
    'jujutsukaisenanime.com',
    'onepunchman.it',
    'dragonballhd.it',
    'narutolegend.it'
];
const TTL = {
    info: 5 * 60 * 1000
};

function normalizeAnimeWorldPath(pathOrUrl) {
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
    const match = value.match(/^\/(?:play\/[^/?#]+|anime\/[^/?#]+)/i);
    return match ? match[0] : null;
}

function buildWorldUrl(pathOrUrl) {
    const text = String(pathOrUrl || '').trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith('/')) return `${AW_DOMAIN}${text}`;
    return `${AW_DOMAIN}/${text}`;
}

function decodeHtmlEntities(raw) {
    const decodedNumeric = String(raw || '')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const codePoint = Number.parseInt(hex, 16);
            if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return _;
            try {
                return String.fromCodePoint(codePoint);
            } catch {
                return _;
            }
        })
        .replace(/&#(\d+);/g, (_, dec) => {
            const codePoint = Number.parseInt(dec, 10);
            if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return _;
            try {
                return String.fromCodePoint(codePoint);
            } catch {
                return _;
            }
        });

    return decodedNumeric
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function sanitizeAnimeTitle(rawTitle) {
    let text = decodeHtmlEntities(rawTitle).trim();
    if (!text) return null;

    text = text
        .replace(/\s*-\s*AnimeWorld.*$/i, '')
        .replace(/\s+Streaming.*$/i, '')
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
    if (/(?:^|[-_/])ita(?:[-_/.?]|$)/i.test(pathText)) return 'ITA';
    return 'SUB';
}

function resolveLanguageLine(sourceTag) {
    return String(sourceTag || '').toUpperCase() === 'ITA'
        ? '🇮🇹 ITA • Dub'
        : '🇯🇵 JPN • Sub ITA';
}

function parseTagAttributes(tag) {
    const attrs = {};
    const regex = /([A-Za-z_:][A-Za-z0-9_:\-.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = regex.exec(String(tag || ''))) !== null) {
        const key = String(match[1] || '').trim().toLowerCase();
        const value = decodeHtmlEntities(match[3] ?? match[4] ?? '').trim();
        if (!key) continue;
        attrs[key] = value;
    }
    return attrs;
}

function parseEpisodeNumber(value, fallbackNum) {
    const text = String(value || '').trim();
    const directInt = parsePositiveInt(text);
    if (directInt) return directInt;
    const floatMatch = text.match(/(\d+(?:[.,]\d+)?)/);
    if (floatMatch) {
        const parsed = Number.parseFloat(floatMatch[1].replace(',', '.'));
        if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
    }
    return fallbackNum;
}

function normalizePlayableMediaUrl(rawUrl, depth = 0) {
    const absolute = toAbsoluteUrl(rawUrl, AW_DOMAIN);
    if (!absolute) return null;
    if (/\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(absolute)) return absolute;
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
        if (host.includes('sweetpixel')) return 'SweetPixel';
        if (host.includes('stream')) return 'Stream';
        const first = host.split('.')[0] || host;
        return first.charAt(0).toUpperCase() + first.slice(1);
    } catch (_) {
        return '';
    }
}

function collectMediaLinksFromHtml(html) {
    const links = [];
    const seen = new Set();

    function add(rawUrl) {
        const normalized = normalizePlayableMediaUrl(rawUrl);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        links.push(normalized);
    }

    const raw = String(html || '');
    for (const text of [raw, raw.replace(/\\\//g, '/')]) {
        let match;
        const directRegex = /https?:\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)(?:[^\s"'<>\\]*)?/gi;
        while ((match = directRegex.exec(text)) !== null) add(match[0]);

        const encodedRegex = /https%3A%2F%2F[^\s"'<>\\]+/gi;
        while ((match = encodedRegex.exec(text)) !== null) {
            try {
                add(decodeURIComponent(match[0]));
            } catch (_) {}
        }

        const sourceRegex = /(?:file|src|url|link)\s*[:=]\s*["']([^"']+)["']/gi;
        while ((match = sourceRegex.exec(text)) !== null) add(match[1]);
    }

    return links;
}

function extractTitleFromHtml(html) {
    const raw = String(html || '');
    const ogTitle = /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(raw);
    if (ogTitle?.[1]) return sanitizeAnimeTitle(ogTitle[1]);
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    if (titleTag?.[1]) return sanitizeAnimeTitle(titleTag[1]);
    return null;
}

function normalizeEpisodesList(sourceEpisodes = []) {
    if (!Array.isArray(sourceEpisodes) || sourceEpisodes.length === 0) return [];

    const output = [];
    const seen = new Set();

    for (let index = 0; index < sourceEpisodes.length; index += 1) {
        const entry = sourceEpisodes[index] || {};
        const num = parseEpisodeNumber(entry.num, index + 1);
        const episodeId = parsePositiveInt(entry.episodeId ?? entry.id);
        const episodeToken = String(entry.episodeToken || entry.token || '').trim() || null;
        if (!episodeId && !episodeToken) continue;

        const rangeLabel = String(entry.rangeLabel || '').trim() || null;
        const baseLabel = String(entry.baseLabel || '').trim() || null;
        const commentLabel = String(entry.commentLabel || '').trim() || null;
        const token = String(entry.token || (episodeToken ? `tok:${episodeToken}` : `ep:${episodeId}`)).trim() || `ep-${num}`;
        const key = `${num}|${episodeId || ''}|${episodeToken || ''}|${rangeLabel || ''}|${baseLabel || ''}|${commentLabel || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
            num,
            token,
            episodeId: episodeId || null,
            episodeToken,
            rangeLabel,
            baseLabel,
            commentLabel
        });
    }

    output.sort((a, b) => a.num - b.num);
    return output;
}

function parseEpisodesFromPageHtml(html) {
    const raw = String(html || '');
    const episodes = [];
    const anchorRegex = /<a\b[^>]*(?:data-episode-num=(?:"[^"]*"|'[^']*'))[^>]*(?:data-id=(?:"[^"]*"|'[^']*'))[^>]*>|<a\b[^>]*(?:data-id=(?:"[^"]*"|'[^']*'))[^>]*(?:data-episode-num=(?:"[^"]*"|'[^']*'))[^>]*>/gi;
    const tags = raw.match(anchorRegex) || [];

    for (let index = 0; index < tags.length; index += 1) {
        const attrs = parseTagAttributes(tags[index]);
        const episodeId = parsePositiveInt(attrs['data-episode-id'] || attrs['data-id']);
        const episodeToken = String(attrs['data-id'] || '').trim() || null;
        if (!episodeId && !episodeToken) continue;

        episodes.push({
            num: parseEpisodeNumber(attrs['data-episode-num'], index + 1),
            episodeId,
            episodeToken,
            rangeLabel: attrs['data-num'] || null,
            baseLabel: attrs['data-base'] || null,
            commentLabel: attrs['data-comment'] || null
        });
    }

    return normalizeEpisodesList(episodes);
}

function parseAnimeWorldPage(html, fallback = {}) {
    const title = extractTitleFromHtml(html) || sanitizeAnimeTitle(fallback.title) || null;
    const animePath = normalizeAnimeWorldPath(fallback.animePath || null);
    return {
        title,
        animePath,
        sourceTag: inferSourceTag(title, animePath),
        episodes: parseEpisodesFromPageHtml(html)
    };
}

function pickEpisodeEntry(episodes, requestedEpisode, mediaType = 'tv') {
    const list = normalizeEpisodesList(episodes);
    if (list.length === 0) return null;
    if (mediaType === 'movie') return list[0];

    const episode = normalizeRequestedEpisode(requestedEpisode);
    return list.find((entry) => entry.num === episode) || list[episode - 1] || (episode === 1 ? list[0] : null);
}

function getEpisodeDisplayLabel(entry, requestedNumber = null) {
    if (!entry) return requestedNumber ? String(requestedNumber) : null;
    for (const source of [entry.rangeLabel, entry.baseLabel, entry.commentLabel]) {
        const text = String(source || '').trim();
        const numeric = parsePositiveInt(text);
        if (numeric) return String(numeric);
        const match = text.match(/\d+(?:\.\d+)?/);
        if (match) return match[0];
    }
    if (parsePositiveInt(entry.num)) return String(entry.num);
    return requestedNumber ? String(requestedNumber) : null;
}

function collectGrabberCandidates(infoData) {
    const urls = [];

    for (const key of ['grabber', 'url', 'link', 'file', 'stream']) {
        const value = infoData?.[key];
        if (typeof value === 'string' && value.trim()) urls.push(value.trim());
    }

    for (const key of ['links', 'streams', 'servers', 'sources']) {
        const value = infoData?.[key];
        if (!Array.isArray(value)) continue;
        for (const item of value) {
            if (typeof item === 'string' && item.trim()) {
                urls.push(item.trim());
                continue;
            }
            if (!item || typeof item !== 'object') continue;
            const candidate = item.grabber || item.url || item.link || item.file || item.stream || null;
            if (candidate && String(candidate).trim()) urls.push(String(candidate).trim());
        }
    }

    return uniqueStrings(urls);
}

function extractSessionCookie(setCookieHeader) {
    const match = String(setCookieHeader || '').match(/sessionId=[^;,\s]+/i);
    return match ? match[0] : null;
}

function extractCsrfTokenFromHtml(html) {
    const match = /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(String(html || ''));
    return match?.[1] ? String(match[1]).trim() : null;
}

async function fetchAnimePageContext(animeUrl) {
    const response = await fetchWithTimeout(animeUrl, {
        method: 'GET',
        headers: {
            'user-agent': USER_AGENT,
            'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        redirect: 'follow'
    }, FETCH_TIMEOUT);

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${animeUrl}`);

    const html = await response.text();
    return {
        html,
        sessionCookie: extractSessionCookie(response.headers.get('set-cookie') || ''),
        csrfToken: extractCsrfTokenFromHtml(html)
    };
}

async function fetchEpisodeInfo(episodeRef, refererUrl, pageContext = null) {
    const token = String(episodeRef || '').trim();
    if (!token) return null;

    const extraHeaders = {};
    const csrfToken = String(pageContext?.csrfToken || '').trim();
    const sessionCookie = String(pageContext?.sessionCookie || '').trim();
    if (csrfToken) extraHeaders['csrf-token'] = csrfToken;
    if (sessionCookie) extraHeaders.cookie = sessionCookie;

    try {
        return await fetchResource(`${AW_DOMAIN}/api/episode/info?id=${encodeURIComponent(token)}`, {
            as: 'json',
            ttlMs: TTL.info,
            cacheKey: `animeworld-info:${token}:${csrfToken ? 'csrf' : 'nocsrf'}:${sessionCookie ? 'cookie' : 'nocookie'}`,
            timeoutMs: FETCH_TIMEOUT,
            headers: {
                referer: refererUrl,
                'x-requested-with': 'XMLHttpRequest',
                ...extraHeaders
            }
        });
    } catch (error) {
        console.error('[AnimeWorld] episode info request failed:', error.message);
        return null;
    }
}

async function extractStreamsFromAnimePath(animePath, requestedEpisode, mediaType = 'tv') {
    const normalizedPath = normalizeAnimeWorldPath(animePath);
    if (!normalizedPath) return [];

    const animeUrl = buildWorldUrl(normalizedPath);
    if (!animeUrl) return [];

    let parsedPage;
    let pageContext;
    try {
        pageContext = await fetchAnimePageContext(animeUrl);
        parsedPage = parseAnimeWorldPage(pageContext.html, { animePath: normalizedPath });
    } catch (error) {
        console.error('[AnimeWorld] anime page request failed:', error.message);
        return [];
    }

    const normalizedEpisode = normalizeRequestedEpisode(requestedEpisode);
    const selectedEpisode = pickEpisodeEntry(parsedPage.episodes, normalizedEpisode, mediaType);
    if (!selectedEpisode) return [];

    const infoRef = selectedEpisode.episodeToken || selectedEpisode.episodeId;
    const infoData = await fetchEpisodeInfo(infoRef, animeUrl, pageContext);
    if (!infoData || typeof infoData !== 'object') return [];

    const baseTitle = sanitizeAnimeTitle(parsedPage.title) || 'Anime';
    const episodeLabel = getEpisodeDisplayLabel(selectedEpisode, normalizedEpisode);
    const displayTitle = episodeLabel ? `${baseTitle} - Ep ${episodeLabel}` : baseTitle;
    const languageLine = resolveLanguageLine(parsedPage.sourceTag);
    const seen = new Set();
    const streams = [];

    for (const candidate of collectGrabberCandidates(infoData)) {
        const mediaUrl = normalizePlayableMediaUrl(candidate);
        if (!mediaUrl || seen.has(mediaUrl)) continue;

        const lowerUrl = mediaUrl.toLowerCase();
        if (lowerUrl.endsWith('.mkv.mp4') || BLOCKED_DOMAINS.some((domain) => lowerUrl.includes(domain))) continue;

        seen.add(mediaUrl);
        const quality = extractQualityHint(mediaUrl);
        const hostLabel = normalizeHostLabel(mediaUrl) || 'Direct';

        streams.push({
            name: `⛩️ AnimeWorld | ${quality}`,
            title: `${displayTitle}
${languageLine} • ${quality}
☁️ ${hostLabel} • AnimeWorld`,
            url: mediaUrl,
            extractor: hostLabel,
            behaviorHints: {
                notWebReady: false,
                extractor: hostLabel,
                bingieGroup: `animeworld|${String(parsedPage.sourceTag || 'sub').toLowerCase()}`,
                proxyHeaders: {
                    request: {
                        'User-Agent': USER_AGENT,
                        Referer: animeUrl
                    }
                }
            }
        });
    }

    if (streams.length === 0) {
        const targetUrl = toAbsoluteUrl(infoData.target || null, AW_DOMAIN);
        if (targetUrl) {
            try {
                const extraHeaders = {};
                const csrfToken = String(pageContext?.csrfToken || '').trim();
                const sessionCookie = String(pageContext?.sessionCookie || '').trim();
                if (csrfToken) extraHeaders['csrf-token'] = csrfToken;
                if (sessionCookie) extraHeaders.cookie = sessionCookie;

                const targetHtml = await fetchResource(targetUrl, {
                    ttlMs: TTL.info,
                    cacheKey: `animeworld-target:${targetUrl}`,
                    timeoutMs: FETCH_TIMEOUT,
                    headers: {
                        referer: animeUrl,
                        'x-requested-with': 'XMLHttpRequest',
                        ...extraHeaders
                    }
                });

                for (const mediaUrl of collectMediaLinksFromHtml(targetHtml)) {
                    if (!mediaUrl || seen.has(mediaUrl)) continue;
                    const lowerUrl = mediaUrl.toLowerCase();
                    if (lowerUrl.endsWith('.mkv.mp4') || BLOCKED_DOMAINS.some((domain) => lowerUrl.includes(domain))) continue;

                    seen.add(mediaUrl);
                    const quality = extractQualityHint(mediaUrl);
                    const hostLabel = normalizeHostLabel(mediaUrl) || 'Direct';

                    streams.push({
                        name: `⛩️ AnimeWorld | ${quality}`,
                        title: `${displayTitle}
${languageLine} • ${quality}
☁️ ${hostLabel} • AnimeWorld`,
                        url: mediaUrl,
                        extractor: hostLabel,
                        behaviorHints: {
                            notWebReady: false,
                            extractor: hostLabel,
                            bingieGroup: `animeworld|${String(parsedPage.sourceTag || 'sub').toLowerCase()}`,
                            proxyHeaders: {
                                request: {
                                    'User-Agent': USER_AGENT,
                                    Referer: animeUrl
                                }
                            }
                        }
                    });
                }
            } catch (error) {
                console.error('[AnimeWorld] target player request failed:', error.message);
            }
        }
    }

    return streams;
}

function extractAnimeWorldPaths(mappingPayload) {
    if (!mappingPayload || typeof mappingPayload !== 'object') return [];
    const raw = mappingPayload?.mappings?.animeworld;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const paths = [];

    for (const item of list) {
        const candidate = typeof item === 'string'
            ? item
            : item && typeof item === 'object'
                ? item.path || item.url || item.href || item.playPath
                : null;
        const normalized = normalizeAnimeWorldPath(candidate);
        if (normalized) paths.push(normalized);
    }

    return uniqueStrings(paths);
}

function resolveEpisodeFromMappingPayload(mappingPayload, fallbackEpisode) {
    return parsePositiveInt(mappingPayload?.kitsu?.episode)
        || parsePositiveInt(mappingPayload?.requested?.episode)
        || normalizeRequestedEpisode(fallbackEpisode);
}

async function searchAnimeWorld(requestId, meta, config) {
    if (!config?.filters?.enableAnimeWorld) return [];

    const providerContext = buildAnimeProviderContext(meta);
    const lookup = resolveLookupRequest(requestId, meta?.season, meta?.episode, providerContext);
    if (!lookup) return [];

    let mappingPayload = await fetchMappingPayload(lookup, providerContext);
    let animePaths = extractAnimeWorldPaths(mappingPayload);

    if (animePaths.length === 0 && String(lookup.provider || '').toLowerCase() === 'imdb') {
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
            const tmdbPaths = extractAnimeWorldPaths(tmdbPayload);
            if (tmdbPaths.length > 0) {
                mappingPayload = tmdbPayload;
                animePaths = tmdbPaths;
            }
        }
    }

    if (animePaths.length === 0) return [];

    const requestedEpisode = resolveEpisodeFromMappingPayload(mappingPayload, lookup.episode);
    const mediaType = meta?.isSeries ? 'tv' : 'movie';
    const perPathStreams = await mapLimit(animePaths, 3, (path) =>
        extractStreamsFromAnimePath(path, requestedEpisode, mediaType)
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

module.exports = { searchAnimeWorld };
