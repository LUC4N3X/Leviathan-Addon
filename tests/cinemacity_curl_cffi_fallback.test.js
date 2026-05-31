'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../providers/cinemacity/cc_handler');

const {
    isUsableCinemaCityHtml,
    isUsableCurlCffiResult,
    isCurlCffiFallbackEnabled,
    fetchViaCurlCffi,
    fetchCinemaCityHtml,
    __setCurlCffiRunner
} = __private;

const GOOD_HTML = `<html><head><title>Movie</title></head><body>${'x'.repeat(800)} tt0111161</body></html>`;
const BLOCKED_HTML = '<html><body>Just a moment...</body></html>';

const originalFetch = globalThis.fetch;

function stubWorker(behaviour) {
    // behaviour: { throw?:bool, ok?:bool, status?:number, body?:string }
    globalThis.fetch = async () => {
        if (behaviour.throw) throw new Error('network down');
        return {
            ok: behaviour.ok !== false,
            status: behaviour.status || 200,
            headers: { get: () => null },
            text: async () => behaviour.body ?? GOOD_HTML
        };
    };
}

function okCurlResult(html = GOOD_HTML, extra = {}) {
    return { status: 'ok', code: 200, html, ...extra };
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    __setCurlCffiRunner(null);
    delete process.env.CC_CURL_CFFI_FALLBACK;
    delete process.env.CURL_CFFI_ENABLED;
});

test('isUsableCinemaCityHtml accepts a real page and rejects blocked/empty', () => {
    assert.equal(isUsableCinemaCityHtml(GOOD_HTML), true);
    assert.equal(isUsableCinemaCityHtml(BLOCKED_HTML), false);
    assert.equal(isUsableCinemaCityHtml('short'), false);
    assert.equal(isUsableCinemaCityHtml(`${'a'.repeat(600)} admin Unlimited`), false);
});

test('isUsableCurlCffiResult validates status, code and challenge flag', () => {
    assert.equal(isUsableCurlCffiResult(okCurlResult()), true);
    assert.equal(isUsableCurlCffiResult({ status: 'error', html: GOOD_HTML }), false);
    assert.equal(isUsableCurlCffiResult(okCurlResult(GOOD_HTML, { code: 403 })), false);
    assert.equal(isUsableCurlCffiResult(okCurlResult(GOOD_HTML, { challengeDetected: true })), false);
    assert.equal(isUsableCurlCffiResult(okCurlResult(BLOCKED_HTML)), false);
});

test('isCurlCffiFallbackEnabled honours local and global kill switches', () => {
    assert.equal(isCurlCffiFallbackEnabled(), true);
    process.env.CC_CURL_CFFI_FALLBACK = '0';
    assert.equal(isCurlCffiFallbackEnabled(), false);
    delete process.env.CC_CURL_CFFI_FALLBACK;
    process.env.CURL_CFFI_ENABLED = 'false';
    assert.equal(isCurlCffiFallbackEnabled(), false);
});

test('fetchViaCurlCffi returns html from an injected runner', async () => {
    let received = null;
    __setCurlCffiRunner(async (url, provider, opts) => {
        received = { url, provider, opts };
        return okCurlResult();
    });
    const html = await fetchViaCurlCffi('https://cinemacity.cc/movies/1-x-1994.html');
    assert.equal(html, GOOD_HTML);
    assert.equal(received.provider, 'cinemacity');
    assert.match(received.url, /cinemacity\.cc/);
});

test('fetchViaCurlCffi throws when no runner is available', async () => {
    __setCurlCffiRunner(null);
    await assert.rejects(() => fetchViaCurlCffi('https://cinemacity.cc/movies/1-x.html'), /curl_cffi_unavailable/);
});

test('fetchViaCurlCffi throws on an unusable (challenge) result', async () => {
    __setCurlCffiRunner(async () => okCurlResult(GOOD_HTML, { challengeDetected: true }));
    await assert.rejects(() => fetchViaCurlCffi('https://cinemacity.cc/movies/1-x.html'), /curl_cffi_unusable/);
});

test('fetchViaCurlCffi is a no-op when disabled by env even with a runner present', async () => {
    process.env.CC_CURL_CFFI_FALLBACK = '0';
    __setCurlCffiRunner(async () => okCurlResult());
    await assert.rejects(() => fetchViaCurlCffi('https://cinemacity.cc/movies/1-x.html'), /curl_cffi_unavailable/);
});

test('fetchCinemaCityHtml returns the worker page without invoking curl_cffi when healthy', async () => {
    stubWorker({ ok: true, body: GOOD_HTML });
    let runnerCalled = false;
    __setCurlCffiRunner(async () => { runnerCalled = true; return okCurlResult(); });

    const html = await fetchCinemaCityHtml('https://cinemacity.cc/movies/1-x.html');
    assert.equal(html, GOOD_HTML);
    assert.equal(runnerCalled, false, 'curl_cffi must not run when the worker is healthy');
});

test('fetchCinemaCityHtml falls back to curl_cffi when the worker returns a blocked page', async () => {
    stubWorker({ ok: true, body: BLOCKED_HTML });
    const curlHtml = `<html>${'y'.repeat(900)} tt7777777</html>`;
    __setCurlCffiRunner(async () => okCurlResult(curlHtml));

    const html = await fetchCinemaCityHtml('https://cinemacity.cc/movies/1-x.html');
    assert.equal(html, curlHtml);
});

test('fetchCinemaCityHtml falls back to curl_cffi when the worker throws', async () => {
    stubWorker({ throw: true });
    __setCurlCffiRunner(async () => okCurlResult());

    const html = await fetchCinemaCityHtml('https://cinemacity.cc/movies/1-x.html');
    assert.equal(html, GOOD_HTML);
});

test('fetchCinemaCityHtml returns the worker page when curl_cffi also fails (preserves existing handling)', async () => {
    stubWorker({ ok: true, body: BLOCKED_HTML });
    __setCurlCffiRunner(async () => { throw new Error('curl boom'); });

    const html = await fetchCinemaCityHtml('https://cinemacity.cc/movies/1-x.html');
    assert.equal(html, BLOCKED_HTML, 'blocked worker html is handed back so caller checks still apply');
});

test('fetchCinemaCityHtml rethrows the worker error when worker throws and curl_cffi is unavailable', async () => {
    stubWorker({ throw: true });
    __setCurlCffiRunner(null);
    await assert.rejects(() => fetchCinemaCityHtml('https://cinemacity.cc/movies/1-x.html'), /network down/);
});
