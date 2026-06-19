'use strict';

const axios = require('axios');
const {
  normalizeBypassEndpoint,
  normalizeBypassEndpoints,
  getConfiguredBypassEndpoints,
  createCloudflareBypassServiceClient
} = require('./cf_bypass_service_client');

let setCookieParser = null;
try {
  setCookieParser = require('set-cookie-parser');
} catch (_) {
}

let toughCookie = null;
try {
  toughCookie = require('tough-cookie');
} catch (_) {
}

const DEFAULT_CLOUDFLARE_BYPASS_URL = null;
const DEFAULT_ENDPOINT_FAILURE_COOLDOWN_MS = 45_000;

function normalizeBaseUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

function normalizeFlareEndpoint(value) {
  // Backward-compatible export name: now normalizes CloudflareBypassForScraping base URLs.
  return normalizeBypassEndpoint(value);
}

function normalizeFlareEndpoints(...values) {
  // Backward-compatible export name: now returns /cookies-/html-capable bypass service bases, not /v1 endpoints.
  return normalizeBypassEndpoints(...values);
}

function normalizeSetCookieHeaders(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map(item => (item && typeof item === 'object') ? cookieObjectToSetCookieString(item) : String(item || ''))
      .filter(Boolean);
  }
  if (value && typeof value.getSetCookie === 'function') {
    try { return value.getSetCookie().filter(Boolean).map(String); } catch (_) {}
  }
  if (value && typeof value.raw === 'function') {
    try {
      const raw = value.raw();
      const setCookie = raw?.['set-cookie'] || raw?.['Set-Cookie'];
      if (Array.isArray(setCookie)) return setCookie.filter(Boolean).map(String);
    } catch (_) {}
  }
  return [String(value)].filter(Boolean);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isFlareBrowserCrash(error) {
  const message = String(error?.message || error?.response?.data?.message || '').toLowerCase();
  const body = stringifyErrorPayload(error?.response?.data).toLowerCase();
  const haystack = `${message} ${body}`;
  return /tab crashed|target closed|session destroyed|browser has disconnected|chrome\s+crashed|context\s+disposed|protocol error/i.test(haystack);
}

function stringifyErrorPayload(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function isRetryableFlareError(error) {
  if (isFlareBrowserCrash(error)) return false;
  const status = Number(error?.response?.status || error?.status || 0);
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return (
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code) ||
    code === 'ERR_NETWORK' ||
    message.includes('timeout') ||
    [502, 503, 504, 522, 523, 524].includes(status)
  );
}

function isUsefulSolutionHtml(body, status = 200) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length < 200) return false;
  return !isLikelyChallengeHtml(text, status);
}

function safeCookieUrl(url, fallback = 'https://example.com/') {
  try {
    const parsed = new URL(String(url || fallback));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
    return parsed.toString();
  } catch (_) {
    try { return new URL(String(fallback || 'https://example.com/')).toString(); } catch (_) { return 'https://example.com/'; }
  }
}

function isToughCookieAvailable() {
  return Boolean(toughCookie?.CookieJar);
}

function getCookieJarFromJSON(serialized) {
  if (!serialized || !isToughCookieAvailable()) return null;
  try {
    if (typeof toughCookie.CookieJar.deserializeSync === 'function') {
      return toughCookie.CookieJar.deserializeSync(serialized);
    }
  } catch (_) {}
  try {
    if (typeof toughCookie.CookieJar.fromJSON === 'function') {
      return toughCookie.CookieJar.fromJSON(serialized);
    }
  } catch (_) {}
  return null;
}

function createEmptyCookieJar() {
  if (!isToughCookieAvailable()) return null;
  try { return new toughCookie.CookieJar(); } catch (_) { return null; }
}

function normalizeCookieDate(value) {
  if (value == null || value === '' || value === Infinity) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function cookieObjectToSetCookieString(cookie) {
  if (!cookie || typeof cookie !== 'object') return null;
  const name = cookie.name || cookie.key;
  const value = cookie.value ?? cookie.val;
  if (!name || value == null) return null;

  const parts = [`${name}=${value}`];
  const domain = cookie.domain || cookie.host;
  const path = cookie.path || '/';
  const maxAge = cookie.maxAge ?? cookie['max-age'];
  const expires = normalizeCookieDate(cookie.expires ?? cookie.expiry ?? cookie.expirationDate ?? cookie.expiration);

  if (domain) parts.push(`Domain=${String(domain).trim()}`);
  if (path) parts.push(`Path=${String(path).trim() || '/'}`);
  if (maxAge != null && Number.isFinite(Number(maxAge))) parts.push(`Max-Age=${Math.trunc(Number(maxAge))}`);
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  if (cookie.secure === true) parts.push('Secure');
  if (cookie.httpOnly === true || cookie.httponly === true) parts.push('HttpOnly');
  if (cookie.sameSite || cookie.samesite) parts.push(`SameSite=${cookie.sameSite || cookie.samesite}`);
  return parts.join('; ');
}

function rawCookiesToSetCookieStrings(rawCookies) {
  if (!rawCookies) return [];
  const out = [];

  if (Array.isArray(rawCookies)) {
    for (const item of rawCookies) {
      if (!item) continue;
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) out.push(trimmed.includes(';') ? trimmed : `${trimmed}; Path=/`);
      } else if (typeof item === 'object') {
        const setCookie = cookieObjectToSetCookieString(item);
        if (setCookie) out.push(setCookie);
      }
    }
    return out;
  }

  const raw = String(rawCookies || '').trim();
  if (!raw) return [];
  if (raw.includes(';') && /(?:path|domain|expires|max-age|secure|httponly|samesite)=?/i.test(raw)) {
    out.push(raw);
  } else {
    for (const { name, value } of parseCookieHeaderPairs(raw)) out.push(`${name}=${value}; Path=/`);
  }
  return out;
}

