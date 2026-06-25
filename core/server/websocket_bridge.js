'use strict';

const { EventEmitter } = require('events');

const CF_TOKEN_CHANNEL = 'cf-token';

function normalizePart(value, fallback = '') {
  return String(value == null ? fallback : value).trim().toLowerCase() || fallback;
}

class CfTokenBridge extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.lastEventByKey = new Map();
    this.publishedCount = 0;
  }

  buildKey({ providerName = 'provider', host = '', egressKey = 'direct' } = {}) {
    return [
      normalizePart(providerName, 'provider'),
      normalizePart(host, ''),
      normalizePart(egressKey, 'direct')
    ].join('|');
  }

  publishTokenRefresh(payload = {}) {
    const event = {
      type: 'cf-token-refresh',
      providerName: normalizePart(payload.providerName, 'provider'),
      host: normalizePart(payload.host, ''),
      egressKey: normalizePart(payload.egressKey, 'direct'),
      expiresAt: Number(payload.expiresAt || 0) || 0,
      source: String(payload.source || 'unknown'),
      at: Date.now()
    };
    this.lastEventByKey.set(this.buildKey(event), event);
    this.publishedCount += 1;
    this.emit(CF_TOKEN_CHANNEL, event);
    return event;
  }

  publishTokenInvalidated(payload = {}) {
    const event = {
      type: 'cf-token-invalidated',
      providerName: normalizePart(payload.providerName, 'provider'),
      host: normalizePart(payload.host, ''),
      egressKey: normalizePart(payload.egressKey, 'direct'),
      reason: String(payload.reason || 'unknown'),
      at: Date.now()
    };
    this.lastEventByKey.delete(this.buildKey(event));
    this.emit(CF_TOKEN_CHANNEL, event);
    return event;
  }

  onTokenEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    this.on(CF_TOKEN_CHANNEL, listener);
    return () => this.off(CF_TOKEN_CHANNEL, listener);
  }

  onTokenRefresh(listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (event) => {
      if (event && event.type === 'cf-token-refresh') listener(event);
    };
    this.on(CF_TOKEN_CHANNEL, wrapped);
    return () => this.off(CF_TOKEN_CHANNEL, wrapped);
  }

  getLastEvent(selector = {}) {
    return this.lastEventByKey.get(this.buildKey(selector)) || null;
  }

  getState() {
    return {
      channel: CF_TOKEN_CHANNEL,
      published: this.publishedCount,
      tracked: this.lastEventByKey.size,
      listeners: this.listenerCount(CF_TOKEN_CHANNEL)
    };
  }
}

const cfTokenBridge = new CfTokenBridge();

module.exports = {
  cfTokenBridge,
  CfTokenBridge,
  CF_TOKEN_CHANNEL
};
