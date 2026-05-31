'use strict';
const cheerio = require('cheerio');
const {
    USER_AGENT,
    FETCH_TIMEOUT,
    uniqueStrings,
    parsePositiveInt,
    normalizeRequestedEpisode,
    toAbsoluteUrl,
    fetchWithTimeout,
    fetchResource,
    fetchMappingPayload,
    mapLimit
} = require('../anime/shared');
const kitsuProvider = require('./kitsu_provider');

function normalizeBaseDomain(value, fallback = 'https://www.animeworld.ac') {
    try {
        const parsed = new URL(String(value || fallback).trim());
        if (!['http:', 'https:'].includes(parsed.protocol)) return fallback;
        return `${parsed.protocol}//${parsed.host}`;
    } catch (_) {
        return fallback;
    }
}

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

const AW_DOMAIN = normalizeBaseDomain(process.env.AW_DOMAIN || process.env.ANIMEWORLD_DOMAIN || 'https://www.animeworld.ac');
const AW_FETCH_TIMEOUT = Math.max(
    FETCH_TIMEOUT,
    Number.parseInt(String(process.env.AW_PROVIDER_FETCH_TIMEOUT || process.env.AW_FETCH_TIMEOUT || '12000'), 10) || 12000
);
const AW_FORWARD_PROXY = normalizeForwardProxyBase(
    process.env.AW_FORWARD_PROXY ||
    process.env.ANIMEWORLD_FORWARD_PROXY ||
    process.env.ANIMEWORLD_FORWARD_PROXY_URL ||
    process.env.FORWARD_PROXY ||
    ''
);
const AW_FORWARD_PROXY_ENABLED = envFlag('AW_FORWARD_PROXY_ENABLED', Boolean(AW_FORWARD_PROXY));
const AW_FORWARD_PROXY_STREAMS = envFlag('AW_FORWARD_PROXY_STREAMS', envFlag('ANIMEWORLD_FORWARD_PROXY_STREAMS', false));
const AW_FORWARD_PROXY_API = envFlag('AW_FORWARD_PROXY_API', envFlag('ANIMEWORLD_FORWARD_PROXY_API', false));
const AW_PLAYLIST_QUALITY_ENABLED = envFlag('AW_PLAYLIST_QUALITY_ENABLED', true);
const BLOCKED_DOMAINS = [];
const TTL = {
    info: 5 * 60 * 1000,
    page: 10 * 60 * 1000,
    search: 10 * 60 * 1000
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

const awMemoryCache = new Map();

function normalizeForwardProxyBase(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw.replace(/\{url\}/g, 'https://example.com/'));
        if (!['http:', 'https:'].includes(parsed.protocol)) return '';
        return raw;
    } catch (_) {
        return '';
    }
}

function buildForwardProxyUrl(targetUrl, options = {}) {
    const target = String(targetUrl || '').trim();
    if (!/^https?:\/\//i.test(target)) return null;
    const enabled = options.force === true || (options.stream ? AW_FORWARD_PROXY_STREAMS : AW_FORWARD_PROXY_ENABLED);
    if (!enabled || !AW_FORWARD_PROXY) return null;

    try {
        const targetHost = new URL(target).host;
        const proxyHost = new URL(AW_FORWARD_PROXY.replace(/\{url\}/g, encodeURIComponent(target))).host;
        if (targetHost && proxyHost && targetHost === proxyHost) return target;
    } catch (_) {}

    if (AW_FORWARD_PROXY.includes('{url}')) {
        return AW_FORWARD_PROXY.replace(/\{url\}/g, encodeURIComponent(target));
    }

    if (/([?&][^=]*url=|=)$/i.test(AW_FORWARD_PROXY)) {
        return `${AW_FORWARD_PROXY}${encodeURIComponent(target)}`;
    }

    const separator = AW_FORWARD_PROXY.includes('?')
        ? (/[?&]$/.test(AW_FORWARD_PROXY) ? '' : '&')
        : '?';
    return `${AW_FORWARD_PROXY}${separator}url=${encodeURIComponent(target)}`;
}

function getFetchUrl(targetUrl, options = {}) {
    if (options.forwardProxy === false || options.useForwardProxy === false) return targetUrl;
    if (options.forwardProxy === true || options.useForwardProxy === true) {
        return buildForwardProxyUrl(targetUrl, { ...options, force: true }) || targetUrl;
    }
    return buildForwardProxyUrl(targetUrl, options) || targetUrl;
}

function getMemoryCache(key) {
    const entry = awMemoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        awMemoryCache.delete(key);
        return null;
    }
    return entry.value;
}

