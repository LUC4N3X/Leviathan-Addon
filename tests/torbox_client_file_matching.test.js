const assert = require('node:assert/strict');
const test = require('node:test');

const TB = require('../core/debrid/tb/clients/torbox_client');

const {
  matchFileDetailed,
  stableKeyFingerprint,
  redactSecretsInText
} = TB.__private;

const GB = 1024 * 1024 * 1024;

test('TorBox file matcher selects the requested episode from a season pack', () => {
  const result = matchFileDetailed([
    { id: 1, name: 'Show.S01E01.1080p.mkv', size: 2 * GB },
    { id: 2, name: 'Show.S01E02.1080p.mkv', size: 2 * GB },
    { id: 3, name: 'Show.S01E03.1080p.mkv', size: 2 * GB }
  ], 1, 2);

  assert.equal(result.fileId, 2);
  assert.equal(result.confidence >= 0.75, true);
  assert.equal(result.reason, 'file_match_confident');
});

test('TorBox file matcher rejects a single conflicting episode instead of guessing fileIdx', () => {
  const result = matchFileDetailed([
    { id: 3, name: 'Show.S01E03.1080p.mkv', size: 2 * GB }
  ], 1, 2);

  assert.equal(result.fileId, null);
  assert.equal(result.reason, 'no_confident_episode_file');
});

test('TorBox forced fileIdx is ignored when it explicitly conflicts with requested episode', () => {
  const result = matchFileDetailed([
    { id: 3, name: 'Show.S01E03.1080p.mkv', size: 2 * GB }
  ], 1, 2, 3);

  assert.equal(result.fileId, null);
});

test('TorBox token fingerprint and request text redaction do not leak the raw token', () => {
  const token = 'tb_super_secret_token_1234567890';
  const fingerprint = stableKeyFingerprint(token);
  const redacted = redactSecretsInText(`Authorization: Bearer ${token} token=${token}`);

  assert.notEqual(fingerprint.includes(token.slice(0, 8)), true);
  assert.equal(/[a-f0-9]{10}/.test(fingerprint), true);
  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /token=<redacted>/);
});

const TorboxSdkAdapter = require('../core/debrid/tb/clients/torbox_sdk_adapter');

test('TorBox SDK adapter maps snake params to official SDK camel params', () => {
  const mapped = TorboxSdkAdapter.__private.paramsToSdk({
    bypass_cache: true,
    list_files: 'true',
    torrent_id: 123,
    file_id: 9,
    zip_link: false,
    user_ip: '127.0.0.1',
    redirect: 'false'
  });

  assert.deepEqual(mapped, {
    bypassCache: 'true',
    listFiles: 'true',
    torrentId: '123',
    fileId: '9',
    zipLink: 'false',
    userIp: '127.0.0.1',
    redirect: 'false'
  });
});

test('TorBox SDK adapter preserves legacy snake aliases on SDK camel responses', () => {
  const normalized = TorboxSdkAdapter.__private.normalizePayloadShape({
    success: true,
    data: [{
      id: 7,
      hash: 'abcdef',
      downloadState: 'completed',
      createdAt: '2026-01-01T00:00:00Z',
      files: [{ id: 3, shortName: 'Movie.mkv', s3Path: 'x/y/Movie.mkv', size: 104857600 }]
    }]
  });

  assert.equal(normalized.data[0].download_state, 'completed');
  assert.equal(normalized.data[0].created_at, '2026-01-01T00:00:00Z');
  assert.equal(normalized.data[0].files[0].short_name, 'Movie.mkv');
  assert.equal(normalized.data[0].files[0].s3_path, 'x/y/Movie.mkv');
});

test('TorBox SDK adapter redacts tokens from fallback errors and URLs', () => {
  const token = 'tb_super_secret_token_1234567890';
  const redacted = TorboxSdkAdapter.__private.redact(`Bearer ${token} https://api.torbox.app/v1/api/torrents/requestdl?token=${token}`);
  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /token=<redacted>/);
});
