const { normalizeLangMode } = require('../canonical/language_rules');

const CURRENT_CONFIG_VERSION = 2;

const DEFAULT_FILTERS = Object.freeze({
  language: 'ita',
  allowEng: false,
  enableVix: true,
  enableStreamingCommunity: true,
  enableGhd: true,
  enableGs: true,
  enableAnimeWorld: true,
  enableGf: true,
  enableP2P: false,
  showFake: false,
  dbOnly: false,
  no4k: false,
  no1080: false,
  no720: false,
  noScr: false,
  noCam: false,
  enableTrailers: false,
  vixLast: false,
  streamingCommunityLast: false
});

function cloneDefaultFilters() {
  return { ...DEFAULT_FILTERS };
}

function coerceObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function migrateConfig(parsed = {}) {
  const source = coerceObject(parsed);
  const migrated = { ...source };
  const version = Number.isInteger(Number(source.configVersion)) ? Number(source.configVersion) : 1;

  migrated.filters = coerceObject(source.filters);

  const aliasPairs = [
    ['enableStreamingCommunity', 'enableVix'],
    ['streamingCommunityLast', 'vixLast']
  ];
  for (const [primaryKey, legacyKey] of aliasPairs) {
    const primaryValue = migrated.filters[primaryKey];
    const legacyValue = migrated.filters[legacyKey];
    if (primaryValue !== undefined && legacyValue === undefined) migrated.filters[legacyKey] = primaryValue;
    if (legacyValue !== undefined && primaryValue === undefined) migrated.filters[primaryKey] = legacyValue;
  }

  if (version < CURRENT_CONFIG_VERSION) {
    migrated.configVersion = CURRENT_CONFIG_VERSION;
  } else {
    migrated.configVersion = version;
  }

  return migrated;
}

function normalizeArrayFilter(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,|;]/).map((entry) => entry.trim()).filter(Boolean);
  return undefined;
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeInteger(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function validateAndNormalizeConfig(parsed = {}) {
  const migrated = migrateConfig(parsed);
  const config = { ...migrated };
  const filters = { ...cloneDefaultFilters(), ...coerceObject(migrated.filters) };

  const normalizedService = String(config.service || '').toLowerCase();
  const allowedServices = new Set(['rd', 'tb', 'p2p', 'web']);
  if (normalizedService && allowedServices.has(normalizedService)) config.service = normalizedService;
  else delete config.service;

  delete config.ad;
  delete config.alldebrid;
  if (normalizedService === 'ad') delete config.key;

  const numericFilterKeys = ['maxPerQuality', 'maxSizeGB', 'minSizeGB', 'maxSizeBytes', 'minSizeBytes', 'instantDebridTop', 'warmupTop', 'minSeeders', 'maxSeeders'];
  for (const key of numericFilterKeys) {
    const normalized = normalizeInteger(filters[key]);
    if (normalized === undefined) delete filters[key];
    else filters[key] = normalized;
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
    'excludeTags'
  ];
  for (const key of arrayFilterKeys) {
    const normalized = normalizeArrayFilter(filters[key]);
    if (normalized === undefined) delete filters[key];
    else filters[key] = normalized;
  }

  const booleanFilterKeys = ['enableVix', 'enableStreamingCommunity', 'enableGhd', 'enableGs', 'enableAnimeWorld', 'enableGf', 'enableP2P', 'showFake', 'dbOnly', 'allowEng', 'no4k', 'no1080', 'no720', 'noScr', 'noCam', 'enableTrailers', 'vixLast', 'streamingCommunityLast'];
  for (const key of booleanFilterKeys) {
    filters[key] = normalizeBoolean(filters[key], DEFAULT_FILTERS[key]);
  }

  const explicitLanguage = normalizeLangMode(migrated.filters?.language);
  filters.language = explicitLanguage || (filters.allowEng ? 'all' : DEFAULT_FILTERS.language);
  config.filters = filters;
  config.configVersion = CURRENT_CONFIG_VERSION;
  return config;
}

module.exports = {
  CURRENT_CONFIG_VERSION,
  DEFAULT_FILTERS,
  migrateConfig,
  validateAndNormalizeConfig
};
