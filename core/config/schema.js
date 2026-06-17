'use strict';

const CURRENT_CONFIG_VERSION = 1;

const {
  isEncryptedConfigToken,
  decryptConfigToken
} = require('../security/user_config_crypto');

const {
  getCachedAppSettings,
  normalizeBool,
  normalizeInt
} = require('./app_settings');

const {
  SOURCE_MODES,
  normalizeSourceMode
} = require('./source_mode');

const APP_SETTINGS = getCachedAppSettings() || {};
const CONFIG_SETTINGS = APP_SETTINGS.config || {};
const SAVED_CLOUD_SETTINGS = APP_SETTINGS.savedCloud || {};
const RANKING_SETTINGS = APP_SETTINGS.ranking || {};

const MAX_CONFIG_LENGTH = positiveInt(CONFIG_SETTINGS.maxConfigLength, 16 * 1024);
const ADMIN_PASS = CONFIG_SETTINGS.adminPass;

const ALLOWED_SERVICES = new Set(['rd', 'tb', 'p2p', 'web']);

const DANGEROUS_OBJECT_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor'
]);

const NUMERIC_FILTER_KEYS = [
  'maxPerQuality',
  'maxSizeGB',
  'minSizeGB',
  'maxSizeBytes',
  'minSizeBytes',
  'instantDebridTop',
  'warmupTop',
  'savedCloudMax',
  'savedCloudScanLimit',
  'savedCloudSnapshotTtlSeconds',
  'externalSnapshotTtl',
  'minSeeders',
  'maxSeeders'
];

const ARRAY_FILTER_KEYS = [
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

const BOOLEAN_FILTER_KEYS = [
  'enableVix',
  'enableStreamingCommunity',
  'enableGhd',
  'enableGs',
  'enableVidxgo',
  'enableEs',
  'enableCb01',
  'enableOnlineserietv',
  'enableAnimeWorld',
  'enableAnimeUnity',
  'enableAnimeSaturn',
  'enableGf',
  'enableAltadefinizione',
  'enableToonItalia',
  'enableMoflix',
  'enableSavedCloud',
  'enableP2P',
  'showFake',
  'dbOnly',
  'allowEng',
  'no4k',
  'no1080',
  'no720',
  'noScr',
  'noCam',
  'noHardcodedSubs',
  'enableTrailers',
  'vixLast',
  'streamingCommunityLast',
  'savedCloudAggressive',
  'savedCloudSnapshotEnabled',
  'useTorrentIntelligenceRanking',
  'useQualityIntelligenceRanking',
  'useLeviathanScoreProfile'
];

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cleanPlainObject(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanPlainObject(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const output = {};

  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) continue;
    output[key] = cleanPlainObject(entry);
  }

  return output;
}

function normalizeStringArray(value) {
  const rawEntries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : value === undefined || value === null
        ? []
        : [value];

  const output = [];
  const seen = new Set();

  for (const rawEntry of rawEntries) {
    const chunks = String(rawEntry || '')
      .split(/[,|;]/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const chunk of chunks) {
      const dedupeKey = chunk.toLowerCase();
      if (seen.has(dedupeKey)) continue;

      seen.add(dedupeKey);
      output.push(chunk);
    }
  }

  return output;
}

function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function assertConfigLength(value, label = 'Config') {
  const length = String(value || '').length;

  if (MAX_CONFIG_LENGTH > 0 && length > MAX_CONFIG_LENGTH) {
    throw new Error(`${label} troppo lunga: rigenera il link/installazione dal pannello Leviathan`);
  }
}

