'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyResolutionOrderingGuard,
  detectCacheTier,
  detectResolutionTier,
  shouldPromoteHigherResolution
} = require('../core/debrid/guards/resolution_ordering_guard');

test('resolution guard promotes nearby 1080p above SD only inside the same cache/source bucket', () => {
  const input = [
    { title: 'Release SD', provider: 'Torrentio', _rdCacheState: 'cached', cached_rd: true, _score: 1000 },
    { title: 'Release 1080p', provider: 'Torrentio', _rdCacheState: 'cached', cached_rd: true, _score: 950 }
  ];

  const output = applyResolutionOrderingGuard(input);

  assert.equal(output[0].title, 'Release 1080p');
  assert.equal(output[1].title, 'Release SD');
});

test('resolution guard does not put uncached 1080p over confirmed cached SD', () => {
  const input = [
    { title: 'Release SD', provider: 'Torrentio', _rdCacheState: 'cached', cached_rd: true, _score: 1000 },
    { title: 'Release 1080p', provider: 'Torrentio', _rdCacheState: 'likely_uncached', _score: 950 }
  ];

  const output = applyResolutionOrderingGuard(input);

  assert.equal(output[0].title, 'Release SD');
  assert.equal(output[1].title, 'Release 1080p');
});

test('resolution guard respects a large ranking reason for lower resolution', () => {
  const current = { title: 'Release 720p very strong', provider: 'Torrentio', _rdCacheState: 'cached', cached_rd: true, _score: 50000, seeders: 120 };
  const candidate = { title: 'Release 2160p weak', provider: 'Torrentio', _rdCacheState: 'cached', cached_rd: true, _score: 1000, seeders: 1 };

  assert.equal(shouldPromoteHigherResolution(candidate, current), false);
});

test('detectResolutionTier reads quality fields without requiring title mutation', () => {
  assert.equal(detectResolutionTier({ quality: '2160p' }), 4);
  assert.equal(detectResolutionTier({ behaviorHints: { videoResolution: '1080p' } }), 3);
  assert.equal(detectResolutionTier({ title: 'Movie SD' }), 1);
});

test('detectCacheTier reads provider-normalized cache hints', () => {
  assert.equal(detectCacheTier({ isCached: true }), 4);
  assert.equal(detectCacheTier({ tbCached: true }), 4);
  assert.equal(detectCacheTier({ behaviorHints: { cacheState: 'likely_cached' } }), 3);
});

test('strict resolution mode from index.html puts 4K before cached lower resolutions', () => {
  const input = [
    { title: 'Release 720p', provider: 'Torrentio', _rdCacheState: 'cached', cached_rd: true, _score: 90000 },
    { title: 'Release 1080p', provider: 'Torrentio', _rdCacheState: 'cached', cached_rd: true, _score: 80000 },
    { title: 'Release 2160p HDR', provider: 'Torrentio', _rdCacheState: 'likely_cached', likely_cached: true, _score: 1000 }
  ];

  const output = applyResolutionOrderingGuard(input, { sortMode: 'resolution' });

  assert.equal(output[0].title, 'Release 2160p HDR');
  assert.equal(output[1].title, 'Release 1080p');
  assert.equal(output[2].title, 'Release 720p');
});
