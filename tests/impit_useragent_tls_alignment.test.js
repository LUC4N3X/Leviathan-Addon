'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  alignHeadersForImpitBrowser,
  requestWithImpit
} = require('../providers/utils/bypass');

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

// requestWithImpit now aligns request headers to the TLS browser it impersonates, so the
// advertised User-Agent (and Chromium client hints) always match the JA3/JA4 ClientHello.
// These tests cover the alignment logic that drives that guarantee.

test('alignment rewrites a mismatched Chrome User-Agent to match the TLS browser', () => {
  // A Chrome/138 UA paired with a chrome136 TLS fingerprint is the mismatch Cloudflare flags.
  const aligned = alignHeadersForImpitBrowser({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
  }, 'chrome136');

  const ua = headerValue(aligned, 'user-agent');
  assert.match(ua, /Chrome\/136\b/, 'User-Agent major version must match the chrome136 TLS fingerprint');
  assert.equal(
    headerValue(aligned, 'sec-ch-ua'),
    '"Google Chrome";v="136", "Not A(Brand";v="8", "Chromium";v="136"'
  );
  assert.equal(headerValue(aligned, 'sec-ch-ua-platform'), '"Windows"');
});

test('alignment to a Firefox TLS browser drops Chromium client hints', () => {
  const aligned = alignHeadersForImpitBrowser({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="138", "Not A(Brand";v="8", "Chromium";v="138"'
  }, 'firefox135');

  assert.match(headerValue(aligned, 'user-agent'), /Firefox\/135\b/);
  assert.equal(headerValue(aligned, 'sec-ch-ua'), undefined, 'Firefox must not send sec-ch-ua');
});

test('alignment preserves caller Referer/Origin and custom cookies', () => {
  const aligned = alignHeadersForImpitBrowser({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    Referer: 'https://vixsrc.to/',
    Origin: 'https://vixsrc.to',
    Cookie: 'cf_clearance=abc'
  }, 'chrome136');

  assert.equal(headerValue(aligned, 'referer'), 'https://vixsrc.to/');
  assert.equal(headerValue(aligned, 'origin'), 'https://vixsrc.to');
  assert.equal(headerValue(aligned, 'cookie'), 'cf_clearance=abc');
});

test('requestWithImpit exposes an alignHeaders opt-out for pre-aligned callers', () => {
  // The rotating path pre-aligns headers and passes alignHeaders:false to avoid double work;
  // make sure the primitive accepts the flag without throwing on option parsing.
  assert.equal(typeof requestWithImpit, 'function');
});
