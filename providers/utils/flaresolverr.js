'use strict';

// Deprecated compatibility layer.
// New provider code should use provider_http_guard.js / cf_clearance_manager.js.

const {
    createCfClearanceManager,
    normalizeFlareEndpoint
} = require('./cf_clearance_manager');

const DEFAULT_FLARESOLVERR_URL = normalizeFlareEndpoint(process.env.FLARESOLVERR_URL);

function createFlareSolverrClient(options = {}) {
    const manager = createCfClearanceManager({
        providerName: options.providerName || 'legacy',
        endpoint: options.endpoint || DEFAULT_FLARESOLVERR_URL,
        sessionTtlMs: options.sessionTtlMs,
        cooldownMs: options.cooldownMs,
        solveTimeoutMs: options.maxTimeout || options.solveTimeoutMs,
        httpAgent: options.httpAgent,
        httpsAgent: options.httpsAgent,
        isCanceledError: options.isCanceledError,
        onSession: (session) => {
            if (typeof options.onSolution === 'function') options.onSolution(session);
        },
        logger: options.logger
    });

    return {
        getClearance(url, requestOptions = {}) {
            return manager.solve(url, requestOptions.signal || null, {
                triggerUrl: requestOptions.triggerUrl || url,
                method: requestOptions.method || 'GET',
                force: requestOptions.force !== false,
                maxTimeout: requestOptions.maxTimeout || options.maxTimeout || options.solveTimeoutMs,
                userAgent: requestOptions.userAgent
            });
        },
        reset() {},
        isFresh(session) {
            return manager.isFresh(session);
        }
    };
}

module.exports = {
    createFlareSolverrClient,
    DEFAULT_FLARESOLVERR_URL
};
