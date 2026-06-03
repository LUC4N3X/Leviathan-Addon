'use strict';

const axios = require('axios');
const he = require('he');
const { URL } = require('url');

const tmdbHelper = require('../../core/utils/tmdb_helper');
const {
    buildWebStream,
    cleanHostLabel,
    normalizeQuality,
    pickBetterQuality
} = require('../extractors/common');
const { extractFromUrl, resolveExtractorDefinition, HOSTER_DIRECT_LINK_PATTERN } = require('../extractors/registry');
const { isVoeUrl } = require('../extractors/hosters/voe');
const { isLoadmUrl } = require('../extractors/hosters/loadm');
const { isMaxstreamUrl } = require('../extractors/hosters/maxstream');
const { TtlLruCache, SingleFlight } = require('../utils/provider_runtime');
const { normalizeStreams } = require('../utils/stream_normalizer');
const { requestWithImpit } = require('../utils/bypass');
const { buildExtractorUrl, buildProxyUrl, getMediaflowBase } = require('../../core/proxy/mediaflow_gateway');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const DEFAULT_DOMAINS = Object.freeze([
    'https://toonitalia.xyz',
    'https://toonitalia.org',
    'https://toonitalia.co',
    'https://toonitalia.fun'
]);

const CONFIG = Object.freeze({
    REQUEST_TIMEOUT_MS: intEnv('TOONITALIA_TIMEOUT_MS', 9000, 2500, 30000),
    RESOLVE_TIMEOUT_MS: intEnv('TOONITALIA_RESOLVE_TIMEOUT_MS', 8500, 2500, 30000),
    SEARCH_PER_PAGE: intEnv('TOONITALIA_SEARCH_PER_PAGE', 10, 1, 20),
    MAX_SEARCH_RESULTS: intEnv('TOONITALIA_MAX_SEARCH_RESULTS', 8, 1, 20),
    MAX_CANDIDATE_LINKS: intEnv('TOONITALIA_MAX_LINKS', 8, 1, 24),
    MAX_RESOLVES: intEnv('TOONITALIA_MAX_RESOLVES', 4, 1, 10),
    CACHE_TTL_MS: intEnv('TOONITALIA_CACHE_TTL_MS', 10 * 60 * 1000, 30 * 1000, 12 * 60 * 60 * 1000),
    STALE_TTL_MS: intEnv('TOONITALIA_STALE_TTL_MS', 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000),
    DOMAIN_TTL_MS: intEnv('TOONITALIA_DOMAIN_TTL_MS', 15 * 60 * 1000, 30 * 1000, 12 * 60 * 60 * 1000),
    DEBUG: boolEnv('TOONITALIA_DEBUG', false),
    MFP_FALLBACK: boolEnv('TOONITALIA_MFP_FALLBACK', true),
    VOE_PROXY_PLAYBACK: boolEnv('TOONITALIA_VOE_PROXY_PLAYBACK', true)
});

const httpClient = axios.create({
    timeout: CONFIG.REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: () => true,
    headers: baseHeaders()
});

const resultCache = new TtlLruCache({
    name: 'toonitalia:streams',
    max: 300,
    ttlMs: CONFIG.CACHE_TTL_MS,
    staleTtlMs: CONFIG.STALE_TTL_MS,
    staleMode: 'extension',
    cloneValues: true
});

const domainCache = new TtlLruCache({
    name: 'toonitalia:domain',
    max: 8,
    ttlMs: CONFIG.DOMAIN_TTL_MS,
    staleTtlMs: CONFIG.DOMAIN_TTL_MS * 2,
    staleMode: 'extension'
});

const inflight = new SingleFlight('toonitalia');

function boolEnv(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(?:1|true|yes|on)$/i.test(String(raw).trim());
}

