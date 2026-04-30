"use strict";

const cluster = require('cluster');
const { EventEmitter } = require('events');

const CHANNEL = 'leviathan:cache_invalidation';
const emitter = new EventEmitter();
let primaryBusReady = false;
let workerBusReady = false;

function setupPrimaryCacheInvalidationBus() {
    if (primaryBusReady || !cluster.isPrimary) return;
    primaryBusReady = true;

    cluster.on('message', (worker, message) => {
        if (!message || message.channel !== CHANNEL || !message.payload) return;
        for (const candidate of Object.values(cluster.workers || {})) {
            if (!candidate || !candidate.process) continue;
            if (candidate.process.pid === worker.process.pid) continue;
            try {
                candidate.send({ channel: CHANNEL, payload: message.payload });
            } catch (_) {}
        }
    });
}

function initCacheInvalidationListener() {
    if (workerBusReady) return;
    workerBusReady = true;

    process.on('message', (message) => {
        if (!message || message.channel !== CHANNEL || !message.payload) return;
        emitter.emit('event', message.payload);
    });
}

function publishCacheInvalidation(payload) {
    if (!payload || typeof payload !== 'object' || !payload.type) return;
    emitter.emit('event', payload);
    if (cluster.isWorker && typeof process.send === 'function') {
        try {
            process.send({ channel: CHANNEL, payload });
        } catch (_) {}
    }
}

function subscribeCacheInvalidation(handler) {
    if (typeof handler !== 'function') return () => {};
    emitter.on('event', handler);
    return () => emitter.off('event', handler);
}

module.exports = {
    setupPrimaryCacheInvalidationBus,
    initCacheInvalidationListener,
    publishCacheInvalidation,
    subscribeCacheInvalidation
};
