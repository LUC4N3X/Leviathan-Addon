'use strict';

const { withProviderHealth } = require('../utils/provider_health');
const { normalizeStreams } = require('../utils/stream_normalizer');
const {
    buildWebStream,
    dedupeStreamsByUrl,
    probePlaylistIntelligence,
    decorateStreamWithPlaylistIntelligence
} = require('../extractors/common');
const { getMediaflowBase } = require('../../core/proxy/mediaflow_gateway');
const { buildForwardProxyUrl, getForwardProxyBase } = require('../../core/proxy/forward_proxy_config');
const { getProviderDomain } = require('../utils/provider_domain_registry');

let buildCinemaCityProxyUrl = null;
let prewarmCinemaCityPlayback = null;
try {
    ({ buildCinemaCityProxyUrl, prewarmCinemaCityPlayback } = require('./cc_proxy'));
} catch (_) {

}

let ccMemory = null;
try {
    ccMemory = require('./cc_memory');
} catch (_) {

}

let runCurlCffiBypass = null;
try {
    ({ runCurlCffiBypass } = require('../utils/cloudflare_bypass'));
} catch (_) {

}

let curlCffiRunnerOverride = null;

function memRecall(id, type) {
    try {
        return ccMemory ? ccMemory.recall(id, type) : null;
    } catch (_) {
        return null;
    }
}
function memRemember(id, type, payload) {
    try {
        if (ccMemory) ccMemory.remember(id, type, payload);
    } catch (_) { /* ignore */ }
}
function memRememberNegative(id, type) {
    try {
        if (ccMemory) ccMemory.rememberNegative(id, type);
    } catch (_) { /* ignore */ }
}
function memReinforce(id, type) {
    try {
        if (ccMemory) ccMemory.reinforce(id, type);
    } catch (_) { /* ignore */ }
}
function memPenalize(id, type) {
    try {
        if (ccMemory) ccMemory.penalize(id, type);
    } catch (_) { /* ignore */ }
}

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

