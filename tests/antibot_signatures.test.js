'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCloudflareChallenge,
  bodyHasCloudflareChallenge,
  headersHaveCloudflare,
  headersIndicateCloudflareChallenge,
  detectAntibot,
  asText,
  normalizeHeaderMap,
  CHALLENGE_BLOCK_STATUSES,
  CF_STRONG_MARKERS,
  CF_WEAK_MARKERS,
  HUMAN_VERIFY_MARKERS,
  VENDOR_SIGNATURES,
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
  process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = 'super-secret-wall';
  delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
  const fresh = require('../providers/utils/antibot_signatures');
  assert.equal(fresh.bodyHasCloudflareChallenge('please pass the SUPER-SECRET-WALL'), true);
  if (prev == null) delete process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
  else process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = prev;
  delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
});

// ── Exported constants ────────────────────────────────────────────────────────

test('CHALLENGE_BLOCK_STATUSES contains exactly 403, 429, 503', () => {
  assert.ok(CHALLENGE_BLOCK_STATUSES instanceof Set);
  assert.ok(CHALLENGE_BLOCK_STATUSES.has(403));
  assert.ok(CHALLENGE_BLOCK_STATUSES.has(429));
  assert.ok(CHALLENGE_BLOCK_STATUSES.has(503));
  assert.equal(CHALLENGE_BLOCK_STATUSES.size, 3);
});

test('CF_STRONG_MARKERS, CF_WEAK_MARKERS, HUMAN_VERIFY_MARKERS are non-empty arrays of RegExp', () => {
  for (const arr of [CF_STRONG_MARKERS, CF_WEAK_MARKERS, HUMAN_VERIFY_MARKERS]) {
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length > 0);
    for (const re of arr) assert.ok(re instanceof RegExp);
  }
});

test('VENDOR_SIGNATURES is an array with required shape for each entry', () => {
  assert.ok(Array.isArray(VENDOR_SIGNATURES));
  assert.ok(VENDOR_SIGNATURES.length >= 8);
  for (const sig of VENDOR_SIGNATURES) {
    assert.ok(typeof sig.vendor === 'string');
    assert.ok(Array.isArray(sig.bodyMarkers));
    assert.ok(Array.isArray(sig.headerKeys));
    assert.ok(Array.isArray(sig.cookieMarkers));
  }
});

// ── asText ────────────────────────────────────────────────────────────────────

test('asText returns empty string for null and undefined', () => {
  assert.equal(asText(null), '');
  assert.equal(asText(undefined), '');
});

test('asText returns string unchanged', () => {
  assert.equal(asText('hello world'), 'hello world');
  assert.equal(asText(''), '');
});

test('asText converts Buffer to utf8 string', () => {
  const buf = Buffer.from('just a moment', 'utf8');
  assert.equal(asText(buf), 'just a moment');
});

test('asText JSON-stringifies plain objects', () => {
  const result = asText({ key: 'value' });
  assert.equal(result, '{"key":"value"}');
});

test('asText JSON-stringifies arrays', () => {
  const result = asText([1, 2, 3]);
  assert.equal(result, '[1,2,3]');
});

// ── normalizeHeaderMap ────────────────────────────────────────────────────────

test('normalizeHeaderMap returns empty object for null/undefined/non-object inputs', () => {
  assert.deepEqual(normalizeHeaderMap(null), {});
  assert.deepEqual(normalizeHeaderMap(undefined), {});
  assert.deepEqual(normalizeHeaderMap('string'), {});
  assert.deepEqual(normalizeHeaderMap(42), {});
});

test('normalizeHeaderMap lowercases all keys', () => {
  const map = normalizeHeaderMap({ 'CF-Ray': 'abc', 'X-DataDome': 'yes', Server: 'cloudflare' });
  assert.equal(map['cf-ray'], 'abc');
  assert.equal(map['x-datadome'], 'yes');
  assert.equal(map['server'], 'cloudflare');
});

test('normalizeHeaderMap joins array values with semicolon-space', () => {
  const map = normalizeHeaderMap({ 'set-cookie': ['a=1', 'b=2'] });
  assert.equal(map['set-cookie'], 'a=1; b=2');
});

test('normalizeHeaderMap preserves scalar values as-is', () => {
  const map = normalizeHeaderMap({ 'content-type': 'text/html' });
  assert.equal(map['content-type'], 'text/html');
});

// ── headersHaveCloudflare ─────────────────────────────────────────────────────

