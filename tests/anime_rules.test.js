'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/golden_cases.json');
const { shouldIgnoreAnimeSeason } = require('../core/canonical/anime_rules');

for (const fixture of fixtures.animeSeasonRules) {
  test(`shouldIgnoreAnimeSeason: ${fixture.title}`, () => {
    assert.equal(shouldIgnoreAnimeSeason(fixture.meta, fixture.type, fixture.title), fixture.expected);
  });
}
