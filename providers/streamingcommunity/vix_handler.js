const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const mediaIdentity = require('../../core/media_identity_resolver');
const kitsuProvider = require('../animeworld/kitsu_provider');
const {
    CircuitBreaker,
    SingleFlight,
    TTLCache,
    resilientCall
} = require('../extractors/resilience');
const { makeProxyToken } = require('./proxy_tokens');
const { buildRequestHeaders: buildProxyRequestHeaders } = require('./vix_proxy');

const VIX_BASE = 'https://vixsrc.to';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io/meta';
const DEFAULT_ADDON_URL = 'https://leviata96n.questoleviatanormio.dpdns.org';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT = 8000;
const MAX_FETCH_RETRIES = 3;
const MAX_IFRAME_DEPTH = 3;
const MAX_SCRIPT_FETCH = 4;
const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const PAYLOAD_CACHE_TTL_MS = 5 * 60 * 1000;
const DIRECT_PAGE_CACHE_TTL_MS = 45 * 1000;
const PLAYLIST_CACHE_TTL_MS = 120 * 1000;
const PREFERRED_LANG = 'it';
const AU_BASE = 'https://www.animeunity.so';
const ANIME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ANIME_MAPPING_BASE = 'https://animemapping.stremio.dpdns.org';

const http = axios.create({
    timeout: REQUEST_TIMEOUT,
    httpAgent: HTTP_AGENT,
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: () => true,
    proxy: false
});

const payloadCache = new TTLCache({ maxSize: 128, ttlMs: PAYLOAD_CACHE_TTL_MS, cloneValues: true });
const directPageCache = new TTLCache({ maxSize: 64, ttlMs: DIRECT_PAGE_CACHE_TTL_MS, cloneValues: true });
const playlistCache = new TTLCache({ maxSize: 96, ttlMs: PLAYLIST_CACHE_TTL_MS, cloneValues: true });
const animeSessionCache = new TTLCache({ maxSize: 2, ttlMs: 20 * 60 * 1000, cloneValues: true });
const animeSearchCache = new TTLCache({ maxSize: 96, ttlMs: 10 * 60 * 1000, cloneValues: true });
const inflight = new SingleFlight();
const requestBreaker = new CircuitBreaker({
    failureThreshold: 4,
    recoveryTimeoutMs: 20000,
    halfOpenMaxCalls: 1
});

