'use strict';

const { withSharedPromise } = require('../utils/common');
const { redisCache, writeJsonLater } = require('../utils/redis_cache');

function cloneValue(value) {
    if (value == null) return value;
    if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch (_) {}
    }
    if (Array.isArray(value) || (value && typeof value === 'object')) {
        try { return JSON.parse(JSON.stringify(value)); } catch (_) {}
    }
    return value;
}

function now() {
    return Date.now();
}

class ProviderRequestCache {
    constructor({ name = 'provider-request-cache', maxEntries = 800, inflightMaxEntries = 400, cloneValues = true, redisEnabled = true } = {}) {
        this.name = name;
        this.maxEntries = Math.max(1, Number(maxEntries) || 800);
        this.inflightMaxEntries = Math.max(1, Number(inflightMaxEntries) || 400);
        this.cloneValues = cloneValues !== false;
        this.redisEnabled = redisEnabled !== false;
        this.cache = new Map();
        this.inflight = new Map();
        this.hits = 0;
        this.misses = 0;
        this.sets = 0;
        this.singleFlightHits = 0;
        this.singleFlightStarts = 0;
        this.evictions = 0;
        this.redisHits = 0;
        this.redisSets = 0;
    }

    _clone(value) {
        return this.cloneValues ? cloneValue(value) : value;
    }

    _touch(key, entry) {
        this.cache.delete(key);
        this.cache.set(key, entry);
    }

    prune(ts = now()) {
        for (const [key, entry] of this.cache.entries()) {
            if (!entry || Number(entry.expiresAt || 0) <= ts) this.cache.delete(key);
        }
        while (this.cache.size > this.maxEntries) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
            this.evictions += 1;
        }
    }

    get(key) {
        if (!key && key !== 0) {
            this.misses += 1;
            return undefined;
        }
        const entry = this.cache.get(key);
        const ts = now();
        if (!entry || Number(entry.expiresAt || 0) <= ts) {
            if (entry) this.cache.delete(key);
            this.misses += 1;
            return undefined;
        }
        this.hits += 1;
        this._touch(key, entry);
        return this._clone(entry.value);
    }

    set(key, value, ttlMs) {
        if (!key && key !== 0) return value;
        const ttl = Math.max(1_000, Number(ttlMs) || 60_000);
        this.cache.set(key, { value: this._clone(value), expiresAt: now() + ttl, createdAt: now() });
        this.sets += 1;
        this.prune();
        return value;
    }

    delete(key) {
        this.cache.delete(key);
        this.inflight.delete(key);
    }

    clear() {
        this.cache.clear();
        this.inflight.clear();
    }

    async singleFlight(key, worker) {
        if (!key && key !== 0) return worker();
        if (this.inflight.has(key)) this.singleFlightHits += 1;
        else this.singleFlightStarts += 1;
        return withSharedPromise(this.inflight, key, worker, { maxEntries: this.inflightMaxEntries });
    }

    async runCached(key, ttlMs, worker, options = {}) {
        const cached = this.get(key);
        if (cached !== undefined) return cached;

        const redisNamespace = `providerRequest:${this.name}`;
        const redisTtlSeconds = Math.max(1, Math.ceil((Number(ttlMs) || 60_000) / 1000));
        if (this.redisEnabled && options.redis !== false && redisCache.isEnabled()) {
            const redisValue = await redisCache.getJson(redisNamespace, key);
            if (redisValue !== undefined) {
                this.redisHits += 1;
                this.set(key, redisValue, ttlMs);
                return this._clone(redisValue);
            }
        }

        return this.singleFlight(`cache:${key}`, async () => {
            const afterWait = this.get(key);
            if (afterWait !== undefined) return afterWait;
            if (this.redisEnabled && options.redis !== false && redisCache.isEnabled()) {
                const redisValue = await redisCache.getJson(redisNamespace, key);
                if (redisValue !== undefined) {
                    this.redisHits += 1;
                    this.set(key, redisValue, ttlMs);
                    return this._clone(redisValue);
                }
            }
            const value = await worker();
            const shouldCache = typeof options.shouldCache === 'function'
                ? options.shouldCache(value)
                : value !== undefined && value !== null;
            if (shouldCache) {
                this.set(key, value, ttlMs);
                if (this.redisEnabled && options.redis !== false) {
                    if (writeJsonLater(redisNamespace, key, value, redisTtlSeconds)) this.redisSets += 1;
                }
            }
            return value;
        });
    }

    stats() {
        return {
            name: this.name,
            cacheSize: this.cache.size,
            inflight: this.inflight.size,
            maxEntries: this.maxEntries,
            inflightMaxEntries: this.inflightMaxEntries,
            hits: this.hits,
            misses: this.misses,
            sets: this.sets,
            evictions: this.evictions,
            redisEnabled: this.redisEnabled && redisCache.isEnabled(),
            redisHits: this.redisHits,
            redisSets: this.redisSets,
            singleFlightHits: this.singleFlightHits,
            singleFlightStarts: this.singleFlightStarts
        };
    }
}

module.exports = {
    ProviderRequestCache,
    cloneValue
};
