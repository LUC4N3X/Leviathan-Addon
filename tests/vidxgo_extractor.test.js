'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractVidxgo, extractVidxgoStreamUrl, isVidxgoUrl } = require('../providers/extractors/hosters/vidxgo');
const { resolveExtractorDefinition } = require('../providers/extractors/registry');

function xorBase64(text, key) {
    const input = Buffer.from(String(text), 'utf8');
    const out = Buffer.allocUnsafe(input.length);
    for (let i = 0; i < input.length; i += 1) {
        out[i] = input[i] ^ key.charCodeAt(i % key.length);
    }
    return out.toString('base64');
}

test('vidxgo matcher recognizes canonical player hosts', () => {
    assert.equal(isVidxgoUrl('https://v.vidxgo.co/e/abc123'), true);
    assert.equal(isVidxgoUrl('https://vidxgo.co/embed/abc123'), true);
    assert.equal(isVidxgoUrl('https://example.com/e/abc123'), false);
});

test('extractor registry resolves VidxGo with top priority', () => {
    const def = resolveExtractorDefinition('https://v.vidxgo.co/e/abc123');
    assert.equal(def.key, 'vidxgo');
    assert.equal(def.label, 'VidxGo');
    assert.equal(def.priority, 0);
});

test('vidxgo extractor decodes xor/atob payload and returns playable stream headers', async () => {
    const key = 'leviathan';
    const streamUrl = 'https://cdn.vidxgo.example/hls/master.m3u8';
    const decodedPayload = `const player = { currentSrc: "${streamUrl}" };`;
    const html = `<html><script>var secret='${key}', d=atob('${xorBase64(decodedPayload, key)}');</script></html>`;

    const client = {
        get: async (url) => {
            if (String(url).includes('/hls/')) {
                return {
                    status: 200,
                    data: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n1080p.m3u8'
                };
            }
            return { status: 200, data: html };
        }
    };

    const result = await extractVidxgo('https://v.vidxgo.co/e/abc123', { client });

    assert.equal(result.url, streamUrl);
    assert.equal(result.extractor, 'VidxGo');
    assert.equal(result.quality, '1080p');
    assert.equal(result.priority, 0);
    assert.equal(result.headers.Referer, 'https://v.vidxgo.co/e/abc123');
});


test('vidxgo parser recognizes plain base64 payloads with m3u8 urls', () => {
    const streamUrl = 'https://cdn.vidxgo.example/playlist/master.m3u8?token=abc';
    const encoded = Buffer.from(JSON.stringify({ stream_url: streamUrl }), 'utf8').toString('base64');
    const html = `<script>const p = atob('${encoded}');</script>`;
    assert.equal(extractVidxgoStreamUrl(html, 'https://v.vidxgo.co/e/abc123'), streamUrl);
});
