'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getImpitBrowserCandidatesForFingerprint,
  getImpitBrowserForFingerprint
} = require('../providers/utils/bypass');

test('impit browser selection maps modern Chrome fingerprints to a supported browser', () => {
  const fingerprint = {
    browserType: 'chrome',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
  };

  assert.equal(getImpitBrowserForFingerprint(fingerprint), 'chrome136');
});

test('impit browser candidates normalize unsupported explicit browser values', () => {
  const candidates = getImpitBrowserCandidatesForFingerprint(null, {
    url: 'https://cb01uno.bar/the-bluff/',
    browser: 'chrome138',
    browserFallbacks: ['firefox138', 'chrome125']
  });

  assert.equal(candidates[0], 'chrome136');
  assert.ok(candidates.includes('chrome125'));
  assert.equal(candidates.includes('chrome138'), false);
  assert.equal(candidates.includes('firefox138'), false);
});
