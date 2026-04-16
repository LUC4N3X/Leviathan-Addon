'use strict';

function normalizeLanguageMode(value, fallback = 'ita') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'ita' || normalized === 'eng' || normalized === 'all' ? normalized : fallback;
}

function resolveLangMode(options = {}) {
  const explicit = normalizeLanguageMode(
    options.langMode || options.languageMode || options.language || options.filters?.language,
    ''
  );
  if (explicit) return explicit;
  if (typeof options.allowEng === 'boolean') return options.allowEng ? 'all' : (options.defaultMode || 'ita');
  if (typeof options.filters?.allowEng === 'boolean') return options.filters.allowEng ? 'all' : (options.defaultMode || 'ita');
  return options.defaultMode || 'ita';
}

function getAcceptLanguage(langMode = 'ita') {
  const resolved = normalizeLanguageMode(langMode);
  if (resolved === 'eng') return 'en-US,en;q=0.9';
  if (resolved === 'all') return 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
  return 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
}

module.exports = {
  normalizeLanguageMode,
  resolveLangMode,
  getAcceptLanguage
};
