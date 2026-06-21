'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTracks, buildTrackProbeKey } = require('../core/intelligence/track_intelligence');
const { extractStreamInfo, formatStreamSelector } = require('../core/lib/stream_formatter');

test('normalizes probed video audio and subtitle tracks', () => {
  const hints = normalizeTracks([
    { id: 1, type: 'video', lang: null, label: 'UHD', codec: 'MPEGH/ISO/HEVC' },
    { id: 2, type: 'audio', lang: 'ita', label: 'Italian EAC3 Atmos 768 Kbps 5.1', codec: 'EAC3' },
    { id: 3, type: 'audio', lang: 'eng', label: 'English AAC 2.0', codec: 'AAC' },
    { id: 4, type: 'text', lang: 'ita', label: 'Italian SRT', codec: 'TEXT/UTF8' }
  ]);

  assert.equal(hints.videoCodec, 'HEVC');
  assert.equal(hints.audioCodec, 'ATMOS DDP');
  assert.equal(hints.audioChannels, '5.1');
  assert.deepEqual(hints.audioLanguages, ['ita', 'eng']);
  assert.deepEqual(hints.subtitleLanguages, ['ita']);
  assert.equal(hints.hasItalianAudio, true);
  assert.equal(hints.hasItalianSubtitles, true);
  assert.match(hints.languageFlags, /🇮🇹/);
});

test('track probe key avoids volatile query tokens when hash is available', () => {
  const a = buildTrackProbeKey({ service: 'rd', infoHash: '0123456789abcdef0123456789abcdef01234567', fileIdx: 2, fileSize: 100, url: 'https://host/file.mkv?token=a' });
  const b = buildTrackProbeKey({ service: 'rd', infoHash: '0123456789abcdef0123456789abcdef01234567', fileIdx: 2, fileSize: 100, url: 'https://host/file.mkv?token=b' });
  assert.equal(a, b);
  assert.equal(a, 'track:v1:rd:0123456789abcdef0123456789abcdef01234567:2:100');
});

test('formatter keeps current shape but lets probe hints override guessed language and audio', () => {
  const trackHints = normalizeTracks([
    { id: 1, type: 'video', codec: 'V_MPEGH/ISO/HEVC', label: 'Main' },
    { id: 2, type: 'audio', lang: 'ita', codec: 'EAC3', label: 'Italian EAC3 5.1' },
    { id: 3, type: 'text', lang: 'ita', codec: 'TEXT/UTF8', label: 'Italian SRT' }
  ]);

  const info = extractStreamInfo('Example.Movie.2024.1080p.WEB-DL.x264-GRP', 'Torrentio', { trackHints });
  assert.equal(info.codec, 'HEVC');
  assert.equal(info.audioTag, 'Dolby DDP');
  assert.equal(info.audioChannels, '5.1');
  assert.match(info.lang, /🇮🇹/);

  const stream = formatStreamSelector('Example.Movie.2024.1080p.WEB-DL.x264-GRP', 'Torrentio', 1024 ** 3, 10, 'RD', { formatter: 'custom', customTemplate: '{codec} {audio} {lang}', trackHints }, null, false, false, 'cached');
  assert.match(stream.title, /HEVC/);
  assert.match(stream.title, /Dolby DDP/);
  assert.match(stream.title, /🇮🇹/);
});
