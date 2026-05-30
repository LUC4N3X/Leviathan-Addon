'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const RealDebridProbe = require('../core/debrid/rd/probe/realdebrid_probe');

function createProbeHarness(result = { hash: 'hash', cached: true }) {
  const calls = [];
  return {
    calls,
    dependencies: {
      scheduleRdProbe(job) {
        calls.push(job);
        return job.execute();
      },
      performAvailabilityProbe: async () => result
    }
  };
}

test('routes slow foreground probes through the RD coordinator', async () => {
  const harness = createProbeHarness();
  const context = { season: 1, episode: 2, fileIdx: 3 };

  await RealDebridProbe.__private.scheduleAvailabilityProbe(
    'HASH',
    'magnet:?xt=urn:btih:HASH',
    'token',
    { context },
    harness.dependencies
  );

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].priority, 'foreground');
  assert.deepEqual(harness.calls[0].context, context);
});

test('uses view_scan priority for fast probes and explicit priority overrides', async () => {
  const fastHarness = createProbeHarness();
  await RealDebridProbe.__private.scheduleAvailabilityProbe(
    'HASH',
    'magnet:?xt=urn:btih:HASH',
    'token',
    { fast: true },
    fastHarness.dependencies
  );

  assert.equal(fastHarness.calls[0].priority, 'view_scan');

  const auditorHarness = createProbeHarness();
  await RealDebridProbe.__private.scheduleAvailabilityProbe(
    'HASH',
    'magnet:?xt=urn:btih:HASH',
    'token',
    { priority: 'auditor' },
    auditorHarness.dependencies
  );

  assert.equal(auditorHarness.calls[0].priority, 'auditor');
});

test('recognizes cached probing results as deferred work', () => {
  assert.equal(RealDebridProbe.__private.shouldDeferCachedProbeResult({
    cached: false,
    deferred: true,
    state: 'probing'
  }), true);
  assert.equal(RealDebridProbe.__private.shouldDeferCachedProbeResult({
    cached: true,
    state: 'cached'
  }), false);
});