function setMemoryCache(key, value, ttlMs) {
    if (!ttlMs || ttlMs <= 0) return value;
    awMemoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (awMemoryCache.size > 300) {
        const firstKey = awMemoryCache.keys().next().value;
        if (firstKey === undefined) break;
        awMemoryCache.delete(firstKey);
    }
    return value;
}

let awSecurityCookie = null;

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

function resolveStreamLanguage(sourceTag) {
    return String(sourceTag || '').toUpperCase() === 'ITA' ? 'ita' : 'jpn';
}

function streamLanguageRank(stream = {}) {
    return String(stream?.language || '').toLowerCase() === 'ita' ? 0 : 1;
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

async function checkQualityFromPlaylist(mediaUrl, headers = {}) {
    if (!AW_PLAYLIST_QUALITY_ENABLED || !/\.m3u8(?:[?#].*)?$/i.test(String(mediaUrl || ''))) return null;
    try {
        const playlist = await fetchAnimeWorldResource(mediaUrl, {
            ttlMs: TTL.info,
            cacheKey: `animeworld-playlist:${mediaUrl}`,
            timeoutMs: Math.min(AW_FETCH_TIMEOUT, 6000),
            forwardProxy: AW_FORWARD_PROXY_STREAMS,
            headers
        });
        const text = String(playlist || '');
        const heights = [...text.matchAll(/RESOLUTION=\d+x(\d{3,4})/gi)]
            .map((match) => Number.parseInt(match[1], 10))
            .filter((value) => Number.isFinite(value) && value > 0);
        if (heights.length > 0) return `${Math.max(...heights)}p`;
        const names = [...text.matchAll(/(?:NAME|VIDEO)=['"]?(\d{3,4})p/gi)]
            .map((match) => Number.parseInt(match[1], 10))
            .filter((value) => Number.isFinite(value) && value > 0);
        return names.length > 0 ? `${Math.max(...names)}p` : null;
    } catch (_) {
        return null;
    }
}

function buildOutputStreamUrl(mediaUrl) {
    return buildForwardProxyUrl(mediaUrl, { stream: true }) || mediaUrl;
}

async function buildAnimeWorldStream(mediaUrl, context = {}) {
    const sourceUrl = normalizePlayableMediaUrl(mediaUrl);
    if (!sourceUrl) return null;
    const lowerUrl = sourceUrl.toLowerCase();
    if (lowerUrl.endsWith('.mkv.mp4') || BLOCKED_DOMAINS.some((domain) => lowerUrl.includes(domain))) return null;

    const referer = context.referer || context.animeUrl || AW_DOMAIN;
    const quality = await checkQualityFromPlaylist(sourceUrl, {
        'User-Agent': USER_AGENT,
        Referer: referer
    }) || extractQualityHint(sourceUrl);
    const hostLabel = normalizeHostLabel(sourceUrl) || 'Direct';

    return {
        name: `⛩️ AnimeWorld | ${quality}`,
        title: `${context.displayTitle || 'Anime'}\n${context.languageLine || '🇯🇵 JPN • Sub ITA'} • ${quality}\n☁️ ${hostLabel} • AnimeWorld`,
        url: buildOutputStreamUrl(sourceUrl),
        language: context.streamLanguage || 'jpn',
        extractor: hostLabel,
        behaviorHints: {
            notWebReady: false,
            extractor: hostLabel,
            bingieGroup: `animeworld|${String(context.sourceTag || 'sub').toLowerCase()}`,
            proxyHeaders: {
                request: {
                    'User-Agent': USER_AGENT,
                    Referer: referer
                }
            }
        }
    };
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
    const seen = new Set();

    function push(attrs = {}, text = '', fallbackIndex = 0) {
        const get = (...names) => {
            for (const name of names) {
                const value = attrs[name] ?? attrs[String(name || '').toLowerCase()];
                if (value != null && String(value).trim()) return String(value).trim();
            }
            return '';
        };

        const episodeId = parsePositiveInt(get('data-episode-id', 'episode-id', 'episodeId'))
            || parsePositiveInt(get('data-id', 'id'));
        const episodeToken = get('data-id', 'data-token', 'token', 'data-episode-token') || (episodeId ? String(episodeId) : null);
        if (!episodeId && !episodeToken) return;

        const numSource = get('data-episode-num', 'data-num', 'data-episode', 'episode', 'data-base', 'data-index') || text;
        const num = parseEpisodeNumber(numSource, fallbackIndex + 1);
        const key = `${num}|${episodeId || ''}|${episodeToken || ''}|${get('data-num')}|${get('data-base')}|${get('data-comment')}`;
        if (seen.has(key)) return;
        seen.add(key);

        episodes.push({
            num,
            episodeId: episodeId || null,
            episodeToken,
            rangeLabel: get('data-num') || null,
            baseLabel: get('data-base') || null,
            commentLabel: get('data-comment') || null
        });
    }

    try {
        const $ = cheerio.load(raw);
        $('[data-id], [data-episode-id], a[href*="/play/"], a[href*="/anime/"]').each((index, element) => {
            const attrs = {};
            for (const [key, value] of Object.entries(element.attribs || {})) attrs[String(key).toLowerCase()] = value;
            const href = attrs.href || '';
            if (!attrs['data-id'] && !attrs['data-episode-id']) {
                const hrefMatch = String(href).match(/(?:episode|episodio|ep)[-_/]?(\d{1,4})/i)
                    || String(href).match(/(?:^|[-_/])(\d{1,4})(?:$|[-_/])/);
                if (hrefMatch) attrs['data-id'] = hrefMatch[1];
            }
            push(attrs, collapseWhitespace($(element).text()), index);
        });
    } catch (_) {}

    const anchorRegex = /<a\b[^>]*(?:data-episode-num=(?:"[^"]*"|'[^']*'))[^>]*(?:data-id=(?:"[^"]*"|'[^']*'))[^>]*>|<a\b[^>]*(?:data-id=(?:"[^"]*"|'[^']*'))[^>]*(?:data-episode-num=(?:"[^"]*"|'[^']*'))[^>]*>/gi;
    const tags = raw.match(anchorRegex) || [];
    for (let index = 0; index < tags.length; index += 1) push(parseTagAttributes(tags[index]), '', index);

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
    const seen = new Set();
    const urlKeys = new Set([
        'grabber', 'url', 'link', 'file', 'stream', 'src', 'source', 'target', 'embed', 'iframe', 'player',
        'download', 'playlist', 'hls', 'mp4', 'm3u8', 'video', 'contenturl'
    ]);

    function push(value) {
        const text = String(value || '').trim();
        if (!text || seen.has(text)) return;
        seen.add(text);
        urls.push(text);
    }

    function shouldTreatAsUrl(key, value) {
        const normalizedKey = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const text = String(value || '').trim();
        return urlKeys.has(normalizedKey)
            || /^https?:\/\//i.test(text)
            || /^\/\//.test(text)
            || /\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(text)
            || /https?%3A%2F%2F/i.test(text);
    }

    function visit(value, depth = 0, key = '') {
        if (value == null || depth > 6) return;

        if (typeof value === 'string') {
            if (shouldTreatAsUrl(key, value)) push(value);
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1, key);
            return;
        }

        if (typeof value !== 'object') return;

        for (const [childKey, childValue] of Object.entries(value)) {
            if (typeof childValue === 'string' && shouldTreatAsUrl(childKey, childValue)) {
                push(childValue);
                continue;
            }
            visit(childValue, depth + 1, childKey);
        }
    }

    visit(infoData);
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

function collapseWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractYear(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : null;
}

function buildCookieHeader(...values) {
    const parts = [];

    for (const value of values) {
        const tokens = String(value || '')
            .split(';')
            .map((item) => item.trim())
            .filter((item) => item.includes('='));
        for (const token of tokens) parts.push(token);
    }

    const unique = uniqueStrings(parts);
    return unique.length > 0 ? unique.join('; ') : null;
}

function extractSecurityCookie(html, setCookieHeader = '') {
    const bodyMatch = String(html || '').match(/SecurityAW-[A-Za-z0-9]+=[^;"'\s>]+/i);
    if (bodyMatch?.[0]) return bodyMatch[0];

    const headerMatch = String(setCookieHeader || '').match(/SecurityAW-[^=]+=[^;,\s]+/i);
    return headerMatch?.[0] ? headerMatch[0] : null;
}

async function requestAnimeWorldResponse(url, options = {}) {
    const timeoutMs = options.timeoutMs || AW_FETCH_TIMEOUT;
    const requestUrl = getFetchUrl(url);
    const baseHeaders = {
        'user-agent': USER_AGENT,
        'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        ...(options.headers || {})
    };

    const initialCookie = buildCookieHeader(baseHeaders.cookie, baseHeaders.Cookie, awSecurityCookie);
    if (initialCookie) {
        delete baseHeaders.Cookie;
        baseHeaders.cookie = initialCookie;
    }

    let response = await fetchWithTimeout(requestUrl, {
        method: options.method || 'GET',
        headers: baseHeaders,
        body: options.body,
        redirect: 'follow'
    }, timeoutMs);

    let html = await response.text();
    const securityCookie = extractSecurityCookie(html, response.headers.get('set-cookie') || '');
    if ((response.status === 202 || securityCookie) && securityCookie) {
        awSecurityCookie = securityCookie;
        const retryCookie = buildCookieHeader(baseHeaders.cookie, awSecurityCookie);
        const retryHeaders = { ...baseHeaders };
        if (retryCookie) retryHeaders.cookie = retryCookie;

        response = await fetchWithTimeout(requestUrl, {
            method: options.method || 'GET',
            headers: retryHeaders,
            body: options.body,
            redirect: 'follow'
        }, timeoutMs);
        html = await response.text();
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    return { response, html, requestUrl };
}

async function fetchAnimeWorldResource(url, options = {}) {
    const requestUrl = getFetchUrl(url);
    return fetchResource(requestUrl, {
        ...options,
        cacheKey: options.cacheKey || url
    });
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

function parseAnimeWorldDateValue(value) {
    const cleaned = collapseWhitespace(decodeHtmlEntities(String(value || '')).replace(/^\?+\s*/, ''));
    if (!cleaned) return null;

    let match = cleaned.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})$/i);
    if (match) {
        const day = Number.parseInt(match[1], 10);
        const monthIndex = MONTHS[String(match[2] || '').trim().toLowerCase()];
        const year = Number.parseInt(match[3], 10);
        if (Number.isInteger(day) && Number.isInteger(monthIndex) && Number.isInteger(year)) {
            const date = new Date(Date.UTC(year, monthIndex, day));
            if (!Number.isNaN(date.getTime())) {
                return { date, exact: true };
            }
        }
    }

    match = cleaned.match(/^([A-Za-zÀ-ÿ]+)\s+(\d{4})$/i);
    if (match) {
        const monthIndex = MONTHS[String(match[1] || '').trim().toLowerCase()];
        const year = Number.parseInt(match[2], 10);
        if (Number.isInteger(monthIndex) && Number.isInteger(year)) {
            const date = new Date(Date.UTC(year, monthIndex, 1));
            if (!Number.isNaN(date.getTime())) {
                return { date, exact: false };
            }
        }
    }

    return null;
}

function extractReleaseDateFromPage(html) {
    const $ = cheerio.load(String(html || ''));
    let releaseDate = null;

    $('dt, label').each((_, element) => {
        if (releaseDate) return;

        const label = collapseWhitespace($(element).text());
        if (!/data di uscita/i.test(label)) return;

        const sibling = collapseWhitespace($(element).next('dd, span').first().text());
        if (sibling) releaseDate = sibling;
    });

    if (releaseDate) return releaseDate;

    const plainText = collapseWhitespace($.root().text());
    const match = plainText.match(/Data di Uscita:\s*(.+?)(?:Data di fine|Genere|Episodi|Stato|Studio|Durata|Voto|Trama|$)/i);
    return match?.[1] ? collapseWhitespace(match[1]) : null;
}

function matchesAnimeWorldDate(candidateDate, targetDate) {
    if (!candidateDate?.date || !targetDate) return false;

    if (candidateDate.exact) {
        const diffMs = Math.abs(candidateDate.date.getTime() - targetDate.getTime());
        return diffMs <= (2 * 24 * 60 * 60 * 1000);
    }

    return candidateDate.date.getUTCFullYear() === targetDate.getUTCFullYear()
        && candidateDate.date.getUTCMonth() === targetDate.getUTCMonth();
}

function parseAnimeWorldSearchCandidates(html) {
    const $ = cheerio.load(String(html || ''));
    const candidates = [];
    const seen = new Set();

    $('a.poster[href], a[href*="/play/"], a[href*="/anime/"]').each((_, element) => {
        const anchor = $(element);
        const animePath = normalizeAnimeWorldPath(anchor.attr('href'));
        if (!animePath) return;

        const infoUrl = toAbsoluteUrl(anchor.attr('data-tip') || anchor.attr('href') || animePath, AW_DOMAIN)
            || buildWorldUrl(animePath);
        const title = sanitizeAnimeTitle(anchor.attr('title') || anchor.attr('data-name') || anchor.text() || '');
        const key = `${animePath}|${infoUrl}`;
        if (seen.has(key)) return;

        seen.add(key);
        candidates.push({ animePath, infoUrl, title });
    });

    return candidates;
}

async function searchAnimeWorldCandidates(query, searchYear = null) {
    const encodedQuery = encodeURIComponent(String(query || '').trim());
    if (!encodedQuery) return [];

    const searchUrls = [
        searchYear ? `${AW_DOMAIN}/filter?year=${encodeURIComponent(searchYear)}&sort=2&keyword=${encodedQuery}` : null,
        `${AW_DOMAIN}/filter?sort=2&keyword=${encodedQuery}`,
        `${AW_DOMAIN}/search?keyword=${encodedQuery}`
    ].filter(Boolean);

    for (const searchUrl of searchUrls) {
        try {
            const { html } = await requestAnimeWorldResponse(searchUrl, {
                headers: { referer: AW_DOMAIN }
            });
            const candidates = parseAnimeWorldSearchCandidates(html);
            if (candidates.length > 0) return candidates;
        } catch (error) {
            console.error('[AnimeWorld] search request failed:', error.message);
        }
    }

    return [];
}

async function matchAnimeWorldCandidatesByDate(candidates, targetDate) {
    const matched = await mapLimit(candidates, 4, async (candidate) => {
        try {
            const lookupUrl = candidate.infoUrl || buildWorldUrl(candidate.animePath);
            if (!lookupUrl) return null;

            const { html } = await requestAnimeWorldResponse(lookupUrl, {
                headers: { referer: AW_DOMAIN }
            });
            const releaseDateValue = extractReleaseDateFromPage(html);
            const parsedDate = parseAnimeWorldDateValue(releaseDateValue);
            return matchesAnimeWorldDate(parsedDate, targetDate) ? candidate.animePath : null;
        } catch (error) {
            console.error('[AnimeWorld] release date request failed:', error.message);
            return null;
        }
    });

    return uniqueStrings(matched.filter(Boolean));
}

function normalizeAnimeWorldMappingValue(value) {
    if (!value) return null;
    const raw = typeof value === 'string'
        ? value
        : (value.path || value.url || value.href || value.link || value.animePath || value.anime_path || value.play || value.page || null);
    if (!raw) return null;
    return normalizeAnimeWorldPath(raw);
}

function extractAnimeWorldPathsFromMappingPayload(payload) {
    const out = [];
    const seen = new Set();

    const push = (value) => {
        const normalized = normalizeAnimeWorldMappingValue(value);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        out.push(normalized);
    };

    const directBuckets = [
        payload?.mappings?.animeworld,
        payload?.mappings?.animeWorld,
        payload?.mappings?.anime_world,
        payload?.mappings?.aw,
        payload?.mappings?.providers?.animeworld,
        payload?.mappings?.providers?.animeWorld,
        payload?.providers?.animeworld,
        payload?.providers?.animeWorld,
        payload?.animeworld,
        payload?.animeWorld,
        payload?.anime_world,
        payload?.aw
    ];

    for (const bucket of directBuckets) {
        if (Array.isArray(bucket)) bucket.forEach(push);
        else push(bucket);
    }

    const stack = [{ value: payload, depth: 0 }];
    const visited = new Set();
    while (stack.length && out.length < 12) {
        const { value, depth } = stack.pop();
        if (!value || typeof value !== 'object' || depth > 5 || visited.has(value)) continue;
        visited.add(value);

        for (const [key, child] of Object.entries(value)) {
            const normalizedKey = String(key || '').toLowerCase();
            if (/^(animeworld|anime_world|aw|animeworldpath|animeworldurl|animeworldhref)$/.test(normalizedKey)) {
                if (Array.isArray(child)) child.forEach(push);
                else push(child);
            }

            if (typeof child === 'string' && /animeworld\.|\/anime\/|\/play\//i.test(child)) push(child);
            if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
        }
    }

    return uniqueStrings(out);
}

async function resolveAnimeWorldPathsFromMapping(searchContext = {}) {
    const kitsuId = String(searchContext?.kitsuId || searchContext?.info?.kitsuId || '').trim();
    if (!/^\d+$/.test(kitsuId)) return [];

    const requestedEpisode = normalizeRequestedEpisode(searchContext?.requestedEpisode || searchContext?.episodeNumber || 1);
    const providerContext = {
        id: `kitsu:${kitsuId}:${requestedEpisode}`,
        kitsuId,
        mappingLanguage: 'it',
        italianOnly: true,
        onlyItalian: true,
        type: 'anime'
    };

    try {
        const payload = await fetchMappingPayload({
            provider: 'kitsu',
            externalId: kitsuId,
            season: null,
            episode: requestedEpisode,
            contentType: 'anime'
        }, providerContext);

        const paths = extractAnimeWorldPathsFromMappingPayload(payload);
        if (paths.length > 0) {
            console.log(`[AnimeWorld][KITSU] mapping paths=${paths.length} id=${kitsuId} ep=${requestedEpisode}`);
        }
        return paths;
    } catch (error) {
        console.error('[AnimeWorld][KITSU] mapping failed:', error.message);
        return [];
    }
}

async function resolveAnimeWorldPaths(searchContext) {
    const mappedPaths = await resolveAnimeWorldPathsFromMapping(searchContext);
    if (mappedPaths.length > 0) return mappedPaths;

    const targetDate = parseIsoDate(searchContext?.date);
    const searchYear = searchContext?.year || extractYear(searchContext?.date);
    const searchQueries = uniqueStrings([
        searchContext?.title,
        ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles.map((title) => kitsuProvider.normalizeTitle(title)) : [])
    ]).slice(0, 5);

    let fallbackPaths = [];

    for (const query of searchQueries) {
        const candidates = await searchAnimeWorldCandidates(query, searchYear);
        if (candidates.length === 0) continue;

        if (fallbackPaths.length === 0) {
            fallbackPaths = uniqueStrings(candidates.map((candidate) => candidate.animePath).filter(Boolean));
        }

        if (targetDate) {
            const matchedPaths = await matchAnimeWorldCandidatesByDate(candidates, targetDate);
            if (matchedPaths.length > 0) return matchedPaths;
        } else if (fallbackPaths.length > 0) {
            return fallbackPaths;
        }
    }

    return fallbackPaths;
}

async function fetchAnimePageContext(animeUrl) {
    const cacheKey = `animeworld-page:${animeUrl}:${awSecurityCookie || 'nosec'}`;
    const cached = getMemoryCache(cacheKey);
    if (cached) return cached;

    const { response, html } = await requestAnimeWorldResponse(animeUrl);
    const context = {
        html,
        sessionCookie: buildCookieHeader(
            extractSessionCookie(response.headers.get('set-cookie') || ''),
            awSecurityCookie
        ),
        csrfToken: extractCsrfTokenFromHtml(html)
    };

    return setMemoryCache(cacheKey, context, TTL.page);
}

async function fetchEpisodeInfo(episodeRef, refererUrl, pageContext = null) {
    const token = String(episodeRef || '').trim();
    if (!token) return null;

    const extraHeaders = {};
    const csrfToken = String(pageContext?.csrfToken || '').trim();
    const sessionCookie = String(pageContext?.sessionCookie || '').trim();
    if (csrfToken) extraHeaders['csrf-token'] = csrfToken;
    const cookieHeader = buildCookieHeader(sessionCookie, awSecurityCookie);
    if (cookieHeader) extraHeaders.cookie = cookieHeader;

    const apiUrl = `${AW_DOMAIN}/api/episode/info?id=${encodeURIComponent(token)}`;
    const requestOptions = {
        as: 'json',
        ttlMs: TTL.info,
        cacheKey: `animeworld-info:${token}:${csrfToken ? 'csrf' : 'nocsrf'}:${sessionCookie ? 'cookie' : 'nocookie'}:direct`,
        timeoutMs: AW_FETCH_TIMEOUT,
        forwardProxy: false,
        headers: {
            referer: refererUrl,
            origin: AW_DOMAIN,
            accept: 'application/json, text/javascript, */*; q=0.01',
            'x-requested-with': 'XMLHttpRequest',
            ...extraHeaders
        }
    };

    try {
        return await fetchAnimeWorldResource(apiUrl, requestOptions);
    } catch (error) {
        if (AW_FORWARD_PROXY_API) {
            try {
                return await fetchAnimeWorldResource(apiUrl, {
                    ...requestOptions,
                    cacheKey: requestOptions.cacheKey.replace(':direct', ':proxy'),
                    forwardProxy: true
                });
            } catch (proxyError) {
                console.error('[AnimeWorld] episode info request failed:', proxyError.message);
                return null;
            }
        }
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
    const streamLanguage = resolveStreamLanguage(parsedPage.sourceTag);
    const seen = new Set();
    const streams = [];

    for (const candidate of collectGrabberCandidates(infoData)) {
        const mediaUrl = normalizePlayableMediaUrl(candidate);
        if (!mediaUrl || seen.has(mediaUrl)) continue;
        const stream = await buildAnimeWorldStream(mediaUrl, {
            animeUrl,
            referer: animeUrl,
            displayTitle,
            languageLine,
            streamLanguage,
            sourceTag: parsedPage.sourceTag
        });
        if (!stream) continue;
        seen.add(mediaUrl);
        streams.push(stream);
    }

    if (streams.length === 0) {
        const targetCandidates = uniqueStrings([
            infoData.target,
            infoData.embed,
            infoData.iframe,
            infoData.player,
            infoData.src,
            ...collectGrabberCandidates(infoData)
        ]
            .map((value) => toAbsoluteUrl(value, AW_DOMAIN))
            .filter(Boolean)
            .filter((value) => !/\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(String(value))));

        for (const targetUrl of targetCandidates.slice(0, 5)) {
            try {
                const extraHeaders = {};
                const csrfToken = String(pageContext?.csrfToken || '').trim();
                const sessionCookie = String(pageContext?.sessionCookie || '').trim();
                if (csrfToken) extraHeaders['csrf-token'] = csrfToken;
                const cookieHeader = buildCookieHeader(sessionCookie, awSecurityCookie);
                if (cookieHeader) extraHeaders.cookie = cookieHeader;

                const targetHtml = await fetchAnimeWorldResource(targetUrl, {
                    ttlMs: TTL.info,
                    cacheKey: `animeworld-target:${targetUrl}`,
                    timeoutMs: AW_FETCH_TIMEOUT,
                    headers: {
                        referer: animeUrl,
                        'x-requested-with': 'XMLHttpRequest',
                        ...extraHeaders
                    }
                });

                for (const mediaUrl of collectMediaLinksFromHtml(targetHtml)) {
                    if (!mediaUrl || seen.has(mediaUrl)) continue;
                    const stream = await buildAnimeWorldStream(mediaUrl, {
                        animeUrl,
                        referer: targetUrl,
                        displayTitle,
                        languageLine,
                        streamLanguage,
                        sourceTag: parsedPage.sourceTag
                    });
                    if (!stream) continue;
                    seen.add(mediaUrl);
                    streams.push(stream);
                }

                if (streams.length > 0) break;
            } catch (error) {
                console.error('[AnimeWorld] target player request failed:', error.message);
            }
        }
    }

    return streams;
}

async function searchAnimeWorld(requestId, meta, config) {
    if (!config?.filters?.enableAnimeWorld) return [];

    const searchContext = await kitsuProvider.buildSearchContext(requestId, meta);
    const animePaths = await resolveAnimeWorldPaths(searchContext);
    if (animePaths.length === 0) return [];

    const requestedEpisode = normalizeRequestedEpisode(searchContext?.requestedEpisode || meta?.episode);
    const mediaType = searchContext?.isMovie ? 'movie' : 'tv';
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

    return deduped.sort((a, b) => streamLanguageRank(a) - streamLanguageRank(b));
}

module.exports = {
    searchAnimeWorld,
    resolveAnimeWorldPaths,
    extractStreamsFromAnimePath,
    buildForwardProxyUrl,
    resolveAnimeWorldPathsFromMapping,
    extractAnimeWorldPathsFromMappingPayload
};
