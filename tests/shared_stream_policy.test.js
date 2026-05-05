const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSharedStreamCachePolicy, shouldUseSharedStreamEntry } = require('../core/lib/shared_stream_policy');

test('shared policy skips shared writes for ultra fresh content', () => {
  const policy = buildSharedStreamCachePolicy({
    year: new Date().getUTCFullYear(),
    releaseDate: new Date().toISOString().slice(0, 10)
  }, {
    finalStreams: [{ name: 'RD', title: 'Example 1080p' }],
    cleanResults: [{ title: 'Example 1080p', cached_rd: true, source: 'Indexer' }],
    debridStreams: [{ name: 'RD', title: 'Example 1080p' }],
    hasDebridKey: true
  });

  assert.equal(policy.sharedFreshSkip, true);
  assert.equal(policy.allowSharedWrite, false);
  assert.equal(policy.sharedTtl, 0);
});

test('shared policy keeps shared writes for stable content', () => {
  const policy = buildSharedStreamCachePolicy({
    year: 2020,
    releaseDate: '2020-01-01'
  }, {
    finalStreams: [{ name: 'RD', title: 'Example 1080p' }],
    cleanResults: [{ title: 'Example 1080p', cached_rd: true, source: 'Indexer' }],
    debridStreams: [{ name: 'RD', title: 'Example 1080p' }],
    hasDebridKey: true
  });

  assert.equal(policy.sharedFreshSkip, false);
  assert.equal(policy.allowSharedWrite, true);
  assert.ok(policy.sharedTtl > 0);
});

test('shared entries younger than skip window are rejected for non-stable requests', () => {
  const nowMs = Date.UTC(2026, 3, 18, 12, 0, 0);
  const allowed = shouldUseSharedStreamEntry({
    content_date: '2026-04-10',
    freshness_bucket: 'settling',
    confidence_score: 90,
    result_count: 4,
    policy_version: 3
  }, {
    freshnessBucket: 'stable',
    nowMs
  }, {
    allowStale: false
  });

  const rejected = shouldUseSharedStreamEntry({
    content_date: '2026-04-16',
    freshness_bucket: 'fresh',
    confidence_score: 90,
    result_count: 4,
    policy_version: 3
  }, {
    freshnessBucket: 'fresh',
    nowMs
  }, {
    allowStale: false
  });

  assert.equal(allowed, true);
  assert.equal(rejected, false);
});
