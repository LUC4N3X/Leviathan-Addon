'use strict';

const { buildWebStream, normalizeRemoteUrl } = require('../extractors/common');
const { createMediaflowGateway, getMediaflowBase, buildMediaflowUrl } = require('../../core/proxy/mediaflow_gateway');
const {
    buildForwardProxyUrl,
    getForwardProxyBase,
    normalizeForwardProxyBase: normalizeSharedForwardProxyBase
} = require('../../core/proxy/forward_proxy_config');
const { extractMaxstream } = require('../extractors/hosters/maxstream');
const { requestWithImpitRotating, isCanceledError } = require('../utils/bypass');
const {
    buildProviderHtmlHeaders,
    createProviderEnv,
    resolveProviderBaseUrls,
    sanitizeLogValue: sanitizeProviderLogValue
} = require('../utils/provider_toolkit');

const DEFAULT_BASE_URL = 'https://onlineserietv.lol';
const DEFAULT_BASE_URLS = Object.freeze(['https://onlineserietv.lol']);
const PROVIDER = 'OnlineSerieTV';
const PROVIDER_CODE = 'OST';
const ICON = '🖥️';

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';

const OST_CODE_DEFAULTS = Object.freeze({
    OST_BASE_URL: DEFAULT_BASE_URL,
    OST_BASE_URL_2: '',
    OST_BASE_URL_3: '',
    OST_BASE_URLS: '',
    OST_PROVIDER_TIMEOUT: '14000',
    OST_DEBUG: '0',
    OST_TRACE: '0',

    OST_IMPIT_STRATEGY: 'forward-first',
    OST_IMPIT_FORWARD_ENABLED: '1',
    OST_IMPIT_DIRECT_FALLBACK: '1',
    OST_STOP_ON_CHALLENGE: '1',

    OST_SEARCH_TIMEOUT_MS: '12000',
    OST_PAGE_TIMEOUT_MS: '12000',
    OST_SEARCH_TOTAL_BUDGET_MS: '14000',
    OST_PAGE_TOTAL_BUDGET_MS: '15000',

    OST_MAX_DETAIL_PAGES: '6',
    OST_YEAR_TOLERANCE: '1',

    OST_IMPIT_FORWARD_TIMEOUT_MS: '9500',
    OST_IMPIT_DIRECT_TIMEOUT_MS: '6000',
    OST_IMPIT_MAX_BROWSER_ATTEMPTS: '1',
    OST_IMPIT_INNER_RETRY: '0',
    OST_IMPIT_RETRY_ON_CHALLENGE: '0',
    OST_IMPIT_HTTP3: '0',
    OST_IMPIT_BROWSER: 'chrome125',

    OST_MAXSTREAM_HOST_TIMEOUT_MS: '20000'
});

const OST_BROWSER_FALLBACKS = Object.freeze(['chrome142', 'chrome136', 'chrome131', 'chrome125', 'firefox144', 'firefox135']);

const ostEnv = createProviderEnv(OST_CODE_DEFAULTS);

function envString(name, fallback = '') {
    return ostEnv.string(name, fallback);
}

function envFlag(name, defaultValue = false) {
    return ostEnv.flag(name, defaultValue);
}

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return ostEnv.int(name, fallback, min, max);
}

function isOstDebugEnabled() {
    return envFlag('OST_DEBUG', false) || envFlag('OST_VERBOSE', false) || envFlag('WEB_PROVIDER_DEBUG', false);
}

function isOstTraceEnabled() {
    return envFlag('OST_TRACE', false) || envFlag('OST_DEBUG_VERBOSE', false);
}

function ostDebug(level, message, payload = null) {
    const normalizedLevel = String(level || 'info').toLowerCase();
    const alwaysShow = /^(warn|error)$/i.test(normalizedLevel);
    if (!alwaysShow && !isOstDebugEnabled()) return;
    if (normalizedLevel === 'trace' && !isOstTraceEnabled()) return;
    const logger = console[normalizedLevel] || console.info;
    const prefix = normalizedLevel === 'trace' ? '[OST:trace]' : '[OST:debug]';
    if (payload && typeof payload === 'object') {
        try {
            logger(`${prefix} ${message} ${JSON.stringify(sanitizeProviderLogValue(payload))}`);
        } catch (_) {
            logger(`${prefix} ${message}`);
        }
    } else {
        logger(`${prefix} ${message}`);
    }
}

