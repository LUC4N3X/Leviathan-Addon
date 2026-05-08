'use strict';

const axios = require('axios');

let setCookieParser = null;
try {
  setCookieParser = require('set-cookie-parser');
} catch (_) {
  // Optional at runtime during tests/dev before npm install. Fallback parsers below stay active.
}

const DEFAULT_FLARESOLVERR_URL = null;
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
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
  } catch (_) {
    return null;
  }
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

function normalizeFlareEndpoints(...values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const parts = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/g);
    for (const part of parts) {
      const endpoint = normalizeFlareEndpoint(part);
      if (!endpoint || seen.has(endpoint)) continue;
      seen.add(endpoint);
      out.push(endpoint);
    }
  }
  return out;
}

function normalizeSetCookieHeaders(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
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

function cookieHeaderToObjects(cookieHeader) {
  if (Array.isArray(cookieHeader)) {
    const out = [];
    const seen = new Set();
    for (const cookie of parseSetCookiePairs(cookieHeader)) {
      if (isCookieExpired(cookie) || seen.has(cookie.name)) continue;
      seen.add(cookie.name);
      out.push({ name: cookie.name, value: cookie.value });
    }
    return out;
  }
  return parseCookieHeaderPairs(cookieHeader).map(({ name, value }) => ({ name, value }));
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

function createAsyncLimiter(maxConcurrency = 1) {
  const limit = Math.max(1, Math.min(4, Number(maxConcurrency) || 1));
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
  const endpoints = normalizeFlareEndpoints(options.endpoints, options.endpoint, process.env.FLARESOLVERR_URLS, process.env.FLARESOLVERR_URL);
  const endpoint = endpoints[0] || null;
  const providerName = options.providerName || 'provider';
  const sessionTtlMs = Math.max(60_000, Number(options.sessionTtlMs || 6 * 60 * 60 * 1000));
  const cooldownMs = Math.max(0, Number(options.cooldownMs || 8000));
  const solveTimeoutMs = Math.max(12_000, Number(options.solveTimeoutMs || 24_000));
  const endpointFailureCooldownMs = Math.max(5_000, Number(options.endpointFailureCooldownMs || DEFAULT_ENDPOINT_FAILURE_COOLDOWN_MS));
  const returnOnlyCookies = options.returnOnlyCookies !== false;
  const disableMedia = options.disableMedia !== false;
  const waitInSeconds = Math.max(0, Math.min(5, Number(options.waitInSeconds || 0) || 0));
  const sessionTtlMinutes = Math.max(1, Math.ceil(sessionTtlMs / 60000));
  const solveLimiter = createAsyncLimiter(options.solveConcurrency || 1);
  const httpAgent = options.httpAgent || undefined;
  const httpsAgent = options.httpsAgent || undefined;
  const getFallbackUserAgent = typeof options.getFallbackUserAgent === 'function'
    ? options.getFallbackUserAgent
    : () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
  const onSession = typeof options.onSession === 'function' ? options.onSession : () => {};
  const isCanceledError = typeof options.isCanceledError === 'function' ? options.isCanceledError : () => false;

  const inFlight = new Map();
  const cooldown = new Map();
  const endpointFailures = new Map();
  let endpointCursor = 0;
  let missingEndpointWarned = false;

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

  function isFresh(session) {
    return Boolean(
      session &&
      session.cookies &&
      session.userAgent &&
      session.timestamp &&
      Date.now() - Number(session.timestamp) < sessionTtlMs
    );
  }

  function keyFor(url) {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}${u.search}`;
    } catch (_) {
      return String(url || '');
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
        logger.warn('solve skipped', { provider: providerName, reason: 'missing_FLARESOLVERR_URL' });
      }
      return null;
    }

    const key = keyFor(clearanceUrl);
    if (inFlight.has(key)) return inFlight.get(key);

    const now = Date.now();
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
        if (!controller.signal.aborted) controller.abort('flaresolverr hard timeout');
      }, maxTimeout + 8000);
      if (hardTimer?.unref) hardTimer.unref();

      const cookieObjects = cookieHeaderToObjects(meta.cookies || meta.cookieHeader || '');
      const candidates = getEndpointCandidates(Boolean(meta.force));
      let lastError = null;

      try {
        for (const selectedEndpoint of candidates) {
          if (controller.signal.aborted) return null;
          try {
            logger.info('solve start', {
              provider: providerName,
              clearanceUrl,
              triggerUrl: meta.triggerUrl,
              method: meta.method || 'GET',
              maxTimeout,
              endpoint: selectedEndpoint,
              endpoints: endpoints.length,
              cookiesIn: cookieObjects.length
            });

            const requestPayload = {
              cmd: 'request.get',
              url: clearanceUrl,
              maxTimeout,
              session_ttl_minutes: sessionTtlMinutes,
              disableMedia,
              returnOnlyCookies
            };
            if (waitInSeconds) requestPayload.waitInSeconds = waitInSeconds;
            if (cookieObjects.length) requestPayload.cookies = cookieObjects;

            const response = await axios.post(selectedEndpoint, requestPayload, {
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

            const payload = response.data || {};
            if (response.status >= 400) throw new Error(`http_${response.status}`);
            if (payload.status && String(payload.status).toLowerCase() !== 'ok') {
              throw new Error(payload.message || payload.error || `status_${payload.status}`);
            }

            const solution = payload.solution || {};
            const cookies = joinCookieHeader(solution.cookies || payload.cookies || '');
            const userAgent = solution.userAgent || payload.userAgent || meta.userAgent || getFallbackUserAgent();
            const solvedUrl = solution.url || clearanceUrl;
            const solutionStatus = solution.status || response.status;
            const solutionBody = solution.response || payload.response || '';

            if ((!cookies || !userAgent) || isLikelyChallengeHtml(solutionBody, solutionStatus)) {
              logger.warn('solve empty', {
                provider: providerName,
                clearanceUrl,
                endpoint: selectedEndpoint,
                status: solutionStatus,
                cookies: Boolean(cookies),
                userAgent: Boolean(userAgent),
                challengeBody: isLikelyChallengeHtml(solutionBody, solutionStatus)
              });
              markEndpointFailure(selectedEndpoint);
              continue;
            }

            const session = {
              providerName,
              userAgent,
              cookies,
              cf_clearance: readCookieValue(cookies, 'cf_clearance'),
              url: normalizeBaseUrl(solvedUrl) || normalizeBaseUrl(clearanceUrl) || null,
              solvedUrl,
              timestamp: Date.now(),
              status: solutionStatus,
              endpoint: selectedEndpoint
            };

            onSession(session);
            markEndpointSuccess(selectedEndpoint);
            logger.info('solve ok', {
              provider: providerName,
              clearanceUrl,
              solvedBase: session.url,
              endpoint: selectedEndpoint,
              hasClearance: Boolean(session.cf_clearance || String(session.cookies || '').includes('cf_clearance=')),
              cookies: String(session.cookies || '').split(';').filter(Boolean).length,
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

        if (lastError) return null;
        return null;
      } finally {
        clearTimeout(hardTimer);
        if (signal) signal.removeEventListener('abort', abortFromParent);
      }
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
  DEFAULT_FLARESOLVERR_URL,
  parseSingleCookie,
  joinCookieHeader,
  readCookieValue,
  mergeCookieHeaders
};
