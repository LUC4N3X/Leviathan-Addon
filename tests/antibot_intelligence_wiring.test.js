'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyProviderFailure } = require('../core/intelligence/provider_failure_classifier');
const { classifyProviderError } = require('../providers/utils/provider_errors');

test('failure classifier flags DataDome block (200 body) as blocked, not selector_miss', () => {
  const body = '<html><body>Please enable JS. powered by datadome geo.captcha-delivery.com</body></html>';
  const failure = classifyProviderFailure({ response: { data: body, status: 200 }, rawResults: [] });
  assert.equal(failure.type, 'blocked');
  assert.equal(failure.canFallback, true);
  assert.equal(failure.details.vendor, 'datadome');
});

test('failure classifier flags managed Cloudflare challenge via header', () => {
  const failure = classifyProviderFailure({
    response: { data: '<html>blocked</html>', status: 403, headers: { 'cf-mitigated': 'challenge' } },
    rawResults: [],
  });
  assert.equal(failure.type, 'blocked');
});

test('failure classifier keeps bare 429 as rate_limited', () => {
  const failure = classifyProviderFailure({ error: { statusCode: 429, message: 'Too Many Requests' } });
  assert.equal(failure.type, 'rate_limited');
});

test('failure classifier still treats plain layout as selector_miss', () => {
  const body = '<html><body><main><a href="/a/one">One</a><a href="/a/two">Two</a><a href="/a/three">Three</a></main></body></html>';
  const failure = classifyProviderFailure({ response: { data: body, status: 200 }, rawResults: [] });
  assert.equal(failure.type, 'selector_miss');
});

test('provider error classifier labels Akamai WAF block', () => {
  const classified = classifyProviderError({ statusCode: 403, body: 'Reference #18.abcd1234 _abck' });
  assert.equal(classified.status, 'blocked_cf');
  assert.equal(classified.reason, 'waf_akamai');
});

test('provider error classifier detects Cloudflare via response header', () => {
  const classified = classifyProviderError({ statusCode: 503, headers: { 'cf-ray': '123', server: 'cloudflare' } });
  assert.equal(classified.status, 'blocked_cf');
});

test('provider error classifier keeps bare 429 as rate_limited', () => {
  const classified = classifyProviderError({ statusCode: 429, message: 'Too Many Requests' });
  assert.equal(classified.status, 'rate_limited');
});
