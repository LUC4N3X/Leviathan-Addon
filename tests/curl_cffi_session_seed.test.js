'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudflareBypass } = require('../providers/utils/cloudflare_bypass');

test('curl_cffi is seeded with hydrated FlareSolverr/Redis session cookies', async () => {
  let session = null;
  const runnerCalls = [];

  const guard = {
    hydrateSessionForUrl: async (url, reason) => {
      assert.equal(url, 'https://guardoserie.run/movie/apex/');
      assert.equal(reason, 'curl-cffi-seed');
      session = {
        source: 'flaresolverr',
        userAgent: 'Mozilla/5.0 Test Chrome/138.0.0.0 Safari/537.36',
        cookies: 'cf_clearance=abc123; guardoserie_sid=sid456',
        url: 'https://guardoserie.run',
        solvedUrl: 'https://guardoserie.run/',
        timestamp: Date.now()
      };
      return true;
    },
    getSession: () => session,
    isSessionFresh: () => true,
    isSessionFreshForUrl: () => true
  };

  const bypass = createCloudflareBypass({
    providerName: 'guardoserie',
    baseUrl: 'https://guardoserie.run',
    guard,
    curlCffiRunner: async (url, providerName, options) => {
      runnerCalls.push({ url, providerName, options });
      return {
        status: 'ok',
        code: 200,
        url,
        html: '<html><body>Guardoserie OK</body></html>',
        userAgent: options.headers['User-Agent'],
        cookies: options.cookiesJson
      };
    }
  });

  await bypass.runCurlCffi('https://guardoserie.run/movie/apex/', { timeoutMs: 3000 });

  assert.equal(runnerCalls.length, 1);
  const { options } = runnerCalls[0];
  assert.match(options.headers.Cookie, /cf_clearance=abc123/);
  assert.match(options.headers.Cookie, /guardoserie_sid=sid456/);
  assert.equal(options.headers['User-Agent'], 'Mozilla/5.0 Test Chrome/138.0.0.0 Safari/537.36');
  assert.ok(Array.isArray(options.cookiesJson));
  assert.ok(options.cookiesJson.some(cookie => cookie.name === 'cf_clearance' && cookie.value === 'abc123'));
});
