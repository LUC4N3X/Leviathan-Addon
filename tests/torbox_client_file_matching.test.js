const assert = require('node:assert/strict');
const test = require('node:test');

const TB = require('../core/debrid/clients/torbox_client');

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
  assert.equal(result.reason, 'episode_file_match');
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
