'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const animeIdentity = require('../anime/anime_identity');
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

const INITIAL_GS_DOMAIN       = 'https://guardoserie.garden';
const BROWSER_PROFILES         = GUARDA_SERIE_BROWSER_PROFILES;
const FLARESOLVERR_URL         = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191/v1';
const PROVIDER_NAME            = 'guardoserie';
const SESSION_FILE             = path.join(process.cwd(), `cf-session-${PROVIDER_NAME}.json`);
const DOMAIN_FILE              = path.join(process.cwd(), `${PROVIDER_NAME}-domain.json`);
const DOMAIN_REFRESH_TTL       = 1000 * 60 * 20;
const DOMAIN_TIMEOUT_MS        = 8000;
const TTL_SEARCH               = 1000 * 60 * 30;
const TTL_EPISODE              = 1000 * 60 * 30;
const TTL_SERIES               = 1000 * 60 * 60 * 6;
const CF_SESSION_TTL           = 1000 * 60 * 60 * 6;
const GLOBAL_TIMEOUT_MS        = 25000;
const SEARCH_QUERY_TIMEOUT_MS  = 12000;
const MAX_CACHE_ITEMS          = 500;
const FS_CIRCUIT_THRESHOLD     = 3;
const FS_CIRCUIT_RESET_MS      = 60_000;

const COMPILED_DIRECT_REGEX  = new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig');
const COMPILED_ESCAPED_REGEX = new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig');

const agentOptions = {
  keepAlive: true,
  maxSockets: 250,
  maxFreeSockets: 100,
  timeout: 30000,
  keepAliveMsecs: 30000
};
const httpsAgent = new https.Agent(agentOptions);
const httpAgent  = new http.Agent(agentOptions);

