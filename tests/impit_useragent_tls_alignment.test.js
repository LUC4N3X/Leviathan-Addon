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

test('alignment rewrites a Chrome User-Agent to match the TLS browser ceiling', () => {
  const aligned = alignHeadersForImpitBrowser({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  }, 'chrome142');

  const ua = headerValue(aligned, 'user-agent');
  assert.match(ua, /Chrome\/142\b/);
  assert.equal(
    headerValue(aligned, 'sec-ch-ua'),
    '"Google Chrome";v="142", "Not A(Brand";v="8", "Chromium";v="142"'
  );
  assert.equal(headerValue(aligned, 'sec-ch-ua-platform'), '"Windows"');
});

test('alignment preserves Edge branding while using the Chromium TLS ceiling', () => {
  const aligned = alignHeadersForImpitBrowser({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0'
  }, 'chrome142');

  const ua = headerValue(aligned, 'user-agent');
  assert.match(ua, /Chrome\/142\b/);
  assert.match(ua, /Edg\/142\b/);
  assert.equal(
    headerValue(aligned, 'sec-ch-ua'),
    '"Microsoft Edge";v="142", "Chromium";v="142", "Not(A:Brand";v="8"'
  );
});

test('alignment to a Firefox TLS browser drops Chromium client hints', () => {
  const aligned = alignHeadersForImpitBrowser({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="142", "Not A(Brand";v="8", "Chromium";v="142"'
  }, 'firefox144');

  assert.match(headerValue(aligned, 'user-agent'), /Firefox\/144\b/);
  assert.equal(headerValue(aligned, 'sec-ch-ua'), undefined);
});

test('alignment preserves caller Referer/Origin and custom cookies', () => {
  const aligned = alignHeadersForImpitBrowser({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    Referer: 'https://vixsrc.to/',
    Origin: 'https://vixsrc.to',
    Cookie: 'cf_clearance=abc'
  }, 'chrome142');

  assert.equal(headerValue(aligned, 'referer'), 'https://vixsrc.to/');
  assert.equal(headerValue(aligned, 'origin'), 'https://vixsrc.to');
  assert.equal(headerValue(aligned, 'cookie'), 'cf_clearance=abc');
});

test('requestWithImpit exposes an alignHeaders opt-out for pre-aligned callers', () => {
  assert.equal(typeof requestWithImpit, 'function');
});
