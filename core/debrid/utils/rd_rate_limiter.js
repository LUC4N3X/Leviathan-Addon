'use strict';

const crypto = require('crypto');
const { computeBackoffDelay, parseRetryAfterMs } = require('./backoff');

const DEFAULT_RATE_PER_MINUTE = 220;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_QUEUE = 450;
const DEFAULT_REQUEST_WAIT_TIMEOUT_MS = 20000;
const DEFAULT_LIMITER_TTL_MS = 10 * 60 * 1000;
// Pausing every RD call after just 2 consecutive 429s (for a fixed 30s) was too
// aggressive. Threshold + pause are now tunable, and the pause honours Retry-After.
const DEFAULT_RATE_LIMIT_429_THRESHOLD = 3;
const DEFAULT_RATE_LIMIT_429_PAUSE_MS = 20000;

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, normalized));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashApiKey(apiKey) {
    return crypto.createHash('sha256').update(String(apiKey || 'no-key')).digest('hex').slice(0, 18);
}

function getStatus(error) {
    return Number(error?.response?.status || error?.status || error?.statusCode || 0) || 0;
}

function isRetryableError(error) {
    const status = getStatus(error);
    if (status === 429 || (status >= 500 && status < 600)) return true;
    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
    const msg = String(error?.message || '').toLowerCase();
    return msg.includes('socket hang up') || msg.includes('fetch failed') || msg.includes('network');
}

function isRateLimitError(error) {
    return getStatus(error) === 429 || /\b429\b|rate\s*limit/i.test(String(error?.message || ''));
}

class RealDebridUserLimiter {
    constructor(options = {}) {
        this.capacity = clampInt(options.ratePerMinute, DEFAULT_RATE_PER_MINUTE, 30, 250);
        this.tokens = this.capacity;
        this.concurrency = clampInt(options.concurrency, DEFAULT_CONCURRENCY, 1, 25);
        this.maxRetries = clampInt(options.maxRetries, DEFAULT_MAX_RETRIES, 0, 8);
        this.maxQueue = clampInt(options.maxQueue, DEFAULT_MAX_QUEUE, 20, 5000);
        this.requestWaitTimeoutMs = clampInt(options.requestWaitTimeoutMs, DEFAULT_REQUEST_WAIT_TIMEOUT_MS, 1000, 120000);
        this.rateLimit429Threshold = clampInt(options.rateLimit429Threshold, DEFAULT_RATE_LIMIT_429_THRESHOLD, 2, 20);
        this.rateLimit429PauseMs = clampInt(options.rateLimit429PauseMs, DEFAULT_RATE_LIMIT_429_PAUSE_MS, 2000, 120000);
        this.queue = [];
        this.running = 0;
        this.consecutive429 = 0;
        this.abortUntil = 0;
        this.lastUsedAt = Date.now();

        const batchSize = Math.max(1, Math.floor(this.capacity / 50));
        const refillMs = Math.max(900, Math.floor(60000 / Math.max(1, this.capacity / batchSize)));
        this.refillInterval = setInterval(() => {
            this.tokens = Math.min(this.capacity, this.tokens + batchSize);
            this.drain();
        }, refillMs);
        this.refillInterval.unref?.();
    }

    schedule(task, label = 'rd-api') {
        this.lastUsedAt = Date.now();
        if (Date.now() < this.abortUntil) {
            const error = new Error(`[RD LIMITER] temporarily paused after repeated 429 (${label})`);
            error.code = 'RD_LIMITER_PAUSED';
            return Promise.reject(error);
        }
        if (this.queue.length >= this.maxQueue) {
            const error = new Error(`[RD LIMITER] queue full ${this.queue.length}/${this.maxQueue} (${label})`);
            error.code = 'RD_LIMITER_QUEUE_FULL';
            return Promise.reject(error);
        }

        return new Promise((resolve, reject) => {
            const job = { task, label, resolve, reject, tries: 0, addedAt: Date.now(), timeout: null };
            job.timeout = setTimeout(() => {
                const idx = this.queue.indexOf(job);
                if (idx >= 0) this.queue.splice(idx, 1);
                const error = new Error(`[RD LIMITER] wait timeout after ${Date.now() - job.addedAt}ms (${label})`);
                error.code = 'RD_LIMITER_WAIT_TIMEOUT';
                reject(error);
            }, this.requestWaitTimeoutMs);
            job.timeout.unref?.();
            this.queue.push(job);
            this.drain();
        });
    }

