'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { issueHlsTransitKey, resolveTransitKey } = require('../providers/streamingcommunity/stream_transit');

test('proxy tokens preserve url referer and cached headers', () => {
    const token = issueHlsTransitKey('https://cdn.example/master.m3u8', {
        referer: 'https://player.example/embed/123',
        headers: {
            Referer: 'https://player.example/embed/123',
            Origin: 'https://player.example',
            'User-Agent': 'TestAgent/1.0'
        }
    });

    const decoded = resolveTransitKey(token);
    assert.equal(decoded.url, 'https://cdn.example/master.m3u8');
    assert.equal(decoded.referer, 'https://player.example/embed/123');
    assert.equal(decoded.headers.referer, 'https://player.example/embed/123');
    assert.equal(decoded.headers.origin, 'https://player.example');
    assert.equal(decoded.headers['user-agent'], 'TestAgent/1.0');
});