function addCookieStringsToJar(jar, rawCookies, url) {
  if (!jar || !rawCookies) return jar;
  const cookieUrl = safeCookieUrl(url);
  for (const setCookie of rawCookiesToSetCookieStrings(rawCookies)) {
    try { jar.setCookieSync(setCookie, cookieUrl, { ignoreError: true }); } catch (_) {}
  }
  return jar;
}

function createCookieJarFromSession(session = {}, url = null) {
  if (!isToughCookieAvailable()) return null;
  const cookieUrl = safeCookieUrl(url || session.solvedUrl || session.url);
  const serializedJar = getCookieJarFromJSON(session.cookieJar || session.jar || null);
  if (serializedJar) return serializedJar;

  const jar = createEmptyCookieJar();
  if (!jar) return null;
  if (session.cookies) addCookieStringsToJar(jar, session.cookies, cookieUrl);
  return jar;
}

function serializeCookieJar(jar) {
  if (!jar) return null;
  try {
    if (typeof jar.serializeSync === 'function') return jar.serializeSync();
  } catch (_) {}
  try {
    if (typeof jar.toJSON === 'function') return jar.toJSON();
  } catch (_) {}
  return null;
}

function getCookieStringFromJar(jar, url) {
  if (!jar) return '';
  try { return jar.getCookieStringSync(safeCookieUrl(url)); } catch (_) { return ''; }
}

function buildCookieHeaderFromSession(session = {}, url = null) {
  if (!session) return '';
  const cookieUrl = safeCookieUrl(url || session.solvedUrl || session.url);
  const jar = createCookieJarFromSession(session, cookieUrl);
  const fromJar = getCookieStringFromJar(jar, cookieUrl);
  return fromJar || joinCookieHeader(session.cookies || '');
}

function createCookieStateForUrl(url, rawCookies, existingSession = {}) {
  const cookieUrl = safeCookieUrl(url || existingSession.solvedUrl || existingSession.url);
  const jar = createCookieJarFromSession(existingSession, cookieUrl);
  if (jar) {
    addCookieStringsToJar(jar, rawCookies, cookieUrl);
    const cookies = getCookieStringFromJar(jar, cookieUrl);
    return {
      cookies,
      cookieJar: serializeCookieJar(jar),
      cookieJarVersion: 2,
      cf_clearance: readCookieValue(cookies, 'cf_clearance')
    };
  }

  const merged = mergeCookieHeaders(existingSession.cookies || '', rawCookies);
  return {
    cookies: merged,
    cf_clearance: readCookieValue(merged, 'cf_clearance')
  };
}

function mergeSessionCookies(session = {}, url = null, setCookieHeader = null) {
  const cookieUrl = safeCookieUrl(url || session.solvedUrl || session.url);
  if (!setCookieHeader && !session.cookieJar) return session;
  const state = createCookieStateForUrl(cookieUrl, setCookieHeader, session);
  return {
    ...session,
    ...state
  };
}

function parseCookieHeaderPairs(cookieHeader) {
  const out = [];
  const seen = new Set();
  const skip = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'priority', 'partitioned']);
  for (const part of String(cookieHeader || '').split(';')) {
    const parsed = parseSingleCookie(part);
    if (!parsed) continue;
    const [name, value] = parsed;
    const lowered = String(name || '').toLowerCase();
    if (!name || value == null || skip.has(lowered) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value });
  }
  return out;
}

function parseSetCookiePairs(setCookieHeader) {
  const headers = normalizeSetCookieHeaders(setCookieHeader);
  if (!headers.length) return [];

  if (setCookieParser?.parse) {
    try {
      return setCookieParser.parse(headers, { map: false, decodeValues: false })
        .filter(cookie => cookie && cookie.name && cookie.value != null)
        .map(cookie => ({
          name: cookie.name,
          value: String(cookie.value),
          expires: cookie.expires,
          maxAge: cookie.maxAge,
          domain: cookie.domain,
          path: cookie.path
        }));
    } catch (_) {}
  }

  return headers.map(header => {
    const parsed = parseSingleCookie(header);
    if (!parsed) return null;
    const cookie = { name: parsed[0], value: parsed[1] };
    for (const attr of String(header || '').split(';').slice(1)) {
      const eqIdx = attr.indexOf('=');
      const key = (eqIdx >= 0 ? attr.slice(0, eqIdx) : attr).trim().toLowerCase();
      const val = eqIdx >= 0 ? attr.slice(eqIdx + 1).trim() : '';
      if (key === 'expires') cookie.expires = val;
      else if (key === 'max-age') cookie.maxAge = Number(val);
      else if (key === 'domain') cookie.domain = val;
      else if (key === 'path') cookie.path = val;
    }
    return cookie;
  }).filter(Boolean);
}

