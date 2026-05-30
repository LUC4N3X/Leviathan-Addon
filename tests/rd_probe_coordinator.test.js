'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRdProbeCoordinator,
  buildProbeKey
} = require('../core/debrid/rd/probe/rd_probe_coordinator');

function createGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function cachedResult(hash) {
  return {
    hash,
    cached: true,
    state: 'likely_cached',
    rd_status: 'downloaded'
  };
}

test('coalesces concurrent probes for the same token and media context', async () => {
  const coordinator = createRdProbeCoordinator({ concurrency: 2 });
  const gate = createGate();
  let calls = 0;

  const first = coordinator.schedule({
    token: 'user-token',
    hash: 'ABC123',
    context: { season: 1, episode: 2, fileIdx: 3 },
    priority: 'foreground',
    execute: async () => {
      calls += 1;
      await gate.promise;
      return cachedResult('abc123');
    }
  });
  const second = coordinator.schedule({
    token: 'user-token',
    hash: 'abc123',
    context: { season: 1, episode: 2, fileIdx: 3 },
    priority: 'view_scan',
    execute: async () => {
      calls += 1;
      return cachedResult('abc123');
    }
  });

  assert.strictEqual(first, second);
  gate.release();

  assert.deepEqual(await first, cachedResult('abc123'));
  assert.equal(calls, 1);
  assert.equal(coordinator.status().metrics.coalescedHits, 1);
});

test('does not reuse probes across different RD tokens', async () => {
  const coordinator = createRdProbeCoordinator({ concurrency: 2 });
  let calls = 0;

  await Promise.all([
    coordinator.schedule({
      token: 'token-a',
      hash: 'same-hash',
      execute: async () => {
        calls += 1;
        return cachedResult('same-hash');
      }
    }),
    coordinator.schedule({
      token: 'token-b',
      hash: 'same-hash',
      execute: async () => {
        calls += 1;
        return cachedResult('same-hash');
      }
    })
  ]);

  assert.equal(calls, 2);
});

test('reuses recent non-deferred results for the same probe key', async () => {
  const coordinator = createRdProbeCoordinator({ recentTtlMs: 60_000 });
  let calls = 0;

  const runProbe = () => coordinator.schedule({
    token: 'user-token',
    hash: 'recent-hash',
    execute: async () => {
      calls += 1;
      return cachedResult('recent-hash');
    }
  });

  assert.deepEqual(await runProbe(), cachedResult('recent-hash'));
  assert.deepEqual(await runProbe(), cachedResult('recent-hash'));
  assert.equal(calls, 1);
  assert.equal(coordinator.status().metrics.recentHits, 1);
});

test('runs queued foreground work before lower-priority background work', async () => {
  const coordinator = createRdProbeCoordinator({ concurrency: 1 });
  const gate = createGate();
  const order = [];

  const active = coordinator.schedule({
    token: 'token',
    hash: 'active',
    priority: 'auditor',
    execute: async () => {
      order.push('active');
      await gate.promise;
      return cachedResult('active');
    }
  });
  const background = coordinator.schedule({
    token: 'token',
    hash: 'background',
    priority: 'auditor',
    execute: async () => {
      order.push('background');
      return cachedResult('background');
    }
  });
  const foreground = coordinator.schedule({
    token: 'token',
    hash: 'foreground',
    priority: 'foreground',
    execute: async () => {
      order.push('foreground');
      return cachedResult('foreground');
    }
  });

  gate.release();
  await Promise.all([active, background, foreground]);

  assert.deepEqual(order, ['active', 'foreground', 'background']);
});

test('defers low-priority work when the queue is saturated', async () => {
  const coordinator = createRdProbeCoordinator({
    concurrency: 1,
    maxQueue: 1
  });
  const gate = createGate();

  const active = coordinator.schedule({
    token: 'token',
    hash: 'active',
    priority: 'auditor',
    execute: async () => {
      await gate.promise;
      return cachedResult('active');
    }
  });
  const queued = coordinator.schedule({
    token: 'token',
    hash: 'queued',
    priority: 'auditor',
    execute: async () => cachedResult('queued')
  });
  const deferred = await coordinator.schedule({
    token: 'token',
    hash: 'deferred',
    priority: 'auditor',
    execute: async () => cachedResult('deferred')
  });

  assert.equal(deferred.cached, false);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.state, 'probing');
  assert.equal(deferred.error, 'coordinator_queue_full');

  gate.release();
  await Promise.all([active, queued]);

  assert.equal(coordinator.status().metrics.droppedLowPriority, 1);
});

test('turns unexpected execution errors into deferred results', async () => {
  const coordinator = createRdProbeCoordinator();

  const result = await coordinator.schedule({
    token: 'token',
    hash: 'failure',
    execute: async () => {
      throw new Error('temporary outage');
    }
  });

  assert.equal(result.cached, false);
  assert.equal(result.deferred, true);
  assert.equal(result.state, 'probing');
  assert.match(result.error, /temporary outage/);
});

test('probe keys include token fingerprint and episode file context', () => {
  const base = {
    token: 'token-a',
    hash: 'HASH',
    context: { season: 1, episode: 2, fileIdx: 3 }
  };

  assert.equal(buildProbeKey(base), buildProbeKey({
    ...base,
    hash: 'hash'
  }));
  assert.notEqual(buildProbeKey(base), buildProbeKey({
    ...base,
    token: 'token-b'
  }));
  assert.notEqual(buildProbeKey(base), buildProbeKey({
    ...base,
    context: { season: 1, episode: 3, fileIdx: 3 }
  }));
  assert.notEqual(buildProbeKey(base), buildProbeKey({
    ...base,
    context: { season: 1, episode: 2, fileIdx: 4 }
  }));
});
