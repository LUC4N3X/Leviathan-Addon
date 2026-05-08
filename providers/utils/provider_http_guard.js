'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const {
  getImpitBrowserForFingerprint,
  isCanceledError: defaultIsCanceledError,
  isCloudflareChallenge,
  requestWithImpit,
  requestWithImpitRotating
} = require('./bypass');
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
  const originClearance = Boolean(options.originClearance);
  const clearanceForce = options.clearanceForce !== false;
  const targetUrlClearance = options.targetUrlClearance !== false;
  const targetFallbackAfterOrigin = Boolean(options.targetFallbackAfterOrigin);
  const homepageFallback = Boolean(options.homepageFallback);
  const preferImpit = options.preferImpit !== false;
  const impitTurbo = options.impitTurbo !== false;
  const impitMaxAttempts = Math.max(1, Math.min(4, Number(options.impitMaxAttempts || 2) || 2));
  const impitTotalExtraMs = Math.max(250, Math.min(2500, Number(options.impitTotalExtraMs || 1400) || 1400));
  const impitBrowserFallbacks = Array.isArray(options.impitBrowserFallbacks) ? options.impitBrowserFallbacks : null;
  const impitChallengeStatuses = Array.isArray(options.impitChallengeStatuses) && options.impitChallengeStatuses.length
    ? options.impitChallengeStatuses
    : [403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524];
  const impitHttp3 = options.impitHttp3 === true;
  const impitSessionFastPath = options.impitSessionFastPath !== false;
  const impitAfterSessionChallenge = options.impitAfterSessionChallenge !== false;
  const impitPreClearanceRescue = options.impitPreClearanceRescue !== false;
  const impitPreClearanceWhenFlareSolverr = options.impitPreClearanceWhenFlareSolverr !== false;
  const impitPreClearanceTimeoutMs = Math.max(1200, Math.min(4500, Number(options.impitPreClearanceTimeoutMs || 2600) || 2600));

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

  function buildHomepageClearanceUrl(triggerUrl) {
    const base = normalizeBaseUrl(triggerUrl) || normalizeBaseUrl(currentBaseUrl) || initialBaseUrl;
    return `${base}/`;
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

  async function axiosSiteRequest(url, { method = 'GET', body = null, headers = {}, timeout = directFetchTimeoutMs, signal = null, maxRedirects = 6, browserProfile = null, useImpit = preferImpit, impitAttempts = null, impitTotalExtra = null } = {}) {
    const startedAt = Date.now();
    if (useImpit && preferImpit) {
      try {
        const baseImpitOptions = {
          url,
          method,
          body: method === 'POST' ? body : null,
          headers,
          timeout,
          signal,
          maxRedirects,
          followRedirect: maxRedirects !== 0,
          responseType: 'text',
          fingerprint: browserProfile || activeSession,
          browser: getImpitBrowserForFingerprint(browserProfile || activeSession),
          browserFallbacks: impitBrowserFallbacks,
          maxBrowserAttempts: Math.max(1, Math.min(4, Number(impitAttempts || (method === 'GET' ? impitMaxAttempts : Math.min(2, impitMaxAttempts))) || 1)),
          totalTimeoutMs: Math.max(timeout, Math.min(timeout + (impitTotalExtra == null ? impitTotalExtraMs : Number(impitTotalExtra) || 0), timeout * 2)),
          retryOnStatuses: impitChallengeStatuses,
          retryOnChallenge: true,
          http3: impitHttp3,
          forceHttp3: false,
          ignoreTlsErrors: options.ignoreTlsErrors === true
        };
        const response = impitTurbo
          ? await requestWithImpitRotating(baseImpitOptions)
          : await requestWithImpit(baseImpitOptions);

        if (response) {
          logger.debug('impit fetch result', {
            method,
            url,
            status: response.statusCode,
            browser: response.impitBrowser,
            attempts: response.impitAttempts || 1,
            ms: Date.now() - startedAt
          });
          return {
            status: response.statusCode,
            headers: response.headers || {},
            data: typeof response.body === 'string' ? response.body : String(response.body || ''),
            url: response.url || url,
            ms: Date.now() - startedAt,
            via: response.impitAttempts > 1 ? `impit:${response.impitBrowser}:${response.impitAttempts}` : 'impit'
          };
        }
      } catch (error) {
        if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
        logger.debug('impit fetch error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      }
    }

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
      ms: Date.now() - startedAt,
      via: 'axios'
    };
  }

  async function fetchImpitRescue(url, { method = 'GET', body = null, signal = null, timeout = impitPreClearanceTimeoutMs, startedAt = Date.now(), headers = null, browserProfile = null, reason = 'pre-clearance', allowClearance = false } = {}) {
    if (!preferImpit || !impitPreClearanceRescue || signal?.aborted) return null;
    if (allowClearance && clearanceManager.endpoint && !impitPreClearanceWhenFlareSolverr) {
      logger.debug('impit rescue skipped', { method, url, reason, clearance: true, ms: Date.now() - startedAt });
      return null;
    }

    try {
      const response = await axiosSiteRequest(url, {
        method,
        body: method === 'POST' ? body : null,
        headers: headers || buildHeaders({ method, body, directProfile: browserProfile }),
        timeout: Math.max(1200, Math.min(timeout, impitPreClearanceTimeoutMs)),
        signal,
        browserProfile: browserProfile || activeSession,
        useImpit: true,
        impitAttempts: Math.min(2, impitMaxAttempts),
        impitTotalExtra: 300
      });

      updateCurrentDomainFromUrl(response.url);
      const html = typeof response.data === 'string' ? response.data : String(response.data || '');
      if (!isChallengePage(html, response.status)) {
        const setCookie = response.headers?.['set-cookie'];
        if (activeSession?.cookies || setCookie) {
          persistSession({
            userAgent: (browserProfile && (browserProfile.userAgent || browserProfile.ua)) || activeSession?.userAgent || getProfileUserAgent(browserProfile),
            cookies: activeSession?.cookies || '',
            url: response.url,
            timestamp: Date.now()
          }, response.url, setCookie);
        }
        logger.debug('impit rescue ok', { method, url, reason, status: response.status, bytes: html.length, via: response.via, ms: Date.now() - startedAt, hasCookie: Boolean(activeSession?.cookies || setCookie) });
        return html;
      }

      logger.debug('impit rescue rejected', { method, url, reason, status: response.status, bytes: html.length, via: response.via, ms: Date.now() - startedAt });
      return null;
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('impit rescue error', { method, url, reason, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      return null;
    }
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
      signal,
      browserProfile: activeSession,
      useImpit: !impitSessionFastPath,
      impitAttempts: 1,
      impitTotalExtra: 350
    });

    updateCurrentDomainFromUrl(response.url);
    const html = typeof response.data === 'string' ? response.data : String(response.data || '');
    if (isChallengePage(html, response.status)) {
      logger.debug('session fetch rejected', { method, url, status: response.status, bytes: html.length, challenge: true, via: response.via, ms: Date.now() - startedAt });

      if (impitSessionFastPath && impitAfterSessionChallenge) {
        try {
          const impitResponse = await axiosSiteRequest(url, {
            method,
            body: method === 'POST' ? body : null,
            headers: buildHeaders({ session: activeSession, method, body }),
            timeout: Math.max(1800, Math.min(timeout, 2600)),
            signal,
            browserProfile: activeSession,
            useImpit: true,
            impitAttempts: 1,
            impitTotalExtra: 250
          });
          updateCurrentDomainFromUrl(impitResponse.url);
          const impitHtml = typeof impitResponse.data === 'string' ? impitResponse.data : String(impitResponse.data || '');
          if (!isChallengePage(impitHtml, impitResponse.status)) {
            persistSession(activeSession, impitResponse.url, impitResponse.headers?.['set-cookie']);
            logger.debug('session impit rescue ok', { method, url, status: impitResponse.status, bytes: impitHtml.length, via: impitResponse.via, ms: Date.now() - startedAt });
            return impitHtml;
          }
        } catch (error) {
          if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
          logger.debug('session impit rescue error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
        }
      }

      clearSession();
      return null;
    }

    persistSession(activeSession, response.url, response.headers?.['set-cookie']);
    logger.debug('session fetch ok', { method, url, status: response.status, bytes: html.length, via: response.via, ms: Date.now() - startedAt });
    return html;
  }

  async function fetchDirectFast(url, { method = 'GET', body = null, signal = null, timeout = directFetchTimeoutMs, startedAt = Date.now(), allowClearance = false } = {}) {
    const profile = pickProfile(profiles) || {};
    const userAgent = getProfileUserAgent(profile);
    const headers = buildHeaders({ method, body, directProfile: profile });
    let response = null;

    try {
      response = await axiosSiteRequest(url, {
        method,
        body: method === 'POST' ? body : null,
        headers,
        timeout,
        signal,
        browserProfile: profile,
        // Cheap probe first. If FlareSolverr exists, do not pay Impit cost unless the probe is blocked.
        useImpit: !clearanceManager.endpoint
      });
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('direct fetch transport error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      return fetchImpitRescue(url, { method, body, signal, timeout: Math.min(timeout, impitPreClearanceTimeoutMs), startedAt, headers, browserProfile: profile, reason: 'direct-error', allowClearance });
    }

    updateCurrentDomainFromUrl(response.url);
    const html = typeof response.data === 'string' ? response.data : String(response.data || '');
    if (isChallengePage(html, response.status)) {
      logger.debug('direct fetch rejected', { method, url, status: response.status, bytes: html.length, challenge: true, ms: Date.now() - startedAt });
      const rescued = await fetchImpitRescue(url, { method, body, signal, timeout: Math.min(timeout, impitPreClearanceTimeoutMs), startedAt, headers, browserProfile: profile, reason: 'direct-challenge', allowClearance });
      if (rescued) return rescued;
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
    const targetClearanceUrl = buildClearanceUrl(triggerUrl, { isPost, body });
    const homepageClearanceUrl = buildHomepageClearanceUrl(triggerUrl);
    const clearanceUrl = originClearance ? homepageClearanceUrl : targetClearanceUrl;
    let session = await clearanceManager.solve(clearanceUrl, signal, {
      triggerUrl,
      method: isPost ? 'POST' : 'GET',
      force,
      maxTimeout: clearanceTimeoutMs,
      cookies: activeSession?.cookies || ''
    });

    if (isSessionFresh(session)) return session;

    const fallbacks = [];
    if (originClearance && targetFallbackAfterOrigin && targetClearanceUrl !== clearanceUrl) fallbacks.push(targetClearanceUrl);
    if (homepageFallback && homepageClearanceUrl !== clearanceUrl && homepageClearanceUrl !== targetClearanceUrl) fallbacks.push(homepageClearanceUrl);

    for (const fallbackUrl of fallbacks) {
      if (signal?.aborted) return null;
      session = await clearanceManager.solve(fallbackUrl, signal, {
        triggerUrl,
        method: isPost ? 'POST' : 'GET',
        force,
        fallback: true,
        maxTimeout: clearanceTimeoutMs,
        cookies: activeSession?.cookies || ''
      });
      if (isSessionFresh(session)) return session;
    }
    return null;
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
      const html = await fetchDirectFast(url, { method, body, signal, timeout: hardFetchTimeout, startedAt, allowClearance: allowFlareSolverr });
      if (html) return html;
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('direct fetch error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
    }

    if (!allowFlareSolverr || signal?.aborted) return null;

    const session = await solveClearance(url, { isPost, body, signal, force: clearanceForce });
    if (!isSessionFresh(session)) {
      logger.warn('clearance no fresh session', { method, url, ms: Date.now() - startedAt });
      return null;
    }

    try {
      const html = await fetchWithSession(url, { method, body, signal, timeout: hardFetchTimeout, startedAt });
      if (html) {
        logger.info('post-clearance fetch ok', { method, url, transport: 'session-fastpath', sessionFresh: isSessionFresh(), ms: Date.now() - startedAt });
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
    getImpitShieldState: () => ({
      enabled: preferImpit,
      turbo: impitTurbo,
      maxAttempts: impitMaxAttempts,
      http3: impitHttp3,
      sessionFastPath: impitSessionFastPath,
      preClearanceRescue: impitPreClearanceRescue,
      preClearanceWhenFlareSolverr: impitPreClearanceWhenFlareSolverr,
      flareEndpoints: clearanceManager.endpoints?.length || 0
    }),
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
