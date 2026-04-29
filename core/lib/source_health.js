'use strict';

const MIN_SCORE = -100;
const MAX_SCORE = 100;
const FAILURE_THRESHOLD = Math.max(2, parseInt(process.env.SOURCE_HEALTH_FAILURE_THRESHOLD || '3', 10) || 3);
const OPEN_MS = Math.max(5000, parseInt(process.env.SOURCE_HEALTH_OPEN_MS || '30000', 10) || 30000);
const HALF_OPEN_SUCCESSES = Math.max(1, parseInt(process.env.SOURCE_HEALTH_HALF_OPEN_SUCCESSES || '2', 10) || 2);
const RECOVERY_SUCCESS_BONUS = Math.max(4, parseInt(process.env.SOURCE_HEALTH_RECOVERY_SUCCESS_BONUS || '10', 10) || 10);
const FAILURE_PENALTY = Math.max(4, parseInt(process.env.SOURCE_HEALTH_FAILURE_PENALTY || '14', 10) || 14);
const TIMEOUT_PENALTY = Math.max(6, parseInt(process.env.SOURCE_HEALTH_TIMEOUT_PENALTY || '20', 10) || 20);
const ZERO_RESULT_PENALTY = Math.max(2, parseInt(process.env.SOURCE_HEALTH_ZERO_RESULT_PENALTY || '4', 10) || 4);
const SUCCESS_BONUS = Math.max(2, parseInt(process.env.SOURCE_HEALTH_SUCCESS_BONUS || '6', 10) || 6);
const LATENCY_SLOW_MS = Math.max(400, parseInt(process.env.SOURCE_HEALTH_LATENCY_SLOW_MS || '2200', 10) || 2200);
const LATENCY_FAST_MS = Math.max(50, parseInt(process.env.SOURCE_HEALTH_LATENCY_FAST_MS || '600', 10) || 600);
const HEALTH_STALE_MS = Math.max(30_000, parseInt(process.env.SOURCE_HEALTH_STALE_MS || String(6 * 60 * 60 * 1000), 10) || (6 * 60 * 60 * 1000));

const states = new Map();

function clampScore(value) {
    return Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(value)));
}

function getState(name) {
    const key = String(name || 'unknown');
    let state = states.get(key);
    if (!state) {
        state = {
            name: key,
            status: 'closed',
            score: 0,
            consecutiveFailures: 0,
            consecutiveSuccesses: 0,
            openUntil: 0,
            totalCalls: 0,
            okCalls: 0,
            failCalls: 0,
            timeoutCalls: 0,
            emptyCalls: 0,
            totalMs: 0,
            avgMs: 0,
            bestMs: null,
            worstMs: null,
            lastError: null,
            lastSeenAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            halfOpenSuccesses: 0,
            exactHits: 0,
            exactMisses: 0,
            packHits: 0,
            packMisses: 0
        };
        states.set(key, state);
    }

    const now = Date.now();
    if (state.status === 'open' && state.openUntil <= now) {
        state.status = 'half-open';
        state.halfOpenSuccesses = 0;
    }
    return state;
}

function getCircuitState(name) {
    const state = getState(name);
    const retryInMs = state.status === 'open' ? Math.max(0, state.openUntil - Date.now()) : 0;
    return {
        status: state.status,
        retryInMs,
        score: state.score,
        consecutiveFailures: state.consecutiveFailures
    };
}

function registerCall(state, ms) {
    state.totalCalls += 1;
    if (Number.isFinite(ms) && ms >= 0) {
        state.totalMs += ms;
        state.avgMs = Math.round((state.totalMs / state.totalCalls) * 100) / 100;
        state.bestMs = state.bestMs === null ? ms : Math.min(state.bestMs, ms);
        state.worstMs = state.worstMs === null ? ms : Math.max(state.worstMs, ms);
    }
    state.lastSeenAt = new Date().toISOString();
}

function applyLatencyDelta(state, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (ms <= LATENCY_FAST_MS) state.score = clampScore(state.score + 1);
    else if (ms >= LATENCY_SLOW_MS) state.score = clampScore(state.score - 2);
}

