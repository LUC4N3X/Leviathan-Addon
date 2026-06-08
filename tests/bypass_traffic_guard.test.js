'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeBypassCacheKey,
  runWithBypassTrafficGuard,
  withBypassRequestCoalescing,
  withBypassResponseCache
} = require('../providers/utils/bypass_traffic_guard');

test('bypass traffic guard coalesces identical in-flight work', async () => {
  let calls = 0;
  const run = () => withBypassRequestCoalescing('unit:coalesce', async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { ok: true, calls };
  });

  const [a, b, c] = await Promise.all([run(), run(), run()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('bypass traffic guard caches short-lived responses', async () => {
  let calls = 0;
  const key = makeBypassCacheKey('unit:cache', 'https://example.test/path?q=1');
  const run = () => withBypassResponseCache(key, async () => {
    calls += 1;
    return `value-${calls}`;
  }, { ttlMs: 1000, staleMs: 2000 });

  assert.equal(await run(), 'value-1');
  assert.equal(await run(), 'value-1');
  assert.equal(calls, 1);
});

test('bypass traffic guard rate-limits per provider/origin key', async () => {
  const started = [];
  await Promise.all([
    runWithBypassTrafficGuard('https://rate.example/a', async () => { started.push(Date.now()); return 1; }, { kind: 'site', providerName: 'unit-rate', minIntervalMs: 30, maxConcurrency: 1, maxQueue: 10 }),
    runWithBypassTrafficGuard('https://rate.example/b', async () => { started.push(Date.now()); return 2; }, { kind: 'site', providerName: 'unit-rate', minIntervalMs: 30, maxConcurrency: 1, maxQueue: 10 })
  ]);

  assert.equal(started.length, 2);
  assert.ok(started[1] - started[0] >= 20);
});
