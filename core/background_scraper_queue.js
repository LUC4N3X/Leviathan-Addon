'use strict';

const DEFAULT_ENABLED = String(process.env.BACKGROUND_SCRAPER_ENABLED || 'true').toLowerCase() !== 'false';
const DEFAULT_CONCURRENCY = Math.max(1, parseInt(process.env.BACKGROUND_SCRAPER_CONCURRENCY || '1', 10) || 1);
const DEFAULT_MAX_QUEUE = Math.max(10, parseInt(process.env.BACKGROUND_SCRAPER_MAX_QUEUE || '200', 10) || 200);
const DEFAULT_DEDUP_TTL_MS = Math.max(30000, parseInt(process.env.BACKGROUND_SCRAPER_DEDUP_TTL_MS || '300000', 10) || 300000);
const DEFAULT_TASK_TIMEOUT_MS = Math.max(10000, parseInt(process.env.BACKGROUND_SCRAPER_TASK_TIMEOUT_MS || '60000', 10) || 60000);
const DEFAULT_MAX_RUNTIME_MS = Math.max(10000, parseInt(process.env.BACKGROUND_SCRAPER_MAX_RUNTIME_MS || '45000', 10) || 45000);

const queue = [];
const activeKeys = new Set();
const recentKeys = new Map();
const stats = {
    enqueued: 0,
    skippedDuplicate: 0,
    droppedFull: 0,
    started: 0,
    completed: 0,
    failed: 0,
    timeout: 0
};
let running = 0;

function now() {
    return Date.now();
}

function cleanupRecent() {
    const ts = now();
    for (const [key, expiresAt] of recentKeys.entries()) {
        if (Number(expiresAt || 0) <= ts) recentKeys.delete(key);
    }
}

function isEnabled() {
    return String(process.env.BACKGROUND_SCRAPER_ENABLED || (DEFAULT_ENABLED ? 'true' : 'false')).toLowerCase() !== 'false';
}

