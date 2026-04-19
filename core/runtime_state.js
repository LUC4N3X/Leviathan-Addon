'use strict';

const os = require('os');

const state = {
  bootedAt: new Date().toISOString(),
  startedAtMs: Date.now(),
  processId: process.pid,
  parentProcessId: process.ppid,
  role: process.env.LEVI_CLUSTER_HTTP ? 'worker' : 'standalone',
  cluster: {
    enabled: String(process.env.LEVI_CLUSTER_HTTP || '').toLowerCase() === '1',
    leader: String(process.env.LEVI_CLUSTER_LEADER || 'false').toLowerCase() === 'true',
    slot: Number.parseInt(process.env.LEVI_CLUSTER_SLOT || '-1', 10)
  },
  lifecycle: {
    draining: false,
    shutdownRequestedAt: null,
    shutdownReason: null,
    activeRequests: 0,
    rejectNewRequests: false
  }
};

function setClusterRole(role, extra = {}) {
  state.role = String(role || 'standalone');
  state.cluster = {
    ...state.cluster,
    ...extra,
    enabled: extra.enabled ?? state.cluster.enabled,
    leader: extra.leader ?? state.cluster.leader,
    slot: Number.isInteger(extra.slot) ? extra.slot : state.cluster.slot
  };
}

function beginRequest() {
  state.lifecycle.activeRequests += 1;
}

function endRequest() {
  state.lifecycle.activeRequests = Math.max(0, state.lifecycle.activeRequests - 1);
}

function markDraining(reason = 'shutdown', options = {}) {
  state.lifecycle.draining = true;
  state.lifecycle.shutdownRequestedAt = state.lifecycle.shutdownRequestedAt || new Date().toISOString();
  state.lifecycle.shutdownReason = String(reason || 'shutdown');
  state.lifecycle.rejectNewRequests = options.rejectNewRequests !== false;
}

function clearDraining() {
  state.lifecycle.draining = false;
  state.lifecycle.shutdownRequestedAt = null;
  state.lifecycle.shutdownReason = null;
  state.lifecycle.rejectNewRequests = false;
}

function isDraining() {
  return state.lifecycle.draining === true;
}

function shouldRejectNewRequests() {
  return state.lifecycle.rejectNewRequests === true;
}

function getSnapshot() {
  const uptimeSeconds = Math.max(0, Math.round((Date.now() - state.startedAtMs) / 1000));
  return {
    pid: state.processId,
    ppid: state.parentProcessId,
    hostname: os.hostname(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds,
    role: state.role,
    cluster: {
      enabled: Boolean(state.cluster.enabled),
      leader: Boolean(state.cluster.leader),
      slot: Number.isInteger(state.cluster.slot) ? state.cluster.slot : null
    },
    lifecycle: {
      draining: Boolean(state.lifecycle.draining),
      shutdownRequestedAt: state.lifecycle.shutdownRequestedAt,
      shutdownReason: state.lifecycle.shutdownReason,
      activeRequests: state.lifecycle.activeRequests,
      rejectNewRequests: Boolean(state.lifecycle.rejectNewRequests)
    },
    memory: {
      rss: process.memoryUsage().rss,
      heapTotal: process.memoryUsage().heapTotal,
      heapUsed: process.memoryUsage().heapUsed,
      external: process.memoryUsage().external,
      arrayBuffers: process.memoryUsage().arrayBuffers
    },
    load: typeof os.loadavg === 'function' ? os.loadavg() : [0, 0, 0],
    cpuCount: Array.isArray(os.cpus()) ? os.cpus().length : 1,
    bootedAt: state.bootedAt
  };
}

module.exports = {
  setClusterRole,
  beginRequest,
  endRequest,
  markDraining,
  clearDraining,
  isDraining,
  shouldRejectNewRequests,
  getSnapshot
};
