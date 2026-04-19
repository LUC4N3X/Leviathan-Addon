'use strict';

const { scheduleKeyed } = require('./utils_limits');
const { getRequestId } = require('./request_context');

function buildRequestQueueKey(scope, key) {
    const requestId = getRequestId() || 'no-request';
    return `${requestId}:${String(scope || 'default')}:${String(key || 'default')}`;
}

function scheduleRequestTask(scope, key, task, options = {}) {
    const queueGroup = String(options.group || 'request').trim() || 'request';
    const queueKey = buildRequestQueueKey(scope, key);
    return scheduleKeyed(queueGroup, queueKey, task, options);
}

module.exports = {
    buildRequestQueueKey,
    scheduleRequestTask
};
