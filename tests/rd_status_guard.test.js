'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { preserveRdStatus, preserveRdStatusList, getSourceState } = require('../core/debrid/guards/rd_status_guard');

test('preserveRdStatus restores cached RD flags when a later pipeline item lost them', () => {
  const before = {
    title: 'Movie 1080p',
    infoHash: 'A'.repeat(40),
    fileIdx: 0,
    _rdCacheState: 'cached',
    rdCacheState: 'cached',
    cached_rd: true,
    _dbCachedRd: true,
    cached: true,
    debridService: 'rd'
  };
  const after = {
    title: 'Movie 1080p',
    infoHash: 'A'.repeat(40),
    fileIdx: 0
  };

  const { item } = preserveRdStatus(after, before);

  assert.equal(item._rdCacheState, 'cached');
  assert.equal(item.rdCacheState, 'cached');
  assert.equal(item.cacheState, 'cached');
  assert.equal(item.cached, true);
  assert.equal(item.cached_rd, true);
  assert.equal(item._dbCachedRd, true);
  assert.equal(item.debridService, 'rd');
});

test('preserveRdStatus does not downgrade a confirmed cached item to probing', () => {
  const cached = {
    title: 'Movie 2160p',
    _rdCacheState: 'cached',
    cached: true,
    cached_rd: true
  };
  const weaker = {
    title: 'Movie 2160p',
    _rdCacheState: 'probing',
    probing: true,
    cached: null
  };

  const { item } = preserveRdStatus(cached, weaker);

  assert.equal(getSourceState(item), 'cached');
  assert.equal(item.cached, true);
  assert.equal(item.cached_rd, true);
});

test('preserveRdStatusList matches by infoHash and fileIdx after ordering transforms', () => {
  const sources = [{
    title: 'Episode 720p',
    infoHash: 'B'.repeat(40),
    fileIdx: 7,
    _rdCacheState: 'likely_cached',
    likely_cached: true,
    cached: null
  }];
  const targets = [{
    title: 'Episode 720p renamed',
    infoHash: 'B'.repeat(40),
    fileIdx: 7
  }];

  const [item] = preserveRdStatusList(sources, targets);

  assert.equal(item._rdCacheState, 'likely_cached');
  assert.equal(item.rdCacheState, 'likely_cached');
  assert.equal(item.likely_cached, true);
  assert.equal(item.cached, null);
});
