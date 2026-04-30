'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const tmdbHelper = require('../../core/utils/tmdb_helper');
const animeIdentity = require('../anime/anime_identity');
const kitsuProvider = require('../animeworld/kitsu_provider');
const animeProviderUtils = require('../anime/provider_utils');
const browserProfiles = require('../../core/browser_profiles');
const { pickRandomProfile } = browserProfiles;
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

const INITIAL_GS_DOMAIN = 'https://guardoserie.run';
const PROVIDER_NAME = 'guardoserie';
const BROWSER_PROFILES = browserProfiles.GUARDO_SERIE_BROWSER_PROFILES || browserProfiles.GUARDA_SERIE_BROWSER_PROFILES || [];
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || process.env.FLARE_URL || 'http://127.0.0.1:8191/v1';
const SESSION_FILE = path.join(process.cwd(), `cf-session-${PROVIDER_NAME}.json`);
const DOMAIN_FILE = path.join(process.cwd(), `${PROVIDER_NAME}-domain.json`);

const DOMAIN_REFRESH_TTL = 1000 * 60 * 20;
const DOMAIN_TIMEOUT_MS = 8000;
const TTL_SEARCH = 1000 * 60 * 30;
const TTL_EPISODE = 1000 * 60 * 30;
const TTL_SERIES = 1000 * 60 * 60 * 6;
const CF_SESSION_TTL = 1000 * 60 * 60 * 6;
const MAX_CACHE_ITEMS = 500;
const FS_CIRCUIT_THRESHOLD = 3;
const FS_CIRCUIT_RESET_MS = 60_000;

const PROVIDER_BUDGET_MS = Math.max(25000, parseInt(process.env.GS_PROVIDER_BUDGET_MS || process.env.GUARDOSERIE_PROVIDER_BUDGET_MS || '55000', 10) || 55000);
const GLOBAL_TIMEOUT_MS = Math.min(
  PROVIDER_BUDGET_MS,
  Math.max(30000, parseInt(process.env.GS_INTERNAL_TIMEOUT || String(PROVIDER_BUDGET_MS), 10) || PROVIDER_BUDGET_MS)
);
const SEARCH_QUERY_TIMEOUT_MS = Math.max(8000, parseInt(process.env.GS_SEARCH_TIMEOUT || '12000', 10) || 12000);
const DIRECT_FETCH_TIMEOUT_MS = Math.max(2500, parseInt(process.env.GS_DIRECT_FETCH_TIMEOUT || '4200', 10) || 4200);
const FLARE_CLEARANCE_COOLDOWN_MS = Math.max(3000, parseInt(process.env.GS_FLARE_CLEARANCE_COOLDOWN_MS || '8000', 10) || 8000);
const FLARE_WARMUP_TIMEOUT_MS = Math.min(
  Math.max(12000, parseInt(process.env.GS_FLARE_WARMUP_TIMEOUT_MS || '24000', 10) || 24000),
  Math.max(15000, GLOBAL_TIMEOUT_MS - 12000)
);
const GS_DOMAIN_PROBE_TIMEOUT_MS = Math.max(1200, parseInt(process.env.GS_DOMAIN_PROBE_TIMEOUT_MS || '2500', 10) || 2500);

const DEBUG_GS = ['1', 'true', 'yes', 'on'].includes(String(process.env.GUARDOSERIE_DEBUG || '').trim().toLowerCase());
const DEBUG_CF = DEBUG_GS || ['1', 'true', 'yes', 'on'].includes(String(process.env.GUARDOSERIE_DEBUG_CF || process.env.FLARESOLVERR_DEBUG || '').trim().toLowerCase());
const FLARE_TARGET_URL_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.GS_FLARE_TARGET_URL || process.env.GUARDOSERIE_FLARE_TARGET_URL || '1').trim().toLowerCase());
const FLARE_HOMEPAGE_FALLBACK = ['1', 'true', 'yes', 'on'].includes(String(process.env.GS_FLARE_HOMEPAGE_FALLBACK || process.env.GUARDOSERIE_FLARE_HOMEPAGE_FALLBACK || '').trim().toLowerCase());
const FLARE_DIRECT_API_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.GS_FLARE_DIRECT_API || process.env.GUARDOSERIE_FLARE_DIRECT_API || '1').trim().toLowerCase());
const GS_SKIP_AJAX_AFTER_FALLBACK_HIT = !['0', 'false', 'no', 'off'].includes(String(process.env.GS_SKIP_AJAX_AFTER_FALLBACK_HIT || process.env.GUARDOSERIE_SKIP_AJAX_AFTER_FALLBACK_HIT || '1').trim().toLowerCase());
const GS_FAST_SLUG_FIRST = !['0', 'false', 'no', 'off'].includes(String(process.env.GS_FAST_SLUG_FIRST || process.env.GUARDOSERIE_FAST_SLUG_FIRST || '1').trim().toLowerCase());
const GS_REFRESH_DOMAIN_ON_START = ['1', 'true', 'yes', 'on'].includes(String(process.env.GS_REFRESH_DOMAIN_ON_START || process.env.GUARDOSERIE_REFRESH_DOMAIN_ON_START || '').trim().toLowerCase());

const COMPILED_DIRECT_REGEX = new RegExp(HOSTER_DIRECT_LINK_PATTERN, 'ig');
const COMPILED_ESCAPED_REGEX = new RegExp(HOSTER_ESCAPED_DIRECT_LINK_PATTERN, 'ig');

const GOT_HEADER_OPTIONS = {
  browsers: [{ name: 'chrome', minVersion: 120, maxVersion: 124 }],
  devices: ['desktop'],
  operatingSystems: ['windows', 'macos'],
  locales: ['it-IT', 'it', 'en-US']
};

const agentOptions = {
  keepAlive: true,
  maxSockets: 250,
  maxFreeSockets: 100,
  timeout: 30000,
  keepAliveMsecs: 30000
};

const httpsAgent = new https.Agent(agentOptions);
const httpAgent = new http.Agent(agentOptions);

const lightClient = axios.create({
  timeout: 10000,
  httpAgent,
  httpsAgent,
  validateStatus: status => status >= 200 && status < 500,
  headers: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' }
});

const getGotScrapingClient = createGotScrapingLoader({ failSoft: false });

let currentGsDomain = loadStoredDomain() || INITIAL_GS_DOMAIN;
let lastDomainRefresh = 0;
let domainRefreshPromise = null;
let activeSession = {};

function gsDebug(message, meta = null) {
  if (!DEBUG_GS && !DEBUG_CF) return;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[GuardoSerie:debug] ${message}${suffix}`);
}

function gsWarn(message, meta = null) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.warn(`[GuardoSerie][CF] ${message}${suffix}`);
}

function gsInfo(message, meta = null) {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[GuardoSerie][CF] ${message}${suffix}`);
}

