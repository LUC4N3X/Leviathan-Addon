const assert = require('node:assert/strict');
const test = require('node:test');

const TorboxAvailabilityCache = require('../core/debrid/tb/availability/torbox_availability_cache');
const {
  TB_CACHE_STATES,
  normalizeTbCacheState,
  toRdCacheState
} = require('../core/debrid/tb/availability/torbox_cache_state');

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

test('TorBox max mode uses full documented checkcached batches by default', () => {
  const tuning = TorboxAvailabilityCache.__private.getRuntimeTuning();

  assert.equal(tuning.chunkSize, 100);
  assert.ok(tuning.maxConcurrency >= 6);
});

test('TorBox getRuntimeTuning returns all required fields with correct types', () => {
  const tuning = TorboxAvailabilityCache.__private.getRuntimeTuning();

  assert.ok(Object.prototype.hasOwnProperty.call(tuning, 'chunkSize'), 'missing chunkSize');
  assert.ok(Object.prototype.hasOwnProperty.call(tuning, 'maxConcurrency'), 'missing maxConcurrency');
  assert.ok(Object.prototype.hasOwnProperty.call(tuning, 'defaultSyncLimit'), 'missing defaultSyncLimit');
  assert.ok(Object.prototype.hasOwnProperty.call(tuning, 'apiTimeout'), 'missing apiTimeout');

  assert.equal(typeof tuning.chunkSize, 'number');
  assert.equal(typeof tuning.maxConcurrency, 'number');
  assert.equal(typeof tuning.defaultSyncLimit, 'number');
  assert.equal(typeof tuning.apiTimeout, 'number');
});

test('TorBox getRuntimeTuning default syncLimit is 120', () => {
  const tuning = TorboxAvailabilityCache.__private.getRuntimeTuning();
  assert.equal(tuning.defaultSyncLimit, 120);
});

test('TorBox getRuntimeTuning apiTimeout is 14000ms', () => {
  const tuning = TorboxAvailabilityCache.__private.getRuntimeTuning();
  assert.equal(tuning.apiTimeout, 14000);
});

test('TorBox getRuntimeTuning chunkSize is clamped between 1 and 100', () => {
  const tuning = TorboxAvailabilityCache.__private.getRuntimeTuning();
  assert.ok(tuning.chunkSize >= 1, 'chunkSize must be >= 1');
  assert.ok(tuning.chunkSize <= 100, 'chunkSize must be <= 100');
});

test('TorBox getRuntimeTuning maxConcurrency is clamped between 1 and 12', () => {
  const tuning = TorboxAvailabilityCache.__private.getRuntimeTuning();
  assert.ok(tuning.maxConcurrency >= 1, 'maxConcurrency must be >= 1');
  assert.ok(tuning.maxConcurrency <= 12, 'maxConcurrency must be <= 12');
});


test('TorBox cached hits require live file proof in foreground parser', () => {
  const { __private } = require('../core/debrid/tb/availability/torbox_availability_cache');
  const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const [key, noFiles] = __private.parseHashResult(hash, { cached: true, name: 'Old expired cache', size: 2147483648 }, { isEpisodeRequest: false });
  assert.equal(key, hash);
  assert.equal(noFiles.state, 'likely_cached');
  assert.equal(noFiles.cached, null);

  const [, withFile] = __private.parseHashResult(hash, {
    cached: true,
    name: 'Mercy 2026 ITA ENG 1080p',
    size: 2147483648,
    files: [{ id: 0, name: 'Mercy.2026.ITA.ENG.1080p.mkv', size: 2147483648 }]
  }, { isEpisodeRequest: false, title: 'Mercy', year: 2026 });
  assert.equal(withFile.state, 'cached_verified');
  assert.equal(withFile.cached, true);
  assert.equal(withFile.file_id, 0);
});
