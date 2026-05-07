'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clearRecentStreamTraces,
  createStreamTrace,
  getRecentStreamTraces,
  sanitizeDetails
} = require('../core/lib/stream_trace');

test('stream trace records stage timings and emits only when slow', async () => {
  clearRecentStreamTraces();
  let current = 1000;
  const logs = [];
  const trace = createStreamTrace({
    type: 'series',
    id: 'tt123:1:2',
    sourceMode: 'balanced',
    service: 'rd'
  }, {
    now: () => current,
    slowMs: 50,
    logger: { info: (...args) => logs.push(args) }
  });

  const result = await trace.time('metadata', async () => {
    current += 20;
    return { title: 'Example' };
  });
  assert.equal(result.title, 'Example');

  current += 40;
  const summary = trace.finish({ streams: 3 });

  assert.equal(summary.totalMs, 60);
  assert.equal(summary.stages[0].name, 'metadata');
  assert.equal(summary.stages[0].ms, 20);
  assert.equal(logs.length, 1);
  assert.equal(getRecentStreamTraces(1)[0].totalMs, 60);
});

test('stream trace logs empty fast requests and redacts sensitive detail keys', () => {
  clearRecentStreamTraces();
  let current = 0;
  const logs = [];
  const trace = createStreamTrace({ type: 'movie', id: 'tt1' }, {
    now: () => current,
    slowMs: 1000,
    logger: { info: (...args) => logs.push(args) }
  });

  trace.stage('cache-write', { apiKey: 'secret', token: 'secret', cacheScope: 'torrent' });
  current += 5;
  const summary = trace.finish({ streams: 0 });

  assert.equal(summary.stages[0].apiKey, undefined);
  assert.equal(summary.stages[0].token, undefined);
  assert.equal(summary.stages[0].cacheScope, 'torrent');
  assert.equal(logs.length, 1);
});

test('recent stream traces are newest first and can be cleared', () => {
  clearRecentStreamTraces();
  const first = createStreamTrace({ id: 'first' }, { logger: null });
  const second = createStreamTrace({ id: 'second' }, { logger: null });

  first.finish({ streams: 1 });
  second.finish({ streams: 1 });

  const traces = getRecentStreamTraces(2);
  assert.equal(traces[0].id, 'second');
  assert.equal(traces[1].id, 'first');
  assert.equal(clearRecentStreamTraces(), 2);
  assert.equal(getRecentStreamTraces(2).length, 0);
});

test('sanitizeDetails keeps useful counters and strips secret-like keys', () => {
  assert.deepEqual(sanitizeDetails({
    results: 12,
    provider: 'Torrentio',
    realdebridKey: 'secret',
    authHeader: 'secret'
  }), {
    results: 12,
    provider: 'Torrentio'
  });
});