function isAbortLikeError(error) {
  if (isCanceledError(error)) return true;

  const name = String(error?.name || '');
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');

  return (
    name === 'AbortError' ||
    name === 'CanceledError' ||
    code === 'ERR_CANCELED' ||
    /(?:operation was aborted|aborted by|parent aborted|canceled|cancelled)/i.test(message)
  );
}

class LRUCache {
  constructor(maxSize) {
    this._max = maxSize;
    this._map = new Map();
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this._max) this._map.delete(this._map.keys().next().value);
    this._map.set(key, value);
  }

  delete(key) {
    this._map.delete(key);
  }

  get size() {
    return this._map.size;
  }
}

const requestCache = new LRUCache(MAX_CACHE_ITEMS);
const pendingRequests = new Map();
const flareClearancePromises = new Map();
const flareClearanceCooldown = new Map();

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return `${url.protocol}//${url.host}`;
  } catch (_) {
    return null;
  }
}

function loadStoredDomain() {
  try {
    if (!fs.existsSync(DOMAIN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(DOMAIN_FILE, 'utf8'));
    return normalizeBaseUrl(data?.baseUrl) || null;
  } catch (_) {
    return null;
  }
}

function saveStoredDomain(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return;

  try {
    fs.writeFileSync(DOMAIN_FILE, JSON.stringify({ baseUrl: normalized, updatedAt: Date.now() }, null, 2));
  } catch (_) {}
}

function getTargetDomain() {
  return currentGsDomain;
}

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

function buildGsUrl(pathname) {
  const cleanPath = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  return `${getTargetDomain()}${cleanPath}`;
}

function isSessionFresh(session) {
  return Boolean(
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
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
  } catch (_) {}
}

function clearSession() {
  activeSession = {};
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch (_) {}
}

function getProfileUserAgent(profile = null) {
  const fallback = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
  if (profile?.ua || profile?.userAgent) return profile.ua || profile.userAgent;

  const picked = pickRandomProfile(BROWSER_PROFILES) || {};
  return picked.ua || picked.userAgent || fallback;
}

async function resolveRedirectDomain(startBase, signal = null) {
  const base = normalizeBaseUrl(startBase);
  if (!base || signal?.aborted) return null;

  const timeout = Math.min(DOMAIN_TIMEOUT_MS, GS_DOMAIN_PROBE_TIMEOUT_MS);

  try {
    const probeUA = activeSession?.userAgent || getProfileUserAgent();
    const res = await lightClient.get(base, {
      timeout,
      signal,
      maxRedirects: 5,
      headers: {
        'User-Agent': probeUA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });

    return normalizeBaseUrl(res?.request?.res?.responseUrl || res?.config?.url || base) || base;
  } catch (error) {
    gsDebug('domain probe skipped/failed', {
      base,
      error: error?.code || error?.message || String(error),
      timeoutMs: timeout
    });
    return null;
  }
}

async function refreshTargetDomain(signal = null, { force = false } = {}) {
  if (signal?.aborted) return currentGsDomain;

  if (!force && !GS_REFRESH_DOMAIN_ON_START) {
    lastDomainRefresh = Date.now();
    return currentGsDomain;
  }

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
      ].filter(([key]) => key)).keys()
    );

    for (const candidate of candidates) {
      if (signal?.aborted) break;
      const resolved = await resolveRedirectDomain(candidate, signal);
      if (resolved) {
        updateCurrentDomainFromUrl(resolved);
        return currentGsDomain;
      }
    }

    return currentGsDomain;
  })().finally(() => {
    domainRefreshPromise = null;
  });

  return domainRefreshPromise;
}

async function axiosSiteRequest(url, {
  method = 'GET',
  body = null,
  headers = {},
  timeout = 5000,
  signal = null,
  maxRedirects = 6
} = {}) {
  const startedAt = Date.now();

  const res = await axios.request({
    url,
    method,
    data: body || undefined,
    headers,
    timeout,
    signal,
    httpAgent,
    httpsAgent,
    maxRedirects,
    decompress: true,
    responseType: 'text',
    validateStatus: status => status >= 200 && status < 600,
    transitional: { clarifyTimeoutError: true }
  });

  const responseUrl =
    res?.request?.res?.responseUrl ||
    res?.request?._redirectable?._currentUrl ||
    res?.config?.url ||
    url;

  return {
    status: res.status,
    headers: res.headers || {},
    data: typeof res.data === 'string' ? res.data : String(res.data || ''),
    url: responseUrl,
    ms: Date.now() - startedAt
  };
}

async function gotSiteRequest(url, {
  method = 'GET',
  body = null,
  headers = {},
  timeout = 15000,
  signal = null,
  responseType = 'text',
  maxRedirects = 8,
  useHttp2 = true
} = {}) {
  const gotScraping = await getGotScrapingClient();
  const lockedUA = headers['User-Agent'] || headers['user-agent'] || null;
  const sessionCookies = headers['Cookie'] || headers['cookie'] || null;

  const opts = {
    url,
    method,
    body: body || undefined,
    headers,
    timeout: { request: timeout, connect: 6000, response: timeout },
    signal,
    responseType,
    throwHttpErrors: false,
    followRedirect: true,
    maxRedirects,
    http2: useHttp2,
    retry: {
      limit: 2,
      methods: ['GET'],
      statusCodes: [408, 413, 500, 502, 504],
      calculateDelay: ({ computedValue, error }) =>
        error?.response?.statusCode === 429
          ? 2000 + Math.random() * 1500
          : computedValue + Math.random() * 400
    },
    agent: { http: httpAgent, https: httpsAgent }
  };

  if (!lockedUA) opts.headerGeneratorOptions = GOT_HEADER_OPTIONS;

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
    status: res.statusCode,
    headers: res.headers || {},
    data: res.body,
    url: res.url || url
  };
}

function normalizeFlareEndpoint(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return 'http://127.0.0.1:8191/v1';
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

function parseSingleCookie(raw) {
  const primary = String(raw || '').split(';')[0];
  const eqIdx = primary.indexOf('=');
  if (eqIdx < 0) return null;

  const key = primary.slice(0, eqIdx).trim();
  const value = primary.slice(eqIdx + 1).trim();

  return key ? [key, value] : null;
}

function updateCookies(existing, setCookieHeader) {
  if (!setCookieHeader) return existing;

  const skippedKeys = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
  const cookieMap = new Map();

  if (existing) {
    for (const part of existing.split(';')) {
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) continue;

      const key = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (key && !skippedKeys.has(key.toLowerCase())) cookieMap.set(key, value);
    }
  }

  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const parsed = parseSingleCookie(header);
    if (parsed && !skippedKeys.has(parsed[0].toLowerCase())) cookieMap.set(parsed[0], parsed[1]);
  }

  return Array.from(cookieMap.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function joinCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return String(cookies || '').trim();

  const out = [];
  const seen = new Set();

  for (const cookie of cookies) {
    let name = null;
    let value = null;

    if (typeof cookie === 'string') {
      const parsed = parseSingleCookie(cookie);
      if (parsed) {
        name = parsed[0];
        value = parsed[1];
      }
    } else if (cookie && typeof cookie === 'object') {
      name = cookie.name || cookie.key || null;
      value = cookie.value ?? cookie.val ?? null;
    }

    if (!name || value == null || seen.has(name)) continue;
    seen.add(name);
    out.push(`${name}=${value}`);
  }

  return out.join('; ');
}

