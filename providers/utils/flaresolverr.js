'use strict';

const axios = require('axios');
const { isCanceledError: defaultIsCanceledError } = require('./bypass');

const DEFAULT_FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191/v1';

function createCircuitBreaker({ threshold = 3, resetMs = 60000 } = {}) {
    return {
        failures: 0,
        lastFailure: 0,
        isOpen() {
            if (this.failures < threshold) return false;
            if (Date.now() - this.lastFailure > resetMs) {
                this.failures = 0;
                return false;
            }
            return true;
        },
        record(ok) {
            if (ok) {
                this.failures = 0;
                return;
            }
            this.failures++;
            this.lastFailure = Date.now();
        }
    };
}

function buildSessionData(solution = {}) {
    const solutionCookies = Array.isArray(solution.cookies) ? solution.cookies : [];
    const cookies = solutionCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const cf_clearance = solutionCookies.find((cookie) => cookie.name === 'cf_clearance')?.value || null;

    return {
        userAgent: solution.userAgent,
        cookies,
        cf_clearance,
        url: solution.url,
        response: solution.response,
        timestamp: Date.now()
    };
}

function createFlareSolverrClient({
    endpoint = DEFAULT_FLARESOLVERR_URL,
    providerName = 'provider',
    sessionId = null,
    circuitThreshold = 3,
    circuitResetMs = 60000,
    maxRetries = 2,
    retryDelayMs = 1500,
    maxTimeout = 90000,
    requestTimeout = 100000,
    isCanceledError = defaultIsCanceledError,
    onSolution = null
} = {}) {
    const activeBypasses = new Map();
    const breaker = createCircuitBreaker({ threshold: circuitThreshold, resetMs: circuitResetMs });

    async function getClearance(url, options = {}) {
        const provider = options.providerName || providerName;
        const session = options.sessionId || sessionId || `session_${provider}`;
        const key = session || provider;

        if (breaker.isOpen()) return null;
        if (activeBypasses.has(key)) return activeBypasses.get(key);

        const bypassPromise = (async () => {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                if (attempt > 0) {
                    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (2 ** (attempt - 1))));
                }

                try {
                    const method = String(options.method || 'GET').toUpperCase();
                    const payload = {
                        cmd: method === 'POST' ? 'request.post' : 'request.get',
                        url,
                        maxTimeout,
                        session
                    };

                    if (method === 'POST' && options.body) payload.postData = options.body;

                    const response = await axios.post(endpoint, payload, {
                        timeout: requestTimeout,
                        signal: options.signal,
                        headers: { 'Content-Type': 'application/json' }
                    });

                    if (response.data?.status === 'ok') {
                        const data = buildSessionData(response.data?.solution || {});
                        if (onSolution) await onSolution(data, response.data);
                        breaker.record(true);
                        return data;
                    }
                } catch (error) {
                    if (isCanceledError(error)) throw error;
                }
            }

            breaker.record(false);
            return null;
        })();

        bypassPromise.finally(() => activeBypasses.delete(key)).catch(() => {});
        activeBypasses.set(key, bypassPromise);
        return bypassPromise;
    }

    return {
        getClearance,
        breaker,
        clearActiveBypasses: () => activeBypasses.clear()
    };
}

module.exports = {
    DEFAULT_FLARESOLVERR_URL,
    createCircuitBreaker,
    createFlareSolverrClient
};
