'use strict';

const { normalizeFailureType } = require('../../core/intelligence/provider_failure_classifier');

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function normalizeFallback(fallback) {
    if (!fallback) return null;
    if (typeof fallback === 'string') return { id: fallback, name: fallback, enabled: true };
    if (typeof fallback === 'object') {
        return {
            ...fallback,
            id: String(fallback.id || fallback.name || fallback.type || '').trim(),
            name: String(fallback.name || fallback.id || fallback.type || '').trim(),
            enabled: fallback.enabled !== false
        };
    }
    return null;
}

function normalizeFallbackReason(reason = null) {
    if (!reason) return { type: 'empty_results', reason: 'empty_results', status: 0 };
    if (typeof reason === 'string') return { type: normalizeFailureType(reason), reason, status: 0 };

    const status = Number(reason.status || reason.statusCode || reason.response?.status || 0) || 0;
    const rawType = reason.type || reason.failureType || reason.status || reason.code || reason.reason || '';
    const type = normalizeFailureType(rawType || (status ? `http_${status}` : 'unknown'));
    return {
        type,
        reason: String(reason.reason || reason.message || reason.code || type || 'unknown').slice(0, 300),
        status,
        recoverable: reason.recoverable === true,
        canFallback: reason.canFallback !== false
    };
}

function shouldTryFallback(errorOrResult) {
    if (!errorOrResult) return true;
    const reason = normalizeFallbackReason(errorOrResult);
    if (reason.canFallback === false) return false;
    if (['selector_miss', 'layout_changed', 'empty_results', 'timeout', 'network_error', 'blocked', 'rate_limited', 'not_found', 'upstream_error'].includes(reason.type)) {
        return true;
    }
    const status = Number(reason.status || 0);
    if (status === 0) return true;
    return status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

class ProviderFallbackManager {
    constructor({ logger = null } = {}) {
        this.logger = logger;
    }

    getFallbacks(recipe = {}, reason = null) {
        const normalizedReason = normalizeFallbackReason(reason);
        return asArray(recipe.fallback || recipe.fallbacks)
            .map(normalizeFallback)
            .filter((fallback) => fallback && fallback.id && fallback.enabled !== false)
            .filter((fallback) => {
                const triggerOn = asArray(fallback.triggerOn || fallback.on);
                if (triggerOn.length === 0) return true;
                return triggerOn.includes(normalizedReason.type) || triggerOn.includes(normalizedReason.reason);
            });
    }

    async runFallbacks({ recipe = {}, context = {}, reason = null, runner }) {
        if (typeof runner !== 'function') return { results: [], attempts: [] };

        const normalizedReason = normalizeFallbackReason(reason);
        const attempts = [];
        const results = [];
        for (const fallback of this.getFallbacks(recipe, normalizedReason)) {
            const startedAt = Date.now();
            try {
                const value = await runner(fallback, context, normalizedReason);
                const list = Array.isArray(value) ? value : (value ? [value] : []);
                attempts.push({
                    fallback: fallback.id,
                    ok: true,
                    count: list.length,
                    ms: Date.now() - startedAt,
                    reason: normalizedReason.type
                });
                results.push(...list);
                if (list.length > 0 && fallback.stopOnHit !== false) break;
            } catch (error) {
                attempts.push({
                    fallback: fallback.id,
                    ok: false,
                    error: error?.message || String(error),
                    ms: Date.now() - startedAt,
                    reason: normalizedReason.type
                });
            }
        }

        return { results, attempts, reason: normalizedReason };
    }
}

module.exports = {
    ProviderFallbackManager,
    normalizeFallback,
    normalizeFallbackReason,
    shouldTryFallback
};
