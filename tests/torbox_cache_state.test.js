const assert = require('node:assert/strict');
const test = require('node:test');

const TorboxAvailabilityCache = require('../core/debrid/availability/torbox_availability_cache');
const {
  TB_CACHE_STATES,
  normalizeTbCacheState,
  toRdCacheState
} = require('../core/debrid/availability/torbox_cache_state');

const {
  parseHashResult,
  buildDbUpdate
} = TorboxAvailabilityCache.__private;

const GB = 1024 * 1024 * 1024;

test('TorBox cache parser verifies movie only when a playable video file is present', () => {
  const [hash, result] = parseHashResult('ABCDEF', {
    name: 'Movie.2024.1080p.WEB-DL',
    size: 8 * GB,
    cached: true,
    files: [
      { id: 7, name: 'Movie.2024.1080p.WEB-DL.mkv', size: 8 * GB }
    ]
  }, { isEpisodeRequest: false });

  assert.equal(hash, 'abcdef');
  assert.equal(result.cached, true);
  assert.equal(result.state, TB_CACHE_STATES.CACHED_VERIFIED);
  assert.equal(result.file_id, 7);
  assert.equal(result.rd_cache_state, 'cached');
});

test('TorBox cache parser does not mark metadata-only responses as verified cached', () => {
  const [, result] = parseHashResult('ABCDEF', {
    name: 'Movie.2024.1080p.WEB-DL',
    size: 8 * GB,
    cached: true,
    files: []
  }, { isEpisodeRequest: false });

  assert.equal(result.cached, null);
  assert.equal(result.state, TB_CACHE_STATES.LIKELY_CACHED);
  assert.equal(result.file_id, undefined);
});

test('TorBox cache parser keeps ambiguous series pack uncertain and does not emit wrong fileIdx', () => {
  const [, result] = parseHashResult('ABCDEF', {
    name: 'Show.S01.1080p.Pack',
    size: 20 * GB,
    cached: true,
    files: [
      { id: 1, name: 'Show.S01E01.1080p.mkv', size: 2 * GB },
      { id: 3, name: 'Show.S01E03.1080p.mkv', size: 2 * GB }
    ]
  }, {
    isEpisodeRequest: true,
    season: 1,
    episode: 2
  });

  assert.notEqual(result.cached, true);
  assert.equal(result.state, TB_CACHE_STATES.UNCERTAIN);
  assert.equal(result.file_id, null);
});

test('TorBox error and uncertain states do not persist negative DB cache booleans', () => {
  const errorUpdate = buildDbUpdate('abcdef', {
    cached: null,
    state: TB_CACHE_STATES.ERROR
  }, {});

  const uncertainUpdate = buildDbUpdate('abcdef', {
    cached: null,
    state: TB_CACHE_STATES.UNCERTAIN
  }, {});

  const uncachedUpdate = buildDbUpdate('abcdef', {
    cached: false,
    state: TB_CACHE_STATES.UNCACHED
  }, {});

  assert.equal(errorUpdate.cached, null);
  assert.equal(uncertainUpdate.cached, null);
  assert.equal(uncachedUpdate.cached, false);
});

test('TorBox cache-state normalization maps display states without mixing verified and probing', () => {
  assert.equal(normalizeTbCacheState('cached'), TB_CACHE_STATES.CACHED_VERIFIED);
  assert.equal(normalizeTbCacheState('queued'), TB_CACHE_STATES.QUEUED);
  assert.equal(toRdCacheState(TB_CACHE_STATES.CACHED_VERIFIED), 'cached');
  assert.equal(toRdCacheState(TB_CACHE_STATES.UNCERTAIN), 'probing');
  assert.equal(toRdCacheState(TB_CACHE_STATES.ERROR), 'unknown');
});
