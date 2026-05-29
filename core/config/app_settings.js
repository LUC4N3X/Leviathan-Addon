'use strict';

const SOURCE_MODES = Object.freeze({
  LIVE: 'live',
  BACKGROUND: 'background',
  BOTH: 'both',
  FALSE: 'false'
});

function normalizeEnvName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function readRawEnv(names, fallback = undefined) {
  const keys = Array.isArray(names) ? names : [names];
  for (const key of keys) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
  }
  return fallback;
}

function normalizeOptionalString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text || /^(?:none|null|undefined)$/i.test(text)) return fallback;
  return text;
}

function normalizeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

function normalizeInt(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function normalizeFloat(value, fallback, min = -Infinity, max = Infinity) {
  const parsed = Number.parseFloat(value);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((entry) => normalizeOptionalString(entry)).filter(Boolean);
  const text = normalizeOptionalString(value);
  if (!text) return fallback;
  if (/^\s*\[/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((entry) => normalizeOptionalString(entry)).filter(Boolean);
    } catch (_) {}
  }
  return text.split(/[,|;]/g).map((entry) => normalizeOptionalString(entry)).filter(Boolean);
}

function normalizeSourceMode(value, fallback = SOURCE_MODES.FALSE) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[^a-z]+/g, '');
  if (['1', 'true', 'yes', 'on', 'both', 'all'].includes(text)) return SOURCE_MODES.BOTH;
  if (['live', 'liveonly', 'request', 'requests'].includes(text)) return SOURCE_MODES.LIVE;
  if (['background', 'bg', 'worker', 'prewarm'].includes(text)) return SOURCE_MODES.BACKGROUND;
  if (['0', 'false', 'no', 'off', 'disabled', 'none'].includes(text)) return SOURCE_MODES.FALSE;
  return fallback;
}

function buildEnvSource(name, defaults = {}) {
  const envName = normalizeEnvName(name);
  const mode = normalizeSourceMode(readRawEnv([`EXT_SOURCE_${envName}`, `LEVIATHAN_EXT_SOURCE_${envName}`], defaults.mode || SOURCE_MODES.FALSE));
  const urls = normalizeList(readRawEnv([`EXT_SOURCE_${envName}_URL`, `EXT_SOURCE_${envName}_URLS`, `LEVIATHAN_EXT_SOURCE_${envName}_URL`], defaults.urls || []));
  return {
    name: String(name || '').trim().toLowerCase(),
    envName,
    mode,
    enabled: mode !== SOURCE_MODES.FALSE,
    live: mode === SOURCE_MODES.LIVE || mode === SOURCE_MODES.BOTH,
    background: mode === SOURCE_MODES.BACKGROUND || mode === SOURCE_MODES.BOTH,
    urls
  };
}

function getAppSettings() {
  const savedCloudAggressive = normalizeBool(readRawEnv('SAVED_CLOUD_AGGRESSIVE', '1'), true);
  const savedCloudScanLimit = normalizeInt(readRawEnv('SAVED_CLOUD_SCAN_LIMIT', savedCloudAggressive ? '180' : '90'), savedCloudAggressive ? 180 : 90, 20, 500);

  return {
    runtime: {
      nodeEnv: normalizeOptionalString(readRawEnv('NODE_ENV'), 'development'),
      publicBaseUrl: normalizeOptionalString(readRawEnv(['PUBLIC_BASE_URL', 'LEVIATHAN_PUBLIC_BASE_URL']))
    },
    config: {
      maxConfigLength: normalizeInt(readRawEnv('MAX_CONFIG_LENGTH'), 16384, 2048, 262144),
      adminPass: normalizeOptionalString(readRawEnv('ADMIN_PASS'))
    },
    database: {
      enabled: Boolean(readRawEnv(['DATABASE_URL', 'DB_HOST', 'DB_NAME'], '')),
      poolMax: normalizeInt(readRawEnv('DB_POOL_MAX'), 40, 5, 120),
      startupCleanupIntervalSec: normalizeInt(readRawEnv('DB_STARTUP_CLEANUP_INTERVAL_SEC'), 3600, -1, 86400),
      torrentCacheTtlSec: normalizeInt(readRawEnv('POSTGRES_TORRENT_CACHE_TTL_SEC'), 60 * 60 * 24 * 30, -1, 60 * 60 * 24 * 365),
      debridCacheTtlSec: normalizeInt(readRawEnv('POSTGRES_DEBRID_CACHE_TTL_SEC'), 60 * 60 * 24, 60, 60 * 60 * 24 * 30),
      metricsTtlSec: normalizeInt(readRawEnv('POSTGRES_METRICS_TTL_SEC'), 60 * 60 * 24 * 30, 3600, 60 * 60 * 24 * 365),
      historyTtlSec: normalizeInt(readRawEnv('POSTGRES_HISTORY_TTL_SEC'), 60 * 60 * 24 * 30, 3600, 60 * 60 * 24 * 365)
    },
    ranking: {
      torrentIntelligenceEnabled: normalizeBool(readRawEnv('TORRENT_INTELLIGENCE_RANKING', '1'), true),
      torrentIntelligenceWeight: normalizeFloat(readRawEnv('TORRENT_INTELLIGENCE_WEIGHT'), 1, 0, 5),
      explain: normalizeBool(readRawEnv('RANKING_EXPLAIN', '1'), true)
    },
    savedCloud: {
      aggressive: savedCloudAggressive,
      scanLimit: savedCloudScanLimit,
      snapshotEnabled: normalizeBool(readRawEnv('SAVED_CLOUD_SNAPSHOT_ENABLED', '1'), true),
      snapshotTtlSec: normalizeInt(readRawEnv('SAVED_CLOUD_SNAPSHOT_TTL_SEC'), savedCloudAggressive ? 6 * 60 * 60 : 90 * 60, 60, 60 * 60 * 24 * 7),
      snapshotWarmMax: normalizeInt(readRawEnv('SAVED_CLOUD_SNAPSHOT_WARM_MAX'), savedCloudAggressive ? 250 : 90, 20, 1000),
      liveFallback: normalizeBool(readRawEnv('SAVED_CLOUD_LIVE_FALLBACK', '1'), true)
    },
    externalSources: {
      torrentio: buildEnvSource('torrentio', { mode: 'live' }),
      mediafusion: buildEnvSource('mediafusion', { mode: 'both' }),
      comet: buildEnvSource('comet', { mode: 'background' }),
      zilean: buildEnvSource('zilean', { mode: 'background' }),
      stremthru: buildEnvSource('stremthru', { mode: 'false' })
    }
  };
}

let cachedSettings = null;

function getCachedAppSettings() {
  if (!cachedSettings) cachedSettings = getAppSettings();
  return cachedSettings;
}

function resetAppSettingsCache() {
  cachedSettings = null;
}

module.exports = {
  SOURCE_MODES,
  buildEnvSource,
  getAppSettings,
  getCachedAppSettings,
  normalizeBool,
  normalizeFloat,
  normalizeInt,
  normalizeList,
  normalizeOptionalString,
  normalizeSourceMode,
  readRawEnv,
  resetAppSettingsCache
};
