'use strict';

const DEFAULT_SLOW_MS = Math.max(250, parseInt(process.env.STREAM_TRACE_SLOW_MS || '2500', 10) || 2500);
const MAX_STAGES = Math.max(8, Math.min(80, parseInt(process.env.STREAM_TRACE_MAX_STAGES || '32', 10) || 32));
const RECENT_TRACE_LIMIT = Math.max(0, Math.min(200, parseInt(process.env.STREAM_TRACE_RECENT_LIMIT || '40', 10) || 40));

const recentTraces = [];

function compactText(value, max = 96) {
    const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function safeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function countOf(value) {
    if (Array.isArray(value)) return value.length;
    if (value && Array.isArray(value.streams)) return value.streams.length;
    if (value && Array.isArray(value.results)) return value.results.length;
    return null;
}

function sanitizeDetails(details = {}) {
    const out = {};
    for (const [key, value] of Object.entries(details || {})) {
        if (value === undefined || value === null || value === '') continue;
        if (/key|token|pass|secret|auth|rd|realdebrid|torbox/i.test(key)) continue;
        if (typeof value === 'number') out[key] = safeNumber(value);
        else if (typeof value === 'boolean') out[key] = value;
        else if (Array.isArray(value)) out[key] = value.slice(0, 8).map((entry) => compactText(entry, 48));
        else out[key] = compactText(value, 120);
    }
    return out;
}

function createStreamTrace(context = {}, options = {}) {
    const enabled = options.enabled !== undefined
        ? options.enabled !== false
        : String(process.env.STREAM_TRACE_ENABLED || '1') !== '0';
    const debug = options.debug !== undefined
        ? options.debug === true
        : String(process.env.STREAM_TRACE_DEBUG || '').toLowerCase() === '1';
    const slowMs = Math.max(50, safeNumber(options.slowMs, DEFAULT_SLOW_MS));
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const logger = options.logger;
    const startedAt = now();
    const stages = [];
    let lastAt = startedAt;
    let emitted = false;

    function pushStage(name, details = {}, durationMs = null) {
        if (!enabled || stages.length >= MAX_STAGES) return;
        const at = now();
        const elapsedMs = Math.max(0, Math.round(at - startedAt));
        const deltaMs = durationMs === null
            ? Math.max(0, Math.round(at - lastAt))
            : Math.max(0, Math.round(durationMs));
        lastAt = at;
        stages.push({
            name: compactText(name, 48),
            ms: deltaMs,
            at: elapsedMs,
            ...sanitizeDetails(details)
        });
    }

    async function time(name, work, details = {}) {
        const stageStartedAt = now();
        try {
            const result = await Promise.resolve().then(work);
            const dynamicDetails = typeof details === 'function' ? details(result) : details;
            const resultCount = countOf(result);
            pushStage(name, {
                ...(resultCount !== null ? { count: resultCount } : {}),
                ...(dynamicDetails || {})
            }, now() - stageStartedAt);
            return result;
        } catch (error) {
            pushStage(name, {
                error: error?.message || error,
                failed: true
            }, now() - stageStartedAt);
            throw error;
        }
    }

    function summarize(extra = {}) {
        const totalMs = Math.max(0, Math.round(now() - startedAt));
        return {
            totalMs,
            type: compactText(context.type, 16),
            id: compactText(context.id, 96),
            title: compactText(context.title, 96),
            sourceMode: compactText(context.sourceMode, 32),
            service: compactText(context.service, 16),
            cacheScope: compactText(context.cacheScope, 16),
            stages: stages.map((stage) => ({ ...stage })),
            ...sanitizeDetails(extra)
        };
    }

    function finish(extra = {}) {
        if (!enabled || emitted) return null;
        emitted = true;
        const summary = summarize(extra);
        if (RECENT_TRACE_LIMIT > 0) {
            recentTraces.push({
                ...summary,
                capturedAt: new Date().toISOString()
            });
            while (recentTraces.length > RECENT_TRACE_LIMIT) recentTraces.shift();
        }
        const streamCount = safeNumber(extra.streams ?? extra.streamCount, 0);
        const shouldLog = debug || summary.totalMs >= slowMs || streamCount === 0 || extra.error;
        if (shouldLog && logger && typeof logger.info === 'function') {
            const stageLine = summary.stages.map((stage) => `${stage.name}:${stage.ms}ms`).join(',');
            logger.info(`[TRACE] stream total=${summary.totalMs}ms streams=${streamCount} mode=${summary.sourceMode || 'n/a'} service=${summary.service || 'n/a'} stages=${stageLine || 'none'}`, {
                trace: summary
            });
        }
        return summary;
    }

    return {
        enabled,
        stage: pushStage,
        time,
        finish,
        summarize
    };
}

function getRecentStreamTraces(limit = RECENT_TRACE_LIMIT) {
    const safeLimit = Math.max(0, Math.min(RECENT_TRACE_LIMIT || 0, parseInt(limit, 10) || RECENT_TRACE_LIMIT || 0));
    if (safeLimit <= 0) return [];
    return recentTraces.slice(-safeLimit).reverse().map((entry) => ({
        ...entry,
        stages: Array.isArray(entry.stages) ? entry.stages.map((stage) => ({ ...stage })) : []
    }));
}

function clearRecentStreamTraces() {
    const count = recentTraces.length;
    recentTraces.length = 0;
    return count;
}

module.exports = {
    createStreamTrace,
    getRecentStreamTraces,
    clearRecentStreamTraces,
    sanitizeDetails
};