function recordSuccess(name, meta = {}) {
    const state = getState(name);
    const ms = Number(meta.ms);
    registerCall(state, ms);
    state.okCalls += 1;
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses += 1;
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    applyLatencyDelta(state, ms);

    let delta = SUCCESS_BONUS;
    if (meta.empty === true) {
        state.emptyCalls += 1;
        delta -= ZERO_RESULT_PENALTY;
    }
    if (meta.exactHit === true) {
        state.exactHits += 1;
        delta += 4;
    } else if (meta.exactHit === false) {
        state.exactMisses += 1;
        delta -= 2;
    }
    if (meta.packHit === true) {
        state.packHits += 1;
        delta += 3;
    } else if (meta.packHit === false) {
        state.packMisses += 1;
        delta -= 1;
    }

    if (state.status === 'half-open') {
        state.halfOpenSuccesses += 1;
        delta += RECOVERY_SUCCESS_BONUS;
        if (state.halfOpenSuccesses >= HALF_OPEN_SUCCESSES) {
            state.status = 'closed';
            state.openUntil = 0;
            state.halfOpenSuccesses = 0;
        }
    } else {
        state.status = 'closed';
        state.openUntil = 0;
    }

    state.score = clampScore(state.score + delta);
    return state;
}

function recordFailure(name, meta = {}) {
    const state = getState(name);
    const ms = Number(meta.ms);
    const isTimeout = meta.timeout === true;
    registerCall(state, ms);
    state.failCalls += 1;
    if (isTimeout) state.timeoutCalls += 1;
    state.consecutiveFailures += 1;
    state.consecutiveSuccesses = 0;
    state.lastFailureAt = new Date().toISOString();
    state.lastError = String(meta.error || 'unknown_error').slice(0, 300);
    state.halfOpenSuccesses = 0;
    state.score = clampScore(state.score - (isTimeout ? TIMEOUT_PENALTY : FAILURE_PENALTY));

    if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
        state.status = 'open';
        state.openUntil = Date.now() + OPEN_MS;
    } else if (state.status !== 'open') {
        state.status = 'closed';
    }
    return state;
}

function getPriority(name) {
    const state = getState(name);
    const freshnessPenalty = state.lastSeenAt && (Date.now() - Date.parse(state.lastSeenAt || 0)) > HEALTH_STALE_MS ? 8 : 0;
    const breakerPenalty = state.status === 'open' ? 100 : state.status === 'half-open' ? 12 : 0;
    return clampScore(state.score - breakerPenalty - freshnessPenalty);
}

function sortNamesByPriority(names) {
    return [...new Set((Array.isArray(names) ? names : []).map((name) => String(name || '').trim()).filter(Boolean))]
        .sort((a, b) => getPriority(b) - getPriority(a));
}

function getSnapshot() {
    const snapshot = {};
    for (const [name, state] of states.entries()) {
        snapshot[name] = {
            status: state.status,
            score: state.score,
            consecutiveFailures: state.consecutiveFailures,
            consecutiveSuccesses: state.consecutiveSuccesses,
            retryInMs: state.status === 'open' ? Math.max(0, state.openUntil - Date.now()) : 0,
            calls: state.totalCalls,
            ok: state.okCalls,
            fail: state.failCalls,
            timeout: state.timeoutCalls,
            empty: state.emptyCalls,
            avgMs: state.avgMs,
            bestMs: state.bestMs,
            worstMs: state.worstMs,
            exactHits: state.exactHits,
            exactMisses: state.exactMisses,
            packHits: state.packHits,
            packMisses: state.packMisses,
            lastError: state.lastError,
            lastSeenAt: state.lastSeenAt,
            lastSuccessAt: state.lastSuccessAt,
            lastFailureAt: state.lastFailureAt
        };
    }
    return snapshot;
}

module.exports = {
    getCircuitState,
    recordSuccess,
    recordFailure,
    getPriority,
    sortNamesByPriority,
    getSnapshot
};
