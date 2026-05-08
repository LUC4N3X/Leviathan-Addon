'use strict';

function now() {
    return Date.now();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

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

function normalizeGetOptions(options) {
    if (typeof options === 'boolean') return { allowStale: options };
    return options && typeof options === 'object' ? options : {};
}

class TtlLruCache {
    constructor({
        name = 'provider-cache',
        max = 500,
        maxSize = null,
        maxEntries = null,
        ttlMs = 60 * 1000,
        ttl = null,
        staleTtlMs = 0,
        staleMs = null,
        staleMode = 'absolute',
        cloneValues = false,
        missingValue = undefined,
        sweepIntervalOps = 0
    } = {}) {
        this.name = name;
        this.max = Math.max(1, positiveInt(maxEntries ?? maxSize ?? max, 500));
        this.ttlMs = Math.max(1, positiveInt(ttl ?? ttlMs, 60 * 1000));
        this.staleTtlMs = Math.max(0, Number(staleMs ?? staleTtlMs) || 0);
        this.staleMode = staleMode === 'extension' ? 'extension' : 'absolute';
        this.cloneValues = cloneValues === true;
        this.missingValue = missingValue;
        this.map = new Map();
        this.ops = 0;
        this.hits = 0;
        this.misses = 0;
        this.staleHits = 0;
        this.sets = 0;
        this.evictions = 0;
        this.sweepIntervalOps = Math.max(0, Number(sweepIntervalOps) || 0);
    }

    get size() {
        return this.map.size;
    }

    _clone(value) {
        return this.cloneValues ? cloneValue(value) : value;
    }

    _touch(key, entry) {
        this.map.delete(key);
        this.map.set(key, entry);
    }

    _missing() {
        return this.missingValue;
    }

    _computeStaleUntil(expiresAt, ttl, staleTtl) {
        if (this.staleMode === 'extension') return expiresAt + Math.max(0, staleTtl);
        return now() + Math.max(ttl, staleTtl || ttl);
    }

    _maybeSweep(ts = now()) {
        if (this.sweepIntervalOps > 0) {
            this.ops += 1;
            if (this.ops % this.sweepIntervalOps !== 0 && this.map.size <= this.max) return;
        }
        this.prune(ts);
    }

    prune(ts = now()) {
        for (const [key, entry] of this.map.entries()) {
            if (!entry || Number(entry.staleUntil || entry.staleAt || entry.expiresAt || 0) <= ts) {
                this.map.delete(key);
            }
        }

        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) break;
            this.map.delete(oldest);
            this.evictions += 1;
        }
    }

    getEntry(key, options = {}) {
        const { allowStale = false } = normalizeGetOptions(options);
        if (!key && key !== 0) {
            this.misses += 1;
            return null;
        }

        const entry = this.map.get(key);
        const ts = now();
        if (!entry) {
            this.misses += 1;
            this._maybeSweep(ts);
            return null;
        }

        const expiresAt = Number(entry.expiresAt || 0);
        const staleUntil = Number(entry.staleUntil || entry.staleAt || expiresAt);
        if (staleUntil <= ts) {
            this.map.delete(key);
            this.misses += 1;
            return null;
        }

        const isStale = expiresAt <= ts;
        if (isStale && !allowStale) {
            this.misses += 1;
            this._touch(key, entry);
            return null;
        }

        if (isStale) this.staleHits += 1;
        else this.hits += 1;
        this._touch(key, entry);
        this._maybeSweep(ts);

        return {
            value: this._clone(entry.value),
            expiresAt,
            staleUntil,
            staleAt: staleUntil,
            isStale,
            fresh: !isStale,
            meta: entry.meta || null
        };
    }

    get(key, options = {}) {
        const entry = this.getEntry(key, options);
        return entry ? entry.value : this._missing();
    }

    getStale(key) {
        return this.get(key, { allowStale: true });
    }

    peek(key) {
        const entry = this.map.get(key);
        return entry ? this._clone(entry.value) : this._missing();
    }

    has(key) {
        return this.getEntry(key, { allowStale: false }) !== null;
    }

    hasFresh(key) {
        return this.has(key);
    }

    set(key, value, ttlMs = this.ttlMs, staleTtlMs = this.staleTtlMs, meta = null) {
        if (!key && key !== 0) return value;
        const ts = now();
        const ttl = Math.max(1, Number(ttlMs) || this.ttlMs);
        const staleTtl = Math.max(0, Number(staleTtlMs) || 0);
        const expiresAt = ts + ttl;
        const staleUntil = this._computeStaleUntil(expiresAt, ttl, staleTtl);

        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, {
            value: this._clone(value),
            createdAt: ts,
            expiresAt,
            staleUntil,
            staleAt: staleUntil,
            meta
        });
        this.sets += 1;
        this.prune(ts);
        return value;
    }

    delete(key) {
        return this.map.delete(key);
    }

    clear() {
        this.map.clear();
    }

    stats() {
        return {
            name: this.name,
            size: this.map.size,
            max: this.max,
            ttlMs: this.ttlMs,
            staleTtlMs: this.staleTtlMs,
            staleMode: this.staleMode,
            hits: this.hits,
            misses: this.misses,
            staleHits: this.staleHits,
            sets: this.sets,
            evictions: this.evictions
        };
    }
}

