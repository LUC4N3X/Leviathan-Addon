'use strict';

// The Rust shield service was removed because in this single-worker deployment
// its benefits (LRU cache, single-flight, connection pool) were marginal vs
// the operational cost (extra container, extra language, extra failure mode).
// All call sites already gate on `rustShield.enabled`, so this stub keeps
// every existing surface intact while skipping the Rust path entirely.
// Re-introduce the service by restoring services/rust-shield/ and reverting
// this file.

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(?:0|false|no|off)$/i.test(String(value).trim());
}

function envNumber(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(String(process.env[name] ?? ''), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return raw;
  } catch (_) {
    return '';
  }
}

function createRustShieldClient() {
  return {
    enabled: false,
    endpoint: '',
    first: false,
    timeoutMs: 0,
    cacheTtlMs: 0,
    staleTtlMs: 0,
    async fetch() { return null; },
    async warmup() { return null; },
    state() {
      return {
        enabled: false,
        endpoint: '',
        first: false,
        timeoutMs: 0,
        cacheEnabled: false,
        cacheTtlMs: 0,
        staleTtlMs: 0
      };
    }
  };
}

module.exports = {
  createRustShieldClient,
  envFlag,
  envNumber,
  normalizeBaseUrl
};
