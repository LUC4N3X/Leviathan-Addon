'use strict';

const axios = require('axios');

const DEFAULT_FLARESOLVERR_URL = null;

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
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
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
    const val = part.slice(eqIdx + 1).trim();
    if (key === name) return val || null;
  }
  return null;
}

function mergeCookieHeaders(existing, setCookieHeader) {
  if (!setCookieHeader) return existing || '';

  const skip = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
  const cookieMap = new Map();

  for (const part of String(existing || '').split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key && !skip.has(key.toLowerCase())) cookieMap.set(key, val);
  }

  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const parsed = parseSingleCookie(header);
    if (parsed && !skip.has(parsed[0].toLowerCase())) cookieMap.set(parsed[0], parsed[1]);
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
  const endpoint = normalizeFlareEndpoint(options.endpoint || process.env.FLARESOLVERR_URL);
  const providerName = options.providerName || 'provider';
  const sessionTtlMs = Math.max(60_000, Number(options.sessionTtlMs || 6 * 60 * 60 * 1000));
  const cooldownMs = Math.max(0, Number(options.cooldownMs || 8000));
  const solveTimeoutMs = Math.max(12_000, Number(options.solveTimeoutMs || 24_000));
  const httpAgent = options.httpAgent || undefined;
  const httpsAgent = options.httpsAgent || undefined;
  const getFallbackUserAgent = typeof options.getFallbackUserAgent === 'function'
    ? options.getFallbackUserAgent
    : () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
  const onSession = typeof options.onSession === 'function' ? options.onSession : () => {};
  const isCanceledError = typeof options.isCanceledError === 'function' ? options.isCanceledError : () => false;

  const inFlight = new Map();
  const cooldown = new Map();
  let missingEndpointWarned = false;

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
    if (!endpoint) {
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

    const promise = (async () => {
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

      try {
        logger.info('solve start', {
          provider: providerName,
          clearanceUrl,
          triggerUrl: meta.triggerUrl,
          method: meta.method || 'GET',
          maxTimeout,
          endpoint
        });

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

        const payload = response.data || {};
        if (response.status >= 400) throw new Error(`http_${response.status}`);
        if (payload.status && String(payload.status).toLowerCase() !== 'ok') {
          throw new Error(payload.message || payload.error || `status_${payload.status}`);
        }

        const solution = payload.solution || {};
        const cookies = joinCookieHeader(solution.cookies || payload.cookies || '');
        const userAgent = solution.userAgent || payload.userAgent || meta.userAgent || getFallbackUserAgent();
        const solvedUrl = solution.url || clearanceUrl;

        if (!cookies || !userAgent) {
          logger.warn('solve empty', { provider: providerName, clearanceUrl, status: solution.status || response.status });
          return null;
        }

        const session = {
          providerName,
          userAgent,
          cookies,
          cf_clearance: readCookieValue(cookies, 'cf_clearance'),
          url: normalizeBaseUrl(solvedUrl) || normalizeBaseUrl(clearanceUrl) || null,
          solvedUrl,
          timestamp: Date.now(),
          status: solution.status || response.status
        };

        onSession(session);
        logger.info('solve ok', {
          provider: providerName,
          clearanceUrl,
          solvedBase: session.url,
          hasClearance: Boolean(session.cf_clearance || String(session.cookies || '').includes('cf_clearance=')),
          cookies: String(session.cookies || '').split(';').filter(Boolean).length,
          ms: Date.now() - startedAt
        });

        return session;
      } catch (error) {
        if (isCanceledError(error) || signal?.aborted || String(error?.code || '') === 'ERR_CANCELED') {
          logger.warn('solve aborted', {
            provider: providerName,
            clearanceUrl,
            reason: formatAbortReason(signal?.reason) || error?.message || String(error)
          });
          return null;
        }
        logger.warn('solve failed', { provider: providerName, clearanceUrl, error: error?.message || String(error) });
        return null;
      } finally {
        clearTimeout(hardTimer);
        if (signal) signal.removeEventListener('abort', abortFromParent);
      }
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, promise);
    return promise;
  }

  return {
    endpoint,
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
  DEFAULT_FLARESOLVERR_URL,
  parseSingleCookie,
  joinCookieHeader,
  readCookieValue,
  mergeCookieHeaders
};
