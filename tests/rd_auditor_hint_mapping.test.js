'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const RealDebridAuditor = require('../core/debrid/rd/audit/realdebrid_auditor');

test('maps personal scanner cache hits to soft shared likely_cached hints', () => {
  const result = RealDebridAuditor.__private.mapAuditorProbeResult('HASH', {
    hash: 'hash',
    cached: true,
    rd_status: 'downloaded',
    file_index: 7,
    file_size: 33000000,
    files: [
      { id: 7, path: 'show.s01e01.mkv', bytes: 33000000 },
      { id: 8, path: 'show.s01e02.mkv', bytes: 34000000 }
    ]
  });

  assert.equal(result.hash, 'hash');
  assert.equal(result.state, 'likely_cached');
  assert.equal(result.cached, null);
  assert.equal(result.verified, true);
  assert.equal(result.rd_file_index, 7);
  assert.equal(result.is_pack, true);
});

test('maps personal scanner terminal negatives to soft shared likely_uncached hints', () => {
  const result = RealDebridAuditor.__private.mapAuditorProbeResult('hash', {
    hash: 'hash',
    cached: false,
    rd_status: 'magnet_error',
    state: 'uncached_terminal'
  });

  assert.equal(result.state, 'likely_uncached');
  assert.equal(result.cached, null);
  assert.equal(result.verified, true);
  assert.match(result.reason, /magnet_error/);
});

test('keeps transient personal scanner failures in probing state', () => {
  const result = RealDebridAuditor.__private.mapAuditorProbeResult('hash', {
    hash: 'hash',
    cached: false,
    deferred: true,
    state: 'probing',
    error: 'timeout'
  });

  assert.equal(result.state, 'probing');
  assert.equal(result.cached, null);
  assert.equal(result.verified, false);
  assert.match(result.reason, /timeout/);
});

test('auditor uses the canonical RD probe with low priority', async () => {
  let captured = null;
  const result = await RealDebridAuditor.__private.auditHashSlow('HASH', 'personal-token', {
    RealDebridProbe: {
      inspectSingleHash(...args) {
        captured = args;
        return Promise.resolve({
          hash: 'hash',
          cached: true,
          rd_status: 'downloaded'
        });
      }
    }
  });

  assert.equal(captured[2], 'personal-token');
  assert.equal(captured[4].priority, 'auditor');
  assert.equal(result.state, 'likely_cached');
  assert.equal(result.cached, null);
});
