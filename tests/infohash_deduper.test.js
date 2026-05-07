'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInfoHash, extractInfoHash, dedupeByInfoHash } = require('../core/stream/infohash_deduper');

const HASH = '0123456789ABCDEF0123456789ABCDEF01234567';
const HASH_LOWER = HASH.toLowerCase();
const OTHER = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

test('extracts and normalizes infohash from direct fields and magnet URLs', () => {
  assert.equal(normalizeInfoHash(HASH_LOWER), HASH);
  assert.equal(extractInfoHash({ magnet: `magnet:?xt=urn:btih:${HASH_LOWER}&dn=test` }), HASH);
  assert.equal(extractInfoHash({ behaviorHints: { magnet: `magnet:?xt=urn:btih:${HASH}` } }), HASH);
  assert.equal(extractInfoHash({ sources: [`dht:${HASH_LOWER}`] }), HASH);
});

test('deduplicates only streams with the same infohash', () => {
  const input = [
    { title: 'A 1080p', infoHash: HASH, seeders: 10, source: 'DB', url: '/lazy/db' },
    { title: 'A 1080p better', hash: HASH_LOWER, seeders: 125, source: 'Torrentio', url: '/lazy/torrentio' },
    { title: 'A 1080p alternative', infoHash: OTHER, seeders: 90, source: 'Torrentio', url: '/lazy/other' },
    { title: 'Web stream without torrent hash', url: 'https://example.test/video.m3u8' }
  ];

  const out = dedupeByInfoHash(input);
  assert.equal(out.removed, 1);
  assert.equal(out.results.length, 3);
  assert.equal(out.results.filter((item) => extractInfoHash(item) === HASH).length, 1);
  assert.equal(out.results.some((item) => item.infoHash === OTHER), true);
  assert.equal(out.results.some((item) => item.url === 'https://example.test/video.m3u8'), true);
});

test('does not deduplicate similar looking titles without matching infohash', () => {
  const input = [
    { title: 'Stranger Things S01E02 1080p x265 648.91 MB', infoHash: HASH, seeders: 125 },
    { title: 'Stranger Things S01E02 1080p x265 648.70 MB', infoHash: OTHER, seeders: 125 }
  ];

  const out = dedupeByInfoHash(input);
  assert.equal(out.removed, 0);
  assert.equal(out.results.length, 2);
});

test('dedupe preserves cached aliases from provider-normalized duplicates', () => {
  const input = [
    { title: 'A 1080p unknown', infoHash: HASH, source: 'DB', seeders: 200, _rdCacheState: 'unknown' },
    {
      title: 'A 1080p cached',
      infoHash: HASH,
      source: 'Torrentio',
      seeders: 5,
      isCached: true,
      behaviorHints: { cacheState: 'cached' },
      _nexusBridgeRdChecked: true
    }
  ];

  const out = dedupeByInfoHash(input);
  const [item] = out.results.filter((entry) => extractInfoHash(entry) === HASH);

  assert.equal(out.removed, 1);
  assert.equal(item._rdCacheState, 'cached');
  assert.equal(item.rdCacheState, 'cached');
  assert.equal(item.cached, true);
  assert.equal(item.isCached, true);
  assert.equal(item._nexusBridgeRdChecked, true);
});
