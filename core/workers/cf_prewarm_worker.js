'use strict';

const { cfRedisStore } = require('../../providers/utils/cf_redis_store');
const { cfTokenBridge } = require('../server/websocket_bridge');
const { DEFAULT_PROVIDER_DOMAINS } = require('../../providers/utils/provider_domain_registry');

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw == null ? '' : String(raw), 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return null;
  }
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function parseProviderList() {
  const raw = String(process.env.CF_PREWARM_PROVIDERS || '').trim();
  if (!raw) return Object.keys(DEFAULT_PROVIDER_DOMAINS);
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function resolveTargets(providerIds = []) {
  const targets = [];
  const seen = new Set();
  for (const id of providerIds) {
    const domains = DEFAULT_PROVIDER_DOMAINS[id] || [];
    for (const domain of domains) {
      const origin = normalizeOrigin(domain);
      if (!origin) continue;
      const key = `${id}:${origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ providerName: id, origin, host: hostFromUrl(origin) });
    }
  }
  return targets;
}

function createCfPrewarmWorker(options = {}) {
  const logger = options.logger || console;
  const bridge = options.bridge || cfTokenBridge;
  const store = options.store || cfRedisStore;
  const createBypass = options.createBypass
    || ((opts) => require('../../providers/utils/cloudflare_bypass').createCloudflareBypass(opts));

  const enabled = options.enabled != null ? Boolean(options.enabled) : boolEnv('CF_PREWARM_ENABLED', false);
  const intervalMs = options.intervalMs || intEnv('CF_PREWARM_INTERVAL_MS', 60_000, 10_000, 60 * 60_000);
  const leadSeconds = options.leadSeconds || intEnv('CF_PREWARM_LEAD_SECONDS', 5 * 60, 30, 60 * 60);
  const concurrency = options.concurrency || intEnv('CF_PREWARM_CONCURRENCY', 2, 1, 8);
  const ensureTimeoutMs = options.ensureTimeoutMs || intEnv('CF_PREWARM_ENSURE_TIMEOUT_MS', 30_000, 5_000, 120_000);
  const egressKey = options.egressKey || process.env.CF_PREWARM_EGRESS_KEY || 'direct';
  const sessionTtlMs = options.sessionTtlMs
    || intEnv('CF_PREWARM_SESSION_TTL_MS', store.sessionTtlSeconds * 1000, 60_000, 24 * 60 * 60_000);

  const targets = resolveTargets(options.providerIds || parseProviderList());
  const bypassByKey = new Map();

  let timer = null;
  let running = false;
  let leader = Boolean(options.leader);
  const stats = { cycles: 0, refreshed: 0, skipped: 0, failed: 0, lastCycleAt: 0, lastError: null };

  function isActive() {
    return enabled && leader && store.isEnabled();
  }

  function getBypass(target) {
    const key = `${target.providerName}:${target.origin}`;
    let instance = bypassByKey.get(key);
    if (!instance) {
      instance = createBypass({
        providerName: target.providerName,
        baseUrl: target.origin,
        initialBaseUrl: target.origin,
        logger
      });
      bypassByKey.set(key, instance);
    }
    return instance;
  }

  async function decideRefresh(target) {
    const meta = await store.getProviderSessionMeta({
      providerName: target.providerName,
      url: target.origin,
      egressKey,
      sessionTtlMs,
      leadSeconds
    });
    if (!meta.session) return { refresh: true, secondsRemaining: 0 };
    return { refresh: meta.secondsRemaining <= leadSeconds, secondsRemaining: meta.secondsRemaining };
  }

  async function warmTarget(target) {
    const decision = await decideRefresh(target);
    if (!decision.refresh) {
      stats.skipped += 1;
      return { providerName: target.providerName, origin: target.origin, action: 'skip', secondsRemaining: decision.secondsRemaining };
    }

    const bypass = getBypass(target);
    if (!bypass || typeof bypass.ensureReady !== 'function') {
      stats.skipped += 1;
      return { providerName: target.providerName, origin: target.origin, action: 'skip', reason: 'no_bypass' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ensureTimeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    try {
      const ready = await bypass.ensureReady('prewarm', {
        url: target.origin,
        force: decision.secondsRemaining <= 0,
        signal: controller.signal,
        reason: 'prewarm'
      });

      if (!ready) {
        stats.failed += 1;
        return { providerName: target.providerName, origin: target.origin, action: 'fail' };
      }

      stats.refreshed += 1;
      const meta = await store.getProviderSessionMeta({
        providerName: target.providerName,
        url: target.origin,
        egressKey,
        sessionTtlMs
      });
      bridge.publishTokenRefresh({
        providerName: target.providerName,
        host: target.host,
        egressKey,
        expiresAt: meta.expiresAt,
        source: 'cf-prewarm'
      });
      return { providerName: target.providerName, origin: target.origin, action: 'refresh', expiresAt: meta.expiresAt };
    } catch (error) {
      stats.failed += 1;
      stats.lastError = error?.message || String(error);
      return { providerName: target.providerName, origin: target.origin, action: 'error', error: stats.lastError };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function runOnce() {
    if (!isActive() || running || targets.length === 0) {
      return { ran: false, results: [] };
    }
    running = true;
    const startedAt = Date.now();
    const results = [];
    try {
      const queue = targets.slice();
      const lanes = Math.max(1, Math.min(concurrency, queue.length));
      const workers = [];
      for (let lane = 0; lane < lanes; lane += 1) {
        workers.push((async () => {
          while (queue.length) {
            const target = queue.shift();
            if (!target) break;
            try {
              results.push(await warmTarget(target));
            } catch (error) {
              stats.failed += 1;
              stats.lastError = error?.message || String(error);
              results.push({ providerName: target.providerName, origin: target.origin, action: 'error', error: stats.lastError });
            }
          }
        })());
      }
      await Promise.all(workers);
      stats.cycles += 1;
      stats.lastCycleAt = startedAt;

      const refreshed = results.filter((item) => item.action === 'refresh').length;
      const skipped = results.filter((item) => item.action === 'skip').length;
      const failed = results.filter((item) => item.action === 'fail' || item.action === 'error').length;
      if (refreshed && logger && typeof logger.info === 'function') {
        logger.info(`[CF-PREWARM] cycle done | targets=${targets.length} refreshed=${refreshed} skipped=${skipped} failed=${failed} ms=${Date.now() - startedAt}`);
      }
    } finally {
      running = false;
    }
    return { ran: true, results };
  }

  function start({ leader: isLeader = true } = {}) {
    leader = Boolean(isLeader);
    if (!enabled) {
      if (logger && typeof logger.info === 'function') {
        logger.info('[CF-PREWARM] disabled (set CF_PREWARM_ENABLED=true to activate)');
      }
      return false;
    }
    if (!leader) return false;
    if (targets.length === 0) {
      if (logger && typeof logger.warn === 'function') logger.warn('[CF-PREWARM] no targets resolved, worker idle');
      return false;
    }
    if (timer) return true;
    if (logger && typeof logger.info === 'function') {
      logger.info(`[CF-PREWARM] starting | targets=${targets.length} intervalMs=${intervalMs} leadSeconds=${leadSeconds} concurrency=${concurrency}`);
    }
    timer = setInterval(() => {
      runOnce().catch((error) => {
        if (logger && typeof logger.warn === 'function') logger.warn(`[CF-PREWARM] cycle failed: ${error?.message || error}`);
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    runOnce().catch(() => {});
    return true;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return true;
  }

  function getState() {
    return {
      enabled,
      leader,
      active: isActive(),
      running,
      intervalMs,
      leadSeconds,
      concurrency,
      egressKey,
      targets: targets.length,
      redisEnabled: store.isEnabled(),
      stats: { ...stats }
    };
  }

  return { start, stop, runOnce, getState, targets };
}

module.exports = {
  createCfPrewarmWorker,
  resolveTargets,
  parseProviderList
};