const lightClient = axios.create({
  timeout: 10000,
  httpAgent,
  httpsAgent,
  validateStatus: s => s >= 200 && s < 500,
  headers: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' }
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
const activeBypasses  = new Map();

const flareSolverrBreaker = {
  failures: 0,
  lastFailure: 0,
  isOpen() {
    if (this.failures < FS_CIRCUIT_THRESHOLD) return false;
    if (Date.now() - this.lastFailure > FS_CIRCUIT_RESET_MS) { this.failures = 0; return false; }
    return true;
  },
  record(ok) {
    if (ok) { this.failures = 0; return; }
    this.failures++;
    this.lastFailure = Date.now();
  }
};

let _gotScrapingClient  = null;
let _gotScrapingPromise = null;

async function getGotScrapingClient() {
  if (_gotScrapingClient) return _gotScrapingClient;
  if (!_gotScrapingPromise) {
    _gotScrapingPromise = import('got-scraping').then(mod => {
      _gotScrapingClient = mod.gotScraping || mod.default || mod;
      return _gotScrapingClient;
    }).catch(e => {
      _gotScrapingPromise = null;
      throw e;
    });
  }
  return _gotScrapingPromise;
}

async function gotSiteRequest(url, {
  method = 'GET',
  body = null,
  headers = {},
  timeout = 15000,
  signal = null,
  responseType = 'text',
  maxRedirects = 8
} = {}) {
  const gotScraping = await getGotScrapingClient();
  const res = await gotScraping({
    url,
    method,
    body: body || undefined,
    headers,
    timeout: { request: timeout },
    signal,
    responseType,
    throwHttpErrors: false,
    followRedirect: true,
    maxRedirects,
    http2: true,
    headerGeneratorOptions: {
      browsers: [
        { name: 'chrome', minVersion: 110 },
        { name: 'firefox', minVersion: 110 },
        { name: 'safari', minVersion: 15 }
      ],
      devices: ['desktop'],
      operatingSystems: ['windows', 'macos', 'linux'],
      locales: ['it-IT', 'en-US', 'en']
    },
    retry: {
      limit: 2,
      methods: ['GET'],
      statusCodes: [408, 413, 429, 500, 502, 503, 504],
      calculateDelay: ({ computedValue }) => computedValue + Math.random() * 500
    },
    agent: { http: httpAgent, https: httpsAgent }
  });
  return {
    status: res.statusCode,
    headers: res.headers || {},
    data: res.body,
    url: res.url || url
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
    activeSession.url = nextBase;
    activeSession.timestamp = Date.now();
    saveSession(activeSession);
  }
  return true;
}

async function resolveRedirectDomain(startBase, signal = null) {
  const base = normalizeBaseUrl(startBase);
  if (!base) return null;
  try {
    const res = await gotSiteRequest(base, {
      timeout: DOMAIN_TIMEOUT_MS,
      maxRedirects: 8,
      signal,
      headers: {
        'User-Agent': activeSession?.userAgent || pickRandomProfile(BROWSER_PROFILES).ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
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
  const base = getTargetDomain();
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

function parseSingleCookie(raw) {
  const primary = String(raw || '').split(';')[0];
  const eqIdx = primary.indexOf('=');
  if (eqIdx < 0) return null;
  const key = primary.slice(0, eqIdx).trim();
  const val = primary.slice(eqIdx + 1).trim();
  return key ? [key, val] : null;
}

function updateCookies(existing, setCookieHeader) {
  if (!setCookieHeader) return existing;
  const SKIP = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
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

  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const parsed = parseSingleCookie(h);
    if (parsed && !SKIP.has(parsed[0].toLowerCase())) cookieMap.set(parsed[0], parsed[1]);
  }

  return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

const CF_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /<div id=["']cf-wrapper["']/i,
  /cf-chl-widget/i,
  /__cf_chl_opt/i,
  /cf\.challenge\.orchestrate/i
];

function looksLikeChallenge(html) {
  if (!html) return false;
  const s = String(html);
  return CF_CHALLENGE_PATTERNS.some(re => re.test(s));
}

function isCanceledError(e) {
  return axios.isCancel(e) ||
    e?.code === 'ERR_CANCELED' ||
    e?.code === 'ABORT_ERR' ||
    e?.name === 'AbortError';
}

async function getClearance(url, provider = PROVIDER_NAME, options = {}) {
  if (flareSolverrBreaker.isOpen()) return null;
  if (activeBypasses.has(provider)) return activeBypasses.get(provider);

  const bypassPromise = (async () => {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * (2 ** (attempt - 1))));
      try {
        const payload = {
          cmd: options.method === 'POST' ? 'request.post' : 'request.get',
          url,
          maxTimeout: 90000,
          session: `session_${provider}`
        };
        if (options.method === 'POST' && options.body) payload.postData = options.body;

        const response = await axios.post(FLARESOLVERR_URL, payload, {
          timeout: 100000,
          signal: options.signal,
          headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok') {
          const solution = response.data?.solution || {};
          const solutionCookies = Array.isArray(solution?.cookies) ? solution.cookies : [];
          const cookies = solutionCookies.map(c => `${c.name}=${c.value}`).join('; ');
          const cf_clearance = solutionCookies.find(c => c.name === 'cf_clearance')?.value || null;
          const data = {
            userAgent: solution.userAgent,
            cookies,
            cf_clearance,
            url: solution.url,
            response: solution.response,
            timestamp: Date.now()
          };
          activeSession = data;
          saveSession(data);
          if (solution.url) updateCurrentDomainFromUrl(solution.url);
          flareSolverrBreaker.record(true);
          return data;
        }
      } catch (e) {
        if (isCanceledError(e)) throw e;
      }
    }
    flareSolverrBreaker.record(false);
    return null;
  })();

  bypassPromise.finally(() => activeBypasses.delete(provider)).catch(() => {});
  activeBypasses.set(provider, bypassPromise);
  return bypassPromise;
}

async function executeSmartFetch(url, isPost = false, body = null, signal = null) {
  if (isSessionFresh(activeSession)) {
    try {
      const headers = {
        'User-Agent': activeSession.userAgent,
        'Cookie': activeSession.cookies,
        'Referer': getTargetDomain(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Upgrade-Insecure-Requests': '1'
      };
      if (isPost && body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

      const res = await gotSiteRequest(url, {
        method: isPost ? 'POST' : 'GET',
        body: isPost ? body : null,
        headers,
        timeout: 15000,
        signal
      });

      updateCurrentDomainFromUrl(res.url);
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});

      if (res.status === 403 || res.status === 503 || looksLikeChallenge(html)) {
        clearSession();
      } else {
        if (res.headers?.['set-cookie']) {
          activeSession.cookies = updateCookies(activeSession.cookies, res.headers['set-cookie']);
          activeSession.timestamp = Date.now();
          saveSession(activeSession);
        }
        return html;
      }
    } catch (e) {
      if (isCanceledError(e)) throw e;
    }
  }

  const session = await getClearance(url, PROVIDER_NAME, { method: isPost ? 'POST' : 'GET', body, signal });
  return session?.response || null;
}

async function smartFetch(url, { isPost = false, body = null, ttl = TTL_SEARCH, signal = null } = {}) {
  const cacheKey = `${isPost ? 'POST' : 'GET'}:${url}:${body || ''}`;
  const cached = requestCache.get(cacheKey);

  if (cached) {
    const now = Date.now();
    if (now < cached.expires) return cached.data;
    if (cached.stale && now < cached.stale && !pendingRequests.has(cacheKey)) {
      setImmediate(() => smartFetch(url, { isPost, body, ttl, signal }).catch(() => {}));
      return cached.data;
    }
    requestCache.delete(cacheKey);
  }

  if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);

  const fetchPromise = executeSmartFetch(url, isPost, body, signal)
    .then(html => {
      if (html) {
        requestCache.set(cacheKey, {
          data: html,
          expires: Date.now() + ttl,
          stale: Date.now() + ttl * 2
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
  const out = [];
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
      requestId: meta?.requestedId || meta?.id || meta?.imdb_id || meta?.tmdb_id || null,
      originalId: meta?.originalId || null,
      finalId: meta?.id || meta?.imdb_id || meta?.tmdb_id || null,
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
  const $ = cheerio.load(String(html));
  const results = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || !/(\/serie\/|\/episodio\/)/i.test(href)) return;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (!seen.has(absolute)) {
        seen.add(absolute);
        results.push({
          url: absolute,
          title: String($(el).attr('title') || $(el).text() || '').trim() || absolute
        });
      }
    } catch (_) {}
  });

  return results;
}

async function searchProviderSequential(query, signal) {
  const baseUrl = await refreshTargetDomain(signal);
  const ajaxUrl  = `${baseUrl}/wp-admin/admin-ajax.php`;
  const ajaxBody = `s=${encodeURIComponent(query)}&action=searchwp_live_search&swpengine=default&swpquery=${encodeURIComponent(query)}`;
  const ajaxHtml = await smartFetch(ajaxUrl, { isPost: true, body: ajaxBody, ttl: TTL_SEARCH, signal });
  const ajaxResults = extractSearchResultsFromHtml(ajaxHtml, baseUrl);
  if (ajaxResults.length > 0) return ajaxResults;

  const fallbackUrl  = `${baseUrl}/?s=${encodeURIComponent(query)}`;
  const fallbackHtml = await smartFetch(fallbackUrl, { ttl: TTL_SEARCH, signal });
  return extractSearchResultsFromHtml(fallbackHtml, baseUrl);
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
    clear: () => {
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

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode) {
  const raw = String(pageHtml || '');
  if (!raw) return null;

  const targetSeason  = parseInt(season, 10);
  const targetEpisode = parseInt(episode, 10);
  if (
    !Number.isInteger(targetSeason) || !Number.isInteger(targetEpisode) ||
    targetSeason < 1 || targetEpisode < 1
  ) return null;

  const $ = cheerio.load(raw);

  const readSeasonNumber = text => {
    const match = String(text || '').match(/\b(?:stagione|season)\s*-?\s*(\d+)\b/i);
    return match ? parseInt(match[1], 10) : null;
  };

  const readEpisodeNumber = text => {
    const s = String(text || '');
    const match =
      s.match(/\b(?:episodio|episode|ep)\s*-?\s*(\d+)\b/i) ||
      s.match(/\bs\d{1,2}e(\d{1,3})\b/i) ||
      s.match(/\b\d{1,2}x(\d{1,3})\b/i);
    return match ? parseInt(match[1], 10) : null;
  };

  const findEpisodeInBlock = block => {
    const links = $(block).find('.les-content a[href*="/episodio/"], a[href*="/episodio/"]').toArray();
    for (const el of links) {
      const href   = $(el).attr('href') || '';
      const epNum  = readEpisodeNumber(`${$(el).text()} ${href}`);
      if (epNum === targetEpisode) return href || null;
    }
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
    const href = findEpisodeInBlock(seasonBlocks[targetSeason - 1]);
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

  const sIdx = targetSeason - 1;
  const eIdx = targetEpisode - 1;
  if (sIdx < 0 || eIdx < 0) return null;

  const legacySeasonBlocks = $('.les-content, [class*="season-"], [class*="stagione-"]');
  if (legacySeasonBlocks.length > sIdx) {
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

  const season  = parseInt(meta?.season, 10);
  const episode = parseInt(meta?.episode, 10);
  if (!season || season < 1 || !episode || episode < 1) return [];

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

  try {
    return await _searchGuardaserie(meta, config, season, episode, controller.signal);
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function _searchGuardaserie(meta, config, season, episode, signal) {
  await refreshTargetDomain(signal);

  const animeContext = await buildSharedAnimeContext(meta, config, season, episode);
  if (animeContext?.isAnime) {
    const mappedSeason = parseInt(animeContext.seasonNumber, 10);
    const mappedEpisode = parseInt(animeContext.requestedEpisode, 10);
    if (mappedSeason > 0) season = mappedSeason;
    if (mappedEpisode > 0) episode = mappedEpisode;
  }

  let tmdbId = meta?.tmdb_id || meta?.tmdbId || animeContext?.tmdbId || animeContext?.mappedIds?.tmdbId || null;

  if (!tmdbId && (meta?.imdb_id || animeContext?.imdbId)) {
    const resolved = await tmdbHelper.getTmdbFromImdb(meta.imdb_id || animeContext.imdbId, { mediaHint: 'tv' }).catch(() => null);
    if (resolved) tmdbId = resolved;
  }

  let showName = meta?.title || animeContext?.title || null;
  let originalTitle = animeContext?.rawTitles?.find((title) => normalizeText(title) !== normalizeText(showName)) || null;
  let targetYear = animeContext?.year || null;

  if (tmdbId) {
    const tmdbMeta = await tmdbHelper.getMediaInfoFull(tmdbId, 'tv', { language: 'it-IT' }).catch(() => null);
    if (tmdbMeta) {
      showName      = tmdbMeta.title || showName;
      originalTitle = tmdbMeta.original_title || originalTitle || null;
      targetYear    = tmdbMeta.year || targetYear || null;
    }
  }

  const expectedTitles = uniqueCleanStrings([
    showName,
    originalTitle,
    ...(Array.isArray(animeContext?.searchTitles) ? animeContext.searchTitles : []),
    ...(Array.isArray(animeContext?.rawTitles) ? animeContext.rawTitles : []),
    meta?.name,
    meta?.originalTitle,
    meta?.canonicalTitle,
    meta?.seriesTitle
  ], 14);

  showName = showName || expectedTitles[0] || null;
  if (!showName) return [];

  const queries    = uniqueCleanStrings(expectedTitles, 8);
  let allResults   = await searchProviderParallel(queries, signal);
  allResults       = Array.from(new Map(allResults.map(i => [i.url, i])).values());

  const seriesResults  = allResults.filter(r => /\/serie\//i.test(r.url));
  const episodeResults = allResults.filter(r => /\/episodio\//i.test(r.url));
  allResults = [...seriesResults, ...episodeResults];

  allResults.sort((a, b) =>
    normalizeTitleScoreMany(b.title, expectedTitles) -
    normalizeTitleScoreMany(a.title, expectedTitles)
  );

  let target = null, bestLoose = null;

  for (const result of allResults) {
    const titleScore = normalizeTitleScoreMany(result.title, expectedTitles);
    if (titleScore < 1) continue;

    const html = await smartFetch(result.url, { ttl: TTL_SERIES, signal });
    if (!html) continue;

    const foundYear =
      html.match(/release-year\/(\d{4})/i)?.[1] ||
      html.match(/\b(19\d{2}|20\d{2})\b/)?.[1] ||
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
        const html = await smartFetch(url, { ttl: TTL_SERIES, signal });
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

  const episodeUrl = extractEpisodeUrlFromSeriesPage(target.html, season, episode);
  if (!episodeUrl) return [];

  const absoluteEpUrl = new URL(episodeUrl, getTargetDomain()).toString();
  const finalHtml     = await smartFetch(absoluteEpUrl, { ttl: TTL_EPISODE, signal });
  const playerLinks   = Array.from(new Set(extractPlayerLinksFromHtml(finalHtml))).slice(0, 8);
  if (!playerLinks.length) return [];

  const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

  const processedResults = await asyncPool(3, playerLinks, async link => {
    try {
      const userAgent = activeSession.userAgent || pickRandomProfile(BROWSER_PROFILES).ua;
      const extracted = await extractFromUrl(link, {
        client: lightClient,
        userAgent,
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
        name:      `GuardoSerie | ${extracted.name}`,
        title:     `${cleanTitle}\n ${extracted.name}  ITA`,
        url:       extracted.url,
        extractor: extracted.name,
        provider:  'GuardoSerie',
        providerCode: 'GS',
        quality,
        headers: extracted.headers,
        extra: { _priority: extracted.priority ?? 9 }
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
