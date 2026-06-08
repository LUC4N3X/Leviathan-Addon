'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'axios') {
    async function axiosLike(url, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      const response = await fetch(url, {
        method,
        headers: options.headers || {},
        body: method === 'GET' || method === 'HEAD' ? undefined : options.body,
        signal: options.signal
      });
      const text = await response.text();
      let data = text;
      if (!options.transformResponse && options.responseType !== 'text') {
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
      }
      return { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
    }
    return {
      async get(url, options = {}) {
        return axiosLike(url, { ...options, method: 'GET' });
      },
      async post(url, body, options = {}) {
        return axiosLike(url, { ...options, method: 'POST', body: JSON.stringify(body) });
      },
      async request(options = {}) {
        return axiosLike(options.url, options);
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  buildCookieHeaderFromSession,
  cookieHeaderToObjects,
  createCfClearanceManager,
  createCookieStateForUrl,
  isToughCookieAvailable,
  joinCookieHeader,
  mergeCookieHeaders,
  normalizeFlareEndpoints,
  parseSetCookiePairs
} = require('../providers/utils/cf_clearance_manager');

function noOpLogger() {
  return { debug() {}, info() {}, warn() {} };
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

test('normalizeFlareEndpoints accepts comma and semicolon CloudflareBypass endpoint lists', () => {
  assert.deepEqual(
    normalizeFlareEndpoints('http://a:8191, http://b:8191/v1; bad-url', ['https://c.example/base/']),
    ['http://a:8191', 'http://b:8191', 'https://c.example/base']
  );
});

test('cookieHeaderToObjects dedupes and converts cookie header for solver payloads', () => {
  assert.deepEqual(cookieHeaderToObjects('a=1; Path=/; b=2; a=3; cf_clearance=ok'), [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
    { name: 'cf_clearance', value: 'ok' }
  ]);
});


test('set-cookie parser merge updates and deletes cookies without leaking attributes', () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const merged = mergeCookieHeaders('a=1; old=gone; cf_clearance=stale', [
    `cf_clearance=fresh; Path=/; Expires=${future}; HttpOnly; Secure; SameSite=None`,
    'old=; Max-Age=0; Path=/',
    'sessionid=abc; Path=/; HttpOnly'
  ]);

  assert.equal(merged.includes('Path='), false);
  assert.equal(merged.includes('HttpOnly'), false);
  assert.equal(merged.includes('old='), false);
  assert.equal(merged.includes('cf_clearance=fresh'), true);
  assert.equal(merged.includes('sessionid=abc'), true);
});

test('parseSetCookiePairs accepts fetch-style getSetCookie containers', () => {
  const parsed = parseSetCookiePairs({
    getSetCookie: () => ['a=1; Path=/', 'b=2; HttpOnly']
  });

  assert.deepEqual(parsed.map(cookie => [cookie.name, cookie.value]), [['a', '1'], ['b', '2']]);
});

test('joinCookieHeader keeps fallback cookie arrays as valid Cookie headers', () => {
  assert.equal(
    joinCookieHeader(['cf_clearance=abc; Path=/; HttpOnly', '__cf_bm=def; Path=/']),
    'cf_clearance=abc; __cf_bm=def'
  );
  assert.equal(
    joinCookieHeader([{ name: 'cf_clearance', value: 'abc' }, { name: '__cf_bm', value: 'def' }]),
    'cf_clearance=abc; __cf_bm=def'
  );
});


test('cookie jar v2 keeps path/domain-aware cookies when tough-cookie is installed', (t) => {
  if (!isToughCookieAvailable()) return t.skip('tough-cookie not installed in this runtime');

  const future = Math.floor((Date.now() + 60_000) / 1000);
  const state = createCookieStateForUrl('https://guardoserie.run/path/page', [
    { name: 'cf_clearance', value: 'clear', domain: 'guardoserie.run', path: '/', expires: future, secure: true },
    { name: 'loadm', value: 'abc', domain: 'guardoserie.run', path: '/path' },
    { name: 'other', value: 'hidden', domain: 'guardoserie.run', path: '/other' }
  ]);

  assert.equal(state.cookieJarVersion, 2);
  assert.equal(state.cf_clearance, 'clear');
  assert.match(state.cookies, /cf_clearance=clear/);
  assert.match(state.cookies, /loadm=abc/);
  assert.doesNotMatch(state.cookies, /other=hidden/);

  const header = buildCookieHeaderFromSession({
    userAgent: 'Mozilla/5.0 UnitTest',
    timestamp: Date.now(),
    url: 'https://guardoserie.run',
    ...state
  }, 'https://guardoserie.run/other/file');

  assert.match(header, /cf_clearance=clear/);
  assert.match(header, /other=hidden/);
  assert.doesNotMatch(header, /loadm=abc/);
});

test('clearance manager fails over CloudflareBypass-compatible endpoints', async (t) => {
  const seenPayloads = [];
  const bad = await listen(async (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', message: 'bad endpoint' }));
  });
  const good = await listen(async (req, res) => {
    if (!req.url.startsWith('/cache/stats')) seenPayloads.push(new URL(req.url, good.url).pathname);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      solution: {
        url: 'https://guardoserie.run/prova/',
        status: 200,
        userAgent: 'Mozilla/5.0 UnitTest',
        cookies: [{ name: 'cf_clearance', value: 'clear' }, { name: 'sessionid', value: 'abc' }]
      }
    }));
  });

  t.after(async () => {
    await bad.close();
    await good.close();
  });

  const manager = createCfClearanceManager({
    providerName: 'unit',
    endpoints: [bad.url, good.url],
    logger: noOpLogger(),
    endpointFailureCooldownMs: 60_000,
    solveTimeoutMs: 12_000
  });

  const session = await manager.solve('https://guardoserie.run/prova/', null, {
    force: true,
    cookies: 'old=1; cf_clearance=stale'
  });

  assert.equal(session.endpoint, good.url);
  assert.equal(session.cf_clearance, 'clear');
  assert.equal(session.userAgent, 'Mozilla/5.0 UnitTest');
  assert.deepEqual(seenPayloads, ['/cookies']);
});