function looksLikeJson(value = '') {
  return /^[\s]*[\[{]/.test(String(value || ''));
}

function decodeBase64UrlToString(value = '') {
  const compact = String(value || '').replace(/\s+/g, '');

  if (!compact) return '';

  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    throw new Error('Config token non valido: rigenera il link/installazione dal pannello Leviathan');
  }

  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0
    ? ''
    : '='.repeat(4 - (normalized.length % 4));

  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function decodeConfigBase64(configStr) {
  const rawInput = String(configStr || '').trim();

  assertConfigLength(rawInput, 'Config token');

  const raw = safeDecodeUriComponent(rawInput).trim();

  assertConfigLength(raw, 'Config token');

  if (!raw) return '{}';

  if (isEncryptedConfigToken(raw)) {
    const decrypted = decryptConfigToken(raw);

    assertConfigLength(decrypted, 'Config decifrata');

    if (!looksLikeJson(decrypted)) {
      throw new Error('Config decifrata non JSON: rigenera il link/installazione dal pannello Leviathan');
    }

    return decrypted;
  }

  if (looksLikeJson(raw)) {
    return raw;
  }

  const decoded = decodeBase64UrlToString(raw);

  assertConfigLength(decoded, 'Config decodificata');

  if (!looksLikeJson(decoded)) {
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
  const config = isPlainObject(input)
    ? cleanPlainObject(input)
    : {};

  const version = Number.isInteger(Number(config.configVersion))
    ? Number(config.configVersion)
    : 0;

  config.filters = isPlainObject(config.filters)
    ? cleanPlainObject(config.filters)
    : {};

  const aliasPairs = [
    ['enableStreamingCommunity', 'enableVix'],
    ['streamingCommunityLast', 'vixLast']
  ];

  for (const [primaryKey, legacyKey] of aliasPairs) {
    const primaryValue = config.filters[primaryKey];
    const legacyValue = config.filters[legacyKey];

    if (primaryValue !== undefined && legacyValue === undefined) {
      config.filters[legacyKey] = primaryValue;
    }

    if (legacyValue !== undefined && primaryValue === undefined) {
      config.filters[primaryKey] = legacyValue;
    }
  }

  const renamedFilterKeys = [
    ['enableGstv', 'enableVidxgo']
  ];

  for (const [legacyKey, currentKey] of renamedFilterKeys) {
    if (config.filters[legacyKey] !== undefined) {
      if (config.filters[currentKey] === undefined) {
        config.filters[currentKey] = config.filters[legacyKey];
      }

      delete config.filters[legacyKey];
    }
  }

  if (config.filters.source_mode !== undefined && config.filters.sourceMode === undefined) {
    config.filters.sourceMode = config.filters.source_mode;
  }

  delete config.filters.source_mode;

  if (version < CURRENT_CONFIG_VERSION) {
    config.configVersion = CURRENT_CONFIG_VERSION;
  }

  return config;
}

function normalizeIntegerFilterValue(value) {
  if (value === undefined || value === null || value === '') return undefined;

  const parsed = parseInt(value, 10);

  if (Number.isNaN(parsed)) return undefined;

  return parsed;
}

function normalizeExplicitBool(value) {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();

    if (!lower) return false;

    if (['false', '0', 'no', 'off', 'disabled', 'disable', 'null', 'none'].includes(lower)) {
      return false;
    }

    if (['true', '1', 'yes', 'on', 'enabled', 'enable'].includes(lower)) {
      return true;
    }

    return Boolean(lower);
  }

  return Boolean(value);
}

function normalizeLanguage(value, allowEng = false) {
  const normalized = String(value || '').trim().toLowerCase();

  if (['ita', 'it', 'italian', 'italiano'].includes(normalized)) {
    return 'ita';
  }

  if (normalized === 'eng') {
    return 'eng';
  }

  if (normalized === 'all') {
    return 'all';
  }

  return allowEng ? 'all' : getDefaultConfig().filters.language;
}

function normalizeSavedCloudMode(value, fallback = 'off') {
  const normalized = String(value || fallback || 'off').trim().toLowerCase();

  if (['off', 'smart', 'fallback', 'always'].includes(normalized)) {
    return normalized;
  }

  return fallback;
}

function safeNormalizeInt(value, fallback, min, max) {
  try {
    return normalizeInt(value, fallback, min, max);
  } catch (_) {
    const parsed = parseInt(value, 10);

    if (Number.isNaN(parsed)) return fallback;
    if (Number.isFinite(min) && parsed < min) return min;
    if (Number.isFinite(max) && parsed > max) return max;

    return parsed;
  }
}

function safeNormalizeBool(value, fallback) {
  try {
    return normalizeBool(value, fallback);
  } catch (_) {
    if (value === undefined || value === null || value === '') return fallback;
    return normalizeExplicitBool(value);
  }
}

function validateConfig(input = {}) {
  const defaults = getDefaultConfig();
  const config = migrateConfig(input);

  const output = {
    ...defaults,
    ...config,
    filters: {
      ...defaults.filters,
      ...(config.filters || {})
    }
  };

  const normalizedService = String(output.service || '').trim().toLowerCase();

  output.service = ALLOWED_SERVICES.has(normalizedService)
    ? normalizedService
    : defaults.service;

  delete output.ad;
  delete output.alldebrid;

  if (output.service === 'ad') {
    output.service = defaults.service;
  }

  for (const key of NUMERIC_FILTER_KEYS) {
    if (output.filters[key] === undefined || output.filters[key] === null || output.filters[key] === '') {
      continue;
    }

    const normalized = normalizeIntegerFilterValue(output.filters[key]);

    if (normalized === undefined) {
      delete output.filters[key];
    } else {
      output.filters[key] = normalized;
    }
  }

  for (const key of ARRAY_FILTER_KEYS) {
    if (output.filters[key] !== undefined) {
      output.filters[key] = normalizeStringArray(output.filters[key]);
    }
  }

  if (output.filters.streamExpression !== undefined && output.filters.streamExpression !== null) {
    const value = String(output.filters.streamExpression).trim().slice(0, 1000);

    if (value) {
      output.filters.streamExpression = value;
    } else {
      delete output.filters.streamExpression;
    }
  }

  for (const key of BOOLEAN_FILTER_KEYS) {
    if (output.filters[key] !== undefined) {
      output.filters[key] = normalizeExplicitBool(output.filters[key]);
    }
  }

  const explicitSourceMode = output.filters.sourceMode;
  const fallbackSourceMode = output.filters.dbOnly === true
    ? SOURCE_MODES.DB_ONLY
    : SOURCE_MODES.BALANCED;

  output.filters.sourceMode = normalizeSourceMode(explicitSourceMode || fallbackSourceMode);
  output.filters.dbOnly = output.filters.sourceMode === SOURCE_MODES.DB_ONLY;

  output.filters.language = normalizeLanguage(
    output.filters.language,
    output.filters.allowEng === true
  );

  const explicitSavedCloudMode = config.filters?.savedCloudMode !== undefined;
  const savedCloudFallback = output.filters.enableSavedCloud === true ? 'smart' : 'off';

  output.filters.savedCloudMode = normalizeSavedCloudMode(
    output.filters.savedCloudMode,
    savedCloudFallback
  );

  if (output.filters.savedCloudMode === 'off') {
    output.filters.enableSavedCloud = false;
  } else if (explicitSavedCloudMode || output.filters.enableSavedCloud === true) {
    output.filters.enableSavedCloud = true;
  }

  if (
    output.filters.enableSavedCloud
    && (!output.filters.savedCloudMax || output.filters.savedCloudMax < 1)
  ) {
    output.filters.savedCloudMax = 6;
  }

  output.filters.savedCloudAggressive = output.filters.savedCloudAggressive !== undefined
    ? output.filters.savedCloudAggressive
    : Boolean(SAVED_CLOUD_SETTINGS.aggressive);

  output.filters.savedCloudSnapshotEnabled = output.filters.savedCloudSnapshotEnabled !== undefined
    ? output.filters.savedCloudSnapshotEnabled
    : Boolean(SAVED_CLOUD_SETTINGS.snapshotEnabled);

  output.filters.savedCloudScanLimit = safeNormalizeInt(
    output.filters.savedCloudScanLimit,
    positiveInt(SAVED_CLOUD_SETTINGS.scanLimit, 100),
    20,
    500
  );

  output.filters.savedCloudSnapshotTtlSeconds = safeNormalizeInt(
    output.filters.savedCloudSnapshotTtlSeconds,
    positiveInt(SAVED_CLOUD_SETTINGS.snapshotTtlSec, 3600),
    60,
    604800
  );

  output.ranking = isPlainObject(output.ranking)
    ? cleanPlainObject(output.ranking)
    : {};

  output.ranking.useTorrentIntelligenceRanking = output.filters.useTorrentIntelligenceRanking !== undefined
    ? safeNormalizeBool(
        output.filters.useTorrentIntelligenceRanking,
        Boolean(RANKING_SETTINGS.torrentIntelligenceEnabled)
      )
    : safeNormalizeBool(
        output.ranking.useTorrentIntelligenceRanking,
        Boolean(RANKING_SETTINGS.torrentIntelligenceEnabled)
      );

  output.ranking.useQualityIntelligenceRanking = output.filters.useQualityIntelligenceRanking !== undefined
    ? safeNormalizeBool(
        output.filters.useQualityIntelligenceRanking,
        Boolean(RANKING_SETTINGS.qualityIntelligenceEnabled)
      )
    : safeNormalizeBool(
        output.ranking.useQualityIntelligenceRanking,
        Boolean(RANKING_SETTINGS.qualityIntelligenceEnabled)
      );

  const torrentWeight = Number(
    output.ranking.torrentIntelligenceWeight
    ?? RANKING_SETTINGS.torrentIntelligenceWeight
    ?? 1
  );

  output.ranking.torrentIntelligenceWeight = Math.max(
    0,
    Math.min(5, Number.isFinite(torrentWeight) ? torrentWeight : 1)
  );

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
