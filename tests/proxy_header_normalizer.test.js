'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isAlreadyProxiedUrl,
    normalizeProxyHeaders,
    prepareProxyTarget,
    proxyHeaderLogLine,
    shouldProxyUrl
} = require('../core/lib/proxy_header_normalizer');

test('proxy header normalizer dedupes common playback headers', () => {
    const result = normalizeProxyHeaders({
        referer: 'https://player.example/embed/1',
        Referrer: 'https://player.example/embed/2',
        origin: 'https://player.example/path',
        'user-agent': 'Agent/1.0',
        range: 'bytes=10-20',
        Host: 'bad.example',
        Connection: 'keep-alive'
    }, {
        targetUrl: 'https://cdn.example/video.m3u8',
        allowRange: true
    });

    assert.equal(result.headers.Referer, 'https://player.example/embed/2');
    assert.equal(result.headers.Origin, 'https://player.example');
    assert.equal(result.headers['User-Agent'], 'Agent/1.0');
    assert.equal(result.headers.Range, 'bytes=10-20');
    assert.equal(result.headers.Host, undefined);
    assert.equal(result.headers.Connection, undefined);
    assert.ok(result.duplicated.includes('Referer'));
    assert.ok(result.dropped.includes('host'));
});

test('proxy header normalizer moves basic auth from url to Authorization header', () => {
    const result = prepareProxyTarget('https://user:pass@cdn.example/file.mp4', {
        referer: 'https://player.example/embed/1'
    });

    assert.equal(result.url, 'https://cdn.example/file.mp4');
    assert.equal(result.basicAuthMoved, true);
    assert.equal(result.headers.Authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
    assert.equal(result.headers.Referer, 'https://player.example/embed/1');
    assert.equal(result.shouldProxy, true);
});

test('proxy header normalizer drops invalid header names and control values', () => {
    const result = normalizeProxyHeaders({
        'X-Good-Header': 'ok',
        'Bad\r\nHeader': 'evil',
        'Also:Bad': 'evil',
        Referer: 'https://player.example/embed/1\r\nX-Bad: evil'
    }, {
        targetUrl: 'https://cdn.example/video.m3u8',
        fillReferer: false
    });

    assert.equal(result.headers['X-Good-Header'], 'ok');
    assert.equal(result.headers['Bad\r\nHeader'], undefined);
    assert.equal(result.headers['Also:Bad'], undefined);
    assert.equal(result.headers.Referer, undefined);
    assert.ok(result.dropped.includes('bad\r\nheader'));
    assert.ok(result.dropped.includes('also:bad'));
    assert.ok(result.dropped.includes('referer'));
});

test('proxy header normalizer skips already proxied urls', () => {
    const url = 'https://leviathan.example/ccproxy/stream?d=token';
    const decision = shouldProxyUrl(url, { addonBase: 'https://leviathan.example' });

    assert.equal(isAlreadyProxiedUrl(url, { addonBase: 'https://leviathan.example' }), true);
    assert.equal(decision.proxy, false);
    assert.equal(decision.reason, 'already_proxied');

    const prepared = prepareProxyTarget(url, {}, { addonBase: 'https://leviathan.example' });
    assert.equal(prepared.shouldProxy, false);
    assert.match(proxyHeaderLogLine(prepared, url, '[PROXY] skip'), /reason=already_proxied/);
});

test('buildWebStream applies proxy header normalization to provider web streams', () => {
    const { buildWebStream } = require('../providers/extractors/common');
    const stream = buildWebStream({
        name: 'Leviathan Web',
        title: 'Example',
        url: 'https://user:pass@cdn.example/master.m3u8',
        extractor: 'TestHoster',
        provider: 'TestProvider',
        headers: {
            referer: 'https://player.example/embed/1',
            origin: 'https://player.example/path',
            Range: 'bad-range'
        }
    });

    assert.equal(stream.url, 'https://cdn.example/master.m3u8');
    assert.equal(stream.behaviorHints.proxyHeaders.request.Referer, 'https://player.example/embed/1');
    assert.equal(stream.behaviorHints.proxyHeaders.request.Origin, 'https://player.example');
    assert.equal(stream.behaviorHints.proxyHeaders.request.Authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
    assert.equal(stream.behaviorHints.proxyHeaders.request.Range, undefined);
    assert.equal(stream.behaviorHints.proxyHeaderNormalizer.basicAuthMoved, true);
});
