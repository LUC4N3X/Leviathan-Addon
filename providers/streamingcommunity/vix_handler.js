const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const { HTTP_AGENT, HTTPS_AGENT } = require('../../core/utils/http');
const {
    buildForwardProxyUrl: buildSharedForwardProxyUrl,
    normalizeForwardProxyBase: normalizeSharedForwardProxyBase
} = require('../../core/proxy/forward_proxy_config');
const mediaIdentity = require('../../core/intelligence/media_identity_resolver');
const kitsuProvider = require('../animeworld/kitsu_provider');
const animeProviderUtils = require('../anime/provider_utils');
const {
    CircuitBreaker,
    SingleFlight,
    TTLCache,
    resilientCall
} = require('../extractors/resilience');
const { issueHlsTransitKey, TRANSIT_KIND, buildTransitUrl } = require('./stream_transit.js');
const { buildRequestHeaders: buildProxyRequestHeaders } = require('./vix_proxy');
const {
    extractPlaylistIntelligence,
    normalizeLanguage: normalizePlaylistLanguage
} = require('../utils/playlist_intelligence');
const { createBlockedFallbackGuard } = require('../utils/provider_blocked_fallback');

const VIX_BASE = 'https://vixsrc.to';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io/meta';
const DEFAULT_ADDON_URL = 'https://leviata96n.questoleviatanormio.dpdns.org';
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = '5bae8d11f2a7bc7a95c6d040a31d2163';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const providerShield = createBlockedFallbackGuard({
    providerName: 'vixsrc',
    envPrefix: 'VIXSRC',
    baseUrl: VIX_BASE,
    logPrefix: 'VIX-SHIELD',
    fallbackUserAgent: DEFAULT_UA
});
const REQUEST_TIMEOUT = 8000;
const MAX_FETCH_RETRIES = 3;
const MAX_IFRAME_DEPTH = 3;
const MAX_SCRIPT_FETCH = 4;
const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const PAYLOAD_CACHE_TTL_MS = 5 * 60 * 1000;
const DIRECT_PAGE_CACHE_TTL_MS = 45 * 1000;
const PLAYLIST_CACHE_TTL_MS = 120 * 1000;
const TMDB_META_CACHE_TTL_MS = 30 * 60 * 1000;
const PREFERRED_LANG = 'it';
const AU_BASE = 'https://www.animeunity.so';
const ANIME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const HLS_PLAYBACK_TOKEN_TTL_MS = Math.max(10 * 60 * 1000, Number.parseInt(process.env.VIX_HLS_TOKEN_TTL_MS || String(2 * 60 * 60 * 1000), 10) || (2 * 60 * 60 * 1000));
const VIX_STRICT_HOST_BINDING = String(process.env.VIX_STRICT_HOST_BINDING || '').trim() === '1';

