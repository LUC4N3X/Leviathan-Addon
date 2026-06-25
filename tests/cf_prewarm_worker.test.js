'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCfPrewarmWorker,
  resolveTargets,
  parseProviderList
} = require('../core/workers/cf_prewarm_worker');
const { CfTokenBridge } = require('../core/server/websocket_bridge');

function makeStore(metaByProvider) {
  return {
    sessionTtlSeconds: 6 * 60 * 60,
    isEnabled: () => true,
    getProviderSessionMeta: async ({ providerName }) => {
      const meta = metaByProvider[providerName] || { session: null, secondsRemaining: 0, expiresAt: 0 };
      return { expiringSoon: true, ...meta };
    }
  };
}

test('resolveTargets expands provider domains and deduplicates', () => {
  const cb01 = resolveTargets(['cb01']);
  assert.equal(cb01.length, 1);
  assert.equal(cb01[0].providerName, 'cb01');
  assert.equal(cb01[0].host, 'cb01uno.lol');

  const vix = resolveTargets(['streamingcommunity']);
  assert.equal(vix[0].origin, 'https://vixsrc.to');

  assert.equal(resolveTargets(['does-not-exist']).length, 0);
});

test('parseProviderList falls back to all known providers', () => {
  const list = parseProviderList();
  assert.ok(list.includes('streamingcommunity'));
  assert.ok(list.includes('cb01'));
});

test('pre-warm worker is inert when disabled', async () => {
  const worker = createCfPrewarmWorker({
    enabled: false,
    providerIds: ['streamingcommunity'],
    store: makeStore({}),
    bridge: new CfTokenBridge(),
    createBypass: () => ({ ensureReady: async () => true }),
    logger: { info() {}, warn() {} }
  });

  assert.equal(worker.start({ leader: true }), false);
  const outcome = await worker.runOnce();
  assert.equal(outcome.ran, false);
});

test('pre-warm worker refreshes expiring tokens and broadcasts them fast', async () => {
  const bridge = new CfTokenBridge();
  const events = [];
  bridge.onTokenRefresh((event) => events.push(event));

  const store = makeStore({
    streamingcommunity: { session: { userAgent: 'x' }, secondsRemaining: 30, expiresAt: Date.now() + 30_000 }
  });

  let ensureCalls = 0;
  const worker = createCfPrewarmWorker({
    enabled: true,
    leader: true,
    providerIds: ['streamingcommunity'],
    leadSeconds: 300,
    store,
    bridge,
    createBypass: () => ({
      ensureReady: async (reason) => {
        ensureCalls += 1;
        assert.equal(reason, 'prewarm');
        return true;
      }
    }),
    logger: { info() {}, warn() {} }
  });

  const startedAt = Date.now();
  const outcome = await worker.runOnce();

  assert.equal(outcome.ran, true);
  assert.equal(ensureCalls >= 1, true);
  assert.equal(outcome.results.some((item) => item.action === 'refresh'), true);
  assert.equal(events.length >= 1, true);
  assert.equal(events[0].source, 'cf-prewarm');
  assert.ok(Date.now() - startedAt < 500);
});

test('pre-warm worker skips tokens that are still fresh', async () => {
  const bridge = new CfTokenBridge();
  const events = [];
  bridge.onTokenRefresh((event) => events.push(event));

  const store = makeStore({
    streamingcommunity: { session: { userAgent: 'x' }, secondsRemaining: 4000, expiresAt: Date.now() + 4_000_000 }
  });

  let ensureCalls = 0;
  const worker = createCfPrewarmWorker({
    enabled: true,
    leader: true,
    providerIds: ['streamingcommunity'],
    leadSeconds: 300,
    store,
    bridge,
    createBypass: () => ({ ensureReady: async () => { ensureCalls += 1; return true; } }),
    logger: { info() {}, warn() {} }
  });

  const outcome = await worker.runOnce();
  assert.equal(outcome.results[0].action, 'skip');
  assert.equal(ensureCalls, 0);
  assert.equal(events.length, 0);
});

test('pre-warm worker reports failures without throwing', async () => {
  const store = makeStore({
    streamingcommunity: { session: null, secondsRemaining: 0, expiresAt: 0 }
  });

  const worker = createCfPrewarmWorker({
    enabled: true,
    leader: true,
    providerIds: ['streamingcommunity'],
    store,
    bridge: new CfTokenBridge(),
    createBypass: () => ({ ensureReady: async () => { throw new Error('challenge 503'); } }),
    logger: { info() {}, warn() {} }
  });

  const outcome = await worker.runOnce();
  assert.equal(outcome.results[0].action, 'error');
  assert.match(outcome.results[0].error, /503/);
  assert.equal(worker.getState().stats.failed >= 1, true);
});
