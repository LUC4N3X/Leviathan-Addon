'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../providers/altadefinizione/ads_handler');

test('AltaDefinizione labels sources by their real extractor name', () => {
    assert.equal(__private.sourceExtractorLabel({ url: 'https://mixdrop.co/e/abc123' }), 'MixDrop');
    assert.equal(__private.sourceExtractorLabel({ provider: 'cdn', url: 'https://cdn.example/master.m3u8' }), 'CDN');
    assert.equal(__private.sourceExtractorLabel({ url: 'https://stream.example/master.m3u8' }), 'CDN');
    assert.equal(__private.sourceExtractorLabel({ provider: 'Foo', url: 'https://foo.example/watch/1' }), 'Foo');
});

test('AltaDefinizione never injects a synthetic VidxGo source', () => {
    assert.equal(typeof __private.buildSyntheticVidxgoUrl, 'undefined');

    const sources = __private.collectPlayableSources({
        payload: {
            sources: [
                { provider: 'cdn', url: 'https://cdn.example/master.m3u8', quality: '1080p' },
                { provider: 'MixDrop', url: 'https://mixdrop.co/e/abc123' }
            ]
        }
    });

    const labels = sources.map((source) => source.extractor);
    assert.ok(labels.includes('CDN'));
    assert.ok(labels.includes('MixDrop'));
    assert.ok(!labels.includes('VidxGo'));
    assert.ok(sources.every((source) => !/vidxgo/i.test(source.url)));
});

test('AltaDefinizione ranks the CDN source ahead of hoster embeds', () => {
    const sources = __private.collectPlayableSources({
        payload: {
            sources: [
                { provider: 'MixDrop', url: 'https://mixdrop.co/e/abc123' },
                { provider: 'cdn', url: 'https://cdn.example/master.m3u8', quality: '1080p' }
            ]
        }
    });

    assert.equal(sources[0].extractor, 'CDN');
});

test('AltaDefinizione maps multi-audio source labels to concrete ITA and ENG flags', () => {
    assert.equal(__private.getSourceLanguageLabel({ language: 'multi audio' }), 'MULTI ITA/ENG');
    assert.equal(__private.getSourceLanguageLabel({ title: 'Film 1080p ITA ENG' }), 'MULTI ITA/ENG');
    assert.deepEqual(__private.audioLanguagesForLabel('MULTI ITA/ENG'), ['ita', 'eng']);
});
