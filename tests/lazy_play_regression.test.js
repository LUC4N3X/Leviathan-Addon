'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeRequestPath, redactSensitiveString } = require('../core/utils/redaction');

function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64url');
}

test('redacts encoded config segment before play_lazy route', () => {
  const conf = encodeConfig({
    service: 'tb',
    key: 'd52e8b31-2f91-4dca-a822-06361b37180a',
    filters: { language: 'ita' }
  });
  const path = `/${conf}/play_lazy/tb/ABCDEF1234567890/2?s=1&e=3&imdb=tt2442560`;
  assert.equal(sanitizeRequestPath(path), '/:conf/play_lazy/tb/ABCDEF1234567890/2?s=1&e=3&imdb=tt2442560');
});

test('redacts encoded config in free-form log messages for playback routes', () => {
  const conf = encodeConfig({
    service: 'tb',
    key: 'd52e8b31-2f91-4dca-a822-06361b37180a',
    filters: { language: 'ita' }
  });
  const message = `GET /${conf}/play_lazy/tb/HASH/2?s=1&e=3`;
  const redacted = redactSensitiveString(message);
  assert.ok(!redacted.includes(conf));
  assert.ok(!redacted.includes('d52e8b31'));
  assert.match(redacted, /\/:conf\/play_lazy\/tb\/HASH\/2/);
});
