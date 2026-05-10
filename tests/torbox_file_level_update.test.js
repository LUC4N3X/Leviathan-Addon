'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../core/debrid/availability/torbox_availability_cache');

test('TorBox DB update keeps episode identity for file-level cache hints', () => {
  const update = __private.buildDbUpdate(
    'c'.repeat(40),
    { cached: true, file_id: 22, file_size: 987654, torrent_title: 'Show S01 Pack' },
    { imdbId: 'tt1111111', isEpisodeRequest: true, season: 1, episode: 6 }
  );

  assert.equal(update.hash, 'c'.repeat(40));
  assert.equal(update.cached, true);
  assert.equal(update.file_id, 22);
  assert.equal(update.file_size, 987654);
  assert.equal(update.imdb_id, 'tt1111111');
  assert.equal(update.imdb_season, 1);
  assert.equal(update.imdb_episode, 6);
});
