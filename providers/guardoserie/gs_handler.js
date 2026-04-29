'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const tmdbHelper        = require('../../core/utils/tmdb_helper');
const animeIdentity     = require('../anime/anime_identity');
const kitsuProvider     = require('../animeworld/kitsu_provider');
const animeProviderUtils = require('../anime/provider_utils');
const { GUARDA_SERIE_BROWSER_PROFILES, pickRandomProfile } = require('../../core/browser_profiles');
const {
  buildWebStream,
  normalizeQuality,
  pickBetterQuality,
  probePlaylistQuality,
  qualityRank
} = require('../extractors/common');
const {
  extractFromUrl,
  HOSTER_DIRECT_LINK_PATTERN,
  HOSTER_ESCAPED_DIRECT_LINK_PATTERN
} = require('../extractors/registry');
const {
  createGotScrapingLoader,
  isCanceledError,
  isCloudflareChallenge
} = require('../utils/bypass');
const { createFlareSolverrClient } = require('../utils/flaresolverr');

const INITIAL_GS_DOMAIN      = 'https://guardoserie.garden';
const BROWSER_PROFILES       = GUARDA_SERIE_BROWSER_PROFILES;
const FLARESOLVERR_URL       = process.env.FLARESOLVERR_URL || process.env.FLARE_URL || 'http://127.0.0.1:8191/v1';
const PROVIDER_NAME          = 'guardoserie';
const SESSION_FILE           = path.join(process.cwd(), `cf-session-${PROVIDER_NAME}.json`);
const DOMAIN_FILE            = path.join(process.cwd(), `${PROVIDER_NAME}-domain.json`);
const DOMAIN_REFRESH_TTL     = 1000 * 60 * 20;
const DOMAIN_TIMEOUT_MS      = 8000;
const TTL_SEARCH             = 1000 * 60 * 30;
const TTL_EPISODE            = 1000 * 60 * 30;
const TTL_SERIES             = 1000 * 60 * 60 * 6;
const CF_SESSION_TTL         = 1000 * 60 * 60 * 6;
const GLOBAL_TIMEOUT_MS      = Math.max(30000, parseInt(process.env.GS_INTERNAL_TIMEOUT || '45000', 10) || 45000);
const SEARCH_QUERY_TIMEOUT_MS = Math.max(12000, parseInt(process.env.GS_SEARCH_TIMEOUT || '22000', 10) || 22000);
const DIRECT_FETCH_TIMEOUT_MS = Math.max(4500, parseInt(process.env.GS_DIRECT_FETCH_TIMEOUT || '5500', 10) || 5500);
const MAX_CACHE_ITEMS        = 500;
const FS_CIRCUIT_THRESHOLD   = 3;
const FS_CIRCUIT_RESET_MS    = 60_000;
const DEBUG_GS              = ['1', 'true', 'yes', 'on'].includes(String(process.env.GUARDOSERIE_DEBUG || '').trim().toLowerCase());
const DEBUG_CF              = DEBUG_GS || ['1', 'true', 'yes', 'on'].includes(String(process.env.GUARDOSERIE_DEBUG_CF || process.env.FLARESOLVERR_DEBUG || '').trim().toLowerCase());

function gsDebug(message, meta = null) {
  if (!DEBUG_GS && !DEBUG_CF) return;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[GuardoSerie:debug] ${message}${suffix}`);
}

const COMPILED_DIRECT_REGEX  = new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig');
const COMPILED_ESCAPED_REGEX = new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig');

const GOT_HEADER_OPTIONS = {
  browsers:         [{ name: 'chrome', minVersion: 120, maxVersion: 124 }],
  devices:          ['desktop'],
  operatingSystems: ['windows', 'macos'],
  locales:          ['it-IT', 'it', 'en-US']
};

const agentOptions = {
  keepAlive:     true,
  maxSockets:    250,
  maxFreeSockets: 100,
  timeout:       30000,
  keepAliveMsecs: 30000
};
const httpsAgent = new https.Agent(agentOptions);
const httpAgent  = new http.Agent(agentOptions);

const lightClient = axios.create({
  timeout:        10000,
  httpAgent,
  httpsAgent,
  validateStatus: s => s >= 200 && s < 500,
  headers:        { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' }
});

class LRUCache {
  constructor(maxSize) {
    this._max = maxSize;
    this._map = new Map();
  }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this._max) this._map.delete(this._map.keys().next().value);
    this._map.set(key, val);
  }
  delete(key) { this._map.delete(key); }
  get size()   { return this._map.size; }
}

const requestCache    = new LRUCache(MAX_CACHE_ITEMS);
const pendingRequests = new Map();
const getGotScrapingClient = createGotScrapingLoader({ failSoft: false });

async function gotSiteRequest(url, {
  method       = 'GET',
  body         = null,
  headers      = {},
  timeout      = 15000,
  signal       = null,
  responseType = 'text',
  maxRedirects = 8,
  useHttp2     = true
} = {}) {
  const gotScraping = await getGotScrapingClient();

  const lockedUA      = headers['User-Agent'] || headers['user-agent'] || null;
  const sessionCookies = headers['Cookie'] || headers['cookie'] || null;

  const opts = {
    url,
    method,
    body:             body || undefined,
    headers,
    timeout:          { request: timeout, connect: 6000, response: timeout },
    signal,
    responseType,
    throwHttpErrors:  false,
    followRedirect:   true,
    maxRedirects,
    http2:            useHttp2,
    retry: {
      limit:       2,
      methods:     ['GET'],
      statusCodes: [408, 413, 500, 502, 504],
      calculateDelay: ({ computedValue, error }) =>
        error?.response?.statusCode === 429
          ? 2000 + Math.random() * 1500
          : computedValue + Math.random() * 400
    },
    agent: { http: httpAgent, https: httpsAgent }
  };

  if (!lockedUA) {
    opts.headerGeneratorOptions = GOT_HEADER_OPTIONS;
  }

  if (sessionCookies) {
    opts.hooks = {
      beforeRedirect: [
        options => {
          if (!options.headers['Cookie'] && !options.headers['cookie']) {
            options.headers['Cookie'] = sessionCookies;
          }
        }
      ]
    };
  }

  const res = await gotScraping(opts);
  return {
    status:  res.statusCode,
    headers: res.headers || {},
    data:    res.body,
    url:     res.url || url
  };
}

function normalizeBaseUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return `${u.protocol}//${u.host}`;
  } catch (_) { return null; }
}

