'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeProxyToken, makeProxyToken } = require('../providers/streamingcommunity/proxy_tokens');

test('proxy tokens preserve url referer and cached headers', () => {
    const token = makeProxyToken('https://cdn.example/master.m3u8', {
        referer: 'https://player.example/embed/123',
        headers: {
            Referer: 'https://player.example/embed/123',
            Origin: 'https://player.example',
            'User-Agent': 'TestAgent/1.0'
        }
    });

    const decoded = decodeProxyToken(token);
    assert.equal(decoded.url, 'https://cdn.example/master.m3u8');
    assert.equal(decoded.referer, 'https://player.example/embed/123');
    assert.equal(decoded.headers.Referer, 'https://player.example/embed/123');
    assert.equal(decoded.headers.Origin, 'https://player.example');
    assert.equal(decoded.headers['User-Agent'], 'TestAgent/1.0');
});
