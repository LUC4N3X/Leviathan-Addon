'use strict';

const { getBody } = require('../../core/intelligence/provider_failure_classifier');
const { runProviderRecovery } = require('../../core/intelligence/provider_recovery_intelligence');

function extractResponseBody(response = null) {
    return getBody(response);
}

async function runProviderRecoveryBridge({ response = null, recipe = {}, context = {}, failure = null, logger = null } = {}) {
    const startedAt = Date.now();
    try {
        const pass = runProviderRecovery({
            html: extractResponseBody(response),
            response,
            recipe,
            context,
            failure
        });
        pass.attempt.ms = Date.now() - startedAt;
        if (pass.results.length > 0 && logger?.debug) {
            logger.debug(`[PROVIDER RECOVERY] ${recipe.id || recipe.name}: recovered ${pass.results.length} candidates (${pass.attempt.topScore || 0})`);
        }
        return pass;
    } catch (error) {
        if (logger?.warn) logger.warn(`[PROVIDER RECOVERY] ${recipe.id || recipe.name}: ${error?.message || error}`);
        return {
            results: [],
            attempt: {
                stage: 'recovery',
                ok: false,
                error: error?.message || String(error),
                ms: Date.now() - startedAt
            }
        };
    }
}

module.exports = {
    extractResponseBody,
    runProviderRecoveryBridge
};