function readCookieValue(cookieHeader, cookieName) {
  const name = String(cookieName || '').trim();
  if (!name) return null;

  for (const part of String(cookieHeader || '').split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;

    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key === name) return value || null;
  }

  return null;
}

function buildFlareClearanceUrl(triggerUrl, { isPost = false, body = null } = {}) {
  const base = normalizeBaseUrl(triggerUrl) || normalizeBaseUrl(getTargetDomain()) || INITIAL_GS_DOMAIN;

  if (!FLARE_TARGET_URL_ENABLED) return `${base}/`;

  if (isPost) {
    try {
      const params = new URLSearchParams(String(body || ''));
      const query = params.get('swpquery') || params.get('s') || params.get('query') || '';
      if (query) return `${base}/?s=${encodeURIComponent(query)}`;
    } catch (_) {}

    return `${base}/`;
  }

  try {
    return new URL(String(triggerUrl || ''), base).toString();
  } catch (_) {
    return `${base}/`;
  }
}

function clearanceCooldownKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return String(url || '');
  }
}

async function directFlareSolverrClearance(clearanceUrl, signal = null, meta = {}) {
  const endpoint = normalizeFlareEndpoint(FLARESOLVERR_URL);
  const maxTimeout = Math.max(12000, Math.min(FLARE_WARMUP_TIMEOUT_MS, GLOBAL_TIMEOUT_MS - 12000));
  const controller = new AbortController();

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason || 'parent aborted');
  };

  if (signal?.aborted) abortFromParent();
  else if (signal) signal.addEventListener('abort', abortFromParent, { once: true });

  const hardTimer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort('flaresolverr hard timeout');
  }, maxTimeout + 8000);

  if (hardTimer?.unref) hardTimer.unref();

  try {
    const response = await axios.post(endpoint, {
      cmd: 'request.get',
      url: clearanceUrl,
      maxTimeout
    }, {
      timeout: maxTimeout + 9000,
      signal: controller.signal,
      httpAgent,
      httpsAgent,
      validateStatus: status => status >= 200 && status < 600,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    const data = response.data || {};
    if (response.status >= 400) throw new Error(`http_${response.status}`);
    if (data.status && String(data.status).toLowerCase() !== 'ok') {
      throw new Error(data.message || data.error || `status_${data.status}`);
    }

    const solution = data.solution || {};
    const cookies = joinCookieHeader(solution.cookies || data.cookies || '');
    const userAgent = solution.userAgent || data.userAgent || meta.userAgent || getProfileUserAgent();
    const solvedUrl = solution.url || clearanceUrl;

    if (!cookies && !userAgent) return null;

    return {
      userAgent,
      cookies,
      cf_clearance: readCookieValue(cookies, 'cf_clearance'),
      url: normalizeBaseUrl(solvedUrl) || normalizeBaseUrl(clearanceUrl) || getTargetDomain(),
      solvedUrl,
      timestamp: Date.now(),
      status: solution.status || response.status
    };
  } finally {
    clearTimeout(hardTimer);
    if (signal) signal.removeEventListener('abort', abortFromParent);
  }
}

async function solveFlareClearanceOnUrl(clearanceUrl, signal = null, meta = {}) {
  const key = clearanceCooldownKey(clearanceUrl);

  if (flareClearancePromises.has(key)) return flareClearancePromises.get(key);

  const now = Date.now();
  const last = flareClearanceCooldown.get(key) || 0;
  if (now - last < FLARE_CLEARANCE_COOLDOWN_MS) return null;

  flareClearanceCooldown.set(key, now);

  const promise = (async () => {
    try {
      gsInfo('flaresolverr target solve start', {
        clearanceUrl,
        triggerUrl: meta.triggerUrl,
        method: meta.method,
        maxTimeout: FLARE_WARMUP_TIMEOUT_MS,
        providerBudget: GLOBAL_TIMEOUT_MS,
        endpoint: FLARESOLVERR_URL
      });

      let session = null;

      if (FLARE_DIRECT_API_ENABLED) {
        session = await directFlareSolverrClearance(clearanceUrl, signal, {
          method: 'GET',
          triggerUrl: meta.triggerUrl
        });
      } else {
        session = await flareSolverrClient.getClearance(clearanceUrl, {
          method: 'GET',
          signal,
          maxTimeout: FLARE_WARMUP_TIMEOUT_MS
        });
      }

      if (isSessionFresh(session)) {
        activeSession = {
          ...session,
          url: normalizeBaseUrl(session.url || clearanceUrl) || normalizeBaseUrl(clearanceUrl) || getTargetDomain(),
          timestamp: Date.now()
        };

        saveSession(activeSession);
        if (activeSession.url) updateCurrentDomainFromUrl(activeSession.url);

        gsInfo('flaresolverr target solve ok', {
          clearanceUrl,
          solvedBase: normalizeBaseUrl(session.url || clearanceUrl),
          hasClearance: Boolean(session.cf_clearance || String(session.cookies || '').includes('cf_clearance=')),
          cookies: String(session.cookies || '').split(';').filter(Boolean).length
        });

        return activeSession;
      }

      gsWarn('flaresolverr target solve empty', {
        clearanceUrl,
        triggerUrl: meta.triggerUrl,
        method: meta.method
      });

      return null;
    } catch (error) {
      if (isCanceledError(error) || signal?.aborted) {
        gsWarn('flaresolverr target solve aborted', {
          clearanceUrl,
          reason: signal?.reason || error?.message || String(error)
        });
        return null;
      }

      gsWarn('flaresolverr target solve failed', {
        clearanceUrl,
        error: error?.message || String(error)
      });

      return null;
    }
  })().finally(() => {
    flareClearancePromises.delete(key);
  });

  flareClearancePromises.set(key, promise);
  return promise;
}

async function warmupFlareClearance(triggerUrl, signal = null, options = {}) {
  if (!options.force && isSessionFresh(activeSession)) return activeSession;

  const clearanceUrl = buildFlareClearanceUrl(triggerUrl, options);
  let session = await solveFlareClearanceOnUrl(clearanceUrl, signal, {
    triggerUrl,
    method: options.isPost ? 'POST' : 'GET'
  });

  if (isSessionFresh(session)) return session;

  if (FLARE_HOMEPAGE_FALLBACK) {
    const base = normalizeBaseUrl(triggerUrl) || normalizeBaseUrl(getTargetDomain()) || INITIAL_GS_DOMAIN;
    const homepageUrl = `${base}/`;

    if (homepageUrl !== clearanceUrl) {
      gsDebug('flaresolverr homepage fallback start', { homepageUrl, triggerUrl });
      session = await solveFlareClearanceOnUrl(homepageUrl, signal, {
        triggerUrl,
        method: options.isPost ? 'POST' : 'GET',
        fallback: true
      });

      if (isSessionFresh(session)) return session;
    }
  }

  return null;
}

function isGuardaserieChallengePage(html, status = 200) {
  const raw = typeof html === 'string' ? html : String(html || '');
  if (!raw) return true;

  const lower = raw.slice(0, 250000).toLowerCase();

  if (status === 403 || status === 429 || status === 503) return true;
  if (isCloudflareChallenge(raw, status)) return true;

  const strongSignals = [
    'turnstile.cloudflare.com',
    'cf-turnstile',
    'cf_chl_',
    '__cf_chl_',
    'cf-browser-verification',
    'cf_captcha_kind',
    'cf_clearance',
    'challenge-platform',
    'challenge-form',
    'cf-challenge',
    'g-recaptcha',
    'h-captcha',
    'hcaptcha.com',
    'checking if the site connection is secure',
    'verify you are human',
    'verifica di essere umano',
    'verifica che sei umano',
    'verifica che tu sia umano',
    'controllo connessione al sito',
    'just a moment',
    'un momento',
    'ray id'
  ];

  let score = 0;

  for (const token of strongSignals) {
    if (lower.includes(token)) score += 2;
  }

  if (lower.includes('cloudflare') && (lower.includes('captcha') || lower.includes('challenge') || lower.includes('turnstile'))) score += 4;
  if (/<title>\s*(just a moment|attention required|verifica|checking)/i.test(raw)) score += 4;
  if (/id=["']?challenge-|class=["'][^"']*(cf-|challenge|turnstile)/i.test(raw)) score += 3;

  return score >= 3;
}

async function executeSmartFetch(url, isPost = false, body = null, signal = null, allowFlareSolverr = true, timeoutMs = DIRECT_FETCH_TIMEOUT_MS) {
  const startedAt = Date.now();
  const method = isPost ? 'POST' : 'GET';
  const hardFetchTimeout = Math.max(2500, Math.min(timeoutMs, DIRECT_FETCH_TIMEOUT_MS));

  gsDebug('smart fetch start', {
    method,
    url,
    hasSession: isSessionFresh(activeSession),
    allowFlareSolverr,
    timeoutMs: hardFetchTimeout
  });

  const isGoodHtml = (html, status = 200) => {
    const raw = typeof html === 'string' ? html : String(html || '');
    return Boolean(raw && !isGuardaserieChallengePage(raw, status));
  };

  const persistSession = (session, resolvedUrl = null, setCookie = null) => {
    if (!session?.userAgent) return;

    const next = {
      ...session,
      url: normalizeBaseUrl(resolvedUrl || session.url) || session.url || getTargetDomain(),
      timestamp: Date.now()
    };

    if (setCookie) next.cookies = updateCookies(session.cookies, setCookie);

    activeSession = next;
    saveSession(activeSession);
    if (next.url) updateCurrentDomainFromUrl(next.url);
  };

  const buildSessionHeaders = session => {
    const headers = {
      'User-Agent': session.userAgent,
      'Cookie': session.cookies,
      'Referer': getTargetDomain(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Fetch-Site': 'same-origin'
    };

    if (isPost && body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Mode'] = 'cors';
    } else {
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-User'] = '?1';
      headers['Upgrade-Insecure-Requests'] = '1';
    }

    return headers;
  };

  const fetchWithSession = async session => {
    if (!isSessionFresh(session)) return null;

    const res = await axiosSiteRequest(url, {
      method,
      body: isPost ? body : null,
      headers: buildSessionHeaders(session),
      timeout: Math.max(hardFetchTimeout, 4500),
      signal
    });

    updateCurrentDomainFromUrl(res.url);

    const html = typeof res.data === 'string' ? res.data : String(res.data || '');
    if (!isGoodHtml(html, res.status)) {
      gsDebug('session fetch rejected', {
        method,
        url,
        status: res.status,
        bytes: html.length,
        challenge: isGuardaserieChallengePage(html, res.status),
        ms: Date.now() - startedAt
      });
      clearSession();
      return null;
    }

    persistSession(session, res.url, res.headers?.['set-cookie']);
    gsDebug('session fetch ok', { method, url, status: res.status, bytes: html.length, ms: Date.now() - startedAt });

    return html;
  };

  const fetchDirectFast = async () => {
    const profile = pickRandomProfile(BROWSER_PROFILES) || {};
    const ua = getProfileUserAgent(profile);

    const headers = {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': getTargetDomain(),
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    };

    if (profile.sec_ch_ua) {
      headers['sec-ch-ua'] = profile.sec_ch_ua;
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
    }

    if (isPost && body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Site'] = 'same-origin';
    } else {
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = 'same-origin';
      headers['Sec-Fetch-User'] = '?1';
      headers['Upgrade-Insecure-Requests'] = '1';
    }

    const res = await axiosSiteRequest(url, {
      method,
      body: isPost ? body : null,
      headers,
      timeout: hardFetchTimeout,
      signal
    });

    updateCurrentDomainFromUrl(res.url);

    const html = typeof res.data === 'string' ? res.data : String(res.data || '');
    if (!isGoodHtml(html, res.status)) {
      gsDebug('direct fast rejected', {
        method,
        url,
        status: res.status,
        bytes: html.length,
        challenge: isGuardaserieChallengePage(html, res.status),
        ms: Date.now() - startedAt
      });
      return null;
    }

    const setCookie = res.headers?.['set-cookie'];
    if (setCookie) {
      const cookies = updateCookies('', setCookie);
      if (cookies) persistSession({ userAgent: ua, cookies, url: res.url, timestamp: Date.now() }, res.url);
    }

    gsDebug('direct fast ok', {
      method,
      url,
      status: res.status,
      bytes: html.length,
      hasCookie: Boolean(setCookie),
      ms: Date.now() - startedAt
    });

    return html;
  };

  if (isSessionFresh(activeSession)) {
    try {
      const html = await fetchWithSession(activeSession);
      if (html) return html;
    } catch (error) {
      if (isAbortLikeError(error) && signal?.aborted) throw error;
      gsDebug('session fetch error', {
        method,
        url,
        error: error?.message || String(error),
        code: error?.code,
        ms: Date.now() - startedAt
      });
    }
  }

  try {
    const html = await fetchDirectFast();
    if (html) return html;
  } catch (error) {
    if (isAbortLikeError(error) && signal?.aborted) throw error;
    gsDebug('direct fast error', {
      method,
      url,
      error: error?.message || String(error),
      code: error?.code,
      ms: Date.now() - startedAt
    });
  }

  if (!allowFlareSolverr) return null;

  const session = await warmupFlareClearance(url, signal, { force: true, isPost, body });
  if (!isSessionFresh(session)) {
    gsWarn('flaresolverr no fresh target session', { method, url, ms: Date.now() - startedAt });
    return null;
  }

  try {
    const html = await fetchWithSession(session);
    if (html) {
      gsInfo('post-clearance fast fetch ok', { method, url, droppedFlareSolverr: true, ms: Date.now() - startedAt });
      return html;
    }
  } catch (error) {
    if (isAbortLikeError(error) && signal?.aborted) throw error;
    gsDebug('post-clearance fetch error', {
      method,
      url,
      error: error?.message || String(error),
      code: error?.code,
      ms: Date.now() - startedAt
    });
    clearSession();
  }

  return null;
}

async function smartFetch(url, {
  isPost = false,
  body = null,
  ttl = TTL_SEARCH,
  signal = null,
  allowFlareSolverr = true,
  timeoutMs = DIRECT_FETCH_TIMEOUT_MS
} = {}) {
  const cacheKey = `${isPost ? 'POST' : 'GET'}:${url}:${body || ''}`;
  const cached = requestCache.get(cacheKey);

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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(IT_STOPWORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTitleScore(candidate, title, originalTitle) {
  const normalizedCandidate = normalizeText(candidate);
  const primary = normalizeText(title);
  const secondary = normalizeText(originalTitle);

  if (!normalizedCandidate) return 0;
  if (normalizedCandidate === primary || (secondary && normalizedCandidate === secondary)) return 3;

  if (
    (primary && (normalizedCandidate.includes(primary) || primary.includes(normalizedCandidate))) ||
    (secondary && (normalizedCandidate.includes(secondary) || secondary.includes(normalizedCandidate)))
  ) return 2;

  const candidateTokens = new Set(normalizedCandidate.split(' ').filter(Boolean));
  const titleTokens = Array.from(new Set(`${primary} ${secondary}`.trim().split(' ').filter(Boolean)));

  if (!titleTokens.length) return 0;

  let hits = 0;
  for (const token of titleTokens) {
    if (candidateTokens.has(token)) hits++;
  }

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

function isUsableGsTitleForSearch(value) {
  const text = String(value || '').trim();

  if (!text || text.length < 2) return false;
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(text)) return false;
  if (/^\d+$/.test(text)) return false;
  if (!/[a-zA-Z]/.test(text)) return false;

  return true;
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
    if (/^\d+$/.test(text)) {
      return {
        requestId: `kitsu:${text}`,
        parsed: { kitsuId: text, seasonNumber: null, episodeNumber: null }
      };
    }
  }

  return null;
}

function buildGsKitsuProviderContext(meta = {}, config = {}, kitsuInfo = null, episodeNumber = 1) {
  const providerContext = animeProviderUtils.buildAnimeProviderContext({
    ...meta,
    id: kitsuInfo?.requestId || meta?.id || meta?.requestedId || null,
    kitsuId: kitsuInfo?.parsed?.kitsuId || meta?.kitsuId || meta?.kitsu_id || meta?.kitsu || null,
    episode: episodeNumber
  });

  providerContext.mappingLanguage = 'it';
  providerContext.italianOnly = true;
  providerContext.onlyItalian = true;
  providerContext.mappingTimeoutMs = 6000;
  providerContext.mappingRetries = 2;

  if (Array.isArray(config?.mappingApiBases)) providerContext.mappingApiBases = config.mappingApiBases;
  if (Array.isArray(config?.mappingMirrors)) providerContext.mappingApiBases = config.mappingMirrors;
  if (Array.isArray(config?.filters?.mappingApiBases)) providerContext.mappingApiBases = config.filters.mappingApiBases;
  if (Array.isArray(config?.filters?.mappingMirrors)) providerContext.mappingApiBases = config.filters.mappingMirrors;

  return providerContext;
}

async function fetchStrictKitsuMapping(meta = {}, config = {}, kitsuInfo = null, requestedEpisode = 1) {
  const kitsuId = kitsuInfo?.parsed?.kitsuId;
  if (!kitsuId) return null;

  const episodeNumber = parseInt(requestedEpisode, 10) || kitsuInfo?.parsed?.episodeNumber || parseInt(meta?.episode, 10) || 1;
  const providerContext = buildGsKitsuProviderContext(meta, config, kitsuInfo, episodeNumber);

  try {
    return await animeProviderUtils.fetchMappingPayload({
      provider: 'kitsu',
      externalId: String(kitsuId),
      season: null,
      episode: episodeNumber,
      contentType: 'anime'
    }, providerContext);
  } catch (error) {
    console.warn('[GuardoSerie][KITSU] mapping failed:', error.message);
    return null;
  }
}

function resolveStrictKitsuEpisodeForGs(mappingPayload, fallbackEpisode) {
  const requested = parseInt(fallbackEpisode, 10) || 1;
  const fromKitsu = parseInt(mappingPayload?.kitsu?.episode, 10);
  const fromRequested = parseInt(mappingPayload?.requested?.episode, 10);

  if (Number.isInteger(fromKitsu) && fromKitsu > 0 && fromKitsu === requested) return fromKitsu;
  if (Number.isInteger(fromRequested) && fromRequested > 0 && fromRequested === requested) return fromRequested;

  return requested;
}

function extractGsMappingEntries(mappingPayload) {
  const mappings = mappingPayload?.mappings || mappingPayload?.mapping || {};
  const raw = mappings.guardoserie || mappings.guardoSerie || mappings.guardaserie || mappings.gs || null;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];

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
  const requestId = kitsuInfo.requestId || `kitsu:${kitsuInfo.parsed.kitsuId}:${requestedEpisode}`;
  let context = null;

  try {
    context = await kitsuProvider.buildSearchContext(requestId, { ...meta, season, episode: requestedEpisode });
  } catch (error) {
    console.warn('[GuardoSerie][KITSU] context failed:', error.message);
  }

  const mappingPayload = await fetchStrictKitsuMapping(meta, config, kitsuInfo, requestedEpisode);
  const strictEpisode = resolveStrictKitsuEpisodeForGs(mappingPayload, requestedEpisode);

  const rawTitles = uniqueCleanStrings([
    ...(Array.isArray(context?.rawTitles) ? context.rawTitles : []),
    ...(Array.isArray(context?.searchTitles) ? context.searchTitles : []),
    ...(Array.isArray(context?.info?.titles) ? context.info.titles : []),
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
    isAnime: true,
    strictKitsu: true,
    kitsuId: String(kitsuInfo.parsed.kitsuId),
    rawTitles,
    searchTitles,
    title: searchTitles[0] || rawTitles[0] || meta?.title || null,
    seasonNumber: parseInt(context?.seasonNumber, 10) || parseInt(season, 10) || parseInt(meta?.season, 10) || 1,
    requestedEpisode: strictEpisode,
    episodeCandidates: [strictEpisode],
    mappingPayload,
    mappingUrls: extractGsMappingEntries(mappingPayload),
    tmdbId: null,
    imdbId: null,
    mappedIds: null,
    identitySources: ['kitsu', mappingPayload ? 'mapping:kitsu' : null].filter(Boolean)
  };
}

function normalizeStreamUrl(url) {
  try {
    const parsed = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(key => parsed.searchParams.delete(key));
    return parsed.toString();
  } catch (_) {
    return String(url || '');
  }
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

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href || !/(\/serie\/|\/episodio\/)/i.test(href)) return;

    try {
      const absolute = new URL(href, baseUrl).toString();
      if (seen.has(absolute)) return;

      seen.add(absolute);
      results.push({
        url: absolute,
        title: String($(element).attr('title') || $(element).text() || '').trim() || absolute
      });
    } catch (_) {}
  });

  return results;
}

