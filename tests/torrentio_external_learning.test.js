'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExternalAddonRequestIds,
  normalizeExternalCandidateForPipeline,
  getExternalSourceLabel,
  protectTorrentioExactMovieMinimum
} = require('../core/stream_generator');

test('buildExternalAddonRequestIds fans out imdb, requested id, and tmdb for Torrentio fallback', () => {
  assert.deepEqual(
    buildExternalAddonRequestIds('movie', 'tmdb:123', { imdb_id: 'tt1234567', tmdb_id: 123 }),
    ['tt1234567', 'tmdb:123']
  );

  assert.deepEqual(
    buildExternalAddonRequestIds('series', 'tmdb:999', { imdb_id: 'tt7654321', tmdb_id: 999, season: 2, episode: 4, isSeries: true }),
    ['tt7654321:2:4', 'tmdb:999:2:4']
  );
});

test('normalizeExternalCandidateForPipeline stores Torrentio items with clean provider-only source', () => {
  const normalized = normalizeExternalCandidateForPipeline({
    title: 'Film 2026 1080p ITA',
    infoHash: '0123456789abcdef0123456789abcdef01234567',
    seeders: 42,
    mainFileSize: 1024,
    externalGroup: 'torrentio',
    externalAddon: 'torrentio_main',
    externalProvider: 'ThePirateBay',
    languageInfo: { isItalian: true, hasAudioItalian: true, confidence: 100 }
  }, { type: 'movie', meta: { title: 'Film' }, langMode: 'ita' });

  assert.equal(getExternalSourceLabel({ externalGroup: 'torrentio', externalAddon: 'torrentio_main', externalProvider: 'ThePirateBay' }), 'ThePirateBay');
  assert.equal(normalized.source, 'ThePirateBay');
  assert.equal(normalized.hash, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(normalized.seeders, 42);
});


test('normalizeExternalCandidateForPipeline marks exact-id external candidates as trusted for movie alias filtering', () => {
  const normalized = normalizeExternalCandidateForPipeline({
    title: 'Ready or Not 2 Here I Come 2026 1080p WEB-DL ITA ENG',
    infoHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    seeders: 19,
    mainFileSize: 2_200_000_000,
    externalGroup: 'torrentio',
    externalAddon: 'torrentio_mirror',
    externalProvider: '1337x',
    _externalRequestId: 'tt33978029',
    _externalIdMatched: true,
    languageInfo: { isItalian: true, hasAudioItalian: true, confidence: 100 }
  }, {
    type: 'movie',
    meta: { title: 'Finché morte non ci separi 2', originalTitle: 'Ready or Not 2: Here I Come', year: 2026 },
    langMode: 'ita'
  });

  assert.equal(normalized._externalIdMatched, true);
  assert.equal(normalized._externalRequestId, 'tt33978029');
  assert.equal(normalized.source, '1337x');
});


test('protectTorrentioExactMovieMinimum keeps at least two safe exact-id Torrentio movie candidates', () => {
  const meta = { title: 'Ti uccideranno', originalTitle: 'They Will Kill You', year: 2026 };
  const mk = (title, hash, seeders) => normalizeExternalCandidateForPipeline({
    title,
    infoHash: hash,
    seeders,
    mainFileSize: 1_900_000_000,
    externalGroup: 'torrentio',
    externalAddon: 'torrentio_mirror',
    externalProvider: '1337x',
    _externalRequestId: 'tt31728330',
    _externalIdMatched: true,
    languageInfo: { isItalian: true, hasAudioItalian: true, confidence: 100 }
  }, { type: 'movie', meta, langMode: 'ita' });

  const candidates = [
    mk('Ti Uccideranno 2026 4K WEB H265 HDR ITA ENG', '1111111111111111111111111111111111111111', 9),
    mk('They Will Kill You 2026 1080p WEB x265 ITA ENG', '2222222222222222222222222222222222222222', 258),
    mk('They Will Kill You 2026 1080p WEB x264 ITA ENG', '3333333333333333333333333333333333333333', 35)
  ];

  const aggressiveOnlyFirst = (item) => String(item.title || '').startsWith('Ti Uccideranno');
  const guarded = protectTorrentioExactMovieMinimum(candidates, aggressiveOnlyFirst, {
    meta,
    type: 'movie',
    langMode: 'ita',
    config: { filters: { torrentioExactMovieMin: 2 } }
  });

  assert.equal(guarded.length, 2);
  assert.ok(guarded.some((item) => String(item.title).startsWith('They Will Kill You')));
});