const SC_FORWARD_PROXY_CONTEXT = 'streamingcommunity';

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = String(raw).trim();
    if (/^(1|true|yes|y|on)$/i.test(value)) return true;
    if (/^(0|false|no|n|off)$/i.test(value)) return false;
    return fallback;
}

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(String(process.env[name] || ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function getScForwardProxyBase() {
    const raw = String(
        process.env.SC_FORWARD_PROXY
        || process.env.STREAMINGCOMMUNITY_FORWARD_PROXY
        || process.env.STREAMINGCOMMUNITY_FORWARD_PROXY_URL
        || process.env.VIXSRC_FORWARD_PROXY
        || process.env.VIX_FORWARD_PROXY
        || process.env.FORWARD_PROXY
        || ''
    ).trim();

    if (!raw) return '';
    try {
        return normalizeSharedForwardProxyBase(raw, SC_FORWARD_PROXY_CONTEXT);
    } catch (error) {
        console.error(`[WEB][StreamingCommunity] invalid forward proxy | ${error.message}`);
        return '';
    }
}

function isScForwardProxyEnabled(kind = 'page') {
    const base = getScForwardProxyBase();
    if (!base) return false;
    if (!envFlag('SC_FORWARD_PROXY_ENABLED', envFlag('STREAMINGCOMMUNITY_FORWARD_PROXY_ENABLED', true))) return false;
    if (kind === 'playlist') {
        return envFlag('SC_FORWARD_PROXY_PLAYLISTS', envFlag('STREAMINGCOMMUNITY_FORWARD_PROXY_PLAYLISTS', true));
    }
    return true;
}

function shouldFallbackDirectAfterForward() {
    return envFlag('SC_FORWARD_PROXY_DIRECT_FALLBACK', envFlag('STREAMINGCOMMUNITY_FORWARD_PROXY_DIRECT_FALLBACK', false));
}

function buildScForwardProxyUrl(targetUrl, kind = 'page') {
    if (!isScForwardProxyEnabled(kind)) return null;
    const base = getScForwardProxyBase();
    if (!base) return null;
    try {
        const proxied = buildSharedForwardProxyUrl(targetUrl, { base, context: SC_FORWARD_PROXY_CONTEXT });
        return proxied && proxied !== targetUrl ? proxied : null;
    } catch (error) {
        console.error(`[WEB][StreamingCommunity] forward proxy url build failed | kind=${kind} | ${error.message}`);
        return null;
    }
}

function safeLogHost(value) {
    try {
        return new URL(String(value || '')).host;
    } catch {
        return '';
    }
}

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
const tmdbMetaCache = new TTLCache({ maxSize: 128, ttlMs: TMDB_META_CACHE_TTL_MS, cloneValues: true });
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
    if (response?._scForwarded) return response._scTargetUrl || fallback;
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
    data,
    kind = 'page'
} = {}) {
    const domain = (() => {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch (_) {
            return 'vixsrc';
        }
    })();

    const forwardUrl = buildScForwardProxyUrl(url, kind);
    const attempts = [];
    if (forwardUrl) {
        attempts.push({ requestUrl: forwardUrl, forwarded: true, via: 'forward-proxy' });
    }
    if (!forwardUrl || shouldFallbackDirectAfterForward()) {
        attempts.push({ requestUrl: url, forwarded: false, via: forwardUrl ? 'direct-fallback' : 'direct' });
    }

    let lastError = null;
    let lastResponse = null;

    for (const attempt of attempts) {
        try {
            const response = await requestBreaker.run(`${domain}:${attempt.via}`, async () => resilientCall(
                async () => http.request({
                    url: attempt.requestUrl,
                    method,
                    headers,
                    timeout: attempt.forwarded
                        ? envInt('SC_FORWARD_PROXY_TIMEOUT_MS', timeout || REQUEST_TIMEOUT, 1000, 60000)
                        : timeout,
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

            if (response) {
                response._scForwarded = attempt.forwarded;
                response._scTargetUrl = url;
                response._scRequestUrl = attempt.requestUrl;
                response._scVia = attempt.via;
            }

            lastResponse = response;
            const status = Number(response?.status || 0);
            const text = responseText(response);
            const shouldShield = !attempt.forwarded && providerShield.shouldUseShield({ url, status: response?.status, body: text, headers: response?.headers });
            if (shouldShield) {
                const shielded = await providerShield.fetchAxiosLike(url, {
                    method,
                    data,
                    ttl: DIRECT_PAGE_CACHE_TTL_MS,
                    timeout: Math.min(timeout || REQUEST_TIMEOUT, 6000),
                    via: 'vixsrc-shield'
                });
                if (shielded) return shielded;
            }

            if (!RETRYABLE_STATUSES.has(status) || attempt === attempts[attempts.length - 1]) return response;
        } catch (error) {
            lastError = error;
            if (!attempt.forwarded || !shouldFallbackDirectAfterForward()) break;
            console.error(`[WEB][StreamingCommunity] forward proxy fallback direct | kind=${kind} | host=${safeLogHost(url)} | proxy=${safeLogHost(attempt.requestUrl)} | error=${error.message}`);
        }
    }

    const shieldFallbackAllowed = !forwardUrl || shouldFallbackDirectAfterForward();
    if (shieldFallbackAllowed && providerShield.shouldUseShield({ url, error: lastError })) {
        const shielded = await providerShield.fetchAxiosLike(url, {
            method,
            data,
            ttl: DIRECT_PAGE_CACHE_TTL_MS,
            timeout: Math.min(timeout || REQUEST_TIMEOUT, 6000),
            via: 'vixsrc-shield'
        });
        if (shielded) return shielded;
    }

    return lastResponse || null;
}

async function fetchText(url, referer = null, kind = 'html') {
    const response = await getWithRetries(url, { headers: buildHeaders(referer, kind), kind });
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

function uniquePlaylistLanguages(values = []) {
    const out = [];
    for (const value of values || []) {
        const normalized = normalizePlaylistLanguage(value) || String(value || '').trim().toLowerCase();
        if (normalized && !out.includes(normalized)) out.push(normalized);
    }
    return out;
}

function buildScLanguageMeta(intelligence = null, fallbackText = '') {
    const audioLanguages = uniquePlaylistLanguages(intelligence?.audioLanguages || []);
    const subtitleLanguages = uniquePlaylistLanguages(intelligence?.subtitleLanguages || []);

    if (!audioLanguages.length && AUDIO_IT_RE.test(String(fallbackText || ''))) {
        audioLanguages.push('ita');
    }

    return {
        audioLanguages,
        subtitleLanguages,
        isMultiAudio: audioLanguages.length > 1,
        hasItalianAudio: audioLanguages.includes('ita'),
        language: audioLanguages.length === 1 ? audioLanguages[0] : ''
    };
}

async function getPlaylistLanguageIntel(streamUrl, referer) {
    try {
        const snapshot = await fetchPlaylistSnapshot(streamUrl, referer);
        const intelligence = extractPlaylistIntelligence(snapshot?.text || '');
        return {
            snapshot,
            intelligence,
            ...buildScLanguageMeta(intelligence, snapshot?.text || '')
        };
    } catch {
        return {
            snapshot: null,
            intelligence: null,
            ...buildScLanguageMeta(null, '')
        };
    }
}

function decorateScStreamWithLanguageIntel(stream, languageIntel = null) {
    if (!stream || !languageIntel) return stream;
    const audioLanguages = uniquePlaylistLanguages(languageIntel.audioLanguages || []);
    const subtitleLanguages = uniquePlaylistLanguages(languageIntel.subtitleLanguages || []);
    const intelligence = languageIntel.intelligence || null;

    const vortexMeta = {
        ...(stream.behaviorHints?.vortexMeta || {})
    };

    if (audioLanguages.length) {
        vortexMeta.audioLanguages = audioLanguages;
        vortexMeta.isMultiAudio = audioLanguages.length > 1;
        vortexMeta.hasItalianAudio = audioLanguages.includes('ita');
    }

    if (subtitleLanguages.length) {
        vortexMeta.subtitleLanguages = subtitleLanguages;
    }

    if (intelligence) {
        vortexMeta.playlistLanguageConfidence = intelligence.confidence || 0;
        vortexMeta.playlistVariantCount = intelligence.variantCount || 0;
        vortexMeta.playlistTrackCount = intelligence.trackCount || 0;
        vortexMeta.playlistQuality = normalizeQuality(intelligence.quality || 'Unknown');
        vortexMeta.playlistHeight = intelligence.height || 0;
    }

    return {
        ...stream,
        language: audioLanguages.length === 1 ? audioLanguages[0] : stream.language,
        audioLanguages: audioLanguages.length ? audioLanguages : stream.audioLanguages,
        subtitleLanguages: subtitleLanguages.length ? subtitleLanguages : stream.subtitleLanguages,
        isMultiAudio: audioLanguages.length > 1 || stream.isMultiAudio === true,
        hasItalianAudio: audioLanguages.includes('ita') || stream.hasItalianAudio === true,
        behaviorHints: {
            ...(stream.behaviorHints || {}),
            audioLanguages: audioLanguages.length ? audioLanguages : stream.behaviorHints?.audioLanguages,
            subtitleLanguages: subtitleLanguages.length ? subtitleLanguages : stream.behaviorHints?.subtitleLanguages,
            isMultiAudio: audioLanguages.length > 1 || stream.behaviorHints?.isMultiAudio === true,
            hasItalianAudio: audioLanguages.includes('ita') || stream.behaviorHints?.hasItalianAudio === true,
            vortexMeta
        }
    };
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

function isImdbId(value) {
    return /^tt\d{5,12}$/i.test(String(value || '').trim());
}

function extractTmdbIdFromValue(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return raw;

    const patterns = [
        /^tmdb:(\d+)$/i,
        /^tmdb:(?:movie|tv|series):(\d+)$/i,
        /^tmdb[/-](?:movie|tv|series)[/-](\d+)$/i,
        /(?:^|:)tmdb:(\d+)$/i,
        /(?:^|:)(\d{2,})$/
    ];

    for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (match?.[1]) return String(match[1]);
    }
    return null;
}

function tmdbParams(params = {}) {
    return { api_key: TMDB_API_KEY, ...params };
}

async function fetchTmdbJson(path, params = {}, cacheKey = null, ttlMs = TMDB_META_CACHE_TTL_MS) {
    const finalCacheKey = cacheKey ? `tmdb:${cacheKey}` : null;
    if (finalCacheKey) {
        const cached = cacheGet(tmdbMetaCache, finalCacheKey);
        if (cached) return cached;
    }

    return singleFlight(finalCacheKey || `tmdb:${path}:${JSON.stringify(params)}`, async () => {
        if (finalCacheKey) {
            const secondCached = cacheGet(tmdbMetaCache, finalCacheKey);
            if (secondCached) return secondCached;
        }

        try {
            const response = await http.get(`${TMDB_API_BASE}${path}`, {
                params: tmdbParams(params),
                timeout: 6000,
                validateStatus: () => true,
                proxy: false
            });
            if (Number(response.status) !== 200 || !response.data || typeof response.data !== 'object') return null;
            if (finalCacheKey) cacheSet(tmdbMetaCache, finalCacheKey, response.data, ttlMs);
            return response.data;
        } catch {
            return null;
        }
    });
}

async function fetchRealTitle(imdbId, metaType) {
    if (!isImdbId(imdbId)) return null;
    try {
        const metaUrl = `${CINEMETA_BASE}/${metaType}/${imdbId}.json`;
        const response = await http.get(metaUrl, { timeout: 6000, validateStatus: () => true, proxy: false });
        if (Number(response.status) !== 200) return null;
        return response?.data?.meta?.name || null;
    } catch {
        return null;
    }
}

async function resolveTmdbFromImdb(imdbId, isSeries) {
    if (!isImdbId(imdbId)) return null;
    const payload = await fetchTmdbJson(`/find/${imdbId}`, {
        external_source: 'imdb_id',
        language: 'it-IT'
    }, `find:${imdbId}:${isSeries ? 'tv' : 'movie'}`);
    if (!payload) return null;

    const bucket = isSeries ? payload?.tv_results : payload?.movie_results;
    const first = Array.isArray(bucket) ? bucket[0] : null;
    return first?.id ? String(first.id) : null;
}

async function fetchTmdbMeta(tmdbId, isSeries) {
    const normalizedTmdbId = extractTmdbIdFromValue(tmdbId);
    if (!normalizedTmdbId) return null;

    const kind = isSeries ? 'tv' : 'movie';
    const payload = await fetchTmdbJson(`/${kind}/${normalizedTmdbId}`, {
        language: 'it-IT',
        append_to_response: 'external_ids,translations'
    }, `meta:${kind}:${normalizedTmdbId}`);
    if (!payload) return null;

    return {
        tmdbId: String(payload?.id || normalizedTmdbId),
        imdbId: payload?.imdb_id || payload?.external_ids?.imdb_id || null,
        title: payload?.title || payload?.name || null,
        originalTitle: payload?.original_title || payload?.original_name || null,
        originalLanguage: payload?.original_language || null,
        year: String(payload?.release_date || payload?.first_air_date || '').slice(0, 4) || null,
        raw: payload
    };
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
        const response = await getWithRetries(apiUrl, { headers: buildHeaders(pageUrl, 'json'), kind: 'json' });
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
    const token = issueHlsTransitKey(masterSource, {
        kind: TRANSIT_KIND,
        referer,
        headers: buildProxyRequestHeaders(masterSource, referer),
        hostBinding: VIX_STRICT_HOST_BINDING ? addonBase : null,
        routeBinding: '/vixsynthetic.m3u8',
        issuer: 'vix-handler',
        profile: 'synthetic-stream',
        meta: {
            syntheticQuality: quality,
            syntheticVariant: quality === '1080p' ? 'max' : 'mid'
        },
        tokenTtlMs: HLS_PLAYBACK_TOKEN_TTL_MS,
        tokenMaxUses: 0,
        maxUses: 0
    });
    return token ? buildTransitUrl(addonBase, '/vixsynthetic.m3u8', token) : '';
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
        const baBranch = String(a?.behaviorHints?.vortexMeta?.branch || '').toLowerCase();
        const bbBranch = String(b?.behaviorHints?.vortexMeta?.branch || '').toLowerCase();
        const aSafe = baBranch.includes('android-safe') ? 1 : 0;
        const bSafe = bbBranch.includes('android-safe') ? 1 : 0;
        if (bSafe !== aSafe) return bSafe - aSafe;
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
    let languageIntel = buildScLanguageMeta(null, '');

    try {
        languageIntel = await getPlaylistLanguageIntel(streamUrl, pageUrl);
        const snapshot = languageIntel?.snapshot;
        if (snapshot?.text) {
            quality = normalizeQuality(snapshot.quality);
            if (!qualityMatchesFilter(quality, qualityFilter)) {
                return { quality, headers, languageIntel, allowed: false };
            }

            if (languageIntel.hasItalianAudio) {
                headers['Accept-Language'] = 'it-IT,it;q=0.9,en;q=0.8';
            } else {
                headers['Accept-Language'] = 'en-US,en;q=0.9,it;q=0.5';
            }
        }
    } catch {}

    return { quality, headers, languageIntel, allowed: true };
}

async function extractFromCandidate(candidateUrl, cleanTitle, season, episode, qualityFilter, reqHost) {
    const { payload, referer } = await resolveCachedPayload(candidateUrl);
    if (!payload) return [];

    const pageReferer = referer || candidateUrl;
    const sourceUrl = buildMasterUrl(payload.rawUrl, payload.token, payload.expires, payload.canPlayFHD, payload.hasB, payload.asn);
    if (!sourceUrl) return [];

    return buildSyntheticStreamsFromSource(sourceUrl, pageReferer, cleanTitle, season, episode, qualityFilter, reqHost, {
        canPlayFHD: payload.canPlayFHD === true
    });
}

async function tryDirectVixsrcStream(pageUrl, cleanTitle, season, episode, qualityFilter) {
    const cached = cacheGet(directPageCache, pageUrl);
    let status;
    let pageHtml;
    if (cached) {
        ({ status, pageHtml } = cached);
    } else {
        const response = await getWithRetries(pageUrl, { headers: buildHeaders(`${VIX_BASE}/`, 'html'), kind: 'html' });
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
    const { quality, headers, languageIntel, allowed } = await fetchPlaylistQualityAndHeaders(streamUrl, pageUrl, qualityFilter);
    if (!allowed) return [];

    const stream = decorateScStreamWithLanguageIntel({
        name: 'SC Direct',
        title: cleanTitle,
        url: streamUrl,
        quality,
        behaviorHints: {
            notWebReady: false,
            proxyHeaders: { request: headers },
            vortexMeta: { branch: 'direct-vixsrc', quality }
        }
    }, languageIntel);
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

function extractSeasonMarker(value) {
    const text = ` ${normalizeLookupTitle(value)} `;
    const patterns = [
        /\b(?:season|stagione|serie|s)\s*([1-9]\d*)\b/i,
        /\b([1-9]\d*)(?:st|nd|rd|th)\s+season\b/i,
        /\b(?:part|cour)\s*([1-9]\d*)\b/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            const parsed = Number.parseInt(match[1], 10);
            if (Number.isInteger(parsed) && parsed > 0) return parsed;
        }
    }

    const roman = text.match(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b/i);
    if (roman?.[1]) {
        const romanMap = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
        return romanMap[String(roman[1]).toLowerCase()] || null;
    }

    const tail = text.match(/\b([2-9])\b\s*$/);
    return tail?.[1] ? Number.parseInt(tail[1], 10) : null;
}

function removeSeasonMarkers(value) {
    return ` ${normalizeLookupTitle(value)} `
        .replace(/\b(?:season|stagione|serie|s)\s*\d+\b/gi, ' ')
        .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, ' ')
        .replace(/\b(?:part|cour)\s*\d+\b/gi, ' ')
        .replace(/\b(?:ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, ' ')
        .replace(/\b[2-9]\b\s*$/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function firstSeasonMarker(values = []) {
    for (const value of values || []) {
        const season = extractSeasonMarker(value);
        if (season) return season;
    }
    return null;
}

function filterSeasonSpecificTitles(titles = []) {
    const season = firstSeasonMarker(titles);
    if (!season) return titles;
    const filtered = titles.filter((title) => extractSeasonMarker(title) === season);
    return filtered.length ? filtered : titles;
}

function seasonScoreAdjustment(wantedTitles = [], candidateTitles = []) {
    const wantedSeason = firstSeasonMarker(wantedTitles);
    const candidateSeason = firstSeasonMarker(candidateTitles);
    if (!wantedSeason) return candidateSeason ? -15 : 0;
    if (!candidateSeason) return -110;
    if (candidateSeason !== wantedSeason) return -180;

    const wantedRoots = uniqueNonEmpty(wantedTitles.map(removeSeasonMarkers).filter(Boolean));
    const candidateRoots = uniqueNonEmpty(candidateTitles.map(removeSeasonMarkers).filter(Boolean));
    const rootMatch = wantedRoots.some((wanted) => candidateRoots.some((candidate) => (
        wanted === candidate || candidate.includes(wanted) || wanted.includes(candidate)
    )));
    return rootMatch ? 120 : 90;
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
        meta?.kitsu,
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

function getBareNumericKitsuCandidates(meta = {}) {
    return [
        meta?.kitsu_id,
        meta?.kitsuId,
        meta?.kitsu,
        meta?.animeKitsuId,
        meta?.behaviorHints?.kitsuId,
        meta?.behaviorHints?.kitsu_id
    ];
}

function parseKitsuCandidate(value, { allowBareNumeric = false } = {}) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (!allowBareNumeric && /^\d+$/.test(raw)) return null;
    return kitsuProvider.parseKitsuId(raw);
}

function findKitsuIdentifierDeep(meta = {}) {
    for (const candidate of uniqueNonEmpty(getBareNumericKitsuCandidates(meta))) {
        const parsed = parseKitsuCandidate(candidate, { allowBareNumeric: true });
        if (parsed?.kitsuId) return parsed;
    }

    const candidates = uniqueNonEmpty([
        ...getExplicitKitsuCandidates(meta),
        ...collectDeepStringValues(meta, 4, 240)
    ]);
    for (const candidate of candidates) {
        const parsed = parseKitsuCandidate(candidate);
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
    for (const candidate of uniqueNonEmpty(getBareNumericKitsuCandidates(meta))) {
        const parsed = parseKitsuCandidate(candidate, { allowBareNumeric: true });
        if (parsed?.kitsuId) return String(candidate);
    }

    const explicit = getExplicitKitsuCandidates(meta);
    for (const candidate of explicit) {
        const parsed = parseKitsuCandidate(candidate);
        if (parsed?.kitsuId) return String(candidate);
    }
    if (kitsu?.kitsuId) {
        const ep = kitsu?.episodeNumber ? `:${kitsu.episodeNumber}` : '';
        return `kitsu:${kitsu.kitsuId}${ep}`;
    }
    return buildKitsuContextId(meta, kitsu);
}


function buildKitsuMappingProviderContext(meta = {}, config = {}, kitsu = null, episodeNumber = 1) {
    const contextId = buildKitsuResolvedSourceId(meta, kitsu) || (kitsu?.kitsuId ? `kitsu:${kitsu.kitsuId}:${episodeNumber || 1}` : null);
    const providerContext = animeProviderUtils.buildAnimeProviderContext({
        ...meta,
        id: contextId || meta?.id || meta?.requestedId || meta?.originalId || null,
        kitsuId: kitsu?.kitsuId || meta?.kitsuId || meta?.kitsu_id || meta?.kitsu || null,
        episode: episodeNumber
    });

    providerContext.mappingLanguage = 'it';
    providerContext.italianOnly = true;
    providerContext.onlyItalian = true;
    providerContext.mappingTimeoutMs = REQUEST_TIMEOUT;
    providerContext.mappingRetries = 2;

    if (Array.isArray(config?.mappingApiBases)) providerContext.mappingApiBases = config.mappingApiBases;
    if (Array.isArray(config?.mappingMirrors)) providerContext.mappingApiBases = config.mappingMirrors;
    if (Array.isArray(config?.filters?.mappingApiBases)) providerContext.mappingApiBases = config.filters.mappingApiBases;
    if (Array.isArray(config?.filters?.mappingMirrors)) providerContext.mappingApiBases = config.filters.mappingMirrors;

    return providerContext;
}

function extractMappingEntries(mappingPayload, key) {
    const raw = mappingPayload?.mappings?.[key]
        || mappingPayload?.mapping?.[key]
        || mappingPayload?.providers?.[key]
        || mappingPayload?.[key]
        || null;
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function extractAnimeUnityPathsFromMapping(mappingPayload) {
    const entries = extractMappingEntries(mappingPayload, 'animeunity');
    const paths = [];

    for (const entry of entries) {
        const value = typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object'
                ? entry.path || entry.url || entry.href || entry.playPath || entry.watchPath || null
                : null;
        const normalized = normalizeAnimeUrl(value, AU_BASE);
        if (normalized && normalized.includes('/anime/')) paths.push(normalized);
    }

    return uniqueNonEmpty(paths);
}

function resolveStrictKitsuEpisode(mappingPayload, fallbackEpisode) {
    const requested = Number.parseInt(String(fallbackEpisode || ''), 10) || 1;
    const fromKitsu = Number.parseInt(String(mappingPayload?.kitsu?.episode || ''), 10);
    const fromRequested = Number.parseInt(String(mappingPayload?.requested?.episode || ''), 10);
    if (Number.isInteger(fromKitsu) && fromKitsu > 0 && fromKitsu === requested) return fromKitsu;
    if (Number.isInteger(fromRequested) && fromRequested > 0 && fromRequested === requested) return fromRequested;
    return requested;
}

function looksLikeAnimeMeta(meta = {}) {
    if (findKitsuIdentifierDeep(meta)) return true;
    if (meta?.isAnime === true || meta?.anime === true) return true;

    const directType = String(meta?.type || meta?.kind || meta?.mediaType || '').toLowerCase();
    if (/(^|[^a-z])anime([^a-z]|$)/i.test(directType)) return true;

    const genreList = Array.isArray(meta?.genres) ? meta.genres : [];
    if (genreList.some((value) => /(^|[^a-z])anime([^a-z]|$)/i.test(String(value)))) return true;

    const haystack = uniqueNonEmpty(collectDeepStringValues(meta, 3, 120)).join(' | ').toLowerCase();
    return /(anime-kitsu|kitsu:)/i.test(haystack);
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
    score += seasonScoreAdjustment(wantedTitles, candidateTitles);
    return score;
}

function rankAnimeUnityResults(results, searchContext) {
    return [...(results || [])]
        .map((result) => ({ result, score: scoreAnimeUnityResult(result, searchContext) }))
        .filter((entry) => entry.result && Number(entry.score || 0) >= 35)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.result);
}

function pickBestAnimeUnityResult(results, searchContext) {
    return rankAnimeUnityResults(results, searchContext)[0] || null;
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

function pickAnimeEpisode(episodes, requestedEpisode, isMovie, options = {}) {
    const wanted = normalizeEpisodeCandidate(requestedEpisode) || 1;
    const list = Array.isArray(episodes) ? episodes : [];
    if (!list.length) return null;

    const exact = list.find((episode) => normalizeEpisodeCandidate(episode?.number) === wanted);
    if (exact) return exact;

    if (options?.strictEpisode && !isMovie) return null;
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

async function getAnimeUnityEmbedUrl(animePath, episodeNumber, isMovie, options = {}) {
    const animeUrl = normalizeAnimeUrl(animePath, AU_BASE);
    if (!animeUrl) return null;

    const page = await fetchAnimePage(animeUrl, `${AU_BASE}/`);
    if (!page?.html) return null;

    const $ = cheerio.load(page.html || '');
    const player = $('video-player').first();
    let embedUrl = normalizeAnimeUrl(player.attr('embed_url'), page.url);
    const episodes = parseAnimeEpisodes(player.attr('episodes'));
    const chosenEpisode = pickAnimeEpisode(episodes, episodeNumber, isMovie, options);

    if (options?.strictEpisode && !isMovie && episodes.length && !chosenEpisode) return null;

    if (chosenEpisode?.embed_url) {
        embedUrl = normalizeAnimeUrl(chosenEpisode.embed_url, page.url);
        if (embedUrl) return embedUrl;
    }

    if (embedUrl && (isMovie || (!options?.strictEpisode && !chosenEpisode?.id))) return embedUrl;

    if (chosenEpisode?.id) {
        const episodePage = await fetchAnimePage(`${animeUrl.replace(/\/$/, '')}/${chosenEpisode.id}`, animeUrl);
        if (episodePage?.html) {
            const $episode = cheerio.load(episodePage.html || '');
            const directEmbed = normalizeAnimeUrl($episode('video-player').first().attr('embed_url'), episodePage.url)
                || normalizeAnimeUrl($episode('iframe[src*="vixcloud"]').first().attr('src'), episodePage.url);
            if (directEmbed) return directEmbed;
        }
    }

    return options?.strictEpisode && !isMovie
        ? null
        : (embedUrl || normalizeAnimeUrl($('iframe[src*="vixcloud"]').first().attr('src'), page.url));
}

async function resolveAnimeUnityMapping(kitsuId, episodeNumber, providerContext = null) {
    const requestedEpisode = Number.parseInt(String(episodeNumber || ''), 10) || 1;
    const lookup = {
        provider: 'kitsu',
        externalId: String(kitsuId || '').trim(),
        season: null,
        episode: requestedEpisode,
        contentType: 'anime'
    };
    if (!lookup.externalId) return null;

    const payload = await animeProviderUtils.fetchMappingPayload(lookup, providerContext);
    if (!payload) return null;

    const animePaths = extractAnimeUnityPathsFromMapping(payload);
    return {
        animePath: animePaths[0] || null,
        animePaths,
        episodeNumber: resolveStrictKitsuEpisode(payload, requestedEpisode),
        mappingPayload: payload
    };
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
    const shouldProbeLanguages = !fastMode || String(process.env.SC_FAST_LANGUAGE_PROBE || '').trim() === '1';

    let inferredFhd = hintedFhd;
    let languageIntel = buildScLanguageMeta(null, '');

    if (shouldProbeLanguages) {
        languageIntel = await getPlaylistLanguageIntel(sourceUrl, pageReferer);
    }

    if (!inferredFhd && wants1080 && !fastMode) {
        try {
            inferredFhd = ['1080p', '1440p', '4K'].includes(normalizeQuality(languageIntel?.snapshot?.quality || 'Unknown'))
                || await inferCanPlayFHDFromPlaylist(sourceUrl, pageReferer);
        } catch {}
    }

    const makeStream = (stream) => stampScStream(decorateScStreamWithLanguageIntel(stream, languageIntel), cleanTitle, season, episode);

    if (inferredFhd && wants1080) {
        streams.push(makeStream({
            name: '🎬 StreamingCommunity\n🎥 1080p',
            title: cleanTitle,
            url: buildSyntheticUrl(sourceUrl, '1080p', pageReferer, reqHost),
            quality: '1080p',
            behaviorHints: {
                notWebReady: false,
                vortexMeta: { branch: fastMode ? 'synthetic-1080-fast' : 'synthetic-1080', quality: '1080p' }
            }
        }));
    }

    if (wants720 || (!streams.length && fastMode)) {
        streams.push(makeStream({
            name: '📱 StreamingCommunity\n🛡 Android/TV Safe 720p',
            title: cleanTitle,
            url: buildSyntheticUrl(sourceUrl, '720p', pageReferer, reqHost),
            quality: '720p',
            behaviorHints: {
                notWebReady: false,
                vortexMeta: { branch: fastMode ? 'android-safe-720-fast' : 'android-safe-720', quality: '720p', androidTvSafe: true }
            }
        }));
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

    const providerContext = buildKitsuMappingProviderContext(meta, config, kitsu, episodeNumber);
    let animePaths = [];
    let resolvedEpisode = Number(episodeNumber) || 1;
    try {
        const mapping = await resolveAnimeUnityMapping(kitsu.kitsuId, resolvedEpisode, providerContext);
        animePaths = Array.isArray(mapping?.animePaths) ? mapping.animePaths : (mapping?.animePath ? [mapping.animePath] : []);
        resolvedEpisode = Number(mapping?.episodeNumber || resolvedEpisode) || resolvedEpisode;
        kitsuDebug('mapping', `paths=${animePaths.length} resolvedEp=${resolvedEpisode}`);
    } catch (error) {
        kitsuDebug('mapping-error', error?.message || 'unknown');
    }

    let embedUrl = null;
    for (const animePath of animePaths.slice(0, 4)) {
        embedUrl = await getAnimeUnityEmbedUrl(animePath, resolvedEpisode, searchContext?.isMovie, { strictEpisode: true });
        kitsuDebug('mapping-embed', `path=${animePath} found=${!!embedUrl}`);
        if (embedUrl) break;
    }

    if (!embedUrl) {
        const session = await fetchAnimeUnitySession();
        kitsuDebug('session', `ok=${!!session}`);
        if (session) {
            const titleCandidates = filterSeasonSpecificTitles(uniqueNonEmpty([
                ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
                ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
                ...fetchedTitles,
                cleanTitle,
                meta?.title,
                meta?.name,
                meta?.originalTitle
            ]));

            for (const title of titleCandidates.slice(0, 6)) {
                const results = await searchAnimeUnity(title, session);
                kitsuDebug('search', `title=${title} results=${results.length}`);
                const searchTitles = filterSeasonSpecificTitles(uniqueNonEmpty([
                    ...(Array.isArray(searchContext?.searchTitles) ? searchContext.searchTitles : []),
                    ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
                    ...fetchedTitles,
                    cleanTitle,
                    title
                ]));
                const rawTitles = filterSeasonSpecificTitles(uniqueNonEmpty([
                    ...(Array.isArray(searchContext?.rawTitles) ? searchContext.rawTitles : []),
                    ...fetchedTitles,
                    cleanTitle,
                    title
                ]));
                const ranked = rankAnimeUnityResults(results, {
                    ...(searchContext || {}),
                    searchTitles,
                    rawTitles
                });

                for (const candidate of ranked.slice(0, 5)) {
                    const path = buildAnimeUnityPath(candidate);
                    if (!path) continue;
                    kitsuDebug('search-best', `title=${title} path=${path}`);
                    embedUrl = await getAnimeUnityEmbedUrl(path, resolvedEpisode, searchContext?.isMovie, { strictEpisode: true });
                    kitsuDebug('search-embed', `title=${title} found=${!!embedUrl}`);
                    if (embedUrl) break;
                }
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

function collectTmdbTitleCandidates(meta = {}) {
    return uniqueNonEmpty([
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.canonicalTitle,
        meta?.seriesTitle
    ]);
}

function scoreTmdbResult(result, titleCandidates = [], meta = {}, isSeries = false) {
    const resultTitles = uniqueNonEmpty([
        result?.title,
        result?.name,
        result?.original_title,
        result?.original_name
    ]).map((value) => normalizeLookupTitle(value));
    const wantedTitles = uniqueNonEmpty(titleCandidates).map((value) => normalizeLookupTitle(value));

    let score = 0;
    for (const candidate of resultTitles) {
        for (const wanted of wantedTitles) {
            if (!candidate || !wanted) continue;
            if (candidate === wanted) score += 200;
            else if (candidate.includes(wanted) || wanted.includes(candidate)) score += 80;
            else if (candidate.split(' ').slice(0, 3).join(' ') === wanted.split(' ').slice(0, 3).join(' ')) score += 35;
        }
    }

    const wantedYear = extractCandidateYear(meta?.year || meta?.date || meta?.releaseInfo);
    const resultYear = extractCandidateYear(result?.release_date || result?.first_air_date);
    if (wantedYear && resultYear && wantedYear === resultYear) score += 20;
    if (isSeries && result?.name) score += 5;
    if (!isSeries && result?.title) score += 5;
    if (String(result?.original_language || '').toLowerCase() === 'it') score += 3;
    return score;
}

async function searchTmdbByTitle(meta = {}) {
    const titleCandidates = collectTmdbTitleCandidates(meta);
    if (!titleCandidates.length) return null;

    const isSeries = Boolean(meta?.isSeries);
    const path = isSeries ? '/search/tv' : '/search/movie';
    const year = extractCandidateYear(meta?.year || meta?.date || meta?.releaseInfo);

    for (const title of titleCandidates.slice(0, 4)) {
        const params = {
            language: 'it-IT',
            include_adult: 'false',
            query: title
        };
        if (year) {
            if (isSeries) params.first_air_date_year = String(year);
            else params.year = String(year);
        }

        const payload = await fetchTmdbJson(path, params, `search:${isSeries ? 'tv' : 'movie'}:${normalizeLookupTitle(title)}:${year || 'na'}`);
        const results = Array.isArray(payload?.results) ? payload.results : [];
        if (!results.length) continue;

        const ranked = [...results]
            .map((entry) => ({ entry, score: scoreTmdbResult(entry, titleCandidates, meta, isSeries) }))
            .sort((a, b) => b.score - a.score);

        if (ranked[0]?.entry?.id && Number(ranked[0].score || 0) >= 120) {
            return String(ranked[0].entry.id);
        }
    }

    return null;
}

async function resolveTmdbId(meta = {}) {
    const explicitTmdbId = extractTmdbIdFromValue(meta?.tmdb_id || meta?.tmdbId);
    if (explicitTmdbId) return explicitTmdbId;

    const imdbCandidates = uniqueNonEmpty([meta?.imdb_id, meta?.id, meta?.requestedId, meta?.originalId]).filter(isImdbId);
    for (const imdbId of imdbCandidates) {
        const viaTmdbFind = await resolveTmdbFromImdb(imdbId, meta?.isSeries);
        if (viaTmdbFind) return viaTmdbFind;

        const converted = await mediaIdentity.imdbToTmdb(imdbId).catch(() => null);
        if (converted?.tmdbId) return String(converted.tmdbId);
    }

    const fromGenericId = extractTmdbIdFromValue(meta?.id);
    if (fromGenericId) return fromGenericId;

    return searchTmdbByTitle(meta);
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
            kitsuDebug('strict-stop', 'direct-kitsu-no-stream; no tmdb fallback to avoid wrong episode/movie');
            return [];
        }

        const tmdbId = await resolveTmdbId(meta);
        if (!tmdbId) {
            console.log('[WEB][StreamingCommunity] no-tmdb');
            if (animeHint && !directKitsu?.kitsuId) {
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
        const tmdbMeta = await fetchTmdbMeta(tmdbId, meta?.isSeries).catch(() => null);
        const canonicalImdbId = tmdbMeta?.imdbId || (isImdbId(meta?.imdb_id) ? meta.imdb_id : null) || (isImdbId(meta?.id) ? meta.id : null);
        const realTitle = await fetchRealTitle(canonicalImdbId, meta?.isSeries ? 'series' : 'movie').catch(() => null);
        const finalTmdbId = tmdbMeta?.tmdbId || String(tmdbId);
        const cleanTitle = cleanSeriesTitle(
            realTitle
            || tmdbMeta?.title
            || tmdbMeta?.originalTitle
            || meta?.title
            || meta?.originalTitle
            || meta?.name
            || meta?.id
            || 'StreamingCommunity'
        );
        console.log('[WEB][StreamingCommunity][TMDB]', JSON.stringify({
            tmdbId: finalTmdbId,
            imdbId: canonicalImdbId,
            title: cleanTitle,
            originalTitle: tmdbMeta?.originalTitle || null,
            year: tmdbMeta?.year || null
        }));
        const pageUrl = buildScPageUrl(finalTmdbId, season, episode);
        const embedUrl = await resolveScEmbedUrl(finalTmdbId, pageUrl, season, episode);

        const candidateUrls = [];
        if (embedUrl) candidateUrls.push(embedUrl);
        candidateUrls.push(pageUrl);

        for (const candidateUrl of [...new Set(candidateUrls.filter(Boolean))]) {
            const out = await extractFromCandidate(candidateUrl, cleanTitle, season, episode, normalizedQuality, reqHost);
            if (out.length) {
                console.log(`[WEB][StreamingCommunity] ok | tmdb=${finalTmdbId} | items=${out.length} | via=${candidateUrl === embedUrl ? 'api-src' : 'page'}`);
                return out;
            }
        }

        for (const candidateUrl of [...new Set(candidateUrls.filter(Boolean))]) {
            const direct = await tryDirectVixsrcStream(candidateUrl, cleanTitle, season, episode, normalizedQuality);
            if (direct.length) {
                console.log(`[WEB][StreamingCommunity] direct-ok | tmdb=${finalTmdbId} | items=${direct.length}`);
                return sortStreams(dedupeStreams(direct));
            }
        }

        if (animeHint && !directKitsu?.kitsuId) {
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

        console.log(`[WEB][StreamingCommunity] no-server-url | tmdb=${finalTmdbId}`);
        return [];
    } catch (error) {
        console.error(`[WEB][StreamingCommunity] error | ${error.message}`);
        return [];
    }
}

module.exports = {
    searchVix,
    resolveAnimeManifest,
    buildSyntheticUrl,
    normalizeQualityFilter,
    inferCanPlayFHDFromPlaylist
};

