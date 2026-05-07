'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLanguageFilterTools } = require('../core/pipeline/language_filter');

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\[\]{}()]/g, ' ')
    .replace(/[._:+\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGoodShortQueryMatch(title, query) {
  const haystack = normalizeSearchText(title);
  const needle = normalizeSearchText(query);
  if (!needle) return false;
  if (needle.length <= 3) return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(haystack);
  return haystack.includes(needle);
}

function parseEpisode(title, defaultSeason = 1) {
  const sxe = String(title || '').match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (!sxe) return null;
  return {
    season: parseInt(sxe[1], 10) || defaultSeason,
    episode: parseInt(sxe[2], 10) || 0
  };
}

function createTools(overrides = {}) {
  return createLanguageFilterTools({
    REGEX_YEAR: /(19|20)\d{2}/,
    normalizeSearchText,
    isGoodShortQueryMatch,
    isSeasonPack: (title = '') => /\b(?:pack|complete|season)\b/i.test(String(title || '')),
    extractSeasonEpisodeFromFilename: parseEpisode,
    smartMatch: (metaTitle, itemTitle) => normalizeSearchText(itemTitle).includes(normalizeSearchText(metaTitle)),
    ...overrides
  });
}

test('language filter works with minimal fallback dependencies for movie web streams', () => {
  const tools = createTools();
  const filter = tools.createAggressiveResultFilter({ title: 'Dune', year: 2021, isSeries: false }, 'movie', 'ita');

  assert.equal(filter({ title: 'Dune 2021 1080p WEB-DL', directUrl: 'https://cdn.example/video.m3u8', source: 'web' }), true);
  assert.equal(filter({ title: 'Dune 1984 1080p WEB-DL', directUrl: 'https://cdn.example/video.m3u8', source: 'web' }), false);
});

test('language filter delegates mode decisions to injected runtime language guard', () => {
  const calls = [];
  const tools = createTools({
    keepLanguageCandidateForMode: (item, meta, langMode) => {
      calls.push({ title: item.title, metaTitle: meta.title, langMode });
      return false;
    }
  });
  const filter = tools.createAggressiveResultFilter({ title: 'Dune', year: 2021, isSeries: false }, 'movie', 'ita');

  assert.equal(filter({ title: 'Dune 2021 1080p WEB-DL', magnet: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', source: 'torrent' }), false);
  assert.deepEqual(calls, [{ title: 'Dune 2021 1080p WEB-DL', metaTitle: 'Dune', langMode: 'ita' }]);
});

test('language filter accepts exact series episodes without optional anime helpers', () => {
  const tools = createTools();
  const filter = tools.createAggressiveResultFilter({ title: 'The Show', isSeries: true, season: 1, episode: 2 }, 'series', 'all');

  assert.equal(filter({ title: 'The Show S01E02 1080p WEB-DL', magnet: 'magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd', source: 'torrent' }), true);
  assert.equal(filter({ title: 'The Show S01E03 1080p WEB-DL', magnet: 'magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd', source: 'torrent' }), false);
});
