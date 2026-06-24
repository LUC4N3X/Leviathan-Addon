'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isUnsupportedStreamRequestError,
  validateStreamRequest
} = require('../core/utils/stream_request');

test('validateStreamRequest accepts supported Stremio stream identifiers', () => {
  assert.equal(validateStreamRequest('movie', 'tt1234567'), true);
  assert.equal(validateStreamRequest('series', 'tt1234567:1:2'), true);
  assert.equal(validateStreamRequest('movie', 'tmdb:12345'), true);
  assert.equal(validateStreamRequest('anime', 'kitsu:9876:12'), true);
});

test('validateStreamRequest marks unsupported type as empty-response safe', () => {
  assert.throws(
    () => validateStreamRequest('channel', 'tt1234567'),
    (error) => {
      assert.equal(isUnsupportedStreamRequestError(error), true);
      assert.equal(error.statusCode, 200);
      return true;
    }
  );
});

test('validateStreamRequest marks unsupported id as empty-response safe', () => {
  assert.throws(
    () => validateStreamRequest('movie', 'not-a-stremio-id'),
    (error) => {
      assert.equal(isUnsupportedStreamRequestError(error), true);
      assert.equal(error.statusCode, 200);
      return true;
    }
  );
});