test('clearance manager coalesces concurrent solves with the same shared key', async (t) => {
  let calls = 0;
  const good = await listen(async (req, res) => {
    if (!req.url.startsWith('/cache/stats')) calls += 1;
    await new Promise(resolve => setTimeout(resolve, 80));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      solution: {
        url: 'https://guardoserie.run/',
        status: 200,
        userAgent: 'Mozilla/5.0 SharedUnitTest',
        cookies: [{ name: 'cf_clearance', value: 'shared-clear' }]
      }
    }));
  });

  t.after(async () => {
    await good.close();
  });

  const manager = createCfClearanceManager({
    providerName: 'unit-shared',
    endpoints: [good.url],
    logger: noOpLogger(),
    solveTimeoutMs: 12_000
  });

  const [a, b, c] = await Promise.all([
    manager.solve('https://guardoserie.run/film/a/', null, { force: true, sharedKey: 'guardoserie:https://guardoserie.run' }),
    manager.solve('https://guardoserie.run/episodio/b/', null, { force: true, sharedKey: 'guardoserie:https://guardoserie.run' }),
    manager.solve('https://guardoserie.run/?s=c', null, { force: true, sharedKey: 'guardoserie:https://guardoserie.run' })
  ]);

  assert.equal(calls, 1);
  assert.equal(a.cf_clearance, 'shared-clear');
  assert.equal(b.cf_clearance, 'shared-clear');
  assert.equal(c.cf_clearance, 'shared-clear');
  assert.equal(a, b);
  assert.equal(b, c);
});


