'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyFallbackSort,
  detectCachedTier
} = require('../core/lib/result_stage_pipeline');

test('detectCachedTier recognizes normalized cached aliases', () => {
  assert.equal(detectCachedTier({ isCached: true }), 2);
  assert.equal(detectCachedTier({ tbCached: true }), 2);
  assert.equal(detectCachedTier({ behaviorHints: { cached: true } }), 2);
  assert.equal(detectCachedTier({ behaviorHints: { cacheState: 'cached' } }), 2);
});

test('fallback sort keeps likely cached results above unknown when quality ties', () => {
  const sorted = applyFallbackSort([
    { title: 'Release 1080p unknown', seeders: 120 },
    { title: 'Release 1080p likely', behaviorHints: { cacheState: 'likely_cached' }, seeders: 1 }
  ]);

  assert.equal(sorted[0].title, 'Release 1080p likely');
});
