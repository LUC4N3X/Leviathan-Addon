'use strict';

const CURRENT_CONFIG_VERSION = 1;
const { isEncryptedConfigToken, decryptConfigToken } = require('../security/user_config_crypto');
const { getCachedAppSettings, normalizeBool, normalizeInt } = require('./app_settings');
const APP_SETTINGS = getCachedAppSettings();
const MAX_CONFIG_LENGTH = APP_SETTINGS.config.maxConfigLength;
const ADMIN_PASS = APP_SETTINGS.config.adminPass;
const ALLOWED_SERVICES = new Set(['rd', 'tb', 'p2p', 'web']);
const { SOURCE_MODES, normalizeSourceMode } = require('./source_mode');

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,|;]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return value;
}

function safeDecodeUriComponent(value) {
  try { return decodeURIComponent(value); }
  catch (_) { return value; }
}

function decodeConfigBase64(configStr) {
  const rawInput = String(configStr || '').trim();
  const raw = safeDecodeUriComponent(rawInput);
  if (!raw) return '{}';
  if (isEncryptedConfigToken(raw)) return decryptConfigToken(raw);

  if (/^[\[{]/.test(raw)) return raw;

  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const decoded = Buffer.from(normalized + padding, 'base64').toString('utf8');

  if (!/^[\s]*[\[{]/.test(decoded)) {
    throw new Error('Config token non JSON: rigenera il link/installazione dal pannello Leviathan');
  }

  return decoded;
}

function getDefaultConfig() {
  return {
    configVersion: CURRENT_CONFIG_VERSION,
    service: 'rd',
    filters: {
      language: 'ita',
      sourceMode: SOURCE_MODES.BALANCED
    }
  };
}

function migrateConfig(input = {}) {
  const config = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  const version = Number.isInteger(Number(config.configVersion)) ? Number(config.configVersion) : 0;
  config.filters = config.filters && typeof config.filters === 'object' && !Array.isArray(config.filters) ? { ...config.filters } : {};

  const aliasPairs = [
    ['enableStreamingCommunity', 'enableVix'],
    ['streamingCommunityLast', 'vixLast']
  ];
  for (const [primaryKey, legacyKey] of aliasPairs) {
    const primaryValue = config.filters[primaryKey];
    const legacyValue = config.filters[legacyKey];
    if (primaryValue !== undefined && legacyValue === undefined) config.filters[legacyKey] = primaryValue;
    if (legacyValue !== undefined && primaryValue === undefined) config.filters[primaryKey] = legacyValue;
  }

  if (version < 1) {
    if (!config.configVersion) config.configVersion = CURRENT_CONFIG_VERSION;
  }

  return config;
}

function validateConfig(input = {}) {
  const config = migrateConfig(input);
  const output = {
    ...getDefaultConfig(),
    ...config,
    filters: {
      ...getDefaultConfig().filters,
      ...(config.filters || {})
    }
  };

  const normalizedService = String(output.service || '').toLowerCase();
  if (normalizedService && ALLOWED_SERVICES.has(normalizedService)) output.service = normalizedService;
  else if (normalizedService) output.service = getDefaultConfig().service;

  delete output.ad;
  delete output.alldebrid;
  if (output.service === 'ad') output.service = getDefaultConfig().service;

  const numericFilterKeys = ['maxPerQuality', 'maxSizeGB', 'minSizeGB', 'maxSizeBytes', 'minSizeBytes', 'instantDebridTop', 'warmupTop', 'savedCloudMax', 'savedCloudScanLimit', 'savedCloudSnapshotTtlSeconds', 'externalSnapshotTtl', 'minSeeders', 'maxSeeders'];
  for (const key of numericFilterKeys) {
    if (output.filters[key] !== undefined && output.filters[key] !== null && output.filters[key] !== '') {
      const value = parseInt(output.filters[key], 10);
      if (Number.isNaN(value)) delete output.filters[key];
      else output.filters[key] = value;
    }
  }

  const arrayFilterKeys = [
    'providers',
    'providerAllow',
    'providerInclude',
    'providerExclude',
    'providerDeny',
    'providerBlock',
    'qualityAllow',
    'qualityInclude',
    'qualityExclude',
    'qualityDeny',
    'qualityFilter',
    'requireTags',
    'excludeTags',
    'preferredResolutions',
    'preferredLanguages',
    'preferredQualities',
    'preferredVisualTags',
    'preferredHdr'
  ];
  for (const key of arrayFilterKeys) {
    if (output.filters[key] !== undefined) output.filters[key] = normalizeStringArray(output.filters[key]);
  }

  const stringFilterKeys = ['streamExpression'];
  for (const key of stringFilterKeys) {
    if (output.filters[key] !== undefined && output.filters[key] !== null) {
      const value = String(output.filters[key]).trim().slice(0, 1000);
      if (value) output.filters[key] = value;
      else delete output.filters[key];
    }
  }

  const booleanFilterKeys = ['enableVix', 'enableStreamingCommunity', 'enableGhd', 'enableGs', 'enableVidxgo', 'enableEs', 'enableCb01', 'enableOnlineserietv', 'enableAnimeWorld', 'enableAnimeUnity', 'enableAnimeSaturn', 'enableGf', 'enableCc', 'enableAltadefinizione', 'enableToonItalia', 'enableMoflix', 'enableSavedCloud', 'enableP2P', 'showFake', 'dbOnly', 'allowEng', 'no4k', 'no1080', 'no720', 'noScr', 'noCam', 'enableTrailers', 'vixLast', 'streamingCommunityLast', 'savedCloudAggressive', 'savedCloudSnapshotEnabled', 'useTorrentIntelligenceRanking', 'useLeviathanScoreProfile'];
  for (const key of booleanFilterKeys) {
    if (output.filters[key] !== undefined) output.filters[key] = !!output.filters[key];
  }

  const explicitSourceMode = config?.filters?.sourceMode ?? config?.filters?.source_mode ?? output.filters.sourceMode;
  output.filters.sourceMode = normalizeSourceMode(explicitSourceMode || (output.filters.dbOnly === true ? SOURCE_MODES.DB_ONLY : SOURCE_MODES.BALANCED));
  delete output.filters.source_mode;
  output.filters.dbOnly = output.filters.sourceMode === SOURCE_MODES.DB_ONLY;

  const normalizedLanguage = String(output.filters.language || '').toLowerCase();
  output.filters.language = ['ita', 'eng', 'all'].includes(normalizedLanguage)
    ? normalizedLanguage
    : (output.filters.allowEng ? 'all' : getDefaultConfig().filters.language);

  const normalizedSavedCloudMode = String(output.filters.savedCloudMode || (output.filters.enableSavedCloud ? 'smart' : 'off')).toLowerCase();
  output.filters.savedCloudMode = ['off', 'smart', 'fallback', 'always'].includes(normalizedSavedCloudMode)
    ? normalizedSavedCloudMode
    : (output.filters.enableSavedCloud ? 'smart' : 'off');
  if (output.filters.savedCloudMode === 'off') output.filters.enableSavedCloud = false;
  if (output.filters.enableSavedCloud && (!output.filters.savedCloudMax || output.filters.savedCloudMax < 1)) output.filters.savedCloudMax = 6;

  output.filters.savedCloudAggressive = output.filters.savedCloudAggressive !== undefined
    ? output.filters.savedCloudAggressive
    : APP_SETTINGS.savedCloud.aggressive;
  output.filters.savedCloudSnapshotEnabled = output.filters.savedCloudSnapshotEnabled !== undefined
    ? output.filters.savedCloudSnapshotEnabled
    : APP_SETTINGS.savedCloud.snapshotEnabled;
  output.filters.savedCloudScanLimit = normalizeInt(output.filters.savedCloudScanLimit, APP_SETTINGS.savedCloud.scanLimit, 20, 500);
  output.filters.savedCloudSnapshotTtlSeconds = normalizeInt(output.filters.savedCloudSnapshotTtlSeconds, APP_SETTINGS.savedCloud.snapshotTtlSec, 60, 604800);

  output.ranking = output.ranking && typeof output.ranking === 'object' && !Array.isArray(output.ranking) ? { ...output.ranking } : {};
  output.ranking.useTorrentIntelligenceRanking = output.filters.useTorrentIntelligenceRanking !== undefined
    ? normalizeBool(output.filters.useTorrentIntelligenceRanking, APP_SETTINGS.ranking.torrentIntelligenceEnabled)
    : normalizeBool(output.ranking.useTorrentIntelligenceRanking, APP_SETTINGS.ranking.torrentIntelligenceEnabled);
  output.ranking.torrentIntelligenceWeight = Math.max(0, Math.min(5, Number(output.ranking.torrentIntelligenceWeight || APP_SETTINGS.ranking.torrentIntelligenceWeight) || APP_SETTINGS.ranking.torrentIntelligenceWeight));

  output.configVersion = CURRENT_CONFIG_VERSION;
  return output;
}

module.exports = {
  CURRENT_CONFIG_VERSION,
  MAX_CONFIG_LENGTH,
  ADMIN_PASS,
  decodeConfigBase64,
  getDefaultConfig,
  migrateConfig,
  normalizeStringArray,
  validateConfig
};
