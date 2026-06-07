'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractStreamInfo } = require('../core/lib/stream_formatter');

test('double parse derives quality from the in-torrent file name', () => {
  const release = extractStreamInfo('The Show S01', '1337x', { season: 1, episode: 3 });
  assert.equal(release.quality, 'SD');

  const merged = extractStreamInfo('The Show S01', '1337x', {
    fileName: 'The.Show.S01E03.1080p.WEB-DL.x265-GRP.mkv',
    season: 1,
    episode: 3
  });
  assert.equal(merged.quality, '1080P');
});

test('double parse lets the file resolution win over a pack title', () => {
  const merged = extractStreamInfo('The Show 2160p COMPLETE PACK', '1337x', {
    fileName: 'The.Show.S01E05.1080p.x264.mkv',
    season: 1,
    episode: 5
  });
  assert.equal(merged.quality, '1080P');
});

test('double parse unions languages from release and file', () => {
  const merged = extractStreamInfo('The Show S01 ITA', '1337x', {
    fileName: 'The.Show.S01E03.1080p.ENG.mkv',
    season: 1,
    episode: 3
  });
  assert.match(merged.lang, /🇮🇹/);
  assert.match(merged.lang, /🇬🇧/);
});

test('double parse is inert when no distinct file name is provided', () => {
  const a = extractStreamInfo('The Movie 2021 1080p BluRay x264-GRP', 'YTS', {});
  const b = extractStreamInfo('The Movie 2021 1080p BluRay x264-GRP', 'YTS', {
    fileName: 'The Movie 2021 1080p BluRay x264-GRP'
  });
  assert.equal(a.quality, b.quality);
  assert.equal(a.releaseGroup, b.releaseGroup);
});
