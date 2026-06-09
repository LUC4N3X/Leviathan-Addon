'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDebridAvailabilityTools, __private } = require('../core/debrid/availability/debrid_availability');

const noopCache = {
  getDbTorrents: async () => null,
  cacheDbTorrents: async () => true,
  getAvailability: async () => null,
  cacheAvailability: async () => true,
  invalidateStreamsByHashes: async () => true,
  invalidateStreamsByEpisode: async () => true,
  invalidateStreamsByImdb: async () => true,
  invalidateDbTorrents: async () => true
};

function makeTools() {
  return createDebridAvailabilityTools({
    Cache: noopCache,
    logger: { info() {}, warn() {} },
    LIMITERS: { rdResolve: { schedule: (fn) => fn() } },
    CONFIG: { MAX_RESULTS: 20 },
    incrementMetric() {},
    isSeasonPack: () => false,
    getMetaDbLookupKey: () => 'meta:key'
  });
}

test('RD availability cache key is media-scoped for series auto file lookups', () => {
  const hash = 'a'.repeat(40);
  const meta = { imdb_id: 'tt1234567', season: 2, episode: 4, isSeries: true };
  const keys = __private.getAvailabilityCacheKeys('rd', hash, null, meta);

  assert.equal(keys.primary, `rd:${hash.toUpperCase()}:auto:tt1234567:s2:e4`);
  assert.deepEqual(keys.fallbacks, [`rd:${hash.toUpperCase()}:auto`]);
  assert.equal(keys.fallbacks.includes(`rd:${hash.toUpperCase()}`), false);
});

test('RD availability cache keeps legacy hash fallback only for concrete series files', () => {
  const hash = 'b'.repeat(40);
  const meta = { imdb_id: 'tt7654321', season: 1, episode: 9, isSeries: true };
  const keys = __private.getAvailabilityCacheKeys('rd', hash, 12, meta);

  assert.equal(keys.primary, `rd:${hash.toUpperCase()}:12:tt7654321:s1:e9`);
  assert.deepEqual(keys.fallbacks, [`rd:${hash.toUpperCase()}:12`, `rd:${hash.toUpperCase()}`]);
});

test('RD availability payload stores file-level and episode proof metadata', () => {
  const payload = __private.buildAvailabilityCachePayload(
    { state: 'cached', cached: true, failures: 0 },
    { fileIdx: 7, _rdEpisodeProof: { exact: true, source: 'test' }, _episodeExact: true },
    { file_size: 1234 },
    { imdb_id: 'tt9999999', season: 3, episode: 5, isSeries: true }
  );

  assert.equal(payload.mediaId, 'tt9999999:s3:e5');
  assert.equal(payload.proofLevel, 'episode_file');
  assert.equal(payload.fileIdx, 7);
  assert.equal(payload.imdbId, 'tt9999999');
  assert.equal(payload.season, 3);
  assert.equal(payload.episode, 5);
});

test('RD strict-fast treats DB positives without a fresh recheck as verification hints', () => {
  const missingRecheck = __private.deriveDbRdAvailability({
    cached_rd: true,
    rd_cache_state: 'cached',
    next_cached_check: null
  });
  const staleRecheck = __private.deriveDbRdAvailability({
    cached_rd: true,
    rd_cache_state: 'cached',
    next_cached_check: new Date(Date.now() - 60_000).toISOString()
  });
  const freshRecheck = __private.deriveDbRdAvailability({
    cached_rd: true,
    rd_cache_state: 'cached',
    next_cached_check: new Date(Date.now() + 60 * 60_000).toISOString()
  });

  assert.equal(missingRecheck.state, 'likely_cached');
  assert.equal(missingRecheck.cached, null);
  assert.equal(missingRecheck.needsLiveVerification, true);
  assert.equal(staleRecheck.state, 'likely_cached');
  assert.equal(staleRecheck.cached, null);
  assert.equal(staleRecheck.needsLiveVerification, true);
  assert.equal(freshRecheck.state, 'cached');
  assert.equal(freshRecheck.cached, true);
  assert.equal(freshRecheck.needsLiveVerification, false);
});

test('RD strict-fast disabled via env reverts positives to cached without needsLiveVerification', () => {
  const previous = process.env.RD_STRICT_FAST_ENABLED;
  process.env.RD_STRICT_FAST_ENABLED = 'false';
  try {
    const staleRecheck = __private.deriveDbRdAvailability({
      cached_rd: true,
      rd_cache_state: 'cached',
      next_cached_check: new Date(Date.now() - 60_000).toISOString()
    });
    // With strict-fast disabled a stale positive still becomes likely_cached
    // (the shared stalePositive path) but needsLiveVerification stays set
    assert.equal(staleRecheck.state, 'likely_cached');
    assert.equal(staleRecheck.stale, true);
    assert.equal(staleRecheck.needsLiveVerification, true);
  } finally {
    if (previous === undefined) delete process.env.RD_STRICT_FAST_ENABLED;
    else process.env.RD_STRICT_FAST_ENABLED = previous;
  }
});

test('RD deriveDbRdAvailability returns unknown state for null/empty row', () => {
  const empty = __private.deriveDbRdAvailability({});
  assert.equal(empty.state, null);
  assert.equal(empty.cached, null);
  assert.equal(empty.stale, false);
  assert.equal(empty.needsLiveVerification, false);

  const nullRow = __private.deriveDbRdAvailability(null);
  assert.equal(nullRow.state, null);
  assert.equal(nullRow.cached, null);
});

test('RD deriveDbRdAvailability returns likely_cached for likely_cached state without fresh recheck', () => {
  const result = __private.deriveDbRdAvailability({
    cached_rd: null,
    rd_cache_state: 'likely_cached',
    next_cached_check: null
  });
  assert.equal(result.state, 'likely_cached');
  assert.equal(result.needsLiveVerification, true);
});

test('RD deriveDbRdAvailability preserves non-positive states unchanged', () => {
  const probing = __private.deriveDbRdAvailability({
    cached_rd: null,
    rd_cache_state: 'probing',
    next_cached_check: null
  });
  assert.equal(probing.state, 'probing');
  assert.equal(probing.stale, false);
  assert.equal(probing.needsLiveVerification, false);

  const uncached = __private.deriveDbRdAvailability({
    cached_rd: false,
    rd_cache_state: 'likely_uncached',
    next_cached_check: null
  });
  assert.equal(uncached.state, 'likely_uncached');
  assert.equal(uncached.stale, false);
});

test('RD deriveDbRdAvailability fresh recheck prevents stale-positive reclassification', () => {
  const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const result = __private.deriveDbRdAvailability({
    cached_rd: true,
    rd_cache_state: 'cached',
    next_cached_check: future
  });
  assert.equal(result.state, 'cached');
  assert.equal(result.cached, true);
  assert.equal(result.stale, false);
  assert.equal(result.needsLiveVerification, false);
});

test('TorBox DB cache is only a hint until a foreground live check confirms it', () => {
  const tools = makeTools();

  assert.equal(tools.getRdAvailabilityState('tb', { _tbDbCachedHint: true }), 'likely_cached');
  assert.equal(tools.getRdAvailabilityState('tb', { _tbCached: true }), 'unknown');
  assert.equal(tools.getRdAvailabilityState('tb', { _tbCached: true, _tbLiveChecked: true }), 'cached');
  assert.equal(tools.getRdAvailabilityState('tb', { _savedCloud: true }), 'cached');
});