function getConcurrency() {
    return Math.max(1, parseInt(process.env.BACKGROUND_SCRAPER_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY);
}

function getMaxQueue() {
    return Math.max(10, parseInt(process.env.BACKGROUND_SCRAPER_MAX_QUEUE || String(DEFAULT_MAX_QUEUE), 10) || DEFAULT_MAX_QUEUE);
}

function getDedupTtlMs() {
    return Math.max(30000, parseInt(process.env.BACKGROUND_SCRAPER_DEDUP_TTL_MS || String(DEFAULT_DEDUP_TTL_MS), 10) || DEFAULT_DEDUP_TTL_MS);
}

function getTaskTimeoutMs() {
    return Math.max(10000, parseInt(process.env.BACKGROUND_SCRAPER_TASK_TIMEOUT_MS || String(DEFAULT_TASK_TIMEOUT_MS), 10) || DEFAULT_TASK_TIMEOUT_MS);
}

function getMaxRuntimeMs() {
    return Math.max(10000, parseInt(process.env.BACKGROUND_SCRAPER_MAX_RUNTIME_MS || String(DEFAULT_MAX_RUNTIME_MS), 10) || DEFAULT_MAX_RUNTIME_MS);
}

function withTimeout(promise, timeoutMs, label = 'background task') {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

function buildContext(task) {
    const startedAt = now();
    const maxRuntimeMs = Math.max(1, Number(task?.maxRuntimeMs || getMaxRuntimeMs()) || getMaxRuntimeMs());
    return {
        key: task.key,
        label: task.label,
        reason: task.reason,
        startedAt,
        maxRuntimeMs,
        get elapsedMs() { return now() - startedAt; },
        get remainingMs() { return Math.max(0, maxRuntimeMs - (now() - startedAt)); },
        shouldStop() { return now() - startedAt >= maxRuntimeMs; }
    };
}

function runNext({ logger, incrementMetric, recordDuration } = {}) {
    if (!isEnabled()) return;
    cleanupRecent();
    while (running < getConcurrency() && queue.length > 0) {
        const task = queue.shift();
        if (!task || typeof task.run !== 'function') continue;
        if (activeKeys.has(task.key)) continue;

        running += 1;
        activeKeys.add(task.key);
        stats.started += 1;
        if (typeof incrementMetric === 'function') incrementMetric('backgroundScraper.started');
        const startedAt = now();
        const context = buildContext(task);
        logger?.info?.(`[BG-SCRAPER] start key=${task.key} reason=${task.reason || 'scheduled'} queue=${queue.length}`);

        withTimeout(task.run(context), Math.min(getTaskTimeoutMs(), context.maxRuntimeMs), task.label || task.key)
            .then((result) => {
                stats.completed += 1;
                if (typeof incrementMetric === 'function') incrementMetric('backgroundScraper.completed');
                logger?.info?.(`[BG-SCRAPER] done key=${task.key} ms=${now() - startedAt} results=${Number(result?.results || result?.count || 0) || 0}`);
            })
            .catch((error) => {
                const isTimeout = /timeout/i.test(String(error?.message || error));
                if (isTimeout) stats.timeout += 1;
                else stats.failed += 1;
                if (typeof incrementMetric === 'function') incrementMetric(isTimeout ? 'backgroundScraper.timeout' : 'backgroundScraper.failed');
                logger?.warn?.(`[BG-SCRAPER] failed key=${task.key} error=${error?.message || error}`);
            })
            .finally(() => {
                activeKeys.delete(task.key);
                running = Math.max(0, running - 1);
                if (typeof recordDuration === 'function') recordDuration('backgroundScraper.task', now() - startedAt);
                setImmediate(() => runNext({ logger, incrementMetric, recordDuration }));
            });
    }
}

function enqueue(task = {}, tools = {}) {
    const key = String(task.key || '').trim();
    if (!isEnabled()) return { queued: false, reason: 'disabled' };
    if (!key || typeof task.run !== 'function') return { queued: false, reason: 'invalid' };

    cleanupRecent();
    if (activeKeys.has(key) || recentKeys.has(key) || queue.some((entry) => entry?.key === key)) {
        stats.skippedDuplicate += 1;
        if (typeof tools.incrementMetric === 'function') tools.incrementMetric('backgroundScraper.skippedDuplicate');
        tools.logger?.info?.(`[BG-SCRAPER] skip duplicate key=${key} reason=${task.reason || 'dedupe'}`);
        return { queued: false, reason: 'duplicate' };
    }

    if (queue.length >= getMaxQueue()) {
        stats.droppedFull += 1;
        if (typeof tools.incrementMetric === 'function') tools.incrementMetric('backgroundScraper.droppedFull');
        tools.logger?.warn?.(`[BG-SCRAPER] queue full drop key=${key} max=${getMaxQueue()}`);
        return { queued: false, reason: 'queue_full' };
    }

    recentKeys.set(key, now() + Math.max(1, Number(task.dedupTtlMs || getDedupTtlMs()) || getDedupTtlMs()));
    queue.push({
        key,
        label: task.label || key,
        reason: task.reason || 'scheduled',
        priority: Number(task.priority || 0) || 0,
        maxRuntimeMs: Math.max(1, Number(task.maxRuntimeMs || getMaxRuntimeMs()) || getMaxRuntimeMs()),
        run: task.run
    });
    queue.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
    stats.enqueued += 1;
    if (typeof tools.incrementMetric === 'function') tools.incrementMetric('backgroundScraper.queued');
    tools.logger?.info?.(`[BG-SCRAPER] queued key=${key} reason=${task.reason || 'scheduled'} queue=${queue.length}`);
    setImmediate(() => runNext(tools));
    return { queued: true, reason: 'queued', size: queue.length };
}

function getStats() {
    cleanupRecent();
    return {
        ...stats,
        enabled: isEnabled(),
        running,
        queued: queue.length,
        active: activeKeys.size,
        recent: recentKeys.size,
        concurrency: getConcurrency(),
        maxQueue: getMaxQueue()
    };
}

module.exports = {
    enqueue,
    getStats,
    isEnabled,
    getConcurrency,
    getMaxQueue,
    getTaskTimeoutMs,
    getMaxRuntimeMs
};
