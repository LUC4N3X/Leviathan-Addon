'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applySeedHealthRanking, getSeedHealth } = require('../core/lib/seed_health_ranker');

test('seed health classifies healthy, weak and dead torrents', () => {
  assert.equal(getSeedHealth(42).health, 'healthy');
  assert.equal(getSeedHealth(1).health, 'weak');
  assert.equal(getSeedHealth(0).health, 'dead');
  assert.equal(getSeedHealth(null).health, 'unknown');
});

test('strict mode drops dead torrents when enough healthy torrents exist', () => {
  const input = [
    ...Array.from({ length: 8 }, (_, index) => ({ title: `healthy ${index}`, seeders: 5 + index, magnet: `magnet:?xt=urn:btih:${String(index).padStart(40, 'a')}` })),
    { title: 'weak', seeders: 1 },
    { title: 'dead', seeders: 0 }
  ];

  const pass = applySeedHealthRanking(input);
  assert.equal(pass.stats.strict, true);
  assert.equal(pass.stats.dead, 1);
  assert.equal(pass.results.some((item) => item.title === 'dead'), false);
});

test('weak torrents survive when there are few healthy alternatives', () => {
  const input = [
    { title: 'healthy', seeders: 7 },
    { title: 'weak a', seeders: 1 },
    { title: 'weak b', seeders: 2 },
    { title: 'dead', seeders: 0 }
  ];

  const pass = applySeedHealthRanking(input);
  assert.equal(pass.stats.strict, false);
  assert.deepEqual(pass.results.map((item) => item.title), ['healthy', 'weak a', 'weak b']);
});

test('cached or file-indexed torrents are protected even with zero seeders', () => {
  const input = [
    ...Array.from({ length: 8 }, (_, index) => ({ title: `healthy ${index}`, seeders: 10 + index })),
    { title: 'cached zero', seeders: 0, _dbCachedRd: true },
    { title: 'file zero', seeders: 0, fileIdx: 3 }
  ];

  const pass = applySeedHealthRanking(input);
  assert.equal(pass.stats.strict, true);
  assert.equal(pass.results.some((item) => item.title === 'cached zero'), true);
  assert.equal(pass.results.some((item) => item.title === 'file zero'), true);
});


test('debrid mode annotates seed health without dropping low-seed items', () => {
  const input = [
    { title: 'Dead but cached', seeders: 0, _dbCachedRd: true },
    { title: 'Weak debrid', seeders: 1 },
    { title: 'Healthy debrid', seeders: 40 }
  ];
  const pass = applySeedHealthRanking(input, { mode: 'debrid' });
  assert.equal(pass.results.length, input.length);
  assert.equal(pass.stats.mode, 'debrid');
  assert.equal(pass.stats.dropped, 0);
  assert.equal(pass.results[0]._seedHealth, 'dead');
});
