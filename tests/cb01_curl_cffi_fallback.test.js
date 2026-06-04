'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../providers/cb01/cb01_handler');

const {
    fetchViaCbCurlCffi,
    isUsableCbCurlCffiResult,
    __setCurlCffiRunner
} = __private;

const GOOD_SEARCH_HTML = `<html><body><div class="card-content">${'x'.repeat(900)}</div></body></html>`;
const GOOD_PAGE_HTML = `<html><body><div id="iframen1" data-src="https://mixdrop.to/e/abc123">${'x'.repeat(900)}</div></body></html>`;
const BLOCKED_HTML = '<html><title>Just a moment</title><body>checking your browser challenge-platform</body></html>';

test.afterEach(() => {
    __setCurlCffiRunner(null);
    delete process.env.CB01_CURL_CFFI_FALLBACK;
    delete process.env.CURL_CFFI_ENABLED;
});

test('isUsableCbCurlCffiResult accepts usable CB01 html and rejects blocked results', () => {
    assert.equal(isUsableCbCurlCffiResult({ status: 'ok', code: 200, html: GOOD_SEARCH_HTML }), true);
    assert.equal(isUsableCbCurlCffiResult({ status: 'ok', code: 200, html: GOOD_PAGE_HTML }), true);
    assert.equal(isUsableCbCurlCffiResult({ status: 'ok', code: 403, html: GOOD_SEARCH_HTML }), false);
    assert.equal(isUsableCbCurlCffiResult({ status: 'ok', code: 200, html: BLOCKED_HTML, challengeDetected: true }), false);
});

test('fetchViaCbCurlCffi returns html using injected runner and passes fast-fallback options', async () => {
    let received = null;
    __setCurlCffiRunner(async (url, provider, opts) => {
        received = { url, provider, opts };
        return { status: 'ok', code: 200, html: GOOD_PAGE_HTML, profileScore: 0.91, httpVersionMode: 'auto' };
    });

    const result = await fetchViaCbCurlCffi('https://cb01uno.bar/film/demo/', 'https://cb01uno.bar', {
        label: 'page',
        totalBudgetMs: 8000,
        startedAt: Date.now(),
        previousVia: 'impit-forward-only',
        previousStatus: 403,
        previousChallenge: true
    });

    assert.equal(result.text, GOOD_PAGE_HTML);
    assert.equal(result.via, 'curl-cffi-fast-fallback');
    assert.equal(received.provider, 'cb01');
    assert.equal(received.opts.warmupOrigin, false);
    assert.equal(received.opts.retries, 0);
    assert.equal(received.opts.signalsJson.provider, 'cb01');
    assert.equal(received.opts.signalsJson.previousVia, 'impit-forward-only');
});

test('fetchViaCbCurlCffi skips itself when there is not enough remaining budget', async () => {
    let called = false;
    __setCurlCffiRunner(async () => {
        called = true;
        return { status: 'ok', code: 200, html: GOOD_SEARCH_HTML };
    });

    const result = await fetchViaCbCurlCffi('https://cb01uno.bar/?s=demo', 'https://cb01uno.bar', {
        label: 'search',
        totalBudgetMs: 1000,
        startedAt: Date.now() - 200
    });

    assert.equal(result, null);
    assert.equal(called, false);
});
