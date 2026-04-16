const { isAnimeMeta } = require('./anime_rules');

const VALID_LANG_MODES = new Set(['ita', 'eng', 'all']);

function normalizeLangMode(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (VALID_LANG_MODES.has(normalized)) return normalized;
  return fallback;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function resolveLangMode(options = {}) {
  const meta = options?.meta || {};
  const filters = options?.filters || options?.config?.filters || {};
  const explicit = normalizeLangMode(options?.langMode)
    || normalizeLangMode(options?.languageMode)
    || normalizeLangMode(options?.language)
    || normalizeLangMode(filters?.language)
    || normalizeLangMode(meta?.langMode)
    || normalizeLangMode(meta?.languageMode)
    || normalizeLangMode(meta?.language);

  if (explicit) return explicit;

  const allowEng = firstBoolean(options?.allowEng, filters?.allowEng, options?.config?.allowEng);
  if (allowEng === true) return 'all';

  const animeDefault = normalizeLangMode(options?.animeDefault);
  if (animeDefault && isAnimeMeta(meta, options?.type)) return animeDefault;

  const profileName = String(options?.profileName || options?.config?.profile || '').toLowerCase();
  const dedupeDefaultsToAll = options?.dedupeDefaultAll === true || profileName === 'dedupe';
  if (dedupeDefaultsToAll) return 'all';

  return normalizeLangMode(options?.defaultMode, 'ita') || 'ita';
}

function resolveMetaOrOptionLangMode(meta = {}, allowEngOrLangMode = false, options = {}) {
  if (typeof allowEngOrLangMode === 'string') {
    return resolveLangMode({ ...options, meta, langMode: allowEngOrLangMode });
  }
  if (typeof allowEngOrLangMode === 'boolean') {
    return resolveLangMode({ ...options, meta, allowEng: allowEngOrLangMode });
  }
  if (allowEngOrLangMode && typeof allowEngOrLangMode === 'object') {
    return resolveLangMode({ ...allowEngOrLangMode, ...options, meta });
  }
  return resolveLangMode({ ...options, meta });
}

module.exports = {
  VALID_LANG_MODES,
  normalizeLangMode,
  resolveLangMode,
  resolveMetaOrOptionLangMode
};