    drain() {
        if (Date.now() < this.abortUntil) return;
        while (this.tokens > 0 && this.running < this.concurrency && this.queue.length > 0) {
            const job = this.queue.shift();
            if (job.timeout) clearTimeout(job.timeout);
            this.tokens -= 1;
            this.running += 1;

            Promise.resolve()
                .then(job.task)
                .then((result) => {
                    this.running -= 1;
                    this.consecutive429 = 0;
                    job.resolve(result);
                    this.drain();
                })
                .catch(async (error) => {
                    this.running -= 1;
                    const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.['retry-after']);
                    if (isRateLimitError(error)) {
                        this.consecutive429 += 1;
                        if (this.consecutive429 >= this.rateLimit429Threshold) {
                            const pauseMs = Math.max(this.rateLimit429PauseMs, retryAfterMs);
                            this.abortUntil = Date.now() + pauseMs;
                            console.warn(`[RD LIMITER] 429 storm detected (${this.consecutive429}x), pausing RD calls for ${Math.round(pauseMs / 1000)}s`);
                        }
                    }

                    if (isRetryableError(error) && job.tries < this.maxRetries && Date.now() >= this.abortUntil) {
                        job.tries += 1;
                        const delay = computeBackoffDelay(job.tries - 1, {
                            baseMs: 750,
                            maxMs: 8000,
                            retryAfterMs
                        });
                        await sleep(delay);
                        this.queue.unshift(job);
                        this.drain();
                        return;
                    }

                    job.reject(error);
                    this.drain();
                });
        }
    }

    shutdown() {
        clearInterval(this.refillInterval);
        this.queue.splice(0).forEach((job) => {
            if (job.timeout) clearTimeout(job.timeout);
            job.reject(new Error('[RD LIMITER] shutdown'));
        });
    }

    stats() {
        return {
            queue: this.queue.length,
            running: this.running,
            tokens: this.tokens,
            capacity: this.capacity,
            concurrency: this.concurrency,
            pausedMs: Math.max(0, this.abortUntil - Date.now()),
            lastUsedAt: this.lastUsedAt
        };
    }
}

const limiters = new Map();
let cleanupInterval = null;

function getLimiter(apiKey) {
    const key = hashApiKey(apiKey);
    let entry = limiters.get(key);
    if (!entry) {
        entry = {
            limiter: new RealDebridUserLimiter({
                ratePerMinute: process.env.RD_RATE_PER_MINUTE,
                concurrency: process.env.RD_CONCURRENCY,
                maxRetries: process.env.RD_MAX_RETRIES,
                maxQueue: process.env.RD_MAX_QUEUE_SIZE,
                requestWaitTimeoutMs: process.env.RD_REQUEST_WAIT_TIMEOUT_MS,
                rateLimit429Threshold: process.env.RD_LIMITER_429_THRESHOLD,
                rateLimit429PauseMs: process.env.RD_LIMITER_429_PAUSE_MS
            }),
            createdAt: Date.now(),
            lastUsedAt: Date.now()
        };
        limiters.set(key, entry);
        console.log(`[RD LIMITER] created per-user limiter key=${key.slice(0, 8)} rate=${entry.limiter.capacity}/min concurrency=${entry.limiter.concurrency}`);
    }
    entry.lastUsedAt = Date.now();
    entry.limiter.lastUsedAt = entry.lastUsedAt;
    ensureCleanup();
    return entry.limiter;
}

function ensureCleanup() {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        const ttl = clampInt(process.env.RD_LIMITER_TTL_MS, DEFAULT_LIMITER_TTL_MS, 60_000, 60 * 60 * 1000);
        for (const [key, entry] of limiters.entries()) {
            if ((now - entry.lastUsedAt) <= ttl) continue;
            entry.limiter.shutdown();
            limiters.delete(key);
        }
    }, 5 * 60 * 1000);
    cleanupInterval.unref?.();
}

function scheduleRealDebridRequest(apiKey, task, label = 'rd-api') {
    return getLimiter(apiKey).schedule(task, label);
}

function getRealDebridLimiterStats() {
    return Object.fromEntries(Array.from(limiters.entries()).map(([key, entry]) => [key.slice(0, 8), entry.limiter.stats()]));
}

module.exports = {
    scheduleRealDebridRequest,
    getRealDebridLimiterStats,
    _private: { RealDebridUserLimiter, hashApiKey, isRetryableError }
};
