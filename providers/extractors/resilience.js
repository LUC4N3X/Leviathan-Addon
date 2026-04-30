'use strict';

const fs = require('fs').promises;
const path = require('path');

const NEGATIVE_CACHE = Symbol('NEGATIVE_CACHE');

function cloneValue(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch (_) {}
    }

    if (Array.isArray(value) || (value && typeof value === 'object')) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_) {}
    }

    return value;
}

class TTLCache {
    constructor({
        maxSize = 256,
        ttlMs = 60_000,
        staleTtlMs = 0,
        negativeTtlMs = null,
        cloneValues = false
    } = {}) {
        this.maxSize = Math.max(1, Number(maxSize) || 256);
        this.ttlMs = Math.max(0, Number(ttlMs) || 0);
        this.staleTtlMs = Math.max(0, Number(staleTtlMs) || 0);
        this.negativeTtlMs = Math.max(0, Number(negativeTtlMs ?? Math.max(250, this.ttlMs / 3)) || 0);
        this.cloneValues = cloneValues === true;
        this.store = new Map();
    }

    _clone(value) {
        return this.cloneValues ? cloneValue(value) : value;
    }

    _touch(key, entry) {
        this.store.delete(key);
        this.store.set(key, entry);
    }

    _prune(now = Date.now()) {
        for (const [key, entry] of this.store.entries()) {
            if ((entry?.staleUntil ?? 0) <= now) this.store.delete(key);
        }

        while (this.store.size > this.maxSize) {
            const firstKey = this.store.keys().next().value;
            if (firstKey == null) break;
            this.store.delete(firstKey);
        }
    }

    getEntry(key, { allowStale = false } = {}) {
        const entry = this.store.get(key);
        const now = Date.now();
        if (!entry) {
            this._prune(now);
            return null;
        }

        if ((entry.staleUntil ?? 0) <= now) {
            this.store.delete(key);
            return null;
        }

        this._touch(key, entry);
        this._prune(now);

        if (!allowStale && (entry.expiresAt ?? 0) <= now) return null;

        return {
            value: entry.value === NEGATIVE_CACHE ? null : this._clone(entry.value),
            expiresAt: entry.expiresAt,
            staleUntil: entry.staleUntil,
            isNegative: entry.value === NEGATIVE_CACHE,
            isStale: (entry.expiresAt ?? 0) <= now
        };
    }

    get(key, options = {}) {
        const entry = this.getEntry(key, options);
        if (!entry || entry.isNegative) return null;
        return entry.value;
    }

    getState(key) {
        const entry = this.getEntry(key, { allowStale: true });
        if (!entry) return { isFresh: false, isStale: false, value: null };
        if (entry.isNegative) return { isFresh: false, isStale: false, value: null };
        return {
            isFresh: entry.isStale !== true,
            isStale: entry.isStale === true,
            value: entry.value
        };
    }

    set(key, value, { ttlMs = this.ttlMs, staleTtlMs = this.staleTtlMs } = {}) {
        const now = Date.now();
        const entry = {
            value: this._clone(value),
            expiresAt: now + Math.max(0, Number(ttlMs) || 0),
            staleUntil: now + Math.max(0, Number(ttlMs) || 0) + Math.max(0, Number(staleTtlMs) || 0)
        };
        this._touch(key, entry);
        this._prune(now);
        return this._clone(value);
    }

    setNegative(key, { ttlMs = this.negativeTtlMs } = {}) {
        const now = Date.now();
        this._touch(key, {
            value: NEGATIVE_CACHE,
            expiresAt: now + Math.max(0, Number(ttlMs) || 0),
            staleUntil: now + Math.max(0, Number(ttlMs) || 0)
        });
        this._prune(now);
    }

    delete(key) {
        this.store.delete(key);
    }

    clear() {
        this.store.clear();
    }
}

class SingleFlight {
    constructor() {
        this.inflight = new Map();
    }

    async do(key, worker) {
        if (this.inflight.has(key)) return this.inflight.get(key);

        const promise = Promise.resolve()
            .then(() => worker())
            .finally(() => {
                if (this.inflight.get(key) === promise) this.inflight.delete(key);
            });

        this.inflight.set(key, promise);
        return promise;
    }
}

