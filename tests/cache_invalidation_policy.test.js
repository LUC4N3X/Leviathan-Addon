'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TTLS,
  describeAvailabilityInvalidation,
  getAvailabilityCacheTtlSeconds,
  getDebridRecheckHours
} = require('../core/cache/cache_invalidation_policy');

test('RD cached exact file-level entries keep a long authority TTL', () => {
  assert.equal(getAvailabilityCacheTtlSeconds({ service: 'rd', state: 'cached', proofLevel: 'episode_file' }), DEFAULT_TTLS.rdCachedExact);
  assert.equal(getDebridRecheckHours({ service: 'rd', state: 'cached', proofLevel: 'episode_file' }), 168);
});

test('TorBox cached DB hints stay short unless live/saved-cloud confirms them', () => {
  const hintTtl = getAvailabilityCacheTtlSeconds({ service: 'tb', state: 'cached', liveChecked: false });
  const liveTtl = getAvailabilityCacheTtlSeconds({ service: 'tb', state: 'cached', liveChecked: true });

  assert.equal(hintTtl, DEFAULT_TTLS.tbLikelyCached);
  assert.equal(liveTtl, DEFAULT_TTLS.tbLiveCached);
  assert.ok(liveTtl > hintTtl);
});

test('cache invalidation explanation exposes TorBox live-first reason', () => {
  const description = describeAvailabilityInvalidation({ service: 'tb', state: 'cached' });

  assert.equal(description.reason, 'torbox_cache_is_hint_until_live_check');
  assert.equal(description.ttlSeconds, DEFAULT_TTLS.tbLikelyCached);
});
