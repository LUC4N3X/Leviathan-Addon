'use strict';

// Shared retry-timing helpers for the debrid HTTP clients (Real-Debrid + TorBox).
// Goal: exponential backoff with jitter, and honour the server `Retry-After`
// header when it is present so we stop hammering a rate-limited / overloaded API.

const ABS_MAX_DELAY_MS = 120000;

function parseRetryAfterMs(headerValue) {
  if (headerValue === undefined || headerValue === null) return 0;
  const raw = String(headerValue).trim();
  if (!raw) return 0;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), ABS_MAX_DELAY_MS);
  }

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, ABS_MAX_DELAY_MS);
  }

  return 0;
}

function computeBackoffDelay(attempt, options = {}) {
  const base = Number(options.baseMs) > 0 ? Number(options.baseMs) : 800;
  const max = Number(options.maxMs) > 0 ? Number(options.maxMs) : 15000;
  const retryAfterMs = Number(options.retryAfterMs) > 0 ? Number(options.retryAfterMs) : 0;

  // Server-provided Retry-After is authoritative; never undercut it.
  if (retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, base), ABS_MAX_DELAY_MS);
  }

  const safeAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  const exponential = Math.min(max, base * Math.pow(2, safeAttempt));
  const jitterRatio = options.jitter === false
    ? 0
    : (typeof options.jitter === 'number' ? Math.max(0, Math.min(1, options.jitter)) : 0.25);
  const jitter = exponential * jitterRatio * Math.random();
  return Math.min(ABS_MAX_DELAY_MS, Math.round(exponential + jitter));
}

module.exports = {
  parseRetryAfterMs,
  computeBackoffDelay,
  ABS_MAX_DELAY_MS
};