class CircuitOpenError extends Error {
    constructor(domain, remainingMs) {
        super(`Circuit open for ${domain}, retry in ${(Math.max(0, Number(remainingMs) || 0) / 1000).toFixed(1)}s`);
        this.name = 'CircuitOpenError';
        this.domain = domain;
        this.remainingMs = Math.max(0, Number(remainingMs) || 0);
    }
}

class CircuitBreaker {
    constructor({
        failureThreshold = 5,
        recoveryTimeoutMs = 30_000,
        halfOpenMaxCalls = 1
    } = {}) {
        this.failureThreshold = Math.max(1, Number(failureThreshold) || 1);
        this.recoveryTimeoutMs = Math.max(100, Number(recoveryTimeoutMs) || 100);
        this.halfOpenMaxCalls = Math.max(1, Number(halfOpenMaxCalls) || 1);
        this.states = new Map();
    }

    _state(domain) {
        if (!this.states.has(domain)) {
            this.states.set(domain, {
                state: 'CLOSED',
                consecutiveFailures: 0,
                openedAt: 0,
                generation: 0,
                halfOpenInflight: 0
            });
        }
        return this.states.get(domain);
    }

    async preRequest(domain = '__default__') {
        const state = this._state(domain);
        const now = Date.now();

        if (state.state === 'OPEN') {
            const remainingMs = state.openedAt + this.recoveryTimeoutMs - now;
            if (remainingMs > 0) throw new CircuitOpenError(domain, remainingMs);
            state.state = 'HALF_OPEN';
            state.halfOpenInflight = 0;
            state.generation += 1;
        }

        if (state.state === 'HALF_OPEN') {
            if (state.halfOpenInflight >= this.halfOpenMaxCalls) {
                throw new CircuitOpenError(domain, this.recoveryTimeoutMs);
            }
            state.halfOpenInflight += 1;
            return { domain, generation: state.generation, halfOpen: true };
        }

        return { domain, generation: state.generation, halfOpen: false };
    }

    async onSuccess(ticket) {
        const state = this._state(ticket.domain);
        if (state.generation !== ticket.generation) return;

        state.state = 'CLOSED';
        state.consecutiveFailures = 0;
        state.openedAt = 0;
        if (ticket.halfOpen) {
            state.halfOpenInflight = 0;
            state.generation += 1;
        }
    }

    async onFailure(ticket) {
        const state = this._state(ticket.domain);
        if (state.generation !== ticket.generation) return;

        const now = Date.now();
        if (ticket.halfOpen) {
            state.state = 'OPEN';
            state.openedAt = now;
            state.halfOpenInflight = 0;
            state.generation += 1;
            return;
        }

        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= this.failureThreshold) {
            state.state = 'OPEN';
            state.openedAt = now;
            state.generation += 1;
        }
    }

    async run(domain, worker) {
        const ticket = await this.preRequest(domain);
        try {
            const result = await worker(ticket);
            await this.onSuccess(ticket);
            return result;
        } catch (error) {
            await this.onFailure(ticket);
            throw error;
        }
    }
}

function getResponseStatus(result) {
    const status = result?.statusCode ?? result?.status ?? null;
    const numeric = Number(status);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function isRetryableError(error) {
    const code = String(error?.code || '').toUpperCase();
    if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'].includes(code)) {
        return true;
    }

    const status = getResponseStatus(error?.response);
    if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;

    return /timeout|socket hang up|temporar|network/i.test(String(error?.message || ''));
}

function computeBackoffDelay(attempt, {
    baseDelayMs = 350,
    maxDelayMs = 4_000,
    jitterMs = 150
} = {}) {
    const safeAttempt = Math.max(1, Number(attempt) || 1) - 1;
    const delay = Math.min(Math.max(0, Number(maxDelayMs) || 0), Math.max(0, Number(baseDelayMs) || 0) * (2 ** safeAttempt));
    return delay + (Math.random() * Math.max(0, Number(jitterMs) || 0));
}

