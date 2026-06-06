'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCloudflareBypass } = require('../providers/utils/cloudflare_bypass');

test('fetchHtml records curl_cffi misses and guard hits in clearance broker state', async () => {
  const guard = {
    getSession: () => null,
    isSessionFreshForUrl: () => false,
    smartFetch: async () => '<html><body>Guard saved it</body></html>'
  };
  const bypass = createCloudflareBypass({
    providerName: 'guardoserie',
    baseUrl: 'https://guardoserie.run',
    guard,
    curlCffiRunner: async (url) => ({
      status: 'ok',
      code: 403,
      url,
      html: '<html><title>Just a moment...</title><body>Checking your browser</body></html>',
      userAgent: 'Mozilla/5.0 Test',
      cookies: []
    })
  });

  const html = await bypass.fetchHtml('https://guardoserie.run/movie/apex/', {
    skipNativeBypass: true,
    allowScrapling: false
  });

  assert.match(html, /Guard saved it/);

  const strategies = bypass.getState().clearanceBroker.hosts['guardoserie.run'].strategies;
  assert.equal(strategies.curl_cffi.misses, 1);
  assert.equal(strategies.curl_cffi.lastStatusCode, 403);
  assert.equal(strategies.guard.hits, 1);
  assert.equal(strategies.guard.lastBytes, '<html><body>Guard saved it</body></html>'.length);
});
