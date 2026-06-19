'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getImpitBrowserCandidatesForFingerprint,
  getImpitBrowserForFingerprint
} = require('../providers/utils/bypass');

test('impit browser selection maps Chrome fingerprints to the supported TLS ceiling', () => {
  const fingerprint = {
    browserType: 'chrome',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  };

  assert.equal(getImpitBrowserForFingerprint(fingerprint), 'chrome142');
});

test('impit browser candidates normalize higher and legacy browser values to the TLS ceiling', () => {
  const candidates = getImpitBrowserCandidatesForFingerprint(null, {
    url: 'https://cb01uno.bar/the-bluff/',
    browser: 'chrome999',
    browserFallbacks: ['firefox999', 'edge999']
  });

  assert.equal(candidates[0], 'chrome142');
  assert.ok(candidates.includes('firefox144'));
  assert.equal(candidates.filter((item) => item === 'chrome142').length, 1);
  assert.equal(candidates.includes('chrome999'), false);
  assert.equal(candidates.includes('firefox999'), false);
});
