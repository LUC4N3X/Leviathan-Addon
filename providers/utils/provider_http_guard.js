'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { isCanceledError: defaultIsCanceledError, isCloudflareChallenge } = require('./bypass');
const { createCfClearanceManager, normalizeBaseUrl, mergeCookieHeaders } = require('./cf_clearance_manager');

class LRUCache {
  constructor(maxSize) {
    this._max = Math.max(25, Number(maxSize || 500));
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
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envFlagNotFalse(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function isAbortLikeError(error, isCanceledError = defaultIsCanceledError) {
  if (isCanceledError(error)) return true;
  const name = String(error?.name || '');
  const code = String(error?.code || '');
  const msg = String(error?.message || error || '');
  return (
    name === 'AbortError' ||
    name === 'CanceledError' ||
    code === 'ERR_CANCELED' ||
    /(?:operation was aborted|aborted by|parent aborted|canceled|cancelled)/i.test(msg)
  );
}

function createLogger(prefix, debugEnabled, cfEnabled) {
  const shouldDebug = Boolean(debugEnabled || cfEnabled);
  return {
    debug(message, meta = null) {
      if (!shouldDebug) return;
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      console.log(`[${prefix}:debug] ${message}${suffix}`);
    },
    info(message, meta = null) {
      if (!cfEnabled && !debugEnabled) return;
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      console.log(`[${prefix}] ${message}${suffix}`);
    },
    warn(message, meta = null) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      console.warn(`[${prefix}] ${message}${suffix}`);
    }
  };
}

function createProviderHttpGuard(options = {}) {
  const providerName = options.providerName || 'provider';
  const logPrefix = options.logPrefix || `${providerName.toUpperCase()}-SHIELD`;
  const initialBaseUrl = normalizeBaseUrl(options.initialBaseUrl) || 'https://example.com';
  const sessionFile = options.sessionFile || path.join(process.cwd(), `cf-session-${providerName}.json`);
  const domainFile = options.domainFile || path.join(process.cwd(), `${providerName}-domain.json`);
  const profiles = Array.isArray(options.profiles) ? options.profiles : [];
  const pickProfile = typeof options.pickProfile === 'function' ? options.pickProfile : list => (Array.isArray(list) ? list[0] : null);
  const isCanceledError = typeof options.isCanceledError === 'function' ? options.isCanceledError : defaultIsCanceledError;
  const debugEnabled = Boolean(options.debug || options.debugCf);
  const logger = options.logger || createLogger(logPrefix, debugEnabled, Boolean(options.debugCf));

  const agentOptions = {
    keepAlive: true,
    maxSockets: Number(options.maxSockets || 250),
    maxFreeSockets: Number(options.maxFreeSockets || 100),
    timeout: Number(options.agentTimeoutMs || 30000),
    keepAliveMsecs: Number(options.keepAliveMsecs || 30000)
  };
  const httpAgent = options.httpAgent || new http.Agent(agentOptions);
  const httpsAgent = options.httpsAgent || new https.Agent(agentOptions);

  const lightClient = axios.create({
    timeout: Number(options.clientTimeoutMs || 10000),
    httpAgent,
    httpsAgent,
    validateStatus: status => status >= 200 && status < 500,
    headers: { 'Accept-Language': options.acceptLanguage || 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' }
  });

  const requestCache = new LRUCache(options.maxCacheItems || 500);
  const pendingRequests = new Map();

  const sessionTtlMs = Math.max(60_000, Number(options.sessionTtlMs || 6 * 60 * 60 * 1000));
  const domainRefreshTtlMs = Math.max(60_000, Number(options.domainRefreshTtlMs || 20 * 60 * 1000));
  const directFetchTimeoutMs = Math.max(2500, Number(options.directFetchTimeoutMs || 4200));
  const searchTimeoutMs = Math.max(8000, Number(options.searchTimeoutMs || 12000));
  const clearanceTimeoutMs = Math.max(12000, Number(options.clearanceTimeoutMs || 24000));
  const refreshDomainOnStart = Boolean(options.refreshDomainOnStart);
  const domainProbeTimeoutMs = Math.max(1200, Number(options.domainProbeTimeoutMs || 2500));
  const targetUrlClearance = options.targetUrlClearance !== false;
  const homepageFallback = Boolean(options.homepageFallback);

  function loadStoredDomain() {
    try {
      if (!fs.existsSync(domainFile)) return null;
      const data = JSON.parse(fs.readFileSync(domainFile, 'utf8'));
      return normalizeBaseUrl(data?.baseUrl) || null;
    } catch (_) { return null; }
  }

  function saveStoredDomain(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) return;
    try { fs.writeFileSync(domainFile, JSON.stringify({ baseUrl: normalized, updatedAt: Date.now() }, null, 2)); } catch (_) {}
  }

  function loadSession() {
    try {
      if (!fs.existsSync(sessionFile)) return {};
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      return data?.userAgent ? data : {};
    } catch (_) { return {}; }
  }

  function saveSession(sessionData) {
    try { fs.writeFileSync(sessionFile, JSON.stringify(sessionData || {}, null, 2)); } catch (_) {}
  }

  let currentBaseUrl = loadStoredDomain() || initialBaseUrl;
  let activeSession = loadSession();
  let lastDomainRefresh = 0;
  let domainRefreshPromise = null;

  function getProfileUserAgent(profile = null) {
    const fallback = options.fallbackUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
    if (profile?.ua || profile?.userAgent) return profile.ua || profile.userAgent;
    const picked = pickProfile(profiles) || {};
    return picked.ua || picked.userAgent || fallback;
  }

  function getCurrentBaseUrl() { return currentBaseUrl; }

  function updateCurrentDomainFromUrl(url) {
    const nextBase = normalizeBaseUrl(url);
    if (!nextBase || nextBase === currentBaseUrl) return false;
    currentBaseUrl = nextBase;
    saveStoredDomain(nextBase);
    if (activeSession?.url) {
      activeSession.url = nextBase;
      activeSession.timestamp = Date.now();
      saveSession(activeSession);
    }
    return true;
  }

  if (activeSession?.url) updateCurrentDomainFromUrl(activeSession.url);

  function getFallbackUserAgent() {
    return getProfileUserAgent(activeSession);
  }

  const clearanceManager = createCfClearanceManager({
    providerName,
    endpoint: options.flareEndpoint || process.env.FLARESOLVERR_URL,
    sessionTtlMs,
    cooldownMs: options.clearanceCooldownMs || 8000,
    solveTimeoutMs: clearanceTimeoutMs,
    httpAgent,
    httpsAgent,
    isCanceledError,
    getFallbackUserAgent,
    logger: {
      debug: logger.debug,
      info: (message, meta) => logger.info(`clearance ${message}`, meta),
      warn: (message, meta) => logger.warn(`clearance ${message}`, meta)
    },
    onSession(session) {
      activeSession = {
        ...session,
        url: normalizeBaseUrl(session.url) || currentBaseUrl,
        timestamp: Date.now()
      };
      saveSession(activeSession);
      if (activeSession.url) updateCurrentDomainFromUrl(activeSession.url);
    }
  });

  function isSessionFresh(session = activeSession) {
    return clearanceManager.isFresh(session);
  }

  function clearSession() {
    activeSession = {};
    try { fs.unlinkSync(sessionFile); } catch (_) {}
  }

  function buildProviderUrl(pathname) {
    const cleanPath = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
    return `${currentBaseUrl}${cleanPath}`;
  }

  function buildClearanceUrl(triggerUrl, { isPost = false, body = null } = {}) {
    const base = normalizeBaseUrl(triggerUrl) || normalizeBaseUrl(currentBaseUrl) || initialBaseUrl;
    if (!targetUrlClearance) return `${base}/`;

    if (isPost) {
      try {
        const params = new URLSearchParams(String(body || ''));
        const query = params.get('swpquery') || params.get('s') || params.get('query') || '';
        if (query) return `${base}/?s=${encodeURIComponent(query)}`;
      } catch (_) {}
      return `${base}/`;
    }

    try { return new URL(String(triggerUrl || ''), base).toString(); }
    catch (_) { return `${base}/`; }
  }

  async function resolveRedirectDomain(startBase, signal = null) {
    const base = normalizeBaseUrl(startBase);
    if (!base || signal?.aborted) return null;
    try {
      const response = await lightClient.get(base, {
        timeout: domainProbeTimeoutMs,
        signal,
        maxRedirects: 5,
        headers: {
          'User-Agent': getProfileUserAgent(activeSession),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': options.acceptLanguage || 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      return normalizeBaseUrl(response?.request?.res?.responseUrl || response?.config?.url || base) || base;
    } catch (error) {
      logger.debug('domain probe skipped', { base, error: error?.code || error?.message || String(error), timeoutMs: domainProbeTimeoutMs });
      return null;
    }
  }

  async function refreshTargetDomain(signal = null, { force = false } = {}) {
    if (signal?.aborted) return currentBaseUrl;
    if (!force && !refreshDomainOnStart) {
      lastDomainRefresh = Date.now();
      return currentBaseUrl;
    }

    const now = Date.now();
    if (!force && now - lastDomainRefresh < domainRefreshTtlMs) return currentBaseUrl;
    if (domainRefreshPromise) return domainRefreshPromise;

    domainRefreshPromise = (async () => {
      lastDomainRefresh = Date.now();
      const candidates = Array.from(new Map([
        [currentBaseUrl, true],
        [loadStoredDomain(), true],
        [initialBaseUrl, true]
      ].filter(([key]) => key)).keys());

      for (const candidate of candidates) {
        if (signal?.aborted) break;
        const resolved = await resolveRedirectDomain(candidate, signal);
        if (resolved) {
          updateCurrentDomainFromUrl(resolved);
          return currentBaseUrl;
        }
      }
      return currentBaseUrl;
    })().finally(() => { domainRefreshPromise = null; });

    return domainRefreshPromise;
  }

  function isChallengePage(html, status = 200) {
    const raw = typeof html === 'string' ? html : String(html || '');
    if (!raw) return true;
    const lower = raw.slice(0, 250000).toLowerCase();

    if ([403, 429, 503].includes(Number(status))) return true;
    if (isCloudflareChallenge(raw, status)) return true;
    if (typeof options.challengeDetector === 'function' && options.challengeDetector(raw, status)) return true;

    const signals = [
      'turnstile.cloudflare.com', 'cf-turnstile', 'cf_chl_', '__cf_chl_',
      'cf-browser-verification', 'cf_captcha_kind', 'cf_clearance',
      'challenge-platform', 'challenge-form', 'cf-challenge', 'g-recaptcha',
      'h-captcha', 'hcaptcha.com', 'checking if the site connection is secure',
      'verify you are human', 'verifica di essere umano', 'verifica che sei umano',
      'verifica che tu sia umano', 'controllo connessione al sito',
      'just a moment', 'un momento', 'ray id'
    ];

    let score = 0;
    for (const token of signals) if (lower.includes(token)) score += 2;
    if (lower.includes('cloudflare') && (lower.includes('captcha') || lower.includes('challenge') || lower.includes('turnstile'))) score += 4;
    if (/<title>\s*(just a moment|attention required|verifica|checking)/i.test(raw)) score += 4;
    if (/id=["']?challenge-|class=["'][^"']*(cf-|challenge|turnstile)/i.test(raw)) score += 3;
    return score >= 3;
  }

  function buildHeaders({ session = null, method = 'GET', body = null, directProfile = null } = {}) {
    const profile = directProfile || pickProfile(profiles) || {};
    const userAgent = session?.userAgent || getProfileUserAgent(profile);
    const headers = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': options.acceptLanguage || 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': currentBaseUrl,
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Site': 'same-origin'
    };

    if (session?.cookies) headers.Cookie = session.cookies;
    if (profile.sec_ch_ua) {
      headers['sec-ch-ua'] = profile.sec_ch_ua;
      headers['sec-ch-ua-mobile'] = '?0';
      headers['sec-ch-ua-platform'] = '"Windows"';
    }

    if (method === 'POST' && body) {
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
  }

  async function axiosSiteRequest(url, { method = 'GET', body = null, headers = {}, timeout = directFetchTimeoutMs, signal = null, maxRedirects = 6 } = {}) {
    const startedAt = Date.now();
    const response = await axios.request({
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
      response?.request?.res?.responseUrl ||
      response?.request?._redirectable?._currentUrl ||
      response?.config?.url ||
      url;

    return {
      status: response.status,
      headers: response.headers || {},
      data: typeof response.data === 'string' ? response.data : String(response.data || ''),
      url: responseUrl,
      ms: Date.now() - startedAt
    };
  }

  function persistSession(session, resolvedUrl = null, setCookie = null) {
    if (!session?.userAgent) return;
    const next = {
      ...session,
      url: normalizeBaseUrl(resolvedUrl || session.url) || session.url || currentBaseUrl,
      timestamp: Date.now()
    };
    if (setCookie) next.cookies = mergeCookieHeaders(session.cookies, setCookie);
    activeSession = next;
    saveSession(activeSession);
    if (next.url) updateCurrentDomainFromUrl(next.url);
  }

  async function fetchWithSession(url, { method = 'GET', body = null, signal = null, timeout = directFetchTimeoutMs, startedAt = Date.now() } = {}) {
    if (!isSessionFresh(activeSession)) return null;
    const response = await axiosSiteRequest(url, {
      method,
      body: method === 'POST' ? body : null,
      headers: buildHeaders({ session: activeSession, method, body }),
      timeout: Math.max(timeout, 4500),
      signal
    });

    updateCurrentDomainFromUrl(response.url);
    const html = typeof response.data === 'string' ? response.data : String(response.data || '');
    if (isChallengePage(html, response.status)) {
      logger.debug('session fetch rejected', { method, url, status: response.status, bytes: html.length, challenge: true, ms: Date.now() - startedAt });
      clearSession();
      return null;
    }

    persistSession(activeSession, response.url, response.headers?.['set-cookie']);
    logger.debug('session fetch ok', { method, url, status: response.status, bytes: html.length, ms: Date.now() - startedAt });
    return html;
  }

  async function fetchDirectFast(url, { method = 'GET', body = null, signal = null, timeout = directFetchTimeoutMs, startedAt = Date.now() } = {}) {
    const profile = pickProfile(profiles) || {};
    const userAgent = getProfileUserAgent(profile);
    const response = await axiosSiteRequest(url, {
      method,
      body: method === 'POST' ? body : null,
      headers: buildHeaders({ method, body, directProfile: profile }),
      timeout,
      signal
    });

    updateCurrentDomainFromUrl(response.url);
    const html = typeof response.data === 'string' ? response.data : String(response.data || '');
    if (isChallengePage(html, response.status)) {
      logger.debug('direct fetch rejected', { method, url, status: response.status, bytes: html.length, challenge: true, ms: Date.now() - startedAt });
      return null;
    }

    const setCookie = response.headers?.['set-cookie'];
    if (setCookie) {
      const cookies = mergeCookieHeaders('', setCookie);
      if (cookies) persistSession({ userAgent, cookies, url: response.url, timestamp: Date.now() }, response.url);
    }

    logger.debug('direct fetch ok', { method, url, status: response.status, bytes: html.length, hasCookie: Boolean(setCookie), ms: Date.now() - startedAt });
    return html;
  }

  async function solveClearance(triggerUrl, { isPost = false, body = null, signal = null, force = true } = {}) {
    const clearanceUrl = buildClearanceUrl(triggerUrl, { isPost, body });
    let session = await clearanceManager.solve(clearanceUrl, signal, {
      triggerUrl,
      method: isPost ? 'POST' : 'GET',
      force,
      maxTimeout: clearanceTimeoutMs
    });

    if (isSessionFresh(session)) return session;
    if (homepageFallback) {
      const base = normalizeBaseUrl(triggerUrl) || currentBaseUrl;
      const homepage = `${base}/`;
      if (homepage !== clearanceUrl) {
        session = await clearanceManager.solve(homepage, signal, {
          triggerUrl,
          method: isPost ? 'POST' : 'GET',
          force,
          fallback: true,
          maxTimeout: clearanceTimeoutMs
        });
      }
    }
    return isSessionFresh(session) ? session : null;
  }

  async function executeSmartFetch(url, isPost = false, body = null, signal = null, allowFlareSolverr = true, timeoutMs = directFetchTimeoutMs) {
    const startedAt = Date.now();
    const method = isPost ? 'POST' : 'GET';
    const hardFetchTimeout = Math.max(2500, Math.min(timeoutMs, directFetchTimeoutMs));
    logger.debug('fetch start', { method, url, hasSession: isSessionFresh(), allowClearance: allowFlareSolverr, timeoutMs: hardFetchTimeout });

    if (isSessionFresh()) {
      try {
        const html = await fetchWithSession(url, { method, body, signal, timeout: hardFetchTimeout, startedAt });
        if (html) return html;
      } catch (error) {
        if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
        logger.debug('session fetch error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      }
    }

    try {
      const html = await fetchDirectFast(url, { method, body, signal, timeout: hardFetchTimeout, startedAt });
      if (html) return html;
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('direct fetch error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
    }

    if (!allowFlareSolverr) return null;

    const session = await solveClearance(url, { isPost, body, signal, force: true });
    if (!isSessionFresh(session)) {
      logger.warn('clearance no fresh session', { method, url, ms: Date.now() - startedAt });
      return null;
    }

    try {
      const html = await fetchWithSession(url, { method, body, signal, timeout: hardFetchTimeout, startedAt });
      if (html) {
        logger.info('post-clearance fetch ok', { method, url, transport: 'axios', ms: Date.now() - startedAt });
        return html;
      }
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('post-clearance fetch error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      clearSession();
    }

    return null;
  }

  async function smartFetch(url, { isPost = false, body = null, ttl = 30 * 60 * 1000, signal = null, allowFlareSolverr = true, timeoutMs = directFetchTimeoutMs } = {}) {
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

  return {
    lightClient,
    httpAgent,
    httpsAgent,
    smartFetch,
    refreshTargetDomain,
    buildProviderUrl,
    getCurrentBaseUrl,
    updateCurrentDomainFromUrl,
    normalizeBaseUrl,
    clearSession,
    getSession: () => activeSession,
    isSessionFresh,
    isAbortLikeError: error => isAbortLikeError(error, isCanceledError),
    getEndpoint: () => clearanceManager.endpoint,
    isDomainProbeEnabled: () => refreshDomainOnStart,
    directFetchTimeoutMs,
    searchTimeoutMs,
    clearanceTimeoutMs,
    logger
  };
}

module.exports = {
  createProviderHttpGuard,
  isAbortLikeError,
  envFlag,
  envFlagNotFalse
};
