'use strict';

const { classifyProviderError } = require('./provider_errors');

const DEFAULTS = Object.freeze({
    slowMs: 12000,
    cooldownMs: 180000,
    maxConsecutiveErrors: 2,
    maxConsecutiveZeroes: 8,
    maxHistory: 20
});

const states = new Map();

function now() {
    return Date.now();
}

function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerKey(provider) {
    return String(provider || 'unknown')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9:_-]+/g, '_') || 'unknown';
}

function providerEnvPrefix(provider) {
    return providerKey(provider).replace(/[^A-Z0-9]+/gi, '_').toUpperCase();
}

function getConfig(provider, overrides = {}) {
    const prefix = providerEnvPrefix(provider);
    return {
        slowMs: positiveInt(overrides.slowMs ?? process.env[`${prefix}_HEALTH_SLOW_MS`] ?? process.env.PROVIDER_HEALTH_SLOW_MS, DEFAULTS.slowMs),
        cooldownMs: positiveInt(overrides.cooldownMs ?? process.env[`${prefix}_HEALTH_COOLDOWN_MS`] ?? process.env.PROVIDER_HEALTH_COOLDOWN_MS, DEFAULTS.cooldownMs),
        maxConsecutiveErrors: positiveInt(overrides.maxConsecutiveErrors ?? process.env[`${prefix}_HEALTH_MAX_ERRORS`] ?? process.env.PROVIDER_HEALTH_MAX_ERRORS, DEFAULTS.maxConsecutiveErrors),
        maxConsecutiveZeroes: positiveInt(overrides.maxConsecutiveZeroes ?? process.env[`${prefix}_HEALTH_MAX_ZEROES`] ?? process.env.PROVIDER_HEALTH_MAX_ZEROES, DEFAULTS.maxConsecutiveZeroes),
        maxHistory: positiveInt(overrides.maxHistory ?? process.env.PROVIDER_HEALTH_HISTORY, DEFAULTS.maxHistory),
        debug: overrides.debug === true || envFlag(`${prefix}_HEALTH_DEBUG`, envFlag('PROVIDER_HEALTH_DEBUG', false)),
        skipCooldown: overrides.skipCooldown === true || envFlag(`${prefix}_HEALTH_SKIP_COOLDOWN`, envFlag('PROVIDER_HEALTH_SKIP_COOLDOWN', false))
    };
}

function createState(provider) {
    return {
        provider: providerKey(provider),
        status: 'unknown',
        previousStatus: 'unknown',
        lastStartedAt: 0,
        lastSuccessAt: 0,
        lastErrorAt: 0,
        lastZeroAt: 0,
        lastDurationMs: 0,
        avgDurationMs: 0,
        lastResultCount: null,
        totalCalls: 0,
        totalSuccess: 0,
        totalErrors: 0,
        totalZeroes: 0,
        consecutiveErrors: 0,
        consecutiveZeroes: 0,
        cooldownUntil: 0,
        lastError: null,
        lastReason: null,
        history: []
    };
}

function getProviderHealth(provider) {
    const key = providerKey(provider);
    if (!states.has(key)) states.set(key, createState(key));
    return states.get(key);
}

function pushHistory(state, entry, maxHistory = DEFAULTS.maxHistory) {
    state.history.push({ at: now(), ...entry });
    while (state.history.length > maxHistory) state.history.shift();
}

function isCloudflareLike(value) {
    const classified = classifyProviderError({ message: value });
    return classified.status === 'blocked_cf';
}

function classifyError(error) {
    const classified = classifyProviderError(error);
    return {
        status: classified.status,
        reason: classified.reason,
        friendly: classified.friendly,
        code: classified.code,
        retryable: classified.retryable
    };
}

function logHealth(provider, state, message, meta = {}, config = {}) {
    const shouldLog = config.debug || ['blocked_cf', 'blocked', 'rate_limited', 'cooldown', 'recovered'].includes(meta.status || state.status);
    if (!shouldLog) return;
    const details = Object.entries(meta)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    console.log(`[PROVIDER HEALTH] ${providerKey(provider)} ${message}${details ? ` | ${details}` : ''}`);
}

function setStatus(state, status) {
    if (state.status !== status) {
        state.previousStatus = state.status;
        state.status = status;
        return true;
    }
    state.status = status;
    return false;
}

function isProviderCoolingDown(provider, options = {}) {
    const state = getProviderHealth(provider);
    const cfg = getConfig(provider, options);
    const active = Number(state.cooldownUntil || 0) > now();
    return {
        active,
        until: active ? state.cooldownUntil : 0,
        remainingMs: active ? Math.max(0, state.cooldownUntil - now()) : 0,
        skip: active && cfg.skipCooldown,
        state: snapshotProviderHealth(provider)
    };
}

function markProviderStart(provider, options = {}) {
    const state = getProviderHealth(provider);
    const cfg = getConfig(provider, options);
    state.lastStartedAt = now();
    state.totalCalls += 1;
    pushHistory(state, { type: 'start' }, cfg.maxHistory);
    return state.lastStartedAt;
}