async function searchProviderSequential(query, signal) {
  const startedAt = Date.now();
  const baseUrl = await refreshTargetDomain(signal);
  const ajaxUrl = `${baseUrl}/wp-admin/admin-ajax.php`;
  const ajaxBody = `s=${encodeURIComponent(query)}&action=searchwp_live_search&swpengine=default&swpquery=${encodeURIComponent(query)}`;
  const fallbackUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;

  const fetchFallback = () => smartFetch(fallbackUrl, {
    ttl: TTL_SEARCH,
    signal,
    allowFlareSolverr: true,
    timeoutMs: SEARCH_QUERY_TIMEOUT_MS
  }).catch(error => {
    if (isAbortLikeError(error)) throw error;
    gsDebug('fallback search failed', { query, error: error?.message || String(error) });
    return '';
  });

  const fetchAjax = () => smartFetch(ajaxUrl, {
    isPost: true,
    body: ajaxBody,
    ttl: TTL_SEARCH,
    signal,
    allowFlareSolverr: true,
    timeoutMs: SEARCH_QUERY_TIMEOUT_MS
  }).catch(error => {
    if (isAbortLikeError(error)) throw error;
    gsDebug('ajax search failed', { query, error: error?.message || String(error) });
    return '';
  });

  const fallbackHtml = await fetchFallback();
  const fallbackResults = extractSearchResultsFromHtml(fallbackHtml, baseUrl);
  let ajaxHtml = '';

  if (!GS_SKIP_AJAX_AFTER_FALLBACK_HIT || fallbackResults.length === 0) {
    ajaxHtml = await fetchAjax();
  }

  const ajaxResults = ajaxHtml ? extractSearchResultsFromHtml(ajaxHtml, baseUrl) : [];
  const unique = Array.from(new Map([...fallbackResults, ...ajaxResults].map(item => [item.url, item])).values());

  gsDebug('search query done', {
    query,
    fallbackResults: fallbackResults.length,
    ajaxResults: ajaxResults.length,
    results: unique.length,
    skippedAjax: GS_SKIP_AJAX_AFTER_FALLBACK_HIT && fallbackResults.length > 0,
    ms: Date.now() - startedAt
  });

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
    clear: () => {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    }
  };
}

