'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSupervideoCandidates, extractSupervideo, extractStreamUrl } = require('../providers/extractors/hosters/supervideo');

test('SuperVideo keeps /v/ candidate before trying embed variants', () => {
    const candidates = buildSupervideoCandidates('https://supervideo.cc/v/znoks5rvmltv');

    assert.equal(candidates[0], 'https://supervideo.cc/v/znoks5rvmltv');
    assert.ok(candidates.includes('https://supervideo.cc/e/znoks5rvmltv'));
});

test('SuperVideo extracts escaped m3u8 sources', () => {
    const html = `eval(function(p,a,c,k,e,d){return p}('x',1,1,'x'.split('|'),0,{})); var player = { file: "https:\\/\\/cdn.supervideo.cc\\/hls\\/master.m3u8?token=1" };`;

    assert.equal(extractStreamUrl(html, 'https://supervideo.cc/v/abc'), 'https://cdn.supervideo.cc/hls/master.m3u8?token=1');
});

test('SuperVideo extractor tries original /v/ URL and returns playable stream', async () => {
    const calls = [];
    const client = {
        get: async (url) => {
            calls.push(url);
            if (url === 'https://supervideo.cc/v/abc') {
                return {
                    status: 200,
                    data: 'jwplayer("v").setup({sources:[{file:"https://cdn.supervideo.cc/master.m3u8"}]});'
                };
            }
            return { status: 404, data: '' };
        }
    };

    const result = await extractSupervideo('https://supervideo.cc/v/abc', { client, requestReferer: 'https://guardaserietv.rest/demo.html' });

    assert.equal(calls[0], 'https://supervideo.cc/v/abc');
    assert.equal(result.url, 'https://cdn.supervideo.cc/master.m3u8');
    assert.equal(result.extractor, 'SuperVideo');
});
