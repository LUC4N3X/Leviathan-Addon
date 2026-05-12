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
  const providerName = options.providerName || 'provider';
  const logger = options.logger || null;
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

  async function fetch(url, requestOptions = {}) {
    if (!enabled || !endpoint || !url) return null;
    const method = String(requestOptions.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'HEAD'].includes(method)) return null;

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
        headers: safeHeaderMap(requestOptions.headers || {}),
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
      if (response.status >= 500 || payload.ok === false && !payload.body) {
        const reason = payload.blocked_reason || payload.error || `http_${response.status}`;
        if (!failOpen) throw new Error(reason);
        debug('fetch fail-open', { method, url, reason, status: response.status, ms: Date.now() - startedAt });
        return null;
      }

      const headers = payload.headers || {};
      const setCookie = normalizeSetCookieHeader(headers['set-cookie'] || headers['Set-Cookie']);
      if (setCookie) headers['set-cookie'] = setCookie;

      debug('fetch result', {
        method,
        url,
        status: payload.status || response.status,
        cache: payload.cache,
        blocked: Boolean(payload.blocked),
        bytes: payload.bytes || 0,
        ms: Date.now() - startedAt
      });

      return {
        status: Number(payload.status || response.status || 0),
        headers,
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
      debug('fetch unavailable', { method, url, error: error?.message || String(error), code: error?.code, ms: Date.now() - startedAt });
      return null;
    }
  }

  async function warmup(urls = [], requestOptions = {}) {
    if (!enabled || !endpoint || !Array.isArray(urls) || !urls.length) return null;
    try {
      const response = await client.post('/warmup', {
        urls: urls.filter(Boolean),
        headers: safeHeaderMap(requestOptions.headers || {}),
        provider: requestOptions.providerName || providerName,
        timeout_ms: requestOptions.timeout || requestOptions.timeoutMs || envNumber('RUST_SHIELD_WARMUP_TIMEOUT_MS', 1600, 350, 10000),
        cache_ttl_ms: requestOptions.cacheTtlMs || cacheTtlMs,
        stale_ttl_ms: requestOptions.staleTtlMs || staleTtlMs,
        concurrency: requestOptions.concurrency || envNumber('RUST_SHIELD_WARMUP_CONCURRENCY', 4, 1, 16)
      }, {
        timeout: envNumber('RUST_SHIELD_WARMUP_NODE_TIMEOUT_MS', 9000, 1000, 30000),
        signal: requestOptions.signal || undefined
      });
      return response.data || null;
    } catch (error) {
      if (requestOptions.signal?.aborted) throw error;
      warn('warmup failed', { urls: urls.length, error: error?.message || String(error), code: error?.code });
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
    state: () => ({ enabled, endpoint, first, timeoutMs, cacheEnabled, cacheTtlMs, staleTtlMs })
  };
}

module.exports = {
  createRustShieldClient,
  envFlag,
  envNumber,
  normalizeBaseUrl
};