function loadStoredDomain() {
  try {
    if (!fs.existsSync(DOMAIN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(DOMAIN_FILE, 'utf8'));
    return normalizeBaseUrl(data?.baseUrl) || null;
  } catch (_) { return null; }
}

function saveStoredDomain(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return;
  try {
    fs.writeFileSync(DOMAIN_FILE, JSON.stringify({ baseUrl: normalized, updatedAt: Date.now() }, null, 2));
  } catch (_) {}
}

let currentGsDomain      = loadStoredDomain() || INITIAL_GS_DOMAIN;
let lastDomainRefresh    = 0;
let domainRefreshPromise = null;
let activeSession        = {};

function getTargetDomain() { return currentGsDomain; }

function updateCurrentDomainFromUrl(url) {
  const nextBase = normalizeBaseUrl(url);
  if (!nextBase || nextBase === currentGsDomain) return false;
  currentGsDomain = nextBase;
  saveStoredDomain(nextBase);
  if (activeSession?.url) {
    activeSession.url       = nextBase;
    activeSession.timestamp = Date.now();
    saveSession(activeSession);
  }
  return true;
}

async function resolveRedirectDomain(startBase, signal = null) {
  const base = normalizeBaseUrl(startBase);
  if (!base) return null;
  try {
    const probeUA = activeSession?.userAgent || pickRandomProfile(BROWSER_PROFILES).ua;
    const res = await gotSiteRequest(base, {
      timeout:      DOMAIN_TIMEOUT_MS,
      maxRedirects: 8,
      signal,
      useHttp2:     false,
      headers: {
        'User-Agent':    probeUA,
        'Accept':        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma':        'no-cache'
      }
    });
    return normalizeBaseUrl(res.url) || base;
  } catch (_) { return null; }
}

async function refreshTargetDomain(signal = null, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastDomainRefresh < DOMAIN_REFRESH_TTL) return currentGsDomain;
  if (domainRefreshPromise) return domainRefreshPromise;

  domainRefreshPromise = (async () => {
    lastDomainRefresh = Date.now();
    const candidates = Array.from(
      new Map([
        [currentGsDomain, true],
        [loadStoredDomain(), true],
        [INITIAL_GS_DOMAIN, true]
      ].filter(([k]) => k)).keys()
    );
    for (const candidate of candidates) {
      const resolved = await resolveRedirectDomain(candidate, signal);
      if (resolved) { updateCurrentDomainFromUrl(resolved); return currentGsDomain; }
    }
    return currentGsDomain;
  })().finally(() => { domainRefreshPromise = null; });

  return domainRefreshPromise;
}

