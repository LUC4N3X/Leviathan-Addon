'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isEnabled,
  normalizeService,
  getFederatedCachedHashes,
  storeFederatedCachedHashes
} = require('../core/debrid/availability/cache_federation');

const HASH = 'a'.repeat(40);

test('cache federation is disabled by default', () => {
  assert.equal(isEnabled(), false);
});

test('normalizeService maps full names to short service tags', () => {
  assert.equal(normalizeService('realdebrid'), 'rd');
  assert.equal(normalizeService('real-debrid'), 'rd');
  assert.equal(normalizeService('torbox'), 'tb');
  assert.equal(normalizeService('RD'), 'rd');
  assert.equal(normalizeService(''), 'rd');
});

test('reads and writes degrade safely when disabled', async () => {
  assert.equal(storeFederatedCachedHashes('rd', HASH), false);
  const set = await getFederatedCachedHashes('rd', [HASH]);
  assert.equal(set.size, 0);
});

test('getFederatedCachedHashes tolerates invalid hashes', async () => {
  const set = await getFederatedCachedHashes('rd', ['not-a-hash', '']);
  assert.equal(set.size, 0);
});
