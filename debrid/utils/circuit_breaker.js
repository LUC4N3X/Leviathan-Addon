'use strict';

// Lightweight keyed circuit breaker for the debrid HTTP clients.
// It trips only after a sustained run of hard failures (network errors / 5xx),
// so a real outage stops every request from paying the full retry+timeout cost
// and stops hammering the upstream API. Rate-limit (429) responses are NOT
// treated as breaker failures — those are handled by the dedicated limiter.
//
// Kill switch: DEBRID_CIRCUIT_BREAKER=0

const ENABLED = String(process.env.DEBRID_CIRCUIT_BREAKER || '1') !== '0';
const FAILURE_THRESHOLD = Math.max(3, parseInt(process.env.DEBRID_CIRCUIT_FAILURES || '8', 10) || 8);
const OPEN_MS = Math.max(2000, parseInt(process.env.DEBRID_CIRCUIT_OPEN_MS || '15000', 10) || 15000);

class CircuitBreaker {
  constructor(name) {
    this.name = name || 'debrid';
    this.state = new Map();
  }

  _entry(key) {
    const k = key || 'default';
    let entry = this.state.get(k);
    if (!entry) {
      entry = { failures: 0, openUntil: 0 };
      this.state.set(k, entry);
    }
    return entry;
  }

  canRequest(key) {
    if (!ENABLED) return true;
    const entry = this._entry(key);
    return !(entry.openUntil && Date.now() < entry.openUntil);
  }

  recordSuccess(key) {
    if (!ENABLED) return;
    const entry = this._entry(key);
    entry.failures = 0;
    entry.openUntil = 0;
  }

  recordFailure(key) {
    if (!ENABLED) return;
    const entry = this._entry(key);
    entry.failures += 1;
    if (entry.failures >= FAILURE_THRESHOLD) {
      entry.openUntil = Date.now() + OPEN_MS;
      // Half-open: after the cooldown a single failed trial re-opens immediately.
      entry.failures = FAILURE_THRESHOLD - 1;
    }
  }

  isOpen(key) {
    return !this.canRequest(key);
  }

  stats() {
    const now = Date.now();
    const out = {};
    for (const [key, entry] of this.state.entries()) {
      out[key] = {
        failures: entry.failures,
        openForMs: Math.max(0, entry.openUntil - now)
      };
    }
    return out;
  }
}

module.exports = {
  CircuitBreaker,
  _config: { ENABLED, FAILURE_THRESHOLD, OPEN_MS }
};
