'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getSeederWeightFactor, rankAndFilterResults } = require('../core/lib/result_ranker');

const WEIGHTS = { seedersFactor: 18 };

test('P2P keeps full seeder weight while debrid uses a light tie-breaker', () => {
  assert.equal(getSeederWeightFactor({ title: 'P2P release', seeders: 100 }, WEIGHTS, { service: 'p2p' }), 18);
  assert.equal(getSeederWeightFactor({ title: 'RD release', seeders: 100, _rdCacheState: 'cached' }, WEIGHTS, { service: 'rd' }), 2);
  assert.equal(getSeederWeightFactor({ title: 'TB release', seeders: 100, _tbCached: true }, WEIGHTS, { service: 'tb' }), 2);
});

test('debrid ranking does not let seeders dominate cached/file precision as aggressively', () => {
  const input = [
    { title: 'Movie 1080p WEB-DL ITA', seeders: 2, _rdCacheState: 'cached', fileIdx: 1 },
    { title: 'Movie 1080p WEB-DL ITA', seeders: 300, _rdCacheState: 'cached' }
  ];
  const ranked = rankAndFilterResults(input, { title: 'Movie', year: '2024' }, { service: 'rd' });
  assert.equal(ranked[0].fileIdx, 1);
});
