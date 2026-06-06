'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http2 = require('http2');
const zlib = require('zlib');

const { createCloudflareBypass } = require('../providers/utils/cloudflare_bypass');
const {
  h2ReplayRequest,
  createH2ReplayPool
} = require('../providers/utils/cf_h2_replay');

function createH2Server(handler) {
  const server = http2.createServer();
  server.on('stream', handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

test('h2ReplayRequest decodes compressed html and exposes response cookies', async () => {
  const seen = {};
  const server = await createH2Server((stream, headers) => {
    seen.cookie = headers.cookie;
    seen.userAgent = headers['user-agent'];
    const body = zlib.gzipSync('<html><body>Replay OK</body></html>');
    stream.respond({
      ':status': 200,
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'set-cookie': ['cf_clearance=fresh; Path=/; HttpOnly']
    });
    stream.end(body);
  });
  const pool = createH2ReplayPool({ maxSize: 2, ttlMs: 30_000 });

  try {
    const result = await h2ReplayRequest(`${server.origin}/movie/apex`, {
      pool,
      cookieHeader: 'cf_clearance=old',
      userAgent: 'Mozilla/5.0 Test',
      timeoutMs: 1000
    });

    assert.equal(result.status, 200);
    assert.match(result.body, /Replay OK/);
    assert.deepEqual(result.setCookies, ['cf_clearance=fresh; Path=/; HttpOnly']);
    assert.equal(seen.cookie, 'cf_clearance=old');
    assert.equal(seen.userAgent, 'Mozilla/5.0 Test');
  } finally {
    pool.closeAll();
    await server.close();
  }
});

test('h2ReplayRequest follows same-origin redirects', async () => {
  const server = await createH2Server((stream, headers) => {
    if (headers[':path'] === '/start') {
      stream.respond({ ':status': 302, location: '/final' });
      stream.end();
      return;
    }
    stream.respond({ ':status': 200, 'content-type': 'text/html' });
    stream.end('<html><body>Redirect OK</body></html>');
  });
  const pool = createH2ReplayPool({ maxSize: 2, ttlMs: 30_000 });

  try {
    const result = await h2ReplayRequest(`${server.origin}/start`, {
      pool,
      cookieHeader: 'cf_clearance=abc',
      timeoutMs: 1000
    });

    assert.equal(result.status, 200);
    assert.equal(result.url, `${server.origin}/final`);
    assert.match(result.body, /Redirect OK/);
  } finally {
    pool.closeAll();
    await server.close();
  }
});

test('fetchHtml uses H2 replay fast path only when enabled and seeded with cookies', async () => {
  const replayCalls = [];
  let curlCalled = false;
  const guard = {
    getSession: () => ({
      source: 'flaresolverr',
      userAgent: 'Mozilla/5.0 Session',
      cookies: 'cf_clearance=session-clear; sid=1',
      solvedUrl: 'https://guardoserie.run/',
      timestamp: Date.now()
    }),
    isSessionFreshForUrl: () => true,
    smartFetch: async () => {
      throw new Error('guard should not run after h2 replay hit');
    }
  };
  const bypass = createCloudflareBypass({
    providerName: 'guardoserie',
    baseUrl: 'https://guardoserie.run',
    guard,
    h2ReplayEnabled: true,
    h2ReplayRunner: async (url, options) => {
      replayCalls.push({ url, options });
      return {
        status: 200,
        url,
        body: '<html><body>H2 HIT</body></html>',
        headers: { 'content-type': 'text/html' },
        setCookies: []
      };
    },
    curlCffiRunner: async () => {
      curlCalled = true;
      throw new Error('curl_cffi should not run after h2 replay hit');
    }
  });

  const html = await bypass.fetchHtml('https://guardoserie.run/movie/apex/');

  assert.match(html, /H2 HIT/);
  assert.equal(replayCalls.length, 1);
  assert.match(replayCalls[0].options.cookieHeader, /cf_clearance=session-clear/);
  assert.equal(replayCalls[0].options.userAgent, 'Mozilla/5.0 Session');
  assert.equal(curlCalled, false);
});

test('fetchHtml skips H2 replay when no cookie seed is available', async () => {
  const replayCalls = [];
  const guard = {
    getSession: () => null,
    isSessionFreshForUrl: () => false,
    smartFetch: async () => '<html><body>Guard fallback</body></html>'
  };
  const bypass = createCloudflareBypass({
    providerName: 'guardoserie',
    baseUrl: 'https://guardoserie.run',
    guard,
    h2ReplayEnabled: true,
    h2ReplayRunner: async () => {
      replayCalls.push(true);
      return null;
    }
  });

  const html = await bypass.fetchHtml('https://guardoserie.run/movie/apex/', {
    skipNativeBypass: true,
    allowCurlCffi: false,
    allowScrapling: false
  });

  assert.match(html, /Guard fallback/);
  assert.equal(replayCalls.length, 0);
});

test('fetchHtml coalesces concurrent H2 replay attempts through the clearance broker', async () => {
  let replayCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const guard = {
    getSession: () => ({
      source: 'flaresolverr',
      userAgent: 'Mozilla/5.0 Session',
      cookies: 'cf_clearance=session-clear; sid=1',
      solvedUrl: 'https://guardoserie.run/',
      timestamp: Date.now()
    }),
    isSessionFreshForUrl: () => true,
    smartFetch: async () => {
      throw new Error('guard should not run after h2 replay hit');
    }
  };
  const bypass = createCloudflareBypass({
    providerName: 'guardoserie',
    baseUrl: 'https://guardoserie.run',
    guard,
    h2ReplayEnabled: true,
    h2ReplayRunner: async (url) => {
      replayCalls += 1;
      await gate;
      return {
        status: 200,
        url,
        body: '<html><body>Broker coalesced</body></html>',
        headers: { 'content-type': 'text/html' },
        setCookies: []
      };
    },
    curlCffiRunner: async () => {
      throw new Error('curl_cffi should not run after h2 replay hit');
    }
  });

  const first = bypass.fetchHtml('https://guardoserie.run/movie/apex/');
  const second = bypass.fetchHtml('https://guardoserie.run/movie/apex/');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(replayCalls, 1);
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.match(a, /Broker coalesced/);
  assert.equal(b, a);

  const h2State = bypass.getState().clearanceBroker.hosts['guardoserie.run'].strategies.h2_replay;
  assert.equal(h2State.attempts, 1);
  assert.equal(h2State.hits, 1);
  assert.equal(h2State.sharedHits, 1);
});