function decodeB64Utf8(str) {
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

const BASE_URL = getProviderDomain('cinemacity', decodeB64Utf8('aHR0cHM6Ly9jaW5lbWFjaXR5LmNj'));
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const FETCH_TIMEOUT = 10000;
const TMDB_API_KEY = '68e094699525b18a70bab2f86b1fa706';
const SITEMAP_URL = `${BASE_URL}/news_pages.xml`;
const SITEMAP_CACHE_MS = 60 * 60 * 1000;
function resolveCinemaCityWorkerHost() {
    const configured = String(
        process.env.CINEMACITY_WORKER_HOST
        || process.env.CC_WORKER_HOST
        || ''
    ).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (configured) return configured;
    return decodeB64Utf8('Y2MucmVhbGJlc3RpYS5jb20=');
}

const WORKER_HOST = resolveCinemaCityWorkerHost();
const PROVIDER_LABEL = 'CinemaCity';
const PROVIDER_CODE = 'CC';
const EXTRACTOR_LABEL = 'CCCDN';
const DEFAULT_STREAM_HEADERS = Object.freeze({
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
});
const AUTH_COOKIE_ENV_NAMES = Object.freeze(['CINEMACITY_AUTH_COOKIE', 'CC_AUTH_COOKIE']);
const AUTH_COOKIE_B64_ENV_NAMES = Object.freeze(['CINEMACITY_AUTH_COOKIE_B64', 'CC_AUTH_COOKIE_B64']);

let sitemapCache = null;

function mappingServiceBaseUrl() {
    return 'https://anime.questoleviatanormio.dpdns.org';
}

function isEnabledConfigValue(value) {
    if (value === true) return true;
    const normalized = String(value || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled', 'checked'].includes(normalized);
}

function mappingLocaleFromContext(providerContext = null) {
    const explicit = String(providerContext?.mappingLanguage || '').trim().toLowerCase();
    if (explicit === 'it') return 'it';
    return isEnabledConfigValue(providerContext?.easyCatalogsLangIt) ? 'it' : null;
}

function getCinemaCityProxySecret() {
    return String(process.env.CINEMACITY_PROXY_SECRET || '').trim();
}

function withCinemaCityWorkerHeaders(headers = {}) {
    const out = withCinemaCityAuthHeaders(headers);
    const secret = getCinemaCityProxySecret();
    if (secret) out['x-proxy-secret'] = secret;
    return out;
}

async function fetchWithCinemaCityWorker(url) {
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    const targetUrl = (`https://${WORKER_HOST}`).replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
    const response = await fetchWithTimeout(targetUrl, {
        timeout: FETCH_TIMEOUT,
        headers: withCinemaCityWorkerHeaders({ 'User-Agent': USER_AGENT })
    });
    if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
    return await response.text();
}

function getCurlCffiRunner() {
    return curlCffiRunnerOverride || runCurlCffiBypass || null;
}

function isCurlCffiFallbackEnabled() {
    const disabledValues = ['0', 'false', 'no', 'off', 'disabled'];
    const local = String(process.env.CC_CURL_CFFI_FALLBACK ?? '').trim().toLowerCase();
    if (disabledValues.includes(local)) return false;
    const global = String(process.env.CURL_CFFI_ENABLED ?? '').trim().toLowerCase();
    if (disabledValues.includes(global)) return false;
    return true;
}

function firstConfiguredEnv(names = []) {
    for (const name of names) {
        const value = String(process.env[name] || '').trim();
        if (value) return value;
    }
    return '';
}

function decodeConfiguredBase64(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        return Buffer.from(raw, 'base64').toString('utf8');
    } catch (_) {
        return '';
    }
}

function cleanCookieHeader(value) {
    return String(value || '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => /^[^=;\s]+=[^;]*$/.test(part))
        .join('; ');
}

function getCinemaCityAuthCookie() {
    const direct = cleanCookieHeader(firstConfiguredEnv(AUTH_COOKIE_ENV_NAMES));
    if (direct) return direct;
    return cleanCookieHeader(decodeConfiguredBase64(firstConfiguredEnv(AUTH_COOKIE_B64_ENV_NAMES)));
}

function withCinemaCityAuthHeaders(headers = {}) {
    const out = { ...(headers || {}) };
    const authCookie = getCinemaCityAuthCookie();
    if (!authCookie) return out;

    const cookieKey = Object.keys(out).find((name) => String(name).toLowerCase() === 'cookie') || 'Cookie';
    const existing = cleanCookieHeader(out[cookieKey]);
    out[cookieKey] = existing ? `${existing}; ${authCookie}` : authCookie;
    return out;
}

function isUsableCinemaCityHtml(html) {
    const text = String(html || '');
    if (text.length < 500) return false;
    if (text.includes('Just a moment')) return false;
    if (text.includes('admin') && text.includes('Unlimited')) return false;
    return true;
}

function isUsableCurlCffiResult(result) {
    if (!result || result.status !== 'ok') return false;
    if (result.challengeDetected === true) return false;
    const code = Number(result.code || 0);
    if (code && code >= 400) return false;
    return isUsableCinemaCityHtml(result.html);
}

async function fetchViaCurlCffi(url, options = {}) {
    const runner = getCurlCffiRunner();
    if (typeof runner !== 'function' || !isCurlCffiFallbackEnabled()) {
        throw new Error('curl_cffi_unavailable');
    }
    const targetUrl = resolveCinemaCityUrl(BASE_URL, url);
    let result;
    try {
        result = await runner(targetUrl, 'cinemacity', {
            headers: withCinemaCityAuthHeaders({ ...DEFAULT_STREAM_HEADERS, ...(options.headers || {}) }),
            referer: `${BASE_URL}/`,
            timeout: options.timeout || FETCH_TIMEOUT,
            coalesceKey: `cinemacity:${targetUrl}`
        });
    } catch (error) {
        const message = String(error?.message || error || '');
        if (/curl_cffi_(?:not_available|unavailable)|No module named ['"]curl_cffi['"]/i.test(message)) {
            throw new Error('curl_cffi_unavailable');
        }
        throw error;
    }
    if (!isUsableCurlCffiResult(result)) {
        throw new Error('curl_cffi_unusable');
    }
    return String(result.html);
}


async function fetchCinemaCityHtml(url, options = {}) {
    let workerHtml = null;
    let workerError = null;
    try {
        workerHtml = await fetchWithCinemaCityWorker(url);
    } catch (error) {
        workerError = error;
    }

    if (workerHtml !== null && isUsableCinemaCityHtml(workerHtml)) {
        return workerHtml;
    }

    try {
        const curlHtml = await fetchViaCurlCffi(url, options);
        console.log(`[CinemaCity] curl_cffi fallback served ${url} (${curlHtml.length} chars)`);
        return curlHtml;
    } catch (_) {
        if (workerHtml !== null) return workerHtml;
        throw workerError || new Error('cinemacity_fetch_failed');
    }
}

function unescapeCinemaCityText(value) {
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        '#039': "'",
        ndash: '-',
        mdash: '-'
    };
    return String(value || '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
            const key = String(entity || '').toLowerCase();
            if (key[0] !== '#') return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : _;
            const rawCode = key[1] === 'x' ? key.slice(2) : key.slice(1);
            const code = Number.parseInt(rawCode, key[1] === 'x' ? 16 : 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/[\u2013\u2014]/g, '-');
}

function statusFromFetchFailure(error) {
    const responseStatus = Number.parseInt(String(error?.response?.status || ''), 10);
    if (Number.isInteger(responseStatus)) return responseStatus;
    const match = String(error && error.message ? error.message : error).match(/HTTP\s+(\d+)/i);
    return match ? Number.parseInt(match[1], 10) : null;
}

function isChallengeSolverFailure(error) {
    const message = [error?.message, error?.response?.data?.message, error?.response?.data].filter(Boolean).join(' ');
    return /Cloudflare has blocked this request|Error solving the challenge/i.test(message);
}

function cinemaCityTitleKey(value) {
    return unescapeCinemaCityText(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .join(' ');
}

function cinemaCityCompactKey(value) {
    return cinemaCityTitleKey(value).split(' ').join('');
}

function mediaReleaseYear(metadata) {
    const found = String(metadata?.release_date || metadata?.first_air_date || '').match(/\b(19|20)\d{2}\b/);
    return found ? Number.parseInt(found[0], 10) : null;
}

function titleSignalTokens(value) {
    const stopwords = new Set('the a an of and in on to for at by is it il lo la gli le un uno una di da del della dei e o con per su tra fra'.split(' '));
    const out = [];
    for (const token of cinemaCityTitleKey(value).split(' ')) {
        if (token.length > 1 && !stopwords.has(token) && !out.includes(token)) out.push(token);
    }
    return out;
}

function catalogRecordFromUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (_) {
        return null;
    }
    if (!/cinemacity\.cc$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/(movies|tv-series|anime)\/\d+-([^/]+)\.html$/i);
    if (!match) return null;

    const slugParts = match[2].split('-').filter(Boolean);
    let year = null;
    const last = slugParts[slugParts.length - 1];
    if (/^(19|20)\d{2}$/.test(last || '')) {
        year = Number.parseInt(slugParts.pop(), 10);
    }
    const title = slugParts.join(' ');
    return {
        url: parsed.toString(),
        kind: match[1].toLowerCase(),
        title,
        normalizedTitle: cinemaCityTitleKey(title),
        compactTitle: cinemaCityCompactKey(title),
        tokens: titleSignalTokens(title),
        year
    };
}

function catalogRecordsFromSitemap(xml) {
    const records = [];
    const seen = new Set();
    for (const match of String(xml || '').matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
        const record = catalogRecordFromUrl(unescapeCinemaCityText(match[1]));
        if (!record || seen.has(record.url)) continue;
        seen.add(record.url);
        records.push(record);
    }
    return records;
}

async function loadCinemaCityCatalogSnapshot(providerContext = null) {
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
        headers: withCinemaCityWorkerHeaders({ 'User-Agent': USER_AGENT })
    });

    if (firstResp.ok) {
        const totalEntries = parseInt(firstResp.headers.get('x-total-entries') || '0', 10);
        const firstXml = await firstResp.text();
        let allEntries = catalogRecordsFromSitemap(firstXml);

        if (totalEntries > 0) {
            const perPage = 500;
            const totalPages = Math.ceil(totalEntries / perPage);
            const pageFetches = [];
            for (let p = 2; p <= totalPages; p++) {
                const pageUrl = sitemapProxy.endsWith('/')
                    ? `${sitemapProxy.slice(0, -1)}${sitemapPath}?page=${p}&perPage=500`
                    : `${sitemapProxy}${sitemapPath}?page=${p}&perPage=500`;
                pageFetches.push(
                    fetchWithTimeout(pageUrl, { timeout: FETCH_TIMEOUT, headers: withCinemaCityWorkerHeaders({ 'User-Agent': USER_AGENT }) })
                        .then((r) => (r.ok ? r.text() : ''))
                        .then((xml) => {
                            if (xml) allEntries = allEntries.concat(catalogRecordsFromSitemap(xml));
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
    let xml = null;
    try {
        const response = await fetchWithTimeout(targetUrl, {
            timeout: FETCH_TIMEOUT,
            headers: withCinemaCityWorkerHeaders({ 'User-Agent': USER_AGENT })
        });
        if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
        xml = await response.text();
    } catch (workerError) {

        try {
            xml = await fetchViaCurlCffi(SITEMAP_URL, { timeout: Math.max(FETCH_TIMEOUT, 20000) });
            console.log('[CinemaCity] curl_cffi fallback served sitemap');
        } catch (_) {
            throw workerError;
        }
    }
    const entries = catalogRecordsFromSitemap(xml);
    sitemapCache = { entries, expiresAt: Date.now() + SITEMAP_CACHE_MS };
    console.log(`[CinemaCity] Sitemap catalog loaded: ${entries.length} entries`);
    return entries;
}

function scoreTitleAgainstRecord(record, title) {
    const titleKey = cinemaCityTitleKey(title);
    const tightTitleKey = cinemaCityCompactKey(title);
    if (!titleKey || !tightTitleKey) return 0;
    if (record.normalizedTitle === titleKey || record.compactTitle === tightTitleKey) return 1000;
    if (record.normalizedTitle.startsWith(titleKey) || titleKey.startsWith(record.normalizedTitle)) return 500;
    if (record.compactTitle.includes(tightTitleKey) || tightTitleKey.includes(record.compactTitle)) return 420;

    const wanted = titleSignalTokens(title);
    if (!wanted.length || !record.tokens.length) return 0;
    const have = new Set(record.tokens);
    const hits = wanted.reduce((count, token) => count + (have.has(token) ? 1 : 0), 0);
    const coverage = hits / wanted.length;
    const surplus = Math.max(0, record.tokens.length - wanted.length);
    return coverage * 300 - surplus * 20 - Math.abs(record.tokens.length - wanted.length) * 2;
}

function rankCatalogRecord(record, expectedTitles, expectedYear) {
    const scores = (Array.isArray(expectedTitles) ? expectedTitles : [expectedTitles])
        .map((title) => scoreTitleAgainstRecord(record, title));
    let best = Math.max(0, ...scores);
    if (expectedYear && record.year) {
        best += record.year === expectedYear ? 50 : -Math.abs(record.year - expectedYear) * 3;
    }
    return best;
}

function readImdbMarker(html) {
    const match = String(html || '').match(/\btt\d{5,}\b/i);
    return match ? match[0].toLowerCase() : null;
}

async function confirmImdbOnCandidatePage(candidateUrl, expectedImdbId) {
    const normalizedExpected = String(expectedImdbId || '').trim().toLowerCase();
    if (!/^tt\d{5,}$/.test(normalizedExpected)) {
        return null;
    }

    try {
        const html = await fetchCinemaCityHtml(candidateUrl);
        const imdbId = readImdbMarker(html);
        if (imdbId) {
            console.log(`[CinemaCity] IMDb check ${candidateUrl}: ${imdbId}`);
        }
        return imdbId;
    } catch (e) {
        const status = statusFromFetchFailure(e);
        if (status !== 403 && status !== 503 && !isChallengeSolverFailure(e)) {
            console.error(`[CinemaCity] IMDb check error for ${candidateUrl}:`, e);
        }
        return null;
    }
}

async function resolveCinemaCityCatalogPage(id, providerType, providerContext = null) {
    const expectedImdbId = /^tt\d{5,}$/i.test(String(id || '').trim())
        ? String(id).trim().toLowerCase()
        : null;

    const remembered = memRecall(id, providerType);
    if (remembered) {
        if (remembered.negative) {
            console.log(`[CinemaCity] Memory: negative hit for ${id} (${providerType}) — skipping sitemap scan`);
            return null;
        }
        if (remembered.url) {
            const confidenceLabel = Number.isFinite(remembered.confidence) ? remembered.confidence.toFixed(2) : remembered.confidence;
            console.log(`[CinemaCity] Memory: resolved ${id} -> ${remembered.url} [conf=${confidenceLabel}${remembered.verifiedImdb ? ', imdb✓' : ''}] — skipping sitemap scan`);
            return { url: remembered.url, title: remembered.title || '', fromMemory: true };
        }
    }

    const metadata = await loadTmdbIdentity(id, providerType === 'anime' ? 'tv' : providerType);
    const expectedTitles = Array.from(new Set([
        metadata?.title,
        metadata?.name,
        metadata?.original_title,
        metadata?.original_name
    ].filter(Boolean)));

    if (expectedTitles.length === 0) {
        return null;
    }

    const expectedYear = mediaReleaseYear(metadata);
    const expectedKinds = providerType === 'movie'
        ? new Set(['movies'])
        : providerType === 'anime'
            ? new Set(['anime', 'tv-series'])
            : new Set(['tv-series', 'anime']);

    let entries;
    try {
        entries = await loadCinemaCityCatalogSnapshot(providerContext);
    } catch (e) {
        const status = statusFromFetchFailure(e);
        if (status === 403 || status === 404 || status === 503 || isChallengeSolverFailure(e)) {
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
        if (!expectedKinds.has(entry.kind)) continue;
        const score = rankCatalogRecord(entry, expectedTitles, expectedYear);
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
        if (Array.isArray(entries) && entries.length > 0) {
            memRememberNegative(id, providerType);
        }
        return null;
    }

    if (expectedImdbId) {
        ranked.sort((a, b) => b.score - a.score);
        const candidatesToVerify = ranked.slice(0, 3);
        for (const candidate of candidatesToVerify) {
            const candidateImdbId = await confirmImdbOnCandidatePage(candidate.entry.url, expectedImdbId);
            if (candidateImdbId === expectedImdbId) {
                console.log(`[CinemaCity] Sitemap IMDb verified: ${expectedTitles[0]} -> ${candidate.entry.url}`);
                const verifiedResult = {
                    url: candidate.entry.url,
                    title: expectedTitles[0] || candidate.entry.title
                };
                memRemember(id, providerType, {
                    url: verifiedResult.url,
                    title: verifiedResult.title,
                    kind: candidate.entry.kind,
                    score: candidate.score,
                    verifiedImdb: true
                });
                return verifiedResult;
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
    const matchResult = {
        url: bestEntry.url,
        title: expectedTitles[0] || bestEntry.title
    };
    memRemember(id, providerType, {
        url: matchResult.url,
        title: matchResult.title,
        kind: bestEntry.kind,
        score: bestScore,
        verifiedImdb: false
    });
    return matchResult;
}

async function loadTmdbIdentity(id, providerType) {
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

async function translateKitsuIdentity(kitsuId, season, episode, providerContext = null) {
    try {
        if (!kitsuId) return null;

        const params = new URLSearchParams();
        const parsedEpisode = Number.parseInt(String(episode || ''), 10);
        const parsedSeason = Number.parseInt(String(season || ''), 10);
        params.set('ep', Number.isInteger(parsedEpisode) && parsedEpisode > 0 ? String(parsedEpisode) : '1');
        if (Number.isInteger(parsedSeason) && parsedSeason >= 0) {
            params.set('s', String(parsedSeason));
        }

        const mappingLanguage = mappingLocaleFromContext(providerContext);
        if (mappingLanguage) {
            params.set('lang', mappingLanguage);
        }

        const url = `${mappingServiceBaseUrl()}/kitsu/${encodeURIComponent(String(kitsuId).trim())}?${params.toString()}`;
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

function numberOrDefault(value, fallback = 1) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function splitSeriesRequestId(rawId, season, episode) {
    const fallbackSeason = Number.isInteger(season) ? season : numberOrDefault(season, 1);
    const fallbackEpisode = Number.isInteger(episode) ? episode : numberOrDefault(episode, 1);
    const raw = String(rawId || '').trim();
    const parts = raw.split(':');
    if (parts.length === 3 && /^(tt\d+|\d+|tmdb:\d+)$/i.test(parts[0])) {
        return {
            normalizedId: parts[0],
            season: numberOrDefault(parts[1], fallbackSeason),
            episode: numberOrDefault(parts[2], fallbackEpisode)
        };
    }
    return { normalizedId: raw, season: fallbackSeason, episode: fallbackEpisode };
}

function makeCdnPlaylistCandidate(fileValue) {
    const value = String(fileValue || '');
    const marker = '/public_files/';
    const markerIndex = value.indexOf(marker);
    if (markerIndex < 0) return null;

    const prefix = value.slice(0, markerIndex + marker.length);
    const manifestSeed = value.slice(markerIndex + marker.length);
    const assets = manifestSeed.split(',').map((part) => part.trim()).filter(Boolean);
    const hasVideo = assets.some((part) => /\.mp4(?:$|[?#])/i.test(part));
    if (!hasVideo) return null;

    const hasNativeManifest = assets.some((part) => /\.m3u8(?:$|[?#])/i.test(part));
    const hasItalian = assets.some((part) => /\.m4a(?:$|[?#])/i.test(part) && /italian|italiano/i.test(part));
    return {
        url: `${prefix}${manifestSeed}${hasNativeManifest ? '' : '.urlset/master.m3u8'}`,
        hasItalian
    };
}

function firstPlayableFileFromInlineTree(items, season, episode) {
    if (!Array.isArray(items) || !items.length) return null;
    const seasonIndex = numberOrDefault(season, 1) - 1;
    const episodeIndex = numberOrDefault(episode, 1) - 1;
    const seasonNode = Array.isArray(items[seasonIndex]?.folder) ? items[seasonIndex] : null;
    if (seasonNode) {
        const episodeNode = seasonNode.folder[episodeIndex];
        if (episodeNode?.file) return episodeNode.file;
    }
    return typeof items[0]?.file === 'string' && /^https?:\/\//i.test(items[0].file) ? items[0].file : null;
}

function recoverCdnPlaylistFromInlinePayload(html, season, episode) {
    for (const match of String(html || '').matchAll(/atob\s*\(\s*['"]([^"']{20,})['"]\s*\)/gi)) {
        const decoded = decodeB64Utf8(match[1]);
        if (!decoded || decoded.length < 20) continue;
        const jsonMatch = decoded.match(/file\s*:\s*'(\[[\s\S]*?\])'/);
        if (!jsonMatch) continue;
        try {
            const fileValue = firstPlayableFileFromInlineTree(JSON.parse(jsonMatch[1]), season, episode);
            const candidate = makeCdnPlaylistCandidate(fileValue);
            if (candidate) return candidate;
        } catch (_) {}
    }
    return null;
}

function collectPlayableAnchors(html) {
    const links = [];
    for (const match of String(html || '').matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = String(match[1] || '').trim();
        if (href.length < 10 || !/\.(mp4|m3u8|mkv|avi|mov|webm)(?:$|[?#])/i.test(href)) continue;
        links.push({
            url: href,
            text: unescapeCinemaCityText(String(match[2] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().toLowerCase()
        });
    }
    return links;
}

function resolveCinemaCityUrl(base, relative) {
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

function looksLikeAnimeMeta(meta = {}) {
    const type = String(meta?.type || '').toLowerCase();
    const ids = [meta?.id, meta?.imdb_id, meta?.imdbId, meta?.kitsu_id, meta?.kitsuId, meta?.stremioId];
    const text = [
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.original_name,
        ...(Array.isArray(meta?.genres) ? meta.genres : [])
    ].filter(Boolean).join(' ');

    return type === 'anime'
        || ids.some((value) => /^kitsu(?::|_)?\d+/i.test(String(value || '').trim()))
        || /\banime\b/i.test(text);
}

function isCinemaCityContentUrlForType(rawUrl, type = 'movie') {
    try {
        const parsed = new URL(String(rawUrl || ''), BASE_URL);
        const pathname = parsed.pathname.toLowerCase();
        const normalizedType = String(type || '').toLowerCase();
        if (!/^https?:$/i.test(parsed.protocol) || !/cinemacity\.cc$/i.test(parsed.hostname)) return false;
        if (normalizedType === 'movie') return /\/movies\/\d+-[^/]+\.html$/i.test(pathname);
        if (normalizedType === 'anime') return /\/(?:anime|tv-series)\/\d+-[^/]+\.html$/i.test(pathname);
        return /\/(?:tv-series|anime)\/\d+-[^/]+\.html$/i.test(pathname);
    } catch (_) {
        return false;
    }
}

function getListingBaseUrls(type = 'movie') {
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedType === 'movie') return [`${BASE_URL}/movies/`];
    if (normalizedType === 'anime') return [`${BASE_URL}/anime/`, `${BASE_URL}/tv-series/`];
    return [`${BASE_URL}/tv-series/`, `${BASE_URL}/anime/`];
}

function buildSearchQueryVariants(titles = []) {
    const out = [];
    const push = (value) => {
        const clean = unescapeCinemaCityText(String(value || ''))
            .replace(/\s+/g, ' ')
            .replace(/^[\s:|•-]+|[\s:|•-]+$/g, '')
            .trim();
        if (clean && !out.some((item) => item.toLowerCase() === clean.toLowerCase())) out.push(clean);
    };

    for (const title of Array.isArray(titles) ? titles : [titles]) {
        push(title);
        push(cinemaCityTitleKey(title));
        push(String(title || '').replace(/[:–—-]+/g, ' '));
    }

    return out.filter(Boolean);
}

function inferCinemaCityAudioLanguages(...values) {
    const text = values.map((value) => String(value || '')).join(' ');
    const out = [];
    const push = (lang) => {
        if (lang && !out.includes(lang)) out.push(lang);
    };
    const isSubOnly = /\b(?:sub\s*ita|vost(?:it)?|sottotitoli?\s*ita)\b/i.test(text)
        && !/\b(?:dub\s*ita|audio\s*ita|ita\s*(?:dub|audio)|doppiat[oa])\b/i.test(text);
    const multiAudio = /\b(?:multi(?:[\s._-]*audio)?|dual[\s._-]*audio)\b/i.test(text)
        && !/\b(?:multi[\s._-]*sub|multisub|sub[\s._-]*multi)\b/i.test(text);

    if (multiAudio) {
        push('ita');
        push('eng');
    }
    if (!isSubOnly && /🇮🇹|\b(?:ita|it|italiano|italian)\b/i.test(text)) push('ita');
    if (/🇬🇧|\b(?:eng|en|inglese|english)\b/i.test(text)) push('eng');
    if (/🇯🇵|\b(?:jpn|jp|jap|ja|giapponese|japanese)\b/i.test(text)) push('jpn');
    return out;
}

function normalizeCinemaCityAudioLanguage(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (!clean) return '';
    if (/^(?:it|ita|italian|italiano)$/.test(clean)) return 'ita';
    if (/^(?:en|eng|english|inglese)$/.test(clean)) return 'eng';
    if (/^(?:ja|jp|jpn|jap|japanese|giapponese)$/.test(clean)) return 'jpn';
    if (/^(?:fr|fra|fre|french|francese)$/.test(clean)) return 'fra';
    if (/^(?:es|esp|spa|spanish|spagnolo)$/.test(clean)) return 'spa';
    if (/^(?:de|deu|ger|german|tedesco)$/.test(clean)) return 'deu';
    return clean.slice(0, 12);
}

function mergeCinemaCityAudioLanguages(baseLanguages = [], playlistIntel = null) {
    const out = [];
    const push = (value) => {
        const normalized = normalizeCinemaCityAudioLanguage(value);
        if (normalized && !out.includes(normalized)) out.push(normalized);
    };

    for (const lang of Array.isArray(baseLanguages) ? baseLanguages : [baseLanguages]) push(lang);
    for (const lang of Array.isArray(playlistIntel?.audioLanguages) ? playlistIntel.audioLanguages : []) push(lang);
    return out;
}

function cinemaCityLanguageLabel(audioLanguages = []) {
    if (!Array.isArray(audioLanguages) || !audioLanguages.length) return '';
    if (audioLanguages.length === 1) {
        if (audioLanguages[0] === 'ita') return 'Italian';
        if (audioLanguages[0] === 'eng') return 'English';
        if (audioLanguages[0] === 'jpn') return 'Japanese';
    }
    return audioLanguages.map((lang) => String(lang || '').slice(0, 3).toUpperCase()).join('/');
}

const cinemaCityPlaylistClient = {
    async get(targetUrl, { headers = {}, timeout = FETCH_TIMEOUT, signal = undefined } = {}) {
        const response = await fetchWithTimeout(targetUrl, {
            headers,
            timeout,
            signal
        });
        return {
            status: response.status,
            data: await response.text()
        };
    }
};

async function probeCinemaCityPlaylist(streamUrl, headers = DEFAULT_STREAM_HEADERS) {
    if (!/\.m3u8(?:$|[?#])/i.test(String(streamUrl || ''))) return null;
    const timeout = Number.parseInt(process.env.CC_PLAYLIST_TIMEOUT_MS || '5000', 10) || 5000;
    return probePlaylistIntelligence(cinemaCityPlaylistClient, streamUrl, {
        headers,
        timeout
    }).catch(() => null);
}

function extractCandidateLinksFromListing(html, type = 'movie') {
    const results = [];
    const seen = new Set();
    const anchorRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorRegex.exec(String(html || ''))) !== null) {
        const absoluteUrl = resolveCinemaCityUrl(BASE_URL, unescapeCinemaCityText(match[1]));
        if (!isCinemaCityContentUrlForType(absoluteUrl, type)) continue;
        const key = absoluteUrl.replace(/[?#].*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);

        const innerText = unescapeCinemaCityText(match[2].replace(/<[^>]+>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim();
        const slugMatch = key.match(/\/\d+-([^/]+)\.html$/i);
        const slugTitle = slugMatch ? slugMatch[1].replace(/-\d{4}$/, '').replace(/-/g, ' ') : '';
        const yearMatch = key.match(/-(\d{4})\.html$/);
        results.push({
            url: key,
            title: innerText || slugTitle,
            normalizedTitle: cinemaCityTitleKey(innerText || slugTitle),
            compactTitle: cinemaCityCompactKey(innerText || slugTitle),
            year: yearMatch ? Number.parseInt(yearMatch[1], 10) : null
        });
    }

    return results;
}

function buildForwardHeaderParams(headers = {}) {
    const params = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null || value === '') continue;
        const key = String(name || '').trim().toLowerCase();
        if (!key || !/^[a-z0-9-]+$/i.test(key)) continue;
        params[`h_${key}`] = String(value);
    }
    return params;
}

function buildCinemaCityKrakenForwardUrl(targetUrl, headers = {}) {
    const normalizedTarget = resolveCinemaCityUrl(BASE_URL, targetUrl);
    if (!/^https?:\/\//i.test(normalizedTarget)) return null;

    try {
        const base = getForwardProxyBase({ context: 'cinemacity' });
        if (!base) return null;
        return buildForwardProxyUrl(normalizedTarget, {
            base,
            context: 'cinemacity',
            params: buildForwardHeaderParams(headers)
        });
    } catch (_) {
        return null;
    }
}

function getCinemaCityPageExtractorBase(config = {}) {
    const raw = String(
        config?.cinemacity?.pageExtractorBase
        || config?.cinemacity?.extractorBase
        || config?.mediaflow?.url
        || config?.mfp?.url
        || config?.kraken?.url
        || process.env.CINEMACITY_PAGE_EXTRACTOR_BASE
        || process.env.CINEMACITY_KRAKEN_EXTRACTOR_URL
        || process.env.KRAKEN_PROXY_URL
        || process.env.MEDIAFLOW_PROXY_URL
        || process.env.MEDIAFLOW_URL
        || process.env.MFP_URL
        || process.env.MFP_BASE_URL
        || process.env.KRAKEN_URL
        || process.env.KRAKEN_BASE_URL
        || process.env.FORWARD_PROXY
        || ''
    ).trim();
    if (!raw) return '';
    try {
        const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        return parsed.origin;
    } catch (_) {
        return raw.replace(/\/.*$/, '').replace(/\/+$/, '');
    }
}

function buildCinemaCityPlaybackUrl(streamUrl, headers, reqHost, options = {}) {
    if (typeof buildCinemaCityProxyUrl !== 'function') return streamUrl;
    const base = String(reqHost || process.env.PUBLIC_BASE_URL || process.env.ADDON_URL || '').trim();
    if (!base) return streamUrl;
    return buildCinemaCityProxyUrl(streamUrl, headers, reqHost, options) || streamUrl;
}

function maybePrewarmCinemaCityPlayback(streamUrl, headers, reqHost, options = {}) {
    if (typeof prewarmCinemaCityPlayback !== 'function') return false;
    const base = String(reqHost || process.env.PUBLIC_BASE_URL || process.env.ADDON_URL || '').trim();
    if (!base) return false;
    try {
        return prewarmCinemaCityPlayback(streamUrl, headers, reqHost, options);
    } catch (_) {
        return false;
    }
}

async function getCinemaCityStreams(id, type, season, episode, providerContext = null) {
    const parsedRequest = splitSeriesRequestId(id, season, episode);
    id = parsedRequest.normalizedId;
    season = parsedRequest.season;
    episode = parsedRequest.episode;

    let imdbId = String(id || '').trim();
    const normalizedType = String(type || '').toLowerCase();
    const providerType = normalizedType === 'movie' ? 'movie' : (normalizedType === 'anime' ? 'anime' : 'tv');
    const tmdbApiType = providerType === 'movie' ? 'movie' : 'tv';
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
        const mapped = kitsuId ? await translateKitsuIdentity(kitsuId, seasonHintForKitsu, episode, providerContext) : null;

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
                    const externalUrl = tmdbApiType === 'movie'
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
        const searchResult = await resolveCinemaCityCatalogPage(imdbId, providerType, providerContext);
        if (!searchResult?.url) {
            return [];
        }

        const fromMemory = searchResult.fromMemory === true;
        const movieUrl = searchResult.url;
        const movieTitle = (searchResult.title || imdbId).replace(/\s*\(.*?\)\s*/g, '').trim();
        const title = (type === 'tv' || type === 'series')
            ? `${movieTitle} ${season}x${episode}`
            : movieTitle;

        let html;
        try {
            html = await fetchCinemaCityHtml(movieUrl);
        } catch (e) {
            console.warn(`[CinemaCity] Worker fetch failed: ${e.message}`);
            return [];
        }

        if (html.length < 500 || html.includes('Just a moment') || (html.includes('admin') && html.includes('Unlimited'))) {
            console.warn(`[CinemaCity] Page blocked or empty (${html.length} chars)`);
            if (fromMemory) memPenalize(imdbId, providerType);
            return [];
        }

        const links = collectPlayableAnchors(html);
        if (links.length === 0) {
            const useSeason = providerType === 'tv' ? season : null;
            const useEpisode = providerType === 'tv' ? episode : null;
            const atobResult = recoverCdnPlaylistFromInlinePayload(html, useSeason, useEpisode);
            if (atobResult) {
                links.push({ url: atobResult.url, text: '' });
            }
        }

        if (links.length === 0) {
            console.log('[CinemaCity] No streams available');
            return [];
        }

        let selectedLink = null;
        for (const link of links) {
            const text = link.text;
            if (text.includes('ita') || text.includes('italian') || text.includes('italiano')) {
                selectedLink = link;
                break;
            }
        }
        if (!selectedLink) {
            for (const link of links) {
                if (link.text.includes('eng') || link.text.includes('sub')) continue;
                selectedLink = link;
                break;
            }
        }
        if (!selectedLink) selectedLink = links[0];

        const selectedUrl = selectedLink.url;
        const labelAudioLanguages = inferCinemaCityAudioLanguages(selectedLink.text);

        const streamUrl = resolveCinemaCityUrl(movieUrl, selectedUrl);
        const playlistIntel = await probeCinemaCityPlaylist(streamUrl, DEFAULT_STREAM_HEADERS);
        const audioLanguages = mergeCinemaCityAudioLanguages(labelAudioLanguages, playlistIntel);
        console.log(`[CinemaCity] CCCDN stream: ${streamUrl}`);

        memReinforce(imdbId, providerType);

        let stream = {
            name: PROVIDER_LABEL,
            title,
            url: streamUrl,
            quality: '1080p',
            type: 'hls',
            extractor: EXTRACTOR_LABEL,
            provider: PROVIDER_LABEL,
            providerCode: PROVIDER_CODE,
            language: cinemaCityLanguageLabel(audioLanguages),
            audioLanguages,
            behaviorHints: {
                notWebReady: true,
                extractor: EXTRACTOR_LABEL,
                vortexExtractor: EXTRACTOR_LABEL,
                vortexSource: PROVIDER_LABEL,
                vortexProviderCode: PROVIDER_CODE,
                vortexMeta: {
                    provider: PROVIDER_LABEL,
                    source: PROVIDER_LABEL,
                    site: PROVIDER_LABEL,
                    extractor: EXTRACTOR_LABEL,
                    quality: '1080p',
                    audioLanguages
                }
            },
            headers: { ...DEFAULT_STREAM_HEADERS }
        };
        stream = decorateStreamWithPlaylistIntelligence(stream, playlistIntel);
        return [stream];
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
        const esStreams = await getCinemaCityStreams(id, type, season, episode, providerContext);
        if (!esStreams.length) return [];

        const streams = esStreams.map((stream) => {
            const isHls = stream.type === 'hls' || /\.m3u8(?:$|[?#])/i.test(String(stream.url || ''));
            const headers = stream.headers || { ...DEFAULT_STREAM_HEADERS };
            const playbackUrl = buildCinemaCityPlaybackUrl(stream.url, headers, reqHost, { isHls });
            const proxied = playbackUrl && playbackUrl !== stream.url;
            if (proxied) maybePrewarmCinemaCityPlayback(stream.url, headers, reqHost, { isHls });
            const audioLanguages = mergeCinemaCityAudioLanguages(stream.audioLanguages || [], stream.behaviorHints?.vortexMeta || {});

            return buildWebStream({
                name: `${PROVIDER_LABEL} | ${EXTRACTOR_LABEL}`,
                title: stream.title || 'Stream',
                url: playbackUrl || stream.url,
                extractor: EXTRACTOR_LABEL,
                provider: PROVIDER_LABEL,
                providerCode: PROVIDER_CODE,
                quality: stream.quality || '1080p',
                headers: proxied ? null : headers,
                mediaflowUrl: getMediaflowBase(config),
                addonBase: reqHost,
                notWebReady: proxied ? false : stream.behaviorHints?.notWebReady !== false,
                extraBehaviorHints: {
                    ...(stream.behaviorHints || {}),
                    notWebReady: proxied ? false : stream.behaviorHints?.notWebReady !== false,
                    extractor: EXTRACTOR_LABEL,
                    vortexExtractor: EXTRACTOR_LABEL,
                    vortexSource: PROVIDER_LABEL,
                    vortexProviderCode: PROVIDER_CODE,
                    vortexMeta: {
                        ...(stream.behaviorHints?.vortexMeta || {}),
                        provider: PROVIDER_LABEL,
                        source: PROVIDER_LABEL,
                        site: PROVIDER_LABEL,
                        providerCode: PROVIDER_CODE,
                        extractor: EXTRACTOR_LABEL,
                        quality: stream.quality || '1080p',
                        deliveryMode: EXTRACTOR_LABEL,
                        audioLanguages
                    }
                },
                extra: {
                    audioLanguages,
                    language: stream.language
                }
            });
        });

        return normalizeStreams(dedupeStreamsByUrl(streams), {
            provider: 'cinemacity',
            providerLabel: PROVIDER_LABEL,
            providerCode: PROVIDER_CODE
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

function getCinemaCityMemoryStats() {
    try {
        return ccMemory ? ccMemory.stats() : { enabled: false };
    } catch (_) {
        return { enabled: false };
    }
}

module.exports = {
    searchCinemaCity,
    buildProviderContext,
    getCinemaCityMemoryStats,
    __private: {
        memory: ccMemory,
        parseSitemapEntries: catalogRecordsFromSitemap,
        scoreSitemapEntry: rankCatalogRecord,
        extractStreamFromAtob: recoverCdnPlaylistFromInlinePayload,
        extractDownloadLinks: collectPlayableAnchors,
        buildDownloadUrl: makeCdnPlaylistCandidate,
        normalizeTitle: cinemaCityTitleKey,
        base64Decode: decodeB64Utf8,
        looksLikeAnimeMeta,
        isCinemaCityContentUrlForType,
        extractCandidateLinksFromListing,
        buildSearchQueryVariants,
        inferCinemaCityAudioLanguages,
        mergeCinemaCityAudioLanguages,
        probeCinemaCityPlaylist,
        getListingBaseUrls,
        buildCinemaCityKrakenForwardUrl,
        getCinemaCityPageExtractorBase,
        buildForwardHeaderParams,
        buildCinemaCityPlaybackUrl,
        isUsableCinemaCityHtml,
        isUsableCurlCffiResult,
        isCurlCffiFallbackEnabled,
        getCinemaCityAuthCookie,
        withCinemaCityAuthHeaders,
        fetchViaCurlCffi,
        fetchCinemaCityHtml,
        __setCurlCffiRunner: (runner) => { curlCffiRunnerOverride = runner; }
    }
};
