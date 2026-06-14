'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasStrictItalianEvidence,
  shouldKeepStrictItalianCandidate
} = require('../core/canonical/language_guard');
const { rankAndFilterResults } = require('../core/lib/result_ranker');

const meta = { title: 'Apex', originalTitle: 'Apex', year: 2026 };

test('solo ITA rejects global/unknown scene releases even when title matches metadata', () => {
  assert.equal(shouldKeepStrictItalianCandidate('Apex 2026 1080p WEB x264 AAC', 'ThePirateBay'), false);
  assert.equal(hasStrictItalianEvidence('Apex 2026 1080p WEB x264 AAC', 'ThePirateBay'), false);
});

test('solo ITA rejects explicit ENG-only releases', () => {
  assert.equal(shouldKeepStrictItalianCandidate('Apex 2026 1080p WEB x264 ENG AAC', 'ThePirateBay'), false);
});

test('solo ITA keeps explicit ITA and ITA+ENG releases', () => {
  assert.equal(shouldKeepStrictItalianCandidate('Apex 2026 1080p WEB x264 ITA AAC', '1337x'), true);
  assert.equal(shouldKeepStrictItalianCandidate('Apex 2026 1080p WEB x264 ITA ENG AAC', '1337x'), true);
});

test('solo ITA keeps trusted Italian release groups without treating generic metadata title as language proof', () => {
  assert.equal(shouldKeepStrictItalianCandidate('Apex 2026 1080p WEB x264 AAC MIRCrew', 'ThePirateBay'), true);
  assert.equal(shouldKeepStrictItalianCandidate('Apex 2026 1080p WEB x264 AAC', 'ilCorSaRoNeRo'), true);
});

test('rankAndFilterResults removes ENG and global results in ita mode', () => {
  const ranked = rankAndFilterResults([
    { title: 'Apex 2026 1080p WEB x264 AAC', source: 'ThePirateBay', seeders: 100 },
    { title: 'Apex 2026 1080p WEB x264 ENG AAC', source: 'ThePirateBay', seeders: 100 },
    { title: 'Apex 2026 1080p WEB x264 ITA AAC', source: 'ThePirateBay', seeders: 5 }
  ], meta, { filters: { language: 'ita' } });

  assert.deepEqual(ranked.map((item) => item.title), ['Apex 2026 1080p WEB x264 ITA AAC']);
});


test('solo ITA is extra strict for ThePirateBay and BestTorrents', () => {
  assert.equal(shouldKeepStrictItalianCandidate('Mercy 2026 2160p MULTi WEB-DL DDP5.1 Atmos H265 K83', 'BestTorrents'), false);
  assert.equal(shouldKeepStrictItalianCandidate('Mercy 2026 1080p WEB-DL SUB ITA ENG x264', 'ThePirateBay'), false);
  assert.equal(shouldKeepStrictItalianCandidate('Mercy 2026 1080p WEB-DL ITA ENG AC3 x264', 'ThePirateBay'), true);
});

test('ThePirateBay rejects Torrentio flag-only 28 Years Later releases without textual ITA audio', () => {
  assert.equal(shouldKeepStrictItalianCandidate('28 Years Later The Bone Temple 2025 2160p 4K WEB-DL DV AAC 🇮🇹', 'ThePirateBay'), false);
  assert.equal(shouldKeepStrictItalianCandidate('28 Years Later The Bone Temple 2025 2160p REMUX H265 DV HDR Atmos TrueHD7.1 🇮🇹', 'ThePirateBay'), false);
  assert.equal(hasStrictItalianEvidence('28 Years Later The Bone Temple 2025 2160p REMUX H265 DV HDR Atmos TrueHD7.1 🇮🇹', 'ThePirateBay'), false);
});

test('ThePirateBay still keeps real textual ITA audio markers', () => {
  assert.equal(shouldKeepStrictItalianCandidate('28 Years Later The Bone Temple 2025 2160p WEB-DL ITA ENG AAC', 'ThePirateBay'), true);
  assert.equal(shouldKeepStrictItalianCandidate('28 Years Later The Bone Temple 2025 2160p REMUX ITA AC3 Atmos TrueHD7.1', 'ThePirateBay'), true);
});
