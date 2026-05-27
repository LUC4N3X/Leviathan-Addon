'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichTorrentItem, extractTrackersFromMagnet } = require('../core/lib/tracker_enricher');

const HASH = '0123456789abcdef0123456789abcdef01234567'.toUpperCase();

test('tracker enricher builds a tracker magnet from an infoHash', () => {
  const item = enrichTorrentItem({ title: 'Example', hash: HASH, seeders: 5 });
  assert.equal(item.hash, HASH);
  assert.equal(item.infoHash, HASH);
  assert.match(item.magnet, /^magnet:\?xt=urn:btih:/);
  assert.ok(extractTrackersFromMagnet(item.magnet).length > 0);
  assert.equal(item._trackerEnriched, true);
});

test('tracker enricher preserves direct playable urls', () => {
  const item = enrichTorrentItem({ title: 'Direct', hash: HASH, magnet: 'https://cdn.example/video.m3u8', directUrl: 'https://cdn.example/video.m3u8' });
  assert.equal(item.magnet, 'https://cdn.example/video.m3u8');
  assert.equal(item.hash, HASH);
  assert.equal(item._trackerEnriched, true);
});


test('tracker enricher adds anime profile trackers when anime/kitsu signals are present', () => {
  const item = enrichTorrentItem({ title: 'Some Anime S01E01 1080p', source: 'NyaaSi', hash: HASH });
  const trackers = extractTrackersFromMagnet(item.magnet);
  assert.ok(item._trackerProfiles.includes('anime'));
  assert.ok(trackers.some((tracker) => /nyaa|anidex/i.test(tracker)));
});