test('headersHaveCloudflare detects cf-ray header', () => {
  assert.equal(headersHaveCloudflare({ 'cf-ray': '7abc123def456' }), true);
});

test('headersHaveCloudflare detects cf-cache-status header', () => {
  assert.equal(headersHaveCloudflare({ 'cf-cache-status': 'MISS' }), true);
});

test('headersHaveCloudflare detects cf-mitigated header', () => {
  assert.equal(headersHaveCloudflare({ 'cf-mitigated': 'challenge' }), true);
});

test('headersHaveCloudflare detects server: cloudflare (case-insensitive)', () => {
  assert.equal(headersHaveCloudflare({ Server: 'Cloudflare' }), true);
  assert.equal(headersHaveCloudflare({ server: 'cloudflare' }), true);
});

test('headersHaveCloudflare returns false for unrelated headers', () => {
  assert.equal(headersHaveCloudflare({ 'x-powered-by': 'express', server: 'nginx' }), false);
  assert.equal(headersHaveCloudflare({}), false);
  assert.equal(headersHaveCloudflare(null), false);
});

// ── headersIndicateCloudflareChallenge ───────────────────────────────────────

test('headersIndicateCloudflareChallenge returns true for cf-mitigated: challenge', () => {
  assert.equal(headersIndicateCloudflareChallenge({ 'cf-mitigated': 'challenge' }), true);
});

test('headersIndicateCloudflareChallenge returns true for cf-mitigated: captcha', () => {
  assert.equal(headersIndicateCloudflareChallenge({ 'cf-mitigated': 'captcha' }), true);
});

test('headersIndicateCloudflareChallenge returns false for cf-mitigated with other value', () => {
  assert.equal(headersIndicateCloudflareChallenge({ 'cf-mitigated': 'managed' }), false);
  assert.equal(headersIndicateCloudflareChallenge({ 'cf-mitigated': '' }), false);
});

test('headersIndicateCloudflareChallenge returns false without cf-mitigated header', () => {
  assert.equal(headersIndicateCloudflareChallenge({ 'cf-ray': 'abc' }), false);
  assert.equal(headersIndicateCloudflareChallenge({}), false);
  assert.equal(headersIndicateCloudflareChallenge(null), false);
});

// ── bodyHasCloudflareChallenge ────────────────────────────────────────────────

test('bodyHasCloudflareChallenge returns false for empty/null body', () => {
  assert.equal(bodyHasCloudflareChallenge(''), false);
  assert.equal(bodyHasCloudflareChallenge(null), false);
  assert.equal(bodyHasCloudflareChallenge(undefined), false);
});

test('bodyHasCloudflareChallenge detects each strong marker independently', () => {
  const strongBodies = [
    'Just a moment...',
    'Checking your browser before accessing the site',
    'Checking if the site connection is secure',
    'Cloudflare Ray ID: 7abc',
    '<div class="cf-browser-verification">',
    'cf-chl-widget element',
    '__cf_chl_opt = {}',
    '_cf_chl_opt token',
    'cf.challenge.orchestrate()',
    'cdn-cgi/challenge-platform/h/b/orchestrate',
    'cdn-cgi/challenge-platform/h/g/orchestrate',
    'turnstile.cloudflare.com/v0/api.js',
    'cf-turnstile-response=TOKEN',
    'window._cf_chl_ = true',
    'challenges.cloudflare.com/turnstile/v0',
  ];
  for (const body of strongBodies) {
    assert.equal(bodyHasCloudflareChallenge(body), true, `Expected true for: ${body}`);
  }
});

test('bodyHasCloudflareChallenge detects weak markers on small body', () => {
  assert.equal(bodyHasCloudflareChallenge('challenge-platform token'), true);
  assert.equal(bodyHasCloudflareChallenge('cf_clearance=xyz'), true);
  assert.equal(bodyHasCloudflareChallenge('cf_chl_ token'), true);
  assert.equal(bodyHasCloudflareChallenge('<form class="challenge-form">'), true);
});

test('bodyHasCloudflareChallenge does not flag weak markers on large body', () => {
  const padding = 'x'.repeat(31000);
  assert.equal(bodyHasCloudflareChallenge(padding + ' cf_clearance=xyz'), false);
});

test('bodyHasCloudflareChallenge detects human verify + CF signal combo on small body', () => {
  const body = 'Please verify you are human. This page uses cloudflare protection.';
  assert.equal(bodyHasCloudflareChallenge(body), true);
});

