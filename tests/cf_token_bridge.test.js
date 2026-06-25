'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CfTokenBridge, cfTokenBridge, CF_TOKEN_CHANNEL } = require('../core/server/websocket_bridge');

test('cf token bridge broadcasts refresh events to subscribers', () => {
  const bridge = new CfTokenBridge();
  const received = [];
  const unsubscribe = bridge.onTokenRefresh((event) => received.push(event));

  const published = bridge.publishTokenRefresh({
    providerName: 'StreamingCommunity',
    host: 'vixsrc.to',
    egressKey: 'direct',
    expiresAt: Date.now() + 60_000,
    source: 'cf-prewarm'
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'cf-token-refresh');
  assert.equal(received[0].providerName, 'streamingcommunity');
  assert.equal(received[0].host, 'vixsrc.to');
  assert.equal(published.source, 'cf-prewarm');

  const last = bridge.getLastEvent({ providerName: 'streamingcommunity', host: 'vixsrc.to', egressKey: 'direct' });
  assert.equal(last.type, 'cf-token-refresh');

  unsubscribe();
  bridge.publishTokenRefresh({ providerName: 'streamingcommunity', host: 'vixsrc.to' });
  assert.equal(received.length, 1);
});

test('cf token bridge tracks invalidation and exposes state', () => {
  const bridge = new CfTokenBridge();
  bridge.publishTokenRefresh({ providerName: 'cb01', host: 'cb01uno.lol' });
  assert.ok(bridge.getLastEvent({ providerName: 'cb01', host: 'cb01uno.lol' }));

  bridge.publishTokenInvalidated({ providerName: 'cb01', host: 'cb01uno.lol', reason: 'burned' });
  assert.equal(bridge.getLastEvent({ providerName: 'cb01', host: 'cb01uno.lol' }), null);

  const state = bridge.getState();
  assert.equal(state.channel, CF_TOKEN_CHANNEL);
  assert.ok(state.published >= 1);
});

test('cf token bridge exposes a shared singleton', () => {
  assert.ok(cfTokenBridge instanceof CfTokenBridge);
});