function safeHost(value) {
    try { return new URL(String(value || '')).host; } catch (_) { return ''; }
}

function safePath(value) {
    try { return new URL(String(value || '')).pathname; } catch (_) { return ''; }
}

function safeUrlForLog(value) {
    const host = safeHost(value);
    const path = safePath(value);
    return host ? `${host}${path}` : String(value || '').slice(0, 80);
}

function getBaseUrls() {
    const raw = [
        envString('OST_BASE_URL', DEFAULT_BASE_URL),
        envString('OST_BASE_URL_2', ''),
        envString('OST_BASE_URL_3', ''),
        ...ostEnv.list('OST_BASE_URLS', [])
    ];
    const out = resolveProviderBaseUrls(raw, DEFAULT_BASE_URLS);
    ostDebug('trace', 'base urls resolved', { bases: out });
    return out;
}

function getDefaultClient() {
    try {
        const axios = require('axios');
        return axios.create({
            timeout: envInt('OST_PROVIDER_TIMEOUT', 14000, 1000, 60000),
            maxRedirects: 5,
            proxy: false,
            validateStatus: () => true,
            headers: {
                'User-Agent': DESKTOP_UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5'
            }
        });
    } catch (_) {
        return null;
    }
}

function getOstForwardProxy() {
    return normalizeSharedForwardProxyBase(getForwardProxyBase({ context: 'onlineserietv' }), 'onlineserietv');
}

function buildOstForwardProxyUrl(targetUrl) {
    return buildForwardProxyUrl(targetUrl, { context: 'onlineserietv' });
}

function pickOstBrowser(label = '') {
    const preferred = envString('OST_IMPIT_BROWSER', '');
    if (preferred) return preferred;
    if (label === 'search') return 'chrome125';
    return OST_BROWSER_FALLBACKS[Math.floor(Math.random() * OST_BROWSER_FALLBACKS.length)] || 'chrome125';
}

function buildOstHeaders(baseUrl, { referer = null, cookie = null } = {}) {
    const headers = buildProviderHtmlHeaders({
        userAgent: pickOstBrowser() ? FIREFOX_UA : DESKTOP_UA,
        referer: referer || `${baseUrl}/`,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5',
        acceptEncoding: 'gzip, deflate, br',
        cacheControl: 'no-cache',
        pragma: 'no-cache',
        upgradeInsecureRequests: true
    });
    if (cookie) headers.Cookie = cookie;
    return headers;
}

function impitResponseToText(response) {
    if (!response) return '';
    const data = response.data ?? response.body;
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data == null) return '';
    try { return JSON.stringify(data); } catch (_) { return String(data || ''); }
}

function impitResponseStatus(response) {
    if (!response) return 0;
    const value = Number(response.statusCode ?? response.status ?? 0);
    return Number.isFinite(value) ? value : 0;
}

function isChallengePage(html = '') {
    const text = String(html || '');
    if (!text) return false;
    return /cf-browser-verification|cf_chl_opt|just a moment|attention required|challenge-platform|_cf_chl/i.test(text);
}

function hasUsableHtml(html = '') {
    return String(html || '').length > 600;
}

