const KNOWN_PROVIDERS = [
  'ilCorSaRoNeRo', 'Corsaro', '1337x', '1337X', 'TorrentGalaxy', 'TGX', 'GalaxyRG',
  'RARBG', 'Rarbg', 'EZTV', 'Eztv', 'YTS', 'YIFY', 'MagnetDL', 'TorLock',
  'PirateBay', 'TPB', 'ThePirateBay', 'Nyaa', 'RuTracker', 'SolidTorrents'
];

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function normalizeBooleanEnv(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

function toSafeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function sanitizeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function normalizeInfoHash(infoHash) {
  if (!infoHash) return null;
  const normalized = String(infoHash).trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeUniqueInfoHashes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeInfoHash(value))
    .filter(Boolean))];
}

function normalizeImdbId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^tt\d+$/.test(normalized) ? normalized : null;
}

function normalizeFileIndex(value) {
  const parsed = toNullableInt(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function normalizeFileIndexNorm(value) {
  const parsed = normalizeFileIndex(value);
  return parsed === null ? -1 : parsed;
}

function normalizeRdCacheState(value) {
  const normalized = sanitizeText(value).toLowerCase();
  if (['cached', 'likely_cached', 'probing', 'likely_uncached', 'uncached_terminal', 'unknown'].includes(normalized)) {
    return normalized;
  }
  return null;
}

function deriveStoredCacheState(entry) {
  const explicitState = normalizeRdCacheState(entry?.state || entry?.rd_cache_state);
  if (explicitState) return explicitState;
  if (entry?.cached === true) return 'cached';
  if (entry?.cached === false) return 'uncached_terminal';
  return null;
}

function deriveCachedBooleanFromState(state, cachedValue) {
  if (typeof cachedValue === 'boolean') return cachedValue;
  if (state === 'cached') return true;
  if (state === 'uncached_terminal') return false;
  return null;
}

function extractOriginalProvider(text) {
  if (!text) return null;
  const content = String(text);
  const iconPatterns = [/🔍\s*([^\n]+)/, /🔗\s*([^\n]+)/, /🔎\s*([^\n]+)/];
  for (const pattern of iconPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  const lowerText = content.toLowerCase();
  for (const provider of KNOWN_PROVIDERS) {
    if (lowerText.includes(provider.toLowerCase())) return provider;
  }
  return null;
}

function normalizeUniqueTextList(values, limit = Infinity) {
  const unique = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = sanitizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
    if (unique.length >= limit) break;
  }

  return unique;
}

function toDateOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

module.exports = {
  clampInt,
  normalizeBooleanEnv,
  toNullableInt,
  toSafeNumber,
  sanitizeText,
  normalizeInfoHash,
  normalizeUniqueInfoHashes,
  normalizeImdbId,
  normalizeFileIndex,
  normalizeFileIndexNorm,
  normalizeRdCacheState,
  deriveStoredCacheState,
  deriveCachedBooleanFromState,
  extractOriginalProvider,
  normalizeUniqueTextList,
  toDateOrNull
};
