'use strict';

const os = require('os');

const BOOTED_AT_MS = Date.now();
const BOOTED_AT_NS = process.hrtime.bigint();
const BOOTED_AT_ISO = new Date(BOOTED_AT_MS).toISOString();

function nowIso() {
  return new Date().toISOString();
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;

  const normalized = String(value ?? '').trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;

  return fallback;
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function getMonotonicUptimeMs() {
  const elapsedNs = process.hrtime.bigint() - BOOTED_AT_NS;
  return Math.max(0, Math.round(Number(elapsedNs) / 1_000_000));
}

function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase();

  if (!normalized) return 'standalone';

  return normalized;
}

const state = {
  bootedAt: BOOTED_AT_ISO,
  startedAtMs: BOOTED_AT_MS,
  processId: process.pid,
  parentProcessId: process.ppid,

  role: parseBoolean(process.env.LEVI_CLUSTER_HTTP, false) ? 'worker' : 'standalone',

  cluster: {
    enabled: parseBoolean(process.env.LEVI_CLUSTER_HTTP, false),
    leader: parseBoolean(process.env.LEVI_CLUSTER_LEADER, false),
    slot: parseInteger(process.env.LEVI_CLUSTER_SLOT, -1)
  },

  lifecycle: {
    draining: false,
    shutdownRequestedAt: null,
    shutdownReason: null,
    activeRequests: 0,
    rejectNewRequests: false,

    ready: false,
    readyAt: null,
    readinessReason: 'starting',

    lastTransitionAt: BOOTED_AT_ISO,
    lastTransition: 'boot',
    lastTransitionReason: 'process_started'
  },

  metrics: {
    totalRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    rejectedRequests: 0,
    lastRequestStartedAt: null,
    lastRequestEndedAt: null
  }
};

function setTransition(name, reason) {
  state.lifecycle.lastTransitionAt = nowIso();
  state.lifecycle.lastTransition = String(name || 'unknown');
  state.lifecycle.lastTransitionReason = String(reason || name || 'unknown');
}

function setClusterRole(role, extra = {}) {
  state.role = normalizeRole(role);

  if (Object.prototype.hasOwnProperty.call(extra, 'enabled')) {
    state.cluster.enabled = parseBoolean(extra.enabled, state.cluster.enabled);
  }

  if (Object.prototype.hasOwnProperty.call(extra, 'leader')) {
    state.cluster.leader = parseBoolean(extra.leader, state.cluster.leader);
  }

  if (Object.prototype.hasOwnProperty.call(extra, 'slot')) {
    state.cluster.slot = parseInteger(extra.slot, state.cluster.slot);
  }

  setTransition('cluster_role_updated', state.role);
}

function beginRequest() {
  state.lifecycle.activeRequests += 1;
  state.metrics.totalRequests += 1;
  state.metrics.lastRequestStartedAt = nowIso();

  return state.lifecycle.activeRequests;
}

function tryBeginRequest() {
  if (shouldRejectNewRequests()) {
    state.metrics.rejectedRequests += 1;
    return false;
  }

  beginRequest();
  return true;
}

function endRequest(options = {}) {
  if (state.lifecycle.activeRequests <= 0) {
    state.lifecycle.activeRequests = 0;
    return 0;
  }

  state.lifecycle.activeRequests -= 1;
  state.metrics.lastRequestEndedAt = nowIso();

  if (options.failed === true) {
    state.metrics.failedRequests += 1;
  } else {
    state.metrics.completedRequests += 1;
  }

  return state.lifecycle.activeRequests;
}

function markRejectedRequest() {
  state.metrics.rejectedRequests += 1;
}

function markDraining(reason = 'shutdown', options = {}) {
  const normalizedReason = String(reason || 'shutdown');

  state.lifecycle.draining = true;
  state.lifecycle.shutdownRequestedAt = state.lifecycle.shutdownRequestedAt || nowIso();
  state.lifecycle.shutdownReason = normalizedReason;
  state.lifecycle.rejectNewRequests = options.rejectNewRequests !== false;

  state.lifecycle.ready = false;
  state.lifecycle.readyAt = null;
  state.lifecycle.readinessReason = normalizedReason;

  setTransition('draining', normalizedReason);
}