function isCookieExpired(cookie) {
  if (!cookie || !cookie.name) return true;
  if (cookie.maxAge != null && Number(cookie.maxAge) <= 0) return true;
  if (cookie.expires) {
    const expiresAt = cookie.expires instanceof Date ? cookie.expires.getTime() : Date.parse(String(cookie.expires));
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return true;
  }
  return false;
}

function hasCookieInput(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return true;
  return String(value || '').trim() !== '';
}

function firstCookieInput(...values) {
  for (const value of values) {
    if (hasCookieInput(value)) return value;
  }
  return '';
}

function cookieHeaderToObjects(cookieHeader, url = null) {
  if (Array.isArray(cookieHeader)) {
    const out = [];
    const seen = new Set();
    for (const item of cookieHeader) {
      if (!item) continue;
      let name = null;
      let value = null;
      let expired = false;

      if (typeof item === 'string') {
        const parsed = parseSingleCookie(item);
        if (parsed) {
          name = parsed[0];
          value = parsed[1];
        }
      } else if (typeof item === 'object') {
        name = item.name || item.key || null;
        value = item.value ?? item.val ?? null;
        expired = isCookieExpired({ name, value, expires: item.expires ?? item.expiry ?? item.expirationDate, maxAge: item.maxAge ?? item['max-age'] });
      }

      if (!name || value == null || expired || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, value: String(value) });
    }
    return out;
  }

  const sessionCookieHeader = cookieHeader?.cookieJar || cookieHeader?.cookies
    ? buildCookieHeaderFromSession(cookieHeader, url)
    : String(cookieHeader || '');
  return parseCookieHeaderPairs(sessionCookieHeader).map(({ name, value }) => ({ name, value }));
}

function isLikelyChallengeHtml(body, status = 200) {
  const text = String(body || '').slice(0, 120000);
  const lower = text.toLowerCase();
  if ([403, 429, 503].includes(Number(status))) return true;
  if (!text) return false;
  return (
    lower.includes('cf-chl') ||
    lower.includes('__cf_chl') ||
    lower.includes('cf-turnstile') ||
    lower.includes('turnstile.cloudflare.com') ||
    lower.includes('challenge-platform') ||
    lower.includes('cloudflare ray id') ||
    lower.includes('checking if the site connection is secure') ||
    lower.includes('verify you are human') ||
    /<title>\s*(just a moment|attention required|checking|verifica)/i.test(text)
  );
}

