'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/golden_cases.json');
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
  return keepItalianCandidate(title, sourceName, metaTitle) || keepEnglishCandidate(title, sourceName, metaTitle) || !/\bsub\b/i.test(String(title || ''));
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

function scoreSeriesCandidate(item, meta) {
  const title = String(item?.title || '');
  const parsed = extractSeasonEpisodeFromFilename(title, meta.season || 1);
  const exactEpisode = Boolean(parsed && parsed.episode === meta.episode && parsed.season === meta.season);
  const pack = isSeasonPack(title);
  const italian = keepItalianCandidate(title, item.source, meta.title);
  const seeders = parseInt(item?.seeders, 10) || 0;
  return (exactEpisode ? 1000 : 0) + (italian ? 250 : 0) + (pack ? 100 : 0) + seeders;
}

test('golden pool excludes live action on anime ITA-only search', () => {
  const fixture = fixtures.goldenPools[0];
  const filter = languageTools.createAggressiveResultFilter(fixture.meta, 'anime', 'ita');
  const filtered = fixture.items.filter((item) => filter({ ...item }));
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some((item) => /season pack/i.test(item.title)));
  assert.ok(!filtered.some((item) => /2023/i.test(item.title)));
});

test('golden ranking prefers exact episode over season pack in ita mode', () => {
  const fixture = fixtures.goldenPools[0];
  const filter = languageTools.createAggressiveResultFilter(fixture.meta, 'anime', 'ita');
  const filtered = fixture.items.filter((item) => filter({ ...item }));
  const ranked = filtered.slice().sort((a, b) => scoreSeriesCandidate(b, fixture.meta) - scoreSeriesCandidate(a, fixture.meta));
  assert.equal(ranked.length, 2);
  assert.match(ranked[0].title, /S01E01/i);
  assert.doesNotMatch(ranked[0].title, /season pack/i);
});
