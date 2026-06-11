'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractReleaseSignals } = require('../core/lib/release_signal_engine');
const {
  detectLanguageBucket,
  detectPack,
  evaluateTorrentIntelligence
} = require('../core/ranking/torrent_intelligence');

test('extractReleaseSignals detects explicit ITA tags and positional language tokens', () => {
  assert.ok(extractReleaseSignals('Dune.Part.Two.2024.1080p.WEB-DL.ITA.ENG.x265').languages.includes('italian'));

  const positional = extractReleaseSignals('The.Movie.2023.1080p.WEBRip.IT.EN.ES.x264');
  assert.ok(positional.languages.includes('italian'));
  assert.ok(positional.languages.includes('english'));
  assert.ok(positional.languages.includes('spanish'));
});

test('extractReleaseSignals never mistakes leading title words for languages', () => {
  const italianJob = extractReleaseSignals('The.Italian.Job.2003.1080p.BluRay.x264');
  assert.ok(!italianJob.languages.includes('italian'));

  const spanishAffair = extractReleaseSignals('Spanish.Affair.2014.720p.WEBRip.x264');
  assert.ok(!spanishAffair.languages.includes('spanish'));
});

test('extractReleaseSignals separates multi subs from multi audio', () => {
  const subs = extractReleaseSignals('Movie.2022.1080p.WEB-DL.MULTi-SUBS.x264');
  assert.ok(subs.languages.includes('multi subs'));
  assert.ok(!subs.languages.includes('multi audio'));
  assert.equal(subs.dubbed, false);

  const audio = extractReleaseSignals('Movie.2022.1080p.WEB-DL.MULTi.AUDiO.x264');
  assert.ok(audio.languages.includes('multi audio'));
  assert.equal(audio.dubbed, true);
});

test('extractReleaseSignals flags dual audio and dubbed releases', () => {
  const dual = extractReleaseSignals('Show.S01E03.Dual.Audio.1080p.WEBRip');
  assert.ok(dual.languages.includes('dual audio'));
  assert.equal(dual.dubbed, true);

  assert.equal(extractReleaseSignals('Filme.2021.1080p.WEB-DL.DUBLADO').dubbed, true);
});

test('extractReleaseSignals infers portuguese from dub markers', () => {
  assert.ok(extractReleaseSignals('Filme.2021.1080p.WEB-DL.Dublado.x264').languages.includes('portuguese'));
});

test('extractReleaseSignals reads HDR profiles, bit depth and 3D variants', () => {
  const hdr = extractReleaseSignals('Movie.2023.2160p.WEB-DL.DV.HDR10+.10bit.x265');
  assert.ok(hdr.hdr.includes('DV'));
  assert.ok(hdr.hdr.includes('HDR10+'));
  assert.equal(hdr.bitDepth, '10bit');

  assert.equal(extractReleaseSignals('Movie.2010.1080p.BluRay.3D.Half-SBS.x264').threeD, '3D HSBS');
  assert.equal(extractReleaseSignals('Movie.2010.1080p.BluRay.x264').threeD, null);
});

test('extractReleaseSignals tells anthologies apart from loose collection wording', () => {
  const trilogy = extractReleaseSignals('The.Lord.of.the.Rings.Trilogy.2001-2003.1080p.BluRay');
  assert.equal(trilogy.complete, true);
  assert.equal(trilogy.anthology, true);

  const allSeasons = extractReleaseSignals('The.Wire.All.Seasons.1080p.WEB-DL');
  assert.equal(allSeasons.anthology, true);

  const criterion = extractReleaseSignals('Seven.Samurai.1954.Criterion.Collection.1080p.BluRay');
  assert.equal(criterion.complete, true);
  assert.equal(criterion.anthology, false);
});

test('bound parser handlers enrich ptt.parse without touching the parsed title', () => {
  const ptt = require('parse-torrent-title');
  const parsed = ptt.parse('La.Casa.2023.1080p.WEB-DL.ITA.ENG.AC3.x264');
  assert.ok(Array.isArray(parsed.languages));
  assert.ok(parsed.languages.includes('italian'));
  assert.ok(parsed.languages.includes('english'));
  assert.equal(parsed.title, 'La Casa');
});

test('detectLanguageBucket leverages parsed languages for positional tokens', () => {
  const parsed = extractReleaseSignals('Movie.2023.1080p.IT.EN.ES.WEB-DL');
  assert.equal(detectLanguageBucket('Movie 2023 1080p IT EN ES WEB-DL', {}, parsed), 'multi_ita');

  assert.equal(detectLanguageBucket('Movie 2023 1080p ITA AC3 WEB-DL', {}, null), 'ita');
  assert.equal(detectLanguageBucket('Movie 2023 1080p SUB ITA WEB-DL', {}, null), 'sub_only');
});

test('detectPack classifies anthologies and box sets as multi-title packs', () => {
  const trilogy = extractReleaseSignals('The.Matrix.Trilogy.1999-2003.1080p.BluRay');
  assert.equal(detectPack('The Matrix Trilogy 1999-2003 1080p BluRay', {}, trilogy), 'multiSeason');

  const seasonPack = extractReleaseSignals('Show.S01.Complete.Pack.1080p');
  assert.equal(detectPack('Show S01 Complete Pack 1080p', {}, seasonPack), 'season');

  assert.equal(detectPack('Movie 2023 1080p BluRay', {}, extractReleaseSignals('Movie.2023.1080p.BluRay')), 'single');
});

test('evaluateTorrentIntelligence surfaces the release signal features', () => {
  const result = evaluateTorrentIntelligence(
    { title: 'Dune.Part.Two.2024.2160p.WEB-DL.ITA.ENG.DV.HDR10+.10bit.x265' },
    { isSeries: false }
  );
  assert.equal(result.features.language, 'multi_ita');
  assert.ok(result.features.languages.includes('italian'));
  assert.equal(result.features.bitDepth, '10bit');
  assert.equal(result.features.resolution, '2160p');
});

test('anime tracker profile covers the dedicated anime announcers', () => {
  const { PROFILE_TRACKERS } = require('../core/lib/tracker_enricher');
  for (const tracker of [
    'http://tracker.anirena.com:80/announce',
    'http://share.camoe.cn:8080/announce',
    'http://t.nyaatracker.com:80/announce'
  ]) {
    assert.ok(PROFILE_TRACKERS.anime.includes(tracker), `missing ${tracker}`);
  }
});
