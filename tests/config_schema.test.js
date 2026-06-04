'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CURRENT_CONFIG_VERSION, validateConfig, decodeConfigBase64 } = require('../core/config/schema');
const { encryptConfigObject } = require('../core/security/user_config_crypto');

test('validateConfig migrates aliases and version', () => {
  const config = validateConfig({
    filters: {
      enableVix: true,
      enableCc: true,
      enableToonItalia: true,
      vixLast: true,
      language: 'ITA',
      providers: 'torrentio,comet'
    }
  });

  assert.equal(config.configVersion, CURRENT_CONFIG_VERSION);
  assert.equal(config.filters.enableStreamingCommunity, true);
  assert.equal(config.filters.enableCc, true);
  assert.equal(config.filters.enableToonItalia, true);
  assert.equal(config.filters.streamingCommunityLast, true);
  assert.deepEqual(config.filters.providers, ['torrentio', 'comet']);
  assert.equal(config.filters.language, 'ita');
  assert.equal(config.filters.sourceMode, 'balanced');
});

test('validateConfig migrates the legacy GuardaserieTV toggle to VidxGo', () => {
  const config = validateConfig({
    filters: {
      enableGstv: true
    }
  });

  assert.equal(config.filters.enableVidxgo, true);
  assert.equal(config.filters.enableGstv, undefined);
});

test('validateConfig keeps an explicit VidxGo toggle over the legacy flag', () => {
  const config = validateConfig({
    filters: {
      enableGstv: true,
      enableVidxgo: false
    }
  });

  assert.equal(config.filters.enableVidxgo, false);
  assert.equal(config.filters.enableGstv, undefined);
});

test('validateConfig normalizes source mode aliases', () => {
  const config = validateConfig({
    filters: {
      source_mode: 'cacheOnly'
    }
  });

  assert.equal(config.filters.sourceMode, 'globalCacheOnly');
  assert.equal(config.filters.dbOnly, false);
});


test('decodeConfigBase64 supports encrypted user config tokens', async () => {
  const token = await encryptConfigObject({
    service: 'rd',
    key: 'secret-token',
    filters: {
      enableGhd: true,
      language: 'ita'
    }
  });

  const decoded = JSON.parse(decodeConfigBase64(token));

  assert.equal(decoded.service, 'rd');
  assert.equal(decoded.key, 'secret-token');
  assert.equal(decoded.filters.enableGhd, true);
});

test('validateConfig normalizes saved cloud aggressive and torrent intelligence settings', () => {
  const config = validateConfig({
    filters: {
      enableSavedCloud: true,
      savedCloudAggressive: true,
      savedCloudScanLimit: '333',
      savedCloudSnapshotTtlSeconds: '3600',
      useTorrentIntelligenceRanking: true
    },
    ranking: {
      torrentIntelligenceWeight: '1.5'
    }
  });

  assert.equal(config.filters.enableSavedCloud, true);
  assert.equal(config.filters.savedCloudAggressive, true);
  assert.equal(config.filters.savedCloudScanLimit, 333);
  assert.equal(config.filters.savedCloudSnapshotTtlSeconds, 3600);
  assert.equal(config.ranking.useTorrentIntelligenceRanking, true);
  assert.equal(config.ranking.torrentIntelligenceWeight, 1.5);
});
