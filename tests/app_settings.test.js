'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEnvSource,
  normalizeBool,
  normalizeInt,
  normalizeList,
  normalizeSourceMode,
  resetAppSettingsCache,
  getCachedAppSettings
} = require('../core/config/app_settings');

test('app settings normalizers are strict and bounded', () => {
  assert.equal(normalizeBool('yes'), true);
  assert.equal(normalizeBool('off', true), false);
  assert.equal(normalizeInt('999', 1, 1, 10), 10);
  assert.deepEqual(normalizeList('["a","b"]'), ['a', 'b']);
  assert.equal(normalizeSourceMode('background'), 'background');
  assert.equal(normalizeSourceMode('live-only'), 'live');
});

test('app settings exposes comet-style source mode from env', () => {
  const previous = process.env.EXT_SOURCE_COMET;
  process.env.EXT_SOURCE_COMET = 'both';
  const source = buildEnvSource('comet', { mode: 'background' });
  assert.equal(source.mode, 'both');
  assert.equal(source.live, true);
  assert.equal(source.background, true);
  if (previous === undefined) delete process.env.EXT_SOURCE_COMET;
  else process.env.EXT_SOURCE_COMET = previous;
});

test('cached app settings can be reset for tests', () => {
  resetAppSettingsCache();
  const settings = getCachedAppSettings();
  assert.equal(settings.ranking.torrentIntelligenceEnabled, true);
  assert.ok(settings.savedCloud.scanLimit >= 20);
});
