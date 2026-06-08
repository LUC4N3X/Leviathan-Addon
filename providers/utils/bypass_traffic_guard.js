'use strict';

function envFlag(name, fallback = true) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function envNumber(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return 'unknown-origin';
  }
}

function normalizeUrlForCache(value, { includeQuery = true } = {}) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.hash = '';
    if (!includeQuery) parsed.search = '';
    return parsed.toString();
  } catch (_) {
    return String(value || '').trim();
  }
}

function smallHash(value) {
  const input = String(value || '');
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function defaultPolicyForKind(kind = 'site', options = {}) {
  const normalizedKind = String(kind || 'site').toLowerCase();
  const enabled = options.enabled ?? envFlag('BYPASS_TRAFFIC_GUARD_ENABLED', true);

  if (normalizedKind === 'solve') {
    return {
      enabled,
      minIntervalMs: Number.isFinite(Number(options.minIntervalMs)) ? Number(options.minIntervalMs) : envNumber('BYPASS_SOLVE_MIN_INTERVAL_MS', 2500, 0, 120000),
      maxConcurrency: Number.isFinite(Number(options.maxConcurrency)) ? Number(options.maxConcurrency) : envNumber('BYPASS_SOLVE_MAX_CONCURRENCY', 1, 1, 4),
      maxQueue: Number.isFinite(Number(options.maxQueue)) ? Number(options.maxQueue) : envNumber('BYPASS_SOLVE_MAX_QUEUE', 80, 0, 1000)
    };
  }

  if (normalizedKind === 'service') {
    return {
      enabled,
      minIntervalMs: Number.isFinite(Number(options.minIntervalMs)) ? Number(options.minIntervalMs) : envNumber('BYPASS_SERVICE_MIN_INTERVAL_MS', 500, 0, 120000),
      maxConcurrency: Number.isFinite(Number(options.maxConcurrency)) ? Number(options.maxConcurrency) : envNumber('BYPASS_SERVICE_MAX_CONCURRENCY', 2, 1, 8),
      maxQueue: Number.isFinite(Number(options.maxQueue)) ? Number(options.maxQueue) : envNumber('BYPASS_SERVICE_MAX_QUEUE', 120, 0, 1000)
    };
  }

  return {
    enabled,
    minIntervalMs: Number.isFinite(Number(options.minIntervalMs)) ? Number(options.minIntervalMs) : envNumber('BYPASS_SITE_MIN_INTERVAL_MS', 250, 0, 120000),
    maxConcurrency: Number.isFinite(Number(options.maxConcurrency)) ? Number(options.maxConcurrency) : envNumber('BYPASS_SITE_MAX_CONCURRENCY', 2, 1, 16),
    maxQueue: Number.isFinite(Number(options.maxQueue)) ? Number(options.maxQueue) : envNumber('BYPASS_SITE_MAX_QUEUE', 300, 0, 5000)
  };
}

const limiterStates = new Map();
const inflight = new Map();
const responseCache = new Map();

function getLimiterState(key) {
  const normalized = String(key || 'global');
  if (!limiterStates.has(normalized)) {
    limiterStates.set(normalized, {
      active: 0,
      queue: [],
      nextAt: 0
    });
  }
  return limiterStates.get(normalized);
}

function pumpLimiter(key, policy) {
  const state = getLimiterState(key);
  if (state.active >= policy.maxConcurrency || !state.queue.length) return;

  const now = Date.now();
  const waitMs = Math.max(0, state.nextAt - now);
  const item = state.queue.shift();

  const start = () => {
    state.active += 1;
    state.nextAt = Date.now() + policy.minIntervalMs;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        state.active -= 1;
        pumpLimiter(key, policy);
      });
  };

  if (waitMs > 0) setTimeout(start, waitMs);
  else start();
}

function runLimitedByKey(key, fn, policy, options = {}) {
  if (!policy.enabled) return Promise.resolve().then(fn);
  const state = getLimiterState(key);
  if (state.active >= policy.maxConcurrency && state.queue.length >= policy.maxQueue) {
    const error = new Error('bypass_traffic_guard_queue_overflow');
    error.code = 'BYPASS_TRAFFIC_GUARD_QUEUE_OVERFLOW';
    error.key = key;
    error.active = state.active;
    error.queued = state.queue.length;
    error.maxQueue = policy.maxQueue;
    throw error;
  }

  if (options.signal?.aborted) {
    const error = new Error('bypass_traffic_guard_aborted');
    error.code = 'BYPASS_TRAFFIC_GUARD_ABORTED';
    throw error;
  }

  return new Promise((resolve, reject) => {
    state.queue.push({ fn, resolve, reject });
    pumpLimiter(key, policy);
  });
}

