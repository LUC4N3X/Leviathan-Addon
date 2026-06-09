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

test('TorBox DB cache is only a hint until a foreground live check confirms it', () => {
  const tools = makeTools();

  assert.equal(tools.getRdAvailabilityState('tb', { _tbDbCachedHint: true }), 'likely_cached');
  assert.equal(tools.getRdAvailabilityState('tb', { _tbCached: true }), 'unknown');
  assert.equal(tools.getRdAvailabilityState('tb', { _tbCached: true, _tbLiveChecked: true }), 'cached');
  assert.equal(tools.getRdAvailabilityState('tb', { _savedCloud: true }), 'cached');
});
