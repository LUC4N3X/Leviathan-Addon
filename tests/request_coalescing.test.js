'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withSharedPromise } = require('../core/utils/common');
const { SingleFlight } = require('../providers/utils/provider_runtime');

test('withSharedPromise shares concurrent work and preserves empty stream results', async () => {
  const inflight = new Map();
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = withSharedPromise(inflight, 'stream:tt123', async () => {
    executions += 1;
    await gate;
    return [];
  });
  const second = withSharedPromise(inflight, 'stream:tt123', async () => {
    executions += 1;
    return [{ title: 'duplicate' }];
  });

  assert.equal(inflight.size, 1);
  release();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, []);
  assert.strictEqual(secondResult, firstResult);
  assert.equal(executions, 1);
  assert.equal(inflight.size, 0);
});

test('withSharedPromise releases keys after failures', async () => {
  const inflight = new Map();
  let executions = 0;

  await assert.rejects(
    withSharedPromise(inflight, 'provider:search', async () => {
      executions += 1;
      throw new Error('provider failed');
    }),
    /provider failed/
  );

  assert.equal(inflight.size, 0);

  const retry = await withSharedPromise(inflight, 'provider:search', async () => {
    executions += 1;
    return false;
  });

  assert.equal(retry, false);
  assert.equal(executions, 2);
  assert.equal(inflight.size, 0);
});

test('withSharedPromise stale completion does not delete a replacement task', async () => {
  const inflight = new Map();
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });

  const first = withSharedPromise(inflight, 'same-key', async () => {
    await firstGate;
    return 'old';
  });

  inflight.delete('same-key');

  const second = withSharedPromise(inflight, 'same-key', async () => {
    await secondGate;
    return 'new';
  });

  releaseFirst();
  assert.equal(await first, 'old');
  assert.equal(inflight.has('same-key'), true);

  releaseSecond();
  assert.equal(await second, 'new');
  assert.equal(inflight.size, 0);
});

test('withSharedPromise bounds inflight maps by evicting oldest keys', async () => {
  const inflight = new Map();
  const gates = [];
  const releases = [];
  const evictions = [];

  for (let i = 0; i < 3; i += 1) {
    gates[i] = new Promise((resolve) => { releases[i] = resolve; });
  }

  const first = withSharedPromise(inflight, 'a', async () => {
    await gates[0];
    return 'a';
  }, { maxEntries: 2, onEvict: (count) => evictions.push(count) });
  const second = withSharedPromise(inflight, 'b', async () => {
    await gates[1];
    return 'b';
  }, { maxEntries: 2, onEvict: (count) => evictions.push(count) });
  const third = withSharedPromise(inflight, 'c', async () => {
    await gates[2];
    return 'c';
  }, { maxEntries: 2, onEvict: (count) => evictions.push(count) });

  assert.equal(inflight.has('a'), false);
  assert.equal(inflight.has('b'), true);
  assert.equal(inflight.has('c'), true);
  assert.deepEqual(evictions, [1]);

  releases[0]();
  releases[1]();
  releases[2]();

  assert.deepEqual(await Promise.all([first, second, third]), ['a', 'b', 'c']);
  assert.equal(inflight.size, 0);
});

test('SingleFlight shares falsey results without treating them as failures', async () => {
  const singleFlight = new SingleFlight('test-singleflight');
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = singleFlight.run('cache-negative', async () => {
    executions += 1;
    await gate;
    return 0;
  });
  const second = singleFlight.run('cache-negative', async () => {
    executions += 1;
    return 1;
  });

  assert.equal(singleFlight.has('cache-negative'), true);
  release();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, 0);
  assert.equal(secondResult, 0);
  assert.equal(executions, 1);
  assert.equal(singleFlight.has('cache-negative'), false);
});

test('SingleFlight clears failed work so retries can start fresh', async () => {
  const singleFlight = new SingleFlight('test-singleflight-retry');
  let executions = 0;

  await assert.rejects(
    singleFlight.run('unstable-provider', async () => {
      executions += 1;
      throw new Error('temporary failure');
    }),
    /temporary failure/
  );

  assert.equal(singleFlight.has('unstable-provider'), false);

  const retry = await singleFlight.run('unstable-provider', async () => {
    executions += 1;
    return '';
  });

  assert.equal(retry, '');
  assert.equal(executions, 2);
  assert.equal(singleFlight.has('unstable-provider'), false);
});
