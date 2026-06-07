'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchLayeredText } = require('../providers/utils/provider_fetch_orchestrator');

function response(status, data, extra = {}) {
  return {
    status,
    statusCode: status,
    data,
    body: data,
    headers: extra.headers || {},
    url: extra.url || 'https://example.test/page'
  };
}

test('fetchLayeredText returns direct response without calling heavier fallbacks', async () => {
  const calls = [];
  const directClient = {
    get: async () => {
      calls.push('direct');
      return response(200, '<html>ok</html>');
    }
  };

  const result = await fetchLayeredText('https://example.test/page', {
    directClient,
    impitRunner: async () => calls.push('impit'),
    curlCffiRunner: async () => calls.push('curl_cffi'),
    flareSolverrRunner: async () => calls.push('flaresolverr')
  });

  assert.equal(result.status, 200);
  assert.equal(result.via, 'direct');
  assert.deepEqual(calls, ['direct']);
});

test('fetchLayeredText falls back from blocked direct response to impit', async () => {
  const calls = [];
  const directClient = {
    get: async () => {
      calls.push('direct');
      return response(403, '<title>Just a moment</title>', { headers: { server: 'cloudflare' } });
    }
  };

  const result = await fetchLayeredText('https://example.test/page', {
    directClient,
    impitRunner: async () => {
      calls.push('impit');
      return response(200, '<html>impit ok</html>', { url: 'https://example.test/page' });
    },
    curlCffiRunner: async () => calls.push('curl_cffi'),
    flareSolverrRunner: async () => calls.push('flaresolverr')
  });

  assert.equal(result.status, 200);
  assert.equal(result.data, '<html>impit ok</html>');
  assert.equal(result.via, 'impit');
  assert.deepEqual(calls, ['direct', 'impit']);
});

test('fetchLayeredText promotes curl_cffi before FlareSolverr after impit miss', async () => {
  const calls = [];
  const directClient = {
    get: async () => {
      calls.push('direct');
      return response(403, '<title>Just a moment</title>', { headers: { server: 'cloudflare' } });
    }
  };

  const result = await fetchLayeredText('https://example.test/page', {
    directClient,
    impitRunner: async () => {
      calls.push('impit');
      return response(403, '<title>Just a moment</title>', { headers: { server: 'cloudflare' } });
    },
    curlCffiRunner: async () => {
      calls.push('curl_cffi');
      return { status: 'ok', code: 200, html: '<html>curl ok</html>' };
    },
    flareSolverrRunner: async () => calls.push('flaresolverr')
  });

  assert.equal(result.status, 200);
  assert.equal(result.data, '<html>curl ok</html>');
  assert.equal(result.via, 'curl_cffi');
  assert.deepEqual(calls, ['direct', 'impit', 'curl_cffi']);
});

test('fetchLayeredText uses FlareSolverr only after direct impit and curl_cffi miss', async () => {
  const calls = [];
  const directClient = {
    get: async () => {
      calls.push('direct');
      return response(403, '<title>Just a moment</title>', { headers: { server: 'cloudflare' } });
    }
  };

  const result = await fetchLayeredText('https://example.test/page', {
    directClient,
    impitRunner: async () => {
      calls.push('impit');
      return response(403, '<title>Just a moment</title>', { headers: { server: 'cloudflare' } });
    },
    curlCffiRunner: async () => {
      calls.push('curl_cffi');
      return { status: 'ok', code: 403, html: '<title>Just a moment</title>', challengeDetected: true };
    },
    flareSolverrRunner: async () => {
      calls.push('flaresolverr');
      return '<html>flare ok</html>';
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.data, '<html>flare ok</html>');
  assert.equal(result.via, 'flaresolverr');
  assert.deepEqual(calls, ['direct', 'impit', 'curl_cffi', 'flaresolverr']);
});

test('fetchLayeredText preserves non-retryable direct 404 without heavier fallbacks', async () => {
  const calls = [];
  const directClient = {
    get: async () => {
      calls.push('direct');
      return response(404, 'not found');
    }
  };

  const result = await fetchLayeredText('https://example.test/missing', {
    directClient,
    impitRunner: async () => calls.push('impit'),
    curlCffiRunner: async () => calls.push('curl_cffi'),
    flareSolverrRunner: async () => calls.push('flaresolverr')
  });

  assert.equal(result.status, 404);
  assert.equal(result.data, 'not found');
  assert.equal(result.via, 'direct');
  assert.deepEqual(calls, ['direct']);
});
