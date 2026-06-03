'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractEpisodeLinks,
  extractMovieLinks,
  isToonItaliaRuntimeEnabled,
  normalizeTitleForSearch,
  providerPriority,
  titleMatches
} = require('../providers/toonitalia/toonitalia_handler');

test('ToonItalia filter is opt-in through config filter', () => {
  assert.equal(isToonItaliaRuntimeEnabled({ filters: {} }), false);
  assert.equal(isToonItaliaRuntimeEnabled({ filters: { enableToonItalia: true } }), true);
});

test('ToonItalia title normalization keeps meaningful words', () => {
  assert.equal(normalizeTitleForSearch('Dragon Ball Super: Broly - Film Streaming ITA'), 'dragon ball super broly');
  assert.equal(titleMatches('Dragon Ball Super', 'Dragon Ball Super Episodi ITA'), true);
});

test('ToonItalia extracts movie links for supported hosters', () => {
  const html = `<p><a href="https://voe.sx/e/aaa">VOE</a></p><a href="https://loadm.cam/e/bbb">RPMShare</a>`;
  const links = extractMovieLinks(html);
  assert.deepEqual(links, ['https://voe.sx/e/aaa', 'https://loadm.cam/e/bbb']);
});

test('ToonItalia extracts only selected episode chunk', () => {
  const html = `
    <h3>1x01</h3><a href="https://voe.sx/e/ep1">VOE</a>
    <h3>1x02</h3><a href="https://voe.sx/e/ep2">VOE</a>
  `;
  assert.deepEqual(extractEpisodeLinks(html, 1, 1), ['https://voe.sx/e/ep1']);
});

test('ToonItalia provider priority prefers LoadM, MaxStream, then VOE', () => {
  assert.equal(providerPriority('https://loadm.cam/e/abc') < providerPriority('https://maxstream.video/emvvv/abc'), true);
  assert.equal(providerPriority('https://maxstream.video/emvvv/abc') < providerPriority('https://voe.sx/e/abc'), true);
});
