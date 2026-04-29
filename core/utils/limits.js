const Bottleneck = require('bottleneck');

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, normalized));
}

function resolveLimiterStrategy(value, fallback = Bottleneck.strategy.OVERFLOW) {
    if (typeof value === 'number') return value;
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'LEAK') return Bottleneck.strategy.LEAK;
    if (normalized === 'OVERFLOW_PRIORITY') return Bottleneck.strategy.OVERFLOW_PRIORITY;
    if (normalized === 'BLOCK') return Bottleneck.strategy.BLOCK;
    if (normalized === 'OVERFLOW') return Bottleneck.strategy.OVERFLOW;
    return fallback;
}

function createLimiter(options, envPrefix = '') {
    const prefix = String(envPrefix || '').trim().toUpperCase();
    const envConcurrent = prefix ? process.env[`${prefix}_MAX_CONCURRENT`] : undefined;
    const envMinTime = prefix ? process.env[`${prefix}_MIN_TIME`] : undefined;
    const envHighWater = prefix ? process.env[`${prefix}_HIGH_WATER`] : undefined;
    const envStrategy = prefix ? process.env[`${prefix}_STRATEGY`] : undefined;
    const limiterOptions = {
        maxConcurrent: clampInt(envConcurrent, options.maxConcurrent, 1, 200),
        minTime: clampInt(envMinTime, options.minTime, 0, 10000)
    };
    const fallbackHighWater = Number.isFinite(Number(options.highWater)) ? Number(options.highWater) : 0;
    const highWater = clampInt(envHighWater, fallbackHighWater, 0, 100000);
    if (highWater > 0) {
        limiterOptions.highWater = highWater;
        limiterOptions.strategy = resolveLimiterStrategy(envStrategy, resolveLimiterStrategy(options.strategy));
    }
    return new Bottleneck(limiterOptions);
}

const LIMITERS = {
    scraper: createLimiter({ maxConcurrent: 40, minTime: 10 }, 'SCRAPER'),
    remoteIndexer: createLimiter({ maxConcurrent: 8, minTime: 25 }, 'REMOTE_INDEXER'),
    externalAddons: createLimiter({ maxConcurrent: 10, minTime: 20 }, 'EXTERNAL_ADDONS'),
    metadata: createLimiter({ maxConcurrent: 6, minTime: 50 }, 'METADATA'),
    rdResolve: createLimiter({ maxConcurrent: 15, minTime: 180 }, 'RD_RESOLVE'),
    tbResolve: createLimiter({ maxConcurrent: 8, minTime: 250 }, 'TB_RESOLVE'),
    lazyPlay: createLimiter({ maxConcurrent: 20, minTime: 30 }, 'LAZY_PLAY'),
    lazyWarmup: createLimiter({ maxConcurrent: 3, minTime: 350, highWater: 12, strategy: Bottleneck.strategy.OVERFLOW }, 'LAZY_WARMUP'),
    cloudBuild: createLimiter({ maxConcurrent: 4, minTime: 250 }, 'CLOUD_BUILD'),
    webVix: createLimiter({ maxConcurrent: 6, minTime: 25 }, 'WEB_VIX'),
    webGhd: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_GHD'),
    webGs: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_GS'),
    webAw: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_AW'),
    webAu: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_AU'),
    webAs: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_AS'),
    webGf: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_GF'),
    webCc: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_CC'),
    packResolver: createLimiter({ maxConcurrent: 1, minTime: 2000 }, 'PACK_RESOLVER'),
    bgPackJobs: createLimiter({ maxConcurrent: 2, minTime: 25, highWater: 10, strategy: Bottleneck.strategy.OVERFLOW }, 'BG_PACK_JOBS')
};

LIMITERS.rd = LIMITERS.rdResolve;
LIMITERS.tb = LIMITERS.tbResolve;