function clearDraining(reason = 'drain_cleared') {
  state.lifecycle.draining = false;
  state.lifecycle.shutdownRequestedAt = null;
  state.lifecycle.shutdownReason = null;
  state.lifecycle.rejectNewRequests = false;

  setTransition('drain_cleared', reason);
}

function markReady(reason = 'ready') {
  const normalizedReason = String(reason || 'ready');

  state.lifecycle.ready = true;
  state.lifecycle.readyAt = nowIso();
  state.lifecycle.readinessReason = normalizedReason;

  setTransition('ready', normalizedReason);
}

function markNotReady(reason = 'starting') {
  const normalizedReason = String(reason || 'starting');

  state.lifecycle.ready = false;
  state.lifecycle.readyAt = null;
  state.lifecycle.readinessReason = normalizedReason;

  setTransition('not_ready', normalizedReason);
}

function isReady() {
  return state.lifecycle.ready === true;
}

function isDraining() {
  return state.lifecycle.draining === true;
}

function shouldRejectNewRequests() {
  return state.lifecycle.rejectNewRequests === true;
}

function canAcceptRequests() {
  return isReady() && !isDraining() && !shouldRejectNewRequests();
}

function getSnapshot() {
  const memory = process.memoryUsage();
  const load = typeof os.loadavg === 'function' ? os.loadavg() : [0, 0, 0];
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 1;
  const uptimeMs = getMonotonicUptimeMs();
  const uptimeSeconds = Math.floor(uptimeMs / 1000);

  const resourceUsage = typeof process.resourceUsage === 'function'
    ? process.resourceUsage()
    : null;

  return {
    pid: state.processId,
    ppid: state.parentProcessId,
    hostname: os.hostname(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,

    bootedAt: state.bootedAt,
    uptimeMs,
    uptimeSeconds,

    role: state.role,

    cluster: {
      enabled: Boolean(state.cluster.enabled),
      leader: Boolean(state.cluster.leader),
      slot: Number.isInteger(state.cluster.slot) && state.cluster.slot >= 0
        ? state.cluster.slot
        : null
    },

    lifecycle: {
      draining: Boolean(state.lifecycle.draining),
      shutdownRequestedAt: state.lifecycle.shutdownRequestedAt,
      shutdownReason: state.lifecycle.shutdownReason,
      activeRequests: state.lifecycle.activeRequests,
      rejectNewRequests: Boolean(state.lifecycle.rejectNewRequests),

      ready: Boolean(state.lifecycle.ready),
      readyAt: state.lifecycle.readyAt,
      readinessReason: state.lifecycle.readinessReason,

      canAcceptRequests: canAcceptRequests(),

      lastTransitionAt: state.lifecycle.lastTransitionAt,
      lastTransition: state.lifecycle.lastTransition,
      lastTransitionReason: state.lifecycle.lastTransitionReason
    },

    metrics: {
      totalRequests: state.metrics.totalRequests,
      completedRequests: state.metrics.completedRequests,
      failedRequests: state.metrics.failedRequests,
      rejectedRequests: state.metrics.rejectedRequests,
      lastRequestStartedAt: state.metrics.lastRequestStartedAt,
      lastRequestEndedAt: state.metrics.lastRequestEndedAt
    },

    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers
    },

    system: {
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      load,
      cpuCount,
      loadRatio1m: cpuCount > 0 ? Number((load[0] / cpuCount).toFixed(3)) : 0
    },

    resourceUsage
  };
}

module.exports = {
  setClusterRole,

  beginRequest,
  tryBeginRequest,
  endRequest,
  markRejectedRequest,

  markDraining,
  clearDraining,

  markReady,
  markNotReady,

  isDraining,
  isReady,
  shouldRejectNewRequests,
  canAcceptRequests,

  getSnapshot
};
