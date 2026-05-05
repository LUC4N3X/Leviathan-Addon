'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/golden_cases.json');
const { tokenizeTitle, hasExplicitSeasonMarker } = require('../core/canonical/title_parser');

for (const fixture of fixtures.titles) {
  test(`tokenizeTitle: ${fixture.name}`, () => {
    const tokens = tokenizeTitle(fixture.input, { keepNumbers: true });
    for (const token of fixture.expectedTokens) assert.ok(tokens.includes(token));
  });
}

for (const fixture of fixtures.seasons) {
  test(`hasExplicitSeasonMarker: ${fixture.title}`, () => {
    assert.equal(hasExplicitSeasonMarker(fixture.title), fixture.expected);
  });
}
