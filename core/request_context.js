'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { sanitizeRequestPath } = require('./utils/redaction');

const requestContext = new AsyncLocalStorage();

function generateRequestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
}

function getRequestContext() {
    return requestContext.getStore() || null;
}

function getRequestId() {
    return getRequestContext()?.requestId || null;
}

function runWithRequestContext(context, handler) {
    return requestContext.run(context, handler);
}

function requestContextMiddleware(req, res, next) {
    const incomingRequestId = String(req.headers['x-request-id'] || '').trim();
    const requestId = incomingRequestId || generateRequestId();
    const context = {
        requestId,
        method: req.method,
        path: sanitizeRequestPath(req.originalUrl || req.url || ''),
        startedAt: Date.now()
    };

    req.requestId = requestId;
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    runWithRequestContext(context, () => next());
}

module.exports = {
    requestContext,
    generateRequestId,
    getRequestContext,
    getRequestId,
    runWithRequestContext,
    requestContextMiddleware
};