function intEnv(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function debug(message, payload = null) {
    if (!CONFIG.DEBUG) return;
    if (payload && typeof payload === 'object') {
        try { console.info(`[ToonItalia] ${message} ${JSON.stringify(payload)}`); }
        catch (_) { console.info(`[ToonItalia] ${message}`); }
    } else {
        console.info(`[ToonItalia] ${message}`);
    }
}

function baseHeaders(extra = {}) {
    return {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'DNT': '1',
        ...extra
    };
}

function providerDomains() {
    const extra = String(process.env.TOONITALIA_DOMAINS || '')
        .split(/[,;|\s]+/)
        .map((value) => value.trim())
        .filter(Boolean);
    return [...new Set([...extra, ...DEFAULT_DOMAINS].map((value) => value.replace(/\/+$/g, '')))].filter((value) => /^https?:\/\//i.test(value));
}

function normalizeText(value) {
    return he.decode(String(value || ''))
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&[#a-z0-9]+;/gi, ' ')
        .replace(/[^a-z0-9]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeTitleForSearch(value) {
    return normalizeText(value)
        .replace(/\b(?:stagione|season|serie|streaming|ita|subita|sub\s*ita|episodi?|film)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleMatches(queryTitle, resultTitle) {
    const query = normalizeTitleForSearch(queryTitle);
    const result = normalizeTitleForSearch(resultTitle);
    if (!query || !result) return false;
    if (result.includes(query) || query.includes(result)) return true;
    const queryTokens = query.split(' ').filter((token) => token.length > 2);
    if (!queryTokens.length) return false;
    const hits = queryTokens.filter((token) => result.includes(token)).length;
    return hits / queryTokens.length >= 0.72;
}

function cleanTitle(meta = {}, tmdbMeta = null) {
    const title = tmdbMeta?.title
        || meta?.title
        || meta?.name
        || meta?.original_title
        || meta?.originalName
        || meta?.original_name
        || '';
    return String(title || '').trim();
}

function mediaLabel(meta = {}, tmdbMeta = null) {
    const title = cleanTitle(meta, tmdbMeta) || 'ToonItalia';
    if (meta?.isSeries) {
        const season = String(meta?.season || tmdbMeta?.season || 1).padStart(2, '0');
        const episode = String(meta?.episode || tmdbMeta?.episode || 1).padStart(2, '0');
        return `${title} S${season}E${episode}`;
    }
    const year = tmdbMeta?.year || meta?.year || meta?.releaseInfo || '';
    return year ? `${title} (${String(year).slice(0, 4)})` : title;
}

async function fetchText(url, { headers = {}, timeout = CONFIG.REQUEST_TIMEOUT_MS, json = false } = {}) {
    const finalHeaders = baseHeaders(headers);
    try {
        const response = await httpClient.get(url, {
            headers: finalHeaders,
            timeout,
            responseType: json ? 'json' : 'text',
            validateStatus: () => true
        });
        return {
            status: Number(response.status || 0),
            text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data || ''),
            data: response.data,
            headers: response.headers || {},
            via: 'axios'
        };
    } catch (axiosError) {
        try {
            const response = await requestWithImpit({
                url,
                method: 'GET',
                headers: finalHeaders,
                responseType: 'text',
                timeout,
                ignoreTlsErrors: true,
                followRedirect: true,
                maxRedirects: 5
            });
            const body = response?.body || '';
            return {
                status: Number(response?.statusCode || 0),
                text: body,
                data: json ? safeJsonParse(body) : body,
                headers: response?.headers || {},
                via: 'impit'
            };
        } catch (_) {
            return {
                status: Number(axiosError?.response?.status || 0),
                text: '',
                data: null,
                headers: {},
                via: 'failed'
            };
        }
    }
}

function safeJsonParse(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); }
    catch (_) { return null; }
}

async function resolveActiveDomain() {
    const cached = domainCache.get('active', { allowStale: true });
    if (cached) return cached;

    for (const domain of providerDomains()) {
        const probeUrl = `${domain}/wp-json/wp/v2/search?search=test&per_page=1`;
        const response = await fetchText(probeUrl, {
            headers: { Referer: `${domain}/` },
            timeout: Math.min(CONFIG.REQUEST_TIMEOUT_MS, 6500),
            json: true
        });
        const data = Array.isArray(response.data) ? response.data : safeJsonParse(response.text);
        if (response.status === 200 && Array.isArray(data)) {
            domainCache.set('active', domain, { ttlMs: CONFIG.DOMAIN_TTL_MS });
            debug('active domain', { domain, via: response.via });
            return domain;
        }
    }

    const fallback = DEFAULT_DOMAINS[0];
    domainCache.set('active', fallback, { ttlMs: 60 * 1000 });
    return fallback;
}

async function resolveMeta(meta = {}, config = {}) {
    const mediaHint = meta?.isSeries ? 'tv' : 'movie';
    const tmdbMeta = await tmdbHelper.resolveFromMeta(meta, {
        type: mediaHint,
        language: 'it-IT',
        userKey: config?.tmdb
    }).catch(() => null);

    return tmdbMeta || {
        title: meta?.title || meta?.name || meta?.original_title || meta?.originalName || '',
        year: meta?.year || String(meta?.releaseInfo || '').slice(0, 4) || null,
        type: mediaHint,
        season: meta?.season || null,
        episode: meta?.episode || null,
        imdb_id: meta?.imdb_id || meta?.imdbId || null
    };
}

function getPostApiUrl(item, domain) {
    const self = item?._links?.self?.[0]?.href || item?._links?.self?.href;
    if (self) return self;
    if (item?.url && /^https?:\/\//i.test(item.url)) return item.url;
    if (item?.link && /^https?:\/\//i.test(item.link)) return item.link;
    if (item?.id) return `${domain}/wp-json/wp/v2/posts/${item.id}`;
    return null;
}

async function searchPosts(domain, title) {
    const searchTitle = normalizeTitleForSearch(title);
    if (!searchTitle) return [];

    const url = `${domain}/wp-json/wp/v2/search?search=${encodeURIComponent(searchTitle)}&per_page=${CONFIG.SEARCH_PER_PAGE}`;
    const response = await fetchText(url, {
        headers: { Referer: `${domain}/` },
        timeout: CONFIG.REQUEST_TIMEOUT_MS,
        json: true
    });
    const data = Array.isArray(response.data) ? response.data : safeJsonParse(response.text);
    if (!Array.isArray(data)) return [];
    return data
        .filter((item) => titleMatches(searchTitle, item?.title || item?.title?.rendered || item?.slug || ''))
        .slice(0, CONFIG.MAX_SEARCH_RESULTS);
}

async function fetchPostContent(item, domain) {
    const apiUrl = getPostApiUrl(item, domain);
    if (!apiUrl) return null;

    const response = await fetchText(apiUrl, {
        headers: { Referer: `${domain}/` },
        timeout: CONFIG.REQUEST_TIMEOUT_MS,
        json: /\/wp-json\//i.test(apiUrl)
    });

    const data = response.data && typeof response.data === 'object' ? response.data : safeJsonParse(response.text);
    if (data && typeof data === 'object' && data.content) {
        return {
            title: data?.title?.rendered || item?.title || '',
            html: String(data?.content?.rendered || ''),
            link: data?.link || item?.url || item?.link || apiUrl
        };
    }

    return {
        title: item?.title || '',
        html: String(response.text || ''),
        link: item?.url || item?.link || apiUrl
    };
}

function extractLinksFromHtml(html) {
    const decoded = he.decode(String(html || '')).replace(/\\\//g, '/');
    const links = [];
    const seen = new Set();
    const add = (value) => {
        const normalized = normalizeCandidateUrl(value);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        links.push(normalized);
    };

    const hrefRe = /(?:href|src|data-src|data-link|data-url)=["']([^"']+)["']/gi;
    for (const match of decoded.matchAll(hrefRe)) add(match[1]);

    const directRe = new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'gi');
    for (const match of decoded.matchAll(directRe)) add(match[0]);

    return links;
}

function normalizeCandidateUrl(value) {
    let raw = he.decode(String(value || '').trim())
        .replace(/\\\//g, '/')
        .replace(/^['"`]+|['"`>,;)\]]+$/g, '')
        .replace(/&amp;/gi, '&');
    if (!raw || !/^https?:\/\//i.test(raw)) return '';
    try {
        const parsed = new URL(raw);
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return raw;
    }
}

function isSupportedCandidate(url) {
    if (!url) return false;
    if (resolveExtractorDefinition(url)) return true;
    if (isVoeUrl(url) || isLoadmUrl(url) || isMaxstreamUrl(url)) return true;
    return /\.(?:m3u8|mp4)(?:$|[?#])/i.test(url);
}

function providerPriority(url) {
    if (isLoadmUrl(url)) return 0;
    if (isMaxstreamUrl(url)) return 1;
    if (isVoeUrl(url)) return 2;
    if (resolveExtractorDefinition(url)) return 3;
    return 9;
}

function extractEpisodeLinks(html, season, episode) {
    const decoded = he.decode(String(html || ''));
    const s = String(Number.parseInt(season, 10) || 1);
    const ep = String(Number.parseInt(episode, 10) || 1).padStart(2, '0');
    const epRaw = String(Number.parseInt(episode, 10) || 1);
    const markers = [
        `${s}&#215;${ep}`,
        `${s}x${ep}`,
        `${s}×${ep}`,
        `${s} x ${ep}`,
        `${s}x${epRaw}`,
        `S${String(s).padStart(2, '0')}E${ep}`,
        `S${s}E${epRaw}`
    ];

    const lower = decoded.toLowerCase();
    let start = -1;
    let used = '';
    for (const marker of markers) {
        const index = lower.indexOf(marker.toLowerCase());
        if (index !== -1 && (start === -1 || index < start)) {
            start = index;
            used = marker;
        }
    }

    if (start === -1) return [];

    const nextEp = String((Number.parseInt(episode, 10) || 1) + 1).padStart(2, '0');
    const nextMarkers = [
        `${s}&#215;${nextEp}`,
        `${s}x${nextEp}`,
        `${s}×${nextEp}`,
        `${s} x ${nextEp}`,
        `S${String(s).padStart(2, '0')}E${nextEp}`
    ];
    let end = decoded.length;
    for (const marker of nextMarkers) {
        const index = lower.indexOf(marker.toLowerCase(), start + used.length);
        if (index !== -1 && index < end) end = index;
    }

    for (const marker of [`Stagione ${Number(s) + 1}`, `STAGIONE ${Number(s) + 1}`, `stagione ${Number(s) + 1}`]) {
        const index = decoded.indexOf(marker, start + used.length);
        if (index !== -1 && index < end) end = index;
    }

    return extractLinksFromHtml(decoded.slice(start, end)).filter(isSupportedCandidate);
}

function extractMovieLinks(html) {
    const decoded = he.decode(String(html || ''));
    const links = [];
    const seen = new Set();
    const add = (url) => {
        const normalized = normalizeCandidateUrl(url);
        if (!normalized || seen.has(normalized) || !isSupportedCandidate(normalized)) return;
        seen.add(normalized);
        links.push(normalized);
    };

    const labelledRe = /href=["']([^"']+)["'][^>]*>\s*(?:<[^>]+>\s*)*(?:Link\s*)?(?:VOE|Maxstream|RPM(?:Share|Play)?|LoadM|Stream)/gi;
    for (const match of decoded.matchAll(labelledRe)) add(match[1]);
    for (const url of extractLinksFromHtml(decoded)) add(url);
    return links;
}

function dedupeUrls(urls = []) {
    const seen = new Set();
    return urls.filter((url) => {
        const key = String(url || '').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function makeSemaphore(limit) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= limit || queue.length === 0) return;
        active += 1;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                active -= 1;
                next();
            });
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

function hostLabel(url, fallback = 'Stream') {
    if (isLoadmUrl(url)) return 'LoadM';
    if (isMaxstreamUrl(url)) return 'MaxStream';
    if (isVoeUrl(url)) return 'VOE';
    const definition = resolveExtractorDefinition(url);
    if (definition?.label) return definition.label;
    return cleanHostLabel(url) || fallback;
}

function buildFallbackExtractorStream(candidateUrl, config, reqHost, label, title) {
    if (!CONFIG.MFP_FALLBACK || !getMediaflowBase(config)) return null;
    const extractorUrl = buildExtractorUrl(config, candidateUrl, label, {
        headers: {
            Referer: `${getOriginSafe(candidateUrl)}/`,
            Origin: getOriginSafe(candidateUrl),
            'User-Agent': USER_AGENT
        }
    });
    if (!extractorUrl || extractorUrl === candidateUrl) return null;
    return buildWebStream({
        name: `🎞️ ${label}`,
        title,
        url: extractorUrl,
        extractor: label,
        provider: 'ToonItalia',
        providerCode: 'TI',
        quality: 'Unknown',
        addonBase: reqHost,
        notWebReady: false,
        extraBehaviorHints: {
            bingeGroup: `toonitalia-${label.toLowerCase()}`,
            playbackProxy: 'mediaflow-extractor',
            vortexSource: 'ToonItalia',
            vortexExtractor: label,
            vortexMeta: { provider: 'ToonItalia', source: 'ToonItalia', site: 'ToonItalia', extractor: label }
        }
    });
}

function getOriginSafe(url) {
    try { return new URL(url).origin; }
    catch (_) { return ''; }
}


function isVoePlayback(label, extracted = {}) {
    const text = [label, extracted?.extractor, extracted?.name, extracted?.sourceUrl, extracted?.url]
        .filter(Boolean)
        .join(' ');
    return /\bvoe\b|voe\.sx|voe\.to|v-o-e|voe-unblock/i.test(text) || isVoeUrl(extracted?.sourceUrl || '');
}

function isHlsPlaybackUrl(url) {
    return /\.m3u8(?:$|[?#])/i.test(String(url || ''));
}

function maybeProxyToonItaliaPlayback(streamUrl, playbackHeaders, { config = {}, label = '', extracted = {} } = {}) {
    const normalizedUrl = String(streamUrl || '').trim();
    if (!normalizedUrl) return { url: normalizedUrl, proxied: false, mode: 'empty', headers: playbackHeaders || {} };

    const shouldUseProxy = CONFIG.VOE_PROXY_PLAYBACK && isVoePlayback(label, extracted) && Boolean(getMediaflowBase(config));
    if (!shouldUseProxy) {
        return { url: normalizedUrl, proxied: false, mode: 'direct', headers: playbackHeaders || {} };
    }

    try {
        const proxyUrl = buildProxyUrl(config, normalizedUrl, playbackHeaders || {}, {
            isHls: isHlsPlaybackUrl(normalizedUrl),
            allowCookie: false
        });
        if (proxyUrl && proxyUrl !== normalizedUrl) {
            return { url: proxyUrl, proxied: true, mode: isHlsPlaybackUrl(normalizedUrl) ? 'mediaflow-hls' : 'mediaflow-stream', headers: {} };
        }
    } catch (error) {
        debug('voe proxy playback failed', { url: normalizedUrl, error: error?.message || String(error) });
    }

    return { url: normalizedUrl, proxied: false, mode: 'direct-fallback', headers: playbackHeaders || {} };
}

async function resolveCandidate(candidateUrl, { meta, tmdbMeta, config, reqHost }) {
    const label = hostLabel(candidateUrl);
    const title = mediaLabel(meta, tmdbMeta);

    if (/\.(?:m3u8|mp4)(?:$|[?#])/i.test(candidateUrl) && !resolveExtractorDefinition(candidateUrl)) {
        return buildWebStream({
            name: '🎞️ Direct',
            title,
            url: candidateUrl,
            extractor: 'Direct',
            provider: 'ToonItalia',
            providerCode: 'TI',
            quality: normalizeQuality(candidateUrl),
            addonBase: reqHost,
            headers: {
                Referer: `${getOriginSafe(candidateUrl)}/`,
                Origin: getOriginSafe(candidateUrl),
                'User-Agent': USER_AGENT
            },
            extraBehaviorHints: {
                bingeGroup: 'toonitalia-direct',
                vortexSource: 'ToonItalia',
                vortexExtractor: 'Direct'
            }
        });
    }

    const extracted = await extractFromUrl(candidateUrl, {
        client: httpClient,
        config,
        reqHost,
        timeout: CONFIG.RESOLVE_TIMEOUT_MS,
        metadataTimeout: Math.min(CONFIG.RESOLVE_TIMEOUT_MS, 6000),
        probeTimeout: Math.min(CONFIG.RESOLVE_TIMEOUT_MS, 5000),
        userAgent: USER_AGENT,
        referer: `${getOriginSafe(candidateUrl)}/`,
        logger: console
    });

    if (!extracted?.url) {
        return buildFallbackExtractorStream(candidateUrl, config, reqHost, label, title);
    }

    const quality = pickBetterQuality(extracted.quality || 'Unknown', candidateUrl);
    const playbackHeaders = extracted.headers || {
        Referer: `${getOriginSafe(extracted.sourceUrl || candidateUrl)}/`,
        Origin: getOriginSafe(extracted.sourceUrl || candidateUrl),
        'User-Agent': USER_AGENT
    };
    const playback = maybeProxyToonItaliaPlayback(extracted.url, playbackHeaders, {
        config,
        label,
        extracted
    });

    return buildWebStream({
        name: `🎞️ ${extracted.name || label}`,
        title,
        url: playback.url,
        extractor: extracted.extractor || label,
        provider: 'ToonItalia',
        providerCode: 'TI',
        quality,
        addonBase: reqHost,
        headers: playback.proxied ? null : playback.headers,
        notWebReady: false,
        extraBehaviorHints: {
            bingeGroup: `toonitalia-${String(extracted.key || label).toLowerCase()}`,
            vortexSource: 'ToonItalia',
            vortexExtractor: extracted.extractor || label,
            playbackProxy: playback.mode,
            voeProxyPlayback: playback.proxied === true,
            vortexMeta: {
                provider: 'ToonItalia',
                source: 'ToonItalia',
                site: 'ToonItalia',
                extractor: extracted.extractor || label,
                sourceUrl: extracted.sourceUrl || candidateUrl,
                bridgeSourceUrl: extracted.bridgeSourceUrl || undefined,
                playbackProxy: playback.mode,
                voeProxyPlayback: playback.proxied === true
            }
        }
    });
}

function cacheKey(meta = {}) {
    const id = meta?.imdb_id || meta?.imdbId || meta?.id || meta?.tmdb_id || meta?.tmdbId || meta?.title || 'unknown';
    return [id, meta?.isSeries ? 'tv' : 'movie', meta?.season || 0, meta?.episode || 0].join(':');
}

async function searchToonItaliaImpl(meta = {}, config = {}, reqHost = null) {
    if (!isToonItaliaRuntimeEnabled({ filters: config?.filters || {} })) return [];

    const tmdbMeta = await resolveMeta(meta, config);
    const title = cleanTitle(meta, tmdbMeta);
    if (!title) return [];

    const domain = await resolveActiveDomain();
    const posts = await searchPosts(domain, title);
    if (!posts.length) return [];

    const streams = [];
    const runLimited = makeSemaphore(CONFIG.MAX_RESOLVES);

    for (const item of posts) {
        const post = await fetchPostContent(item, domain).catch(() => null);
        if (!post?.html) continue;
        if (post.title && !titleMatches(title, post.title) && !titleMatches(title, item?.title || '')) continue;

        const hasSeasons = /stagione|\bS\d{1,2}E\d{1,3}\b|\d+\s*(?:x|×|&#215;)\s*\d+/i.test(post.html);
        if (meta?.isSeries && !hasSeasons) continue;
        if (!meta?.isSeries && hasSeasons && !/film|movie/i.test(post.title || '')) continue;

        const candidateLinks = meta?.isSeries
            ? extractEpisodeLinks(post.html, meta?.season || tmdbMeta?.season || 1, meta?.episode || tmdbMeta?.episode || 1)
            : extractMovieLinks(post.html);

        const candidates = dedupeUrls(candidateLinks)
            .filter(isSupportedCandidate)
            .sort((a, b) => providerPriority(a) - providerPriority(b))
            .slice(0, CONFIG.MAX_CANDIDATE_LINKS);

        debug('candidates', { title, post: post.title, count: candidates.length, candidates });
        if (!candidates.length) continue;

        const resolved = await Promise.all(candidates.map((candidateUrl) => runLimited(() => resolveCandidate(candidateUrl, {
            meta,
            tmdbMeta,
            config,
            reqHost
        }).catch((error) => {
            debug('resolve failed', { url: candidateUrl, error: error?.message || String(error) });
            return null;
        }))));

        for (const stream of resolved) {
            if (stream?.url) streams.push(stream);
        }
    }

    return normalizeStreams(streams, {
        provider: 'ToonItalia',
        providerCode: 'TI',
        logger: console,
        config,
        reqHost
    });
}

function isToonItaliaRuntimeEnabled({ filters = {} } = {}) {
    return boolEnv('TOONITALIA_ENABLED', true) && filters?.enableToonItalia === true;
}

async function searchToonItalia(meta = {}, config = {}, reqHost = null) {
    const key = cacheKey(meta);
    const cached = resultCache.get(key, { allowStale: true });
    if (cached) return cached;

    const result = await inflight.do(key, () => searchToonItaliaImpl(meta, config, reqHost));
    resultCache.set(key, result);
    return result;
}

module.exports = {
    DEFAULT_DOMAINS,
    extractEpisodeLinks,
    extractMovieLinks,
    isToonItaliaRuntimeEnabled,
    normalizeText,
    normalizeTitleForSearch,
    maybeProxyToonItaliaPlayback,
    providerPriority,
    resolveCandidate,
    searchToonItalia,
    searchToonItaliaImpl,
    titleMatches
};
