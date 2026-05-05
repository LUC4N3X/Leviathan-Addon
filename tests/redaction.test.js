'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeRequestPath,
  redactLogInfo,
  redactSensitiveString
} = require('../core/utils/redaction');

function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

test('sanitizeRequestPath masks encoded Stremio config path segment and sensitive query params', () => {
  const conf = encodeConfig({
    service: 'rd',
    key: 'rd-secret-token',
    filters: { enableP2P: false }
  });

  assert.equal(
    sanitizeRequestPath(`/${conf}/stream/movie/tt1234567.json?apiKey=secret&safe=1`),
    '/:conf/stream/movie/tt1234567.json?apiKey=[REDACTED]&safe=1'
  );
});

test('redactLogInfo removes secrets from structured logger metadata', () => {
  const conf = encodeConfig({ service: 'tb', key: 'tb-secret-token' });
  const info = redactLogInfo({
    level: 'error',
    message: 'Authorization: Bearer direct-secret token=inline-secret',
    path: `/${conf}/manifest.json`,
    params: {
      conf,
      key: 'nested-secret',
      type: 'movie'
    }
  });

  const serialized = JSON.stringify(info);
  assert.equal(info.path, '/:conf/manifest.json');
  assert.equal(info.params.conf, '[REDACTED]');
  assert.equal(info.params.key, '[REDACTED]');
  assert.equal(info.params.type, 'movie');
  assert.doesNotMatch(serialized, /direct-secret|inline-secret|nested-secret|tb-secret-token/);
});

test('redactSensitiveString masks common inline secret patterns', () => {
  const redacted = redactSensitiveString('apiKey=abc123 password=hunter2 {"tmdb":"tmdb-secret"}');

  assert.doesNotMatch(redacted, /abc123|hunter2|tmdb-secret/);
  assert.match(redacted, /apiKey=\[REDACTED\]/);
});
