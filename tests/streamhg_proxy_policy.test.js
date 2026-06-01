'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeToken } = require('../core/proxy/content_proxy_engine');
const {
    proxyStreamHgStream,
    shouldProxyStreamHgStream
} = require('../core/stream/web_stream_proxy');

test('StreamHG web streams are forced through Leviathan content proxy with playback headers', () => {
    const stream = {
        url: 'https://video-cdn.example/master.m3u8',
        title: 'Example StreamHG',
        extractor: 'StreamHG',
        behaviorHints: {
            proxyHeaders: {
                request: {
                    Referer: 'https://dhcplay.com/',
                    Origin: 'https://dhcplay.com',
                    'User-Agent': 'UA'
                }
            }
        }
    };

    assert.equal(shouldProxyStreamHgStream(stream, { baseUrl: 'https://addon.test', rawConf: 'cfg', config: {} }), true);

    const proxied = proxyStreamHgStream(stream, { baseUrl: 'https://addon.test', rawConf: 'cfg', config: {} });
    assert.match(proxied.url, /^https:\/\/addon\.test\/cfg\/levi_proxy\/content\//);
    assert.equal(proxied.behaviorHints.streamhgContentProxy, true);

    const token = decodeURIComponent(new URL(proxied.url).pathname.split('/').pop());
    const decoded = decodeToken(token);
    assert.equal(decoded.url, stream.url);
    assert.equal(decoded.headers.referer, 'https://dhcplay.com/');
    assert.equal(decoded.headers.origin, 'https://dhcplay.com');
    assert.equal(decoded.headers['user-agent'], 'UA');
});


test('StreamHG HLS prefers MediaFlow/Kraken HLS proxy when configured', () => {
    const stream = {
        url: 'https://video-cdn.example/master.m3u8',
        extractor: 'StreamHG',
        behaviorHints: {
            proxyHeaders: {
                request: {
                    Referer: 'https://vibuxer.com/',
                    Origin: 'https://vibuxer.com'
                }
            }
        }
    };

    const proxied = proxyStreamHgStream(stream, {
        baseUrl: 'https://addon.test',
        rawConf: 'cfg',
        config: { mediaflow: { url: 'https://mfp.example', pass: 'secret' } }
    });

    assert.match(proxied.url, /^https:\/\/mfp\.example\/proxy\/hls\/manifest\.m3u8\?/);
    assert.match(proxied.url, /h_referer=/);
    assert.equal(proxied.behaviorHints.streamhgProxyMode, 'mediaflow');
});

test('StreamHG proxy policy does not proxy lazy or non-StreamHG streams', () => {
    const context = { baseUrl: 'https://addon.test', rawConf: 'cfg', config: {} };
    const lazy = { url: 'https://addon.test/lazy_extract/token', extractor: 'StreamHG' };
    const other = { url: 'https://video-cdn.example/master.m3u8', extractor: 'LoadM' };

    assert.equal(proxyStreamHgStream(lazy, context), lazy);
    assert.equal(proxyStreamHgStream(other, context), other);
});