async function searchProviderWithTimeout(query, signal, timeoutMs = SEARCH_QUERY_TIMEOUT_MS) {
  const clearanceBudgetMs = Math.min(GLOBAL_TIMEOUT_MS - 12000, FLARE_WARMUP_TIMEOUT_MS + DIRECT_FETCH_TIMEOUT_MS + 5000);
  const effectiveTimeoutMs = Math.max(timeoutMs, Math.max(18000, clearanceBudgetMs));
  const needsClearanceWindow = !isSessionFresh(activeSession);
  const scoped = createTimeoutSignal(signal, effectiveTimeoutMs);

  try {
    gsDebug('search query start', { query, timeoutMs: effectiveTimeoutMs, needsClearanceWindow });
    return await searchProviderSequential(query, scoped.signal);
  } catch (error) {
    if (isAbortLikeError(error) || scoped.signal.aborted) {
      gsDebug('search query aborted', {
        query,
        timeoutMs: effectiveTimeoutMs,
        needsClearanceWindow,
        error: error?.message || String(error)
      });
      return [];
    }

    gsDebug('search query failed', { query, error: error?.message || String(error) });
    return [];
  } finally {
    scoped.clear();
  }
}

async function searchProviderParallel(queries, signal) {
  const uniqueQueries = Array.from(new Set(queries.filter(Boolean))).slice(0, 3);
  if (!uniqueQueries.length) return [];

  const results = await asyncPool(2, uniqueQueries, query => searchProviderWithTimeout(query, signal));
  return results.flat().filter(Boolean);
}

