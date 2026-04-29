'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  parseMagnetInput,
  parseTorrentInput,
  inferPackMappings
} = require('../core/lib/manual_import_parser');

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(String(value.length) + ':'), value]);
  if (typeof value === 'string') {
    const buf = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(String(buf.length) + ':'), buf]);
  }
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return Buffer.concat([
      Buffer.from('d'),
      ...keys.flatMap((key) => [bencode(key), bencode(value[key])]),
      Buffer.from('e')
    ]);
  }
  throw new Error(`Unsupported bencode type: ${typeof value}`);
}

test('parseMagnetInput extracts info hash and display name', () => {
  const infoHash = '0123456789ABCDEF0123456789ABCDEF01234567';
  const parsed = parseMagnetInput(`magnet:?xt=urn:btih:${infoHash}&dn=Example.Release.1080p`);
  assert.equal(parsed.infoHash, infoHash);
  assert.equal(parsed.title, 'Example.Release.1080p');
});

test('parseTorrentInput decodes torrent metadata and file list', () => {
  const info = {
    name: 'Example Pack',
    files: [
      { length: 123456789, path: ['Season 01', 'Example.S01E01.mkv'] },
      { length: 223456789, path: ['Season 01', 'Example.S01E02.mkv'] }
    ],
    'piece length': 262144,
    pieces: Buffer.alloc(20)
  };
  const torrent = {
    announce: 'https://tracker.example/announce',
    info
  };
  const raw = bencode(torrent);
  const expectedHash = crypto.createHash('sha1').update(bencode(info)).digest('hex').toUpperCase();
  const parsed = parseTorrentInput(raw.toString('base64'));

  assert.equal(parsed.infoHash, expectedHash);
  assert.equal(parsed.title, 'Example Pack');
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0].file_index, 0);
  assert.equal(parsed.files[0].file_path, 'Season 01/Example.S01E01.mkv');
  assert.equal(parsed.totalSize, 346913578);
});

test('inferPackMappings maps series pack files to imdb episodes', () => {
  const files = [
    { file_index: 0, file_path: 'Season 01/Example.S01E01.mkv', file_title: 'Example.S01E01.mkv', file_size: 100 },
    { file_index: 1, file_path: 'Season 01/Example.S01E02.mkv', file_title: 'Example.S01E02.mkv', file_size: 120 }
  ];
  const mappings = inferPackMappings(files, { imdbId: 'tt1234567', type: 'series', season: 1, episode: 1 });
  assert.equal(mappings.length, 2);
  assert.deepEqual(mappings.map((entry) => [entry.imdb_season, entry.imdb_episode]), [[1, 1], [1, 2]]);
});