function runWithBypassTrafficGuard(url, fn, options = {}) {
  if (typeof fn !== 'function') throw new Error('missing_bypass_guard_fn');
  const kind = String(options.kind || 'site').toLowerCase();
  const providerName = String(options.providerName || options.provider || 'provider').toLowerCase();
  const origin = options.originKey || normalizeOrigin(url);
  const egressKey = String(options.egressKey || options.proxy || 'default').replace(/\s+/g, '_');
  const key = `${kind}:${providerName}:${origin}:egress:${egressKey}`;
  const policy = defaultPolicyForKind(kind, options);
  return runLimitedByKey(key, fn, policy, options);
}

function pruneCache(maxEntries = envNumber('BYPASS_RESPONSE_CACHE_MAX_ENTRIES', 1500, 50, 20000)) {
  if (responseCache.size <= maxEntries) return;
  const overflow = responseCache.size - maxEntries;
  let removed = 0;
  for (const key of responseCache.keys()) {
    responseCache.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function getCachedBypassResponse(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expires > now) return { hit: true, stale: false, value: entry.value };
  if (entry.stale > now) return { hit: true, stale: true, value: entry.value };
  responseCache.delete(key);
  return null;
}

function setCachedBypassResponse(key, value, { ttlMs = 0, staleMs = 0 } = {}) {
  const ttl = Math.max(0, Number(ttlMs) || 0);
  if (!ttl) return;
  const stale = Math.max(ttl, Number(staleMs) || ttl * 2);
  responseCache.set(key, {
    value,
    expires: Date.now() + ttl,
    stale: Date.now() + stale
  });
  pruneCache();
}

function withBypassRequestCoalescing(key, fn, options = {}) {
  if (typeof fn !== 'function') throw new Error('missing_bypass_coalescing_fn');
  const enabled = options.enabled ?? envFlag('BYPASS_REQUEST_COALESCING_ENABLED', true);
  const normalizedKey = String(key || '').trim();
  if (!enabled || !normalizedKey) return Promise.resolve().then(fn);
  if (inflight.has(normalizedKey)) return inflight.get(normalizedKey);
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(normalizedKey));
  inflight.set(normalizedKey, promise);
  return promise;
}

async function withBypassResponseCache(key, fn, options = {}) {
  const ttlMs = Number(options.ttlMs || 0);
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey || ttlMs <= 0) return withBypassRequestCoalescing(normalizedKey, fn, options);

  const cached = getCachedBypassResponse(normalizedKey);
  if (cached && !cached.stale) return cached.value;
  if (cached?.stale && !inflight.has(normalizedKey)) {
    setImmediate(() => withBypassRequestCoalescing(normalizedKey, fn, options)
      .then(value => setCachedBypassResponse(normalizedKey, value, options))
      .catch(() => {}));
    return cached.value;
  }
  if (cached?.stale && inflight.has(normalizedKey)) return cached.value;

  const value = await withBypassRequestCoalescing(normalizedKey, fn, options);
  setCachedBypassResponse(normalizedKey, value, options);
  return value;
}

function makeBypassCacheKey(prefix, url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const includeQuery = options.includeQuery !== false;
  const body = options.body ?? options.data ?? '';
  const proxy = options.proxy || options.proxyUrl || options.egressKey || '';
  const vary = options.vary || '';
  return [
    prefix || 'bypass',
    method,
    normalizeUrlForCache(url, { includeQuery }),
    proxy ? `proxy:${smallHash(proxy)}` : 'proxy:none',
    body ? `body:${smallHash(body)}` : 'body:none',
    vary ? `vary:${smallHash(vary)}` : 'vary:none'
  ].join('|');
}

function getBypassTrafficGuardStats() {
  return {
    limiters: limiterStates.size,
    inflight: inflight.size,
    cached: responseCache.size
  };
}

module.exports = {
  envFlag,
  envNumber,
  normalizeOrigin,
  normalizeUrlForCache,
  makeBypassCacheKey,
  runWithBypassTrafficGuard,
  withBypassRequestCoalescing,
  withBypassResponseCache,
  getBypassTrafficGuardStats,
  sleep
};
