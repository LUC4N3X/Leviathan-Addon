'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshotRow, tokenFingerprint } = require('../core/debrid/saved_cloud/saved_cloud_snapshot_repository');

test('saved cloud snapshot row captures RD torrent info and file payload', () => {
  const row = buildSnapshotRow({
    service: 'rd',
    apiKey: 'secret',
    torrent: { id: '123', hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', filename: 'Film 2024' },
    info: {
      id: '123',
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'downloaded',
      files: [{ id: 1, path: '/Film.2024.1080p.ITA.mkv', bytes: 1234 }]
    },
    ttlSeconds: 3600
  });

  assert.equal(row.service, 'rd');
  assert.equal(row.tokenFp, tokenFingerprint('secret'));
  assert.equal(row.fileCount, 1);
  assert.equal(row.hash, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(row.expiresAt instanceof Date);
});
