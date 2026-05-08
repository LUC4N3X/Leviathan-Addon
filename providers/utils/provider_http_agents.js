'use strict';

const http = require('http');
const https = require('https');

const pools = new Map();

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeAgentOptions(options = {}) {
  return {
    keepAlive: options.keepAlive !== false,
    maxSockets: positiveInt(options.maxSockets, 250, 1, 1000),
    maxFreeSockets: positiveInt(options.maxFreeSockets, 100, 1, 500),
    timeout: positiveInt(options.timeout ?? options.agentTimeoutMs, 30_000, 1000, 120_000),
    keepAliveMsecs: positiveInt(options.keepAliveMsecs, 30_000, 1000, 120_000)
  };
}

function stableKey(protocol, options) {
  return `${protocol}:${options.keepAlive ? 1 : 0}:${options.maxSockets}:${options.maxFreeSockets}:${options.timeout}:${options.keepAliveMsecs}`;
}

function getSharedHttpAgent(protocol = 'http', options = {}) {
  const normalized = normalizeAgentOptions(options);
  const cleanProtocol = String(protocol || 'http').replace(/:$/, '').toLowerCase() === 'https' ? 'https' : 'http';
  const key = stableKey(cleanProtocol, normalized);
  if (pools.has(key)) return pools.get(key);

  const Agent = cleanProtocol === 'https' ? https.Agent : http.Agent;
  const agent = new Agent(normalized);
  pools.set(key, agent);
  return agent;
}

function getSharedHttpAgents(options = {}) {
  return {
    httpAgent: getSharedHttpAgent('http', options),
    httpsAgent: getSharedHttpAgent('https', options)
  };
}

module.exports = {
  getSharedHttpAgent,
  getSharedHttpAgents,
  normalizeAgentOptions
};
