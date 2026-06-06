'use strict';

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
