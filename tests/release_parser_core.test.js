'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTitle, parseTitleDetails } = require('../core/intelligence/release_parser');

test('release parser keeps title words that look like language tokens', () => {
  const parsed = parseTitle('The.Italian.Job.2003.1080p.WEB-DL.ENG.mkv');
  assert.equal(parsed.cleanTitle, 'The Italian Job');
  assert.deepEqual(parsed.languages, ['english']);
});

test('release parser extracts series episode, ITA/ENG and audio profile', () => {
  const parsed = parseTitle('Game.of.Thrones.S01E01.1080p.WEB-DL.ITA.ENG.DDP5.1.H264-GRP.mkv');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 1);
  assert.equal(parsed.resolution, '1080p');
  assert.equal(parsed.source, 'WEB-DL');
  assert.equal(parsed.audioChannels, '5.1');
  assert.equal(parsed.releaseGroup, 'GRP');
  assert.ok(parsed.languages.includes('italian'));
  assert.ok(parsed.languages.includes('english'));
});

test('release parser handles anime absolute episode numbers', () => {
  const parsed = parseTitle('[SubsPlease] One Piece - 1071 (1080p) [ITA].mkv');
  assert.equal(parsed.cleanTitle, 'One Piece');
  assert.equal(parsed.episode, 1071);
  assert.equal(parsed.absoluteEpisode, 1071);
  assert.equal(parsed.releaseGroup, 'SUBSPLEASE');
});

test('release parser marks season packs and exposes details shape', () => {
  const details = parseTitleDetails('Show.S02.Complete.1080p.WEB-DL.MULTI.ITA.ENG.x265.mkv');
  assert.equal(details.cleanTitle, 'Show');
  assert.equal(details.isPack, true);
  assert.equal(details.isSeasonPack, true);
  assert.ok(details.rawLanguages.includes('Italian'));
  assert.ok(details.rawLanguages.includes('English'));
  assert.ok(details.languages.includes('🌍 MULTI'));
});
