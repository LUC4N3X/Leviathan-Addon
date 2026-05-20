'use strict';

const { buildWebStream, normalizeRemoteUrl } = require('../extractors/common');
const { ProviderRequestCache } = require('../../core/cache/provider_request_cache');
const { createMediaflowGateway, getMediaflowBase, buildMediaflowUrl } = require('../../core/proxy/mediaflow_gateway');
const { isUprotUrl, resolveUprotToMaxstream } = require('../extractors/hosters/uprot');
const { extractMixdrop } = require('../extractors/hosters/mixdrop');

const DEFAULT_BASE_URL = 'https://cb01uno.bar';
const PROVIDER = 'CB01';
const PROVIDER_CODE = 'CB01';
const ICON = '🎬';
const SEARCH_TTL_FALLBACK_MS = 12_000;
const SAFEGO_FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const CB_CACHE_LIMIT = 700;
const CB_CACHE_TTL = Object.freeze({
    movieSearch: 30 * 60_000,
    seriesSearch: 30 * 60_000,
    moviePage: 20 * 60_000,
    seriesPage: 20 * 60_000,
    stayonline: 15 * 60_000,
    seasonAlias: 30 * 60_000
});

const cbMemoryCache = new Map();
const cbRequestCache = new ProviderRequestCache({ name: 'cb01', maxEntries: 900, inflightMaxEntries: 500 });

function cacheNamespaceKey(namespace, parts = []) {
    return `${namespace}:${parts.map((part) => String(part ?? '').trim()).join('|')}`;
}

function cloneCacheValue(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

function getCbCache(namespace, parts = []) {
    const key = cacheNamespaceKey(namespace, parts);
    const entry = cbMemoryCache.get(key);
    if (!entry) {
        cbDebug('trace', 'cache miss', { namespace, key: String(key).slice(0, 160) });
        return null;
    }
    if (entry.expiresAt <= Date.now()) {
        cbMemoryCache.delete(key);
        cbDebug('trace', 'cache expired', { namespace, key: String(key).slice(0, 160) });
        return null;
    }
    entry.lastHit = Date.now();
    cbDebug('trace', 'cache hit', { namespace, key: String(key).slice(0, 160), ttlLeftMs: Math.max(0, entry.expiresAt - Date.now()) });
    return cloneCacheValue(entry.value);
}

function setCbCache(namespace, parts = [], value, ttlMs) {
    if (value == null) return value;
    const key = cacheNamespaceKey(namespace, parts);
    const effectiveTtl = Math.max(1_000, Number(ttlMs || CB_CACHE_TTL[namespace] || 60_000));
    cbMemoryCache.set(key, {
        value: cloneCacheValue(value),
        expiresAt: Date.now() + effectiveTtl,
        lastHit: Date.now()
    });
    cbDebug('trace', 'cache set', { namespace, key: String(key).slice(0, 160), ttlMs: effectiveTtl, size: cbMemoryCache.size });
    if (cbMemoryCache.size > CB_CACHE_LIMIT) {
        const victims = [...cbMemoryCache.entries()]
            .sort((a, b) => (a[1].expiresAt - b[1].expiresAt) || (a[1].lastHit - b[1].lastHit))
            .slice(0, Math.ceil(CB_CACHE_LIMIT * 0.15));
        for (const [victimKey] of victims) cbMemoryCache.delete(victimKey);
    }
    return value;
}

async function withCbCoalescing(namespace, parts = [], worker) {
    const key = cacheNamespaceKey(namespace, parts);
    if (cbRequestCache.inflight.has(key)) {
        cbDebug('info', 'coalescing hit', { namespace, key: String(key).slice(0, 160) });
    }
    return cbRequestCache.singleFlight(key, worker);
}

function normalizeBaseUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
        try { return new URL(raw).origin; } catch (_) { return raw; }
    }
    try { return new URL(`https://${raw}`).origin; } catch (_) { return `https://${raw}`; }
}

function getBaseUrls() {
    const out = [normalizeBaseUrl(DEFAULT_BASE_URL)].filter(Boolean);
    cbDebug('trace', 'base urls resolved', { bases: out, source: 'hardcoded' });
    return out;
}

function getBaseUrl() {
    return getBaseUrls()[0];
}

function getDefaultClient() {
    try {
        const axios = require('axios');
        return axios.create({
            timeout: Number.parseInt(process.env.CB01_PROVIDER_TIMEOUT || String(SEARCH_TTL_FALLBACK_MS), 10) || SEARCH_TTL_FALLBACK_MS,
            maxRedirects: 5,
            proxy: false,
            validateStatus: () => true,
            headers: {
                'User-Agent': DESKTOP_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5'
            }
        });
    } catch (_) {
        return null;
    }
}

function envFlag(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    return /^(?:1|true|yes|on)$/i.test(String(raw).trim());
}

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const raw = process.env[name];
    const value = Number.parseInt(String(raw ?? fallback), 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function isCbDebugEnabled() {
    return envFlag('CB01_DEBUG', false) || envFlag('CB01_VERBOSE', false) || envFlag('WEB_PROVIDER_DEBUG', false);
}

function isCbTraceEnabled() {
    return envFlag('CB01_TRACE', false) || envFlag('CB01_DEBUG_VERBOSE', false);
}

function sanitizeLogValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        let out = value;
        out = out.replace(/(api_password=)[^&\s]+/gi, '$1***');
        out = out.replace(/([?&](?:api|key|token|pass|password|apikey|api_key)=)[^&\s]+/gi, '$1***');
        out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1***');
        return out.length > 650 ? `${out.slice(0, 650)}…` : out;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        if (depth > 2) return `[array:${value.length}]`;
        return value.slice(0, 12).map((item) => sanitizeLogValue(item, depth + 1));
    }
    if (typeof value === 'object') {
        if (depth > 2) return '[object]';
        const out = {};
        for (const [key, item] of Object.entries(value).slice(0, 40)) {
            if (/password|pass|token|apikey|api_key|key/i.test(key)) {
                out[key] = item ? '***' : item;
            } else {
                out[key] = sanitizeLogValue(item, depth + 1);
            }
        }
        return out;
    }
    return String(value);
}

function cbDebug(level, message, payload = null) {
    const normalizedLevel = String(level || 'info').toLowerCase();
    const alwaysShow = /^(warn|error)$/i.test(normalizedLevel);
    if (!alwaysShow && !isCbDebugEnabled()) return;
    if (normalizedLevel === 'trace' && !isCbTraceEnabled()) return;
    const logger = console[normalizedLevel] || console.info;
    const prefix = normalizedLevel === 'trace' ? '[CB01:trace]' : '[CB01:debug]';
    if (payload && typeof payload === 'object') {
        try {
            logger(`${prefix} ${message} ${JSON.stringify(sanitizeLogValue(payload))}`);
        } catch (_) {
            logger(`${prefix} ${message}`);
        }
    } else {
        logger(`${prefix} ${message}`);
    }
}

function safeHost(value) {
    try { return new URL(String(value || '')).hostname; } catch (_) { return ''; }
}

function safePath(value) {
    try { return new URL(String(value || '')).pathname; } catch (_) { return ''; }
}

function safeUrlForLog(value) {
    try {
        const parsed = new URL(String(value || ''));
        const search = parsed.search ? parsed.search.replace(/(api_password=)[^&]+/gi, '$1***').replace(/((?:api|key|token|pass|password|apikey|api_key)=)[^&]+/gi, '$1***') : '';
        return `${parsed.origin}${parsed.pathname}${search}`;
    } catch (_) {
        return sanitizeLogValue(String(value || ''));
    }
}

