'use strict';

const axios = require('axios');

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envNumber(name, fallback, min = 0, max = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function envList(name, fallback = []) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback.join(',') : raw;
  return String(value || '')
    .split(/[ ,|]+/)
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function originKey(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch (_) {
    return 'invalid';
  }
}

function safeHeaderMap(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    const name = String(key || '').trim();
    if (!name) continue;
    if (/^(?:host|connection|content-length|transfer-encoding)$/i.test(name)) continue;
    if (Array.isArray(value)) out[name] = value.filter(Boolean).map(String).join(', ');
    else out[name] = String(value);
  }
  return out;
}

function hasCookieHeader(headers = {}) {
  const cookie = headers.Cookie || headers.cookie;
  return typeof cookie === 'string' && cookie.trim().length > 0;
}

function normalizeSetCookieHeader(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  const raw = String(value || '');
  if (!raw) return undefined;
  return raw.includes('\n') ? raw.split('\n').filter(Boolean) : raw;
}

function createRustShieldClient(options = {}) {
  const endpoint = normalizeBaseUrl(options.endpoint || process.env.RUST_SHIELD_URL || 'http://rust-shield:8787');
  const enabled = Boolean(endpoint) && envFlag('RUST_SHIELD_ENABLED', false);
  const failOpen = envFlag('RUST_SHIELD_FAIL_OPEN', true);
  const cacheEnabled = envFlag('RUST_SHIELD_CACHE_ENABLED', true);
  const first = envFlag('RUST_SHIELD_FIRST', true);
  const timeoutMs = envNumber('RUST_SHIELD_NODE_TIMEOUT_MS', envNumber('RUST_SHIELD_TIMEOUT_MS', 1800, 350, 10000) + 450, 350, 12000);
  const cacheTtlMs = envNumber('RUST_SHIELD_CACHE_TTL_MS', 20 * 60 * 1000, 5000, 86_400_000);
  const staleTtlMs = envNumber('RUST_SHIELD_STALE_TTL_MS', 60 * 60 * 1000, cacheTtlMs, 172_800_000);
  const maxRedirects = envNumber('RUST_SHIELD_MAX_REDIRECTS', 8, 0, 20);
  const providerName = String(options.providerName || 'provider').toLowerCase();
  const logger = options.logger || null;

  // Critical safety default: providers protected by CF must not use reqwest as a first strike
  // before FlareSolverr/ImpIt has a real browser session. This avoids the old GuardoSerie breakage.
  const requireSessionProviders = new Set(envList('RUST_SHIELD_REQUIRE_SESSION_FOR_PROVIDERS', ['guardoserie']));
  const allowPost = envFlag('RUST_SHIELD_ALLOW_POST', false);
  const circuitEnabled = envFlag('RUST_SHIELD_ORIGIN_CIRCUIT_ENABLED', true);
  const circuitTtlMs = envNumber('RUST_SHIELD_BLOCKED_TTL_MS', 120_000, 5_000, 900_000);
  const allowSessionAfterBlock = envFlag('RUST_SHIELD_ALLOW_SESSION_AFTER_BLOCK', true);
  const warmupRequiresSession = envFlag('RUST_SHIELD_WARMUP_REQUIRES_SESSION_FOR_CF', true);
  const serviceCircuitMs = envNumber('RUST_SHIELD_SERVICE_CIRCUIT_MS', 30_000, 2_000, 300_000);
  let serviceUnavailableUntil = 0;
  const blockedOrigins = new Map();

  const client = axios.create({
    baseURL: endpoint || undefined,
    timeout: timeoutMs,
    validateStatus: status => status >= 200 && status < 600,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  function debug(message, meta = null) {
    if (logger?.debug) logger.debug(`rust ${message}`, meta);
  }

  function warn(message, meta = null) {
    if (logger?.warn) logger.warn(`rust ${message}`, meta);
  }

  function isProviderSessionRequired(name = providerName) {
    const normalized = String(name || providerName || '').toLowerCase();
    return requireSessionProviders.has(normalized) || requireSessionProviders.has('*');
  }

  function getCircuit(url) {
    if (!circuitEnabled) return null;
    const origin = originKey(url);
    if (origin === 'invalid') return null;
    const item = blockedOrigins.get(origin);
    if (!item) return null;
    if (Date.now() > item.until) {
      blockedOrigins.delete(origin);
      return null;
    }
    return item;
  }

  function noteBlocked(url, reason = 'blocked') {
    if (!circuitEnabled) return;
    const origin = originKey(url);
    if (origin === 'invalid') return;
    blockedOrigins.set(origin, { until: Date.now() + circuitTtlMs, reason: String(reason || 'blocked') });
  }

  function shouldAttempt(url, requestOptions = {}) {
    if (!enabled || !endpoint || !url) return { ok: false, reason: 'disabled' };
    if (Date.now() < serviceUnavailableUntil) return { ok: false, reason: 'service_circuit_open' };
    const method = String(requestOptions.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'HEAD'].includes(method)) return { ok: false, reason: 'unsupported_method' };
    if (method === 'POST' && !allowPost) return { ok: false, reason: 'post_disabled' };

    const headers = safeHeaderMap(requestOptions.headers || {});
    const hasCookie = hasCookieHeader(headers);
    const purpose = String(requestOptions.purpose || 'fetch');
    const sessionRequired = isProviderSessionRequired(requestOptions.providerName || providerName);

    if (sessionRequired && !hasCookie) {
      if (purpose === 'warmup' && warmupRequiresSession) return { ok: false, reason: 'session_required_for_warmup' };
      if (purpose !== 'warmup') return { ok: false, reason: 'session_required' };
    }

    const circuit = getCircuit(url);
    if (circuit && (!hasCookie || !allowSessionAfterBlock)) {
      return { ok: false, reason: `origin_circuit:${circuit.reason}` };
    }

    return { ok: true, reason: 'ok', hasCookie };
  }

  async function fetch(url, requestOptions = {}) {
    const method = String(requestOptions.method || 'GET').toUpperCase();
    const headers = safeHeaderMap(requestOptions.headers || {});
    const decision = shouldAttempt(url, { ...requestOptions, method, headers, purpose: 'fetch' });
    if (!decision.ok) {
      debug('fetch skipped', { method, url, reason: decision.reason, providerName });
      return null;
    }

    const startedAt = Date.now();
    const timeoutForRequest = Math.max(350, Math.min(
      Number(requestOptions.timeout || requestOptions.timeoutMs || timeoutMs) || timeoutMs,
      timeoutMs
    ));

    try {
      const response = await client.post('/fetch', {
        url,
        method,
        body: method === 'POST' ? (requestOptions.body || requestOptions.data || '') : null,
        headers,
        provider: requestOptions.providerName || providerName,
        cache: requestOptions.cache !== false && cacheEnabled,
        cache_ttl_ms: requestOptions.cacheTtlMs || cacheTtlMs,
        stale_ttl_ms: requestOptions.staleTtlMs || staleTtlMs,
        timeout_ms: timeoutForRequest,
        max_redirects: requestOptions.maxRedirects ?? maxRedirects
      }, {
        timeout: Math.max(timeoutForRequest + 500, timeoutMs),
        signal: requestOptions.signal || undefined
      });

      const payload = response.data || {};
      const status = Number(payload.status || response.status || 0);
      if (response.status >= 500 || payload.ok === false && !payload.body && !payload.blocked) {
        const reason = payload.blocked_reason || payload.error || `http_${response.status}`;
        if (!failOpen) throw new Error(reason);
        debug('fetch fail-open', { method, url, reason, status: response.status, ms: Date.now() - startedAt });
        return null;
      }

      if (payload.blocked || [403, 429, 503, 520, 521, 522, 523, 524].includes(status)) {
        noteBlocked(url, payload.blocked_reason || `status_${status}`);
      }

      const headersOut = payload.headers || {};
      const setCookie = normalizeSetCookieHeader(headersOut['set-cookie'] || headersOut['Set-Cookie']);
      if (setCookie) headersOut['set-cookie'] = setCookie;

      debug('fetch result', {
        method,
        url,
        status,
        cache: payload.cache,
        blocked: Boolean(payload.blocked),
        bytes: payload.bytes || 0,
        ms: Date.now() - startedAt
      });

      return {
        status,
        headers: headersOut,
        data: typeof payload.body === 'string' ? payload.body : String(payload.body || ''),
        url: payload.url || url,
        ms: Date.now() - startedAt,
        via: payload.cache && payload.cache !== 'miss' ? `rust-shield:${payload.cache}` : 'rust-shield',
        rustShield: true,
        rustCache: payload.cache || 'miss',
        rustBlocked: Boolean(payload.blocked),
        rustBlockedReason: payload.blocked_reason || null
      };
    } catch (error) {
      if (requestOptions.signal?.aborted) throw error;
      if (!failOpen) throw error;
      serviceUnavailableUntil = Date.now() + serviceCircuitMs;
      debug('fetch unavailable', { method, url, error: error?.message || String(error), code: error?.code, serviceCircuitMs, ms: Date.now() - startedAt });
      return null;
    }
  }

  async function warmup(urls = [], requestOptions = {}) {
    if (!enabled || !endpoint || !Array.isArray(urls) || !urls.length) return null;

    const headers = safeHeaderMap(requestOptions.headers || {});
    const cleanUrls = Array.from(new Set(urls.filter(Boolean).map(String)))
      .filter(url => {
        const decision = shouldAttempt(url, { ...requestOptions, headers, method: 'GET', purpose: 'warmup' });
        if (!decision.ok) debug('warmup url skipped', { url, reason: decision.reason, providerName });
        return decision.ok;
      });

    if (!cleanUrls.length) {
      return {
        ok: false,
        total: 0,
        warmed: 0,
        blocked: 0,
        skipped: urls.length,
        ms: 0,
        results: []
      };
    }

    try {
      const response = await client.post('/warmup', {
        urls: cleanUrls,
        headers,
        provider: requestOptions.providerName || providerName,
        timeout_ms: requestOptions.timeout || requestOptions.timeoutMs || envNumber('RUST_SHIELD_WARMUP_TIMEOUT_MS', 1600, 350, 10000),
        cache_ttl_ms: requestOptions.cacheTtlMs || cacheTtlMs,
        stale_ttl_ms: requestOptions.staleTtlMs || staleTtlMs,
        concurrency: requestOptions.concurrency || envNumber('RUST_SHIELD_WARMUP_CONCURRENCY', 4, 1, 16)
      }, {
        timeout: envNumber('RUST_SHIELD_WARMUP_NODE_TIMEOUT_MS', 9000, 1000, 30000),
        signal: requestOptions.signal || undefined
      });

      const payload = response.data || null;
      if (Array.isArray(payload?.results)) {
        for (const item of payload.results) {
          if (item?.blocked) noteBlocked(item.url, 'warmup_blocked');
        }
      }
      return payload;
    } catch (error) {
      if (requestOptions.signal?.aborted) throw error;
      serviceUnavailableUntil = Date.now() + serviceCircuitMs;
      warn('warmup failed', { urls: cleanUrls.length, error: error?.message || String(error), code: error?.code, serviceCircuitMs });
      return null;
    }
  }

  async function fetchBatch(requests = [], requestOptions = {}) {
    if (!enabled || !endpoint || !Array.isArray(requests) || !requests.length) return null;
    const clean = requests
      .filter(item => item?.url)
      .map(item => {
        const headers = safeHeaderMap(item.headers || requestOptions.headers || {});
        return {
          url: item.url,
          method: String(item.method || 'GET').toUpperCase(),
          body: item.body || item.data || null,
          headers,
          provider: item.provider || item.providerName || requestOptions.providerName || providerName,
          cache: item.cache !== false,
          cache_ttl_ms: item.cacheTtlMs || requestOptions.cacheTtlMs || cacheTtlMs,
          stale_ttl_ms: item.staleTtlMs || requestOptions.staleTtlMs || staleTtlMs,
          timeout_ms: item.timeoutMs || item.timeout || requestOptions.timeoutMs || timeoutMs,
          max_redirects: item.maxRedirects ?? requestOptions.maxRedirects ?? maxRedirects
        };
      })
      .filter(item => shouldAttempt(item.url, { ...item, purpose: 'fetch' }).ok)
      .slice(0, 64);
    if (!clean.length) return null;

    try {
      const response = await client.post('/fetch_batch', {
        requests: clean,
        concurrency: requestOptions.concurrency || envNumber('RUST_SHIELD_BATCH_CONCURRENCY', 6, 1, 16)
      }, {
        timeout: requestOptions.timeoutMs || envNumber('RUST_SHIELD_BATCH_NODE_TIMEOUT_MS', 12000, 1000, 30000),
        signal: requestOptions.signal || undefined
      });
      return response.data || null;
    } catch (error) {
      if (requestOptions.signal?.aborted) throw error;
      serviceUnavailableUntil = Date.now() + serviceCircuitMs;
      warn('fetch batch failed', { requests: clean.length, error: error?.message || String(error), code: error?.code, serviceCircuitMs });
      return null;
    }
  }

  async function getStats() {
    if (!enabled || !endpoint) return null;
    try {
      const response = await client.get('/stats', { timeout: envNumber('RUST_SHIELD_STATS_TIMEOUT_MS', 1200, 300, 5000) });
      return response.data || null;
    } catch (error) {
      debug('stats failed', { error: error?.message || String(error), code: error?.code });
      return null;
    }
  }

  async function clearCache(options = {}) {
    if (!enabled || !endpoint) return null;
    try {
      const response = await client.post('/cache/clear', {
        all: options.all !== false,
        cookies: options.cookies === true,
        circuits: options.circuits !== false
      }, { timeout: envNumber('RUST_SHIELD_CLEAR_TIMEOUT_MS', 1500, 300, 5000) });
      if (options.circuits !== false) blockedOrigins.clear();
      return response.data || null;
    } catch (error) {
      warn('clear cache failed', { error: error?.message || String(error), code: error?.code });
      return null;
    }
  }

  return {
    enabled,
    endpoint,
    first,
    timeoutMs,
    cacheTtlMs,
    staleTtlMs,
    fetch,
    warmup,
    fetchBatch,
    getStats,
    clearCache,
    shouldAttempt,
    noteBlocked,
    state: () => ({
      enabled,
      endpoint,
      first,
      timeoutMs,
      cacheEnabled,
      cacheTtlMs,
      staleTtlMs,
      requireSessionProviders: Array.from(requireSessionProviders),
      circuitEnabled,
      blockedOrigins: blockedOrigins.size,
      serviceCircuitOpen: Date.now() < serviceUnavailableUntil,
      serviceCircuitRemainingMs: Math.max(0, serviceUnavailableUntil - Date.now())
    })
  };
}

module.exports = {
  createRustShieldClient,
  envFlag,
  envNumber,
  normalizeBaseUrl
};