const IFRAME_SRC_RE = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i;
const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*><\/script>/gi;
const AUDIO_IT_RE = /#EXT-X-MEDIA:TYPE=AUDIO.*(?:LANGUAGE="it"|LANGUAGE="ita"|NAME="Italian"|NAME="Ita"|NAME="ITA"|GROUP-ID="ita")/i;
const RESOLUTION_RE = /RESOLUTION=\d+x(\d+)/ig;
const NAME_HEIGHT_RE = /NAME\s*=\s*"?(?:.*?)(\d{3,4})p/ig;
const FHD_RE = /(?:window\.)?canPlayFHD\s*[:=]\s*(?:true|!0|1)|["']canPlayFHD["']\s*:\s*true/i;
const H_FLAG_RE = /(?:[?&]|^)h=1(?:&|$)/i;
const B_FLAG_RE = /(?:[?&]|^)b=1(?:&|$)/i;

const TOKEN_PATTERNS = [
    /["']token["']\s*:\s*["']([^"']+)["']/i,
    /\btoken\s*[:=]\s*["']([^"']+)["']/i,
    /[?&]token=([^&\s"']+)/i
];

const ASN_PATTERNS = [
    /["']asn["']\s*:\s*["']([^"']+)["']/i,
    /\basn\s*[:=]\s*["']([^"']+)["']/i,
    /[?&]asn=([^&\s"']+)/i
];

const EXPIRES_PATTERNS = [
    /["']expires["']\s*:\s*["']?(\d+)["']?/i,
    /\bexpires\s*[:=]\s*["']?(\d+)["']?/i,
    /[?&]expires=(\d+)/i
];

const URL_PATTERNS = [
    /["']url["']\s*:\s*["']([^"']+)["']/i,
    /["']src["']\s*:\s*["']([^"']+)["']/i,
    /["']hls["']\s*:\s*["']([^"']+)["']/i,
    /["']file["']\s*:\s*["']([^"']+)["']/i,
    /["']playlist(?:Url)?["']\s*:\s*["']([^"']+)["']/i,
    /["']manifest(?:Url)?["']\s*:\s*["']([^"']+)["']/i,
    /["']master(?:Url)?["']\s*:\s*["']([^"']+)["']/i,
    /\burl\s*:\s*["']([^"']+)["']/i,
    /(?:https?:)?\/\/[^\s'"<>]+(?:\.m3u8)?[^\s'"<>]*/i
];

function now() {
    return Date.now();
}

function cacheGet(cache, key) {
    return cache.get(key);
}

function cacheSet(cache, key, value, ttlMs) {
    if (!key) return value;
    cache.set(key, value, { ttlMs });
    return value;
}

async function singleFlight(key, worker) {
    return inflight.do(key, worker);
}

function normalizeAddonBase(reqHost) {
    const envUrl = process.env.ADDON_URL || (process.env.SPACE_HOST ? `https://${process.env.SPACE_HOST}` : null);
    const raw = envUrl || reqHost || DEFAULT_ADDON_URL;
    try {
        if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '');
        return `https://${String(raw).replace(/^\/+/, '').replace(/\/$/, '')}`;
    } catch {
        return DEFAULT_ADDON_URL;
    }
}

function normalizeEscapedUrl(value) {
    let out = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    let previous = null;
    for (let i = 0; i < 4; i += 1) {
        if (out === previous) break;
        previous = out;
        out = out
            .replace(/&amp;/g, '&')
            .replace(/\\u002F/gi, '/')
            .replace(/\\u0026/gi, '&')
            .replace(/\\\//g, '/');
        out = out.replace(/^(https?):\/{3,}/i, '$1://');
        out = out.replace(/^(https?):\/([^/])/i, '$1://$2');
    }
    if (out.startsWith('//')) return `https:${out}`;
    return out;
}

function normalizeEmbedUrl(src, referer = null) {
    const value = normalizeEscapedUrl(src);
    if (!value) return null;
    try {
        if (value.startsWith('//')) return `https:${value}`;
        if (value.startsWith('/')) return new URL(value, VIX_BASE).toString();
        if (/^https?:\/\//i.test(value)) return new URL(value).toString();
        return new URL(value, referer || VIX_BASE).toString();
    } catch {
        return null;
    }
}

function normalizeAnimeUrl(src, referer = AU_BASE) {
    const value = normalizeEscapedUrl(src);
    if (!value) return null;
    try {
        if (value.startsWith('//')) return `https:${value}`;
        if (value.startsWith('/')) return new URL(value, referer || AU_BASE).toString();
        if (/^https?:\/\//i.test(value)) return new URL(value).toString();
        return new URL(value, referer || AU_BASE).toString();
    } catch {
        return null;
    }
}

function responseText(response) {
    if (!response) return '';
    if (typeof response.data === 'string') return response.data;
    if (Buffer.isBuffer(response.data)) return response.data.toString('utf8');
    if (response.data == null) return '';
    try {
        return JSON.stringify(response.data);
    } catch {
        return String(response.data || '');
    }
}

function responseUrl(response, fallback) {
    return response?.request?.res?.responseUrl || response?.config?.url || fallback;
}

function buildHeaders(referer = null, kind = 'html') {
    const headers = {
        'User-Agent': DEFAULT_UA,
        'Referer': referer || `${VIX_BASE}/`,
        'Origin': VIX_BASE,
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    if (kind === 'script') {
        headers.Accept = 'application/javascript,text/javascript,*/*;q=0.8';
    } else if (kind === 'playlist') {
        headers.Accept = '*/*';
    } else if (kind === 'json') {
        headers.Accept = 'application/json,text/plain,*/*';
    } else {
        headers.Accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    }

    return headers;
}

async function getWithRetries(url, {
    method = 'GET',
    headers = {},
    timeout = REQUEST_TIMEOUT,
    responseType,
    data
} = {}) {
    const domain = (() => {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch (_) {
            return 'vixsrc';
        }
    })();

    try {
        return await requestBreaker.run(domain, async () => resilientCall(
            async () => http.request({
                url,
                method,
                headers,
                timeout,
                responseType,
                data
            }),
            {
                attempts: MAX_FETCH_RETRIES,
                shouldRetry: ({ error, status }) => (
                    status != null
                        ? RETRYABLE_STATUSES.has(Number(status))
                        : Boolean(error)
                )
            }
        ));
    } catch (_) {
        return null;
    }
}

async function fetchText(url, referer = null, kind = 'html') {
    const response = await getWithRetries(url, { headers: buildHeaders(referer, kind) });
    const status = Number(response?.status || 0);
    const text = responseText(response);
    if (status === 200 && text) {
        return { text, resolvedUrl: responseUrl(response, url), status };
    }
    return { text: '', resolvedUrl: responseUrl(response, url), status };
}

function normalizedSearchVariants(searchSpace) {
    const base = String(searchSpace || '');
    const variants = [];
    const push = (value) => {
        const text = String(value || '');
        if (text && !variants.includes(text)) variants.push(text);
    };

    push(base);
    push(normalizeEscapedUrl(base));
    push(base.replace(/\\\//g, '/'));
    push(base.replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&'));
    return variants;
}

function extractFirst(patterns, searchSpace) {
    for (const variant of normalizedSearchVariants(searchSpace)) {
        for (const pattern of patterns) {
            const match = variant.match(pattern);
            if (!match) continue;
            const value = normalizeEscapedUrl(match[1] || match[0]);
            if (value) return value;
        }
    }
    return null;
}

function extractUrlValue(searchSpace) {
    for (const variant of normalizedSearchVariants(searchSpace)) {
        for (const pattern of URL_PATTERNS) {
            const match = variant.match(pattern);
            if (!match) continue;
            const value = normalizeEscapedUrl(match[1] || match[0]);
            if (value) return value;
        }
    }
    return null;
}

function stripMediaQuery(url) {
    const value = normalizeEscapedUrl(url);
    if (!value) return '';
    try {
        const parsed = new URL(value);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return value.split('?')[0].split('#')[0];
    }
}

function normalizeMediaBaseUrl(url) {
    const value = stripMediaQuery(url);
    if (!value) return '';
    return value.endsWith('.m3u8') ? value : `${value}.m3u8`;
}

function getQueryParam(url, key) {
    try {
        const parsed = new URL(normalizeEscapedUrl(url));
        return parsed.searchParams.get(key);
    } catch {
        const match = normalizeEscapedUrl(url).match(new RegExp(`(?:[?&])${key}=([^&]+)`, 'i'));
        return match ? match[1] : null;
    }
}

function appendOrReplaceQuery(url, params) {
    try {
        const parsed = new URL(url);
        for (const [key, value] of Object.entries(params || {})) {
            parsed.searchParams.set(key, String(value));
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function buildMasterUrl(base, token, expires, h = false, b = false, asn = null) {
    const cleanBase = normalizeMediaBaseUrl(base);
    if (!cleanBase) return '';
    const parsed = new URL(cleanBase);
    parsed.search = '';
    if (b) parsed.searchParams.set('b', '1');
    parsed.searchParams.set('token', String(token));
    parsed.searchParams.set('expires', String(expires));
    if (asn) parsed.searchParams.set('asn', String(asn));
    if (h) parsed.searchParams.set('h', '1');
    return parsed.toString();
}

function extractInlineScripts(html) {
    const out = [];
    let match;
    const regex = new RegExp(SCRIPT_RE);
    while ((match = regex.exec(html || '')) !== null) {
        const payload = String(match[1] || '').trim();
        if (payload) out.push(payload);
    }
    return out;
}

async function fetchExternalScripts(html, baseUrl) {
    const sources = [];
    const seen = new Set();
    let match;
    const regex = new RegExp(SCRIPT_SRC_RE);
    while ((match = regex.exec(html || '')) !== null) {
        const src = normalizeEmbedUrl(match[1], baseUrl);
        if (!src || seen.has(src)) continue;
        seen.add(src);
        sources.push(src);
    }

    const subset = sources.slice(0, MAX_SCRIPT_FETCH);
    const texts = await Promise.all(subset.map(async (src) => {
        const result = await fetchText(src, baseUrl, 'script');
        return result.text || '';
    }));
    return texts.filter(Boolean);
}

function scoreScript(payload) {
    const lowered = String(payload || '').toLowerCase();
    let score = 0;
    if (lowered.includes('token')) score += 4;
    if (lowered.includes('expires')) score += 4;
    if (lowered.includes('.m3u8')) score += 4;
    if (lowered.includes('manifest') || lowered.includes('playlist') || lowered.includes('master')) score += 2;
    if (lowered.includes('canplayfhd') || lowered.includes('1080')) score += 2;
    if (lowered.includes('__next_f') || lowered.includes('player')) score += 1;
    return score;
}

function buildCandidateSpaces(html, scripts) {
    const ranked = [...(scripts || [])].sort((a, b) => scoreScript(b) - scoreScript(a));
    const combinedBest = ranked.slice(0, 4).join('\n');
    const candidates = [];
    if (combinedBest) candidates.push(combinedBest);
    candidates.push(...ranked);
    if (html) candidates.push(html);
    if (combinedBest && html) candidates.push(`${combinedBest}\n${html}`);
    return [...new Set(candidates.filter(Boolean))];
}

function parsePayloadFromSpace(searchSpace) {
    const token = extractFirst(TOKEN_PATTERNS, searchSpace);
    const expires = extractFirst(EXPIRES_PATTERNS, searchSpace);
    const asn = extractFirst(ASN_PATTERNS, searchSpace);
    const urlValue = extractUrlValue(searchSpace);
    if (!urlValue) return null;

    const tokenFinal = token || getQueryParam(urlValue, 'token');
    const expiresFinal = expires || getQueryParam(urlValue, 'expires');
    const asnFinal = asn || getQueryParam(urlValue, 'asn');
    if (!(urlValue && tokenFinal && expiresFinal)) return null;

    const rawUrl = normalizeMediaBaseUrl(urlValue);
    if (!rawUrl) return null;

    return {
        rawUrl,
        token: String(tokenFinal),
        expires: String(expiresFinal),
        asn: asnFinal ? String(asnFinal) : null,
        canPlayFHD: FHD_RE.test(searchSpace) || H_FLAG_RE.test(urlValue),
        hasB: B_FLAG_RE.test(urlValue)
    };
}

function extractQualityFromPlaylist(playlistText) {
    const text = String(playlistText || '');
    const heights = [];
    for (const match of text.matchAll(RESOLUTION_RE)) heights.push(Number(match[1]));
    if (!heights.length) {
        for (const match of text.matchAll(NAME_HEIGHT_RE)) heights.push(Number(match[1]));
    }
    if (!heights.length) return 'Unknown';
    const top = Math.max(...heights.filter(Number.isFinite));
    if (top >= 2160) return '4K';
    if (top >= 1440) return '1440p';
    if (top >= 1080) return '1080p';
    if (top >= 720) return '720p';
    if (top >= 576) return '576p';
    if (top >= 480) return '480p';
    return 'Unknown';
}

function qualityRank(value) {
    const q = normalizeQuality(value);
    return { '4K': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '576p': 576, '480p': 480, '360p': 360, '240p': 240, Unknown: 0 }[q] || 0;
}

function normalizeQuality(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text || ['all', 'auto', 'unknown', 'unknow'].includes(text)) return 'Unknown';
    if (['4k', '2160p', '2160'].includes(text)) return '4K';
    if (['1440p', '1440', '2k', 'qhd'].includes(text)) return '1440p';
    if (['1080p', '1080', 'fhd', 'fullhd'].includes(text)) return '1080p';
    if (['720p', '720', 'hd'].includes(text)) return '720p';
    if (['576p', '576'].includes(text)) return '576p';
    if (['480p', '480', 'sd'].includes(text)) return '480p';
    if (['360p', '360'].includes(text)) return '360p';
    if (['240p', '240'].includes(text)) return '240p';
    return String(value || 'Unknown');
}

function normalizeQualityFilter(value) {
    const raw = String(value || 'all').trim().toLowerCase();
    if (['1080p', '1080', 'fhd', 'fullhd'].includes(raw)) return '1080';
    if (['720p', '720', 'hd'].includes(raw)) return '720';
    return 'all';
}

function qualityMatchesFilter(detectedQuality, qualityFilter) {
    const wanted = normalizeQualityFilter(qualityFilter);
    if (wanted === 'all') return true;
    const detected = normalizeQuality(detectedQuality);
    if (detected === 'Unknown') return true;
    return qualityRank(detected) >= qualityRank(wanted);
}

function inferQualityFromStream(stream) {
    const explicit = normalizeQuality(stream?.quality || 'Unknown');
    if (explicit !== 'Unknown') return explicit;
    const searchSpace = [stream?.name, stream?.title, stream?.filename, stream?.url].filter(Boolean).join(' ');
    if (/\b1080p?\b|\bfhd\b/i.test(searchSpace)) return '1080p';
    if (/\b720p?\b|\bhd\b/i.test(searchSpace)) return '720p';
    if (/\b4k\b|\b2160p?\b/i.test(searchSpace)) return '4K';
    return 'Unknown';
}

async function fetchPlaylistSnapshot(url, referer) {
    const cached = cacheGet(playlistCache, url);
    if (cached) return cached;

    return singleFlight(`playlist:${url}`, async () => {
        const secondCached = cacheGet(playlistCache, url);
        if (secondCached) return secondCached;
        const { text } = await fetchText(url, referer, 'playlist');
        const snapshot = { text: text || '', quality: extractQualityFromPlaylist(text || '') };
        cacheSet(playlistCache, url, snapshot, PLAYLIST_CACHE_TTL_MS);
        return snapshot;
    });
}

async function inferCanPlayFHDFromPlaylist(url, referer) {
    const snapshot = await fetchPlaylistSnapshot(url, referer);
    return ['1080p', '1440p', '4K'].includes(normalizeQuality(snapshot.quality));
}

async function getRealVixPage(url) {
    let currentUrl = url;
    let currentReferer = `${VIX_BASE}/`;
    const visited = new Set();

    for (let depth = 0; depth <= MAX_IFRAME_DEPTH; depth += 1) {
        if (visited.has(currentUrl)) break;
        visited.add(currentUrl);

        const { text, resolvedUrl, status } = await fetchText(currentUrl, currentReferer, 'html');
        if (status !== 200 || !text || !resolvedUrl) return { html: '', finalUrl: currentUrl, finalReferer: currentReferer, status };

        const iframeMatch = text.match(IFRAME_SRC_RE);
        if (!iframeMatch) {
            return { html: text, finalUrl: resolvedUrl, finalReferer: resolvedUrl, status: 200 };
        }

        const nextUrl = normalizeEmbedUrl(iframeMatch[1], resolvedUrl);
        if (!nextUrl) {
            return { html: text, finalUrl: resolvedUrl, finalReferer: resolvedUrl, status: 200 };
        }

        currentReferer = resolvedUrl;
        currentUrl = nextUrl;
    }

    return { html: '', finalUrl: currentUrl, finalReferer: currentReferer, status: 0 };
}

async function parseVixPayload(html, referer) {
    const inlineScripts = extractInlineScripts(html);
    const externalScripts = await fetchExternalScripts(html, referer);
    const candidates = buildCandidateSpaces(html, [...inlineScripts, ...externalScripts]);
    for (const searchSpace of candidates) {
        const payload = parsePayloadFromSpace(searchSpace);
        if (payload) return payload;
    }
    return null;
}

async function resolveCachedPayload(url) {
    const cached = cacheGet(payloadCache, url);
    if (cached) return { payload: cached, referer: url };

    return singleFlight(`payload:${url}`, async () => {
        const secondCached = cacheGet(payloadCache, url);
        if (secondCached) return { payload: secondCached, referer: url };

        const page = await getRealVixPage(url);
        if (!page?.html) return { payload: null, referer: page?.finalReferer || url, status: page?.status || 0 };

        const referer = page.finalReferer || page.finalUrl || url;
        const payload = await parseVixPayload(page.html, referer);
        if (!payload) return { payload: null, referer, status: 200 };

        cacheSet(payloadCache, url, payload, PAYLOAD_CACHE_TTL_MS);
        cacheSet(payloadCache, referer, payload, PAYLOAD_CACHE_TTL_MS);
        return { payload, referer, status: 200 };
    });
}

async function fetchRealTitle(imdbId, metaType) {
    try {
        const metaUrl = `${CINEMETA_BASE}/${metaType}/${imdbId}.json`;
        const response = await http.get(metaUrl, { timeout: 6000, validateStatus: () => true, proxy: false });
        if (Number(response.status) !== 200) return null;
        return response?.data?.meta?.name || null;
    } catch {
        return null;
    }
}

function cleanSeriesTitle(text) {
    return String(text || '')
        .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, ' ')
        .replace(/\b(?:s\s*\d{1,2}\s*e\s*\d{1,3}|stagione\s*\d+|season\s*\d+|episodio\s*\d+|episode\s*\d+|ep\.?\s*\d+)\b/gi, ' ')
        .replace(/[\[\]{}()<>|•·]+/g, ' ')
        .replace(/[:;,_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || String(text || 'Unknown');
}

function safeInt(value) {
    const parsed = Number.parseInt(String(value || '').trim(), 10);
    return Number.isFinite(parsed) ? String(parsed) : null;
}

function buildScPageUrl(tmdbId, season = null, episode = null) {
    if (season == null || episode == null) return `${VIX_BASE}/movie/${tmdbId}`;
    return `${VIX_BASE}/tv/${tmdbId}/${season}/${episode}`;
}

function buildScApiUrl(tmdbId, season = null, episode = null) {
    if (season == null || episode == null) return `${VIX_BASE}/api/movie/${tmdbId}`;
    return `${VIX_BASE}/api/tv/${tmdbId}/${season}/${episode}`;
}

async function resolveScEmbedUrl(tmdbId, pageUrl, season = null, episode = null) {
    const apiBase = buildScApiUrl(tmdbId, season, episode);
    const candidates = [`${apiBase}?lang=${PREFERRED_LANG}`, apiBase];
    for (const apiUrl of candidates) {
        const response = await getWithRetries(apiUrl, { headers: buildHeaders(pageUrl, 'json') });
        if (Number(response?.status || 0) !== 200) continue;

        let payload = response?.data;
        if (!payload || typeof payload !== 'object') {
            try {
                payload = JSON.parse(responseText(response) || '{}');
            } catch {
                payload = {};
            }
        }

        const src = normalizeEmbedUrl(payload?.src, pageUrl);
        if (src) return src;
    }
    return null;
}

function buildSyntheticUrl(masterSource, quality, referer, reqHost) {
    const addonBase = normalizeAddonBase(reqHost);
    const proxy = new URL(`${addonBase}/vixsynthetic.m3u8`);
    const token = makeProxyToken(masterSource, {
        referer,
        headers: buildProxyRequestHeaders(masterSource, referer)
    });
    if (token) proxy.searchParams.set('d', token);
    else proxy.searchParams.set('src', masterSource);
    proxy.searchParams.set('max', quality === '1080p' ? '1' : '0');
    if (referer) proxy.searchParams.set('referer', referer);
    return proxy.toString();
}

function buildSeriesFilename(cleanTitle, season, episode) {
    if (season == null || episode == null) return cleanTitle;
    const s = String(Number.parseInt(season, 10)).padStart(2, '0');
    const e = String(Number.parseInt(episode, 10)).padStart(2, '0');
    return `${cleanTitle} S${s}E${e}`;
}

function stampScStream(stream, cleanTitle, season, episode) {
    const stamped = { ...(stream || {}) };
    const filename = buildSeriesFilename(cleanTitle, season, episode);
    const stampedTitle = season != null && episode != null ? filename : cleanTitle;
    const quality = inferQualityFromStream(stamped);
    const hints = { ...(stamped.behaviorHints || {}) };
    const vortexMeta = { ...((hints.vortexMeta) || {}) };

    vortexMeta.extractor = 'VixCloud';
    vortexMeta.provider = 'StreamingCommunity';
    vortexMeta.source = 'StreamingCommunity';
    vortexMeta.site = 'StreamingCommunity';
    vortexMeta.providerCode = 'SC';
    vortexMeta.filename = filename;
    vortexMeta.seriesTitle = cleanTitle;
    vortexMeta.quality = quality;

    stamped.title = stampedTitle;
    stamped.extractor = 'VixCloud';
    stamped.host = 'VixCloud';
    stamped.provider = 'StreamingCommunity';
    stamped.source = 'StreamingCommunity';
    stamped.site = 'StreamingCommunity';
    stamped.filename = filename;
    stamped.quality = quality;
    stamped.behaviorHints = {
        ...hints,
        extractor: 'VixCloud',
        vortexExtractor: 'VixCloud',
        vortexSource: 'StreamingCommunity',
        vortexProviderCode: 'SC',
        filename,
        seriesTitle: cleanTitle,
        bingeGroup: `sc-${cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'title'}`,
        quality,
        notWebReady: false,
        vortexMeta
    };

    return stamped;
}

function dedupeStreams(streams) {
    const seen = new Set();
    const out = [];
    for (const stream of streams || []) {
        const url = String(stream?.url || '').trim();
        if (!url) continue;
        const quality = inferQualityFromStream(stream);
        const language = String(stream?.language || '').trim().toLowerCase();
        const branch = String(stream?.behaviorHints?.vortexMeta?.branch || '');
        const key = `${url}|||${quality}|||${language}|||${branch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stream.quality = quality;
        out.push(stream);
    }
    return out;
}

function sortStreams(streams) {
    return [...(streams || [])].sort((a, b) => {
        const qa = qualityRank(inferQualityFromStream(a));
        const qb = qualityRank(inferQualityFromStream(b));
        if (qb !== qa) return qb - qa;
        const la = String(a?.language || '').toLowerCase() === 'ita' ? 1 : 0;
        const lb = String(b?.language || '').toLowerCase() === 'ita' ? 1 : 0;
        if (lb !== la) return lb - la;
        const ba = String(a?.behaviorHints?.vortexMeta?.branch || '').startsWith('synthetic') ? 1 : 0;
        const bb = String(b?.behaviorHints?.vortexMeta?.branch || '').startsWith('synthetic') ? 1 : 0;
        if (bb !== ba) return bb - ba;
        return String(a?.title || '').localeCompare(String(b?.title || ''));
    });
}

async function fetchPlaylistQualityAndHeaders(streamUrl, pageUrl, qualityFilter) {
    const headers = {
        Referer: pageUrl,
        Origin: VIX_BASE,
        'User-Agent': DEFAULT_UA,
        Accept: '*/*'
    };

    let quality = 'Unknown';
    let hasItalianAudio = false;

    try {
        const snapshot = await fetchPlaylistSnapshot(streamUrl, pageUrl);
        if (snapshot?.text) {
            quality = normalizeQuality(snapshot.quality);
            if (!qualityMatchesFilter(quality, qualityFilter)) {
                return { quality, headers, hasItalianAudio: false, allowed: false };
            }
            if (AUDIO_IT_RE.test(snapshot.text)) {
                hasItalianAudio = true;
                headers['Accept-Language'] = 'it-IT,it;q=0.9,en;q=0.8';
            } else {
                headers['Accept-Language'] = 'en-US,en;q=0.9,it;q=0.5';
            }
        }
    } catch {}

    return { quality, headers, hasItalianAudio, allowed: true };
}

async function extractFromCandidate(candidateUrl, cleanTitle, season, episode, qualityFilter, reqHost) {
    const { payload, referer } = await resolveCachedPayload(candidateUrl);
    if (!payload) return [];

    const pageReferer = referer || candidateUrl;
    const sourceUrl = buildMasterUrl(payload.rawUrl, payload.token, payload.expires, payload.canPlayFHD, payload.hasB, payload.asn);
    if (!sourceUrl) return [];

    return buildSyntheticStreamsFromSource(sourceUrl, pageReferer, cleanTitle, season, episode, qualityFilter, reqHost);
}

async function tryDirectVixsrcStream(pageUrl, cleanTitle, season, episode, qualityFilter) {
    const cached = cacheGet(directPageCache, pageUrl);
    let status;
    let pageHtml;
    if (cached) {
        ({ status, pageHtml } = cached);
    } else {
        const response = await getWithRetries(pageUrl, { headers: buildHeaders(`${VIX_BASE}/`, 'html') });
        status = Number(response?.status || 0);
        pageHtml = responseText(response);
        if (status === 200 && pageHtml) {
            cacheSet(directPageCache, pageUrl, { status, pageHtml }, DIRECT_PAGE_CACHE_TTL_MS);
        }
    }

    if (status !== 200 || !pageHtml) return [];

    const inlineScripts = extractInlineScripts(pageHtml);
    const candidates = buildCandidateSpaces(pageHtml, inlineScripts);
    let streamUrl = null;
    for (const searchSpace of candidates) {
        const payload = parsePayloadFromSpace(searchSpace);
        if (!payload) continue;
        streamUrl = buildMasterUrl(payload.rawUrl, payload.token, payload.expires, payload.canPlayFHD, payload.hasB, payload.asn);
        if (streamUrl) break;
    }
    if (!streamUrl) return [];

    streamUrl = appendOrReplaceQuery(streamUrl, { lang: PREFERRED_LANG });
    const { quality, headers, hasItalianAudio, allowed } = await fetchPlaylistQualityAndHeaders(streamUrl, pageUrl, qualityFilter);
    if (!allowed) return [];

    const stream = {
        name: 'SC Direct',
        title: cleanTitle,
        url: streamUrl,
        quality,
        behaviorHints: {
            notWebReady: false,
            proxyHeaders: { request: headers },
            vortexMeta: { branch: 'direct-vixsrc', quality }
        }
    };
    if (hasItalianAudio) stream.language = 'ita';
    return [stampScStream(stream, cleanTitle, season, episode)];
}

function normalizeLookupTitle(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractCandidateYear(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? Number(match[0]) : null;
}

function collectDeepStringValues(input, maxDepth = 4, maxItems = 200) {
    const out = [];
    const seenObjects = new Set();

    const visit = (value, depth) => {
        if (out.length >= maxItems || depth > maxDepth || value == null) return;
        if (typeof value === 'string' || typeof value === 'number') {
            out.push(String(value));
            return;
        }
        if (typeof value === 'boolean') return;
        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item, depth + 1);
                if (out.length >= maxItems) break;
            }
            return;
        }
        if (typeof value === 'object') {
            if (seenObjects.has(value)) return;
            seenObjects.add(value);
            for (const [key, item] of Object.entries(value)) {
                out.push(String(key));
                if (out.length >= maxItems) break;
                visit(item, depth + 1);
                if (out.length >= maxItems) break;
            }
        }
    };

    visit(input, 0);
    return out;
}

function getExplicitKitsuCandidates(meta = {}) {
    return [
        meta?.requestedId,
        meta?.originalId,
        meta?.kitsu_id,
        meta?.kitsuId,
        meta?.sourceId,
        meta?.source_id,
        meta?.stremioId,
        meta?.stremio_id,
        meta?.canonicalId,
        meta?.canonical_id,
        meta?.id,
        meta?.imdb_id
    ];
}

function findKitsuIdentifierDeep(meta = {}) {
    const candidates = uniqueNonEmpty([
        ...getExplicitKitsuCandidates(meta),
        ...collectDeepStringValues(meta, 4, 240)
    ]);
    for (const candidate of candidates) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) return parsed;
    }
    return null;
}

function isKitsuMeta(meta = {}) {
    return Boolean(findKitsuIdentifierDeep(meta));
}

function getKitsuIdentifier(meta = {}) {
    return findKitsuIdentifierDeep(meta);
}

function uniqueNonEmpty(values = []) {
    return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function kitsuDebug(stage, details = '') {
    console.log(`[WEB][StreamingCommunity][KITSU] ${stage}${details ? ` | ${details}` : ''}`);
}

function buildKitsuContextId(meta = {}, kitsu = null) {
    return meta?.requestedId
        || meta?.originalId
        || meta?.kitsu_id
        || meta?.kitsuId
        || meta?.id
        || meta?.imdb_id
        || (kitsu?.kitsuId ? `kitsu:${kitsu.kitsuId}${kitsu?.episodeNumber ? `:${kitsu.episodeNumber}` : ''}` : null);
}

function buildKitsuResolvedSourceId(meta = {}, kitsu = null) {
    const explicit = getExplicitKitsuCandidates(meta);
    for (const candidate of explicit) {
        const parsed = kitsuProvider.parseKitsuId(candidate);
        if (parsed?.kitsuId) return String(candidate);
    }
    if (kitsu?.kitsuId) {
        const ep = kitsu?.episodeNumber ? `:${kitsu.episodeNumber}` : '';
        return `kitsu:${kitsu.kitsuId}${ep}`;
    }
    return buildKitsuContextId(meta, kitsu);
}

function looksLikeAnimeMeta(meta = {}) {
    const directType = String(meta?.type || meta?.kind || meta?.mediaType || '').toLowerCase();
    if (/(^|[^a-z])(anime|animation)([^a-z]|$)/i.test(directType)) return true;

    const genreList = Array.isArray(meta?.genres) ? meta.genres : [];
    if (genreList.some((value) => /(anime|animation|animazione)/i.test(String(value)))) return true;

    const haystack = uniqueNonEmpty(collectDeepStringValues(meta, 3, 120)).join(' | ').toLowerCase();
    return /(anime-kitsu|kitsu:|anime|animazione)/i.test(haystack);
}

async function searchKitsuByTitle(title) {
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) return [];

    const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(normalizedTitle)}&page[limit]=10`;
    const response = await getWithRetries(url, {
        headers: { Accept: 'application/vnd.api+json,application/json;q=0.9,*/*;q=0.8' },
        timeout: 7000
    });
    if (Number(response?.status || 0) !== 200) return [];

    let payload = response?.data;
    if (!payload || typeof payload !== 'object') {
        try {
            payload = JSON.parse(responseText(response) || '{}');
        } catch {
            payload = {};
        }
    }

    return Array.isArray(payload?.data) ? payload.data : [];
}

function scoreKitsuSearchResult(entry, titleCandidates = [], meta = {}) {
    const attributes = entry?.attributes || {};
    const titles = attributes?.titles || {};
    const candidateTitles = uniqueNonEmpty([
        titles?.en,
        titles?.en_jp,
        titles?.ja_jp,
        titles?.it,
        attributes?.canonicalTitle,
        ...(Array.isArray(attributes?.abbreviatedTitles) ? attributes.abbreviatedTitles : [])
    ]).map((value) => normalizeLookupTitle(value));

    const wantedTitles = uniqueNonEmpty(titleCandidates).map((value) => normalizeLookupTitle(value));
    let score = 0;
    for (const candidate of candidateTitles) {
        for (const wanted of wantedTitles) {
            if (!candidate || !wanted) continue;
            if (candidate === wanted) score += 220;
            else if (candidate.includes(wanted) || wanted.includes(candidate)) score += 80;
            else if (candidate.split(' ').slice(0, 3).join(' ') === wanted.split(' ').slice(0, 3).join(' ')) score += 35;
        }
    }

    const wantedYear = extractCandidateYear(meta?.year || meta?.date || meta?.releaseInfo);
    const entryYear = extractCandidateYear(attributes?.startDate || attributes?.endDate || attributes?.createdAt);
    if (wantedYear && entryYear && wantedYear === entryYear) score += 15;

    if (/anime/i.test(String(attributes?.subtype || ''))) score += 10;
    return score;
}

async function inferKitsuIdentifierFromMeta(meta = {}) {
    const titleCandidates = uniqueNonEmpty([
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.canonicalTitle,
        meta?.seriesTitle
    ]);
    if (!titleCandidates.length) return null;

    const requestedEpisode = String(
        normalizeEpisodeCandidate(meta?.episode)
        || normalizeEpisodeCandidate(meta?.requestedEpisode)
        || 1
    );

    for (const title of titleCandidates.slice(0, 4)) {
        const results = await searchKitsuByTitle(title).catch(() => []);
        const ranked = [...results]
            .map((entry) => ({ entry, score: scoreKitsuSearchResult(entry, titleCandidates, meta) }))
            .sort((a, b) => b.score - a.score);
        const best = ranked[0];
        if (!best?.entry?.id || Number(best.score || 0) < 140) continue;
        return {
            kitsuId: String(best.entry.id),
            episodeNumber: requestedEpisode,
            inferredFromTitle: title,
            score: best.score
        };
    }

    return null;
}

async function fetchKitsuCanonicalTitlesById(kitsuId) {
    if (!kitsuId) return [];
    try {
        const response = await getWithRetries(`https://kitsu.io/api/edge/anime/${kitsuId}`, {
            headers: { Accept: 'application/vnd.api+json,application/json;q=0.9,*/*;q=0.8' },
            timeout: 6000
        });
        if (Number(response?.status || 0) !== 200) return [];
        let payload = response?.data;
        if (!payload || typeof payload !== 'object') {
            try {
                payload = JSON.parse(responseText(response) || '{}');
            } catch {
                payload = {};
            }
        }
        const attributes = payload?.data?.attributes || {};
        const titles = attributes?.titles || {};
        return uniqueNonEmpty([
            titles?.en,
            titles?.en_jp,
            titles?.ja_jp,
            titles?.it,
            attributes?.canonicalTitle,
            ...(Array.isArray(attributes?.abbreviatedTitles) ? attributes.abbreviatedTitles : [])
        ]);
    } catch {
        return [];
    }
}

function extractSetCookieHeader(response) {
    const header = response?.headers?.['set-cookie'];
    if (!header) return '';
    if (Array.isArray(header)) return header.map((entry) => String(entry).split(';')[0]).join('; ');
    return String(header).split(';')[0] || '';
}

function buildAnimeHeaders(referer = `${AU_BASE}/`, extra = {}) {
    return {
        'User-Agent': ANIME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: referer,
        Origin: AU_BASE,
        ...extra
    };
}

async function fetchAnimeUnitySession() {
    const cached = cacheGet(animeSessionCache, 'session');
    if (cached?.csrfToken && cached?.cookie) return cached;

    return singleFlight('animeunity:session', async () => {
        const secondCached = cacheGet(animeSessionCache, 'session');
        if (secondCached?.csrfToken && secondCached?.cookie) return secondCached;

        const response = await getWithRetries(AU_BASE, { headers: buildAnimeHeaders(`${AU_BASE}/`) });
        if (Number(response?.status || 0) !== 200) return null;

        const html = responseText(response);
        const $ = cheerio.load(html || '');
        const session = {
            csrfToken: $('meta[name="csrf-token"]').attr('content') || '',
            cookie: extractSetCookieHeader(response)
        };

        if (!session.csrfToken || !session.cookie) return null;
        cacheSet(animeSessionCache, 'session', session, 20 * 60 * 1000);
        return session;
    });
}

function normalizeAnimeUnityResults(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.records)) return payload.records;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.results)) return payload.results;
    return [];
}

async function searchAnimeUnity(title, session) {
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle || !session?.csrfToken || !session?.cookie) return [];

    const cacheKey = `au:${normalizeLookupTitle(normalizedTitle)}`;
    const cached = cacheGet(animeSearchCache, cacheKey);
    if (cached) return cached;

    return singleFlight(cacheKey, async () => {
        const secondCached = cacheGet(animeSearchCache, cacheKey);
        if (secondCached) return secondCached;

        const response = await getWithRetries(`${AU_BASE}/livesearch`, {
            method: 'POST',
            headers: {
                'User-Agent': ANIME_UA,
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/json;charset=utf-8',
                'X-CSRF-Token': session.csrfToken,
                Referer: `${AU_BASE}/`,
                Origin: AU_BASE,
                Cookie: session.cookie,
                Accept: 'application/json,text/plain,*/*'
            },
            timeout: REQUEST_TIMEOUT,
            data: { title: normalizedTitle }
        });

        if (Number(response?.status || 0) !== 200) return [];

        let payload = response?.data;
        if (!payload || typeof payload !== 'object') {
            try {
                payload = JSON.parse(responseText(response) || '{}');
            } catch {
                payload = {};
            }
        }

        const results = normalizeAnimeUnityResults(payload);
        cacheSet(animeSearchCache, cacheKey, results, 10 * 60 * 1000);
        return results;
    });
}

function scoreAnimeUnityResult(result, searchContext) {
    const candidateTitles = [
        result?.title,
        result?.name,
        result?.title_eng,
        result?.title_it,
        result?.slug
    ].filter(Boolean);
    const normalizedCandidates = candidateTitles.map((value) => normalizeLookupTitle(value)).filter(Boolean);
    const wantedTitles = [
        ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : [])
    ].map((value) => normalizeLookupTitle(value)).filter(Boolean);

    let score = 0;
    for (const candidate of normalizedCandidates) {
        for (const wanted of wantedTitles) {
            if (!candidate || !wanted) continue;
            if (candidate === wanted) score += 120;
            else if (candidate.includes(wanted) || wanted.includes(candidate)) score += 60;
            else if (candidate.split(' ').slice(0, 3).join(' ') === wanted.split(' ').slice(0, 3).join(' ')) score += 35;
        }
    }

    const wantedYear = extractCandidateYear(searchContext?.year || searchContext?.date);
    const resultYear = extractCandidateYear(result?.year || result?.release_date || result?.date || result?.slug);
    if (wantedYear && resultYear && wantedYear === resultYear) score += 20;

    if (searchContext?.isMovie && /movie|film/i.test(String(result?.type || result?.kind || ''))) score += 10;
    if (!searchContext?.isMovie && /serie|tv|anime/i.test(String(result?.type || result?.kind || ''))) score += 10;
    return score;
}

function pickBestAnimeUnityResult(results, searchContext) {
    const ranked = [...(results || [])]
        .map((result) => ({ result, score: scoreAnimeUnityResult(result, searchContext) }))
        .sort((a, b) => b.score - a.score);
    return ranked[0]?.result || null;
}

function buildAnimeUnityPath(result) {
    if (!result) return null;
    const direct = normalizeAnimeUrl(result?.path || result?.url || result?.href, AU_BASE);
    if (direct && direct.includes('/anime/')) return direct;
    const id = result?.id || result?.anime_id;
    const slug = result?.slug || result?.title_slug;
    if (id && slug) return `${AU_BASE}/anime/${id}-${slug}`;
    if (slug) return `${AU_BASE}/anime/${slug}`;
    return null;
}

function parseAnimeEpisodes(rawValue) {
    if (!rawValue) return [];
    try {
        const decoded = he.decode(String(rawValue || ''));
        const parsed = JSON.parse(decoded);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normalizeEpisodeCandidate(value) {
    const parsed = Number.parseFloat(String(value || '').replace(',', '.'));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function pickAnimeEpisode(episodes, requestedEpisode, isMovie) {
    const wanted = normalizeEpisodeCandidate(requestedEpisode) || 1;
    const list = Array.isArray(episodes) ? episodes : [];
    if (!list.length) return null;

    const exact = list.find((episode) => normalizeEpisodeCandidate(episode?.number) === wanted);
    if (exact) return exact;
    if (isMovie || list.length === 1) return list[0];
    const fallback = list.find((episode) => normalizeEpisodeCandidate(episode?.number) === 1);
    return fallback || list[0];
}

async function fetchAnimePage(url, referer = `${AU_BASE}/`) {
    const response = await getWithRetries(url, { headers: buildAnimeHeaders(referer) });
    if (Number(response?.status || 0) !== 200) return null;
    return {
        html: responseText(response),
        url: responseUrl(response, url)
    };
}

async function getAnimeUnityEmbedUrl(animePath, episodeNumber, isMovie) {
    const animeUrl = normalizeAnimeUrl(animePath, AU_BASE);
    if (!animeUrl) return null;

    const page = await fetchAnimePage(animeUrl, `${AU_BASE}/`);
    if (!page?.html) return null;

    const $ = cheerio.load(page.html || '');
    const player = $('video-player').first();
    let embedUrl = normalizeAnimeUrl(player.attr('embed_url'), page.url);
    const episodes = parseAnimeEpisodes(player.attr('episodes'));
    const chosenEpisode = pickAnimeEpisode(episodes, episodeNumber, isMovie);

    if (chosenEpisode?.embed_url) {
        embedUrl = normalizeAnimeUrl(chosenEpisode.embed_url, page.url);
        if (embedUrl) return embedUrl;
    }

    if (embedUrl && (isMovie || !chosenEpisode?.id)) return embedUrl;

    if (chosenEpisode?.id) {
        const episodePage = await fetchAnimePage(`${animeUrl.replace(/\/$/, '')}/${chosenEpisode.id}`, animeUrl);
        if (episodePage?.html) {
            const $episode = cheerio.load(episodePage.html || '');
            const directEmbed = normalizeAnimeUrl($episode('video-player').first().attr('embed_url'), episodePage.url)
                || normalizeAnimeUrl($episode('iframe[src*="vixcloud"]').first().attr('src'), episodePage.url);
            if (directEmbed) return directEmbed;
        }
    }

    return embedUrl || normalizeAnimeUrl($('iframe[src*="vixcloud"]').first().attr('src'), page.url);
}

async function resolveAnimeUnityMapping(kitsuId, episodeNumber) {
    if (!ANIME_MAPPING_BASE) return null;
    const requestedEpisode = Number.parseInt(String(episodeNumber || ''), 10) || 1;
    const mappingUrl = `${ANIME_MAPPING_BASE}/kitsu/${kitsuId}?ep=${requestedEpisode}`;
    const response = await getWithRetries(mappingUrl, {
        headers: { Accept: 'application/json' },
        timeout: REQUEST_TIMEOUT
    });
    if (Number(response?.status || 0) !== 200) return null;

    let payload = response?.data;
    if (!payload || typeof payload !== 'object') {
        try {
            payload = JSON.parse(responseText(response) || '{}');
        } catch {
            payload = {};
        }
    }

    const mapping = payload?.mappings?.animeunity;
    const entries = Array.isArray(mapping) ? mapping : (mapping ? [mapping] : []);
    let animePath = null;
    for (const entry of entries) {
        const value = typeof entry === 'string' ? entry : (entry?.path || entry?.url || entry?.href || null);
        if (typeof value === 'string' && value.startsWith('/')) {
            animePath = `${AU_BASE}${value}`;
            break;
        }
        const normalized = normalizeAnimeUrl(value, AU_BASE);
        if (normalized) {
            animePath = normalized;
            break;
        }
    }

    const resolvedEpisode = Number(payload?.kitsu?.episode || payload?.requested?.episode || requestedEpisode) || requestedEpisode;
    return { animePath, episodeNumber: resolvedEpisode };
}

function inferAnimePayloadFromEmbedUrl(embedUrl) {
    const token = getQueryParam(embedUrl, 'token');
    const expires = getQueryParam(embedUrl, 'expires');
    const asn = getQueryParam(embedUrl, 'asn');
    if (!(token && expires)) return null;
    const match = String(embedUrl || '').match(/\/embed\/(\d+)/i);
    if (!match) return null;
    const origin = (() => {
        try {
            return new URL(embedUrl).origin;
        } catch {
            return null;
        }
    })();
    if (!origin) return null;
    return {
        rawUrl: `${origin}/playlist/${match[1]}.m3u8`,
        token: String(token),
        expires: String(expires),
        asn: asn ? String(asn) : null,
        canPlayFHD: H_FLAG_RE.test(embedUrl),
        hasB: B_FLAG_RE.test(embedUrl)
    };
}

async function resolveAnimeManifest(embedUrl) {
    const resolved = await resolveCachedPayload(embedUrl);
    const payload = resolved?.payload || inferAnimePayloadFromEmbedUrl(embedUrl);
    const referer = resolved?.referer || embedUrl;
    if (!payload) return null;
    const streamUrl = buildMasterUrl(payload.rawUrl, payload.token, payload.expires, payload.canPlayFHD, payload.hasB, payload.asn);
    if (!streamUrl) return null;
    return { streamUrl, referer, payload };
}

async function buildSyntheticStreamsFromSource(sourceUrl, pageReferer, cleanTitle, season, episode, qualityFilter, reqHost, options = {}) {
    const streams = [];
    const wants1080 = normalizeQualityFilter(qualityFilter) !== '720';
    const wants720 = normalizeQualityFilter(qualityFilter) !== '1080';
    const hintedFhd = options?.canPlayFHD === true || H_FLAG_RE.test(String(sourceUrl || ''));
    const fastMode = options?.fastMode === true;

    let inferredFhd = hintedFhd;

    if (!inferredFhd && wants1080 && !fastMode) {
        try {
            inferredFhd = await inferCanPlayFHDFromPlaylist(sourceUrl, pageReferer);
        } catch {}
    }

    if (inferredFhd && wants1080) {
        streams.push(stampScStream({
            name: '??? StreamingCommunity\n?? 1080p',
            title: cleanTitle,
            url: buildSyntheticUrl(sourceUrl, '1080p', pageReferer, reqHost),
            quality: '1080p',
            behaviorHints: {
                notWebReady: false,
                vortexMeta: { branch: fastMode ? 'synthetic-1080-fast' : 'synthetic-1080', quality: '1080p' }
            }
        }, cleanTitle, season, episode));
    }

    if (wants720 || (!streams.length && fastMode)) {
        streams.push(stampScStream({
            name: '??? StreamingCommunity\n?? 720p',
            title: cleanTitle,
            url: buildSyntheticUrl(sourceUrl, '720p', pageReferer, reqHost),
            quality: '720p',
            behaviorHints: {
                notWebReady: false,
                vortexMeta: { branch: fastMode ? 'synthetic-720-fast' : 'synthetic-720', quality: '720p' }
            }
        }, cleanTitle, season, episode));
    }

    return sortStreams(dedupeStreams(streams));
}


async function resolveKitsuVix(meta, config = {}, reqHost, forcedKitsu = null) {
    const kitsu = forcedKitsu || getKitsuIdentifier(meta);
    if (!kitsu?.kitsuId) return [];

    const contextSourceId = buildKitsuResolvedSourceId(meta, kitsu);
    let searchContext = null;
    try {
        searchContext = await kitsuProvider.buildSearchContext(contextSourceId, meta);
    } catch (error) {
        kitsuDebug('context-error', error?.message || 'unknown');
    }

    const fetchedTitles = await fetchKitsuCanonicalTitlesById(kitsu.kitsuId).catch(() => []);
    const normalizedQuality = normalizeQualityFilter(config?.filters?.scQuality || 'all');
    const cleanTitle = cleanSeriesTitle(
        searchContext?.title
            || fetchedTitles[0]
            || meta?.title
            || meta?.name
            || meta?.originalTitle
            || `Kitsu ${kitsu.kitsuId}`
    );
    const episodeNumber = searchContext?.requestedEpisode || kitsu.episodeNumber || normalizeEpisodeCandidate(meta?.episode) || 1;

    kitsuDebug('start', `id=${kitsu.kitsuId} requested=${contextSourceId || 'n/a'} ep=${episodeNumber} title=${cleanTitle}${kitsu?.inferredFromTitle ? ` inferred=${kitsu.inferredFromTitle}` : ''}`);

    let animePath = null;
    let resolvedEpisode = Number(episodeNumber) || 1;
    try {
        const mapping = await resolveAnimeUnityMapping(kitsu.kitsuId, resolvedEpisode);
        if (mapping?.animePath) animePath = mapping.animePath;
        if (Number(mapping?.episodeNumber || 0) > 0) resolvedEpisode = Number(mapping.episodeNumber);
        kitsuDebug('mapping', `path=${animePath || 'none'} resolvedEp=${resolvedEpisode}`);
    } catch (error) {
        kitsuDebug('mapping-error', error?.message || 'unknown');
    }

    let embedUrl = null;
    if (animePath) {
        embedUrl = await getAnimeUnityEmbedUrl(animePath, resolvedEpisode, searchContext?.isMovie);
        kitsuDebug('mapping-embed', `found=${!!embedUrl}`);
    }

    if (!embedUrl) {
        const session = await fetchAnimeUnitySession();
        kitsuDebug('session', `ok=${!!session}`);
        if (session) {
            const titleCandidates = uniqueNonEmpty([
                ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
                ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
                ...fetchedTitles,
                cleanTitle,
                meta?.title,
                meta?.name,
                meta?.originalTitle
            ]);

            for (const title of titleCandidates.slice(0, 6)) {
                const results = await searchAnimeUnity(title, session);
                kitsuDebug('search', `title=${title} results=${results.length}`);
                const best = pickBestAnimeUnityResult(results, {
                    ...(searchContext || {}),
                    searchTitles: uniqueNonEmpty([
                        ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
                        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
                        ...fetchedTitles,
                        cleanTitle,
                        title
                    ]),
                    rawTitles: uniqueNonEmpty([
                        ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
                        ...fetchedTitles,
                        cleanTitle,
                        title
                    ])
                });
                const path = buildAnimeUnityPath(best);
                if (!path) continue;
                kitsuDebug('search-best', `title=${title} path=${path}`);
                embedUrl = await getAnimeUnityEmbedUrl(path, resolvedEpisode, searchContext?.isMovie);
                kitsuDebug('search-embed', `title=${title} found=${!!embedUrl}`);
                if (embedUrl) break;
            }
        }
    }

    if (!embedUrl) {
        kitsuDebug('fail', 'no-embed-url');
        return [];
    }

    const manifest = await resolveAnimeManifest(embedUrl);
    kitsuDebug('manifest', `found=${!!manifest?.streamUrl}`);
    if (!manifest?.streamUrl) return [];

    const streams = await buildSyntheticStreamsFromSource(
        manifest.streamUrl,
        manifest.referer || embedUrl,
        cleanTitle,
        meta?.isSeries ? safeInt(meta.season) : null,
        meta?.isSeries ? safeInt(meta.episode) : null,
        normalizedQuality,
        reqHost,
        {
            fastMode: true,
            canPlayFHD: manifest?.payload?.canPlayFHD === true
        }
    );
    kitsuDebug('done', `items=${streams.length}`);
    return streams;
}

async function resolveTmdbId(meta) {
    const rawId = meta.tmdb_id || meta.tmdbId || meta.imdb_id || meta.id;
    if (!rawId) return null;
    if (typeof rawId === 'string' && rawId.startsWith('tt')) {
        const converted = await mediaIdentity.imdbToTmdb(rawId).catch(() => null);
        return converted?.tmdbId ? String(converted.tmdbId) : null;
    }
    return String(rawId);
}

async function searchVix(meta, config = {}, reqHost) {
    if (!config?.filters || (!config.filters.enableVix && !config.filters.enableSC && !config.filters.enableStreamingCommunity)) {
        console.log('[WEB][StreamingCommunity] disabled');
        return [];
    }

    try {
        const directKitsu = getKitsuIdentifier(meta);
        const animeHint = looksLikeAnimeMeta(meta);
        console.log('[WEB][StreamingCommunity][ENTRY]', JSON.stringify({
            id: meta?.id,
            requestedId: meta?.requestedId,
            originalId: meta?.originalId,
            kitsu_id: meta?.kitsu_id,
            kitsuId: meta?.kitsuId,
            imdb_id: meta?.imdb_id,
            tmdb_id: meta?.tmdb_id,
            animeHint,
            isKitsu: Boolean(directKitsu?.kitsuId)
        }));

        if (directKitsu?.kitsuId) {
            kitsuDebug('detected', `id=${buildKitsuResolvedSourceId(meta, directKitsu) || 'n/a'}`);
            const animeStreams = await resolveKitsuVix(meta, config, reqHost, directKitsu);
            if (animeStreams.length) {
                console.log(`[WEB][StreamingCommunity][KITSU] ok | items=${animeStreams.length}`);
                return animeStreams;
            }
            kitsuDebug('fallback', 'using-tmdb-flow');
        }

        const tmdbId = await resolveTmdbId(meta);
        if (!tmdbId) {
            console.log('[WEB][StreamingCommunity] no-tmdb');
            if (!directKitsu?.kitsuId) {
                const inferredKitsu = await inferKitsuIdentifierFromMeta(meta).catch(() => null);
                if (inferredKitsu?.kitsuId) {
                    kitsuDebug('title-fallback', `id=${inferredKitsu.kitsuId} title=${inferredKitsu.inferredFromTitle || 'n/a'} score=${inferredKitsu.score || 0}`);
                    const animeStreams = await resolveKitsuVix(meta, config, reqHost, inferredKitsu);
                    if (animeStreams.length) {
                        console.log(`[WEB][StreamingCommunity][KITSU] ok | items=${animeStreams.length} | via=title-fallback`);
                        return animeStreams;
                    }
                }
            }
            return [];
        }

        const season = meta?.isSeries ? safeInt(meta.season) : null;
        const episode = meta?.isSeries ? safeInt(meta.episode) : null;
        const normalizedQuality = normalizeQualityFilter(config?.filters?.scQuality || 'all');
        const realTitle = await fetchRealTitle(meta.imdb_id || meta.id, meta?.isSeries ? 'series' : 'movie').catch(() => null);
        const cleanTitle = cleanSeriesTitle(realTitle || meta?.title || meta?.originalTitle || meta?.name || meta?.id || 'StreamingCommunity');
        const pageUrl = buildScPageUrl(tmdbId, season, episode);
        const embedUrl = await resolveScEmbedUrl(tmdbId, pageUrl, season, episode);

        const candidateUrls = [];
        if (embedUrl) candidateUrls.push(embedUrl);
        candidateUrls.push(pageUrl);

        for (const candidateUrl of [...new Set(candidateUrls.filter(Boolean))]) {
            const out = await extractFromCandidate(candidateUrl, cleanTitle, season, episode, normalizedQuality, reqHost);
            if (out.length) {
                console.log(`[WEB][StreamingCommunity] ok | tmdb=${tmdbId} | items=${out.length} | via=${candidateUrl === embedUrl ? 'api-src' : 'page'}`);
                return out;
            }
        }

        for (const candidateUrl of [...new Set(candidateUrls.filter(Boolean))]) {
            const direct = await tryDirectVixsrcStream(candidateUrl, cleanTitle, season, episode, normalizedQuality);
            if (direct.length) {
                console.log(`[WEB][StreamingCommunity] direct-ok | tmdb=${tmdbId} | items=${direct.length}`);
                return sortStreams(dedupeStreams(direct));
            }
        }

        if (!directKitsu?.kitsuId) {
            const inferredKitsu = await inferKitsuIdentifierFromMeta(meta).catch(() => null);
            if (inferredKitsu?.kitsuId) {
                kitsuDebug('title-fallback', `id=${inferredKitsu.kitsuId} title=${inferredKitsu.inferredFromTitle || 'n/a'} score=${inferredKitsu.score || 0}`);
                const animeStreams = await resolveKitsuVix(meta, config, reqHost, inferredKitsu);
                if (animeStreams.length) {
                    console.log(`[WEB][StreamingCommunity][KITSU] ok | items=${animeStreams.length} | via=title-fallback`);
                    return animeStreams;
                }
                kitsuDebug('title-fallback-fail', `id=${inferredKitsu.kitsuId}`);
            } else if (animeHint) {
                kitsuDebug('title-fallback', 'no-kitsu-id-found-from-meta');
            }
        }

        console.log(`[WEB][StreamingCommunity] no-server-url | tmdb=${tmdbId}`);
        return [];
    } catch (error) {
        console.error(`[WEB][StreamingCommunity] error | ${error.message}`);
        return [];
    }
}

module.exports = { searchVix };