test('clearance manager returns null instead of growing an unbounded solve queue', async (t) => {
  let calls = 0;
  const good = await listen(async (req, res) => {
    if (!req.url.startsWith('/cache/stats')) calls += 1;
    await new Promise(resolve => setTimeout(resolve, 120));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      solution: {
        url: 'https://guardoserie.run/',
        status: 200,
        userAgent: 'Mozilla/5.0 QueueUnitTest',
        cookies: [{ name: 'cf_clearance', value: 'queue-clear' }]
      }
    }));
  });

  t.after(async () => {
    await good.close();
  });

  const warnings = [];
  const manager = createCfClearanceManager({
    providerName: 'unit-queue',
    endpoints: [good.url],
    logger: { debug() {}, info() {}, warn(message, meta) { warnings.push({ message, meta }); } },
    solveConcurrency: 1,
    solveMaxQueue: 0,
    solveTimeoutMs: 12_000,
    cooldownMs: 0
  });

  const [first, overflow] = await Promise.all([
    manager.solve('https://guardoserie.run/a/', null, { force: true, sharedKey: 'a' }),
    manager.solve('https://guardoserie.run/b/', null, { force: true, sharedKey: 'b' })
  ]);

  assert.equal(first.cf_clearance, 'queue-clear');
  assert.equal(overflow, null);
  assert.equal(calls, 1);
  assert.equal(warnings.some(entry => entry.meta?.reason === 'queue_overflow'), true);
});

test('clearance manager can keep useful solution HTML for immediate reuse', async (t) => {
  let requestGetPayload = null;
  const html = `<!doctype html><html><head><title>OK</title></head><body>${'valid html '.repeat(40)}</body></html>`;
  const good = await listen(async (req, res) => {
    if (req.url.startsWith('/cache/stats')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: [] }));
      return;
    }
    if (req.url.startsWith('/html') || !requestGetPayload) requestGetPayload = { returnOnlyCookies: !req.url.startsWith('/html') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      solution: {
        url: 'https://guardoserie.run/film/a/',
        status: 200,
        userAgent: 'Mozilla/5.0 HtmlUnitTest',
        cookies: [{ name: 'cf_clearance', value: 'html-clear' }],
        response: html
      }
    }));
  });

  t.after(async () => {
    await good.close();
  });

  const manager = createCfClearanceManager({
    providerName: 'unit-html',
    endpoints: [good.url],
    logger: noOpLogger(),
    solveTimeoutMs: 12_000
  });

  const session = await manager.solve('https://guardoserie.run/film/a/', null, {
    force: true,
    wantResponse: true
  });

  assert.equal(requestGetPayload.returnOnlyCookies, false);
  assert.equal(session.solutionResponse, html);
  assert.equal(session.solutionResponseUrl, 'https://guardoserie.run/film/a/');
});

test('clearance manager caches CloudflareBypass health checks briefly', async (t) => {
  let healthCalls = 0;
  let solveCalls = 0;
  const good = await listen(async (req, res) => {
    const url = new URL(req.url, good.url);
    if (url.pathname === '/cache/stats') {
      healthCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: [] }));
      return;
    }
    solveCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      solution: {
        url: url.searchParams.get('url'),
        status: 200,
        userAgent: 'Mozilla/5.0 HealthUnitTest',
        cookies: [{ name: 'cf_clearance', value: `health-${solveCalls}` }]
      }
    }));
  });

  t.after(async () => {
    await good.close();
  });

  const manager = createCfClearanceManager({
    providerName: 'unit-health',
    endpoints: [good.url],
    logger: noOpLogger(),
    solveTimeoutMs: 12_000,
    cooldownMs: 0,
    healthCacheMs: 10_000
  });

  await manager.solve('https://guardoserie.run/a/', null, { force: true, sharedKey: 'a' });
  await manager.solve('https://guardoserie.run/b/', null, { force: true, sharedKey: 'b' });

  assert.equal(solveCalls, 2);
  assert.equal(healthCalls, 1);
});