test('bodyHasCloudflareChallenge accepts Buffer input', () => {
  const buf = Buffer.from('Just a moment...', 'utf8');
  assert.equal(bodyHasCloudflareChallenge(buf), true);
});

test('bodyHasCloudflareChallenge detects strong marker even on large body', () => {
  const body = 'x'.repeat(50000) + ' just a moment ' + 'y'.repeat(10000);
  assert.equal(bodyHasCloudflareChallenge(body), true);
});

// ── isCloudflareChallenge ─────────────────────────────────────────────────────

test('isCloudflareChallenge returns true for 403 with null headers', () => {
  assert.equal(isCloudflareChallenge('opaque body', 403, null), true);
});

test('isCloudflareChallenge returns true for 429 with null headers', () => {
  assert.equal(isCloudflareChallenge('', 429, null), true);
});

test('isCloudflareChallenge returns true for 503 with null headers', () => {
  assert.equal(isCloudflareChallenge('', 503, null), true);
});

test('isCloudflareChallenge returns false for 503 with non-CF headers', () => {
  assert.equal(isCloudflareChallenge('service unavailable', 503, { server: 'nginx' }), false);
});

test('isCloudflareChallenge returns false for clean 200', () => {
  assert.equal(isCloudflareChallenge('<html>normal page</html>', 200, { server: 'apache' }), false);
});

test('isCloudflareChallenge returns true for 403 with CF headers and no challenge body', () => {
  assert.equal(isCloudflareChallenge('access denied', 403, { 'cf-ray': 'abc123' }), true);
});

// ── detectAntibot: cloudflare kinds ──────────────────────────────────────────

test('detectAntibot returns managed_challenge kind when cf-mitigated: challenge header present', () => {
  const result = detectAntibot('blocked', 403, { 'cf-mitigated': 'challenge' });
  assert.equal(result.blocked, true);
  assert.equal(result.vendor, 'cloudflare');
  assert.equal(result.kind, 'managed_challenge');
  assert.equal(result.reason, 'cloudflare_challenge');
});

test('detectAntibot returns interactive kind for CF challenge without turnstile or cf-mitigated', () => {
  const result = detectAntibot('Just a moment...', 503, { 'cf-ray': 'xyz' });
  assert.equal(result.vendor, 'cloudflare');
  assert.equal(result.kind, 'interactive');
});

// ── detectAntibot: remaining vendors ─────────────────────────────────────────

test('detectAntibot classifies Incapsula via body marker', () => {
  const result = detectAntibot('Blocked by Incapsula WAF', 403, {});
  assert.equal(result.vendor, 'incapsula');
  assert.equal(result.blocked, true);
  assert.equal(result.kind, 'waf');
});

test('detectAntibot classifies Incapsula via header', () => {
  const result = detectAntibot('blocked', 403, { 'x-iinfo': '8-123456' });
  assert.equal(result.vendor, 'incapsula');
  assert.equal(result.blocked, true);
});

test('detectAntibot classifies Incapsula via cookie marker', () => {
  const result = detectAntibot('page content', 200, { 'set-cookie': 'visid_incap_12345=abc; Path=/' });
  assert.equal(result.vendor, 'incapsula');
});

test('detectAntibot classifies Kasada via body marker', () => {
  const result = detectAntibot('kasada bot protection active', 403, {});
  assert.equal(result.vendor, 'kasada');
  assert.equal(result.blocked, true);
});

test('detectAntibot classifies Kasada via header', () => {
  const result = detectAntibot('blocked', 403, { 'x-kpsdk-ct': 'token123' });
  assert.equal(result.vendor, 'kasada');
  assert.equal(result.blocked, true);
});

test('detectAntibot classifies Kasada via cookie marker', () => {
  const result = detectAntibot('', 200, { 'set-cookie': 'KP_UIDz=somevalue; Path=/' });
  assert.equal(result.vendor, 'kasada');
});

test('detectAntibot classifies Queue-IT via body marker', () => {
  const result = detectAntibot('You are now in line. Please wait.', 200, {});
  assert.equal(result.vendor, 'queue-it');
});

test('detectAntibot classifies Queue-IT via header', () => {
  const result = detectAntibot('', 200, { 'x-queueit-passed': '1' });
  assert.equal(result.vendor, 'queue-it');
});

test('detectAntibot classifies Queue-IT via cookie marker', () => {
  const result = detectAntibot('queued', 200, { 'set-cookie': 'QueueITAccepted-abc=true; Path=/' });
  assert.equal(result.vendor, 'queue-it');
});

