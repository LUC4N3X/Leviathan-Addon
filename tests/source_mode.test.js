'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasWebProvidersEnabled,
  shouldUseTorrentPipeline
} = require('../core/source_mode');
const { validateConfig } = require('../core/config/schema');

test('hasWebProvidersEnabled detects active web providers', () => {
  assert.equal(hasWebProvidersEnabled({}), false);
  assert.equal(hasWebProvidersEnabled({ enableAnimeWorld: true }), true);
  assert.equal(hasWebProvidersEnabled({ enableCc: true }), true);
  assert.equal(hasWebProvidersEnabled({ enableStreamingCommunity: true }), true);
});

test('shouldUseTorrentPipeline disables torrent search in web-only mode', () => {
  const filters = {
    enableAnimeWorld: true,
    enableAnimeSaturn: true,
    enableP2P: false
  };

  assert.equal(shouldUseTorrentPipeline({ filters, hasDebridKey: false, isP2PEnabled: false }), false);
  assert.equal(shouldUseTorrentPipeline({ filters, hasDebridKey: true, isP2PEnabled: false }), true);
  assert.equal(shouldUseTorrentPipeline({ filters, hasDebridKey: false, isP2PEnabled: true }), true);
  assert.equal(shouldUseTorrentPipeline({ filters: {}, hasDebridKey: false, isP2PEnabled: false }), true);
});

test('validateConfig preserves explicit web service', () => {
  const config = validateConfig({
    service: 'web',
    filters: {
      enableAnimeWorld: true,
      enableCc: true
    }
  });

  assert.equal(config.service, 'web');
  assert.equal(config.filters.enableCc, true);
});
