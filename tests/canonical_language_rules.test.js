'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/golden_cases.json');
const { resolveLangMode } = require('../core/canonical/language_rules');

for (const fixture of fixtures.languageModes) {
  test(`resolveLangMode: ${fixture.name}`, () => {
    assert.equal(resolveLangMode(fixture.input), fixture.expected);
  });
}