function htmlProbe(html = '') {
    const text = String(html || '');
    return {
        bytes: Buffer.byteLength(text, 'utf8'),
        cards: (text.match(/card-content/gi) || []).length,
        iframen1: /id=["']iframen1["']/i.test(text),
        iframen2: /id=["']iframen2["']/i.test(text),
        spoilers: (text.match(/sp-head/gi) || []).length,
        anchors: (text.match(/<a\b/gi) || []).length,
        challenge: isChallengePage(text),
        snippet: isCbTraceEnabled() ? text.replace(/\s+/g, ' ').slice(0, 220) : undefined
    };
}

function responseSummary(response, url = '') {
    const headers = response?.headers || {};
    const text = responseText(response);
    return {
        url: safeUrlForLog(url),
        status: Number(response?.status || 0),
        finalUrl: safeUrlForLog(response?.request?.res?.responseUrl || response?.responseUrl || url || ''),
        contentType: headers['content-type'] || headers['Content-Type'] || '',
        bytes: Buffer.byteLength(String(text || ''), 'utf8'),
        challenge: isChallengePage(text)
    };
}

function logCandidateTable(kind, title, candidates, year = null) {
    if (!isCbDebugEnabled()) return;
    const rows = (Array.isArray(candidates) ? candidates : []).slice(0, isCbTraceEnabled() ? 12 : 6).map((candidate) => {
        let urlYear = extractYear(candidate?.dateText) || extractYear(candidate?.cardHtml);
        try {
            const parts = new URL(candidate?.href || '').pathname.split('/').filter(Boolean);
            urlYear = urlYear || extractYear(parts[parts.length - 1] || '');
        } catch (_) {}
        return {
            title: candidate?.title || '',
            sim: Math.round(similarity(candidate?.title || '', title) * 100),
            year: urlYear || null,
            expectedYear: year || null,
            host: safeHost(candidate?.href),
            path: safePath(candidate?.href)
        };
    });
    cbDebug('info', `${kind} candidates detail`, { queryTitle: title, expectedYear: year || null, rows });
}

function responseData(response) {
    return response?.data ?? response?.body ?? response;
}

function responseText(response) {
    const data = responseData(response);
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data || ''); }
}

function responseJson(response) {
    const data = responseData(response);
    if (data && typeof data === 'object' && !Buffer.isBuffer(data)) return data;
    try { return JSON.parse(responseText(response)); } catch (_) { return null; }
}