function markProviderSuccess(provider, meta = {}, options = {}) {
    const state = getProviderHealth(provider);
    const cfg = getConfig(provider, options);
    const durationMs = Math.max(0, Number(meta.durationMs) || 0);
    const resultCount = Number.isFinite(Number(meta.resultCount)) ? Number(meta.resultCount) : null;
    const recovered = ['blocked_cf', 'blocked', 'rate_limited', 'error', 'slow', 'cooldown'].includes(state.status);

    state.lastSuccessAt = now();
    state.lastDurationMs = durationMs;
    state.avgDurationMs = state.avgDurationMs > 0 ? Math.round((state.avgDurationMs * 0.75) + (durationMs * 0.25)) : durationMs;
    state.lastResultCount = resultCount;
    state.totalSuccess += 1;
    state.consecutiveErrors = 0;
    state.lastError = null;
    state.cooldownUntil = 0;

    if (resultCount === 0) {
        state.totalZeroes += 1;
        state.consecutiveZeroes += 1;
        state.lastZeroAt = now();
        setStatus(state, state.consecutiveZeroes >= cfg.maxConsecutiveZeroes ? 'zero_results' : 'ok');
    } else {
        state.consecutiveZeroes = 0;
        setStatus(state, durationMs >= cfg.slowMs ? 'slow' : 'ok');
    }

    pushHistory(state, { type: 'success', durationMs, resultCount, status: state.status }, cfg.maxHistory);
    if (recovered && state.status === 'ok') logHealth(provider, state, 'recovered', { status: 'recovered', ms: durationMs, results: resultCount }, cfg);
    else logHealth(provider, state, 'success', { status: state.status, ms: durationMs, results: resultCount }, cfg);
    return snapshotProviderHealth(provider);
}

function markProviderError(provider, error, meta = {}, options = {}) {
    const state = getProviderHealth(provider);
    const cfg = getConfig(provider, options);
    const durationMs = Math.max(0, Number(meta.durationMs) || 0);
    const classified = classifyError(error);

    state.lastErrorAt = now();
    state.lastDurationMs = durationMs;
    state.avgDurationMs = state.avgDurationMs > 0 && durationMs > 0 ? Math.round((state.avgDurationMs * 0.75) + (durationMs * 0.25)) : state.avgDurationMs || durationMs;
    state.totalErrors += 1;
    state.consecutiveErrors += 1;
    state.lastError = {
        message: String(error?.message || error || classified.reason).slice(0, 300),
        reason: classified.reason,
        status: classified.status
    };
    state.lastReason = classified.reason;

    const hardBlocked = ['blocked_cf', 'blocked', 'rate_limited'].includes(classified.status);
    const tooManyErrors = state.consecutiveErrors >= cfg.maxConsecutiveErrors;
    if (hardBlocked || tooManyErrors) state.cooldownUntil = now() + cfg.cooldownMs;
    setStatus(state, state.cooldownUntil > now() ? classified.status : classified.status);

    pushHistory(state, {
        type: 'error',
        durationMs,
        status: state.status,
        reason: classified.reason,
        message: state.lastError.message
    }, cfg.maxHistory);
    logHealth(provider, state, 'error', {
        status: state.status,
        reason: classified.reason,
        nice: classified.friendly,
        ms: durationMs,
        consecutive: state.consecutiveErrors,
        cooldown: state.cooldownUntil > now() ? `${Math.ceil((state.cooldownUntil - now()) / 1000)}s` : ''
    }, cfg);
    return snapshotProviderHealth(provider);
}

async function withProviderHealth(provider, worker, options = {}) {
    const cfg = getConfig(provider, options);
    const cooldown = isProviderCoolingDown(provider, options);
    if (cooldown.skip) {
        const state = getProviderHealth(provider);
        setStatus(state, 'cooldown');
        logHealth(provider, state, 'skip', { status: 'cooldown', remaining: `${Math.ceil(cooldown.remainingMs / 1000)}s` }, cfg);
        return options.fallbackValue !== undefined ? options.fallbackValue : [];
    }

    const started = markProviderStart(provider, options);
    try {
        const result = await worker();
        const count = Array.isArray(result)
            ? result.length
            : Number.isFinite(Number(options.resultCount)) ? Number(options.resultCount) : null;
        markProviderSuccess(provider, { durationMs: now() - started, resultCount: count }, options);
        return result;
    } catch (error) {
        markProviderError(provider, error, { durationMs: now() - started }, options);
        if (options.swallowErrors === true) return options.fallbackValue !== undefined ? options.fallbackValue : [];
        throw error;
    }
}

function snapshotProviderHealth(provider = null) {
    const serialize = (state) => ({
        provider: state.provider,
        status: state.status,
        previousStatus: state.previousStatus,
        lastStartedAt: state.lastStartedAt || null,
        lastSuccessAt: state.lastSuccessAt || null,
        lastErrorAt: state.lastErrorAt || null,
        lastZeroAt: state.lastZeroAt || null,
        lastDurationMs: state.lastDurationMs || 0,
        avgDurationMs: state.avgDurationMs || 0,
        lastResultCount: state.lastResultCount,
        totalCalls: state.totalCalls,
        totalSuccess: state.totalSuccess,
        totalErrors: state.totalErrors,
        totalZeroes: state.totalZeroes,
        consecutiveErrors: state.consecutiveErrors,
        consecutiveZeroes: state.consecutiveZeroes,
        cooldownUntil: state.cooldownUntil > now() ? state.cooldownUntil : 0,
        cooldownRemainingMs: state.cooldownUntil > now() ? Math.max(0, state.cooldownUntil - now()) : 0,
        lastError: state.lastError,
        lastReason: state.lastReason,
        history: state.history.slice(-DEFAULTS.maxHistory)
    });

    if (provider) return serialize(getProviderHealth(provider));
    const out = {};
    for (const [key, state] of states.entries()) out[key] = serialize(state);
    return out;
}

function resetProviderHealth(provider = null) {
    if (provider) {
        states.delete(providerKey(provider));
        return;
    }
    states.clear();
}

module.exports = {
    classifyError,
    getProviderHealth,
    isProviderCoolingDown,
    markProviderError,
    markProviderStart,
    markProviderSuccess,
    resetProviderHealth,
    snapshotProviderHealth,
    withProviderHealth
};
