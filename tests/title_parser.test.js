const test = require('node:test');
const assert = require('node:assert/strict');

const {
  tokenizeTitle,
  hasExplicitSeasonMarker,
  parseSeasonEpisode,
  extractSeasonFromText
} = require('../core/canonical/title_parser');

test('tokenizeTitle removes common release noise but keeps the real title', () => {
  const tokens = tokenizeTitle('One.Piece.S01E01.1080p.NF.WEB-DL.MULTI');
  assert.ok(tokens.includes('one'));
  assert.ok(tokens.includes('piece'));
  assert.ok(!tokens.includes('1080p'));
  assert.ok(!tokens.includes('multi'));
});

test('hasExplicitSeasonMarker catches common season syntaxes', () => {
  assert.equal(hasExplicitSeasonMarker('One Piece S01E01'), true);
  assert.equal(hasExplicitSeasonMarker('One Piece 1x01'), true);
  assert.equal(hasExplicitSeasonMarker('One Piece 1st Season - 01'), true);
  assert.equal(hasExplicitSeasonMarker('One Piece - 01'), false);
});

test('parseSeasonEpisode supports episodic and anime absolute numbering', () => {
  assert.deepEqual(parseSeasonEpisode('One Piece S01E01 1080p', 1, { anime: false }), { season: 1, episode: 1 });
  assert.deepEqual(parseSeasonEpisode('[SubsPlease] One Piece - 07 (1080p)', 1, { anime: true }), { season: 1, episode: 7 });
});

test('extractSeasonFromText avoids confusing packs with single episodes', () => {
  assert.equal(extractSeasonFromText('One Piece Season 02 Complete'), 2);
  assert.equal(extractSeasonFromText('One Piece Episode 02'), null);
});