function isChallengePage(html = '') {
    const text = String(html || '').slice(0, 200000);
    return /cloudflare|cf-browser-verification|just a moment|challenge-platform|cf-chl|captcha|attention required/i.test(text);
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&#215;|&#x0?d7;/gi, 'x')
        .replace(/&#8211;|&#8212;/g, '-')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTitle(value) {
    return decodeHtml(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function similarity(a, b) {
    const left = normalizeTitle(a);
    const right = normalizeTitle(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.98;
    const leftTokens = new Set(left.split(' ').filter(Boolean));
    const rightTokens = right.split(' ').filter(Boolean);
    if (!leftTokens.size || !rightTokens.length) return 0;
    const matches = rightTokens.filter((token) => leftTokens.has(token)).length;
    return matches / Math.max(leftTokens.size, rightTokens.length);
}

function extractYear(value) {
    const match = String(value || '').match(/(?<!\/)(?:19|20)\d{2}(?!\/)/);
    return match ? Number.parseInt(match[0], 10) : null;
}

function withTimeout(promise, ms, label = 'operation') {
    const timeoutMs = Number.parseInt(String(ms || 0), 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function getMetaTitle(meta = {}) {
    return decodeHtml(meta?.title || meta?.name || meta?.originalTitle || meta?.seriesName || '').trim();
}

function getMetaYear(meta = {}) {
    return Number.parseInt(String(meta?.year || meta?.releaseYear || meta?.released || meta?.firstAirDate || '').slice(0, 4), 10) || null;
}

function getSeasonEpisode(meta = {}) {
    const season = Number.parseInt(String(meta?.season || meta?.s || meta?.seasonNumber || meta?.tmdbSeason || 0), 10);
    const episode = Number.parseInt(String(meta?.episode || meta?.e || meta?.episodeNumber || meta?.tmdbEpisode || 0), 10);
    return { season, episode };
}

function isSeriesMeta(meta = {}) {
    if (meta?.isSeries === true || meta?.type === 'series') return true;
    const { season, episode } = getSeasonEpisode(meta);
    return Boolean(season && episode);
}

const STAYONLINE_URL_RE = /https?:\/\/(?:www\.)?stayonline\.[a-z.]+[^"'<>\s\\]+/i;
const MIXDROP_URL_RE = /https?:\/\/(?:www\.)?(?:mixdrop|m1xdrop|mxcontent|mixdrp)[^"'<>\s\\]+/i;
const MAXSTREAM_URL_RE = /https?:\/\/(?:www\.)?(?:uprot\.net|maxstream\.video|maxstream\.[a-z.]+|stayonline\.[a-z.]+)[^"'<>\s\\]+/i;
const HOSTER_URL_RE = /https?:\/\/(?:www\.)?(?:mixdrop|m1xdrop|mxcontent|mixdrp|uprot\.net|maxstream\.video|maxstream\.[a-z.]+|stayonline\.[a-z.]+)[^"'<>\s\\]+/i;

function isStayonlineUrl(value) {
    return STAYONLINE_URL_RE.test(String(value || ''));
}

function isMixdropUrl(value) {
    return MIXDROP_URL_RE.test(String(value || ''));
}

function isMaxstreamLikeUrl(value) {
    return MAXSTREAM_URL_RE.test(String(value || ''));
}

function normalizeMixdropForExtractor(value) {
    const normalized = normalizeRemoteUrl(value);
    if (!normalized || !isMixdropUrl(normalized)) return null;
    try {
        const parsed = new URL(normalized);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const fileId = parts.length >= 2 && /^(?:e|emb|embed|f|file|watch|video)$/i.test(parts[0])
            ? parts[1]
            : parts.length === 1 ? parts[0] : '';
        if (!fileId) return normalized;
        parsed.pathname = `/e/${fileId}`;
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch (_) {
        return normalized
            .replace('/emb/', '/e/')
            .replace('/embed/', '/e/')
            .replace('/f/', '/e/')
            .replace('/file/', '/e/')
            .replace('/watch/', '/e/')
            .replace('/video/', '/e/');
    }
}

async function resolveStayonline(client, url, options = {}) {
    const cleaned = normalizeRemoteUrl(url);
    if (!cleaned || !isStayonlineUrl(cleaned)) {
        cbDebug('trace', 'stayonline skip: invalid url', { rawHost: safeHost(url), rawPath: safePath(url) });
        return null;
    }

    cbDebug('info', 'stayonline resolve start', { host: safeHost(cleaned), path: safePath(cleaned) });
    const cacheKey = [cleaned];
    const cached = getCbCache('stayonline', cacheKey);
    if (cached) return cached;

    return withCbCoalescing('stayonline', cacheKey, async () => {
        const afterWait = getCbCache('stayonline', cacheKey);
        if (afterWait) return afterWait;
        try {
            const id = cleaned.split('/').filter(Boolean).slice(-1)[0] || '';
            if (!id) return null;
            const endpointHost = (() => {
                try { return new URL(cleaned).host; } catch (_) { return 'stayonline.pro'; }
            })();
            const endpoint = `https://${endpointHost}/ajax/linkEmbedView.php`;
            const body = `id=${encodeURIComponent(id)}&ref=`;
            cbDebug('info', 'stayonline ajax request', { endpoint: safeUrlForLog(endpoint), id: String(id).slice(0, 80), refererHost: safeHost(cleaned) });
            const headers = {
                'User-Agent': DESKTOP_UA,
                'Accept': '*/*',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': `https://${endpointHost}`,
                'Referer': cleaned
            };
            const response = await withTimeout(client.post(endpoint, body, {
                headers,
                timeout: envInt('CB01_STAYONLINE_TIMEOUT_MS', 8000, 1500, 20000),
                maxRedirects: 5,
                validateStatus: () => true,
                responseType: 'text'
            }), envInt('CB01_STAYONLINE_TIMEOUT_MS', 8000, 1500, 20000) + 1500, 'CB01 stayonline');
            const status = Number(response?.status || 0);
            cbDebug('info', 'stayonline ajax response', responseSummary(response, endpoint));
            if (status && (status < 200 || status >= 400)) {
                cbDebug('warn', 'stayonline bad status', { status, host: safeHost(cleaned), endpoint: safeUrlForLog(endpoint) });
                return null;
            }
            const json = responseJson(response);
            cbDebug('trace', 'stayonline ajax json probe', { keys: json && typeof json === 'object' ? Object.keys(json).slice(0, 20) : [], dataKeys: json?.data && typeof json.data === 'object' ? Object.keys(json.data).slice(0, 20) : [] });
            const real = normalizeRemoteUrl(json?.data?.value || json?.data?.url || json?.value || json?.url || '');
            if (real) {
                cbDebug('info', 'stayonline resolved from json', { fromHost: safeHost(cleaned), toHost: safeHost(real), toPath: safePath(real) });
                setCbCache('stayonline', cacheKey, real, CB_CACHE_TTL.stayonline);
                return real;
            }
            const fromText = normalizeRemoteUrl((responseText(response).match(HOSTER_URL_RE) || [])[0] || '');
            if (fromText) {
                cbDebug('info', 'stayonline resolved from html/text', { fromHost: safeHost(cleaned), toHost: safeHost(fromText), toPath: safePath(fromText) });
                setCbCache('stayonline', cacheKey, fromText, CB_CACHE_TTL.stayonline);
                return fromText;
            }
            cbDebug('warn', 'stayonline unresolved: no hoster url in response', { host: safeHost(cleaned), probe: htmlProbe(responseText(response)) });
            return null;
        } catch (error) {
            cbDebug('warn', 'stayonline resolve failed', { error: error?.message || String(error), host: safeHost(cleaned) });
            return null;
        }
    });
}

function buildMfpProxyUrl(config = {}, targetUrl, headers = {}, { isHls = false } = {}) {
    const gateway = createMediaflowGateway(config);
    cbDebug('trace', 'mfp proxy build start', {
        configured: gateway.isConfigured,
        targetHost: safeHost(targetUrl),
        targetPath: safePath(targetUrl),
        isHls,
        headerNames: Object.keys(headers || {})
    });
    const proxied = gateway.buildProxyUrl(targetUrl, headers, {
        isHls,
        allowCookie: envFlag('CB01_PROXY_COOKIE', true)
    });
    cbDebug('trace', 'mfp proxy build end', {
        changed: Boolean(proxied && proxied !== targetUrl),
        proxyHost: safeHost(proxied),
        proxyPath: safePath(proxied)
    });
    return proxied && proxied !== targetUrl ? proxied : null;
}

function isHlsStreamUrl(value) {
    return /\.m3u8(?:$|[?#])/i.test(String(value || ''));
}

function urlOrigin(value, fallback = '') {
    try { return new URL(String(value || '')).origin; } catch (_) { return fallback; }
}

function extractorHeadersFor(targetUrl, kind = '') {
    const origin = urlOrigin(targetUrl);
    const headers = { 'User-Agent': SAFEGO_FIREFOX_UA };
    if (/mix/i.test(kind)) {
        headers.Referer = origin ? `${origin}/` : 'https://mixdrop.vip/';
        headers.Origin = origin || 'https://mixdrop.vip';
        return headers;
    }
    if (/max|uprot/i.test(kind)) {
        const isUprot = /uprot\.net/i.test(String(targetUrl || ''));
        headers.Referer = isUprot ? 'https://uprot.net/' : (origin ? `${origin}/` : 'https://uprot.net/');
        headers.Origin = isUprot ? 'https://uprot.net' : (origin || 'https://uprot.net');
        return headers;
    }
    if (origin) {
        headers.Referer = `${origin}/`;
        headers.Origin = origin;
    }
    return headers;
}

function streamPriority(label) {
    if (/mix/i.test(label)) return 1;
    if (/max/i.test(label)) return 2;
    return 9;
}

function buildDirectExtractorStream({ targetUrl, label, title, headers = null, mediaflowUrl = null, via = 'direct' }) {
    return buildWebStream({
        name: `${ICON} ${PROVIDER} | ${label}`,
        title: `${title}\n☁️ ${label} • 🇮🇹 ITA`,
        url: targetUrl,
        extractor: label,
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers,
        mediaflowUrl,
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                language: 'ITA',
                audioLanguages: ['ita'],
                subtitleLanguages: [],
                via
            }
        },
        extra: { _priority: streamPriority(label) }
    });
}

function buildMfpExtractorStream({ config, targetUrl, host, label, title, via = 'mfp', mediaflowOptions = null, streamKind = 'video' }) {
    if (!getMediaflowBase(config)) return null;
    const mfpUrl = buildMediaflowUrl(config, targetUrl, 'extractor', host, mediaflowOptions || {});
    if (!mfpUrl || mfpUrl === targetUrl) return null;
    cbDebug('info', 'mfp extractor stream built', {
        label,
        host,
        via,
        targetHost: safeHost(targetUrl),
        targetPath: safePath(targetUrl),
        mfpPath: safePath(mfpUrl),
        redirectStream: /[?&]redirect_stream=true(?:&|$)/i.test(mfpUrl),
        streamKind
    });
    return buildWebStream({
        name: `${ICON} ${PROVIDER} | ${label}`,
        title: `${title}\n☁️ ${label} • 🇮🇹 ITA`,
        url: mfpUrl,
        extractor: label,
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers: null,
        mediaflowUrl: getMediaflowBase(config),
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: {
                language: 'ITA',
                audioLanguages: ['ita'],
                subtitleLanguages: [],
                via,
                streamKind
            }
        },
        extra: { _priority: streamPriority(label) }
    });
}

async function buildMixdropStream(rawUrl, context) {
    const { client, config, title } = context;
    let targetUrl = normalizeRemoteUrl(rawUrl);
    cbDebug('info', 'mixdrop build start', {
        rawHost: safeHost(rawUrl),
        rawPath: safePath(rawUrl),
        normalizedHost: safeHost(targetUrl),
        hasMfp: Boolean(getMediaflowBase(config))
    });
    if (targetUrl && isStayonlineUrl(targetUrl)) {
        const beforeStayonline = targetUrl;
        const resolved = await resolveStayonline(client, targetUrl, context.options);
        if (resolved) targetUrl = resolved;
        cbDebug(resolved ? 'info' : 'warn', 'mixdrop stayonline resolution result', {
            fromHost: safeHost(beforeStayonline),
            resolved: Boolean(resolved),
            toHost: safeHost(targetUrl),
            toPath: safePath(targetUrl)
        });
    }
    if (!targetUrl || !isMixdropUrl(targetUrl)) {
        cbDebug('warn', 'mixdrop build skipped: target is not MixDrop', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl) });
        return null;
    }
    const normalized = normalizeMixdropForExtractor(targetUrl);
    if (!normalized) {
        cbDebug('warn', 'mixdrop build skipped: normalization failed', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl) });
        return null;
    }
    cbDebug('info', 'mixdrop normalized', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl), normalizedPath: safePath(normalized) });

    if (getMediaflowBase(config) && envFlag('CB01_MIXDROP_LOCAL_PROXY_FIRST', true)) {
        try {
            const extracted = await withTimeout(
                extractMixdrop(normalized, { client, userAgent: SAFEGO_FIREFOX_UA }),
                envInt('CB01_MIXDROP_LOCAL_TIMEOUT_MS', 3500, 800, 8000),
                'CB01 MixDrop local'
            );
            if (extracted?.url) {
                cbDebug('info', 'mixdrop local extractor success', {
                    sourceHost: safeHost(extracted.url),
                    sourcePath: safePath(extracted.url),
                    hasHeaders: Boolean(extracted.headers),
                    headerNames: Object.keys(extracted.headers || {})
                });
                const isHls = isHlsStreamUrl(extracted.url);
                const proxied = buildMfpProxyUrl(config, extracted.url, extracted.headers || extractorHeadersFor(normalized, 'mixdrop'), { isHls });
                if (proxied && proxied !== extracted.url) {
                    cbDebug('info', 'mixdrop source proxied via MFP/Kraken', {
                        sourceHost: safeHost(extracted.url),
                        sourcePath: safePath(extracted.url),
                        proxyPath: safePath(proxied),
                        isHls,
                        hasHeaders: Boolean(extracted.headers)
                    });
                    return buildDirectExtractorStream({
                        targetUrl: proxied,
                        label: 'MixDrop',
                        title,
                        headers: null,
                        mediaflowUrl: getMediaflowBase(config),
                        via: isHls ? 'mixdrop-local-mfp-hls' : 'mixdrop-local-mfp-stream'
                    });
                }
                cbDebug('warn', 'mixdrop local extractor returned source but MFP proxy did not change URL', { sourceHost: safeHost(extracted.url), sourcePath: safePath(extracted.url) });
            } else {
                cbDebug('warn', 'mixdrop local extractor returned no url', { normalizedHost: safeHost(normalized), normalizedPath: safePath(normalized) });
            }
        } catch (error) {
            cbDebug('warn', 'mixdrop local proxy failed; using MFP extractor fallback', { error: error?.message || String(error), targetHost: safeHost(normalized), targetPath: safePath(normalized) });
        }
    }

    if (!getMediaflowBase(config)) {
        cbDebug('warn', 'mixdrop stream skipped: MediaFlow Proxy not configured', { targetHost: safeHost(normalized) });
        return null;
    }

    cbDebug('info', 'mixdrop using MFP extractor fallback', { targetHost: safeHost(normalized), targetPath: safePath(normalized), redirectStream: envFlag('CB01_MIXDROP_REDIRECT_STREAM', true) });
    return buildMfpExtractorStream({
        config,
        targetUrl: normalized,
        host: 'Mixdrop',
        label: 'MixDrop',
        title,
        via: 'mixdrop-mfp',
        mediaflowOptions: {
            redirectStream: envFlag('CB01_MIXDROP_REDIRECT_STREAM', true),
            headers: extractorHeadersFor(normalized, 'mixdrop')
        },
        streamKind: 'video'
    });
}

async function buildMaxstreamStream(rawUrl, context) {
    const { client, config, title, options } = context;
    let targetUrl = normalizeRemoteUrl(rawUrl);
    cbDebug('info', 'maxstream build start', {
        rawHost: safeHost(rawUrl),
        rawPath: safePath(rawUrl),
        normalizedHost: safeHost(targetUrl),
        hasMfp: Boolean(getMediaflowBase(config))
    });
    if (targetUrl && isStayonlineUrl(targetUrl)) {
        const beforeStayonline = targetUrl;
        const resolved = await resolveStayonline(client, targetUrl, options);
        if (resolved) targetUrl = resolved;
        cbDebug(resolved ? 'info' : 'warn', 'maxstream stayonline resolution result', {
            fromHost: safeHost(beforeStayonline),
            resolved: Boolean(resolved),
            toHost: safeHost(targetUrl),
            toPath: safePath(targetUrl)
        });
    }
    if (!targetUrl) {
        cbDebug('warn', 'maxstream build skipped: empty target after normalization/resolution', { rawHost: safeHost(rawUrl), rawPath: safePath(rawUrl) });
        return null;
    }

    const originalUprotUrl = isUprotUrl(targetUrl) ? targetUrl : null;
    if (originalUprotUrl) {
        cbDebug('info', 'uprot local resolve start', { host: safeHost(originalUprotUrl), path: safePath(originalUprotUrl) });
        const resolved = await withCbCoalescing('uprotLocal', [originalUprotUrl], () =>
            resolveUprotToMaxstream(client, targetUrl, options || {})
        );
        cbDebug(resolved?.playerUrl ? 'info' : 'warn', 'uprot local resolve result', {
            ok: Boolean(resolved?.playerUrl),
            playerHost: safeHost(resolved?.playerUrl),
            playerPath: safePath(resolved?.playerUrl),
            keys: resolved && typeof resolved === 'object' ? Object.keys(resolved).slice(0, 20) : []
        });
        targetUrl = resolved?.playerUrl || null;
        if (!targetUrl && getMediaflowBase(config)) {
            cbDebug('warn', 'uprot local resolve failed; using MFP fallback', { hrefHost: safeHost(originalUprotUrl) });
            return buildMfpExtractorStream({
                config,
                targetUrl: originalUprotUrl,
                host: 'Maxstream',
                label: 'MaxStream',
                title,
                via: 'uprot-fallback',
                mediaflowOptions: {
                    extractorPath: '/extractor/video.m3u8',
                    redirectStream: true,
                    headers: extractorHeadersFor(originalUprotUrl, 'uprot')
                },
                streamKind: 'hls'
            });
        }
    }

    if (!targetUrl || !isMaxstreamLikeUrl(targetUrl)) {
        cbDebug('warn', 'maxstream build skipped: target is not MaxStream-like', { targetHost: safeHost(targetUrl), targetPath: safePath(targetUrl) });
        return null;
    }

    if (!getMediaflowBase(config)) {
        cbDebug('warn', 'maxstream stream skipped: MediaFlow Proxy not configured', { targetHost: safeHost(targetUrl) });
        return null;
    }

    cbDebug('info', 'maxstream using MFP extractor', {
        targetHost: safeHost(targetUrl),
        targetPath: safePath(targetUrl),
        via: originalUprotUrl ? 'uprot-local' : 'maxstream',
        extractorPath: '/extractor/video.m3u8',
        redirectStream: true
    });
    return buildMfpExtractorStream({
        config,
        targetUrl,
        host: 'Maxstream',
        label: 'MaxStream',
        title,
        via: originalUprotUrl ? 'uprot-local' : 'maxstream',
        mediaflowOptions: {
            extractorPath: '/extractor/video.m3u8',
            redirectStream: true,
            headers: extractorHeadersFor(targetUrl, 'maxstream')
        },
        streamKind: 'hls'
    });
}

function extractCardCandidates(html, baseUrl = null) {
    const candidates = [];
    const cardRe = /<div\b[^>]*class=["'][^"']*card-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
    for (const cardMatch of String(html || '').matchAll(cardRe)) {
        const cardHtml = cardMatch?.[1] || '';
        const titleRe = /<h3\b[^>]*class=["'][^"']*card-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i;
        const titleBlock = cardHtml.match(titleRe)?.[1] || '';
        const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
        const linkMatch = titleBlock.match(linkRe);
        if (!linkMatch) continue;
        const href = normalizeRemoteUrl(linkMatch?.[1] || '', baseUrl);
        const title = decodeHtml(linkMatch?.[2] || '');
        const dateSpanMatch = cardHtml.match(/<span\b[^>]*style=["'][^"']*color[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        const dateText = decodeHtml(dateSpanMatch?.[1] || '');
        candidates.push({ href, title, dateText, cardHtml });
    }
    return candidates;
}

async function fetchSearchHtml(client, url, baseUrl) {
    cbDebug('info', 'search html request', { url: safeUrlForLog(url), baseUrl });
    const response = await withTimeout(client.get(url, {
        headers: {
            'User-Agent': DESKTOP_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5',
            'Referer': `${baseUrl}/`
        },
        timeout: envInt('CB01_SEARCH_TIMEOUT_MS', 12000, 1500, 30000),
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'text'
    }), envInt('CB01_SEARCH_TIMEOUT_MS', 12000, 1500, 30000) + 1500, 'CB01 search');
    const status = Number(response?.status || 0);
    const text = responseText(response);
    cbDebug('info', 'search html response', { ...responseSummary(response, url), probe: htmlProbe(text) });
    if (status && (status < 200 || status >= 400)) {
        cbDebug('warn', 'search bad status', { status, url: safeUrlForLog(url), baseUrl, probe: htmlProbe(text) });
        return '';
    }
    if (isChallengePage(text)) {
        cbDebug('warn', 'search challenge detected', { url: safeUrlForLog(url), baseUrl, probe: htmlProbe(text) });
        return '';
    }
    if (!text || !/card-content/i.test(text)) {
        cbDebug('warn', 'search html has no card-content markers', { url: safeUrlForLog(url), baseUrl, probe: htmlProbe(text) });
    }
    return text;
}

async function fetchPageHtml(client, url, baseUrl, namespace = 'page') {
    cbDebug('info', 'page html request', { namespace, url: safeUrlForLog(url), baseUrl });
    const cacheKey = [url];
    const cached = getCbCache(namespace, cacheKey);
    if (cached) return cached;
    return withCbCoalescing(namespace, cacheKey, async () => {
        const afterWait = getCbCache(namespace, cacheKey);
        if (afterWait) return afterWait;
        const response = await withTimeout(client.get(url, {
            headers: {
                'User-Agent': DESKTOP_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5',
                'Referer': `${baseUrl}/`
            },
            timeout: envInt('CB01_PAGE_TIMEOUT_MS', 14000, 1500, 30000),
            maxRedirects: 5,
            validateStatus: () => true,
            responseType: 'text'
        }), envInt('CB01_PAGE_TIMEOUT_MS', 14000, 1500, 30000) + 1500, 'CB01 page');
        const status = Number(response?.status || 0);
        const text = responseText(response);
        cbDebug('info', 'page html response', { namespace, ...responseSummary(response, url), probe: htmlProbe(text) });
        if (status && (status < 200 || status >= 400)) {
            cbDebug('warn', 'page bad status', { status, url: safeUrlForLog(url), namespace, probe: htmlProbe(text) });
            return '';
        }
        if (isChallengePage(text)) {
            cbDebug('warn', 'page challenge detected', { url: safeUrlForLog(url), baseUrl, namespace, probe: htmlProbe(text) });
            return '';
        }
        if (!text) {
            cbDebug('warn', 'page response empty', { url: safeUrlForLog(url), namespace });
        }
        if (text) setCbCache(namespace, cacheKey, text, CB_CACHE_TTL[namespace] || CB_CACHE_TTL.moviePage);
        return text;
    });
}

function buildSearchQuery(title) {
    const normalized = decodeHtml(title)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
    return new URLSearchParams({ s: normalized }).toString();
}

async function searchMovieUrl(client, baseUrl, title, year) {
    if (!title) return null;
    const cacheKey = [baseUrl, normalizeTitle(title), year || 0];
    const cached = getCbCache('movieSearch', cacheKey);
    if (cached) return cached;
    return withCbCoalescing('movieSearch', cacheKey, async () => {
        const afterWait = getCbCache('movieSearch', cacheKey);
        if (afterWait) return afterWait;
        const query = buildSearchQuery(title);
        const url = `${baseUrl}/?${query}`;
        cbDebug('info', 'movie search start', { title, normalizedTitle: normalizeTitle(title), year: year || null, query, url: safeUrlForLog(url) });
        const html = await fetchSearchHtml(client, url, baseUrl);
        if (!html) {
            cbDebug('warn', 'movie search failed: empty html', { title, year: year || null, url: safeUrlForLog(url) });
            return null;
        }
        const candidates = extractCardCandidates(html, baseUrl);
        cbDebug('info', 'movie search candidates', { title, year, count: candidates.length });
        logCandidateTable('movie search', title, candidates, year);
        let best = null;
        let bestScore = 0;
        for (const candidate of candidates) {
            if (!candidate.href) continue;
            let urlYear = null;
            try {
                const parts = new URL(candidate.href).pathname.split('/').filter(Boolean);
                const slug = parts[parts.length - 1] || '';
                urlYear = extractYear(slug);
            } catch (_) {}
            if (year && urlYear && Number(urlYear) === Number(year)) {
                const score = similarity(candidate.title, title) * 100 + 50;
                if (score > bestScore) { best = candidate; bestScore = score; }
                continue;
            }
            if (!year) {
                const score = similarity(candidate.title, title) * 100;
                if (score > bestScore && score >= 55) { best = candidate; bestScore = score; }
            }
        }
        if (best?.href) {
            cbDebug('info', 'movie search selected', {
                title,
                year: year || null,
                selectedTitle: best.title,
                score: Math.round(bestScore),
                host: safeHost(best.href),
                path: safePath(best.href)
            });
            setCbCache('movieSearch', cacheKey, best.href, CB_CACHE_TTL.movieSearch);
            return best.href;
        }
        cbDebug('warn', 'movie search no suitable candidate', { title, year: year || null, candidates: candidates.length, bestScore: Math.round(bestScore) });
        return null;
    });
}

async function searchSeriesUrl(client, baseUrl, title, year) {
    if (!title) return null;
    const cacheKey = [baseUrl, normalizeTitle(title), year || 0];
    const cached = getCbCache('seriesSearch', cacheKey);
    if (cached) return cached;
    return withCbCoalescing('seriesSearch', cacheKey, async () => {
        const afterWait = getCbCache('seriesSearch', cacheKey);
        if (afterWait) return afterWait;
        const query = buildSearchQuery(title);
        const url = `${baseUrl}/serietv/?${query}`;
        cbDebug('info', 'series search start', { title, normalizedTitle: normalizeTitle(title), year: year || null, query, url: safeUrlForLog(url) });
        const html = await fetchSearchHtml(client, url, baseUrl);
        if (!html) {
            cbDebug('warn', 'series search failed: empty html', { title, year: year || null, url: safeUrlForLog(url) });
            return null;
        }
        const candidates = extractCardCandidates(html, baseUrl);
        cbDebug('info', 'series search candidates', { title, year, count: candidates.length });
        logCandidateTable('series search', title, candidates, year);
        let best = null;
        let bestScore = 0;
        for (const candidate of candidates) {
            if (!candidate.href) continue;
            const candidateYear = extractYear(candidate.dateText) || extractYear(candidate.cardHtml);
            const sim = similarity(candidate.title, title) * 100;
            let score = sim;
            if (year && candidateYear) {
                const diff = Math.abs(Number(candidateYear) - Number(year));
                if (diff === 0) score += 60;
                else if (diff <= 1) score += 30;
                else continue;
            }
            if (score > bestScore && score >= 55) {
                best = candidate;
                bestScore = score;
            }
        }
        if (best?.href) {
            cbDebug('info', 'series search selected', {
                title,
                year: year || null,
                selectedTitle: best.title,
                score: Math.round(bestScore),
                host: safeHost(best.href),
                path: safePath(best.href)
            });
            setCbCache('seriesSearch', cacheKey, best.href, CB_CACHE_TTL.seriesSearch);
            return best.href;
        }
        cbDebug('warn', 'series search no suitable candidate', { title, year: year || null, candidates: candidates.length, bestScore: Math.round(bestScore) });
        return null;
    });
}

async function extractMovieEmbedLinks(client, pageUrl, baseUrl) {
    const html = await fetchPageHtml(client, pageUrl, baseUrl, 'moviePage');
    if (!html) {
        cbDebug('warn', 'movie page empty while extracting embeds', { pageUrl: safeUrlForLog(pageUrl), baseUrl });
        return null;
    }
    const iframen2 = html.match(/<div\b[^>]*id=["']iframen2["'][^>]*data-src=["']([^"']+)["'][^>]*>/i)?.[1];
    const iframen1 = html.match(/<div\b[^>]*id=["']iframen1["'][^>]*data-src=["']([^"']+)["'][^>]*>/i)?.[1];
    const links = {
        mixdropLink: normalizeRemoteUrl(iframen2 || '', baseUrl),
        maxstreamLink: normalizeRemoteUrl(iframen1 || '', baseUrl)
    };
    cbDebug((links.mixdropLink || links.maxstreamLink) ? 'info' : 'warn', 'movie embed extraction result', {
        pageHost: safeHost(pageUrl),
        pagePath: safePath(pageUrl),
        hasIframen2: Boolean(iframen2),
        hasIframen1: Boolean(iframen1),
        mixdropHost: safeHost(links.mixdropLink),
        mixdropPath: safePath(links.mixdropLink),
        maxstreamHost: safeHost(links.maxstreamLink),
        maxstreamPath: safePath(links.maxstreamLink),
        probe: htmlProbe(html)
    });
    return links;
}

function decodeSeasonAliasText(text) {
    return decodeHtml(text)
        .replace(/STAGIONE/gi, '')
        .replace(/ITA/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseSeasonRange(headerText) {
    const decoded = decodeHtml(headerText);
    const match = /STAGIONE\s*(\d{1,2})\s*A\s*(\d{1,2})/i.exec(decoded);
    if (!match) return null;
    const from = Number.parseInt(match[1], 10);
    const to = Number.parseInt(match[2], 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
}

function extractSpoilerSections(html) {
    const sections = [];
    const headerRe = /<div\b[^>]*class=["'][^"']*sp-head[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
    const sources = String(html || '');
    let lastIndex = 0;
    const headers = [];
    for (const headerMatch of sources.matchAll(headerRe)) {
        headers.push({
            text: headerMatch?.[1] || '',
            startIndex: headerMatch.index ?? 0,
            endIndex: (headerMatch.index ?? 0) + (headerMatch?.[0]?.length || 0)
        });
    }
    for (let i = 0; i < headers.length; i += 1) {
        const header = headers[i];
        const nextStart = i + 1 < headers.length ? headers[i + 1].startIndex : sources.length;
        const blockHtml = sources.slice(header.endIndex, nextStart);
        sections.push({ headerText: header.text, blockHtml });
        lastIndex = nextStart;
    }
    if (!sections.length && sources.length) sections.push({ headerText: '', blockHtml: sources });
    return sections;
}

function findStandardEpisodeLinks(blockHtml, season, episode, baseUrl = null) {
    const safeSeason = Math.max(1, Number.parseInt(String(season || 1), 10) || 1);
    const safeEpisode = Math.max(1, Number.parseInt(String(episode || 1), 10) || 1);
    const seasonVariants = [...new Set([String(safeSeason), String(safeSeason).padStart(2, '0')])];
    const episodeVariants = [...new Set([String(safeEpisode), String(safeEpisode).padStart(2, '0')])];
    const sx = seasonVariants.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const ex = episodeVariants.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const separator = '(?:&#215;|&#x0?d7;|\\u00d7|×|x)';
    const html = String(blockHtml || '');
    const patterns = [
        `(?:^|>|\\b)(?:${sx})\\s*${separator}\\s*(?:${ex})[\\s\\S]{0,1000}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`,
        `(?:^|>|\\b)s\\s*0*${safeSeason}\\s*[-_. ]*e\\s*0*${safeEpisode}[\\s\\S]{0,1000}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`,
        `(?:^|>|\\b)stagione\\s*0*${safeSeason}\\D{0,20}episodio\\s*0*${safeEpisode}[\\s\\S]{0,1000}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`,
        `(?:^|>|\\b)ep(?:isodio)?\\.?\\s*0*${safeEpisode}\\b[\\s\\S]{0,1000}?(?=<br|<\\/p>|<\\/li>|<\\/tr>|<\\/div>|$)`
    ];

    for (const source of patterns) {
        const match = html.match(new RegExp(source, 'i'));
        if (!match) continue;
        const anchors = collectAnchors(match[0], baseUrl);
        cbDebug(anchors.length ? 'info' : 'warn', 'series episode pattern matched', {
            season: safeSeason,
            episode: safeEpisode,
            anchors: anchors.length,
            pattern: source.slice(0, 120),
            labels: anchors.slice(0, 8).map((anchor) => anchor.label),
            hosts: anchors.slice(0, 8).map((anchor) => safeHost(anchor.href))
        });
        if (anchors.length) return anchors;
    }

    cbDebug('warn', 'series episode pattern not found in standard section', {
        season: safeSeason,
        episode: safeEpisode,
        blockProbe: htmlProbe(html)
    });
    return [];
}

function collectAnchors(html, baseUrl = null) {
    const anchors = [];
    const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig;
    for (const match of String(html || '').matchAll(re)) {
        const href = normalizeRemoteUrl(match?.[1] || '', baseUrl);
        const label = decodeHtml(match?.[2] || '');
        if (!href) continue;
        anchors.push({ href, label });
    }
    return anchors;
}

function pickEpisodeHostLinks(anchors) {
    if (!Array.isArray(anchors) || !anchors.length) return { mixdropLink: null, maxstreamLink: null };
    let mixdropLink = null;
    let maxstreamLink = null;
    for (const anchor of anchors) {
        const href = anchor?.href || '';
        const label = (anchor?.label || '').toLowerCase();
        if (!href) continue;
        if (!mixdropLink && (/mix\s*drop/i.test(label) || isMixdropUrl(href))) {
            mixdropLink = href;
            continue;
        }
        if (!maxstreamLink && (/max\s*stream/i.test(label) || isStayonlineUrl(href) || isUprotUrl(href) || isMaxstreamLikeUrl(href))) {
            maxstreamLink = href;
            continue;
        }
    }
    if (!mixdropLink && !maxstreamLink && anchors.length) {
        if (anchors.length >= 2) {
            maxstreamLink = anchors[0]?.href || null;
            mixdropLink = anchors[1]?.href || null;
        } else {
            maxstreamLink = anchors[0]?.href || null;
        }
        cbDebug('warn', 'series host links guessed by anchor order', {
            anchors: anchors.length,
            labels: anchors.slice(0, 8).map((anchor) => anchor.label),
            hosts: anchors.slice(0, 8).map((anchor) => safeHost(anchor.href))
        });
    }
    cbDebug((mixdropLink || maxstreamLink) ? 'info' : 'warn', 'series host link pick result', {
        anchors: anchors.length,
        mixdropHost: safeHost(mixdropLink),
        mixdropPath: safePath(mixdropLink),
        maxstreamHost: safeHost(maxstreamLink),
        maxstreamPath: safePath(maxstreamLink)
    });
    return { mixdropLink, maxstreamLink };
}

async function resolveAliasSeasonEpisode(client, baseUrl, alias, seasonAliasHeaderText, season, episode) {
    if (!alias?.href) {
        cbDebug('warn', 'series alias skipped: missing href', { season, episode, seasonAliasHeaderText });
        return null;
    }
    cbDebug('info', 'series alias resolve start', {
        season,
        episode,
        aliasHeader: decodeHtml(seasonAliasHeaderText),
        aliasHost: safeHost(alias.href),
        aliasPath: safePath(alias.href),
        label: alias.label || ''
    });
    const cacheKey = [alias.href, season, episode];
    const cached = getCbCache('seasonAlias', cacheKey);
    if (cached) return cached;
    return withCbCoalescing('seasonAlias', cacheKey, async () => {
        const afterWait = getCbCache('seasonAlias', cacheKey);
        if (afterWait) return afterWait;
        const html = await fetchPageHtml(client, alias.href, baseUrl, 'seriesPage');
        if (!html) return null;
        const safeSeason = Math.max(1, Number.parseInt(String(season || 1), 10) || 1);
        const safeEpisode = Math.max(1, Number.parseInt(String(episode || 1), 10) || 1);
        const seasonVariants = [...new Set([String(safeSeason), String(safeSeason).padStart(2, '0')])];
        const episodeVariants = [...new Set([String(safeEpisode), String(safeEpisode).padStart(2, '0')])];
        const pairs = [];
        for (const sValue of seasonVariants) {
            for (const eValue of episodeVariants) {
                pairs.push(`S${sValue}E${eValue}`, `${sValue}x${eValue}`, `${sValue}×${eValue}`, `${sValue}&#215;${eValue}`, `${sValue}&#xD7;${eValue}`);
            }
        }
        const escapedPairs = pairs.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const re = new RegExp(`(?:${escapedPairs})[\\s\\S]{0,1200}?href=['"]([^'"]+)['"]`, 'i');
        cbDebug('trace', 'series alias regex probe', { pairs: pairs.slice(0, 16), htmlProbe: htmlProbe(html) });
        const match = html.match(re);
        if (!match) {
            cbDebug('warn', 'series alias episode link not found', { season, episode, aliasHost: safeHost(alias.href), aliasPath: safePath(alias.href), pairs: pairs.slice(0, 16), probe: htmlProbe(html) });
            return null;
        }
        const out = { maxstreamLink: normalizeRemoteUrl(match[1] || '', baseUrl) };
        cbDebug(out.maxstreamLink ? 'info' : 'warn', 'series alias episode resolved', {
            season,
            episode,
            maxstreamHost: safeHost(out.maxstreamLink),
            maxstreamPath: safePath(out.maxstreamLink)
        });
        setCbCache('seasonAlias', cacheKey, out, CB_CACHE_TTL.seasonAlias);
        return out;
    });
}

async function extractSeriesEpisodeLinks(client, pageUrl, baseUrl, season, episode) {
    const html = await fetchPageHtml(client, pageUrl, baseUrl, 'seriesPage');
    if (!html) return null;
    const sections = extractSpoilerSections(html);
    cbDebug('info', 'series sections', {
        sections: sections.length,
        season,
        episode,
        pageHost: safeHost(pageUrl),
        pagePath: safePath(pageUrl),
        headers: sections.slice(0, 12).map((section) => decodeHtml(section.headerText).slice(0, 120))
    });

    let standardSection = null;
    let aliasAnchor = null;
    let aliasHeaderText = '';
    for (const section of sections) {
        const headerText = decodeHtml(section.headerText);
        if (!headerText) continue;
        if (!/STAGIONE/i.test(headerText)) continue;
        const decoded = decodeSeasonAliasText(headerText);
        if (decoded.includes('A') && /\d+\s*A\s*\d+/i.test(headerText)) {
            const range = parseSeasonRange(headerText);
            if (range && season >= range.from && season <= range.to) {
                const anchors = collectAnchors(section.blockHtml, baseUrl);
                if (anchors.length) {
                    aliasAnchor = anchors[0];
                    aliasHeaderText = headerText;
                    cbDebug('info', 'season range alias matched', { season, range, anchor: safeHost(aliasAnchor?.href) });
                }
            }
            continue;
        }
        const headerSeason = Number.parseInt(decoded.replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(headerSeason) && headerSeason === Number(season)) {
            standardSection = section;
            cbDebug('info', 'series standard season section matched', { season, headerText, blockProbe: htmlProbe(section.blockHtml) });
            break;
        }
    }

    if (!standardSection) {
        cbDebug('warn', 'series standard season section not found', {
            season,
            episode,
            availableHeaders: sections.slice(0, 20).map((section) => decodeHtml(section.headerText).slice(0, 120)),
            aliasCandidate: Boolean(aliasAnchor),
            aliasHost: safeHost(aliasAnchor?.href)
        });
    }

    if (standardSection) {
        const anchors = findStandardEpisodeLinks(standardSection.blockHtml, season, episode, baseUrl);
        if (anchors.length) {
            const picked = pickEpisodeHostLinks(anchors);
            cbDebug('info', 'series standard match', {
                season,
                episode,
                anchors: anchors.length,
                mixdrop: safeHost(picked.mixdropLink),
                maxstream: safeHost(picked.maxstreamLink)
            });
            return picked;
        }
    }

    if (aliasAnchor) {
        const aliasResult = await resolveAliasSeasonEpisode(client, baseUrl, aliasAnchor, aliasHeaderText, season, episode);
        if (aliasResult?.maxstreamLink) {
            cbDebug('info', 'series alias resolved', { season, episode, maxstream: safeHost(aliasResult.maxstreamLink), maxstreamPath: safePath(aliasResult.maxstreamLink) });
            return { mixdropLink: null, maxstreamLink: aliasResult.maxstreamLink };
        }
        cbDebug('warn', 'series alias resolve failed', { season, episode, aliasHost: safeHost(aliasAnchor?.href), aliasPath: safePath(aliasAnchor?.href) });
    }

    cbDebug('warn', 'series episode links extraction failed', { season, episode, pageUrl: safeUrlForLog(pageUrl) });
    return null;
}

async function buildStreamsFromLinks({ mixdropLink, maxstreamLink } = {}, context) {
    const streams = [];
    const seen = new Set();

    cbDebug('info', 'build streams from links start', {
        title: context?.title || '',
        hasMixdrop: Boolean(mixdropLink),
        mixdropHost: safeHost(mixdropLink),
        mixdropPath: safePath(mixdropLink),
        hasMaxstream: Boolean(maxstreamLink),
        maxstreamHost: safeHost(maxstreamLink),
        maxstreamPath: safePath(maxstreamLink),
        hasMfp: Boolean(getMediaflowBase(context?.config || {}))
    });

    const tasks = [];

    if (mixdropLink) {
        tasks.push((async () => {
            try {
                const timeoutMs = envInt('CB01_MIXDROP_HOST_TIMEOUT_MS', 6000, 1000, 20000);
                const stream = await withTimeout(buildMixdropStream(mixdropLink, context), timeoutMs, 'CB01 MixDrop host');
                if (stream?.url && !seen.has(stream.url)) {
                    seen.add(stream.url);
                    streams.push(stream);
                    cbDebug('info', 'mixdrop stream accepted', { streamHost: safeHost(stream.url), streamPath: safePath(stream.url), name: stream.name, via: stream?.behaviorHints?.vortexMeta?.via || stream?.extraBehaviorHints?.vortexMeta?.via });
                } else {
                    cbDebug('warn', 'mixdrop stream empty or duplicate', { hasStream: Boolean(stream?.url), duplicate: Boolean(stream?.url && seen.has(stream.url)) });
                }
            } catch (error) {
                cbDebug('warn', 'mixdrop stream failed', { error: error?.message || String(error) });
            }
        })());
    }

    if (maxstreamLink) {
        tasks.push((async () => {
            try {
                const timeoutMs = envInt('CB01_MAXSTREAM_HOST_TIMEOUT_MS', 6000, 1000, 20000);
                const stream = await withTimeout(buildMaxstreamStream(maxstreamLink, context), timeoutMs, 'CB01 MaxStream host');
                if (stream?.url && !seen.has(stream.url)) {
                    seen.add(stream.url);
                    streams.push(stream);
                    cbDebug('info', 'maxstream stream accepted', { streamHost: safeHost(stream.url), streamPath: safePath(stream.url), name: stream.name, via: stream?.behaviorHints?.vortexMeta?.via || stream?.extraBehaviorHints?.vortexMeta?.via });
                } else {
                    cbDebug('warn', 'maxstream stream empty or duplicate', { hasStream: Boolean(stream?.url), duplicate: Boolean(stream?.url && seen.has(stream.url)) });
                }
            } catch (error) {
                cbDebug('warn', 'maxstream stream failed', { error: error?.message || String(error) });
            }
        })());
    }

    if (tasks.length) await Promise.allSettled(tasks);
    const sorted = streams.sort((a, b) => (a?._priority ?? 9) - (b?._priority ?? 9));
    cbDebug(sorted.length ? 'info' : 'warn', 'build streams from links done', {
        title: context?.title || '',
        streams: sorted.length,
        names: sorted.map((stream) => stream.name).slice(0, 8),
        urls: sorted.map((stream) => ({ host: safeHost(stream.url), path: safePath(stream.url) })).slice(0, 8)
    });
    return sorted;
}

async function searchCb01(meta = {}, config = {}, reqHost = null, options = {}) {
    if (config?.filters?.enableCb01 !== true) {
        cbDebug('trace', 'provider disabled by config', { enableCb01: config?.filters?.enableCb01 });
        return [];
    }

    const title = getMetaTitle(meta);
    if (!title) {
        cbDebug('warn', 'search aborted: missing title', { metaKeys: Object.keys(meta || {}).slice(0, 30) });
        return [];
    }

    const client = options.client || getDefaultClient();
    if (!client || typeof client.get !== 'function') {
        cbDebug('warn', 'search aborted: missing http client');
        return [];
    }

    const year = getMetaYear(meta);
    const isSeries = isSeriesMeta(meta);
    const { season, episode } = getSeasonEpisode(meta);
    if (isSeries && (!season || !episode)) {
        cbDebug('warn', 'search aborted: series missing season/episode', { title, season, episode, metaSeason: meta?.season, metaEpisode: meta?.episode });
        return [];
    }

    const bases = getBaseUrls();
    cbDebug('info', 'search start', {
        title,
        normalizedTitle: normalizeTitle(title),
        year: year || null,
        isSeries,
        season: season || null,
        episode: episode || null,
        bases,
        hasMfp: Boolean(getMediaflowBase(config)),
        mfpBase: getMediaflowBase(config) ? safeHost(getMediaflowBase(config)) : '',
        reqHost: reqHost || '',
        cb01Debug: isCbDebugEnabled(),
        cb01Trace: isCbTraceEnabled()
    });

    const failureTrail = [];
    for (const baseUrl of bases) {
        const baseStartedAt = Date.now();
        cbDebug('info', 'base attempt start', { baseUrl, isSeries, title, season: season || null, episode: episode || null });
        try {
            if (isSeries) {
                const pageUrl = await searchSeriesUrl(client, baseUrl, title, year);
                if (!pageUrl) {
                    failureTrail.push({ baseUrl, stage: 'series_page_not_found', elapsedMs: Date.now() - baseStartedAt });
                    cbDebug('warn', 'series page not found', { title, year, baseUrl });
                    continue;
                }
                const links = await extractSeriesEpisodeLinks(client, pageUrl, baseUrl, season, episode);
                if (!links) {
                    failureTrail.push({ baseUrl, stage: 'series_episode_links_not_found', pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), elapsedMs: Date.now() - baseStartedAt });
                    cbDebug('warn', 'series episode links not found', { title, season, episode, pageUrl: safeUrlForLog(pageUrl) });
                    continue;
                }
                const displayTitle = `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                const streams = await buildStreamsFromLinks(links, {
                    client,
                    config,
                    title: displayTitle,
                    reqHost,
                    options: { ...options, baseUrl }
                });
                if (streams.length) {
                    cbDebug('info', 'base attempt success', { baseUrl, kind: 'series', streams: streams.length, elapsedMs: Date.now() - baseStartedAt });
                    return streams;
                }
                failureTrail.push({ baseUrl, stage: 'series_streams_empty', pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), elapsedMs: Date.now() - baseStartedAt });
            } else {
                const pageUrl = await searchMovieUrl(client, baseUrl, title, year);
                if (!pageUrl) {
                    failureTrail.push({ baseUrl, stage: 'movie_page_not_found', elapsedMs: Date.now() - baseStartedAt });
                    cbDebug('warn', 'movie page not found', { title, year, baseUrl });
                    continue;
                }
                const links = await extractMovieEmbedLinks(client, pageUrl, baseUrl);
                if (!links || (!links.mixdropLink && !links.maxstreamLink)) {
                    failureTrail.push({ baseUrl, stage: 'movie_embed_links_not_found', pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), elapsedMs: Date.now() - baseStartedAt });
                    cbDebug('warn', 'movie embed links not found', { title, year, pageUrl: safeUrlForLog(pageUrl) });
                    continue;
                }
                const displayTitle = year ? `${title} (${year})` : title;
                const streams = await buildStreamsFromLinks(links, {
                    client,
                    config,
                    title: displayTitle,
                    reqHost,
                    options: { ...options, baseUrl }
                });
                if (streams.length) {
                    cbDebug('info', 'base attempt success', { baseUrl, kind: 'movie', streams: streams.length, elapsedMs: Date.now() - baseStartedAt });
                    return streams;
                }
                failureTrail.push({ baseUrl, stage: 'movie_streams_empty', pageHost: safeHost(pageUrl), pagePath: safePath(pageUrl), elapsedMs: Date.now() - baseStartedAt });
            }
        } catch (error) {
            failureTrail.push({ baseUrl, stage: 'exception', error: error?.message || String(error), elapsedMs: Date.now() - baseStartedAt });
            cbDebug('warn', 'search base failed', { baseUrl, error: error?.message || String(error), stack: isCbTraceEnabled() ? error?.stack : undefined });
        }
    }

    cbDebug('warn', 'search finished with zero streams', {
        title,
        year: year || null,
        isSeries,
        season: season || null,
        episode: episode || null,
        basesTried: bases.length,
        failureTrail
    });
    return [];
}

module.exports = {
    searchCb01,
    searchCB01: searchCb01,
    __private: {
        decodeHtml,
        normalizeTitle,
        extractCardCandidates,
        parseSeasonRange,
        decodeSeasonAliasText,
        extractSpoilerSections,
        findStandardEpisodeLinks,
        pickEpisodeHostLinks,
        getBaseUrls,
        normalizeBaseUrl,
        isChallengePage,
        isMixdropUrl,
        isStayonlineUrl,
        isMaxstreamLikeUrl,
        normalizeMixdropForExtractor,
        buildSearchQuery
    }
};
