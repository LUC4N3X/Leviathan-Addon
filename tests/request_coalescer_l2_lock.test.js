'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RequestCoalescer, buildRequestCoalescingKey } = require('../core/cache/request_coalescer');

class FakeRedis {
  constructor() {
    this.enabled = true;
    this.values = new Map();
    this.locks = new Map();
  }

  isEnabled() { return this.enabled; }

  _key(namespace, key) { return `${namespace}:${key}`; }

  async getJson(namespace, key) {
    const entry = this.values.get(this._key(namespace, key));
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(this._key(namespace, key));
      return undefined;
    }
    return entry.value;
  }

  async setJson(namespace, key, value, ttlSeconds) {
    this.values.set(this._key(namespace, key), {
      value,
      expiresAt: Date.now() + (Math.max(1, Number(ttlSeconds) || 1) * 1000)
    });
    return true;
  }

  async setIfAbsent(namespace, key, value, ttlMs) {
    const fullKey = this._key(namespace, key);
    const current = this.locks.get(fullKey);
    if (current && current.expiresAt > Date.now()) return false;
    this.locks.set(fullKey, { value, expiresAt: Date.now() + Math.max(1, Number(ttlMs) || 1) });
    return true;
  }

  async releaseLock(namespace, key, token) {
    const fullKey = this._key(namespace, key);
    const current = this.locks.get(fullKey);
    if (current && current.value === token) {
      this.locks.delete(fullKey);
      return true;
    }
    return false;
  }
}

test('RequestCoalescer shares local concurrent work', async () => {
  const redis = new FakeRedis();
  redis.enabled = false;
  const coalescer = new RequestCoalescer({ namespace: 'testLocal', redis, distributed: false, pollMs: 5, waitMs: 50 });
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = coalescer.runDetailed('same', async () => {
    executions += 1;
    await gate;
    return { streams: [] };
  });
  const second = coalescer.runDetailed('same', async () => {
    executions += 1;
    return { streams: [{ title: 'duplicate' }] };
  });

  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(executions, 1);
  assert.deepEqual(a.value, { streams: [] });
  assert.deepEqual(b.value, { streams: [] });
  assert.equal(a.didRunWorker, true);
  assert.equal(b.didRunWorker, false);
  assert.equal(b.origin, 'local_wait');
});

test('RequestCoalescer waits on distributed lock and reads handed-off result', async () => {
  const redis = new FakeRedis();
  const owner = new RequestCoalescer({ namespace: 'testDist', redis, distributed: true, pollMs: 5, waitMs: 300, resultTtlSeconds: 30 });
  const waiter = new RequestCoalescer({ namespace: 'testDist', redis, distributed: true, pollMs: 5, waitMs: 300, resultTtlSeconds: 30 });
  let executions = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = owner.runDetailed('same', async () => {
    executions += 1;
    await gate;
    return { streams: [{ title: 'ok' }] };
  });

  const second = waiter.runDetailed('same', async () => {
    executions += 1;
    return { streams: [{ title: 'should-not-run' }] };
  });

  setTimeout(release, 25);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(executions, 1);
  assert.equal(a.didRunWorker, true);
  assert.equal(b.didRunWorker, false);
  assert.equal(b.origin, 'wait_result');
  assert.deepEqual(b.value, { streams: [{ title: 'ok' }] });
});

test('RequestCoalescer can read fresh cache while waiting on another owner', async () => {
  const redis = new FakeRedis();
  await redis.setIfAbsent('testCache:locks', 'same', 'external', 500);
  const coalescer = new RequestCoalescer({ namespace: 'testCache', redis, distributed: true, pollMs: 5, waitMs: 100 });
  let cached = null;
  setTimeout(() => { cached = { streams: [{ title: 'from-cache' }] }; }, 20);

  const detail = await coalescer.runDetailed('same', async () => {
    throw new Error('worker should not run');
  }, {
    readCached: () => cached
  });

  assert.equal(detail.didRunWorker, false);
  assert.equal(detail.origin, 'wait_cache');
  assert.deepEqual(detail.value, { streams: [{ title: 'from-cache' }] });
});


test('RequestCoalescer falls back immediately when Redis disables itself after lock failure', async () => {
  const redis = new FakeRedis();
  redis.setIfAbsent = async () => {
    redis.enabled = false;
    return false;
  };
  const coalescer = new RequestCoalescer({ namespace: 'testRedisDown', redis, distributed: true, pollMs: 50, waitMs: 1000 });
  let executions = 0;

  const started = Date.now();
  const detail = await coalescer.runDetailed('same', async () => {
    executions += 1;
    return { streams: [] };
  });

  assert.equal(executions, 1);
  assert.equal(detail.didRunWorker, true);
  assert.equal(detail.origin, 'redis_unavailable_worker');
  assert.ok(Date.now() - started < 250);
});

test('buildRequestCoalescingKey produces safe bounded keys', () => {
  const key = buildRequestCoalescingKey(['stream', 'tt123:1:2', 'x'.repeat(1000)]);
  assert.match(key, /^stream:tt123:1:2:sha256_/);
  assert.ok(key.length < 100);
});