// Forward-proxy first, direct fallback — same shape as CB01's impit fetch.
async function fetchOstHtml(url, baseUrl, { label = 'page', headers = null, timeoutMs = null } = {}) {
    const startedAt = Date.now();
    const isSearch = label === 'search';
    const hardTimeoutMs = Math.max(
        2000,
        Number(timeoutMs) || envInt(isSearch ? 'OST_SEARCH_TIMEOUT_MS' : 'OST_PAGE_TIMEOUT_MS', isSearch ? 12000 : 12000, 1500, 30000)
    );
    const totalBudgetMs = envInt(
        isSearch ? 'OST_SEARCH_TOTAL_BUDGET_MS' : 'OST_PAGE_TOTAL_BUDGET_MS',
        isSearch ? 14000 : 15000,
        3000,
        24000
    );

    const upstreamHeaders = headers || buildOstHeaders(baseUrl);
    const forwardBase = getOstForwardProxy();
    let forwardUrl = '';
    if (forwardBase && envFlag('OST_IMPIT_FORWARD_ENABLED', true)) {
        try { forwardUrl = buildOstForwardProxyUrl(url); } catch (error) {
            ostDebug('warn', 'forward proxy url build failed', { error: error?.message || String(error) });
        }
    }
    const hasForward = Boolean(forwardUrl && forwardUrl !== url);

    const strategy = String(envString('OST_IMPIT_STRATEGY', hasForward ? 'forward-first' : 'direct-first')).trim().toLowerCase();
    const directFallback = envFlag('OST_IMPIT_DIRECT_FALLBACK', true);
    const forwardTimeoutMs = envInt('OST_IMPIT_FORWARD_TIMEOUT_MS', 9500, 2000, 18000);
    const directTimeoutMs = envInt('OST_IMPIT_DIRECT_TIMEOUT_MS', 6000, 1500, 18000);

    const attempts = [];
    const addForward = (via) => { if (hasForward) attempts.push({ via, requestUrl: forwardUrl, timeoutMs: forwardTimeoutMs }); };
    const addDirect = (via) => attempts.push({ via, requestUrl: url, timeoutMs: hasForward ? directTimeoutMs : hardTimeoutMs });

    if (strategy === 'forward-only') {
        addForward('forward-only');
    } else if (strategy === 'direct-only' || !hasForward) {
        addDirect('direct');
    } else if (strategy === 'direct-first') {
        addDirect('direct-first');
        if (envFlag('OST_IMPIT_FORWARD_ENABLED', true)) addForward('forward-fallback');
    } else {
        addForward('forward-first');
        if (directFallback) addDirect('direct-fallback');
    }
    if (!attempts.length) addDirect('direct-default');

    ostDebug('info', 'html fetch plan', {
        label,
        url: safeUrlForLog(url),
        strategy,
        hasForward,
        forwardHost: safeHost(forwardUrl),
        attempts: attempts.map((a) => a.via)
    });

    let lastStatus = 0;
    let lastVia = '';
    for (let index = 0; index < attempts.length; index += 1) {
        const elapsed = Date.now() - startedAt;
        const remaining = totalBudgetMs - elapsed;
        if (remaining < 1800) break;

        const attempt = attempts[index];
        const browser = pickOstBrowser(label);
        const perAttemptTimeout = Math.max(1500, Math.min(Number(attempt.timeoutMs || hardTimeoutMs), remaining - 500));
        lastVia = attempt.via;

        let response = null;
        let errorMessage = '';
        try {
            response = await requestWithImpitRotating(attempt.requestUrl, {
                method: 'GET',
                headers: upstreamHeaders,
                timeout: perAttemptTimeout,
                responseType: 'text',
                browser,
                browserFallbacks: [browser, ...OST_BROWSER_FALLBACKS.filter((item) => item !== browser)],
                maxBrowserAttempts: envInt('OST_IMPIT_MAX_BROWSER_ATTEMPTS', 1, 1, 3),
                totalTimeoutMs: perAttemptTimeout + 300,
                innerRetry: { limit: envInt('OST_IMPIT_INNER_RETRY', 0, 0, 2) },
                retryOnStatuses: [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524],
                retryOnChallenge: envFlag('OST_IMPIT_RETRY_ON_CHALLENGE', false),
                http3: envFlag('OST_IMPIT_HTTP3', false),
                ignoreTlsErrors: true,
                fingerprint: { userAgent: upstreamHeaders['User-Agent'] || upstreamHeaders['user-agent'] || FIREFOX_UA }
            });
        } catch (error) {
            if (isCanceledError(error)) throw error;
            errorMessage = error?.message || String(error);
        }

        const status = impitResponseStatus(response);
        const text = impitResponseToText(response);
        const challenge = isChallengePage(text);
        const usable = hasUsableHtml(text);
        const ok = status >= 200 && status < 400 && text && (!challenge || usable);
        lastStatus = status;

        ostDebug(ok ? 'info' : 'warn', 'html fetch result', {
            label,
            url: safeUrlForLog(url),
            via: attempt.via,
            browser,
            status,
            bytes: Buffer.byteLength(text || '', 'utf8'),
            challenge,
            error: errorMessage || undefined,
            ms: Date.now() - startedAt
        });

        if (ok) return { text, status, via: attempt.via };

        if (challenge && !usable && envFlag('OST_STOP_ON_CHALLENGE', true)) break;
    }

    ostDebug('warn', 'html fetch exhausted', { label, url: safeUrlForLog(url), lastStatus, lastVia, ms: Date.now() - startedAt });
    return { text: '', status: lastStatus, via: lastVia || 'error' };
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&#(\d+);/g, (_, code) => { try { return String.fromCodePoint(Number(code)); } catch (_) { return ''; } })
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => { try { return String.fromCodePoint(parseInt(code, 16)); } catch (_) { return ''; } })
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTitle(value) {
    return decodeHtml(value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function similarity(a, b) {
    const sa = new Set(normalizeTitle(a).split(' ').filter(Boolean));
    const sb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
    if (!sa.size || !sb.size) return 0;
    let common = 0;
    for (const token of sa) if (sb.has(token)) common += 1;
    return common / Math.max(sa.size, sb.size);
}

function getMetaTitle(meta = {}) {
    return decodeHtml(meta?.title || meta?.name || meta?.originalTitle || meta?.seriesName || '').trim();
}

function getMetaYear(meta = {}) {
    return Number.parseInt(
        String(meta?.year || meta?.releaseYear || meta?.released || meta?.firstAirDate || '').slice(0, 4),
        10
    ) || null;
}

function getSeasonEpisode(meta = {}) {
    const season = Number.parseInt(String(meta?.season || meta?.s || meta?.seasonNumber || meta?.tmdbSeason || 0), 10);
    const episode = Number.parseInt(String(meta?.episode || meta?.e || meta?.episodeNumber || meta?.tmdbEpisode || 0), 10);
    return { season: Number.isFinite(season) ? season : 0, episode: Number.isFinite(episode) ? episode : 0 };
}

function isSeriesMeta(meta = {}) {
    if (meta?.isSeries === true || String(meta?.type || '').toLowerCase() === 'series') return true;
    const { season, episode } = getSeasonEpisode(meta);
    return Boolean(season && episode);
}

const UPROT_MSF_RE = /https?:\/\/(?:www\.)?uprot\.(?:net|pro)\/msf\/[^\s"'<>\\]+/i;
const UPROT_ANY_RE = /https?:\/\/(?:www\.)?uprot\.(?:net|pro)\/[^\s"'<>\\]+/i;

function cleanShowName(title) {
    return decodeHtml(title).replace(/['’]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildSearchUrl(baseUrl, showName) {
    const q = encodeURIComponent(showName);
    return `${baseUrl}/wp-admin/admin-ajax.php?s=${q}&action=searchwp_live_search&swpengine=default&swpquery=${q}&origin_id=50141&searchwp_live_search_client_nonce=undefined`;
}

function collectAnchors(html, baseUrl) {
    const anchors = [];
    const seen = new Set();
    const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = re.exec(String(html || ''))) !== null) {
        const href = normalizeRemoteUrl(match[1] || '', baseUrl);
        const text = decodeHtml(match[2] || '');
        if (!href) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        anchors.push({ href, text });
    }
    return anchors;
}

function extractPageYear(html) {
    const text = String(html || '');
    const strict = text.match(/Anno:\s*<i>\s*(\d{4})\s*<\/i>/i);
    if (strict) return Number.parseInt(strict[1], 10);
    const loose = text.match(/Anno[^0-9]{0,16}(\d{4})/i);
    if (loose) return Number.parseInt(loose[1], 10);
    return null;
}

function yearAccepted(pageYear, metaYear) {
    if (!metaYear || !pageYear) return true; 
    const tolerance = envInt('OST_YEAR_TOLERANCE', 1, 0, 5);
    return Math.abs(pageYear - metaYear) <= tolerance;
}

function extractMovieUprot(html) {
    const msf = String(html || '').match(UPROT_MSF_RE);
    if (msf) return msf[0];
    const any = String(html || '').match(UPROT_ANY_RE);
    return any ? any[0] : null;
}

function extractSeriesUprot(html, season, episode) {
    const text = String(html || '');
    const ss = String(season).padStart(2, '0');
    const ee = String(episode).padStart(2, '0');

    const markers = [
        `${ss}x${ee}`,
        `${season}x${ee}`,
        `${ss}x${episode}`,
        `${season}x${episode}`
    ];

    for (const marker of markers) {
        const idx = text.indexOf(marker);
        if (idx === -1) continue;
        const window = text.slice(idx, idx + 4000);
        const msf = window.match(UPROT_MSF_RE);
        if (msf) return msf[0];
        const any = window.match(UPROT_ANY_RE);
        if (any) return any[0];
    }

    const fallbackIdx = text.indexOf(`0${ee}`);
    if (fallbackIdx !== -1) {
        const window = text.slice(fallbackIdx, fallbackIdx + 4000);
        const msf = window.match(UPROT_MSF_RE);
        if (msf) return msf[0];
        const any = window.match(UPROT_ANY_RE);
        if (any) return any[0];
    }

    return null;
}

function rankCandidates(anchors, kind, showName) {
    const wanted = kind === 'movie' ? /\/film\b|\/film\/|film/i : /serietv/i;
    return anchors
        .filter((anchor) => wanted.test(anchor.href))
        .map((anchor) => ({ ...anchor, score: similarity(anchor.text || anchor.href, showName) }))
        .sort((a, b) => b.score - a.score);
}

async function findUprotLink({ client, baseUrl, showName, metaYear, isSeries, season, episode, config }) {
    const searchUrl = buildSearchUrl(baseUrl, showName);
    const searchHeaders = buildOstHeaders(baseUrl, { referer: `${baseUrl}/`, cookie: 'player_opt=fx' });
    const { text: searchHtml } = await fetchOstHtml(searchUrl, baseUrl, { label: 'search', headers: searchHeaders });
    if (!searchHtml) {
        ostDebug('warn', 'search empty', { baseUrl, showName });
        return null;
    }

    const anchors = collectAnchors(searchHtml, baseUrl);
    const candidates = rankCandidates(anchors, isSeries ? 'series' : 'movie', showName);
    ostDebug('info', 'search candidates', {
        baseUrl,
        showName,
        kind: isSeries ? 'series' : 'movie',
        anchors: anchors.length,
        candidates: candidates.slice(0, 6).map((c) => ({ host: safeHost(c.href), path: safePath(c.href), score: Number(c.score.toFixed(2)) }))
    });
    if (!candidates.length) return null;

    const maxPages = envInt('OST_MAX_DETAIL_PAGES', 6, 1, 12);
    const pageHeaders = buildOstHeaders(baseUrl, { referer: `${baseUrl}/`, cookie: 'player_opt=fx' });

    for (const enforceYear of [true, false]) {
        let probed = 0;
        for (const candidate of candidates) {
            if (probed >= maxPages) break;
            probed += 1;
            const { text: pageHtml } = await fetchOstHtml(candidate.href, baseUrl, { label: 'detail', headers: pageHeaders });
            if (!pageHtml) continue;

            const pageYear = extractPageYear(pageHtml);
            if (enforceYear && !yearAccepted(pageYear, metaYear)) {
                ostDebug('trace', 'detail year rejected', { path: safePath(candidate.href), pageYear, metaYear });
                continue;
            }

            const uprotLink = isSeries
                ? extractSeriesUprot(pageHtml, season, episode)
                : extractMovieUprot(pageHtml);

            if (uprotLink) {
                ostDebug('info', 'uprot link found', {
                    path: safePath(candidate.href),
                    pageYear,
                    uprotHost: safeHost(uprotLink),
                    uprotPath: safePath(uprotLink),
                    enforceYear
                });
                return uprotLink;
            }
        }
    }

    ostDebug('warn', 'no uprot link found', { baseUrl, showName, isSeries, season, episode });
    return null;
}

function uprotPlaybackHeaders() {
    return { 'User-Agent': FIREFOX_UA, Referer: 'https://uprot.net/', Origin: 'https://uprot.net' };
}

function buildKrakenUprotStream(config, uprotUrl, title) {
    if (!getMediaflowBase(config)) return null;
    const mfpUrl = buildMediaflowUrl(config, uprotUrl, 'extractor', 'Maxstream', {
        extractorPath: '/extractor/video.m3u8',
        redirectStream: true,
        headers: uprotPlaybackHeaders()
    });
    if (!mfpUrl || mfpUrl === uprotUrl) return null;
    return buildWebStream({
        name: `${ICON} ${PROVIDER} | MaxStream`,
        title: `${title}\n☁️ MaxStream • 🇮🇹 ITA`,
        url: mfpUrl,
        extractor: 'MaxStream',
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: 'HD',
        headers: null,
        mediaflowUrl: getMediaflowBase(config),
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: { language: 'ITA', audioLanguages: ['ita'], subtitleLanguages: [], via: 'uprot-kraken', streamKind: 'hls' }
        },
        extra: { _priority: 1 }
    });
}

async function buildLocalMaxstreamStream(config, client, uprotUrl, title) {
    let extracted = null;
    try {
        extracted = await extractMaxstream(uprotUrl, { client, userAgent: FIREFOX_UA, timeout: envInt('OST_MAXSTREAM_HOST_TIMEOUT_MS', 20000, 1000, 30000) });
    } catch (error) {
        ostDebug('warn', 'local maxstream extract failed', { error: error?.message || String(error), uprotHost: safeHost(uprotUrl) });
        return null;
    }
    if (!extracted?.url) return null;

    const isHls = /\.m3u8(?:$|[?#])/i.test(extracted.url);
    let finalUrl = extracted.url;
    let headers = extracted.headers || uprotPlaybackHeaders();
    let mediaflowUrl = null;
    let via = extracted.via ? `maxstream-local-${extracted.via}` : 'maxstream-local';

    if (getMediaflowBase(config)) {
        const proxied = createMediaflowGateway(config).buildProxyUrl(extracted.url, extracted.headers || uprotPlaybackHeaders(), { isHls, allowCookie: true });
        if (proxied && proxied !== extracted.url) {
            finalUrl = proxied;
            headers = null;
            mediaflowUrl = getMediaflowBase(config);
            via = 'maxstream-local-mfp';
        }
    }

    return buildWebStream({
        name: `${ICON} ${PROVIDER} | MaxStream`,
        title: `${title}\n☁️ MaxStream • 🇮🇹 ITA`,
        url: finalUrl,
        extractor: 'MaxStream',
        provider: PROVIDER,
        providerCode: PROVIDER_CODE,
        quality: extracted.quality || 'HD',
        headers,
        mediaflowUrl,
        notWebReady: false,
        extraBehaviorHints: {
            bingeWatching: true,
            vortexMeta: { language: 'ITA', audioLanguages: ['ita'], subtitleLanguages: [], via, streamKind: isHls ? 'hls' : 'video' }
        },
        extra: { _priority: 2 }
    });
}

async function buildStreamsFromUprot(uprotUrl, context) {
    const { client, config, title } = context;
    const normalized = normalizeRemoteUrl(uprotUrl);
    if (!normalized) return [];

    const streams = [];
    const seen = new Set();
    const push = (stream) => {
        if (stream?.url && !seen.has(stream.url)) {
            seen.add(stream.url);
            streams.push(stream);
        }
    };

    push(buildKrakenUprotStream(config, normalized, title));

    if (!streams.length) {
        push(await buildLocalMaxstreamStream(config, client, normalized, title));
    }

    if (!streams.length) {
        ostDebug('warn', 'no playable stream from uprot link', {
            uprotHost: safeHost(normalized),
            uprotPath: safePath(normalized),
            hasMfp: Boolean(getMediaflowBase(config))
        });
    }
    return streams.sort((a, b) => (a?.extra?._priority ?? 9) - (b?.extra?._priority ?? 9));
}

async function searchOnlineserietv(meta = {}, config = {}, reqHost = null, options = {}) {
    if (config?.filters?.enableOnlineserietv !== true) {
        ostDebug('trace', 'provider disabled by config', { enableOnlineserietv: config?.filters?.enableOnlineserietv });
        return [];
    }

    const title = getMetaTitle(meta);
    if (!title) {
        ostDebug('warn', 'search aborted: missing title', { metaKeys: Object.keys(meta || {}).slice(0, 30) });
        return [];
    }

    const client = options.client || getDefaultClient();
    if (!client || typeof client.get !== 'function') {
        ostDebug('warn', 'search aborted: missing http client');
        return [];
    }

    const metaYear = getMetaYear(meta);
    const isSeries = isSeriesMeta(meta);
    const { season, episode } = getSeasonEpisode(meta);
    if (isSeries && (!season || !episode)) {
        ostDebug('warn', 'search aborted: series missing season/episode', { title, season, episode });
        return [];
    }

    const showName = cleanShowName(title);
    const bases = getBaseUrls();

    ostDebug('info', 'search start', {
        title,
        showName,
        year: metaYear || null,
        isSeries,
        season: season || null,
        episode: episode || null,
        bases,
        hasMfp: Boolean(getMediaflowBase(config)),
        hasForwardProxy: Boolean(getOstForwardProxy())
    });

    for (const baseUrl of bases) {
        const baseStartedAt = Date.now();
        try {
            const uprotLink = await findUprotLink({ client, baseUrl, showName, metaYear, isSeries, season, episode, config });
            if (!uprotLink) {
                ostDebug('warn', 'base attempt: no uprot link', { baseUrl, elapsedMs: Date.now() - baseStartedAt });
                continue;
            }

            const displayTitle = isSeries
                ? `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
                : (metaYear ? `${title} (${metaYear})` : title);

            const streams = await buildStreamsFromUprot(uprotLink, {
                client,
                config,
                title: displayTitle,
                reqHost,
                options: { ...options, baseUrl }
            });

            if (streams.length) {
                ostDebug('info', 'base attempt success', { baseUrl, streams: streams.length, elapsedMs: Date.now() - baseStartedAt });
                return streams;
            }
        } catch (error) {
            ostDebug('warn', 'search base failed', { baseUrl, error: error?.message || String(error), stack: isOstTraceEnabled() ? error?.stack : undefined });
        }
    }

    ostDebug('warn', 'search finished with zero streams', { title, isSeries, season: season || null, episode: episode || null, basesTried: bases.length });
    return [];
}

module.exports = {
    searchOnlineserietv,
    searchOnlineSerieTv: searchOnlineserietv,
    __private: {
        getBaseUrls,
        getOstForwardProxy,
        buildOstForwardProxyUrl,
        cleanShowName,
        buildSearchUrl,
        collectAnchors,
        extractPageYear,
        yearAccepted,
        extractMovieUprot,
        extractSeriesUprot,
        rankCandidates,
        buildKrakenUprotStream,
        buildStreamsFromUprot,
        normalizeTitle,
        similarity,
        getMetaTitle,
        getMetaYear,
        getSeasonEpisode,
        isSeriesMeta
    }
};