async function resilientCall(operation, {
    attempts = 3,
    baseDelayMs = 350,
    maxDelayMs = 4_000,
    jitterMs = 150,
    retryableStatuses = [408, 425, 429, 500, 502, 503, 504],
    shouldRetry = null
} = {}) {
    const maxAttempts = Math.max(1, Number(attempts) || 1);
    const statusSet = new Set((retryableStatuses || []).map((value) => Number(value)));
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const result = await operation(attempt);
            const status = getResponseStatus(result);
            let retry = status != null && statusSet.has(status);

            if (typeof shouldRetry === 'function') {
                const decision = shouldRetry({ attempt, error: null, result, status });
                if (typeof decision === 'boolean') retry = decision;
            }

            if (!retry || attempt >= maxAttempts) return result;
        } catch (error) {
            lastError = error;
            let retry = isRetryableError(error);

            if (typeof shouldRetry === 'function') {
                const decision = shouldRetry({ attempt, error, result: null, status: getResponseStatus(error?.response) });
                if (typeof decision === 'boolean') retry = decision;
            }

            if (!retry || attempt >= maxAttempts) throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, computeBackoffDelay(attempt, {
            baseDelayMs,
            maxDelayMs,
            jitterMs
        })));
    }

    if (lastError) throw lastError;
    throw new Error('resilientCall exhausted without a result');
}

class PersistentJsonCache {
    constructor({
        file,
        ttlMs,
        staleTtlMs = 0,
        maxEntries = 512,
        saveDebounceMs = 750,
        cloneValues = true
    }) {
        this.file = file;
        this.ttlMs = Math.max(0, Number(ttlMs) || 0);
        this.staleTtlMs = Math.max(0, Number(staleTtlMs) || 0);
        this.maxEntries = Math.max(1, Number(maxEntries) || 1);
        this.saveDebounceMs = Math.max(0, Number(saveDebounceMs) || 0);
        this.cloneValues = cloneValues === true;
        this.cache = new Map();
        this.loaded = false;
        this.loading = null;
        this.saveTimer = null;
        this.pendingWrite = null;
    }

    _clone(value) {
        return this.cloneValues ? cloneValue(value) : value;
    }

    async _ensureLoaded() {
        if (this.loaded) return;
        if (this.loading) return this.loading;

        this.loading = (async () => {
            try {
                const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
                for (const [key, value] of Object.entries(raw || {})) {
                    if (!value || typeof value !== 'object') continue;
                    const timestamp = Number(value.timestamp || 0);
                    if (!timestamp) continue;

                    const payload = Object.prototype.hasOwnProperty.call(value, 'value')
                        ? value.value
                        : Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== 'timestamp'));

                    this.cache.set(key, { timestamp, value: payload });
                }
            } catch (_) {}

            this._prune();
            this.loaded = true;
            this.loading = null;
        })();

        return this.loading;
    }

    _prune(now = Date.now()) {
        for (const [key, entry] of this.cache.entries()) {
            if ((now - Number(entry?.timestamp || 0)) > (this.ttlMs + this.staleTtlMs)) {
                this.cache.delete(key);
            }
        }

        if (this.cache.size <= this.maxEntries) return;

        const ordered = [...this.cache.entries()].sort((a, b) => Number(b[1]?.timestamp || 0) - Number(a[1]?.timestamp || 0));
        this.cache = new Map(ordered.slice(0, this.maxEntries));
    }

    _scheduleSave() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.pendingWrite = this.flush().catch(() => {});
        }, this.saveDebounceMs);
    }

    async get(key) {
        await this._ensureLoaded();
        const entry = this.cache.get(key);
        if (!entry) return { data: null, isStale: false };

        const age = Date.now() - Number(entry.timestamp || 0);
        if (age <= this.ttlMs) {
            return { data: this._clone(entry.value), isStale: false };
        }

        if (age <= (this.ttlMs + this.staleTtlMs)) {
            return { data: this._clone(entry.value), isStale: true };
        }

        this.cache.delete(key);
        this._scheduleSave();
        return { data: null, isStale: false };
    }

    async set(key, value) {
        await this._ensureLoaded();
        this.cache.set(key, {
            timestamp: Date.now(),
            value: this._clone(value)
        });
        this._prune();
        this._scheduleSave();
    }

    async delete(key) {
        await this._ensureLoaded();
        this.cache.delete(key);
        this._scheduleSave();
    }

    async flush() {
        await this._ensureLoaded();
        this._prune();

        const serializable = {};
        for (const [key, entry] of this.cache.entries()) {
            serializable[key] = {
                timestamp: entry.timestamp,
                value: entry.value
            };
        }

        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, JSON.stringify(serializable), 'utf8');
    }
}

module.exports = {
    CircuitBreaker,
    CircuitOpenError,
    PersistentJsonCache,
    SingleFlight,
    TTLCache,
    computeBackoffDelay,
    getResponseStatus,
    resilientCall
};
