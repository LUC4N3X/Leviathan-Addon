'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCloudflareChallenge,
  bodyHasCloudflareChallenge,
  headersHaveCloudflare,
  headersIndicateCloudflareChallenge,
  detectAntibot,
} = require('../providers/utils/antibot_signatures');

test('detects classic Cloudflare IUAM interstitial', () => {
  const html = '<html><head><title>Just a moment...</title></head><body>'
    + 'Checking your browser before accessing. <div id="cf-wrapper"></div></body></html>';
  assert.equal(bodyHasCloudflareChallenge(html), true);
  assert.equal(isCloudflareChallenge(html, 503, { 'cf-ray': 'abc' }), true);
});

test('detects Turnstile managed challenge body', () => {
  const html = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
    + '<div class="cf-turnstile"></div> __cf_chl_opt';
  const result = detectAntibot(html, 403, { 'cf-ray': 'x', server: 'cloudflare' });
  assert.equal(result.blocked, true);
  assert.equal(result.vendor, 'cloudflare');
  assert.equal(result.kind, 'turnstile');
});

test('detects modern cf-mitigated challenge header even with opaque body', () => {
  assert.equal(headersIndicateCloudflareChallenge({ 'cf-mitigated': 'challenge' }), true);
  assert.equal(isCloudflareChallenge('<html>blocked</html>', 403, { 'cf-mitigated': 'challenge' }), true);
});

test('cf-mitigated header counts as a Cloudflare response header', () => {
  assert.equal(headersHaveCloudflare({ 'cf-mitigated': 'challenge' }), true);
  assert.equal(headersHaveCloudflare({ server: 'cloudflare' }), true);
  assert.equal(headersHaveCloudflare({ 'x-served-by': 'nginx' }), false);
});

test('does not flag a normal large page that merely embeds a widget', () => {
  const page = `<html><body>${'lorem ipsum '.repeat(5000)} cf_clearance footer note</body></html>`;
  assert.equal(bodyHasCloudflareChallenge(page), false);
});

test('classifies DataDome block via header', () => {
  const result = detectAntibot('<html>blocked</html>', 403, { 'x-datadome': 'protected' });
  assert.equal(result.blocked, true);
  assert.equal(result.vendor, 'datadome');
  assert.equal(result.kind, 'waf');
});

test('classifies Akamai bot manager via body marker', () => {
  const result = detectAntibot('Reference #18.abcd1234 _abck challenge', 403, {});
  assert.equal(result.vendor, 'akamai');
  assert.equal(result.blocked, true);
});

test('classifies PerimeterX via cookie marker on a block status', () => {
  const result = detectAntibot('access denied', 403, { 'set-cookie': '_pxhd=abc; Path=/' });
  assert.equal(result.vendor, 'perimeterx');
});

test('rate limit without vendor markers is reported as 429', () => {
  const result = detectAntibot('slow down', 429, {});
  assert.equal(result.blocked, true);
  assert.equal(result.kind, 'rate_limit');
});

test('clean 200 response is not blocked', () => {
  const result = detectAntibot('<html><body>movie list</body></html>', 200, { server: 'nginx' });
  assert.equal(result.blocked, false);
  assert.equal(result.vendor, 'none');
});

test('env-provided extra markers extend Cloudflare detection', () => {
  const prev = process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
  try {
    process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = 'super-secret-wall';
    delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
    const fresh = require('../providers/utils/antibot_signatures');
    assert.equal(fresh.bodyHasCloudflareChallenge('please pass the SUPER-SECRET-WALL'), true);
  } finally {
    if (prev == null) delete process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
    else process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = prev;
    delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
  }
});

test('vendor presence headers on 200 responses are not blocked', () => {
  const queue = detectAntibot('<html><body>passed queue</body></html>', 200, { 'x-queueit-passed': 'true' });
  assert.equal(queue.vendor, 'queue-it');
  assert.equal(queue.blocked, false);
  assert.equal(queue.retryable, false);

  const cdn = detectAntibot('<html><body>regular cdn page</body></html>', 200, { 'x-cdn': 'incapsula' });
  assert.equal(cdn.vendor, 'incapsula');
  assert.equal(cdn.blocked, false);
  assert.equal(cdn.retryable, false);
});

test('block-specific vendor headers on 200 responses are blocked', () => {
  const perimeterx = detectAntibot('x', 200, { 'x-px-block': '1' });
  assert.equal(perimeterx.vendor, 'perimeterx');
  assert.equal(perimeterx.blocked, true);
  assert.equal(perimeterx.retryable, true);
  assert.equal(perimeterx.reason, 'perimeterx_header');

  const kasada = detectAntibot('', 200, { 'x-kpsdk-cd': 'challenge-data' });
  assert.equal(kasada.vendor, 'kasada');
  assert.equal(kasada.blocked, true);
  assert.equal(kasada.retryable, true);
  assert.equal(kasada.reason, 'kasada_header');

  const ddosGuard = detectAntibot('ok', 200, { 'x-ddg': 'protected' });
  assert.equal(ddosGuard.vendor, 'ddos-guard');
  assert.equal(ddosGuard.blocked, true);
  assert.equal(ddosGuard.retryable, true);
  assert.equal(ddosGuard.reason, 'ddos-guard_header');
});