class SingleFlight {
    constructor(name = 'singleflight', { max = 2000 } = {}) {
        this.name = name;
        this.max = Math.max(1, Number(max) || 2000);
        this.inflight = new Map();
        this.map = this.inflight;
        this.hits = 0;
        this.starts = 0;
    }

    async do(key, worker) {
        return this.run(key, worker);
    }

    async run(key, worker) {
        if (!key && key !== 0) return worker();
        const existing = this.inflight.get(key);
        if (existing) {
            this.hits += 1;
            return existing;
        }

        const promise = Promise.resolve()
            .then(() => worker())
            .finally(() => {
                if (this.inflight.get(key) === promise) this.inflight.delete(key);
            });

        this.inflight.set(key, promise);
        this.starts += 1;
        while (this.inflight.size > this.max) {
            const oldest = this.inflight.keys().next().value;
            if (oldest === undefined || oldest === key) break;
            this.inflight.delete(oldest);
        }
        return promise;
    }

    has(key) {
        return this.inflight.has(key);
    }

    get(key) {
        return this.inflight.get(key);
    }

    set(key, value) {
        this.inflight.set(key, value);
        return this;
    }

    delete(key) {
        return this.inflight.delete(key);
    }

    clear() {
        this.inflight.clear();
    }

    stats() {
        return {
            name: this.name,
            inflight: this.inflight.size,
            hits: this.hits,
            starts: this.starts,
            shared: this.hits,
            started: this.starts
        };
    }
}

class AsyncSemaphore {
    constructor(max = 1) {
        this.max = Math.max(1, Number(max) || 1);
        this.active = 0;
        this.queue = [];
    }

    async acquire() {
        if (this.active < this.max) {
            this.active += 1;
            return;
        }
        await new Promise((resolve) => this.queue.push(resolve));
    }

    release() {
        this.active = Math.max(0, this.active - 1);
        const next = this.queue.shift();
        if (next) {
            this.active += 1;
            next();
        }
    }

    async run(worker) {
        await this.acquire();
        try {
            return await worker();
        } finally {
            this.release();
        }
    }

    stats() {
        return {
            max: this.max,
            active: this.active,
            queued: this.queue.length
        };
    }
}

function createLimiter(concurrency = 4) {
    const semaphore = new AsyncSemaphore(concurrency);
    return (fn) => semaphore.run(fn);
}

function createProviderCacheGroup(providerName, definitions = {}, options = {}) {
    const group = {};
    for (const [name, config] of Object.entries(definitions || {})) {
        group[name] = new TtlLruCache({
            name: `${providerName}:${name}`,
            ...(config || {})
        });
    }
    if (options.inflight !== false) {
        group.inflight = new SingleFlight(`${providerName}:inflight`, options.inflightOptions || {});
    }
    return group;
}

function cacheGet(store, key, options = {}) {
    if (!store || typeof store.get !== 'function') return undefined;
    return store.get(key, options);
}

function cacheGetStale(store, key) {
    return cacheGet(store, key, { allowStale: true });
}

function cacheSet(store, key, value, ttlMs, staleTtlMs, meta = null) {
    if (!store || typeof store.set !== 'function') return value;
    return store.set(key, value, ttlMs, staleTtlMs, meta);
}

function cacheStats(group = {}) {
    const out = {};
    for (const [name, value] of Object.entries(group || {})) {
        if (value && typeof value.stats === 'function') out[name] = value.stats();
        else if (value instanceof Map) out[name] = { size: value.size };
    }
    return out;
}

function clearCaches(group = {}) {
    for (const value of Object.values(group || {})) {
        if (value && typeof value.clear === 'function') value.clear();
    }
}

module.exports = {
    AsyncSemaphore,
    SingleFlight,
    TtlLruCache,
    cacheGet,
    cacheGetStale,
    cacheSet,
    cacheStats,
    clearCaches,
    cloneValue,
    createLimiter,
    createProviderCacheGroup,
    now,
    sleep
};
