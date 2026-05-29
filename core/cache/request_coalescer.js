'use strict';

const crypto = require('crypto');
const { redisCache } = require('../utils/redis_cache');
const { cloneValue } = require('./provider_request_cache');
let incrementMetric = () => {};
try {
    ({ incrementMetric } = require('../utils/runtime'));
} catch (_) {
    incrementMetric = () => {};
}

function boolEnv(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const normalized = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function intEnv(name, fallback, min, max) {
    const parsed = parseInt(process.env[name] || String(fallback), 10);
    const safe = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, safe));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(ms) || 1)));
}

function sanitizePart(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return 'empty';
    const clean = raw.replace(/[\r\n\t]+/g, ' ').replace(/[^a-z0-9:._-]+/gi, '_');
    if (clean.length <= 160) return clean;
    return `sha256_${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function buildRequestCoalescingKey(parts = []) {
    const joined = (Array.isArray(parts) ? parts : [parts]).map(sanitizePart).join(':');
    if (joined.length <= 420) return joined || 'empty';
    return `sha256:${crypto.createHash('sha256').update(joined).digest('hex')}`;
}

function trimInflightMap(map, maxEntries, onEvict = null) {
    if (!(map instanceof Map)) return;
    const max = Math.max(1, Number(maxEntries) || 1);
    let evicted = 0;
    while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
        evicted += 1;
    }
    if (evicted > 0 && typeof onEvict === 'function') onEvict(evicted);
}

function isUsableResult(value) {
    return value !== undefined && value !== null;
}

class RequestCoalescer {
    constructor({
        namespace = 'request',
        localMaxEntries = intEnv('REQUEST_COALESCER_LOCAL_MAX_ENTRIES', 4096, 64, 50000),
        enabled = boolEnv('REQUEST_COALESCING_ENABLED', true),
        distributed = boolEnv('REQUEST_COALESCING_DISTRIBUTED_ENABLED', true),
        lockTtlMs = intEnv('REQUEST_COALESCING_LOCK_TTL_MS', 60000, 1000, 300000),
        waitMs = intEnv('REQUEST_COALESCING_WAIT_MS', 25000, 250, 120000),
        pollMs = intEnv('REQUEST_COALESCING_POLL_MS', 350, 50, 5000),
        resultTtlSeconds = intEnv('REQUEST_COALESCING_RESULT_TTL_SECONDS', 90, 5, 3600),
        redis = redisCache,
        cloneResults = true,
        logger = null,
        metricsPrefix = 'requestCoalescer'
    } = {}) {
        this.namespace = sanitizePart(namespace);
        this.localMaxEntries = Math.max(1, Number(localMaxEntries) || 4096);
        this.enabled = enabled !== false;
        this.distributed = distributed !== false;
        this.lockTtlMs = Math.max(1000, Number(lockTtlMs) || 60000);
        this.waitMs = Math.max(250, Number(waitMs) || 25000);
        this.pollMs = Math.max(50, Number(pollMs) || 350);
        this.resultTtlSeconds = Math.max(5, Number(resultTtlSeconds) || 90);
        this.redis = redis;
        this.cloneResults = cloneResults !== false;
        this.logger = logger;
        this.metricsPrefix = String(metricsPrefix || 'requestCoalescer').replace(/[^a-z0-9._-]+/gi, '_');
        this.inflight = new Map();
        this.statsData = {
            localHits: 0,
            starts: 0,
            cacheHitsBefore: 0,
            resultHits: 0,
            lockAcquired: 0,
            lockWaits: 0,
            waitCacheHits: 0,
            waitResultHits: 0,
            waitTimeouts: 0,
            workerRuns: 0,
            workerErrors: 0,
            evictions: 0
        };
    }

    _metric(name, count = 1) {
        try { incrementMetric(`${this.metricsPrefix}.${name}`, count); } catch (_) {}
    }

    _clone(value) {
        return this.cloneResults ? cloneValue(value) : value;
    }

    _lockNamespace() {
        return `${this.namespace}:locks`;
    }

    _resultNamespace() {
        return `${this.namespace}:results`;
    }

    _isRedisEnabled() {
        return this.distributed && this.redis && typeof this.redis.isEnabled === 'function' && this.redis.isEnabled();
    }

    async _readCached(readCached, phase) {
        if (typeof readCached !== 'function') return undefined;
        try {
            const value = await readCached(phase);
            return isUsableResult(value) ? value : undefined;
        } catch (_) {
            return undefined;
        }
    }

    async _readResult(key) {
        if (!this._isRedisEnabled() || typeof this.redis.getJson !== 'function') return undefined;
        const wrapped = await this.redis.getJson(this._resultNamespace(), key);
        if (!wrapped || typeof wrapped !== 'object' || !('value' in wrapped)) return undefined;
        return wrapped.value;
    }

    async _writeResult(key, value, ttlSeconds) {
        if (!this._isRedisEnabled() || typeof this.redis.setJson !== 'function') return false;
        const ttl = Math.max(5, Number(ttlSeconds || this.resultTtlSeconds) || this.resultTtlSeconds);
        return this.redis.setJson(this._resultNamespace(), key, { value, storedAt: Date.now() }, ttl);
    }

    async run(key, worker, options = {}) {
        const detail = await this.runDetailed(key, worker, options);
        return detail.value;
    }

    async runDetailed(key, worker, options = {}) {
        const normalizedKey = sanitizePart(key);
        if (!this.enabled || !normalizedKey) {
            return { value: await worker(), origin: 'disabled_worker', didRunWorker: true, waitedMs: 0 };
        }

        const existing = this.inflight.get(normalizedKey);
        if (existing) {
            this.statsData.localHits += 1;
            this._metric('localHit');
            const startedWait = Date.now();
            const detail = await existing;
            return {
                value: this._clone(detail.value),
                origin: 'local_wait',
                didRunWorker: false,
                waitedMs: Date.now() - startedWait
            };
        }

        this.statsData.starts += 1;
        this._metric('start');
        const promise = this._runOnce(normalizedKey, worker, options)
            .finally(() => {
                if (this.inflight.get(normalizedKey) === promise) this.inflight.delete(normalizedKey);
            });
        this.inflight.set(normalizedKey, promise);
        trimInflightMap(this.inflight, this.localMaxEntries, (count) => {
            this.statsData.evictions += count;
            this._metric('evicted', count);
        });
        return promise;
    }

    async _runWorker(key, worker, options = {}, origin = 'worker') {
        if (typeof worker !== 'function') throw new Error('request coalescer worker missing');
        this.statsData.workerRuns += 1;
        this._metric('workerRun');
        try {
            const value = await worker();
            const shouldStore = typeof options.shouldStoreResult === 'function'
                ? options.shouldStoreResult(value)
                : isUsableResult(value);
            if (shouldStore) {
                await this._writeResult(key, value, options.resultTtlSeconds).catch(() => false);
            }
            return { value: this._clone(value), origin, didRunWorker: true, waitedMs: 0 };
        } catch (error) {
            this.statsData.workerErrors += 1;
            this._metric('workerError');
            throw error;
        }
    }

    async _runOnce(key, worker, options = {}) {
        const startedAt = Date.now();
        const readCached = options.readCached;

        const cachedBefore = await this._readCached(readCached, 'before');
        if (cachedBefore !== undefined) {
            this.statsData.cacheHitsBefore += 1;
            this._metric('cacheHitBefore');
            return { value: this._clone(cachedBefore), origin: 'cache_before', didRunWorker: false, waitedMs: 0 };
        }

        const redisResult = await this._readResult(key);
        if (redisResult !== undefined) {
            this.statsData.resultHits += 1;
            this._metric('resultHit');
            return { value: this._clone(redisResult), origin: 'redis_result', didRunWorker: false, waitedMs: 0 };
        }

        if (!this._isRedisEnabled()) {
            return this._runWorker(key, worker, options, 'local_worker');
        }

        const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
        const lockTtlMs = Math.max(1000, Number(options.lockTtlMs || this.lockTtlMs) || this.lockTtlMs);
        const gotLock = await this.redis.setIfAbsent(this._lockNamespace(), key, token, lockTtlMs);

        if (gotLock) {
            this.statsData.lockAcquired += 1;
            this._metric('lockAcquired');
            try {
                const cachedAfterLock = await this._readCached(readCached, 'after_lock');
                if (cachedAfterLock !== undefined) {
                    this.statsData.waitCacheHits += 1;
                    this._metric('cacheHitAfterLock');
                    return { value: this._clone(cachedAfterLock), origin: 'cache_after_lock', didRunWorker: false, waitedMs: 0 };
                }
                return await this._runWorker(key, worker, options, 'distributed_owner_worker');
            } finally {
                if (typeof this.redis.releaseLock === 'function') {
                    this.redis.releaseLock(this._lockNamespace(), key, token).catch(() => false);
                }
            }
        }

        // If SET NX failed because Redis entered cooldown, do not stall the user for
        // the distributed wait window. Fall back to local execution immediately.
        if (!this._isRedisEnabled()) {
            this._metric('redisUnavailableFallback');
            return this._runWorker(key, worker, options, 'redis_unavailable_worker');
        }

        this.statsData.lockWaits += 1;
        this._metric('lockWait');
        const waitMs = Math.max(250, Number(options.waitMs || this.waitMs) || this.waitMs);
        const pollMs = Math.max(50, Number(options.pollMs || this.pollMs) || this.pollMs);
        const deadline = Date.now() + waitMs;

        while (Date.now() < deadline) {
            await sleep(pollMs);

            const cachedDuringWait = await this._readCached(readCached, 'wait');
            if (cachedDuringWait !== undefined) {
                this.statsData.waitCacheHits += 1;
                this._metric('waitCacheHit');
                return {
                    value: this._clone(cachedDuringWait),
                    origin: 'wait_cache',
                    didRunWorker: false,
                    waitedMs: Date.now() - startedAt
                };
            }

            const resultDuringWait = await this._readResult(key);
            if (resultDuringWait !== undefined) {
                this.statsData.waitResultHits += 1;
                this._metric('waitResultHit');
                return {
                    value: this._clone(resultDuringWait),
                    origin: 'wait_result',
                    didRunWorker: false,
                    waitedMs: Date.now() - startedAt
                };
            }
        }

        this.statsData.waitTimeouts += 1;
        this._metric('waitTimeout');
        if (this.logger && typeof this.logger.warn === 'function') {
            this.logger.warn(`[CACHE LOCK] wait timeout | namespace=${this.namespace} | key=${String(key).slice(0, 140)} | waitMs=${waitMs}`);
        }

        const finalCacheCheck = await this._readCached(readCached, 'timeout');
        if (finalCacheCheck !== undefined) {
            this.statsData.waitCacheHits += 1;
            this._metric('timeoutCacheHit');
            return {
                value: this._clone(finalCacheCheck),
                origin: 'timeout_cache',
                didRunWorker: false,
                waitedMs: Date.now() - startedAt
            };
        }

        if (options.fallbackToWorker === false) {
            return { value: options.fallbackValue, origin: 'wait_timeout_fallback', didRunWorker: false, waitedMs: Date.now() - startedAt };
        }
        return this._runWorker(key, worker, options, 'timeout_worker');
    }

    stats() {
        return {
            namespace: this.namespace,
            enabled: this.enabled,
            distributed: this.distributed,
            redisEnabled: this._isRedisEnabled(),
            inflight: this.inflight.size,
            localMaxEntries: this.localMaxEntries,
            lockTtlMs: this.lockTtlMs,
            waitMs: this.waitMs,
            pollMs: this.pollMs,
            resultTtlSeconds: this.resultTtlSeconds,
            ...this.statsData
        };
    }

    clearLocal() {
        this.inflight.clear();
    }
}

const streamRequestCoalescer = new RequestCoalescer({
    namespace: 'streamRequest',
    localMaxEntries: intEnv('STREAM_REQUEST_COALESCER_LOCAL_MAX_ENTRIES', 4096, 64, 50000),
    enabled: boolEnv('STREAM_REQUEST_COALESCING_ENABLED', boolEnv('REQUEST_COALESCING_ENABLED', true)),
    distributed: boolEnv('STREAM_REQUEST_DISTRIBUTED_LOCK_ENABLED', boolEnv('REQUEST_COALESCING_DISTRIBUTED_ENABLED', true)),
    lockTtlMs: intEnv('STREAM_REQUEST_LOCK_TTL_MS', intEnv('REQUEST_COALESCING_LOCK_TTL_MS', 60000, 1000, 300000), 1000, 300000),
    waitMs: intEnv('STREAM_REQUEST_LOCK_WAIT_MS', intEnv('REQUEST_COALESCING_WAIT_MS', 25000, 250, 120000), 250, 120000),
    pollMs: intEnv('STREAM_REQUEST_LOCK_POLL_MS', intEnv('REQUEST_COALESCING_POLL_MS', 350, 50, 5000), 50, 5000),
    resultTtlSeconds: intEnv('STREAM_REQUEST_RESULT_TTL_SECONDS', intEnv('REQUEST_COALESCING_RESULT_TTL_SECONDS', 90, 5, 3600), 5, 3600),
    metricsPrefix: 'streamRequestCoalescer'
});

module.exports = {
    RequestCoalescer,
    buildRequestCoalescingKey,
    streamRequestCoalescer
};
