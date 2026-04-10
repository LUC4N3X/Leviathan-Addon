require('dotenv').config();
const Bottleneck = require('bottleneck');

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, normalized));
}

function createLimiter(options, envPrefix = '') {
    const prefix = String(envPrefix || '').trim().toUpperCase();
    const envConcurrent = prefix ? process.env[`${prefix}_MAX_CONCURRENT`] : undefined;
    const envMinTime = prefix ? process.env[`${prefix}_MIN_TIME`] : undefined;
    return new Bottleneck({
        maxConcurrent: clampInt(envConcurrent, options.maxConcurrent, 1, 200),
        minTime: clampInt(envMinTime, options.minTime, 0, 10000)
    });
}

const LIMITERS = {
    scraper: createLimiter({ maxConcurrent: 40, minTime: 10 }, 'SCRAPER'),
    remoteIndexer: createLimiter({ maxConcurrent: 8, minTime: 25 }, 'REMOTE_INDEXER'),
    externalAddons: createLimiter({ maxConcurrent: 10, minTime: 20 }, 'EXTERNAL_ADDONS'),
    metadata: createLimiter({ maxConcurrent: 6, minTime: 50 }, 'METADATA'),
    rdResolve: createLimiter({ maxConcurrent: 15, minTime: 180 }, 'RD_RESOLVE'),
    adResolve: createLimiter({ maxConcurrent: 10, minTime: 220 }, 'AD_RESOLVE'),
    tbResolve: createLimiter({ maxConcurrent: 8, minTime: 250 }, 'TB_RESOLVE'),
    lazyPlay: createLimiter({ maxConcurrent: 20, minTime: 30 }, 'LAZY_PLAY'),
    lazyWarmup: createLimiter({ maxConcurrent: 3, minTime: 350 }, 'LAZY_WARMUP'),
    cloudBuild: createLimiter({ maxConcurrent: 4, minTime: 250 }, 'CLOUD_BUILD'),
    webVix: createLimiter({ maxConcurrent: 6, minTime: 25 }, 'WEB_VIX'),
    webGhd: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_GHD'),
    webGs: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_GS'),
    webAw: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_AW'),
    webGf: createLimiter({ maxConcurrent: 4, minTime: 40 }, 'WEB_GF'),
    packResolver: createLimiter({ maxConcurrent: 1, minTime: 2000 }, 'PACK_RESOLVER'),
    bgPackJobs: createLimiter({ maxConcurrent: 2, minTime: 25 }, 'BG_PACK_JOBS')
};

LIMITERS.rd = LIMITERS.rdResolve;
LIMITERS.ad = LIMITERS.adResolve;
LIMITERS.tb = LIMITERS.tbResolve;

const keyedQueues = new Map();
const KEYED_QUEUE_MAX = clampInt(process.env.KEYED_QUEUE_MAX, 4000, 100, 20000);
const KEYED_QUEUE_SWEEP_INTERVAL = clampInt(process.env.KEYED_QUEUE_SWEEP_INTERVAL_MS, 60000, 5000, 300000);
const KEYED_QUEUE_IDLE_TTL = clampInt(process.env.KEYED_QUEUE_IDLE_TTL_MS, 10 * 60 * 1000, 10000, 60 * 60 * 1000);
let lastQueueSweepAt = 0;

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
    const queueKey = `${String(group || 'default')}:${String(key || 'default')}`;
    const state = getQueueState(queueKey);
    const limiter = options && options.limiter ? options.limiter : null;

    state.pending += 1;
    const execute = async () => {
        if (limiter && typeof limiter.schedule === 'function') return limiter.schedule(() => Promise.resolve().then(task));
        return Promise.resolve().then(task);
    };

    const runPromise = state.tail.catch(() => undefined).then(execute);
    state.tail = runPromise.finally(() => {
        state.pending = Math.max(0, state.pending - 1);
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
    return stats;
}

module.exports = {
    LIMITERS,
    scheduleKeyed,
    getLimiterStats
};
