'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CURRENT_CONFIG_VERSION, validateConfig } = require('../core/config/schema');

test('validateConfig migrates aliases and version', () => {
  const config = validateConfig({
    filters: {
      enableVix: true,
      vixLast: true,
      language: 'ITA',
      providers: 'torrentio,comet'
    }
  });

  assert.equal(config.configVersion, CURRENT_CONFIG_VERSION);
  assert.equal(config.filters.enableStreamingCommunity, true);
  assert.equal(config.filters.streamingCommunityLast, true);
  assert.deepEqual(config.filters.providers, ['torrentio', 'comet']);
  assert.equal(config.filters.language, 'ita');
});