function extractEpisodeUrlFromSeriesPage(pageHtml, season, episode, options = {}) {
  const raw = String(pageHtml || '');
  if (!raw) return null;

  const targetSeason = parseInt(season, 10);
  const targetEpisode = parseInt(episode, 10);

  if (
    !Number.isInteger(targetSeason) ||
    !Number.isInteger(targetEpisode) ||
    targetSeason < 1 ||
    targetEpisode < 1
  ) return null;

  const $ = cheerio.load(raw);

  const readSeasonNumber = text => {
    const match = String(text || '').match(/\b(?:stagione|season)\s*-?\s*(\d+)\b/i);
    return match ? parseInt(match[1], 10) : null;
  };

  const readEpisodeNumber = text => {
    const value = String(text || '');
    const match =
      value.match(/\b(?:episodio|episode|ep)\s*-?\s*(\d+)\b/i) ||
      value.match(/\bs\d{1,2}e(\d{1,3})\b/i) ||
      value.match(/\b\d{1,2}x(\d{1,3})\b/i);

    return match ? parseInt(match[1], 10) : null;
  };

  const findEpisodeInBlock = block => {
    const links = $(block).find('.les-content a[href*="/episodio/"], a[href*="/episodio/"]').toArray();

    for (const element of links) {
      const href = $(element).attr('href') || '';
      const epNum = readEpisodeNumber(`${$(element).text()} ${href}`);
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

  $('a[href*="/episodio/"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const text = `${$(element).text()} ${href}`;
    const seasonNum = readSeasonNumber(text);
    const epNum = readEpisodeNumber(text);

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

  for (const regex of directEpisodeRegexes) {
    const match = raw.match(regex);
    if (match?.[0]) return match[0];
  }

  const seasonIndex = targetSeason - 1;
  const episodeIndex = targetEpisode - 1;

  if (seasonIndex < 0 || episodeIndex < 0) return null;

  const legacySeasonBlocks = $('.les-content, [class*="season-"], [class*="stagione-"]');

  if (!options?.strictEpisode && legacySeasonBlocks.length > seasonIndex) {
    const block = legacySeasonBlocks.eq(seasonIndex);
    const episodes = block.find('a[href*="/episodio/"]');
    if (episodes.length > episodeIndex) return episodes.eq(episodeIndex).attr('href') || null;
  }

  return null;
}

function extractPlayerLinksFromHtml(html) {
  const raw = String(html || '');
  const links = new Set();
  const baseUrl = normalizeBaseUrl(getTargetDomain()) || INITIAL_GS_DOMAIN;

  const normalize = link => {
    let normalized = String(link).trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');

    if (!normalized || normalized.startsWith('data:')) return null;
    if (normalized.startsWith('//')) return `https:${normalized}`;
    if (normalized.startsWith('/')) return `${baseUrl}${normalized}`;
    if (!/^https?:\/\//i.test(normalized) && /(loadm|mixdrop|m1xdrop|mxcontent)/i.test(normalized)) {
      return `https://${normalized.replace(/^\/+/, '')}`;
    }

    return /^https?:\/\//i.test(normalized) ? normalized : null;
  };

  const iframeTags = raw.match(/<iframe\b[^>]*>/ig) || [];

  for (const tag of iframeTags) {
    const attrRegex = /\b(?:data-src|src)\s*=\s*(['"])(.*?)\1/ig;
    let match;

    while ((match = attrRegex.exec(tag)) !== null) {
      const candidate = normalize(match[2]);
      if (candidate && isLikelyPlayerUrl(candidate)) links.add(candidate);
    }
  }

  for (const regex of [COMPILED_DIRECT_REGEX, COMPILED_ESCAPED_REGEX]) {
    regex.lastIndex = 0;

    for (const match of raw.match(regex) || []) {
      const candidate = normalize(match);
      if (candidate && isLikelyPlayerUrl(candidate)) links.add(candidate);
    }
  }

  return Array.from(links);
}

async function asyncPool(limit, items, asyncFn) {
  if (!items.length) return [];

  const results = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  const running = new Set();

  async function runNext() {
    if (!queue.length) return;

    const { item, index } = queue.shift();
    const promise = Promise.resolve()
      .then(() => asyncFn(item))
      .catch(error => {
        if (!isAbortLikeError(error)) return null;
        throw error;
      })
      .then(result => {
        results[index] = result;
        running.delete(promise);
        return runNext();
      });

    running.add(promise);
    return promise;
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function searchGuardaserie(meta, config) {
  if (!meta?.isSeries || !config?.filters?.enableGs) return [];

  const kitsuInfo = getKitsuRequestFromMeta(meta);
  let season = parseInt(meta?.season, 10);
  let episode = parseInt(meta?.episode, 10) || kitsuInfo?.parsed?.episodeNumber || 1;

  if ((!season || season < 1) && kitsuInfo?.parsed?.kitsuId) season = kitsuInfo.parsed.seasonNumber || 1;
  if (!season || season < 1 || !episode || episode < 1) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

  try {
    return await _searchGuardaserie(meta, config, season, episode, controller.signal);
  } catch (error) {
    gsDebug('provider failed', { error: error?.message || String(error) });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function tryFastSlugTargets(expectedTitles = [], targetYear = null, signal = null) {
  if (!GS_FAST_SLUG_FIRST) return [];

  const candidates = [];
  const seen = new Set();

  for (const title of uniqueCleanStrings(expectedTitles, 8).filter(isUsableGsTitleForSearch)) {
    const slug = slugify(title);
    if (!slug) continue;

    for (const pathname of [`/serie/${slug}/`]) {
      const url = buildGsUrl(pathname);
      if (seen.has(url)) continue;

      seen.add(url);
      candidates.push(url);
    }
  }

  const out = [];
  gsDebug('fast slug start', { candidates: candidates.slice(0, 3) });

  for (const url of candidates.slice(0, 3)) {
    try {
      const html = await smartFetch(url, {
        ttl: TTL_SERIES,
        signal,
        allowFlareSolverr: true,
        timeoutMs: Math.min(DIRECT_FETCH_TIMEOUT_MS, 4200)
      });

      if (!html) continue;

      const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
      const titleScore = normalizeTitleScoreMany(pageTitle, expectedTitles);
      if (titleScore < 2) continue;

      const foundYear =
        html.match(/release-year\/(\d{4})/i)?.[1] ||
        html.match(/\b(19\d{2}|20\d{2})\b/)?.[1] ||
        null;

      if (targetYear && foundYear && Math.abs(Number(foundYear) - Number(targetYear)) > 3) continue;

      out.push({ url, html, title: pageTitle || url, mapped: true, fastSlug: true, score: titleScore });
      if (titleScore >= 3) break;
    } catch (error) {
      if (isAbortLikeError(error) && signal?.aborted) throw error;
      gsDebug('fast slug candidate failed', { url, error: error?.message || String(error) });
    }
  }

  if (out.length) gsInfo('fast slug matched', { count: out.length, first: out[0].url });
  return out;
}

async function _searchGuardaserie(meta, config, season, episode, signal) {
  const providerStartedAt = Date.now();

  gsDebug('provider start', {
    title: meta?.title || meta?.name,
    season,
    episode,
    budgetMs: GLOBAL_TIMEOUT_MS,
    flareUrl: FLARESOLVERR_URL
  });

  await refreshTargetDomain(signal);

  gsDebug('domain ready', {
    base: getTargetDomain(),
    ms: Date.now() - providerStartedAt,
    probed: GS_REFRESH_DOMAIN_ON_START
  });

  if (signal?.aborted) return [];

  const strictKitsuContext = await buildStrictKitsuAnimeContext(meta, config, season, episode);
  const animeContext = strictKitsuContext || await buildSharedAnimeContext(meta, config, season, episode);
  const strictKitsu = Boolean(animeContext?.strictKitsu);

  gsDebug('identity ready', {
    isAnime: Boolean(animeContext?.isAnime),
    strictKitsu,
    ms: Date.now() - providerStartedAt
  });

  if (animeContext?.isAnime) {
    const mappedSeason = parseInt(animeContext.seasonNumber, 10);
    const mappedEpisode = parseInt(animeContext.requestedEpisode, 10);

    if (mappedSeason > 0) season = mappedSeason;
    if (mappedEpisode > 0) episode = mappedEpisode;
  }

  let tmdbId = strictKitsu ? null : (meta?.tmdb_id || meta?.tmdbId || animeContext?.tmdbId || animeContext?.mappedIds?.tmdbId || null);

  if (!strictKitsu && !tmdbId && (meta?.imdb_id || animeContext?.imdbId)) {
    const resolved = await tmdbHelper.getTmdbFromImdb(meta.imdb_id || animeContext.imdbId, { mediaHint: 'tv' }).catch(() => null);
    if (resolved) tmdbId = resolved;
  }

  let showName = strictKitsu ? (animeContext?.title || meta?.title || meta?.name || null) : (meta?.title || animeContext?.title || null);
  let originalTitle = animeContext?.rawTitles?.find(title => normalizeText(title) !== normalizeText(showName)) || null;
  let targetYear = animeContext?.year || null;

  if (tmdbId) {
    const tmdbMeta = await tmdbHelper.getMediaInfoFull(tmdbId, 'tv', { language: 'it-IT' }).catch(() => null);

    if (tmdbMeta) {
      showName = tmdbMeta.title || showName;
      originalTitle = tmdbMeta.original_title || originalTitle || null;
      targetYear = tmdbMeta.year || targetYear || null;
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
  ], 18).filter(isUsableGsTitleForSearch).slice(0, 14);

  showName = showName || expectedTitles[0] || null;
  if (!showName) return [];

  const queries = uniqueCleanStrings(expectedTitles, animeContext?.isAnime ? 8 : 4);
  const mappedResults = (Array.isArray(animeContext?.mappingUrls) ? animeContext.mappingUrls : [])
    .map(url => ({ url, title: showName || url, mapped: true }));
  const fastSlugResults = await tryFastSlugTargets(expectedTitles, targetYear, signal);

  gsDebug('fast slug done', {
    results: fastSlugResults.length,
    ms: Date.now() - providerStartedAt
  });

  let allResults = [...mappedResults, ...fastSlugResults];

  if (!fastSlugResults.length) {
    allResults.push(...await searchProviderParallel(queries, signal));
    gsDebug('search fallback done', {
      totalResults: allResults.length,
      ms: Date.now() - providerStartedAt
    });
  }

  allResults = Array.from(new Map(allResults.map(item => [item.url, item])).values());

  const seriesResults = allResults.filter(result => /\/serie\//i.test(result.url));
  const episodeResults = allResults.filter(result => /\/episodio\//i.test(result.url));

  allResults = strictKitsu && seriesResults.length ? seriesResults : [...seriesResults, ...episodeResults];
  allResults.sort((a, b) => normalizeTitleScoreMany(b.title, expectedTitles) - normalizeTitleScoreMany(a.title, expectedTitles));

  let target = null;
  let bestLoose = null;

  for (const result of allResults) {
    const titleScore = normalizeTitleScoreMany(result.title, expectedTitles);
    if (titleScore < 1) continue;

    const html = result.html || await smartFetch(result.url, {
      ttl: TTL_SERIES,
      signal,
      allowFlareSolverr: true,
      timeoutMs: DIRECT_FETCH_TIMEOUT_MS
    });

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
    const slugs = uniqueCleanStrings(expectedTitles, 3).map(slugify).filter(Boolean);

    outer: for (const slug of slugs) {
      for (const pathname of [`/serie/${slug}/`, `/${slug}/`, `/serietv/${slug}/`]) {
        const url = buildGsUrl(pathname);
        const html = await smartFetch(url, {
          ttl: TTL_SERIES,
          signal,
          allowFlareSolverr: true,
          timeoutMs: Math.min(DIRECT_FETCH_TIMEOUT_MS, 4200)
        });

        if (!html) continue;

        const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
        if (normalizeTitleScoreMany(pageTitle, expectedTitles) >= 2) {
          target = { url, html };
          break outer;
        }
      }
    }
  }

  if (!target?.url) return [];

  const episodeUrl = extractEpisodeUrlFromSeriesPage(target.html, season, episode, { strictEpisode: strictKitsu });
  if (!episodeUrl) return [];

  const absoluteEpUrl = new URL(episodeUrl, getTargetDomain()).toString();
  const finalHtml = await smartFetch(absoluteEpUrl, {
    ttl: TTL_EPISODE,
    signal,
    allowFlareSolverr: true,
    timeoutMs: DIRECT_FETCH_TIMEOUT_MS
  });

  const playerLinks = Array.from(new Set(extractPlayerLinksFromHtml(finalHtml))).slice(0, 5);
  if (!playerLinks.length) return [];

  const cleanTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const sessionUA = activeSession.userAgent || pickRandomProfile(BROWSER_PROFILES).ua;

  const processedResults = await asyncPool(2, playerLinks, async link => {
    try {
      const extracted = await extractFromUrl(link, {
        client: lightClient,
        userAgent: sessionUA,
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
        name: `GuardoSerie | ${extracted.name}`,
        title: `${cleanTitle}\n ${extracted.name}  ITA`,
        url: extracted.url,
        extractor: extracted.name,
        provider: 'GuardoSerie',
        providerCode: 'GS',
        quality,
        headers: extracted.headers,
        extra: { _priority: extracted.priority ?? 9 }
      });
    } catch (_) {
      return null;
    }
  });

  return processedResults
    .filter(Boolean)
    .sort((a, b) => {
      const qDelta = qualityRank(b.quality) - qualityRank(a.quality);
      return qDelta !== 0 ? qDelta : getStreamPriority(a) - getStreamPriority(b);
    })
    .filter((stream, index, arr) => {
      const key = normalizeStreamUrl(stream.url);
      return arr.findIndex(item => normalizeStreamUrl(item.url) === key) === index;
    })
    .map(stream => {
      if (stream.extra) delete stream.extra._priority;
      delete stream._priority;
      return stream;
    });
}

activeSession = loadSession();

const flareSolverrClient = createFlareSolverrClient({
  providerName: PROVIDER_NAME,
  endpoint: FLARESOLVERR_URL,
  circuitThreshold: FS_CIRCUIT_THRESHOLD,
  circuitResetMs: FS_CIRCUIT_RESET_MS,
  isCanceledError,
  onSolution(data) {
    activeSession = data;
    saveSession(data);
    if (data.url) updateCurrentDomainFromUrl(data.url);
  }
});

module.exports = {
  searchGuardaserie,
  searchGuardoSerie: searchGuardaserie
};
