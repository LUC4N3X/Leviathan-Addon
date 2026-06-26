'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getSharedHttpAgents } = require('./provider_http_agents');
const {
  getImpitBrowserForFingerprint,
  hasCfResponseHeaders,
  isCanceledError: defaultIsCanceledError,
  isCloudflareChallenge,
  requestWithImpit,
  requestWithImpitRotating
} = require('./bypass');
const { createCfClearanceManager, normalizeBaseUrl, mergeCookieHeaders, buildCookieHeaderFromSession, mergeSessionCookies } = require('./cf_clearance_manager');
const { createRustShieldClient } = require('./rust_shield_client');
const { cfRedisStore } = require('./cf_redis_store');
const { envNumber, runWithBypassTrafficGuard } = require('./bypass_traffic_guard');

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

const CF_SHARED_CLEARANCE_AUTHORITY = true;
const CF_SHARED_CLEARANCE_FORCE_ORIGIN = true;
const CURL_CFFI_GUARD_DEFAULTS = Object.freeze({ beforeFlare: true, beforeFlareTimeoutMs: 6500 });

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
  const rustShield = createRustShieldClient({
    providerName,
    endpoint: options.rustShieldUrl || process.env.RUST_SHIELD_URL,
    logger
  });

  const useRustShieldDefault = options.useRustShield !== false;
  const useRustShieldForSession = useRustShieldDefault && options.useRustShieldForSession !== false;

  const agentOptions = {
    keepAlive: true,
    maxSockets: Number(options.maxSockets || 250),
    maxFreeSockets: Number(options.maxFreeSockets || 100),
    timeout: Number(options.agentTimeoutMs || 30000),
    keepAliveMsecs: Number(options.keepAliveMsecs || 30000)
  };
  const sharedAgents = getSharedHttpAgents(agentOptions);
  const httpAgent = options.httpAgent || sharedAgents.httpAgent;
  const httpsAgent = options.httpsAgent || sharedAgents.httpsAgent;

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
  const sharedClearanceAuthority = CF_SHARED_CLEARANCE_AUTHORITY;
  const sharedClearanceForceOrigin = CF_SHARED_CLEARANCE_FORCE_ORIGIN;
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
  const impitPreClearanceTimeoutMs = Math.max(1200, Math.min(4500, Number(options.impitPreClearanceTimeoutMs || 2600) || 2600));
  const sessionTimeoutFloorMs = Math.max(1200, Math.min(4500, Number(options.sessionTimeoutFloorMs || 4500) || 4500));
  const postClearanceReplayTimeoutMs = Math.max(
    sessionTimeoutFloorMs,
    Math.min(12000, Number(options.postClearanceReplayTimeoutMs || Math.max(sessionTimeoutFloorMs, directFetchTimeoutMs + 2500)) || Math.max(sessionTimeoutFloorMs, directFetchTimeoutMs + 2500))
  );
  const clearSessionOnTransportFailure = Boolean(options.clearSessionOnTransportFailure);
  const emergencyClearanceAfterSessionFailure = Boolean(options.emergencyClearanceAfterSessionFailure);
  const emergencyClearanceMinIntervalMs = Math.max(0, Math.min(30000, Number(options.emergencyClearanceMinIntervalMs ?? 6000) || 0));
  const clearanceBridgeMode = Boolean(options.clearanceBridgeMode);
  const clearanceEgressKey = String(
    options.clearanceEgressKey ||
    process.env.CF_CLEARANCE_EGRESS_KEY ||
    process.env.PROVIDER_EGRESS_KEY ||
    process.env.OUTBOUND_PROXY_ID ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    'direct'
  ).trim() || 'direct';
  const siteTrafficGuardOptions = {
    kind: 'site',
    providerName,
    egressKey: clearanceEgressKey,
    minIntervalMs: Number.isFinite(Number(options.siteRateLimitMinIntervalMs)) ? Number(options.siteRateLimitMinIntervalMs) : envNumber('BYPASS_SITE_MIN_INTERVAL_MS', 250, 0, 120000),
    maxConcurrency: Number.isFinite(Number(options.siteRateLimitMaxConcurrency)) ? Number(options.siteRateLimitMaxConcurrency) : envNumber('BYPASS_SITE_MAX_CONCURRENCY', 2, 1, 16),
    maxQueue: Number.isFinite(Number(options.siteRateLimitMaxQueue)) ? Number(options.siteRateLimitMaxQueue) : envNumber('BYPASS_SITE_MAX_QUEUE', 300, 0, 5000)
  };
  const providerEnvPrefix = String(providerName || 'provider').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'PROVIDER';
  const curlCffiPreClearance = typeof options.curlCffiPreClearance === 'function' ? options.curlCffiPreClearance : null;
  const curlCffiBeforeFlare = Boolean(curlCffiPreClearance)
    && options.curlCffiBeforeFlare !== false
    && envFlagNotFalse(`${providerEnvPrefix}_CURL_CFFI_BEFORE_FLARE`, envFlagNotFalse('CURL_CFFI_BEFORE_FLARE', CURL_CFFI_GUARD_DEFAULTS.beforeFlare));
  const curlCffiBeforeFlareTimeoutMs = Math.max(1000, Math.min(15000, Number(
    options.curlCffiBeforeFlareTimeoutMs
    || process.env[`${providerEnvPrefix}_CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS`]
    || process.env.CURL_CFFI_BEFORE_FLARE_TIMEOUT_MS
    || CURL_CFFI_GUARD_DEFAULTS.beforeFlareTimeoutMs
  ) || CURL_CFFI_GUARD_DEFAULTS.beforeFlareTimeoutMs));

  const redisSessionSharing = options.redisSessionSharing !== false && cfRedisStore.isEnabled();
  const redisLockSharing = options.redisLockSharing !== false && cfRedisStore.isLockEnabled();
  const redisLockTtlMs = Math.max(
    5000,
    Math.min(5 * 60 * 1000, Number(options.redisLockTtlMs || process.env.CF_REDIS_LOCK_TTL_MS || Math.max(clearanceTimeoutMs + 15_000, 45_000)) || Math.max(clearanceTimeoutMs + 15_000, 45_000))
  );
  const redisLockWaitMs = Math.max(
    1000,
    Math.min(5 * 60 * 1000, Number(options.redisLockWaitMs || process.env.CF_REDIS_LOCK_WAIT_MS || Math.max(clearanceTimeoutMs + 8000, redisLockTtlMs)) || Math.max(clearanceTimeoutMs + 8000, redisLockTtlMs))
  );

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
  let sharedClearancePromise = null;
  let sharedClearancePromiseStartedAt = 0;
  let lastEmergencyClearanceAt = 0;

  function getProfileUserAgent(profile = null) {
    const fallback = options.fallbackUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
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
    endpoint: options.cloudflareBypassEndpoint || options.bypassEndpoint || options.flareEndpoint || process.env.CF_BYPASS_URL || process.env.CLOUDFLARE_BYPASS_URL,
    sessionTtlMs,
    cooldownMs: options.clearanceCooldownMs || 8000,
    cooldownMaxEntries: options.clearanceCooldownMaxEntries,
    solveMaxQueue: options.clearanceSolveMaxQueue,
    solveConcurrency: options.clearanceSolveConcurrency,
    solveTimeoutMs: clearanceTimeoutMs,
    endpointFailureCooldownMs: options.endpointFailureCooldownMs,
    providerFailureCooldownMs: options.providerFailureCooldownMs,
    providerFailureCooldownMaxMs: options.providerFailureCooldownMaxMs,
    healthCacheMs: options.flareHealthCacheMs,
    healthTimeoutMs: options.flareHealthTimeoutMs,
    flareRetryCount: options.flareRetryCount,
    flareRetryBackoffMs: options.flareRetryBackoffMs,
    waitInSeconds: options.flareWaitInSeconds,
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
        timestamp: Date.now(),
        egressKey: session.egressKey || clearanceEgressKey,
        impitBrowser: session.impitBrowser || getImpitBrowserForFingerprint(session)
      };
      const persistedSession = { ...activeSession };
      delete persistedSession.solutionResponse;
      delete persistedSession.solutionResponseUrl;
      delete persistedSession.solutionResponseStatus;
      saveSession(persistedSession);
      persistRedisSession(persistedSession, activeSession.solvedUrl || activeSession.url || currentBaseUrl, 'cloudflare-bypass');
      if (activeSession.url) updateCurrentDomainFromUrl(activeSession.url);
    }
  });

  function isSessionFresh(session = activeSession) {
    if (!clearanceManager.isFresh(session)) return false;
    if (session?.egressKey && session.egressKey !== clearanceEgressKey) return false;
    return true;
  }

  function isSessionFreshForUrl(session = activeSession, url = currentBaseUrl) {
    if (!isSessionFresh(session)) return false;
    return Boolean(buildCookieHeaderFromSession(session, url || session.solvedUrl || session.url || currentBaseUrl));
  }

  function persistRedisSession(session, url = null, reason = 'store') {
    if (!redisSessionSharing || !session?.userAgent) return false;
    const storageUrl = normalizeBaseUrl(url || session.url || session.solvedUrl || currentBaseUrl) || url || session.url || session.solvedUrl || currentBaseUrl;
    cfRedisStore.saveProviderSession({
      providerName,
      url: storageUrl,
      egressKey: session.egressKey || clearanceEgressKey,
      session,
      sessionTtlMs
    }).then((ok) => {
      if (ok) logger.debug('redis session stored', { provider: providerName, reason, url: storageUrl, egressKey: session.egressKey || clearanceEgressKey });
    }).catch((error) => {
      logger.debug('redis session store skipped', { provider: providerName, reason, error: error?.message || String(error) });
    });
    return true;
  }

  function activateRedisSession(session, targetUrl = currentBaseUrl, reason = 'hydrate') {
    if (!session || !isSessionFreshForUrl(session, targetUrl || session.solvedUrl || session.url || currentBaseUrl)) return false;
    const next = { ...session };
    delete next.redisKey;
    delete next.redisHydratedAt;
    activeSession = next;
    const persistedSession = { ...activeSession };
    delete persistedSession.solutionResponse;
    delete persistedSession.solutionResponseUrl;
    delete persistedSession.solutionResponseStatus;
    saveSession(persistedSession);
    if (activeSession.url) updateCurrentDomainFromUrl(activeSession.url);
    logger.debug('redis session hydrated', { provider: providerName, reason, url: targetUrl, solvedBase: activeSession.url, egressKey: activeSession.egressKey || clearanceEgressKey });
    return true;
  }

  async function hydrateRedisSessionForUrl(url = currentBaseUrl, reason = 'hydrate') {
    if (!redisSessionSharing) return false;
    const targetUrl = url || currentBaseUrl;
    if (isSessionFreshForUrl(activeSession, targetUrl)) return false;
    try {
      const session = await cfRedisStore.getProviderSession({
        providerName,
        url: normalizeBaseUrl(targetUrl) || normalizeBaseUrl(currentBaseUrl) || targetUrl,
        egressKey: clearanceEgressKey,
        sessionTtlMs
      });
      return activateRedisSession(session, targetUrl, reason);
    } catch (error) {
      logger.debug('redis session hydrate skipped', { provider: providerName, reason, url: targetUrl, error: error?.message || String(error) });
      return false;
    }
  }

  function deleteRedisSession(url = currentBaseUrl, reason = 'clear') {
    if (!redisSessionSharing) return false;
    const storageUrl = normalizeBaseUrl(url || currentBaseUrl) || url || currentBaseUrl;
    cfRedisStore.deleteProviderSession({ providerName, url: storageUrl, egressKey: clearanceEgressKey })
      .then((deleted) => {
        if (deleted) logger.debug('redis session deleted', { provider: providerName, reason, url: storageUrl });
      })
      .catch((error) => logger.debug('redis session delete skipped', { provider: providerName, reason, error: error?.message || String(error) }));
    return true;
  }

  function clearSession() {
    const previousUrl = activeSession?.url || currentBaseUrl;
    activeSession = {};
    try { fs.unlinkSync(sessionFile); } catch (_) {}
    deleteRedisSession(previousUrl, 'local-clear');
  }

  function isTimeoutLikeError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || error || '');
    return /(?:ETIMEDOUT|ECONNABORTED|timeout|timed out|socket hang up)/i.test(`${code} ${message}`);
  }

  function clearSessionAfterTransportFailure(error, url, startedAt, stage = 'session') {
    if (!isTimeoutLikeError(error) || !isSessionFreshForUrl(activeSession, url)) return false;

    const meta = {
      stage,
      url,
      error: error?.message || String(error),
      code: error?.code,
      ms: Date.now() - startedAt
    };

    // A timeout/502/socket reset after a valid cf_clearance is usually a transport hiccup
    // or an overloaded Rust/Axios bridge, not proof that the CF cookie is invalid.
    // Clearing here causes the next candidate URL to start with hasSession:false and may
    // waste the remaining provider budget solving CloudflareBypass again. Challenge HTML is
    // still handled inside fetchWithSession(), where the session is invalidated correctly.
    if (!clearSessionOnTransportFailure) {
      logger.debug('session kept after transport failure', meta);
      return false;
    }

    clearSession();
    logger.debug('session cleared after transport failure', meta);
    return true;
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

  function buildSharedClearanceKey(triggerUrl) {
    const base = normalizeBaseUrl(triggerUrl) || normalizeBaseUrl(currentBaseUrl) || normalizeBaseUrl(initialBaseUrl) || initialBaseUrl;
    return `${providerName}:${base}:egress:${clearanceEgressKey}`;
  }

  function normalizeComparableUrl(value, base = currentBaseUrl) {
    try {
      const parsed = new URL(String(value || ''), base || initialBaseUrl);
      parsed.hash = '';
      return parsed.toString();
    } catch (_) {
      return null;
    }
  }

  function sameDocumentUrl(a, b) {
    const left = normalizeComparableUrl(a);
    const right = normalizeComparableUrl(b);
    return Boolean(left && right && left === right);
  }

  function getSolutionHtmlForUrl(session, targetUrl) {
    if (!session?.solutionResponse || !session.solutionResponseUrl) return null;
    if (!sameDocumentUrl(session.solutionResponseUrl, targetUrl)) return null;
    const html = typeof session.solutionResponse === 'string' ? session.solutionResponse : String(session.solutionResponse || '');
    return html && !isChallengePage(html, session.solutionResponseStatus || 200) ? html : null;
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

  function isChallengePage(html, status = 200, responseHeaders = null) {
    const raw = typeof html === 'string' ? html : String(html || '');
    if (!raw) return true;
    const lower = raw.slice(0, 250000).toLowerCase();
    const code = Number(status);

    if ([403, 429, 503].includes(code)) {
      if (responseHeaders == null) return true;
      if (hasCfResponseHeaders(responseHeaders)) return true;
      // Non-CF server: fall through to body-based scoring below.
    }

    if (isCloudflareChallenge(raw, 0, responseHeaders)) return true;
    if (typeof options.challengeDetector === 'function' && options.challengeDetector(raw, status)) return true;
    if (options.strictChallengeOnly === true) return false;

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

  function buildHeaders({ session = null, method = 'GET', body = null, directProfile = null, url = null } = {}) {
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

    if (session) {
      const cookieHeader = buildCookieHeaderFromSession(session, url || currentBaseUrl);
      if (cookieHeader) headers.Cookie = cookieHeader;
    }

    const secChUaSource = profile.sec_ch_ua
      ? profile.sec_ch_ua
      : (() => {
          const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
          if (!chromeMatch || userAgent.includes('Firefox')) return null;
          const major = chromeMatch[1];
          const majorInt = Number.parseInt(major, 10);
          return majorInt >= 131
            ? `"Google Chrome";v="${major}", "Not A(Brand";v="8", "Chromium";v="${major}"`
            : `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not.A/Brand";v="99"`;
        })();
    const secChUaPlatformSource = profile.sec_ch_ua_platform
      || profile.secChUaPlatform
      || (() => {
          if (/Macintosh|Mac OS X/i.test(userAgent)) return '"macOS"';
          if (/Linux/i.test(userAgent) && !/Android/i.test(userAgent)) return '"Linux"';
          if (/Android/i.test(userAgent)) return '"Android"';
          if (/CrOS/i.test(userAgent)) return '"Chrome OS"';
          return '"Windows"';
        })();
    if (secChUaSource) {
      headers['sec-ch-ua'] = secChUaSource;
      headers['sec-ch-ua-mobile'] = /Android|Mobile/i.test(userAgent) ? '?1' : '?0';
      headers['sec-ch-ua-platform'] = secChUaPlatformSource;
    }

    if (method === 'POST' && body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Site'] = 'same-origin';
    } else {
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = 'none';
      headers['Sec-Fetch-User'] = '?1';
      headers['Upgrade-Insecure-Requests'] = '1';
      if (secChUaSource) headers['Priority'] = 'u=0, i';
    }

    return headers;
  }

  async function axiosSiteRequest(url, { method = 'GET', body = null, headers = {}, timeout = directFetchTimeoutMs, signal = null, maxRedirects = 6, browserProfile = null, useImpit = preferImpit, useRustShield = useRustShieldDefault, impitAttempts = null, impitTotalExtra = null } = {}) {
    const startedAt = Date.now();

    if (useRustShield && rustShield.enabled && rustShield.first) {
      try {
        const rustResponse = await rustShield.fetch(url, {
          method,
          body: method === 'POST' ? body : null,
          headers,
          timeout: Math.min(timeout, rustShield.timeoutMs || timeout),
          signal,
          maxRedirects,
          providerName
        });
        if (rustResponse && !rustResponse.rustBlocked) {
          logger.debug('rust shield fetch ok', {
            method,
            url,
            status: rustResponse.status,
            cache: rustResponse.rustCache,
            bytes: String(rustResponse.data || '').length,
            ms: Date.now() - startedAt
          });
          return rustResponse;
        }
        if (rustResponse?.rustBlocked) {
          logger.debug('rust shield blocked; falling through', {
            method,
            url,
            status: rustResponse.status,
            reason: rustResponse.rustBlockedReason,
            ms: Date.now() - startedAt
          });
        }
      } catch (error) {
        if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
        logger.debug('rust shield error; falling through', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      }
    }

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
          browser: (browserProfile && browserProfile.impitBrowser) || activeSession?.impitBrowser || getImpitBrowserForFingerprint(browserProfile || activeSession),
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
            via: response.impitAttempts > 1 ? `impit:${response.impitBrowser}:${response.impitAttempts}` : 'impit',
            impitBrowser: response.impitBrowser || null
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

  async function fetchImpitRescue(url, { method = 'GET', body = null, signal = null, timeout = impitPreClearanceTimeoutMs, startedAt = Date.now(), headers = null, browserProfile = null, reason = 'pre-clearance' } = {}) {
    if (!preferImpit || !impitPreClearanceRescue || signal?.aborted) return null;

    try {
      const response = await axiosSiteRequest(url, {
        method,
        body: method === 'POST' ? body : null,
        headers: headers || buildHeaders({ method, body, directProfile: browserProfile, url }),
        timeout: Math.max(1200, Math.min(timeout, impitPreClearanceTimeoutMs)),
        signal,
        browserProfile: browserProfile || activeSession,
        useImpit: true,
        impitAttempts: Math.min(2, impitMaxAttempts),
        impitTotalExtra: 300
      });

      updateCurrentDomainFromUrl(response.url);
      const html = typeof response.data === 'string' ? response.data : String(response.data || '');
      if (!isChallengePage(html, response.status, response.headers || null)) {
        const setCookie = response.headers?.['set-cookie'];
        if (activeSession?.cookies || setCookie) {
          persistSession({
            userAgent: (browserProfile && (browserProfile.userAgent || browserProfile.ua)) || activeSession?.userAgent || getProfileUserAgent(browserProfile),
            cookies: buildCookieHeaderFromSession(activeSession, response.url || url) || activeSession?.cookies || '',
            url: response.url,
            timestamp: Date.now(),
            egressKey: clearanceEgressKey,
            impitBrowser: response.impitBrowser || browserProfile?.impitBrowser || activeSession?.impitBrowser || getImpitBrowserForFingerprint(browserProfile || activeSession)
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
    const cookieUrl = resolvedUrl || session.solvedUrl || session.url || currentBaseUrl;
    const merged = mergeSessionCookies(session, cookieUrl, setCookie);
    const next = {
      ...merged,
      url: normalizeBaseUrl(cookieUrl) || normalizeBaseUrl(merged.url) || currentBaseUrl,
      timestamp: Date.now(),
      egressKey: merged.egressKey || clearanceEgressKey,
      impitBrowser: merged.impitBrowser || session.impitBrowser || getImpitBrowserForFingerprint(merged)
    };
    if (!next.cookies && setCookie) next.cookies = mergeCookieHeaders(session.cookies || '', setCookie);
    activeSession = next;
    const persistedSession = { ...activeSession };
    delete persistedSession.solutionResponse;
    delete persistedSession.solutionResponseUrl;
    delete persistedSession.solutionResponseStatus;
    saveSession(persistedSession);
    persistRedisSession(persistedSession, cookieUrl, 'persist-session');
    if (next.url) updateCurrentDomainFromUrl(next.url);
  }

  async function tryCurlCffiBeforeFlare(clearanceUrl, triggerUrl, { signal = null, startedAt = Date.now(), reason = 'pre-flare', sharedKey = null } = {}) {
    if (!curlCffiBeforeFlare || signal?.aborted || !clearanceUrl) return null;

    const profile = activeSession?.userAgent ? activeSession : pickProfile(profiles);
    const headers = buildHeaders({
      session: isSessionFreshForUrl(activeSession, clearanceUrl) ? activeSession : null,
      directProfile: profile,
      method: 'GET',
      url: clearanceUrl
    });

    try {
      const session = await curlCffiPreClearance(clearanceUrl, {
        method: 'GET',
        isPost: false,
        body: null,
        timeoutMs: Math.min(curlCffiBeforeFlareTimeoutMs, clearanceTimeoutMs),
        headers,
        allowCurlCffi: true,
        allowScrapling: false,
        allowCloudflareBypass: false,
        triggerUrl,
        reason,
        sharedKey,
        curlCffiCoalesceKey: sharedKey ? `${sharedKey}:curl_cffi` : `${providerName}:${normalizeBaseUrl(clearanceUrl) || clearanceUrl}:curl_cffi`
      });

      if (!session) return null;
      const cookieHeader = buildCookieHeaderFromSession(session, session.solvedUrl || clearanceUrl) || session.cookies || '';
      const html = typeof session.response === 'string' ? session.response : String(session.response || session.solutionResponse || '');
      const status = Number(session.solutionResponseStatus || session.status || 200) || 200;
      const usefulHtml = html.length >= 32 && !isChallengePage(html, status);
      const hasCfClearance = Boolean(session.cf_clearance) || /(?:^|;\s*)cf_clearance=/i.test(cookieHeader);

      if (session.userAgent && cookieHeader) {
        persistSession({
          ...session,
          cookies: cookieHeader,
          url: session.url || normalizeBaseUrl(session.solvedUrl || clearanceUrl) || currentBaseUrl,
          solvedUrl: session.solvedUrl || clearanceUrl,
          timestamp: Date.now(),
          egressKey: session.egressKey || clearanceEgressKey,
          impitBrowser: session.impitBrowser || getImpitBrowserForFingerprint(session)
        }, session.solvedUrl || clearanceUrl);
      }

      logger.debug('curl_cffi pre-flare result', {
        clearanceUrl,
        triggerUrl,
        status,
        bytes: html.length,
        usefulHtml,
        hasCookie: Boolean(cookieHeader),
        hasCfClearance,
        seededSession: Boolean(session.userAgent && cookieHeader),
        freshForTrigger: isSessionFreshForUrl(activeSession, triggerUrl),
        ms: Date.now() - startedAt
      });

      return hasCfClearance && isSessionFreshForUrl(activeSession, triggerUrl) ? activeSession : null;
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('curl_cffi pre-flare skipped', {
        clearanceUrl,
        triggerUrl,
        reason,
        error: error?.message || String(error),
        code: error?.code,
        ms: Date.now() - startedAt
      });
      return null;
    }
  }

  async function tryRedirectedSessionReplay(originalUrl, redirectedUrl, { method = 'GET', body = null, signal = null, timeout = directFetchTimeoutMs, startedAt = Date.now(), reason = 'redirect' } = {}) {
    const originalBase = normalizeBaseUrl(originalUrl);
    const redirectedBase = normalizeBaseUrl(redirectedUrl);
    if (!redirectedUrl || !originalBase || !redirectedBase || originalBase === redirectedBase) return null;
    if (!isSessionFreshForUrl(activeSession, redirectedUrl)) return null;

    try {
      logger.debug('redirect session replay start', { method, originalUrl, redirectedUrl, reason });
      const response = await axiosSiteRequest(redirectedUrl, {
        method,
        body: method === 'POST' ? body : null,
        headers: buildHeaders({ session: activeSession, method, body, url: redirectedUrl }),
        timeout: Math.max(2200, Math.min(timeout, 4500)),
        signal,
        browserProfile: activeSession,
        useImpit: false,
        useRustShield: useRustShieldForSession,
        maxRedirects: 3
      });

      updateCurrentDomainFromUrl(response.url);
      const html = typeof response.data === 'string' ? response.data : String(response.data || '');
      if (isChallengePage(html, response.status, response.headers || null)) {
        logger.debug('redirect session replay rejected', { method, originalUrl, redirectedUrl, status: response.status, bytes: html.length, via: response.via, ms: Date.now() - startedAt });
        return null;
      }

      persistSession(activeSession, response.url, response.headers?.['set-cookie']);
      logger.debug('redirect session replay ok', { method, originalUrl, redirectedUrl, status: response.status, bytes: html.length, via: response.via, ms: Date.now() - startedAt });
      return html;
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('redirect session replay error', { method, originalUrl, redirectedUrl, reason, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      return null;
    }
  }

  async function fetchWithSession(url, { method = 'GET', body = null, signal = null, timeout = directFetchTimeoutMs, startedAt = Date.now() } = {}) {
    if (!isSessionFreshForUrl(activeSession, url)) return null;
    const response = await axiosSiteRequest(url, {
      method,
      body: method === 'POST' ? body : null,
      headers: buildHeaders({ session: activeSession, method, body, url }),
      timeout: Math.max(timeout, sessionTimeoutFloorMs),
      signal,
      browserProfile: activeSession,
      useRustShield: useRustShieldForSession,
      useImpit: !impitSessionFastPath,
      impitAttempts: 1,
      impitTotalExtra: 350
    });

    updateCurrentDomainFromUrl(response.url);
    const html = typeof response.data === 'string' ? response.data : String(response.data || '');
    if (isChallengePage(html, response.status, response.headers || null)) {
      logger.debug('session fetch rejected', { method, url, status: response.status, bytes: html.length, challenge: true, via: response.via, ms: Date.now() - startedAt });

      const replayed = await tryRedirectedSessionReplay(url, response.url, { method, body, signal, timeout, startedAt, reason: 'session-challenge' });
      if (replayed) return replayed;

      if (impitSessionFastPath && impitAfterSessionChallenge) {
        try {
          const impitResponse = await axiosSiteRequest(url, {
            method,
            body: method === 'POST' ? body : null,
            headers: buildHeaders({ session: activeSession, method, body, url }),
            timeout: Math.max(1800, Math.min(timeout, 2600)),
            signal,
            browserProfile: activeSession,
            useImpit: true,
            impitAttempts: 1,
            impitTotalExtra: 250
          });
          updateCurrentDomainFromUrl(impitResponse.url);
          const impitHtml = typeof impitResponse.data === 'string' ? impitResponse.data : String(impitResponse.data || '');
          if (!isChallengePage(impitHtml, impitResponse.status, impitResponse.headers || null)) {
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

  async function fetchDirectFast(url, { method = 'GET', body = null, signal = null, timeout = directFetchTimeoutMs, startedAt = Date.now() } = {}) {
    const profile = pickProfile(profiles) || {};
    const userAgent = getProfileUserAgent(profile);
    const headers = buildHeaders({ method, body, directProfile: profile, url });
    let response = null;

    try {
      response = await axiosSiteRequest(url, {
        method,
        body: method === 'POST' ? body : null,
        headers,
        timeout,
        signal,
        browserProfile: profile,
        useImpit: !clearanceManager.endpoint
      });
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('direct fetch transport error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      if (clearanceManager.endpoint) {
        logger.debug('impit rescue skipped', { method, url, reason: 'direct-error-clearance-endpoint', ms: Date.now() - startedAt });
        return null;
      }
      return fetchImpitRescue(url, { method, body, signal, timeout: Math.min(timeout, impitPreClearanceTimeoutMs), startedAt, headers, browserProfile: profile, reason: 'direct-error' });
    }

    updateCurrentDomainFromUrl(response.url);
    const html = typeof response.data === 'string' ? response.data : String(response.data || '');
    if (isChallengePage(html, response.status, response.headers || null)) {
      logger.debug('direct fetch rejected', { method, url, status: response.status, bytes: html.length, challenge: true, ms: Date.now() - startedAt });
      const replayed = await tryRedirectedSessionReplay(url, response.url, { method, body, signal, timeout, startedAt, reason: 'direct-challenge' });
      if (replayed) return replayed;
      if (clearanceManager.endpoint) {
        logger.debug('impit rescue skipped', { method, url, reason: 'direct-challenge-clearance-endpoint', clearance: true, ms: Date.now() - startedAt });
        return null;
      }
      const rescued = await fetchImpitRescue(url, { method, body, signal, timeout: Math.min(timeout, impitPreClearanceTimeoutMs), startedAt, headers, browserProfile: profile, reason: 'direct-challenge' });
      if (rescued) return rescued;
      return null;
    }

    const setCookie = response.headers?.['set-cookie'];
    if (setCookie) {
      const cookies = mergeCookieHeaders('', setCookie);
      if (cookies) persistSession({
        userAgent,
        cookies,
        url: response.url,
        timestamp: Date.now(),
        egressKey: clearanceEgressKey,
        impitBrowser: getImpitBrowserForFingerprint(profile)
      }, response.url, setCookie);
    }

    logger.debug('direct fetch ok', { method, url, status: response.status, bytes: html.length, hasCookie: Boolean(setCookie), ms: Date.now() - startedAt });
    return html;
  }

  async function solveClearance(triggerUrl, { isPost = false, body = null, signal = null, force = true, ignoreProviderCooldown = false } = {}) {
    if (!force && isSessionFreshForUrl(activeSession, triggerUrl)) return activeSession;
    await hydrateRedisSessionForUrl(triggerUrl, 'pre-solve');
    if (!force && isSessionFreshForUrl(activeSession, triggerUrl)) return activeSession;

    const targetClearanceUrl = buildClearanceUrl(triggerUrl, { isPost, body });
    const homepageClearanceUrl = buildHomepageClearanceUrl(triggerUrl);
    const primaryClearanceUrl = sharedClearanceAuthority && sharedClearanceForceOrigin
      ? homepageClearanceUrl
      : (originClearance ? homepageClearanceUrl : targetClearanceUrl);
    const sharedKey = sharedClearanceAuthority ? buildSharedClearanceKey(primaryClearanceUrl) : null;

    const runActualSolve = async () => {
      if (!force && isSessionFreshForUrl(activeSession, triggerUrl)) return activeSession;

      const solverSignal = sharedClearanceAuthority ? null : signal;
      const curlSession = await tryCurlCffiBeforeFlare(primaryClearanceUrl, triggerUrl, {
        signal: solverSignal,
        reason: 'primary-pre-flare',
        sharedKey
      });
      if (isSessionFreshForUrl(curlSession || activeSession, triggerUrl)) {
        logger.debug('clearance satisfied by curl_cffi pre-flare', {
          triggerUrl,
          clearanceUrl: primaryClearanceUrl,
          sharedKey
        });
        return curlSession || activeSession;
      }

      let session = await clearanceManager.solve(primaryClearanceUrl, solverSignal, {
        triggerUrl,
        method: isPost ? 'POST' : 'GET',
        force,
        maxTimeout: clearanceTimeoutMs,
        sharedKey,
        wantResponse: !clearanceBridgeMode && sameDocumentUrl(primaryClearanceUrl, triggerUrl),
        cookies: buildCookieHeaderFromSession(activeSession, targetClearanceUrl) || activeSession?.cookies || '',
        userAgent: activeSession?.userAgent || getFallbackUserAgent(),
        egressKey: clearanceEgressKey,
        ignoreProviderCooldown
      });

      if (isSessionFreshForUrl(session, triggerUrl)) return session;

      const fallbacks = [];
      if (!sharedClearanceAuthority && originClearance && targetFallbackAfterOrigin && targetClearanceUrl !== primaryClearanceUrl) fallbacks.push(targetClearanceUrl);
      if (!sharedClearanceAuthority && homepageFallback && homepageClearanceUrl !== primaryClearanceUrl && homepageClearanceUrl !== targetClearanceUrl) fallbacks.push(homepageClearanceUrl);

      for (const fallbackUrl of fallbacks) {
        if (signal?.aborted) return null;
        const curlFallbackSession = await tryCurlCffiBeforeFlare(fallbackUrl, triggerUrl, {
          signal,
          reason: 'fallback-pre-flare',
          sharedKey: sharedKey ? `${sharedKey}:fallback` : null
        });
        if (isSessionFreshForUrl(curlFallbackSession || activeSession, triggerUrl)) {
          logger.debug('fallback clearance satisfied by curl_cffi pre-flare', { triggerUrl, clearanceUrl: fallbackUrl });
          return curlFallbackSession || activeSession;
        }

        session = await clearanceManager.solve(fallbackUrl, signal, {
          triggerUrl,
          method: isPost ? 'POST' : 'GET',
          force,
          fallback: true,
          maxTimeout: clearanceTimeoutMs,
          wantResponse: !clearanceBridgeMode && sameDocumentUrl(fallbackUrl, triggerUrl),
          cookies: buildCookieHeaderFromSession(activeSession, fallbackUrl) || activeSession?.cookies || '',
          userAgent: activeSession?.userAgent || getFallbackUserAgent(),
          egressKey: clearanceEgressKey,
          ignoreProviderCooldown
        });
        if (isSessionFreshForUrl(session, triggerUrl)) return session;
      }
      return null;
    };

    const runSolve = async () => {
      if (!force && isSessionFreshForUrl(activeSession, triggerUrl)) return activeSession;
      await hydrateRedisSessionForUrl(primaryClearanceUrl, 'solve-before-lock');
      if (isSessionFreshForUrl(activeSession, triggerUrl)) return activeSession;

      if (!sharedClearanceAuthority || !redisLockSharing) return runActualSolve();

      const lockKey = cfRedisStore.lockKeyForProviderSession({
        providerName,
        url: primaryClearanceUrl,
        egressKey: clearanceEgressKey
      });
      const token = await cfRedisStore.acquireLock(lockKey, { ttlMs: redisLockTtlMs });

      if (!token) {
        logger.debug('redis clearance lock wait', {
          method: isPost ? 'POST' : 'GET',
          triggerUrl,
          clearanceUrl: primaryClearanceUrl,
          sharedKey,
          waitMs: redisLockWaitMs
        });
        const waited = await cfRedisStore.waitForProviderSession({
          providerName,
          url: primaryClearanceUrl,
          egressKey: clearanceEgressKey,
          sessionTtlMs,
          timeoutMs: redisLockWaitMs
        });
        if (activateRedisSession(waited, triggerUrl, 'redis-lock-wait')) return activeSession;
        logger.debug('redis clearance lock wait missed; falling back to local solve', {
          triggerUrl,
          clearanceUrl: primaryClearanceUrl,
          sharedKey
        });
        return runActualSolve();
      }

      try {
        logger.debug('redis clearance lock acquired', { triggerUrl, clearanceUrl: primaryClearanceUrl, sharedKey, ttlMs: redisLockTtlMs });
        return await runActualSolve();
      } finally {
        cfRedisStore.releaseLock(lockKey, token)
          .catch((error) => logger.debug('redis clearance lock release skipped', { sharedKey, error: error?.message || String(error) }));
      }
    };

    if (!sharedClearanceAuthority) return runSolve();

    if (sharedClearancePromise) {
      logger.debug('clearance shared wait', {
        method: isPost ? 'POST' : 'GET',
        triggerUrl,
        clearanceUrl: primaryClearanceUrl,
        sharedKey,
        waitMs: Date.now() - sharedClearancePromiseStartedAt
      });
      const waited = await sharedClearancePromise;
      return isSessionFreshForUrl(waited, triggerUrl) ? waited : (isSessionFreshForUrl(activeSession, triggerUrl) ? activeSession : null);
    }

    sharedClearancePromiseStartedAt = Date.now();
    sharedClearancePromise = runSolve()
      .finally(() => {
        sharedClearancePromise = null;
        sharedClearancePromiseStartedAt = 0;
      });

    return sharedClearancePromise;
  }

  async function ensureClearance(triggerUrl = currentBaseUrl, { signal = null, force = false, isPost = false, body = null, ignoreProviderCooldown = false } = {}) {
    const targetUrl = triggerUrl || currentBaseUrl;
    await hydrateRedisSessionForUrl(targetUrl, 'ensure-clearance');
    if (!force && isSessionFreshForUrl(activeSession, targetUrl)) return activeSession;
    if (!clearanceManager.endpoint) return isSessionFreshForUrl(activeSession, targetUrl) ? activeSession : null;
    return solveClearance(targetUrl, { isPost, body, signal, force, ignoreProviderCooldown });
  }

  async function executeSmartFetch(url, isPost = false, body = null, signal = null, allowCloudflareBypass = true, timeoutMs = directFetchTimeoutMs, allowEmergencyClearance = true) {
    const startedAt = Date.now();
    const method = isPost ? 'POST' : 'GET';
    const hardFetchTimeout = Math.max(2500, Math.min(timeoutMs, directFetchTimeoutMs));
    await hydrateRedisSessionForUrl(url, 'fetch-start');
    const hadFreshSessionAtStart = isSessionFreshForUrl(activeSession, url);
    let sessionFailureDetected = false;
    logger.debug('fetch start', { method, url, hasSession: hadFreshSessionAtStart, allowClearance: allowCloudflareBypass, timeoutMs: hardFetchTimeout });

    if (hadFreshSessionAtStart) {
      try {
        const html = await runWithBypassTrafficGuard(url, () => fetchWithSession(url, { method, body, signal, timeout: hardFetchTimeout, startedAt }), {
          ...siteTrafficGuardOptions,
          signal
        });
        if (html) return html;
        sessionFailureDetected = true;
      } catch (error) {
        if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
        sessionFailureDetected = true;
        clearSessionAfterTransportFailure(error, url, startedAt, 'session');
        logger.debug('session fetch error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      }
    }

    try {
      const html = await runWithBypassTrafficGuard(url, () => fetchDirectFast(url, { method, body, signal, timeout: hardFetchTimeout, startedAt }), {
        ...siteTrafficGuardOptions,
        signal
      });
      if (html) return html;
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('direct fetch error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
    }

    const canEmergencyClearance = allowEmergencyClearance && emergencyClearanceAfterSessionFailure && clearanceManager.endpoint && hadFreshSessionAtStart && sessionFailureDetected;
    const emergencyCoolingDown = canEmergencyClearance && lastEmergencyClearanceAt && (Date.now() - lastEmergencyClearanceAt < emergencyClearanceMinIntervalMs);
    if (!allowCloudflareBypass && canEmergencyClearance && !emergencyCoolingDown && !signal?.aborted) {
      allowCloudflareBypass = true;
      lastEmergencyClearanceAt = Date.now();
      logger.info('emergency clearance enabled after stale session failure', {
        method,
        url,
        reason: 'session_failed_then_direct_blocked',
        ms: Date.now() - startedAt
      });
    } else if (!allowCloudflareBypass && canEmergencyClearance && emergencyCoolingDown) {
      logger.debug('emergency clearance skipped by cooldown', { method, url, cooldownMs: emergencyClearanceMinIntervalMs, ms: Date.now() - startedAt });
    }

    if (!allowCloudflareBypass || signal?.aborted) return null;

    const session = await solveClearance(url, { isPost, body, signal, force: clearanceForce });
    if (!isSessionFreshForUrl(session, url)) {
      logger.warn('clearance no fresh session', { method, url, ms: Date.now() - startedAt });
      return null;
    }

    const solutionHtml = clearanceBridgeMode ? null : getSolutionHtmlForUrl(session, url);
    if (solutionHtml) {
      logger.info('post-clearance solution html used', { method, url, bytes: solutionHtml.length, ms: Date.now() - startedAt });
      return solutionHtml;
    }

    if (clearanceBridgeMode) {
      logger.debug('post-clearance bridge replay start', { method, url, transport: 'axios', sessionFresh: isSessionFreshForUrl(activeSession, url), ms: Date.now() - startedAt });
    }

    try {
      const html = await runWithBypassTrafficGuard(url, () => fetchWithSession(url, {
        method,
        body,
        signal,
        timeout: Math.max(hardFetchTimeout, postClearanceReplayTimeoutMs),
        startedAt
      }), {
        ...siteTrafficGuardOptions,
        signal
      });
      if (html) {
        logger.info('post-clearance fetch ok', { method, url, transport: 'session-fastpath', sessionFresh: isSessionFreshForUrl(activeSession, url), ms: Date.now() - startedAt });
        return html;
      }
    } catch (error) {
      if (isAbortLikeError(error, isCanceledError) && signal?.aborted) throw error;
      logger.debug('post-clearance fetch error', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      clearSessionAfterTransportFailure(error, url, startedAt, 'post-clearance');
    }

    return null;
  }

  async function smartFetch(url, { isPost = false, body = null, ttl = 30 * 60 * 1000, signal = null, allowCloudflareBypass = true, timeoutMs = directFetchTimeoutMs, allowEmergencyClearance = true } = {}) {
    const cacheKey = `${isPost ? 'POST' : 'GET'}:${url}:${body || ''}`;
    const cached = requestCache.get(cacheKey);

    if (cached) {
      const now = Date.now();
      if (now < cached.expires) return cached.data;
      if (cached.stale && now < cached.stale && !pendingRequests.has(cacheKey)) {
        setImmediate(() => smartFetch(url, { isPost, body, ttl, signal, allowCloudflareBypass, timeoutMs }).catch(() => {}));
        return cached.data;
      }
      requestCache.delete(cacheKey);
    }

    if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);

    const fetchPromise = executeSmartFetch(url, isPost, body, signal, allowCloudflareBypass, timeoutMs, allowEmergencyClearance)
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


  function originKeyForWarmup(url) {
    try {
      const parsed = new URL(String(url || ''), currentBaseUrl || initialBaseUrl);
      return parsed.origin;
    } catch (_) {
      return 'invalid';
    }
  }

  function buildRustWarmupHeaders(url, requestHeaders = {}) {
    const baseHeaders = buildHeaders({
      session: isSessionFreshForUrl(activeSession, url) ? activeSession : null,
      method: 'GET',
      url
    });
    return {
      ...baseHeaders,
      ...(requestHeaders || {})
    };
  }

  async function warmupRustShield(urls, requestOptions = {}) {
    if (!rustShield.enabled) return null;
    const cleanUrls = Array.from(new Set((urls || []).filter(Boolean).map(String))).slice(0, Math.max(1, Number(requestOptions.max || 64) || 64));
    if (!cleanUrls.length) return null;

    const groups = new Map();
    for (const url of cleanUrls) {
      const origin = originKeyForWarmup(url);
      if (!groups.has(origin)) groups.set(origin, []);
      groups.get(origin).push(url);
    }

    const startedAt = Date.now();
    const aggregate = {
      ok: false,
      total: 0,
      warmed: 0,
      blocked: 0,
      ms: 0,
      results: [],
      groups: groups.size,
      sessionBridge: false
    };

    for (const [origin, groupUrls] of groups.entries()) {
      if (origin === 'invalid' || !groupUrls.length) continue;
      const firstUrl = groupUrls[0];
      const headers = buildRustWarmupHeaders(firstUrl, requestOptions.headers || {});
      const cookieHeader = headers.Cookie || headers.cookie || '';
      const userAgent = headers['User-Agent'] || headers['user-agent'] || '';
      const sessionFresh = isSessionFreshForUrl(activeSession, firstUrl);
      const startedGroup = Date.now();

      const result = await rustShield.warmup(groupUrls, {
        ...requestOptions,
        headers,
        providerName,
        staleTtlMs: requestOptions.staleTtlMs || requestOptions.cacheTtlMs || rustShield.staleTtlMs
      });

      aggregate.total += Number(result?.total || groupUrls.length || 0);
      aggregate.warmed += Number(result?.warmed || 0);
      aggregate.blocked += Number(result?.blocked || 0);
      if (Array.isArray(result?.results)) aggregate.results.push(...result.results);
      if (cookieHeader) aggregate.sessionBridge = true;

      logger.debug('rust warmup bridge group done', {
        origin,
        urls: groupUrls.length,
        warmed: Number(result?.warmed || 0),
        blocked: Number(result?.blocked || 0),
        sessionFresh,
        hasCookie: Boolean(cookieHeader),
        hasUserAgent: Boolean(userAgent),
        ms: Date.now() - startedGroup
      });
    }

    aggregate.ok = aggregate.warmed > 0 || aggregate.total === 0;
    aggregate.ms = Date.now() - startedAt;
    return aggregate;
  }

  return {
    lightClient,
    httpAgent,
    httpsAgent,
    smartFetch,
    ensureClearance,
    refreshTargetDomain,
    buildProviderUrl,
    getCurrentBaseUrl,
    updateCurrentDomainFromUrl,
    normalizeBaseUrl,
    clearSession,
    importSession: (session, resolvedUrl = null, setCookie = null) => {
      persistSession(session, resolvedUrl, setCookie);
      return activeSession;
    },
    getSession: () => activeSession,
    hydrateSessionForUrl: hydrateRedisSessionForUrl,
    isSessionFreshForUrl,
    warmupRustShield,
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
      cloudflareBypassEndpoints: clearanceManager.endpoints?.length || 0,
      flareEndpoints: clearanceManager.endpoints?.length || 0,
      cookieJarV2: true,
      curlCffiBeforeFlare,
      curlCffiBeforeFlareTimeoutMs,
      rustShield: rustShield.state?.() || { enabled: false },
      sharedClearanceAuthority,
      sharedClearanceForceOrigin,
      sharedClearancePending: Boolean(sharedClearancePromise),
      clearanceBridgeMode,
      clearanceEgressKey,
      emergencyClearanceAfterSessionFailure,
      sessionTimeoutFloorMs,
      providerFailureCooldownMs: options.providerFailureCooldownMs,
      providerFailureCooldownMaxMs: options.providerFailureCooldownMaxMs,
      postClearanceReplayTimeoutMs,
      clearSessionOnTransportFailure,
      useRustShieldDefault,
      useRustShieldForSession
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
