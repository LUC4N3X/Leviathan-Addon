'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeUprotInput,
    resolveUprotToMaxstream,
    toMaxstreamPlayerUrl,
    _test: uprotTest
} = require('../providers/extractors/hosters/uprot');

test('uprot helpers normalize escaped inputs and watchfree player URLs', () => {
    assert.equal(
        normalizeUprotInput('https:\\/\\/uprot.net\\/msf\\/abc123?token=one&amp;x=2'),
        'https://uprot.net/mse/abc123?token=one&x=2'
    );
    assert.equal(
        normalizeUprotInput('https://uprot.net/MSF/UpperCase'),
        'https://uprot.net/mse/UpperCase'
    );
    assert.equal(
        toMaxstreamPlayerUrl('https://watchfree.example/watchfree/title/abc123'),
        'https://maxstream.video/emvvv/abc123'
    );
    assert.equal(
        uprotTest.extractContinueLink('<a class="btn" href="/go/next">C o n t i n u e</a>', 'https://uprot.net/mse/abc'),
        'https://uprot.net/go/next'
    );
});

test('uprot state parser accepts env, cookie header and python-style file values without leaking secrets', () => {
    const fromState = uprotTest.loadUprotState({
        uprotState: "{'cookies': {'xfss': 'cookie-secret'}, 'captchaData': {'captcha': '12345'}}"
    });
    assert.deepEqual(fromState.cookies, { xfss: 'cookie-secret' });
    assert.deepEqual(fromState.captchaData, { captcha: '12345' });

    const fromHeader = uprotTest.loadUprotState({
        uprotCookies: 'xfss=cookie-secret; session=abc',
        uprotCaptchaData: 'captcha=12345&token=form-secret'
    });
    assert.equal(uprotTest.cookieHeaderFromState(fromHeader.cookies), 'xfss=cookie-secret; session=abc');
    assert.equal(uprotTest.buildFormBody(fromHeader.captchaData), 'captcha=12345&token=form-secret');
});

test('uprot resolver follows landing continue links to MaxStream with injected client', async () => {
    const calls = [];
    const client = {
        async get(url) {
            calls.push(['get', url]);
            if (url.includes('/mse/abc')) {
                return {
                    status: 200,
                    data: '<a href="/redirect/abc">Continue</a>',
                    request: { res: { responseUrl: url } }
                };
            }
            return {
                status: 302,
                data: '',
                request: { res: { responseUrl: 'https://watchfree.example/watchfree/movie/abc' } }
            };
        },
        async head(url) {
            calls.push(['head', url]);
            return {
                status: 302,
                request: { res: { responseUrl: 'https://watchfree.example/watchfree/movie/abc' } }
            };
        }
    };

    const resolved = await resolveUprotToMaxstream(client, 'https://uprot.net/msf/abc', {
        uprotFlareEnabled: false
    });

    assert.equal(resolved.playerUrl, 'https://maxstream.video/emvvv/abc');
    assert.equal(resolved.sourceUrl, 'https://uprot.net/mse/abc');
    assert.equal(resolved.via, 'uprot-landing');
    assert.deepEqual(calls.map((entry) => entry[0]), ['get', 'head']);
});

test('uprot resolver posts stored state and resolves redirect final URL', async () => {
    const posts = [];
    const client = {
        async get() {
            return { status: 403, data: 'blocked' };
        },
        async post(url, body, options) {
            posts.push({ url, body, headers: options.headers });
            return {
                status: 200,
                data: '',
                request: { res: { responseUrl: 'https://watchfree.example/watchfree/movie/stateid' } }
            };
        }
    };

    const resolved = await resolveUprotToMaxstream(client, 'https://uprot.net/msf/stateid', {
        uprotCookies: { xfss: 'cookie-secret' },
        uprotCaptchaData: { captcha: '12345' },
        uprotFlareEnabled: false
    });

    assert.equal(resolved.playerUrl, 'https://maxstream.video/emvvv/stateid');
    assert.equal(resolved.via, 'uprot-msfi-redirect');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://uprot.net/msf/stateid');
    assert.equal(posts[0].body, 'captcha=12345');
    assert.equal(posts[0].headers.Cookie, 'xfss=cookie-secret');
});

test('uprot resolver extracts escaped direct stream URLs from landing scripts', async () => {
    const client = {
        async get(url) {
            assert.equal(url, 'https://uprot.net/mse/direct');
            return {
                status: 200,
                data: 'var player = { file: "https:\\/\\/cdn.example\\/hls\\/master.m3u8?token=abc" };',
                request: { res: { responseUrl: url } }
            };
        }
    };

    const resolved = await resolveUprotToMaxstream(client, 'https://uprot.net/msf/direct', {
        uprotFlareEnabled: false
    });

    assert.equal(resolved.streamUrl, 'https://cdn.example/hls/master.m3u8?token=abc');
    assert.equal(resolved.playerUrl, 'https://uprot.net/mse/direct');
    assert.equal(resolved.via, 'uprot-direct');
});

test('uprot resolver follows javascript location redirects to watchfree players', async () => {
    const client = {
        async get(url) {
            assert.equal(url, 'https://uprot.net/mse/jsid');
            return {
                status: 200,
                data: '<script>window.location.href = "/watchfree/movie/jsid";</script>',
                request: { res: { responseUrl: url } }
            };
        }
    };

    const resolved = await resolveUprotToMaxstream(client, 'https://uprot.net/msf/jsid', {
        uprotFlareEnabled: false
    });

    assert.equal(resolved.playerUrl, 'https://maxstream.video/emvvv/jsid');
    assert.equal(resolved.via, 'uprot-landing');
});
