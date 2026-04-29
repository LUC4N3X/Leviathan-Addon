'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSeasonEpisode } = require('../core/pack_intelligence');

const cases = [
  {
    title: 'anime episode range batch',
    input: 'One Piece 01-12 Batch 1080p',
    expected: { season: 1, episode: 1, isRange: true, rangeEnd: 12 }
  },
  {
    title: 'japanese episode marker',
    input: 'My Hero Academia 第03話 1080p',
    expected: { season: 1, episode: 3 }
  },
  {
    title: 'japanese season marker',
    input: 'My Hero Academia 第2期 第03話 1080p',
    expected: { season: 2, episode: 3 }
  },
  {
    title: 'season batch explicit',
    input: 'Solo Leveling Season 1 01 to 12 Complete',
    expected: { season: 1, episode: 1, isRange: true, rangeEnd: 12 }
  }
];

for (const fixture of cases) {
  test(`parseSeasonEpisode: ${fixture.title}`, () => {
    const parsed = parseSeasonEpisode(fixture.input, 1, { anime: true });
    assert.ok(parsed);
    assert.equal(parsed.season, fixture.expected.season);
    assert.equal(parsed.episode, fixture.expected.episode);
    if (fixture.expected.isRange !== undefined) assert.equal(Boolean(parsed.isRange), fixture.expected.isRange);
    if (fixture.expected.rangeEnd !== undefined) assert.equal(parsed.rangeEnd, fixture.expected.rangeEnd);
  });
}