function createAsyncLimiter(maxConcurrency = 1, options = {}) {
  const limit = Math.max(1, Math.min(4, Number(maxConcurrency) || 1));
  const maxQueue = Math.max(0, Number.isFinite(Number(options.maxQueue)) ? Number(options.maxQueue) : 80);
  let active = 0;
  const queue = [];

  function runNext() {
    if (active >= limit || !queue.length) return;
    const item = queue.shift();
    active += 1;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  }

  return function schedule(fn) {
    return new Promise((resolve, reject) => {
      if (active >= limit && queue.length >= maxQueue) {
        const error = new Error('async_limiter_queue_overflow');
        error.code = 'ASYNC_LIMITER_QUEUE_OVERFLOW';
        error.active = active;
        error.queued = queue.length;
        error.limit = limit;
        error.maxQueue = maxQueue;
        reject(error);
        return;
      }

      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

function parseSingleCookie(raw) {
  const primary = String(raw || '').split(';')[0];
  const eqIdx = primary.indexOf('=');
  if (eqIdx < 0) return null;
  const key = primary.slice(0, eqIdx).trim();
  const val = primary.slice(eqIdx + 1).trim();
  return key ? [key, val] : null;
}

function joinCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return String(cookies || '').trim();

  const out = [];
  const seen = new Set();
  for (const cookie of cookies) {
    let name = null;
    let value = null;
    let expired = false;

    if (typeof cookie === 'string') {
      const parsed = parseSingleCookie(cookie);
      if (parsed) {
        name = parsed[0];
        value = parsed[1];
      }
    } else if (cookie && typeof cookie === 'object') {
      name = cookie.name || cookie.key || null;
      value = cookie.value ?? cookie.val ?? null;
      expired = isCookieExpired({ name, value, expires: cookie.expires, maxAge: cookie.maxAge });
    }

    if (!name || value == null || expired || seen.has(name)) continue;
    seen.add(name);
    out.push(`${name}=${value}`);
  }
  return out.join('; ');
}

function appendCacheBustParam(url, paramName = '__cfcb') {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    const u = new URL(String(url));
    u.searchParams.set(paramName, nonce);
    return u.toString();
  } catch (_) {
    const sep = String(url || '').includes('?') ? '&' : '?';
    return `${url || ''}${sep}${paramName}=${nonce}`;
  }
}

function readCookieValue(cookieHeader, cookieName) {
  const name = String(cookieName || '').trim();
  if (!name) return null;
  for (const { name: key, value } of parseCookieHeaderPairs(cookieHeader)) {
    if (key === name) return value || null;
  }
  return null;
}

function mergeCookieHeaders(existing, setCookieHeader) {
  const cookieMap = new Map();

  for (const { name, value } of parseCookieHeaderPairs(existing)) {
    cookieMap.set(name, value);
  }

  for (const cookie of parseSetCookiePairs(setCookieHeader)) {
    if (!cookie?.name) continue;
    if (isCookieExpired(cookie)) cookieMap.delete(cookie.name);
    else cookieMap.set(cookie.name, cookie.value);
  }

  return Array.from(cookieMap.entries()).map(([key, val]) => `${key}=${val}`).join('; ');
}

function defaultLogger() {
  return {
    debug() {},
    info(message, meta = null) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      console.log(`[CF-SHIELD] ${message}${suffix}`);
    },
    warn(message, meta = null) {
      const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
      console.warn(`[CF-SHIELD] ${message}${suffix}`);
    }
  };
}

function createCfClearanceManager(options = {}) {
  const logger = options.logger || defaultLogger();
  const endpoints = getConfiguredBypassEndpoints(options.endpoints, options.endpoint, options.bypassEndpoints, options.bypassEndpoint);
  const endpoint = endpoints[0] || null;
  const providerName = options.providerName || 'provider';
  const sessionTtlMs = Math.max(60_000, Number(options.sessionTtlMs || 6 * 60 * 60 * 1000));
  const cooldownMs = Math.max(0, Number(options.cooldownMs || 8000));
  const cooldownMaxEntries = Math.max(25, Number.isFinite(Number(options.cooldownMaxEntries)) ? Number(options.cooldownMaxEntries) : 500);
  const solveMaxQueue = Math.max(0, Number.isFinite(Number(options.solveMaxQueue)) ? Number(options.solveMaxQueue) : 80);
  const solveTimeoutMs = Math.max(12_000, Number(options.solveTimeoutMs || 24_000));
  const endpointFailureCooldownMs = Math.max(5_000, Number(options.endpointFailureCooldownMs || DEFAULT_ENDPOINT_FAILURE_COOLDOWN_MS));
  const healthCacheMs = Math.max(0, Number(options.healthCacheMs ?? 10_000));
  const healthTimeoutMs = Math.max(1500, Math.min(8000, Number(options.healthTimeoutMs || 6000)));
  const flareRetryCount = Math.max(0, Math.min(2, Number.isFinite(Number(options.flareRetryCount)) ? Number(options.flareRetryCount) : 1));
  const flareRetryBackoffMs = Math.max(100, Math.min(3000, Number(options.flareRetryBackoffMs || 750)));
  const providerFailureCooldownMs = Math.max(5_000, Number(options.providerFailureCooldownMs || 60_000));
  const providerFailureCooldownMaxMs = Math.max(providerFailureCooldownMs, Number(options.providerFailureCooldownMaxMs || 300_000));
  const returnOnlyCookies = options.returnOnlyCookies !== false;
  const disableMedia = options.disableMedia !== false;
  const waitInSeconds = Math.max(0, Math.min(5, Number(options.waitInSeconds ?? 1) || 0));
  const sessionTtlMinutes = Math.max(1, Math.ceil(sessionTtlMs / 60000));
  // When the bypass service replies 200 but with no cookies (a poisoned/empty
  // cache entry keyed on the URL), retry once against the same endpoint with a
  // cache-busting query param so the upstream solver is forced to re-run the
  // browser challenge instead of serving the stale empty result forever.
  const cacheBustOnEmpty = options.cacheBustOnEmpty !== false;
  const cacheBustParam = String(options.cacheBustParam || '__cfcb');
  // The upstream bypass service keys its cookie cache per-hostname (md5 of the
  // host), ignoring path/query — so a URL nonce alone cannot evict a poisoned
  // empty entry. When an empty result is seen we POST /cache/clear to purge it,
  // throttled so a request storm cannot thrash the shared cache.
  const clearUpstreamCacheOnEmpty = options.clearUpstreamCacheOnEmpty !== false;
  const cacheClearMinIntervalMs = Math.max(2_000, Number(options.cacheClearMinIntervalMs || 15_000));
  const solveLimiter = createAsyncLimiter(options.solveConcurrency || 1, { maxQueue: solveMaxQueue });
  const httpAgent = options.httpAgent || undefined;
  const httpsAgent = options.httpsAgent || undefined;
  const getFallbackUserAgent = typeof options.getFallbackUserAgent === 'function'
    ? options.getFallbackUserAgent
    : () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  const onSession = typeof options.onSession === 'function' ? options.onSession : () => {};
  const isCanceledError = typeof options.isCanceledError === 'function' ? options.isCanceledError : () => false;

  const inFlight = new Map();
  const cooldown = new Map();
  const cacheClearCooldown = new Map();
  const endpointFailures = new Map();
  const endpointHealthOkUntil = new Map();
  let endpointCursor = 0;
  let missingEndpointWarned = false;
  let providerFailureUntil = 0;
  let providerFailureCount = 0;
  let providerFailureReason = null;

  function getEndpointCandidates(force = false) {
    if (!endpoints.length) return [];
    const now = Date.now();
    const rotated = endpoints.slice(endpointCursor).concat(endpoints.slice(0, endpointCursor));
    const healthy = rotated.filter(item => force || (endpointFailures.get(item) || 0) <= now);
    return healthy.length ? healthy : rotated;
  }

  function markEndpointSuccess(item) {
    endpointFailures.delete(item);
    const index = endpoints.indexOf(item);
    if (index >= 0) endpointCursor = index;
  }

  function markEndpointFailure(item) {
    if (!item) return;
    endpointFailures.set(item, Date.now() + endpointFailureCooldownMs);
    if (endpoints.length > 1) endpointCursor = (endpoints.indexOf(item) + 1 + endpoints.length) % endpoints.length;
  }

  function getProviderCooldown(now = Date.now()) {
    if (!providerFailureUntil || now >= providerFailureUntil) return null;
    return {
      remainingMs: providerFailureUntil - now,
      failures: providerFailureCount,
      reason: providerFailureReason
    };
  }

  function markProviderFailure(error) {
    const now = Date.now();
    if (providerFailureUntil && now > providerFailureUntil + providerFailureCooldownMaxMs) providerFailureCount = 0;
    providerFailureCount += 1;
    const duration = Math.min(
      providerFailureCooldownMs * Math.pow(2, Math.max(0, providerFailureCount - 1)),
      providerFailureCooldownMaxMs
    );
    providerFailureUntil = now + duration;
    providerFailureReason = error?.message || String(error || 'cloudflare_bypass_failure');
    logger.warn('solve provider cooldown', {
      provider: providerName,
      cooldownMs: duration,
      failures: providerFailureCount,
      reason: providerFailureReason
    });
  }

  function clearProviderFailure() {
    providerFailureUntil = 0;
    providerFailureCount = 0;
    providerFailureReason = null;
  }

  const bypassClientCache = new Map();

  function getBypassClient(selectedEndpoint) {
    const endpointKey = normalizeBypassEndpoint(selectedEndpoint);
    if (!endpointKey) throw new Error('invalid_cloudflare_bypass_endpoint');
    if (!bypassClientCache.has(endpointKey)) {
      bypassClientCache.set(endpointKey, createCloudflareBypassServiceClient({
        endpoint: endpointKey,
        retries: Math.max(1, Number(options.bypassRetries || options.retries || 5) || 5),
        httpClient: axios
      }));
    }
    return bypassClientCache.get(endpointKey);
  }

  async function clearEndpointCacheOnce(selectedEndpoint, signal = null) {
    if (!clearUpstreamCacheOnEmpty) return false;
    const now = Date.now();
    const last = cacheClearCooldown.get(selectedEndpoint) || 0;
    if (now - last < cacheClearMinIntervalMs) return false;
    cacheClearCooldown.set(selectedEndpoint, now);
    try {
      const client = getBypassClient(selectedEndpoint);
      if (typeof client.clearCache !== 'function') return false;
      const result = await client.clearCache({ timeout: healthTimeoutMs, signal });
      logger.warn('cache cleared', {
        provider: providerName,
        endpoint: selectedEndpoint,
        message: result?.message || undefined
      });
      return true;
    } catch (error) {
      logger.warn('cache clear failed', {
        provider: providerName,
        endpoint: selectedEndpoint,
        error: error?.message || String(error)
      });
      return false;
    }
  }

  async function postFlareWithRetry(selectedEndpoint, payload, timeout, signal, label = 'request') {
    let lastError = null;
    for (let attempt = 0; attempt <= flareRetryCount; attempt += 1) {
      try {
        const client = getBypassClient(selectedEndpoint);
        const cmd = String(payload?.cmd || '').toLowerCase();

        if (cmd === 'sessions.list') {
          await client.health({ timeout, signal });
          return { status: 200, data: { status: 'ok' } };
        }

        if (cmd !== 'request.get') {
          throw new Error(`unsupported_cloudflare_bypass_cmd_${payload?.cmd || 'unknown'}`);
        }

        const targetUrl = payload.url;
        const wantResponse = payload.returnOnlyCookies === false;
        const requestTimeout = Math.max(5000, Number(timeout || payload.maxTimeout || solveTimeoutMs));
        const requestOptions = {
          providerName,
          timeout: requestTimeout,
          timeoutMs: requestTimeout,
          signal,
          retries: Math.max(1, Math.min(10, Number(payload.retries || options.bypassRetries || 5) || 5)),
          proxy: payload.proxy || options.proxy || options.proxyUrl || null,
          egressKey: options.egressKey || 'direct',
          bypassCache: Boolean(payload.bypassCookieCache || payload.force || payload.bypassCache),
          httpRetries: 1,
          retryBackoffMs: flareRetryBackoffMs,
          guardMinIntervalMs: options.solveMinIntervalMs,
          guardMaxConcurrency: options.solveMaxConcurrency,
          guardMaxQueue: options.solveMaxQueue
        };

        let htmlResult = null;
        if (wantResponse) {
          htmlResult = await client.getHtml(targetUrl, requestOptions);
        }

        const cookieResult = await client.getCookies(targetUrl, requestOptions);
        const solutionUrl = htmlResult?.finalUrl || cookieResult.url || targetUrl;
        const responseBody = wantResponse ? (htmlResult?.html || '') : '';
        const solutionStatus = htmlResult?.status || cookieResult.status || 200;
        const solutionCookies = cookieResult.setCookie || cookieResult.cookieHeader || cookieResult.cookies || [];
        const userAgent = cookieResult.userAgent || htmlResult?.userAgent || getFallbackUserAgent();

        return {
          status: 200,
          data: {
            status: 'ok',
            solution: {
              url: solutionUrl,
              status: solutionStatus,
              response: responseBody,
              cookies: solutionCookies,
              userAgent
            }
          }
        };
      } catch (error) {
        lastError = error;
        if (attempt >= flareRetryCount || !isRetryableFlareError(error) || signal?.aborted) break;
        const waitMs = flareRetryBackoffMs * (attempt + 1);
        logger.debug('solve retry', {
          provider: providerName,
          endpoint: selectedEndpoint,
          label,
          attempt: attempt + 1,
          waitMs,
          error: error?.message || String(error)
        });
        await sleep(waitMs);
      }
    }
    throw lastError;
  }

  async function assertEndpointHealthy(selectedEndpoint, signal = null) {
    if (!healthCacheMs) return true;
    const now = Date.now();
    if ((endpointHealthOkUntil.get(selectedEndpoint) || 0) > now) return true;

    const response = await postFlareWithRetry(selectedEndpoint, { cmd: 'sessions.list' }, healthTimeoutMs, signal, 'health');
    const payload = response.data || {};
    if (response.status >= 400) throw new Error(`health_http_${response.status}`);
    if (payload.status && String(payload.status).toLowerCase() !== 'ok') {
      throw new Error(payload.message || payload.error || `health_status_${payload.status}`);
    }
    endpointHealthOkUntil.set(selectedEndpoint, Date.now() + healthCacheMs);
    return true;
  }

  function isFresh(session) {
    if (!session || !session.userAgent || !session.timestamp) return false;
    if (Date.now() - Number(session.timestamp) >= sessionTtlMs) return false;
    const cookieHeader = buildCookieHeaderFromSession(session, session.solvedUrl || session.url);
    return Boolean(cookieHeader);
  }

  function keyFor(url, sharedKey = null) {
    const shared = String(sharedKey || '').trim();
    if (shared) return `shared:${providerName}:${shared}`;
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}${u.search}`;
    } catch (_) {
      return String(url || '');
    }
  }

  function pruneCooldown(now = Date.now()) {
    if (!cooldown.size) return;
    const maxAge = Math.max(cooldownMs * 4, 60_000);
    for (const [entryKey, timestamp] of cooldown.entries()) {
      if (!Number.isFinite(Number(timestamp)) || now - Number(timestamp) > maxAge) {
        cooldown.delete(entryKey);
      }
    }

    if (cooldown.size <= cooldownMaxEntries) return;
    const overflow = cooldown.size - cooldownMaxEntries;
    let removed = 0;
    for (const entryKey of cooldown.keys()) {
      cooldown.delete(entryKey);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  function formatAbortReason(reason) {
    if (reason == null) return null;
    if (typeof reason === 'string') return reason;
    if (reason instanceof Error) return reason.message || reason.name;
    try { return JSON.stringify(reason); } catch (_) { return String(reason); }
  }

  async function solve(clearanceUrl, signal = null, meta = {}) {
    if (!endpoints.length) {
      if (!missingEndpointWarned) {
        missingEndpointWarned = true;
        logger.warn('solve skipped', { provider: providerName, reason: 'missing_CLOUDFLARE_BYPASS_URL' });
      }
      return null;
    }

    const sharedKey = meta.sharedKey || meta.coalesceKey || null;
    const key = keyFor(clearanceUrl, sharedKey);
    if (inFlight.has(key)) {
      logger.debug('solve shared wait', {
        provider: providerName,
        clearanceUrl,
        key,
        shared: Boolean(sharedKey)
      });
      return inFlight.get(key);
    }

    const now = Date.now();
    const activeProviderCooldown = getProviderCooldown(now);
    if (activeProviderCooldown && !meta.ignoreProviderCooldown) {
      logger.warn('solve skipped', {
        provider: providerName,
        clearanceUrl,
        reason: 'provider_cooldown',
        remainingMs: activeProviderCooldown.remainingMs,
        failures: activeProviderCooldown.failures,
        lastError: activeProviderCooldown.reason
      });
      return null;
    }

    pruneCooldown(now);
    const last = cooldown.get(key) || 0;
    if (!meta.force && now - last < cooldownMs) return null;
    cooldown.set(key, now);

    const promise = solveLimiter(async () => {
      const startedAt = Date.now();
      const maxTimeout = Math.max(12_000, Math.min(solveTimeoutMs, Number(meta.maxTimeout || solveTimeoutMs)));
      const controller = new AbortController();
      const abortFromParent = () => {
        if (!controller.signal.aborted) controller.abort(signal?.reason || 'parent aborted');
      };

      if (signal?.aborted) abortFromParent();
      else if (signal) signal.addEventListener('abort', abortFromParent, { once: true });

      const hardTimer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort('cloudflare bypass hard timeout');
      }, maxTimeout + 8000);
      if (hardTimer?.unref) hardTimer.unref();

      const inputCookies = firstCookieInput(meta.cookies, meta.cookieHeader);
      const cookieObjects = cookieHeaderToObjects(inputCookies);
      const candidates = getEndpointCandidates(Boolean(meta.force));
      let lastError = null;

      // A single solve attempt against one endpoint. Returned as a closure so the
      // empty/poisoned-cache path can transparently retry with a cache-busted URL
      // (cf_clearance is domain-scoped, so the throwaway query param does not
      // change the resulting cookie). Returns { session } on success or
      // { empty, ... } when the bypass replied without usable cookies.
      const attemptSolve = async (selectedEndpoint, attemptUrl, { bust = false, sessionBase = null } = {}) => {
        const requestPayload = {
          cmd: 'request.get',
          url: attemptUrl,
          maxTimeout,
          session_ttl_minutes: sessionTtlMinutes,
          disableMedia,
          returnOnlyCookies: meta.wantResponse ? false : returnOnlyCookies
        };
        if (waitInSeconds) requestPayload.waitInSeconds = waitInSeconds;
        if (cookieObjects.length) requestPayload.cookies = cookieObjects;
        if (bust) {
          requestPayload.force = true;
          requestPayload.bypassCookieCache = true;
        }

        const response = await postFlareWithRetry(
          selectedEndpoint,
          requestPayload,
          maxTimeout + 9000,
          controller.signal,
          `${requestPayload.cmd} ${providerName}`
        );

        const payload = response.data || {};
        if (response.status >= 400) throw new Error(`http_${response.status}`);
        if (payload.status && String(payload.status).toLowerCase() !== 'ok') {
          throw new Error(payload.message || payload.error || `status_${payload.status}`);
        }

        const solution = payload.solution || {};
        const rawSolutionCookies = firstCookieInput(solution.cookies, payload.cookies);
        const userAgent = solution.userAgent || payload.userAgent || meta.userAgent || getFallbackUserAgent();
        // Keep the canonical (un-busted) URL as the session base so the stored
        // cookie domain is never tied to the throwaway cache-bust query param.
        const solvedUrl = sessionBase || solution.url || attemptUrl;
        const solutionStatus = solution.status || response.status;
        const solutionBody = solution.response || payload.response || '';
        const usefulSolutionHtml = isUsefulSolutionHtml(solutionBody, solutionStatus);
        const cookieState = createCookieStateForUrl(solvedUrl || attemptUrl, rawSolutionCookies, {
          cookies: inputCookies,
          userAgent,
          url: normalizeBaseUrl(solvedUrl) || normalizeBaseUrl(attemptUrl) || null
        });
        const cookies = cookieState.cookies || joinCookieHeader(rawSolutionCookies || '');

        if ((!cookies || !userAgent) || isLikelyChallengeHtml(solutionBody, solutionStatus)) {
          return {
            empty: true,
            status: solutionStatus,
            cookies: Boolean(cookies),
            userAgent: Boolean(userAgent),
            challengeBody: isLikelyChallengeHtml(solutionBody, solutionStatus)
          };
        }

        return {
          session: {
            providerName,
            userAgent,
            cookies,
            cookieJar: cookieState.cookieJar || null,
            cookieJarVersion: cookieState.cookieJar ? 2 : undefined,
            cf_clearance: cookieState.cf_clearance || readCookieValue(cookies, 'cf_clearance'),
            url: normalizeBaseUrl(solvedUrl) || normalizeBaseUrl(clearanceUrl) || null,
            solvedUrl,
            timestamp: Date.now(),
            status: solutionStatus,
            endpoint: selectedEndpoint,
            solutionResponse: usefulSolutionHtml ? solutionBody : undefined,
            solutionResponseUrl: usefulSolutionHtml ? solvedUrl : undefined,
            solutionResponseStatus: usefulSolutionHtml ? solutionStatus : undefined
          }
        };
      };

      try {
        for (const selectedEndpoint of candidates) {
          if (controller.signal.aborted) return null;
          try {
            await assertEndpointHealthy(selectedEndpoint, controller.signal);

            logger.info('solve start', {
              provider: providerName,
              clearanceUrl,
              triggerUrl: meta.triggerUrl,
              method: meta.method || 'GET',
              maxTimeout,
              endpoint: selectedEndpoint,
              endpoints: endpoints.length,
              cookiesIn: cookieObjects.length,
              shared: Boolean(sharedKey),
              sharedKey: sharedKey || undefined
            });

            let result = await attemptSolve(selectedEndpoint, clearanceUrl);

            // The bypass replied 200 but without usable cookies — almost always a
            // poisoned/empty entry served straight from the upstream URL-keyed
            // cache ("Using cached cookies ... 0 cookies"). Force one re-solve with
            // a cache-busted URL so the solver actually re-runs the challenge.
            if (result.empty && cacheBustOnEmpty && !controller.signal.aborted) {
              logger.warn('solve empty cache-bust retry', {
                provider: providerName,
                clearanceUrl,
                endpoint: selectedEndpoint,
                status: result.status,
                cookies: result.cookies,
                userAgent: result.userAgent,
                challengeBody: result.challengeBody
              });
              // Purge the upstream per-hostname cache so the busted retry forces a
              // fresh browser solve instead of replaying the poisoned empty entry.
              await clearEndpointCacheOnce(selectedEndpoint, controller.signal);
              result = await attemptSolve(
                selectedEndpoint,
                appendCacheBustParam(clearanceUrl, cacheBustParam),
                { bust: true, sessionBase: clearanceUrl }
              );
            }

            if (result.empty) {
              logger.warn('solve empty', {
                provider: providerName,
                clearanceUrl,
                endpoint: selectedEndpoint,
                status: result.status,
                cookies: result.cookies,
                userAgent: result.userAgent,
                challengeBody: result.challengeBody
              });
              markEndpointFailure(selectedEndpoint);
              continue;
            }

            const session = result.session;
            onSession(session);
            markEndpointSuccess(selectedEndpoint);
            clearProviderFailure();
            logger.info('solve ok', {
              provider: providerName,
              clearanceUrl,
              solvedBase: session.url,
              endpoint: selectedEndpoint,
              hasClearance: Boolean(session.cf_clearance || String(session.cookies || '').includes('cf_clearance=')),
              cookies: String(session.cookies || '').split(';').filter(Boolean).length,
              solutionHtml: Boolean(session.solutionResponse),
              ms: Date.now() - startedAt
            });

            return session;
          } catch (error) {
            lastError = error;
            if (isCanceledError(error) || signal?.aborted || String(error?.code || '') === 'ERR_CANCELED') {
              logger.warn('solve aborted', {
                provider: providerName,
                clearanceUrl,
                endpoint: selectedEndpoint,
                reason: formatAbortReason(signal?.reason) || error?.message || String(error)
              });
              return null;
            }
            markEndpointFailure(selectedEndpoint);
            logger.warn('solve failed', { provider: providerName, clearanceUrl, endpoint: selectedEndpoint, error: error?.message || String(error) });
          }
        }

        if (lastError) markProviderFailure(lastError);
        return null;
      } finally {
        clearTimeout(hardTimer);
        if (signal) signal.removeEventListener('abort', abortFromParent);
      }
    }).catch((error) => {
      if (error?.code === 'ASYNC_LIMITER_QUEUE_OVERFLOW') {
        logger.warn('solve skipped', {
          provider: providerName,
          clearanceUrl,
          reason: 'queue_overflow',
          active: error.active,
          queued: error.queued,
          limit: error.limit,
          maxQueue: error.maxQueue,
          shared: Boolean(sharedKey),
          sharedKey: sharedKey || undefined
        });
        return null;
      }
      throw error;
    }).finally(() => inFlight.delete(key));

    inFlight.set(key, promise);
    return promise;
  }

  return {
    endpoint,
    endpoints,
    isFresh,
    solve,
    mergeCookieHeaders,
    readCookieValue,
    normalizeBaseUrl
  };
}

module.exports = {
  createCfClearanceManager,
  normalizeBaseUrl,
  normalizeFlareEndpoint,
  normalizeFlareEndpoints,
  cookieHeaderToObjects,
  normalizeSetCookieHeaders,
  parseSetCookiePairs,
  parseCookieHeaderPairs,
  DEFAULT_CLOUDFLARE_BYPASS_URL,
  parseSingleCookie,
  joinCookieHeader,
  readCookieValue,
  mergeCookieHeaders,
  buildCookieHeaderFromSession,
  mergeSessionCookies,
  createCookieJarFromSession,
  createCookieStateForUrl,
  isToughCookieAvailable
};
