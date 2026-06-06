'use strict';

const DEFAULT_MAX_HOSTS = 300;
const DEFAULT_MAX_COOLDOWN_MS = 5 * 60 * 1000;

function clampNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function hostOf(url, fallback = 'unknown') {
  try {
    const parsed = new URL(String(url || ''));
    return String(parsed.hostname || fallback).toLowerCase();
  } catch (_) {
    return fallback;
  }
}

function strategyName(strategy) {
  const value = String(strategy || '').trim();
  return value || 'unknown';
}

function bodyBytes(value) {
  if (value == null) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  return Buffer.byteLength(String(value));
}

function defaultResultMeta(result) {
  if (!result || typeof result !== 'object') return {};
  const nested = result.result && typeof result.result === 'object' ? result.result : null;
  const body = result.body ?? result.response ?? result.html ?? nested?.body ?? nested?.response ?? nested?.html ?? '';
  return {
    statusCode: result.status ?? result.statusCode ?? result.solutionResponseStatus ?? nested?.status ?? nested?.statusCode ?? 0,
    bytes: bodyBytes(body)
  };
}

class ClearanceBroker {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxHosts = clampNumber(options.maxHosts, DEFAULT_MAX_HOSTS, 1, 10_000);
    this.maxCooldownMs = clampNumber(options.maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS, 0, 60 * 60 * 1000);
    this.hosts = new Map();
    this.inflight = new Map();
  }

  _now() {
    return Number(this.now()) || Date.now();
  }

  _hostKey(url, hostKey) {
    return String(hostKey || hostOf(url)).toLowerCase();
  }

  _hostState(url, hostKey) {
    const key = this._hostKey(url, hostKey);
    let state = this.hosts.get(key);
    const now = this._now();
    if (!state) {
      state = {
        host: key,
        createdAt: now,
        updatedAt: now,
        strategies: new Map()
      };
      this.hosts.set(key, state);
      this._pruneHosts();
    }
    state.updatedAt = now;
    return state;
  }

  _strategyState(url, hostKey, strategy) {
    const hostState = this._hostState(url, hostKey);
    const name = strategyName(strategy);
    let state = hostState.strategies.get(name);
    const now = this._now();
    if (!state) {
      state = {
        strategy: name,
        attempts: 0,
        hits: 0,
        sharedHits: 0,
        misses: 0,
        sharedMisses: 0,
        errors: 0,
        sharedErrors: 0,
        skips: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastAttemptAt: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
        lastSkipAt: 0,
        lastStatus: 'idle',
        lastError: '',
        lastStatusCode: 0,
        lastBytes: 0,
        createdAt: now,
        updatedAt: now
      };
      hostState.strategies.set(name, state);
    }
    state.updatedAt = now;
    return state;
  }

  _pruneHosts() {
    if (this.hosts.size <= this.maxHosts) return;
    const overflow = this.hosts.size - this.maxHosts;
    const ordered = [...this.hosts.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (let i = 0; i < overflow; i += 1) {
      this.hosts.delete(ordered[i].host);
    }
  }

  _cooldownRemaining(state, now = this._now()) {
    const remaining = Number(state.cooldownUntil || 0) - now;
    return remaining > 0 ? remaining : 0;
  }

  _coalesceKey(url, hostKey, strategy, coalesceKey) {
    return `${this._hostKey(url, hostKey)}:${strategyName(strategy)}:${String(coalesceKey || url || '')}`;
  }

  _describeResult(result, describeResult) {
    if (typeof describeResult !== 'function') return defaultResultMeta(result);
    try {
      return { ...defaultResultMeta(result), ...(describeResult(result) || {}) };
    } catch (_) {
      return defaultResultMeta(result);
    }
  }

  _cooldownFor(state, cooldownMs, maxCooldownMs) {
    const base = clampNumber(cooldownMs, 0, 0, 60 * 60 * 1000);
    if (!base) return 0;
    const max = clampNumber(maxCooldownMs, this.maxCooldownMs, 0, 60 * 60 * 1000);
    const multiplier = Math.pow(2, Math.max(0, Number(state.consecutiveFailures || 1) - 1));
    return Math.min(base * multiplier, max || base * multiplier);
  }

  _recordHit(state, meta = {}) {
    const now = this._now();
    state.hits += 1;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.lastStatus = 'hit';
    state.lastError = '';
    state.lastSuccessAt = now;
    state.lastStatusCode = Number(meta.statusCode || 0) || 0;
    state.lastBytes = Number(meta.bytes || 0) || 0;
    state.updatedAt = now;
  }

  _recordMiss(state, meta = {}, cooldownMs = 0, maxCooldownMs = undefined) {
    const now = this._now();
    state.misses += 1;
    state.consecutiveFailures += 1;
    state.lastStatus = 'miss';
    state.lastError = '';
    state.lastFailureAt = now;
    state.lastStatusCode = Number(meta.statusCode || 0) || 0;
    state.lastBytes = Number(meta.bytes || 0) || 0;
    const cooldown = this._cooldownFor(state, cooldownMs, maxCooldownMs);
    state.cooldownUntil = cooldown ? now + cooldown : 0;
    state.updatedAt = now;
  }

  _recordError(state, error, cooldownMs = 0, maxCooldownMs = undefined) {
    const now = this._now();
    state.errors += 1;
    state.consecutiveFailures += 1;
    state.lastStatus = 'error';
    state.lastError = error?.message || String(error || 'unknown_error');
    state.lastFailureAt = now;
    const cooldown = this._cooldownFor(state, cooldownMs, maxCooldownMs);
    state.cooldownUntil = cooldown ? now + cooldown : 0;
    state.updatedAt = now;
  }

  _recordSkip(state, reason) {
    const now = this._now();
    state.skips += 1;
    state.lastStatus = reason || 'skipped';
    state.lastSkipAt = now;
    state.updatedAt = now;
  }

  _recordShared(state, outcome) {
    if (outcome?.status === 'hit') state.sharedHits += 1;
    else if (outcome?.status === 'miss') state.sharedMisses += 1;
    else if (outcome?.status === 'error') state.sharedErrors += 1;
    state.updatedAt = this._now();
  }

  async run(params = {}) {
    const {
      strategy,
      url,
      hostKey,
      runner,
      isUsable,
      canRun = true,
      cooldownMs = 0,
      maxCooldownMs,
      coalesce = true,
      coalesceKey,
      describeResult
    } = params;

    if (typeof runner !== 'function') {
      throw new TypeError('clearance broker runner must be a function');
    }

    const state = this._strategyState(url, hostKey, strategy);
    if (canRun === false) {
      this._recordSkip(state, 'disabled');
      return {
        status: 'skipped',
        reason: 'disabled',
        strategy: state.strategy,
        hostKey: this._hostKey(url, hostKey),
        cooldownRemainingMs: this._cooldownRemaining(state)
      };
    }

    if (this.enabled) {
      const remaining = this._cooldownRemaining(state);
      if (remaining > 0) {
        this._recordSkip(state, 'cooldown');
        return {
          status: 'skipped',
          reason: 'cooldown',
          strategy: state.strategy,
          hostKey: this._hostKey(url, hostKey),
          cooldownRemainingMs: remaining
        };
      }
    }

    const key = this._coalesceKey(url, hostKey, strategy, coalesceKey);
    if (this.enabled && coalesce !== false && this.inflight.has(key)) {
      const outcome = await this.inflight.get(key);
      this._recordShared(state, outcome);
      return {
        ...outcome,
        shared: true
      };
    }

    state.attempts += 1;
    state.lastAttemptAt = this._now();
    state.lastStatus = 'running';
    state.updatedAt = state.lastAttemptAt;

    const execute = (async () => {
      try {
        const result = await runner();
        const usable = typeof isUsable === 'function' ? Boolean(await isUsable(result)) : Boolean(result);
        const meta = this._describeResult(result, describeResult);
        if (usable) {
          this._recordHit(state, meta);
          return {
            status: 'hit',
            strategy: state.strategy,
            hostKey: this._hostKey(url, hostKey),
            result,
            cooldownRemainingMs: 0
          };
        }
        this._recordMiss(state, meta, cooldownMs, maxCooldownMs);
        return {
          status: 'miss',
          strategy: state.strategy,
          hostKey: this._hostKey(url, hostKey),
          result,
          cooldownRemainingMs: this._cooldownRemaining(state)
        };
      } catch (error) {
        this._recordError(state, error, cooldownMs, maxCooldownMs);
        return {
          status: 'error',
          strategy: state.strategy,
          hostKey: this._hostKey(url, hostKey),
          error,
          cooldownRemainingMs: this._cooldownRemaining(state)
        };
      }
    })();

    if (this.enabled && coalesce !== false) this.inflight.set(key, execute);
    try {
      const outcome = await execute;
      return {
        ...outcome,
        shared: false
      };
    } finally {
      if (this.inflight.get(key) === execute) this.inflight.delete(key);
    }
  }

  record(url, strategy, outcome, meta = {}, hostKey = null) {
    const state = this._strategyState(url, hostKey, strategy);
    if (outcome === 'hit') this._recordHit(state, meta);
    else if (outcome === 'miss') this._recordMiss(state, meta);
    else if (outcome === 'error') this._recordError(state, meta.error || meta.message || 'error');
    else this._recordSkip(state, outcome || 'skipped');
  }

  state() {
    const now = this._now();
    const hosts = {};
    const strategies = {};

    for (const [host, hostState] of this.hosts.entries()) {
      hosts[host] = {
        createdAt: hostState.createdAt,
        updatedAt: hostState.updatedAt,
        strategies: {}
      };
      for (const [strategy, strategyState] of hostState.strategies.entries()) {
        const snapshot = {
          strategy,
          attempts: strategyState.attempts,
          hits: strategyState.hits,
          sharedHits: strategyState.sharedHits,
          misses: strategyState.misses,
          sharedMisses: strategyState.sharedMisses,
          errors: strategyState.errors,
          sharedErrors: strategyState.sharedErrors,
          skips: strategyState.skips,
          consecutiveFailures: strategyState.consecutiveFailures,
          cooldownRemainingMs: Math.max(0, Number(strategyState.cooldownUntil || 0) - now),
          lastAttemptAt: strategyState.lastAttemptAt,
          lastSuccessAt: strategyState.lastSuccessAt,
          lastFailureAt: strategyState.lastFailureAt,
          lastSkipAt: strategyState.lastSkipAt,
          lastStatus: strategyState.lastStatus,
          lastError: strategyState.lastError,
          lastStatusCode: strategyState.lastStatusCode,
          lastBytes: strategyState.lastBytes
        };
        hosts[host].strategies[strategy] = snapshot;
        if (!strategies[strategy]) {
          strategies[strategy] = {
            attempts: 0,
            hits: 0,
            sharedHits: 0,
            misses: 0,
            sharedMisses: 0,
            errors: 0,
            sharedErrors: 0,
            skips: 0
          };
        }
        strategies[strategy].attempts += snapshot.attempts;
        strategies[strategy].hits += snapshot.hits;
        strategies[strategy].sharedHits += snapshot.sharedHits;
        strategies[strategy].misses += snapshot.misses;
        strategies[strategy].sharedMisses += snapshot.sharedMisses;
        strategies[strategy].errors += snapshot.errors;
        strategies[strategy].sharedErrors += snapshot.sharedErrors;
        strategies[strategy].skips += snapshot.skips;
      }
    }

    return {
      enabled: this.enabled,
      maxHosts: this.maxHosts,
      maxCooldownMs: this.maxCooldownMs,
      inflight: this.inflight.size,
      hostCount: this.hosts.size,
      strategies,
      hosts
    };
  }
}

function createClearanceBroker(options = {}) {
  return new ClearanceBroker(options);
}

module.exports = {
  ClearanceBroker,
  createClearanceBroker,
  hostOf
};
