'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeUprotInput,
    resolveUprotToMaxstream,
    fetchWithFlareSolverr,
    toMaxstreamPlayerUrl,
    _test: uprotTest
} = require('../providers/extractors/hosters/uprot');

function withEnvironment(values, fn) {
    const previous = {};
    for (const [name, value] of Object.entries(values)) {
        previous[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    try {
        return fn();
    } finally {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

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
        toMaxstreamPlayerUrl('https://maxstream.video/emhuih/abc123'),
        'https://maxstream.video/emhuih/abc123'
    );
    // /uprotem/ is a maxstream-hosted captcha mirror, not a playable embed.
    // Accepting it as a player URL short-circuits the uprot captcha solver.
    assert.equal(
        toMaxstreamPlayerUrl('https://maxstream.video/uprotem/dTVZK1VSNWZVWmpOL1dIVlhpdG5LUT09'),
        null
    );
    assert.equal(
        toMaxstreamPlayerUrl('https://maxstream.video/'),
        null
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
        uprotFlareEnabled: false,
        uprotForwardProxy: 'false'
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
        uprotFlareEnabled: false,
        uprotForwardProxy: 'false'
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
        uprotFlareEnabled: false,
        uprotForwardProxy: 'false'
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
        uprotFlareEnabled: false,
        uprotForwardProxy: 'false'
    });

    assert.equal(resolved.playerUrl, 'https://maxstream.video/emvvv/jsid');
    assert.equal(resolved.via, 'uprot-landing');
});

test('fetchWithFlareSolverr wraps uprot URLs in the configured forward proxy', async () => {
    const seen = [];
    const flareClient = {
        async post(endpoint, payload) {
            seen.push({ endpoint, url: payload.url });
            return {
                status: 200,
                data: {
                    status: 'ok',
                    solution: { response: '<html></html>', url: payload.url, cookies: [] }
                }
            };
        }
    };

    const result = await fetchWithFlareSolverr('https://uprot.net/e/abc123/', {
        uprotFlareEnabled: true,
        uprotFlareEndpoint: 'http://flaresolverr.local:8191/v1',
        uprotForwardProxy: 'https://krakenproxy.example/forward?url=',
        flareClient
    });

    assert.ok(result, 'expected a FlareSolverr response');
    assert.equal(seen.length, 1, 'flare client should be called once');
    assert.equal(
        seen[0].url,
        'https://krakenproxy.example/forward?url=https%3A%2F%2Fuprot.net%2Fe%2Fabc123%2F',
        'FlareSolverr must receive the proxy-wrapped URL so its egress IP is masked'
    );
});

test('uprot reads the shared FORWARD_PROXY env without embedded fallback', () => {
    withEnvironment({
        FORWARD_PROXY: 'https://proxy.example/forward?url=',
        UPROT_FORWARD_PROXY: 'https://legacy.example/forward?url=',
        FORWARDPROXY: 'https://legacy-alias.example/forward?url='
    }, () => {
        assert.equal(
            uprotTest.buildUprotForwardRequestUrl('https://uprot.net/e/abc123/'),
            'https://proxy.example/forward?url=https%3A%2F%2Fuprot.net%2Fe%2Fabc123%2F'
        );
    });
});

test('uprot reports a configuration error when shared FORWARD_PROXY is missing', () => {
    withEnvironment({
        FORWARD_PROXY: undefined,
        UPROT_FORWARD_PROXY: undefined,
        FORWARDPROXY: undefined,
        CB01_FORWARD_PROXY: undefined
    }, () => {
        assert.throws(
            () => uprotTest.buildUprotForwardRequestUrl('https://uprot.net/e/abc123/'),
            (error) => error.code === 'FORWARD_PROXY_CONFIG_ERROR'
        );
    });
});
