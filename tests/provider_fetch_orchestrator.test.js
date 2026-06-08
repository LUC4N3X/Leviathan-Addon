'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
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

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
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
    cloudflareBypassRunner: async () => calls.push('cloudflare_bypass')
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
    cloudflareBypassRunner: async () => calls.push('cloudflare_bypass')
  });

  assert.equal(result.status, 200);
  assert.equal(result.data, '<html>impit ok</html>');
  assert.equal(result.via, 'impit');
  assert.deepEqual(calls, ['direct', 'impit']);
});

test('fetchLayeredText promotes curl_cffi before CloudflareBypass after impit miss', async () => {
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
    cloudflareBypassRunner: async () => calls.push('cloudflare_bypass')
  });

  assert.equal(result.status, 200);
  assert.equal(result.data, '<html>curl ok</html>');
  assert.equal(result.via, 'curl_cffi');
  assert.deepEqual(calls, ['direct', 'impit', 'curl_cffi']);
});

test('fetchLayeredText uses CloudflareBypass only after direct impit and curl_cffi miss', async () => {
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
    cloudflareBypassRunner: async () => {
      calls.push('cloudflare_bypass');
      return '<html>bypass ok</html>';
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.data, '<html>bypass ok</html>');
  assert.equal(result.via, 'cloudflare_bypass');
  assert.deepEqual(calls, ['direct', 'impit', 'curl_cffi', 'cloudflare_bypass']);
});

test('fetchLayeredText falls back to CloudflareBypass mirror when the shield runner is still blocked', async (t) => {
  const calls = [];
  const mirror = await listen((req, res) => {
    calls.push({
      method: req.method,
      url: req.url,
      hostname: req.headers['x-hostname'],
      bypassCache: req.headers['x-bypass-cache']
    });
    res.writeHead(200, {
      'content-type': 'text/html',
      'x-cf-bypasser-final-url': 'https://protected.example/path?q=1'
    });
    res.end('<html>mirror ok</html>');
  });

  t.after(async () => {
    await mirror.close();
  });

  const result = await fetchLayeredText('https://protected.example/path?q=1', {
    allowDirect: false,
    allowImpit: false,
    allowCurlCffi: false,
    cloudflareBypassRunner: async () => response(403, '<title>Just a moment</title>', { headers: { server: 'cloudflare' } }),
    cloudflareBypassMirrorFallback: true,
    cloudflareBypassEndpoint: mirror.url,
    bypassCache: true,
    timeout: 1000
  });

  assert.equal(result.status, 200);
  assert.equal(result.data, '<html>mirror ok</html>');
  assert.equal(result.via, 'cloudflare_bypass');
  assert.deepEqual(calls, [{
    method: 'GET',
    url: '/path?q=1',
    hostname: 'protected.example',
    bypassCache: 'true'
  }]);
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
    cloudflareBypassRunner: async () => calls.push('cloudflare_bypass')
  });

  assert.equal(result.status, 404);
  assert.equal(result.data, 'not found');
  assert.equal(result.via, 'direct');
  assert.deepEqual(calls, ['direct']);
});
