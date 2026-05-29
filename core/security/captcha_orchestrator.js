'use strict';

const CAPTCHA_ORCHESTRATOR_DEFAULTS = Object.freeze({
    defaultTtlMs: 30 * 60_000,
    failureTtlMs: 2 * 60_000,
    retryBudget: 2,
    maxRecords: 300
});

const DEFAULT_TTL_MS = CAPTCHA_ORCHESTRATOR_DEFAULTS.defaultTtlMs;
const DEFAULT_FAILURE_TTL_MS = CAPTCHA_ORCHESTRATOR_DEFAULTS.failureTtlMs;
const DEFAULT_RETRY_BUDGET = CAPTCHA_ORCHESTRATOR_DEFAULTS.retryBudget;
const MAX_RECORDS = CAPTCHA_ORCHESTRATOR_DEFAULTS.maxRecords;

function nowMs() {
    return Date.now();
}

function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === '') return fallback;
    return !/^(?:0|false|no|off)$/i.test(String(value).trim());
}

function envNumber(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(String(process.env[name] ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizePart(value, fallback = 'default') {
    const text = String(value ?? '').trim().toLowerCase();
    return text || fallback;
}

function createCaptchaKey(input = {}) {
    const provider = normalizePart(input.provider || input.providerId);
    const hoster = normalizePart(input.hoster || input.host || input.service);
    const captchaType = normalizePart(input.captchaType || input.type || input.challengeType);
    const scope = normalizePart(input.scope || input.url || input.target || input.domain, 'global');
    return `${provider}:${hoster}:${captchaType}:${scope}`;
}

function clone(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

class CaptchaOrchestrator {
    constructor(options = {}) {
        this.defaultTtlMs = Number(options.defaultTtlMs || DEFAULT_TTL_MS);
        this.failureTtlMs = Number(options.failureTtlMs || DEFAULT_FAILURE_TTL_MS);
        this.defaultRetryBudget = Number(options.defaultRetryBudget || DEFAULT_RETRY_BUDGET);
        this.records = new Map();
        this.inflight = new Map();
    }

    makeKey(input = {}) {
        return createCaptchaKey(input);
    }

    get(input = {}) {
        const key = this.makeKey(input);
        const record = this.records.get(key);
        if (!record) return null;
        const now = nowMs();
        if (record.expiresAt && record.expiresAt <= now) {
            this.records.delete(key);
            return null;
        }
        return clone(record);
    }

    upsert(input = {}, patch = {}, ttlMs = null) {
        const key = this.makeKey(input);
        const now = nowMs();
        const previous = this.records.get(key) || {};
        const ttl = Math.max(1_000, Number(ttlMs || patch.ttlMs || previous.ttlMs || this.defaultTtlMs));
        const record = {
            provider: input.provider || previous.provider || 'default',
            hoster: input.hoster || previous.hoster || input.host || 'default',
            captchaType: input.captchaType || previous.captchaType || input.type || 'default',
            scope: input.scope || previous.scope || input.url || input.target || 'global',
            createdAt: previous.createdAt || now,
            updatedAt: now,
            ttlMs: ttl,
            expiresAt: now + ttl,
            retryBudget: Number.isFinite(Number(patch.retryBudget))
                ? Number(patch.retryBudget)
                : Number.isFinite(Number(previous.retryBudget)) ? Number(previous.retryBudget) : this.defaultRetryBudget,
            failures: Number.isFinite(Number(patch.failures))
                ? Number(patch.failures)
                : Number.isFinite(Number(previous.failures)) ? Number(previous.failures) : 0,
            lastSuccess: previous.lastSuccess || null,
            lastFail: previous.lastFail || null,
            reason: previous.reason || null,
            cookieState: previous.cookieState || null,
            metadata: previous.metadata || {},
            ...clone(patch)
        };
        this.records.set(key, record);
        this.prune();
        return clone(record);
    }

    markSuccess(input = {}, patch = {}, ttlMs = null) {
        return this.upsert(input, {
            ...patch,
            lastSuccess: nowMs(),
            lastFail: null,
            failures: 0,
            reason: patch.reason || 'ok'
        }, ttlMs);
    }

    markFailure(input = {}, reason = 'failed', ttlMs = null) {
        const key = this.makeKey(input);
        const previous = this.records.get(key) || {};
        const failures = Number(previous.failures || 0) + 1;
        return this.upsert(input, {
            failures,
            lastFail: nowMs(),
            reason: String(reason || 'failed')
        }, ttlMs || this.failureTtlMs);
    }

    shouldAttempt(input = {}, retryBudget = null) {
        const record = this.get(input);
        if (!record) return { ok: true, reason: 'no_record', record: null };
        const hasExplicitBudget = retryBudget !== null && retryBudget !== undefined && retryBudget !== '';
        const budget = hasExplicitBudget && Number.isFinite(Number(retryBudget))
            ? Number(retryBudget)
            : Number(record.retryBudget || this.defaultRetryBudget);
        if (Number(record.failures || 0) >= budget) {
            return { ok: false, reason: record.reason || 'retry_budget_exhausted', record };
        }
        return { ok: true, reason: 'within_budget', record };
    }

    async singleFlight(input = {}, worker) {
        const key = this.makeKey(input);
        if (this.inflight.has(key)) return this.inflight.get(key);
        const promise = Promise.resolve()
            .then(worker)
            .finally(() => this.inflight.delete(key));
        this.inflight.set(key, promise);
        return promise;
    }

    async ensureState(input = {}, resolver, options = {}) {
        const existing = this.get(input);
        if (existing?.cookieState && !options.force) return existing.cookieState;
        const attempt = this.shouldAttempt(input, options.retryBudget);
        if (!attempt.ok) return null;

        return this.singleFlight(input, async () => {
            const current = this.get(input);
            if (current?.cookieState && !options.force) return current.cookieState;
            try {
                const state = await resolver();
                if (state) {
                    this.markSuccess(input, {
                        cookieState: clone(state),
                        metadata: options.metadata || {},
                        retryBudget: options.retryBudget !== null && options.retryBudget !== undefined && options.retryBudget !== '' && Number.isFinite(Number(options.retryBudget)) ? Number(options.retryBudget) : this.defaultRetryBudget,
                        reason: 'state_ready'
                    }, options.ttlMs || this.defaultTtlMs);
                    return state;
                }
                this.markFailure(input, 'state_missing', options.failureTtlMs || this.failureTtlMs);
                return null;
            } catch (error) {
                this.markFailure(input, error?.message || 'resolver_error', options.failureTtlMs || this.failureTtlMs);
                throw error;
            }
        });
    }

    prune() {
        if (this.records.size <= MAX_RECORDS) return;
        const now = nowMs();
        for (const [key, record] of this.records.entries()) {
            if (record.expiresAt && record.expiresAt <= now) this.records.delete(key);
        }
        if (this.records.size <= MAX_RECORDS) return;
        const victims = [...this.records.entries()]
            .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
            .slice(0, Math.ceil(MAX_RECORDS * 0.2));
        for (const [key] of victims) this.records.delete(key);
    }

    snapshot() {
        return [...this.records.values()].map((record) => clone(record));
    }
}

const captchaOrchestrator = new CaptchaOrchestrator({
    defaultTtlMs: envNumber('CAPTCHA_ORCHESTRATOR_TTL_MS', DEFAULT_TTL_MS, 5_000, 24 * 60 * 60_000),
    failureTtlMs: envNumber('CAPTCHA_ORCHESTRATOR_FAILURE_TTL_MS', DEFAULT_FAILURE_TTL_MS, 5_000, 30 * 60_000),
    defaultRetryBudget: envNumber('CAPTCHA_ORCHESTRATOR_RETRY_BUDGET', DEFAULT_RETRY_BUDGET, 1, 10)
});

module.exports = {
    CaptchaOrchestrator,
    captchaOrchestrator,
    createCaptchaKey,
    envFlag,
    envNumber,
    CAPTCHA_ORCHESTRATOR_DEFAULTS
};
