'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getLanguageInfo,
  parseTitleDetails,
  formatLanguageLabel,
  isItalianByTitleMatch
} = require('../core/utils/text');
const {
  analyzeItalianSignals,
  filterNormalizedExternalStreams
} = require('../core/nexus-bridge/shared');

const POLISH_MULTI = '90 minut do wolnosci - Mercy (2026) MULTi.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H265-K83 / Lektor i Napisy PL';
const ENGLISH_REMUX = 'Mercy.2026.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.Atmos.7.1-FGT';
const TRUE_ITA = 'Mercy (2026) AC3 5.1 ITA.ENG 1080p H265 sub ita.eng Sp33dy94-MIRCrew';
const ITA_LOCALIZED = 'Mercy - Sotto Accusa (2026) 2160P WEBDL H265 iTA-ENG AC3 5.1 Sub iTA - CoSmo Crew';

function infoFor(title, metaTitle, originalTitle) {
  return getLanguageInfo(title, metaTitle, 'BestTorrents', parseTitleDetails(title), originalTitle);
}

test('a metadata title shared with the original never marks foreign releases as Italian', () => {
  const polish = infoFor(POLISH_MULTI, 'Mercy', 'Mercy');
  assert.equal(polish.isItalian, false);
  assert.equal(polish.isMaybeItalian, false);
  assert.equal(formatLanguageLabel(polish), '🌍 MULTI');

  const remux = infoFor(ENGLISH_REMUX, 'Mercy', 'Mercy');
  assert.equal(remux.isItalian, false);
  assert.equal(remux.isMaybeItalian, false);
});

test('declared foreign languages veto weak Italian signals', () => {
  const polish = infoFor(POLISH_MULTI, 'Mercy', null);
  assert.equal(polish.isItalian, false);

  const french = infoFor('Mercy.2026.FRENCH.1080p.WEB-DL.x264', 'Mercy', 'Mercy');
  assert.equal(french.isItalian, false);
});

test('explicit Italian markers still win over the foreign veto', () => {
  const ita = infoFor(TRUE_ITA, 'Mercy', 'Mercy');
  assert.equal(ita.isItalian, true);
  assert.ok(ita.confidence >= 9);

  const localized = infoFor(ITA_LOCALIZED, 'Mercy - Sotto accusa', 'Mercy');
  assert.equal(localized.isItalian, true);
});

test('isItalianByTitleMatch requires distinctive localized words', () => {
  assert.equal(isItalianByTitleMatch(ENGLISH_REMUX, 'Mercy', 'Mercy'), false);
  assert.equal(isItalianByTitleMatch(ENGLISH_REMUX, 'Mercy'), false);
  assert.equal(isItalianByTitleMatch(ITA_LOCALIZED, 'Mercy - Sotto accusa', 'Mercy'), true);
  assert.equal(isItalianByTitleMatch('Oceania (2016) 1080p WEB-DL DD5.1', 'Oceania', 'Moana'), true);
  assert.equal(isItalianByTitleMatch('Moana.2016.1080p.BluRay.x264-SPARKS', 'Oceania', 'Moana'), false);
});

test('REMUX releases no longer match the Italian brand list', () => {
  const remux = analyzeItalianSignals({ title: `${ENGLISH_REMUX}\n👤 35 💾 52.42 GB ⚙️ ThePirateBay` });
  assert.equal(remux.isItalian, false);
  assert.equal(remux.confidence, 0);

  const dlmux = analyzeItalianSignals({ title: 'Mercy.2026.iTA.AC3.WEBDL.1080p.DLMux.x264-Papeete' });
  assert.equal(dlmux.isItalian, true);
});

test('polish release tags count as negative language evidence', () => {
  const polish = analyzeItalianSignals({ title: `${POLISH_MULTI}\n👤 5 💾 17.98 GB ⚙️ BestTorrents` });
  assert.equal(polish.isItalian, false);
  assert.equal(polish.hasNegativeLanguage, true);
});

test('onlyItalian external filter drops foreign and undeclared releases but keeps real ITA', () => {
  const mk = (title) => ({ title, name: 'Torrentio\n4k WEB-DL' });
  const streams = [
    mk(`${POLISH_MULTI}\n👤 5 💾 17.98 GB ⚙️ BestTorrents`),
    mk(`${ENGLISH_REMUX}\n👤 35 💾 52.42 GB ⚙️ ThePirateBay`),
    mk(`${TRUE_ITA}\n👤 29 💾 2.39 GB ⚙️ ilCorSaRoNeRo`)
  ];
  for (const addonKey of ['torrentio_mirror', 'mediafusion']) {
    const kept = filterNormalizedExternalStreams(streams, addonKey, { onlyItalian: true });
    assert.equal(kept.length, 1, addonKey);
    assert.ok(kept[0].title.includes('ITA.ENG'), addonKey);
  }
});