function buildGsUrl(pathname) {
  const base      = getTargetDomain();
  const cleanPath = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${cleanPath}`;
}

function isSessionFresh(session) {
  return !!(
    session?.cookies &&
    session?.userAgent &&
    session?.timestamp &&
    Date.now() - session.timestamp < CF_SESSION_TTL
  );
}

function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (data?.userAgent) {
      if (data.url) updateCurrentDomainFromUrl(data.url);
      return data;
    }
  } catch (_) {}
  return {};
}

function saveSession(sessionData) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2)); } catch (_) {}
}

function clearSession() {
  activeSession = {};
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
}

activeSession = loadSession();

const flareSolverrClient = createFlareSolverrClient({
  providerName:      PROVIDER_NAME,
  endpoint:          FLARESOLVERR_URL,
  circuitThreshold:  FS_CIRCUIT_THRESHOLD,
  circuitResetMs:    FS_CIRCUIT_RESET_MS,
  isCanceledError,
  onSolution(data) {
    activeSession = data;
    saveSession(data);
    if (data.url) updateCurrentDomainFromUrl(data.url);
  }
});

function parseSingleCookie(raw) {
  const primary = String(raw || '').split(';')[0];
  const eqIdx   = primary.indexOf('=');
  if (eqIdx < 0) return null;
  const key = primary.slice(0, eqIdx).trim();
  const val = primary.slice(eqIdx + 1).trim();
  return key ? [key, val] : null;
}

function updateCookies(existing, setCookieHeader) {
  if (!setCookieHeader) return existing;
  const SKIP      = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
  const cookieMap = new Map();

  if (existing) {
    for (const part of existing.split(';')) {
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) continue;
      const k = part.slice(0, eqIdx).trim();
      const v = part.slice(eqIdx + 1).trim();
      if (k && !SKIP.has(k.toLowerCase())) cookieMap.set(k, v);
    }
  }

  const hdrs = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of hdrs) {
    const parsed = parseSingleCookie(h);
    if (parsed && !SKIP.has(parsed[0].toLowerCase())) cookieMap.set(parsed[0], parsed[1]);
  }

  return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function executeSmartFetch(url, isPost = false, body = null, signal = null, allowFlareSolverr = true, timeoutMs = DIRECT_FETCH_TIMEOUT_MS) {
  const startedAt = Date.now();
  const method = isPost ? 'POST' : 'GET';

  const buildSessionHeaders = session => {
    const headers = {
      'User-Agent':                session.userAgent,
      'Cookie':                    session.cookies,
      'Referer':                   getTargetDomain(),
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language':           'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Fetch-Dest':            'document',
      'Sec-Fetch-Mode':            'navigate',
      'Sec-Fetch-Site':            'same-origin',
      'Upgrade-Insecure-Requests': '1'
    };

    if (isPost && body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    return headers;
  };

  const isGoodHtml = (html, status = 200) => {
    const raw = typeof html === 'string' ? html : String(html || '');
    if (!raw || status === 403 || status === 429 || status === 503) return false;
    if (isCloudflareChallenge(raw)) return false;
    return true;
  };

  const persistSession = (session, resolvedUrl = null, setCookie = null) => {
    if (!session?.userAgent) return;
    const next = {
      ...session,
      url:       normalizeBaseUrl(resolvedUrl || session.url) || session.url || getTargetDomain(),
      timestamp: Date.now()
    };
    if (setCookie) next.cookies = updateCookies(session.cookies, setCookie);
    activeSession = next;
    saveSession(activeSession);
    if (next.url) updateCurrentDomainFromUrl(next.url);
  };

  const fetchWithSession = async session => {
    if (!isSessionFresh(session)) return null;

    const res = await gotSiteRequest(url, {
      method,
      body:     isPost ? body : null,
      headers:  buildSessionHeaders(session),
      timeout:  timeoutMs,
      signal,
      useHttp2: true
    });

    updateCurrentDomainFromUrl(res.url);

    const html = typeof res.data === 'string'
      ? res.data
      : String(res.data || '');

    if (!isGoodHtml(html, res.status)) {
      gsDebug('session fetch rejected', { method, url, status: res.status, ms: Date.now() - startedAt });
      clearSession();
      return null;
    }

    persistSession(session, res.url, res.headers?.['set-cookie']);
    gsDebug('session fetch ok', { method, url, status: res.status, bytes: html.length, ms: Date.now() - startedAt });
    return html;
  };

  if (isSessionFresh(activeSession)) {
    try {
      const html = await fetchWithSession(activeSession);
      if (html) return html;
    } catch (e) {
      if (isCanceledError(e)) throw e;
      gsDebug('session fetch error', { method, url, error: e?.message || String(e), ms: Date.now() - startedAt });
    }
  }

  if (!allowFlareSolverr) return null;

  gsDebug('flaresolverr request', { method, url, endpoint: FLARESOLVERR_URL });
  const session = await flareSolverrClient.getClearance(url, {
    method,
    body,
    signal
  });

  if (!isSessionFresh(session)) {
    gsDebug('flaresolverr no fresh session', { method, url, ms: Date.now() - startedAt });
    return null;
  }

  if (isGoodHtml(session.response, 200)) {
    persistSession(session, session.url || url);
    const html = String(session.response || '');
    gsDebug('flaresolverr response used directly', { method, url, bytes: html.length, ms: Date.now() - startedAt });
    return html;
  }

  try {
    const html = await fetchWithSession(session);
    if (html) return html;
  } catch (e) {
    if (isCanceledError(e)) throw e;
    gsDebug('post-flaresolverr fetch error', { method, url, error: e?.message || String(e), ms: Date.now() - startedAt });
    clearSession();
  }

  return null;
}

async function smartFetch(url, { isPost = false, body = null, ttl = TTL_SEARCH, signal = null, allowFlareSolverr = true, timeoutMs = DIRECT_FETCH_TIMEOUT_MS } = {}) {
  const cacheKey = `${isPost ? 'POST' : 'GET'}:${url}:${body || ''}`;
  const cached   = requestCache.get(cacheKey);

  if (cached) {
    const now = Date.now();
    if (now < cached.expires) return cached.data;
    if (cached.stale && now < cached.stale && !pendingRequests.has(cacheKey)) {
      setImmediate(() => smartFetch(url, { isPost, body, ttl, signal, allowFlareSolverr, timeoutMs }).catch(() => {}));
      return cached.data;
    }
    requestCache.delete(cacheKey);
  }

  if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);

  const fetchPromise = executeSmartFetch(url, isPost, body, signal, allowFlareSolverr, timeoutMs)
    .then(html => {
      if (html) {
        requestCache.set(cacheKey, {
          data:    html,
          expires: Date.now() + ttl,
          stale:   Date.now() + ttl * 2
        });
      }
      return html;
    })
    .finally(() => pendingRequests.delete(cacheKey));

  pendingRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

const IT_STOPWORDS = /\b(the|a|an|un|una|il|lo|la|gli|le|di|de|del|della|degli|delle|dei|alle|nei|nelle|negli|serie|stagione|season|episodio|episode)\b/g;

function normalizeText(val) {
  return String(val || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(IT_STOPWORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(val) {
  return String(val || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTitleScore(candidate, title, originalTitle) {
  const cand      = normalizeText(candidate);
  const primary   = normalizeText(title);
  const secondary = normalizeText(originalTitle);
  if (!cand) return 0;
  if (cand === primary || (secondary && cand === secondary)) return 3;
  if (
    (primary   && (cand.includes(primary)   || primary.includes(cand))) ||
    (secondary && (cand.includes(secondary) || secondary.includes(cand)))
  ) return 2;

  const candTokens  = new Set(cand.split(' ').filter(Boolean));
  const titleTokens = Array.from(new Set(`${primary} ${secondary}`.trim().split(' ').filter(Boolean)));
  if (!titleTokens.length) return 0;

  let hits = 0;
  for (const token of titleTokens) if (candTokens.has(token)) hits++;
  const ratio = hits / titleTokens.length;
  return ratio >= 0.75 ? 2 : ratio >= 0.45 ? 1 : 0;
}

function uniqueCleanStrings(values = [], max = 12) {
  const out  = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2) continue;
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeTitleScoreMany(candidate, titles = []) {
  let best = 0;
  for (const title of uniqueCleanStrings(titles, 16)) {
    best = Math.max(best, normalizeTitleScore(candidate, title, null));
    if (best >= 3) break;
  }
  return best;
}

async function buildSharedAnimeContext(meta = {}, config = {}, season = null, episode = null) {
  try {
    const context = await animeIdentity.buildAnimeSearchContextForProvider({
      requestId:  meta?.requestedId || meta?.id || meta?.imdb_id || meta?.tmdb_id || null,
      originalId: meta?.originalId || null,
      finalId:    meta?.id || meta?.imdb_id || meta?.tmdb_id || null,
      meta,
      config,
      season,
      episode,
      providerName: 'GuardoSerie'
    });
    if (context?.isAnime || context?.searchTitles?.length || context?.rawTitles?.length) return context;
  } catch (error) {
    console.warn('[GuardoSerie] shared anime context failed:', error.message);
  }
  return null;
}

function getKitsuRequestFromMeta(meta = {}) {
  const candidates = uniqueCleanStrings([
    meta?.requestedId,
    meta?.originalId,
    meta?.sourceId,
    meta?.source_id,
    meta?.stremioId,
    meta?.stremio_id,
    meta?.canonicalId,
    meta?.canonical_id,
    meta?.id,
    meta?.kitsu_id,
    meta?.kitsuId,
    meta?.kitsu
  ], 40);

  for (const candidate of candidates) {
    const parsed = kitsuProvider.parseKitsuId(candidate);
    if (parsed?.kitsuId) return { requestId: candidate, parsed };
  }

  for (const value of [meta?.kitsu_id, meta?.kitsuId, meta?.kitsu]) {
    const text = String(value || '').trim();
    if (/^\d+$/.test(text)) return { requestId: `kitsu:${text}`, parsed: { kitsuId: text, seasonNumber: null, episodeNumber: null } };
  }

  return null;
}

function buildGsKitsuProviderContext(meta = {}, config = {}, kitsuInfo = null, episodeNumber = 1) {
  const providerContext = animeProviderUtils.buildAnimeProviderContext({
    ...meta,
    id:      kitsuInfo?.requestId || meta?.id || meta?.requestedId || null,
    kitsuId: kitsuInfo?.parsed?.kitsuId || meta?.kitsuId || meta?.kitsu_id || meta?.kitsu || null,
    episode: episodeNumber
  });
  providerContext.mappingLanguage  = 'it';
  providerContext.italianOnly      = true;
  providerContext.onlyItalian      = true;
  providerContext.mappingTimeoutMs = 6000;
  providerContext.mappingRetries   = 2;

  if (Array.isArray(config?.mappingApiBases))          providerContext.mappingApiBases = config.mappingApiBases;
  if (Array.isArray(config?.mappingMirrors))           providerContext.mappingApiBases = config.mappingMirrors;
  if (Array.isArray(config?.filters?.mappingApiBases)) providerContext.mappingApiBases = config.filters.mappingApiBases;
  if (Array.isArray(config?.filters?.mappingMirrors))  providerContext.mappingApiBases = config.filters.mappingMirrors;

  return providerContext;
}

async function fetchStrictKitsuMapping(meta = {}, config = {}, kitsuInfo = null, requestedEpisode = 1) {
  const kitsuId = kitsuInfo?.parsed?.kitsuId;
  if (!kitsuId) return null;
  const episodeNumber   = parseInt(requestedEpisode, 10) || kitsuInfo?.parsed?.episodeNumber || parseInt(meta?.episode, 10) || 1;
  const providerContext = buildGsKitsuProviderContext(meta, config, kitsuInfo, episodeNumber);
  const lookup = {
    provider:    'kitsu',
    externalId:  String(kitsuId),
    season:      null,
    episode:     episodeNumber,
    contentType: 'anime'
  };
  try {
    return await animeProviderUtils.fetchMappingPayload(lookup, providerContext);
  } catch (error) {
    console.warn('[GuardoSerie][KITSU] mapping failed:', error.message);
    return null;
  }
}

function resolveStrictKitsuEpisodeForGs(mappingPayload, fallbackEpisode) {
  const requested    = parseInt(fallbackEpisode, 10) || 1;
  const fromKitsu    = parseInt(mappingPayload?.kitsu?.episode, 10);
  const fromRequested = parseInt(mappingPayload?.requested?.episode, 10);
  if (Number.isInteger(fromKitsu)    && fromKitsu > 0    && fromKitsu === requested)    return fromKitsu;
  if (Number.isInteger(fromRequested) && fromRequested > 0 && fromRequested === requested) return fromRequested;
  return requested;
}

function extractGsMappingEntries(mappingPayload) {
  const mappings = mappingPayload?.mappings || mappingPayload?.mapping || {};
  const raw      = mappings.guardoserie || mappings.guardoSerie || mappings.guardaserie || mappings.gs || null;
  const list     = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out      = [];

  for (const entry of list) {
    const value = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object'
        ? entry.path || entry.url || entry.href || entry.watchPath || entry.playPath || null
        : null;
    if (!value) continue;
    try {
      out.push(/^https?:\/\//i.test(String(value)) ? String(value) : buildGsUrl(String(value)));
    } catch (_) {}
  }

  return Array.from(new Set(out.filter(Boolean)));
}

async function buildStrictKitsuAnimeContext(meta = {}, config = {}, season = null, episode = null) {
  const kitsuInfo = getKitsuRequestFromMeta(meta);
  if (!kitsuInfo?.parsed?.kitsuId) return null;

  const requestedEpisode = kitsuInfo.parsed.episodeNumber || parseInt(episode, 10) || parseInt(meta?.episode, 10) || 1;
  const requestId        = kitsuInfo.requestId || `kitsu:${kitsuInfo.parsed.kitsuId}:${requestedEpisode}`;
  let context            = null;

  try {
    context = await kitsuProvider.buildSearchContext(requestId, { ...meta, season, episode: requestedEpisode });
  } catch (error) {
    console.warn('[GuardoSerie][KITSU] context failed:', error.message);
  }

  const mappingPayload = await fetchStrictKitsuMapping(meta, config, kitsuInfo, requestedEpisode);
  const strictEpisode  = resolveStrictKitsuEpisodeForGs(mappingPayload, requestedEpisode);
  const rawTitles      = uniqueCleanStrings([
    ...(Array.isArray(context?.rawTitles)    ? context.rawTitles    : []),
    ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
    ...(Array.isArray(context?.info?.titles) ? context.info.titles  : []),
    context?.info?.canonicalTitle,
    context?.title,
    meta?.title,
    meta?.name,
    meta?.originalTitle,
    meta?.canonicalTitle,
    meta?.seriesTitle
  ], 24);

  const searchTitles = uniqueCleanStrings([
    ...kitsuProvider.buildTitleVariants(rawTitles),
    ...rawTitles
  ], 24);

  return {
    ...(context || {}),
    isAnime:           true,
    strictKitsu:       true,
    kitsuId:           String(kitsuInfo.parsed.kitsuId),
    rawTitles,
    searchTitles,
    title:             searchTitles[0] || rawTitles[0] || meta?.title || null,
    seasonNumber:      parseInt(context?.seasonNumber, 10) || parseInt(season, 10) || parseInt(meta?.season, 10) || 1,
    requestedEpisode:  strictEpisode,
    episodeCandidates: [strictEpisode],
    mappingPayload,
    mappingUrls:       extractGsMappingEntries(mappingPayload),
    tmdbId:            null,
    imdbId:            null,
    mappedIds:         null,
    identitySources:   ['kitsu', mappingPayload ? 'mapping:kitsu' : null].filter(Boolean)
  };
}

function normalizeStreamUrl(url) {
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch (_) { return String(url || ''); }
}

function getStreamPriority(stream) {
  return Number.isFinite(stream?.extra?._priority) ? stream.extra._priority : 9;
}

function isLikelyPlayerUrl(url) {
  return /(mixdrop|m1xdrop|voe|loadm|rpmshare|rpmplay|maxstream|supervideo|dood|streamtape|vixsrc|vixcloud|filemoon|dropload|dr0pstream|mxcontent)/i.test(url);
}

function extractSearchResultsFromHtml(html, baseUrl) {
  if (!html) return [];
  const $       = cheerio.load(String(html));
  const results = [];
  const seen    = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/(\/serie\/|\/episodio\/)/i.test(href)) return;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (!seen.has(absolute)) {
        seen.add(absolute);
        results.push({
          url:   absolute,
          title: String($(el).attr('title') || $(el).text() || '').trim() || absolute
        });
      }
    } catch (_) {}
  });

  return results;
}

async function searchProviderSequential(query, signal) {
  const startedAt = Date.now();
  const baseUrl     = await refreshTargetDomain(signal);
  const ajaxUrl     = `${baseUrl}/wp-admin/admin-ajax.php`;
  const ajaxBody    = `s=${encodeURIComponent(query)}&action=searchwp_live_search&swpengine=default&swpquery=${encodeURIComponent(query)}`;
  const fallbackUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;

  const [ajaxHtml, fallbackHtml] = await Promise.all([
    smartFetch(ajaxUrl, {
      isPost: true,
      body: ajaxBody,
      ttl: TTL_SEARCH,
      signal,
      allowFlareSolverr: true,
      timeoutMs: SEARCH_QUERY_TIMEOUT_MS
    }).catch((e) => {
      if (isCanceledError(e)) throw e;
      gsDebug('ajax search failed', { query, error: e?.message || String(e) });
      return '';
    }),
    smartFetch(fallbackUrl, {
      ttl: TTL_SEARCH,
      signal,
      allowFlareSolverr: true,
      timeoutMs: SEARCH_QUERY_TIMEOUT_MS
    }).catch((e) => {
      if (isCanceledError(e)) throw e;
      gsDebug('fallback search failed', { query, error: e?.message || String(e) });
      return '';
    })
  ]);

  const results = [
    ...extractSearchResultsFromHtml(ajaxHtml, baseUrl),
    ...extractSearchResultsFromHtml(fallbackHtml, baseUrl)
  ];

  const unique = Array.from(new Map(results.map(item => [item.url, item])).values());
  gsDebug('search query done', { query, results: unique.length, ms: Date.now() - startedAt });
  return unique;
}

function createTimeoutSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason ?? 'parent aborted');
    return { signal: controller.signal, clear: () => {} };
  }

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason ?? 'parent aborted');
  };

  if (parentSignal) parentSignal.addEventListener('abort', abortFromParent, { once: true });

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort('timeout');
  }, timeoutMs);

  if (timer?.unref) timer.unref();

  return {
    signal: controller.signal,
    clear:  () => {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    }
  };
}

async function searchProviderWithTimeout(query, signal, timeoutMs = SEARCH_QUERY_TIMEOUT_MS) {
  const scoped = createTimeoutSignal(signal, timeoutMs);
  try {
    return await searchProviderSequential(query, scoped.signal);
  } catch (e) {
    if (isCanceledError(e) || scoped.signal.aborted) return [];
    return [];
  } finally {
    scoped.clear();
  }
}

async function searchProviderParallel(queries, signal) {
  const uniqueQueries = Array.from(new Set(queries.filter(Boolean)));
  if (!uniqueQueries.length) return [];
  const results = await Promise.all(uniqueQueries.map(q => searchProviderWithTimeout(q, signal)));
  return results.flat();
}

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode, options = {}) {
  const raw = String(pageHtml || '');
  if (!raw) return null;

  const targetSeason  = parseInt(season, 10);
  const targetEpisode = parseInt(episode, 10);
  if (
    !Number.isInteger(targetSeason)  || !Number.isInteger(targetEpisode) ||
    targetSeason < 1                 || targetEpisode < 1
  ) return null;

  const $ = cheerio.load(raw);

  const readSeasonNumber = text => {
    const match = String(text || '').match(/\b(?:stagione|season)\s*-?\s*(\d+)\b/i);
    return match ? parseInt(match[1], 10) : null;
  };

  const readEpisodeNumber = text => {
    const s     = String(text || '');
    const match =
      s.match(/\b(?:episodio|episode|ep)\s*-?\s*(\d+)\b/i) ||
      s.match(/\bs\d{1,2}e(\d{1,3})\b/i) ||
      s.match(/\b\d{1,2}x(\d{1,3})\b/i);
    return match ? parseInt(match[1], 10) : null;
  };

  const findEpisodeInBlock = block => {
    const links = $(block).find('.les-content a[href*="/episodio/"], a[href*="/episodio/"]').toArray();
    for (const el of links) {
      const href  = $(el).attr('href') || '';
      const epNum = readEpisodeNumber(`${$(el).text()} ${href}`);
      if (epNum === targetEpisode) return href || null;
    }
    if (options?.strictEpisode) return null;
    return links.length >= targetEpisode ? ($(links[targetEpisode - 1]).attr('href') || null) : null;
  };

  const seasonBlocks = $('.tvseason').toArray();
  for (const block of seasonBlocks) {
    const seasonNum = readSeasonNumber($(block).find('.les-title').first().text());
    if (seasonNum !== targetSeason) continue;
    const href = findEpisodeInBlock(block);
    if (href) return href;
  }

  if (seasonBlocks.length >= targetSeason) {
    const href = options?.strictEpisode ? null : findEpisodeInBlock(seasonBlocks[targetSeason - 1]);
    if (href) return href;
  }

  let matchedHref = null;
  $('a[href*="/episodio/"]').each((_, el) => {
    const href      = $(el).attr('href') || '';
    const text      = `${$(el).text()} ${href}`;
    const seasonNum = readSeasonNumber(text);
    const epNum     = readEpisodeNumber(text);
    if (seasonNum === targetSeason && epNum === targetEpisode) {
      matchedHref = href;
      return false;
    }
  });

  if (matchedHref) return matchedHref;

  const directEpisodeRegexes = [
    new RegExp(`/episodio/[^"'\\s<>]*stagione-0?${targetSeason}-episodio-0?${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i'),
    new RegExp(`/episodio/[^"'\\s<>]*s0?${targetSeason}e0?${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i'),
    new RegExp(`/episodio/[^"'\\s<>]*${targetSeason}x${targetEpisode}(?=[/?#"'\\s<>]|$)`, 'i')
  ];

  for (const re of directEpisodeRegexes) {
    const match = raw.match(re);
    if (match?.[0]) return match[0];
  }

  const sIdx = targetSeason  - 1;
  const eIdx = targetEpisode - 1;
  if (sIdx < 0 || eIdx < 0) return null;

  const legacySeasonBlocks = $('.les-content, [class*="season-"], [class*="stagione-"]');
  if (!options?.strictEpisode && legacySeasonBlocks.length > sIdx) {
    const block    = legacySeasonBlocks.eq(sIdx);
    const episodes = block.find('a[href*="/episodio/"]');
    if (episodes.length > eIdx) return episodes.eq(eIdx).attr('href') || null;
  }

  return null;
}

function extractPlayerLinksFromHtml(html) {
  const raw     = String(html || '');
  const links   = new Set();
  const baseUrl = normalizeBaseUrl(getTargetDomain()) || INITIAL_GS_DOMAIN;

  const normalize = link => {
    let n = String(link).trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
    if (!n || n.startsWith('data:')) return null;
    if (n.startsWith('//')) return `https:${n}`;
    if (n.startsWith('/'))  return `${baseUrl}${n}`;
    if (!/^https?:\/\//i.test(n) && /(loadm|mixdrop|m1xdrop|mxcontent)/i.test(n)) {
      return `https://${n.replace(/^\/+/, '')}`;
    }
    return /^https?:\/\//i.test(n) ? n : null;
  };

  const iframeTags = raw.match(/<iframe\b[^>]*>/ig) || [];
  for (const tag of iframeTags) {
    const attrRegex = /\b(?:data-src|src)\s*=\s*(['"])(.*?)\1/ig;
    let m;
    while ((m = attrRegex.exec(tag)) !== null) {
      const c = normalize(m[2]);
      if (c && isLikelyPlayerUrl(c)) links.add(c);
    }
  }

  for (const regex of [COMPILED_DIRECT_REGEX, COMPILED_ESCAPED_REGEX]) {
    regex.lastIndex = 0;
    for (const m of raw.match(regex) || []) {
      const c = normalize(m);
      if (c && isLikelyPlayerUrl(c)) links.add(c);
    }
  }

  return Array.from(links);
}

async function asyncPool(limit, items, asyncFn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  const queue   = items.map((item, i) => ({ item, i }));
  const running = new Set();

  async function runNext() {
    if (!queue.length) return;
    const { item, i } = queue.shift();
    const p = Promise.resolve()
      .then(() => asyncFn(item))
      .catch(e => { if (!isCanceledError(e)) return null; throw e; })
      .then(result => { results[i] = result; running.delete(p); return runNext(); });
    running.add(p);
    return p;
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function searchGuardaserie(meta, config) {
  if (!meta?.isSeries || !config?.filters?.enableGs) return [];

  const kitsuInfo = getKitsuRequestFromMeta(meta);
  let season      = parseInt(meta?.season, 10);
  let episode     = parseInt(meta?.episode, 10) || kitsuInfo?.parsed?.episodeNumber || 1;

  if ((!season || season < 1) && kitsuInfo?.parsed?.kitsuId) season = kitsuInfo.parsed.seasonNumber || 1;
  if (!season || season < 1 || !episode || episode < 1) return [];

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

  try {
    return await _searchGuardaserie(meta, config, season, episode, controller.signal);
  } catch (e) {
    gsDebug('provider failed', { error: e?.message || String(e) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function _searchGuardaserie(meta, config, season, episode, signal) {
  await refreshTargetDomain(signal);

  const strictKitsuContext = await buildStrictKitsuAnimeContext(meta, config, season, episode);
  const animeContext       = strictKitsuContext || await buildSharedAnimeContext(meta, config, season, episode);
  const strictKitsu        = Boolean(animeContext?.strictKitsu);

  if (animeContext?.isAnime) {
    const mappedSeason  = parseInt(animeContext.seasonNumber, 10);
    const mappedEpisode = parseInt(animeContext.requestedEpisode, 10);
    if (mappedSeason > 0)  season  = mappedSeason;
    if (mappedEpisode > 0) episode = mappedEpisode;
  }

  let tmdbId = strictKitsu ? null : (meta?.tmdb_id || meta?.tmdbId || animeContext?.tmdbId || animeContext?.mappedIds?.tmdbId || null);

  if (!strictKitsu && !tmdbId && (meta?.imdb_id || animeContext?.imdbId)) {
    const resolved = await tmdbHelper.getTmdbFromImdb(meta.imdb_id || animeContext.imdbId, { mediaHint: 'tv' }).catch(() => null);
    if (resolved) tmdbId = resolved;
  }

  let showName     = strictKitsu ? (animeContext?.title || meta?.title || meta?.name || null) : (meta?.title || animeContext?.title || null);
  let originalTitle = animeContext?.rawTitles?.find(title => normalizeText(title) !== normalizeText(showName)) || null;
  let targetYear   = animeContext?.year || null;

  if (tmdbId) {
    const tmdbMeta = await tmdbHelper.getMediaInfoFull(tmdbId, 'tv', { language: 'it-IT' }).catch(() => null);
    if (tmdbMeta) {
      showName      = tmdbMeta.title         || showName;
      originalTitle = tmdbMeta.original_title || originalTitle || null;
      targetYear    = tmdbMeta.year          || targetYear    || null;
    }
  }

  const expectedTitles = uniqueCleanStrings([
    showName,
    originalTitle,
    ...(Array.isArray(animeContext?.searchTitles) ? animeContext.searchTitles : []),
    ...(Array.isArray(animeContext?.rawTitles)    ? animeContext.rawTitles    : []),
    meta?.name,
    meta?.originalTitle,
    meta?.canonicalTitle,
    meta?.seriesTitle
  ], 14);

  showName = showName || expectedTitles[0] || null;
  if (!showName) return [];

  const queries       = uniqueCleanStrings(expectedTitles, animeContext?.isAnime ? 8 : 4);
  const mappedResults = (Array.isArray(animeContext?.mappingUrls) ? animeContext.mappingUrls : [])
    .map(url => ({ url, title: showName || url, mapped: true }));
  let allResults = [...mappedResults, ...await searchProviderParallel(queries, signal)];
  allResults     = Array.from(new Map(allResults.map(i => [i.url, i])).values());

  const seriesResults  = allResults.filter(r => /\/serie\//i.test(r.url));
  const episodeResults = allResults.filter(r => /\/episodio\//i.test(r.url));
  allResults = strictKitsu && seriesResults.length ? seriesResults : [...seriesResults, ...episodeResults];

  allResults.sort((a, b) =>
    normalizeTitleScoreMany(b.title, expectedTitles) -
    normalizeTitleScoreMany(a.title, expectedTitles)
  );

  let target = null, bestLoose = null;

  for (const result of allResults) {
    const titleScore = normalizeTitleScoreMany(result.title, expectedTitles);
    if (titleScore < 1) continue;

    const html = await smartFetch(result.url, { ttl: TTL_SERIES, signal, allowFlareSolverr: true, timeoutMs: DIRECT_FETCH_TIMEOUT_MS });
    if (!html) continue;

    const foundYear =
      html.match(/release-year\/(\d{4})/i)?.[1] ||
      html.match(/\b(19\d{2}|20\d{2})\b/)?.[1]  ||
      null;

    if (targetYear && foundYear) {
      const allowedYearDelta = titleScore >= 3 ? 3 : 1;
      if (Math.abs(Number(foundYear) - Number(targetYear)) <= allowedYearDelta) {
        target = { url: result.url, html };
        break;
      }
    } else if (titleScore >= (bestLoose?.score || 0)) {
      bestLoose = { url: result.url, html, score: titleScore };
      if (titleScore >= 2) break;
    }
  }

  if (!target && bestLoose) target = bestLoose;

  if (!target) {
    const slugs = uniqueCleanStrings(expectedTitles, 8).map(slugify).filter(Boolean);
    outer: for (const slug of slugs) {
      for (const p of [`/serie/${slug}/`, `/${slug}/`, `/serietv/${slug}/`]) {
        const url  = buildGsUrl(p);
        const html = await smartFetch(url, { ttl: TTL_SERIES, signal, allowFlareSolverr: true, timeoutMs: DIRECT_FETCH_TIMEOUT_MS });
        if (html) {
          const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
          if (normalizeTitleScoreMany(pageTitle, expectedTitles) >= 2) {
            target = { url, html };
            break outer;
          }
        }
      }
    }
  }

  if (!target?.url) return [];

  const episodeUrl    = extractEpisodeUrlFromSeriesPage(target.html, season, episode, { strictEpisode: strictKitsu });
  if (!episodeUrl) return [];

  const absoluteEpUrl = new URL(episodeUrl, getTargetDomain()).toString();
  const finalHtml     = await smartFetch(absoluteEpUrl, { ttl: TTL_EPISODE, signal, allowFlareSolverr: true, timeoutMs: DIRECT_FETCH_TIMEOUT_MS });
  const playerLinks   = Array.from(new Set(extractPlayerLinksFromHtml(finalHtml))).slice(0, 5);
  if (!playerLinks.length) return [];

  const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const sessionUA  = activeSession.userAgent || pickRandomProfile(BROWSER_PROFILES).ua;

  const processedResults = await asyncPool(2, playerLinks, async link => {
    try {
      const extracted = await extractFromUrl(link, {
        client:         lightClient,
        userAgent:      sessionUA,
        requestReferer: getTargetDomain()
      });
      if (!extracted?.url) return null;

      let quality = normalizeQuality(extracted?.quality || 'Unknown');
      if (/\.m3u8($|\?)/i.test(String(extracted.url))) {
        try {
          const probed = await probePlaylistQuality(lightClient, extracted.url, {
            headers: extracted.headers || {},
            timeout: 5000,
            signal
          });
          quality = pickBetterQuality(probed || 'Unknown', quality);
        } catch (_) {}
      }

      return buildWebStream({
        name:         `GuardoSerie | ${extracted.name}`,
        title:        `${cleanTitle}\n ${extracted.name}  ITA`,
        url:          extracted.url,
        extractor:    extracted.name,
        provider:     'GuardoSerie',
        providerCode: 'GS',
        quality,
        headers:      extracted.headers,
        extra:        { _priority: extracted.priority ?? 9 }
      });
    } catch (_) { return null; }
  });

  return processedResults
    .filter(Boolean)
    .sort((a, b) => {
      const qDelta = qualityRank(b.quality) - qualityRank(a.quality);
      return qDelta !== 0 ? qDelta : getStreamPriority(a) - getStreamPriority(b);
    })
    .filter((s, i, arr) => {
      const key = normalizeStreamUrl(s.url);
      return arr.findIndex(x => normalizeStreamUrl(x.url) === key) === i;
    })
    .map(s => {
      if (s.extra) delete s.extra._priority;
      delete s._priority;
      return s;
    });
}

module.exports = { searchGuardaserie, searchGuardoSerie: searchGuardaserie };
