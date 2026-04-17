'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const fixtures = require('../tests/fixtures/golden_cases.json');
const { tokenizeTitle, hasExplicitSeasonMarker } = require('../core/canonical/title_parser');
const { resolveLangMode } = require('../core/canonical/language_rules');
const { validateConfig } = require('../core/config/schema');
const { createLanguageFilterTools } = require('../core/pipeline/language_filter');
const { isAnimeMetaContext, shouldIgnoreAnimeSeason, getEpisodeParseOptions } = require('../core/canonical/anime_rules');

const REGEX_SUB_ONLY = /\b(?:SUB|SUBS|SUBBED|SOTTOTITOLI|VOST|VOSTIT)\b/i;
const REGEX_AUDIO_CONFIRM = /\b(?:AUDIO|AC3|AAC|DTS|DDP|MP3|LINGUA)[\s._-]+(?:ITA|IT)\b/i;
const REGEX_YEAR = /(19|20)\d{2}/;

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\[\]{}()]/g, ' ')
    .replace(/[._:+\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSeasonPack(title = '') {
  return /\b(?:pack|complete|completa|full ?season|season ?pack|stagione ?(?:completa|complete)?|serie completa|collection|integrale)\b/i.test(String(title || ''));
}

function isGoodShortQueryMatch(title, query) {
  const haystack = normalizeSearchText(title);
  const needle = normalizeSearchText(query);
  if (!needle) return false;
  if (needle.length <= 3) return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);
  return haystack.includes(needle);
}

function smartMatch(metaTitle, itemTitle) {
  return normalizeSearchText(itemTitle).includes(normalizeSearchText(metaTitle));
}

function hasStrongSeriesTitleMatch(title, meta) {
  return normalizeSearchText(title).includes(normalizeSearchText(meta.title || ''));
}

function extractSeasonEpisodeFromFilename(title, defaultSeason = 1) {
  const text = String(title || '');
  const sxe = text.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (sxe) return { season: parseInt(sxe[1], 10), episode: parseInt(sxe[2], 10) };
  const xFormat = text.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (xFormat) return { season: parseInt(xFormat[1], 10), episode: parseInt(xFormat[2], 10) };
  const animeEp = text.match(/(?:^|\D)(\d{3,4})(?:\D|$)/);
  if (animeEp) return { season: defaultSeason, episode: parseInt(animeEp[1], 10) };
  return null;
}

function getLanguageInfo(title = '') {
  const text = String(title || '');
  const isItalian = /\b(?:ITA|ITALIAN|ITALIANO|TRUE\s*ITA|AUDIO\s*ITA)\b/i.test(text) || REGEX_AUDIO_CONFIRM.test(text);
  const isEnglish = /\b(?:ENG|ENGLISH|TRUE\s*ENGLISH|AUDIO\s*ENG)\b/i.test(text);
  return {
    isItalian,
    isMaybeItalian: isItalian,
    isEnglish,
    confidence: isItalian ? 5 : isEnglish ? 4 : 1
  };
}

function getSignals(title, metaTitle) {
  const langInfo = getLanguageInfo(title);
  const rawTitle = String(title || '');
  return {
    langInfo,
    explicitIta: /\b(?:ITA|ITALIAN|ITALIANO|TRUE\s*ITA|AUDIO\s*ITA)\b/i.test(rawTitle),
    explicitEng: /\b(?:ENG|ENGLISH|TRUE\s*ENGLISH|AUDIO\s*ENG)\b/i.test(rawTitle),
    explicitOther: /\b(?:FRENCH|GERMAN|SPANISH|ESP|LATINO|JPN|JAP)\b/i.test(rawTitle),
    explicitMulti: /\b(?:MULTI|MULTILANG(?:UAGE)?|DUAL[\s.-]?AUDIO)\b/i.test(rawTitle),
    neutralScene: !metaTitle || normalizeSearchText(rawTitle).includes(normalizeSearchText(metaTitle || ''))
  };
}

function keepItalianCandidate(title, sourceName, metaTitle) {
  const signals = getSignals(title, metaTitle, sourceName);
  return Boolean(signals.langInfo.isItalian || (signals.langInfo.confidence || 0) >= 4 || signals.langInfo.isMaybeItalian);
}

function keepEnglishCandidate(title, sourceName, metaTitle) {
  const signals = getSignals(title, metaTitle, sourceName);
  if (signals.explicitEng) return true;
  if (signals.explicitOther && !signals.explicitEng) return false;
  if (signals.explicitIta && !signals.explicitEng) return false;
  if (signals.explicitMulti && !signals.explicitEng) return false;
  return signals.neutralScene;
}

function keepAllCandidate(title, sourceName, metaTitle) {
  return keepItalianCandidate(title, sourceName, metaTitle)
    || keepEnglishCandidate(title, sourceName, metaTitle)
    || !/\bsub\b/i.test(String(title || ''));
}

const languageTools = createLanguageFilterTools({
  isAnimeMetaContext,
  shouldIgnoreAnimeSeason,
  getEpisodeParseOptions,
  REGEX_SUB_ONLY,
  REGEX_AUDIO_CONFIRM,
  REGEX_YEAR,
  isSeasonPack,
  normalizeSearchText,
  isGoodShortQueryMatch,
  extractSeasonEpisodeFromFilename,
  smartMatch,
  keepItalianCandidate,
  keepEnglishCandidate,
  keepAllCandidate,
  hasStrongSeriesTitleMatch
});

function measure(name, iterations, fn) {
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) fn(index);
  const totalMs = performance.now() - startedAt;
  return {
    name,
    iterations,
    totalMs: Number(totalMs.toFixed(3)),
    avgUs: Number(((totalMs * 1000) / iterations).toFixed(3))
  };
}

const samplePool = fixtures.goldenPools[0];
const aggressiveFilter = languageTools.createAggressiveResultFilter(samplePool.meta, 'anime', 'ita');

const results = [
  measure('tokenizeTitle', 20000, (index) => {
    const fixture = fixtures.titles[index % fixtures.titles.length];
    tokenizeTitle(fixture.input, { keepNumbers: true });
  }),
  measure('hasExplicitSeasonMarker', 20000, (index) => {
    const fixture = fixtures.seasons[index % fixtures.seasons.length];
    hasExplicitSeasonMarker(fixture.title);
  }),
  measure('resolveLangMode', 20000, (index) => {
    const fixture = fixtures.languageModes[index % fixtures.languageModes.length];
    resolveLangMode(fixture.input);
  }),
  measure('validateConfig', 10000, () => {
    validateConfig({ filters: { enableVix: true, vixLast: true, language: 'ITA', providers: 'torrentio,comet' } });
  }),
  measure('aggressiveAnimeFilter', 5000, (index) => {
    aggressiveFilter({ ...samplePool.items[index % samplePool.items.length] });
  })
];

const payload = {
  generatedAt: new Date().toISOString(),
  nodeVersion: process.version,
  benchmarks: results
};

const outputPath = path.join(process.cwd(), 'benchmark-results.json');
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`[bench] wrote ${outputPath}`);
for (const entry of results) {
  console.log(`[bench] ${entry.name}: ${entry.iterations} iterations | ${entry.totalMs}ms total | ${entry.avgUs}us avg`);
}