const keyedQueues = new Map();
const keyedGroupPending = new Map();
const KEYED_QUEUE_MAX = clampInt(process.env.KEYED_QUEUE_MAX, 4000, 100, 20000);
const KEYED_QUEUE_SWEEP_INTERVAL = clampInt(process.env.KEYED_QUEUE_SWEEP_INTERVAL_MS, 60000, 5000, 300000);
const KEYED_QUEUE_IDLE_TTL = clampInt(process.env.KEYED_QUEUE_IDLE_TTL_MS, 10 * 60 * 1000, 10000, 60 * 60 * 1000);
let lastQueueSweepAt = 0;

function createQueueOverflowError(scope, maxPending) {
    const error = new Error(`Queue overflow for ${scope} (max pending: ${maxPending})`);
    error.code = 'QUEUE_OVERFLOW';
    return error;
}

function getGroupPendingCount(group) {
    return keyedGroupPending.get(group) || 0;
}

function incrementGroupPending(group) {
    keyedGroupPending.set(group, getGroupPendingCount(group) + 1);
}

function decrementGroupPending(group) {
    const nextValue = Math.max(0, getGroupPendingCount(group) - 1);
    if (nextValue === 0) keyedGroupPending.delete(group);
    else keyedGroupPending.set(group, nextValue);
}

function sweepKeyedQueues() {
    const now = Date.now();
    if ((now - lastQueueSweepAt) < KEYED_QUEUE_SWEEP_INTERVAL && keyedQueues.size < KEYED_QUEUE_MAX) return;
    lastQueueSweepAt = now;

    for (const [queueKey, state] of keyedQueues) {
        if (!state || state.pending > 0) continue;
        if ((now - Number(state.lastUsedAt || 0)) > KEYED_QUEUE_IDLE_TTL || keyedQueues.size > KEYED_QUEUE_MAX) {
            keyedQueues.delete(queueKey);
        }
    }

    while (keyedQueues.size > KEYED_QUEUE_MAX) {
        const oldestKey = keyedQueues.keys().next().value;
        if (!oldestKey) break;
        keyedQueues.delete(oldestKey);
    }
}

function getQueueState(queueKey) {
    sweepKeyedQueues();
    let state = keyedQueues.get(queueKey);
    if (!state) {
        state = { tail: Promise.resolve(), pending: 0, lastUsedAt: Date.now() };
        keyedQueues.set(queueKey, state);
    }
    state.lastUsedAt = Date.now();
    return state;
}

function scheduleKeyed(group, key, task, options = {}) {
    const normalizedGroup = String(group || 'default');
    const queueKey = `${normalizedGroup}:${String(key || 'default')}`;
    const maxGroupPending = clampInt(options.maxGroupPending, 0, 0, 100000);
    if (maxGroupPending > 0 && getGroupPendingCount(normalizedGroup) >= maxGroupPending) {
        return Promise.reject(createQueueOverflowError(normalizedGroup, maxGroupPending));
    }
    const state = getQueueState(queueKey);
    const limiter = options && options.limiter ? options.limiter : null;

    state.pending += 1;
    incrementGroupPending(normalizedGroup);
    const execute = async () => {
        if (limiter && typeof limiter.schedule === 'function') return limiter.schedule(() => Promise.resolve().then(task));
        return Promise.resolve().then(task);
    };

    const runPromise = state.tail.catch(() => undefined).then(execute);
    state.tail = runPromise.catch(() => undefined).finally(() => {
        state.pending = Math.max(0, state.pending - 1);
        decrementGroupPending(normalizedGroup);
        state.lastUsedAt = Date.now();
        if (state.pending === 0 && keyedQueues.get(queueKey) === state) {
            keyedQueues.delete(queueKey);
        }
    });

    return runPromise;
}

function getLimiterStats() {
    const stats = {};
    for (const [name, limiter] of Object.entries(LIMITERS || {})) {
        if (!limiter || typeof limiter.counts !== 'function') continue;
        try {
            stats[name] = limiter.counts();
        } catch (_) {}
    }
    stats.keyedQueues = { active: keyedQueues.size };
    stats.keyedQueueGroups = Object.fromEntries(keyedGroupPending.entries());
    return stats;
}

module.exports = {
    LIMITERS,
    scheduleKeyed,
    getLimiterStats
};
