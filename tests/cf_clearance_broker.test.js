'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createClearanceBroker } = require('../providers/utils/cf_clearance_broker');

test('clearance broker coalesces concurrent attempts for the same strategy key', async () => {
  const broker = createClearanceBroker({ enabled: true });
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const run = () => broker.run({
    strategy: 'h2_replay',
    url: 'https://guardoserie.run/movie/apex/',
    coalesceKey: 'GET:https://guardoserie.run/movie/apex/',
    cooldownMs: 30_000,
    runner: async () => {
      calls += 1;
      await gate;
      return { status: 200, body: '<html><body>OK</body></html>' };
    },
    isUsable: (result) => result?.status === 200 && String(result.body || '').includes('OK')
  });

  const first = run();
  const second = run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'hit');
  assert.equal(b.status, 'hit');
  assert.equal(a.shared, false);
  assert.equal(b.shared, true);

  const state = broker.state();
  assert.equal(state.inflight, 0);
  assert.equal(state.strategies.h2_replay.attempts, 1);
  assert.equal(state.strategies.h2_replay.hits, 1);
  assert.equal(state.strategies.h2_replay.sharedHits, 1);
});

test('clearance broker backs off after misses and clears cooldown after a hit', async () => {
  let now = 1_000;
  const broker = createClearanceBroker({
    enabled: true,
    now: () => now,
    maxCooldownMs: 60_000
  });

  const miss = await broker.run({
    strategy: 'h2_replay',
    url: 'https://guardoserie.run/movie/apex/',
    cooldownMs: 5_000,
    runner: async () => ({ status: 403, body: '<html><title>Just a moment...</title></html>' }),
    isUsable: () => false
  });

  assert.equal(miss.status, 'miss');

  const skipped = await broker.run({
    strategy: 'h2_replay',
    url: 'https://guardoserie.run/movie/apex/',
    cooldownMs: 5_000,
    runner: async () => {
      throw new Error('runner should not be called during cooldown');
    },
    isUsable: () => true
  });

  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'cooldown');
  assert.ok(skipped.cooldownRemainingMs > 0);

  now += 5_001;

  const hit = await broker.run({
    strategy: 'h2_replay',
    url: 'https://guardoserie.run/movie/apex/',
    cooldownMs: 5_000,
    runner: async () => ({ status: 200, body: '<html><body>Fresh</body></html>' }),
    isUsable: () => true
  });

  assert.equal(hit.status, 'hit');

  const strategyState = broker.state().hosts['guardoserie.run'].strategies.h2_replay;
  assert.equal(strategyState.consecutiveFailures, 0);
  assert.equal(strategyState.cooldownRemainingMs, 0);
  assert.equal(strategyState.hits, 1);
  assert.equal(strategyState.misses, 1);
  assert.equal(strategyState.skips, 1);
});
