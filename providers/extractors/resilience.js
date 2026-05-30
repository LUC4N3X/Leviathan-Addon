'use strict';

const fs = require('fs').promises;
const path = require('path');

const NEGATIVE_CACHE = Symbol('NEGATIVE_CACHE');
const DEFAULT_RETRYABLE_STATUSES = Object.freeze([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRYABLE_CODES = Object.freeze([
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET'
]);

function nowMs() {
    return Date.now();
}

function toPositiveNumber(value, fallback, min = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return Math.max(min, Number(fallback) || 0);
    return Math.max(min, numeric);
}

function cloneValue(value) {
    if (value == null || typeof value !== 'object') return value;

    if (Buffer.isBuffer(value)) return Buffer.from(value);

    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch (_) {}
    }

    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value) || (value && typeof value === 'object')) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_) {}
    }

    return value;
}

function createDeferredTimeout(ms, onTimeout) {
    const timeoutMs = Math.max(0, Number(ms) || 0);
    if (!timeoutMs) return null;

    const timer = setTimeout(onTimeout, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

function sleep(ms, signal = null) {
    const delay = Math.max(0, Number(ms) || 0);
    if (!delay) return Promise.resolve();

    if (signal?.aborted) {
        return Promise.reject(signal.reason || new Error('Operation aborted'));
    }

    return new Promise((resolve, reject) => {
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
        };

        const onAbort = () => {
            cleanup();
            reject(signal.reason || new Error('Operation aborted'));
        };

        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();

        if (signal?.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
    });
}

class TTLCache {
    constructor({
        maxSize = 256,
        ttlMs = 60_000,
        staleTtlMs = 0,
        negativeTtlMs = null,
        cloneValues = false,
        onEvict = null,
        pruneIntervalMs = 0
    } = {}) {
        this.maxSize = Math.max(1, Number(maxSize) || 256);
        this.ttlMs = toPositiveNumber(ttlMs, 0);
        this.staleTtlMs = toPositiveNumber(staleTtlMs, 0);
        this.negativeTtlMs = toPositiveNumber(negativeTtlMs ?? Math.max(250, this.ttlMs / 3), 0);
        this.cloneValues = cloneValues === true;
        this.onEvict = typeof onEvict === 'function' ? onEvict : null;
        this.pruneIntervalMs = toPositiveNumber(pruneIntervalMs, 0);
        this.lastPruneAt = 0;
        this.store = new Map();
        this.stats = {
            hits: 0,
            misses: 0,
            staleHits: 0,
            negativeHits: 0,
            sets: 0,
            deletes: 0,
            evictions: 0
        };
    }

    get size() {
        this._prune();
        return this.store.size;
    }

    _clone(value) {
        return this.cloneValues ? cloneValue(value) : value;
    }

    _emitEvict(key, entry, reason) {
        this.stats.evictions += 1;
        if (!this.onEvict) return;

        try {
            this.onEvict(key, entry?.value === NEGATIVE_CACHE ? null : this._clone(entry?.value), reason);
        } catch (_) {}
    }

    _deleteEntry(key, reason = 'delete') {
        const entry = this.store.get(key);
        if (!this.store.delete(key)) return false;
        if (reason !== 'delete') this._emitEvict(key, entry, reason);
        else this.stats.deletes += 1;
        return true;
    }

    _touch(key, entry) {
        this.store.delete(key);
        this.store.set(key, entry);
    }

    _shouldPrune(now) {
        return !this.pruneIntervalMs || (now - this.lastPruneAt) >= this.pruneIntervalMs || this.store.size > this.maxSize;
    }

    _prune(now = nowMs(), { force = false } = {}) {
        if (!force && !this._shouldPrune(now)) return;
        this.lastPruneAt = now;

        for (const [key, entry] of this.store.entries()) {
            if ((entry?.staleUntil ?? 0) <= now) this._deleteEntry(key, 'expired');
        }

        while (this.store.size > this.maxSize) {
            const firstKey = this.store.keys().next().value;
            if (firstKey == null) break;
            this._deleteEntry(firstKey, 'capacity');
        }
    }

    getEntry(key, { allowStale = false, touch = true } = {}) {
        const entry = this.store.get(key);
        const now = nowMs();
        if (!entry) {
            this.stats.misses += 1;
            this._prune(now);
            return null;
        }

        if ((entry.staleUntil ?? 0) <= now) {
            this._deleteEntry(key, 'expired');
            this.stats.misses += 1;
            return null;
        }

        if (touch) this._touch(key, entry);
        this._prune(now);

        const isStale = (entry.expiresAt ?? 0) <= now;
        const isNegative = entry.value === NEGATIVE_CACHE;

        if (!allowStale && isStale) {
            this.stats.misses += 1;
            return null;
        }

        if (isNegative) this.stats.negativeHits += 1;
        else if (isStale) this.stats.staleHits += 1;
        else this.stats.hits += 1;

        return {
            value: isNegative ? null : this._clone(entry.value),
            expiresAt: entry.expiresAt,
            staleUntil: entry.staleUntil,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            isNegative,
            isStale,
            ageMs: Math.max(0, now - Number(entry.updatedAt || entry.createdAt || now)),
            ttlRemainingMs: Math.max(0, Number(entry.expiresAt || 0) - now),
            staleRemainingMs: Math.max(0, Number(entry.staleUntil || 0) - now)
        };
    }

    get(key, options = {}) {
        const entry = this.getEntry(key, options);
        if (!entry || entry.isNegative) return null;
        return entry.value;
    }

    getMany(keys, options = {}) {
        const output = new Map();
        for (const key of keys || []) output.set(key, this.get(key, options));
        return output;
    }

    getState(key) {
        const entry = this.getEntry(key, { allowStale: true });
        if (!entry) return { isFresh: false, isStale: false, value: null };
        if (entry.isNegative) return { isFresh: false, isStale: false, value: null };
        return {
            isFresh: entry.isStale !== true,
            isStale: entry.isStale === true,
            value: entry.value,
            ttlRemainingMs: entry.ttlRemainingMs,
            staleRemainingMs: entry.staleRemainingMs
        };
    }

    has(key, options = {}) {
        const entry = this.getEntry(key, { ...options, touch: false });
        return Boolean(entry && !entry.isNegative);
    }

    set(key, value, { ttlMs = this.ttlMs, staleTtlMs = this.staleTtlMs } = {}) {
        const now = nowMs();
        const freshTtl = toPositiveNumber(ttlMs, 0);
        const staleTtl = toPositiveNumber(staleTtlMs, 0);
        const previous = this.store.get(key);
        const entry = {
            value: this._clone(value),
            createdAt: previous?.createdAt || now,
            updatedAt: now,
            expiresAt: now + freshTtl,
            staleUntil: now + freshTtl + staleTtl
        };
        this._touch(key, entry);
        this.stats.sets += 1;
        this._prune(now, { force: true });
        return this._clone(value);
    }

    setMany(entries, options = {}) {
        if (entries instanceof Map) {
            for (const [key, value] of entries.entries()) this.set(key, value, options);
            return;
        }

        for (const [key, value] of Object.entries(entries || {})) this.set(key, value, options);
    }

    setNegative(key, { ttlMs = this.negativeTtlMs } = {}) {
        const now = nowMs();
        const ttl = toPositiveNumber(ttlMs, 0);
        this._touch(key, {
            value: NEGATIVE_CACHE,
            createdAt: now,
            updatedAt: now,
            expiresAt: now + ttl,
            staleUntil: now + ttl
        });
        this.stats.sets += 1;
        this._prune(now, { force: true });
    }

    delete(key) {
        return this._deleteEntry(key, 'delete');
    }

    deletePrefix(prefix) {
        const needle = String(prefix || '');
        if (!needle) return 0;

        let count = 0;
        for (const key of [...this.store.keys()]) {
            if (String(key).startsWith(needle) && this.delete(key)) count += 1;
        }
        return count;
    }

    keys({ includeExpired = false } = {}) {
        if (!includeExpired) this._prune(nowMs(), { force: true });
        return [...this.store.keys()];
    }

    values({ allowStale = false } = {}) {
        return this.keys().map((key) => this.get(key, { allowStale })).filter((value) => value != null);
    }

    clear() {
        const count = this.store.size;
        this.store.clear();
        this.stats.deletes += count;
    }

    snapshot() {
        this._prune(nowMs(), { force: true });
        return [...this.store.entries()].map(([key, entry]) => ({
            key,
            value: entry.value === NEGATIVE_CACHE ? null : this._clone(entry.value),
            isNegative: entry.value === NEGATIVE_CACHE,
            expiresAt: entry.expiresAt,
            staleUntil: entry.staleUntil,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
        }));
    }

    getStats() {
        this._prune(nowMs());
        return {
            ...this.stats,
            size: this.store.size,
            maxSize: this.maxSize
        };
    }
}

class SingleFlight {
    constructor({ cloneValues = false } = {}) {
        this.cloneValues = cloneValues === true;
        this.inflight = new Map();
        this.stats = {
            started: 0,
            joined: 0,
            resolved: 0,
            rejected: 0
        };
    }

    get size() {
        return this.inflight.size;
    }

    async do(key, worker) {
        if (this.inflight.has(key)) {
            this.stats.joined += 1;
            const result = await this.inflight.get(key);
            return this.cloneValues ? cloneValue(result) : result;
        }

        this.stats.started += 1;
        const promise = Promise.resolve()
            .then(() => worker())
            .then((result) => {
                this.stats.resolved += 1;
                return result;
            })
            .catch((error) => {
                this.stats.rejected += 1;
                throw error;
            })
            .finally(() => {
                if (this.inflight.get(key) === promise) this.inflight.delete(key);
            });

        this.inflight.set(key, promise);
        const result = await promise;
        return this.cloneValues ? cloneValue(result) : result;
    }

    forget(key) {
        return this.inflight.delete(key);
    }

    clear() {
        this.inflight.clear();
    }

    getStats() {
        return {
            ...this.stats,
            inflight: this.inflight.size
        };
    }
}

class CircuitOpenError extends Error {
    constructor(domain, remainingMs) {
        super(`Circuit open for ${domain}, retry in ${(Math.max(0, Number(remainingMs) || 0) / 1000).toFixed(1)}s`);
        this.name = 'CircuitOpenError';
        this.domain = domain;
        this.remainingMs = Math.max(0, Number(remainingMs) || 0);
        this.retryAfterMs = this.remainingMs;
    }
}

class CircuitBreaker {
    constructor({
        failureThreshold = 5,
        recoveryTimeoutMs = 30_000,
        halfOpenMaxCalls = 1,
        successThreshold = 1,
        failureWindowMs = 0,
        shouldTrip = null
    } = {}) {
        this.failureThreshold = Math.max(1, Number(failureThreshold) || 1);
        this.recoveryTimeoutMs = Math.max(100, Number(recoveryTimeoutMs) || 100);
        this.halfOpenMaxCalls = Math.max(1, Number(halfOpenMaxCalls) || 1);
        this.successThreshold = Math.max(1, Number(successThreshold) || 1);
        this.failureWindowMs = Math.max(0, Number(failureWindowMs) || 0);
        this.shouldTrip = typeof shouldTrip === 'function' ? shouldTrip : null;
        this.states = new Map();
    }

    _state(domain) {
        if (!this.states.has(domain)) {
            this.states.set(domain, {
                state: 'CLOSED',
                consecutiveFailures: 0,
                consecutiveSuccesses: 0,
                openedAt: 0,
                lastFailureAt: 0,
                generation: 0,
                halfOpenInflight: 0,
                totalSuccesses: 0,
                totalFailures: 0,
                totalRejected: 0
            });
        }
        return this.states.get(domain);
    }

    _withinFailureWindow(state, now) {
        if (!this.failureWindowMs) return true;
        return !state.lastFailureAt || (now - state.lastFailureAt) <= this.failureWindowMs;
    }

    async preRequest(domain = '__default__') {
        const state = this._state(domain);
        const now = nowMs();

        if (state.state === 'OPEN') {
            const remainingMs = state.openedAt + this.recoveryTimeoutMs - now;
            if (remainingMs > 0) {
                state.totalRejected += 1;
                throw new CircuitOpenError(domain, remainingMs);
            }
            state.state = 'HALF_OPEN';
            state.halfOpenInflight = 0;
            state.consecutiveSuccesses = 0;
            state.generation += 1;
        }

        if (state.state === 'HALF_OPEN') {
            if (state.halfOpenInflight >= this.halfOpenMaxCalls) {
                state.totalRejected += 1;
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

        state.totalSuccesses += 1;
        state.consecutiveFailures = 0;

        if (ticket.halfOpen) {
            state.halfOpenInflight = Math.max(0, state.halfOpenInflight - 1);
            state.consecutiveSuccesses += 1;
            if (state.consecutiveSuccesses >= this.successThreshold) {
                state.state = 'CLOSED';
                state.openedAt = 0;
                state.consecutiveSuccesses = 0;
                state.generation += 1;
            }
            return;
        }

        state.state = 'CLOSED';
        state.openedAt = 0;
        state.consecutiveSuccesses = 0;
    }

    async onFailure(ticket, error = null) {
        const state = this._state(ticket.domain);
        if (state.generation !== ticket.generation) return;

        const now = nowMs();
        state.totalFailures += 1;
        state.lastFailureAt = now;

        if (ticket.halfOpen) {
            state.state = 'OPEN';
            state.openedAt = now;
            state.halfOpenInflight = Math.max(0, state.halfOpenInflight - 1);
            state.consecutiveSuccesses = 0;
            state.generation += 1;
            return;
        }

        if (!this._withinFailureWindow(state, now)) state.consecutiveFailures = 0;
        state.consecutiveFailures += 1;

        const shouldTrip = this.shouldTrip
            ? this.shouldTrip({ domain: ticket.domain, error, state: { ...state } }) !== false
            : true;

        if (shouldTrip && state.consecutiveFailures >= this.failureThreshold) {
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
            await this.onFailure(ticket, error);
            throw error;
        }
    }

    reset(domain = null) {
        if (domain == null) {
            this.states.clear();
            return;
        }
        this.states.delete(domain);
    }

    getState(domain = '__default__') {
        const state = this._state(domain);
        const now = nowMs();
        const remainingMs = state.state === 'OPEN'
            ? Math.max(0, state.openedAt + this.recoveryTimeoutMs - now)
            : 0;
        return {
            ...state,
            remainingMs
        };
    }

    getStats() {
        const output = {};
        for (const domain of this.states.keys()) output[domain] = this.getState(domain);
        return output;
    }
}

function getResponseStatus(result) {
    const status = result?.statusCode ?? result?.status ?? result?.response?.status ?? null;
    const numeric = Number(status);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getRetryAfterMs(source, maxRetryAfterMs = 30_000) {
    const headers = source?.headers || source?.response?.headers || null;
    if (!headers) return null;

    const retryAfter = headers['retry-after'] || headers['Retry-After'] || headers.retryAfter;
    if (retryAfter == null) return null;

    const numericSeconds = Number(retryAfter);
    if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
        return Math.min(Number(maxRetryAfterMs) || 30_000, numericSeconds * 1000);
    }

    const retryAt = Date.parse(String(retryAfter));
    if (Number.isFinite(retryAt)) {
        return Math.min(Number(maxRetryAfterMs) || 30_000, Math.max(0, retryAt - nowMs()));
    }

    return null;
}

function isRetryableError(error) {
    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    if (DEFAULT_RETRYABLE_CODES.includes(code)) return true;

    const status = getResponseStatus(error?.response || error);
    if (DEFAULT_RETRYABLE_STATUSES.includes(status)) return true;

    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;

    return /timeout|socket hang up|temporar|network|aborted|reset/i.test(String(error?.message || ''));
}

function computeBackoffDelay(attempt, {
    baseDelayMs = 350,
    maxDelayMs = 4_000,
    jitterMs = 150,
    jitterRatio = null
} = {}) {
    const safeAttempt = Math.max(1, Number(attempt) || 1) - 1;
    const base = toPositiveNumber(baseDelayMs, 350);
    const max = toPositiveNumber(maxDelayMs, 4_000);
    const exponential = Math.min(max, base * (2 ** safeAttempt));

    const jitter = jitterRatio != null
        ? exponential * Math.max(0, Number(jitterRatio) || 0)
        : toPositiveNumber(jitterMs, 150);

    return Math.max(0, exponential + (Math.random() * jitter));
}

async function runWithOptionalTimeout(operation, attempt, context, timeoutMs) {
    const safeTimeout = Math.max(0, Number(timeoutMs) || 0);
    if (!safeTimeout) return operation(attempt, context);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;

    const timeoutPromise = new Promise((_, reject) => {
        timer = createDeferredTimeout(safeTimeout, () => {
            if (controller) controller.abort(new Error(`Operation timed out after ${safeTimeout}ms`));
            const error = new Error(`Operation timed out after ${safeTimeout}ms`);
            error.name = 'TimeoutError';
            error.code = 'ETIMEDOUT';
            reject(error);
        });
    });

    try {
        return await Promise.race([
            operation(attempt, { ...context, signal: controller?.signal || context.signal || null }),
            timeoutPromise
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function resilientCall(operation, {
    attempts = 3,
    baseDelayMs = 350,
    maxDelayMs = 4_000,
    jitterMs = 150,
    jitterRatio = null,
    retryableStatuses = DEFAULT_RETRYABLE_STATUSES,
    shouldRetry = null,
    onRetry = null,
    signal = null,
    perAttemptTimeoutMs = 0,
    maxRetryAfterMs = 30_000
} = {}) {
    const maxAttempts = Math.max(1, Number(attempts) || 1);
    const statusSet = new Set((retryableStatuses || []).map((value) => Number(value)));
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (signal?.aborted) throw signal.reason || new Error('Operation aborted');

        let result = null;
        let error = null;
        let status = null;
        let retry = false;

        try {
            result = await runWithOptionalTimeout(operation, attempt, { signal }, perAttemptTimeoutMs);
            status = getResponseStatus(result);
            retry = status != null && statusSet.has(status);
        } catch (caught) {
            error = caught;
            lastError = caught;
            status = getResponseStatus(caught?.response || caught);
            retry = isRetryableError(caught);
        }

        if (typeof shouldRetry === 'function') {
            const decision = shouldRetry({ attempt, error, result, status, attempts: maxAttempts });
            if (typeof decision === 'boolean') retry = decision;
        }

        if (!retry || attempt >= maxAttempts) {
            if (error) throw error;
            return result;
        }

        const retryAfterMs = getRetryAfterMs(error?.response || error || result, maxRetryAfterMs);
        const delayMs = retryAfterMs ?? computeBackoffDelay(attempt, {
            baseDelayMs,
            maxDelayMs,
            jitterMs,
            jitterRatio
        });

        if (typeof onRetry === 'function') {
            try {
                onRetry({ attempt, nextAttempt: attempt + 1, delayMs, error, result, status });
            } catch (_) {}
        }

        await sleep(delayMs, signal);
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
        cloneValues = true,
        pretty = false,
        atomicWrite = true
    }) {
        if (!file) throw new Error('PersistentJsonCache requires a file path');

        this.file = file;
        this.ttlMs = toPositiveNumber(ttlMs, 0);
        this.staleTtlMs = toPositiveNumber(staleTtlMs, 0);
        this.maxEntries = Math.max(1, Number(maxEntries) || 1);
        this.saveDebounceMs = toPositiveNumber(saveDebounceMs, 0);
        this.cloneValues = cloneValues === true;
        this.pretty = pretty === true;
        this.atomicWrite = atomicWrite !== false;
        this.cache = new Map();
        this.loaded = false;
        this.loading = null;
        this.saveTimer = null;
        this.pendingWrite = null;
        this.writeChain = Promise.resolve();
        this.dirty = false;
        this.stats = {
            hits: 0,
            staleHits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            flushes: 0,
            loadErrors: 0,
            writeErrors: 0
        };
    }

    get size() {
        return this.cache.size;
    }

    _clone(value) {
        return this.cloneValues ? cloneValue(value) : value;
    }

    _normalizePersistedEntry(value) {
        if (!value || typeof value !== 'object') return null;
        const timestamp = Number(value.timestamp || value.updatedAt || 0);
        if (!timestamp) return null;

        const payload = Object.prototype.hasOwnProperty.call(value, 'value')
            ? value.value
            : Object.fromEntries(Object.entries(value).filter(([entryKey]) => !['timestamp', 'updatedAt'].includes(entryKey)));

        return { timestamp, value: payload };
    }

    async _ensureLoaded() {
        if (this.loaded) return;
        if (this.loading) return this.loading;

        this.loading = (async () => {
            try {
                const rawText = await fs.readFile(this.file, 'utf8');
                const raw = JSON.parse(rawText);
                const entries = raw instanceof Array ? raw : Object.entries(raw || {});

                if (Array.isArray(raw)) {
                    for (const item of entries) {
                        const key = item?.key;
                        const entry = this._normalizePersistedEntry(item);
                        if (key == null || !entry) continue;
                        this.cache.set(String(key), entry);
                    }
                } else {
                    for (const [key, value] of entries) {
                        const entry = this._normalizePersistedEntry(value);
                        if (!entry) continue;
                        this.cache.set(key, entry);
                    }
                }
            } catch (error) {
                if (error?.code !== 'ENOENT') this.stats.loadErrors += 1;
            }

            this._prune();
            this.loaded = true;
            this.loading = null;
        })();

        return this.loading;
    }

    _prune(now = nowMs()) {
        let removed = false;
        for (const [key, entry] of this.cache.entries()) {
            if ((now - Number(entry?.timestamp || 0)) > (this.ttlMs + this.staleTtlMs)) {
                this.cache.delete(key);
                removed = true;
            }
        }

        if (this.cache.size > this.maxEntries) {
            const ordered = [...this.cache.entries()].sort((a, b) => Number(b[1]?.timestamp || 0) - Number(a[1]?.timestamp || 0));
            this.cache = new Map(ordered.slice(0, this.maxEntries));
            removed = true;
        }

        if (removed) this.dirty = true;
    }

    _scheduleSave() {
        this.dirty = true;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.pendingWrite = this.flush().catch(() => {});
        }, this.saveDebounceMs);
        if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
    }

    async get(key) {
        await this._ensureLoaded();
        const entry = this.cache.get(key);
        if (!entry) {
            this.stats.misses += 1;
            return { data: null, isStale: false };
        }

        const age = nowMs() - Number(entry.timestamp || 0);
        if (age <= this.ttlMs) {
            this.stats.hits += 1;
            return { data: this._clone(entry.value), isStale: false };
        }

        if (age <= (this.ttlMs + this.staleTtlMs)) {
            this.stats.staleHits += 1;
            return { data: this._clone(entry.value), isStale: true };
        }

        this.cache.delete(key);
        this.stats.misses += 1;
        this._scheduleSave();
        return { data: null, isStale: false };
    }

    async getState(key) {
        const result = await this.get(key);
        return {
            isFresh: Boolean(result.data && !result.isStale),
            isStale: Boolean(result.data && result.isStale),
            value: result.data
        };
    }

    async set(key, value) {
        await this._ensureLoaded();
        this.cache.set(key, {
            timestamp: nowMs(),
            value: this._clone(value)
        });
        this.stats.sets += 1;
        this._prune();
        this._scheduleSave();
    }

    async delete(key) {
        await this._ensureLoaded();
        const removed = this.cache.delete(key);
        if (removed) {
            this.stats.deletes += 1;
            this._scheduleSave();
        }
        return removed;
    }

    async deletePrefix(prefix) {
        await this._ensureLoaded();
        const needle = String(prefix || '');
        if (!needle) return 0;

        let count = 0;
        for (const key of [...this.cache.keys()]) {
            if (String(key).startsWith(needle)) {
                this.cache.delete(key);
                count += 1;
            }
        }

        if (count) {
            this.stats.deletes += count;
            this._scheduleSave();
        }

        return count;
    }

    async clear() {
        await this._ensureLoaded();
        const count = this.cache.size;
        this.cache.clear();
        this.stats.deletes += count;
        this._scheduleSave();
    }

    async keys() {
        await this._ensureLoaded();
        this._prune();
        return [...this.cache.keys()];
    }

    async flush() {
        await this._ensureLoaded();
        this._prune();

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        if (!this.dirty) return;

        this.writeChain = this.writeChain.then(async () => {
            const serializable = {};
            for (const [key, entry] of this.cache.entries()) {
                serializable[key] = {
                    timestamp: entry.timestamp,
                    value: entry.value
                };
            }

            const output = JSON.stringify(serializable, null, this.pretty ? 2 : 0);
            await fs.mkdir(path.dirname(this.file), { recursive: true });

            if (this.atomicWrite) {
                const tmpFile = `${this.file}.${process.pid}.${Date.now()}.tmp`;
                await fs.writeFile(tmpFile, output, 'utf8');
                await fs.rename(tmpFile, this.file);
            } else {
                await fs.writeFile(this.file, output, 'utf8');
            }

            this.dirty = false;
            this.stats.flushes += 1;
        }).catch((error) => {
            this.stats.writeErrors += 1;
            throw error;
        });

        return this.writeChain;
    }

    getStats() {
        return {
            ...this.stats,
            size: this.cache.size,
            maxEntries: this.maxEntries,
            loaded: this.loaded,
            dirty: this.dirty
        };
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
