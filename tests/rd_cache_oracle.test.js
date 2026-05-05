'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Oracle = require('../core/stream/rd_cache_oracle');
const EpisodePrecision = require('../core/stream/episode_precision');

const META = { isSeries: true, season: 1, episode: 3, title: 'Example Show' };

test('series positive hash without exact fileIdx is likely_cached not probing', () => {
  const state = Oracle.resolveEffectiveRdState({ _dbCachedRd: true, cached_rd: true, hash: 'a'.repeat(40) }, META);
  assert.equal(state, 'likely_cached');
});

test('series positive hash with raw fileIdx but no episode proof is only likely_cached', () => {
  const state = Oracle.resolveEffectiveRdState({ _dbCachedRd: true, cached_rd: true, fileIdx: 12 }, META);
  assert.equal(state, 'likely_cached');
});

test('series positive hash with exact episode proof is cached', () => {
  const state = Oracle.resolveEffectiveRdState({
    _dbCachedRd: true,
    cached_rd: true,
    fileIdx: 12,
    _episodeExact: true,
    matched_file_index: 12,
    matched_file_title: 'Example.Show.S01E03.1080p.mkv'
  }, META);
  assert.equal(state, 'cached');
});

test('series positive hash with filename SxxEyy proof is cached', () => {
  const item = {
    _dbCachedRd: true,
    cached_rd: true,
    fileIdx: 7,
    behaviorHints: { filename: 'Example.Show.S01E03.1080p.WEB-DL.mkv' }
  };
  EpisodePrecision.applyEpisodePrecisionToItem(item, META);
  assert.equal(Oracle.resolveEffectiveRdState(item, META), 'cached');
});

test('positive cache wins over stale probing marker for movie', () => {
  const item = { _rdCacheState: 'probing', _dbCachedRd: true, cached_rd: true };
  const state = Oracle.resolveEffectiveRdState(item, { isSeries: false });
  assert.equal(state, 'cached');
});

test('unknown external result does not become likely_uncached from null booleans', () => {
  const item = { rdCacheState: 'unknown', _dbCachedRd: null, cached_rd: null };
  const state = Oracle.resolveEffectiveRdState(item, { isSeries: true, season: 2, episode: 4 });
  assert.equal(state, 'unknown');
});

test('hash sibling positive is softened for series when exact proof is missing', () => {
  const state = Oracle.getHashPositiveStateForSibling('cached', { hash: 'b'.repeat(40), fileIdx: 2 }, { isSeries: true, season: 1, episode: 1 });
  assert.equal(state, 'likely_cached');
});
