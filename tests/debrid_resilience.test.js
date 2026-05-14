'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRetryAfterMs, computeBackoffDelay } = require('../core/debrid/utils/backoff');
const { CircuitBreaker } = require('../core/debrid/utils/circuit_breaker');
const { TB_CACHE_STATES } = require('../core/debrid/availability/torbox_cache_state');
const { __private: TbCachePrivate } = require('../core/debrid/availability/torbox_availability_cache');
const TB = require('../core/debrid/clients/torbox_client');

const GB = 1024 * 1024 * 1024;

test('parseRetryAfterMs reads numeric seconds and ignores garbage', () => {
  assert.equal(parseRetryAfterMs('3'), 3000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs(''), 0);
  assert.equal(parseRetryAfterMs(undefined), 0);
  assert.equal(parseRetryAfterMs('not-a-number'), 0);
  assert.ok(parseRetryAfterMs('1000000') <= 120000);
});

test('parseRetryAfterMs supports an HTTP date in the future', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = parseRetryAfterMs(future);
  assert.ok(ms > 2000 && ms <= 6000, `expected ~5s, got ${ms}`);
  const past = new Date(Date.now() - 5000).toUTCString();
  assert.equal(parseRetryAfterMs(past), 0);
});

test('computeBackoffDelay grows exponentially and stays bounded', () => {
  const a0 = computeBackoffDelay(0, { baseMs: 1000, maxMs: 16000, jitter: false });
  const a1 = computeBackoffDelay(1, { baseMs: 1000, maxMs: 16000, jitter: false });
  const a2 = computeBackoffDelay(2, { baseMs: 1000, maxMs: 16000, jitter: false });
  assert.equal(a0, 1000);
  assert.equal(a1, 2000);
  assert.equal(a2, 4000);
  assert.ok(computeBackoffDelay(20, { baseMs: 1000, maxMs: 16000, jitter: false }) <= 16000);
});

test('computeBackoffDelay treats Retry-After as authoritative', () => {
  const delay = computeBackoffDelay(0, { baseMs: 500, maxMs: 2000, retryAfterMs: 9000 });
  assert.equal(delay, 9000);
});

test('CircuitBreaker trips after sustained failures and recovers on success', () => {
  const breaker = new CircuitBreaker('test');
  const key = 'user-a';
  for (let i = 0; i < 7; i += 1) breaker.recordFailure(key);
  assert.equal(breaker.canRequest(key), true, 'should still be closed below threshold');
  breaker.recordFailure(key);
  assert.equal(breaker.canRequest(key), false, 'should open at the failure threshold');
  // Other keys are unaffected.
  assert.equal(breaker.canRequest('user-b'), true);
  breaker.recordSuccess(key);
  assert.equal(breaker.canRequest(key), true, 'a success closes the breaker again');
});

test('TorBox checkcached: size alone is not treated as cached', () => {
  const sizeOnly = TB.__private.normalizeCheckcachedInfo('ABCDEF', { size: 8 * GB });
  assert.equal(sizeOnly.state, TB_CACHE_STATES.UNCERTAIN);
  assert.notEqual(sizeOnly.cached, true);

  const cachedFlag = TB.__private.normalizeCheckcachedInfo('ABCDEF', { cached: true });
  assert.equal(cachedFlag.state, TB_CACHE_STATES.LIKELY_CACHED);

  const withFiles = TB.__private.normalizeCheckcachedInfo('ABCDEF', {
    files: [{ id: 1, name: 'Movie.2024.1080p.mkv', size: 8 * GB }]
  });
  assert.equal(withFiles.state, TB_CACHE_STATES.CACHED_VERIFIED);
  assert.equal(withFiles.cached, true);
});

test('TorBox availability parser: metadata size without files stays uncertain', () => {
  const [, sizeOnly] = TbCachePrivate.parseHashResult('ABCDEF', {
    name: 'Movie.2024.1080p.WEB-DL',
    size: 8 * GB,
    files: []
  }, { isEpisodeRequest: false });
  assert.equal(sizeOnly.state, TB_CACHE_STATES.UNCERTAIN);
  assert.notEqual(sizeOnly.cached, true);

  const [, cachedFlag] = TbCachePrivate.parseHashResult('ABCDEF', {
    name: 'Movie.2024.1080p.WEB-DL',
    size: 8 * GB,
    cached: true,
    files: []
  }, { isEpisodeRequest: false });
  assert.equal(cachedFlag.state, TB_CACHE_STATES.LIKELY_CACHED);
});