test('detectAntibot classifies DDoS-Guard via body marker', () => {
  const result = detectAntibot('Protected by ddos-guard', 403, {});
  assert.equal(result.vendor, 'ddos-guard');
  assert.equal(result.blocked, true);
});

test('detectAntibot classifies DDoS-Guard via header', () => {
  const result = detectAntibot('', 403, { 'x-ddg': 'hit' });
  assert.equal(result.vendor, 'ddos-guard');
});

test('detectAntibot classifies DDoS-Guard via cookie marker', () => {
  const result = detectAntibot('page', 200, { 'set-cookie': '__ddg1_=cookievalue; Path=/' });
  assert.equal(result.vendor, 'ddos-guard');
});

test('detectAntibot classifies Sucuri via body marker', () => {
  const result = detectAntibot('Access Denied - Sucuri Website Firewall', 403, {});
  assert.equal(result.vendor, 'sucuri');
  assert.equal(result.blocked, true);
});

test('detectAntibot classifies Sucuri via header', () => {
  const result = detectAntibot('', 200, { 'x-sucuri-id': '12345' });
  assert.equal(result.vendor, 'sucuri');
});

test('detectAntibot classifies Sucuri via cookie marker', () => {
  const result = detectAntibot('page', 200, { 'set-cookie': 'sucuri_cloudproxy_uuid=abc; Path=/' });
  assert.equal(result.vendor, 'sucuri');
});

test('detectAntibot classifies DataDome via cookie marker', () => {
  const result = detectAntibot('page', 200, { 'set-cookie': 'datadome=abc123; Path=/' });
  assert.equal(result.vendor, 'datadome');
});

test('detectAntibot classifies DataDome via body marker', () => {
  const result = detectAntibot('blocked by datadome', 403, {});
  assert.equal(result.vendor, 'datadome');
  assert.equal(result.blocked, true);
});

test('detectAntibot classifies Akamai via header', () => {
  const result = detectAntibot('', 403, { 'x-akamai-transformed': 'yes' });
  assert.equal(result.vendor, 'akamai');
  assert.equal(result.blocked, true);
});

test('detectAntibot classifies PerimeterX via body marker', () => {
  const result = detectAntibot('perimeterx px-captcha challenge', 403, {});
  assert.equal(result.vendor, 'perimeterx');
  assert.equal(result.blocked, true);
});

// ── detectAntibot: reason field ───────────────────────────────────────────────

test('detectAntibot reason encodes detection method for body hit', () => {
  const result = detectAntibot('sucuri cloudproxy blocked', 403, {});
  assert.equal(result.reason, 'sucuri_body');
});

test('detectAntibot reason encodes detection method for header hit', () => {
  const result = detectAntibot('page', 200, { 'x-sucuri-cache': 'MISS' });
  assert.equal(result.reason, 'sucuri_header');
});

test('detectAntibot reason encodes detection method for cookie hit', () => {
  const result = detectAntibot('page', 200, { 'set-cookie': 'sucuri_cloudproxy_uuid=x; Path=/' });
  assert.equal(result.reason, 'sucuri_cookie');
});

// ── detectAntibot: vendor cookie on non-block status (blocked=false) ──────────

test('detectAntibot vendor cookie-only on 200 results in blocked=false', () => {
  const result = detectAntibot('normal page content', 200, { 'set-cookie': 'datadome=xyz; Path=/' });
  assert.equal(result.vendor, 'datadome');
  assert.equal(result.blocked, false);
  assert.equal(result.retryable, false);
});

// ── detectAntibot: upstream/temporary status codes ───────────────────────────

test('detectAntibot returns temporary_upstream for 502', () => {
  const result = detectAntibot('', 502, {});
  assert.equal(result.kind, 'temporary_upstream');
  assert.equal(result.blocked, true);
  assert.equal(result.retryable, true);
});

test('detectAntibot returns temporary_upstream for 504', () => {
  const result = detectAntibot('gateway timeout', 504, { server: 'nginx' });
  assert.equal(result.kind, 'temporary_upstream');
});

test('detectAntibot returns temporary_upstream for Cloudflare-specific codes', () => {
  for (const code of [520, 521, 522, 523, 524]) {
    const result = detectAntibot('', code, {});
    assert.equal(result.kind, 'temporary_upstream', `Expected temporary_upstream for ${code}`);
    assert.equal(result.reason, 'temporary_http_status');
  }
});

