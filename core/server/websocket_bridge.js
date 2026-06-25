'use strict';

const { EventEmitter } = require('events');
const { logger } = require('../utils/runtime');

// A simple internal EventBus (or WebSocket equivalent for inter-process/inter-module)
// For a multi-node cluster, this could use Redis Pub/Sub. Here we use an EventEmitter
// as a local bridge to broadcast CF clearances instantly.
class RealtimeBridge extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
        this.knownTokens = new Map();
    }

    broadcastClearance(providerName, url, cookies, userAgent) {
        const key = `${providerName}:${url}`;
        this.knownTokens.set(key, { cookies, userAgent, timestamp: Date.now() });
        
        logger.info(`[BRIDGE] Broadcasting CF clearance for ${providerName}`);
        this.emit('clearance_updated', { providerName, url, cookies, userAgent });
    }

    subscribeClearance(callback) {
        this.on('clearance_updated', callback);
        return () => this.off('clearance_updated', callback);
    }

    getLatestClearance(providerName, url) {
        return this.knownTokens.get(`${providerName}:${url}`);
    }
}

const globalBridge = new RealtimeBridge();

module.exports = {
    globalBridge,
    broadcastClearance: globalBridge.broadcastClearance.bind(globalBridge),
    subscribeClearance: globalBridge.subscribeClearance.bind(globalBridge),
    getLatestClearance: globalBridge.getLatestClearance.bind(globalBridge)
};