// ── detectAntibot: generic WAF 403 body keywords ─────────────────────────────

test('detectAntibot flags generic WAF body on 403 for "access denied"', () => {
  const result = detectAntibot('Access Denied', 403, {});
  assert.equal(result.kind, 'waf');
  assert.equal(result.vendor, 'unknown');
  assert.equal(result.reason, 'generic_waf_body');
  assert.equal(result.blocked, true);
  assert.equal(result.retryable, true);
});

test('detectAntibot flags generic WAF body on 403 for "request blocked"', () => {
  const result = detectAntibot('Your request blocked by security filter', 403, {});
  assert.equal(result.kind, 'waf');
  assert.equal(result.reason, 'generic_waf_body');
});

test('detectAntibot flags generic WAF body on 403 for "automated traffic"', () => {
  const result = detectAntibot('We detected automated traffic from your IP', 403, {});
  assert.equal(result.reason, 'generic_waf_body');
});

test('detectAntibot flags generic WAF body on 403 for "bot protection"', () => {
  const result = detectAntibot('Bot protection enabled. Please verify.', 403, {});
  assert.equal(result.reason, 'generic_waf_body');
});

// ── detectAntibot: 403 forbidden (no matching body) ───────────────────────────

test('detectAntibot returns forbidden with retryable=false for plain 403', () => {
  const result = detectAntibot('<html><body>you shall not pass</body></html>', 403, {});
  assert.equal(result.kind, 'forbidden');
  assert.equal(result.blocked, true);
  assert.equal(result.retryable, false);
  assert.equal(result.vendor, 'unknown');
  assert.equal(result.reason, 'http_403');
});

// ── detectAntibot: status field is always numeric ─────────────────────────────

test('detectAntibot status field reflects the numeric status code', () => {
  assert.equal(detectAntibot('', 200, {}).status, 200);
  assert.equal(detectAntibot('', 403, {}).status, 403);
  assert.equal(detectAntibot('', 429, {}).status, 429);
  assert.equal(detectAntibot('', 502, {}).status, 502);
});

test('detectAntibot coerces string status to number', () => {
  const result = detectAntibot('just a moment', '503', null);
  assert.equal(result.status, 503);
  assert.equal(result.blocked, true);
});

// ── detectAntibot: header case insensitivity ──────────────────────────────────

test('detectAntibot detects vendor headers with mixed-case names', () => {
  const result = detectAntibot('', 200, { 'X-DataDome': 'protected' });
  assert.equal(result.vendor, 'datadome');
  assert.equal(result.blocked, true);
});

test('detectAntibot detects CF headers with mixed-case names', () => {
  const result = detectAntibot('Just a moment', 503, { 'CF-Ray': 'abc' });
  assert.equal(result.vendor, 'cloudflare');
  assert.equal(result.blocked, true);
});

// ── env-based extra markers: pipe and newline separators ─────────────────────

test('env extra markers support pipe separator for multiple patterns', () => {
  const prev = process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
  process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = 'my-wall-alpha|my-wall-beta';
  delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
  const fresh = require('../providers/utils/antibot_signatures');
  assert.equal(fresh.bodyHasCloudflareChallenge('blocked by MY-WALL-ALPHA'), true);
  assert.equal(fresh.bodyHasCloudflareChallenge('blocked by MY-WALL-BETA'), true);
  if (prev == null) delete process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
  else process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = prev;
  delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
});

test('env extra markers with invalid regex are skipped silently', () => {
  const prev = process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
  process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = '[invalid-regex|valid-marker';
  delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
  const fresh = require('../providers/utils/antibot_signatures');
  // invalid regex is skipped, valid marker still works
  assert.equal(fresh.bodyHasCloudflareChallenge('valid-marker detected'), true);
  // invalid regex does not throw
  assert.equal(fresh.bodyHasCloudflareChallenge('nothing here'), false);
  if (prev == null) delete process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
  else process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = prev;
  delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
});

test('env extra markers empty string results in no extra markers', () => {
  const prev = process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
  process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = '';
  delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
  const fresh = require('../providers/utils/antibot_signatures');
  // page without any real CF markers should not be flagged
  assert.equal(fresh.bodyHasCloudflareChallenge('totally normal page content'), false);
  if (prev == null) delete process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS;
  else process.env.ANTIBOT_EXTRA_CHALLENGE_MARKERS = prev;
  delete require.cache[require.resolve('../providers/utils/antibot_signatures')];
});
