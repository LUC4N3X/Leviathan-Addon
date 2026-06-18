'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildMediaflowUrl,
    buildWebStream,
    dedupeStreamsByUrl,
    detectStreamQuality,
    extractPlaylistQuality,
    normalizeRemoteUrl
} = require('../providers/extractors/common');
const { resolveExtractorDefinition, isBridgeResolverCandidate } = require('../providers/extractors/registry');
const { extractBridgeTarget } = require('../providers/extractors/bridge_resolver');
const { getWebProviderDefinition, getWebProviderIcon } = require('../providers/extractors/provider_registry');
const { createWebProviderTools } = require('../core/stream/web_providers');
const { buildExtractorUrl, buildProxyUrl, defaultExtractorPath } = require('../core/proxy/mediaflow_gateway');

test('normalizeRemoteUrl resolves protocol-relative and relative URLs', () => {
    assert.equal(normalizeRemoteUrl('//mixdrop.co/e/abc'), 'https://mixdrop.co/e/abc');
    assert.equal(normalizeRemoteUrl('/watch?id=1', 'https://example.com/player'), 'https://example.com/watch?id=1');
    assert.equal(normalizeRemoteUrl('javascript:void(0)'), null);
});

test('detectStreamQuality recognizes common web qualities', () => {
    assert.equal(detectStreamQuality('Movie.2160p.WEB-DL'), '4K');
    assert.equal(detectStreamQuality('Movie 1080p FHD'), '1080p');
    assert.equal(detectStreamQuality('Movie 720p HD'), '720p');
    assert.equal(detectStreamQuality('Movie 480p SD'), '480p');
});

test('resolveExtractorDefinition recognizes supported hosters', () => {
    assert.equal(resolveExtractorDefinition('https://loadm.xyz/e/123').key, 'loadm');
    assert.equal(resolveExtractorDefinition('https://mixdrop.co/e/abc').key, 'mixdrop');
    assert.equal(resolveExtractorDefinition('https://mixdrop.bz/e/abc').key, 'mixdrop');
    assert.equal(resolveExtractorDefinition('https://md3b0.example/e/abc').key, 'mixdrop');
    assert.equal(resolveExtractorDefinition('https://supervideo.tv/e/xyz').key, 'supervideo');
    assert.equal(resolveExtractorDefinition('https://vixcloud.co/embed/xyz').key, 'vixcloud');
    assert.equal(resolveExtractorDefinition('https://streamtape.com/e/xyz').key, 'streamtape');
    assert.equal(resolveExtractorDefinition('https://vidoza.net/embed-xyz').key, 'vidoza');
    assert.equal(resolveExtractorDefinition('https://example.com/player'), null);
});


test('bridge resolver extracts safe redirect candidates before hoster matching', () => {
    const html = '<script>window.location.replace("https://mixdrop.bz/e/abc123")</script>';
    assert.equal(isBridgeResolverCandidate('https://mysync.mov/stream/abc'), true);
    assert.equal(extractBridgeTarget(html, 'https://mysync.mov/stream/abc'), 'https://mixdrop.bz/e/abc123');
});

test('extractPlaylistQuality infers the highest advertised rendition', () => {
    const playlist = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720',
        '720p/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1920x1080',
        '1080p/index.m3u8'
    ].join('\n');

    assert.equal(extractPlaylistQuality(playlist), '1080p');
});

test('buildWebStream stamps consistent provider metadata', () => {
    const stream = buildWebStream({
        name: '🍿 GuardoSerie | LoadM',
        title: 'Show S01E01\n☁️ LoadM • 🇮🇹 ITA',
        url: 'https://cdn.example.com/master.m3u8',
        extractor: 'LoadM',
        provider: 'GuardoSerie',
        providerCode: 'GS',
        quality: '1080p',
        headers: {
            Referer: 'https://loadm.example/',
            Origin: 'https://loadm.example'
        }
    });

    assert.equal(stream.extractor, 'LoadM');
    assert.equal(stream.provider, 'GuardoSerie');
    assert.equal(stream.behaviorHints.extractor, 'LoadM');
    assert.equal(stream.behaviorHints.vortexMeta.providerCode, 'GS');
    assert.equal(stream.behaviorHints.proxyHeaders.request.Referer, 'https://loadm.example/');
});

test('buildMediaflowUrl builds extractor and hls targets', () => {
    const config = {
        mediaflow: {
            url: 'https://mfp.example/',
            pass: 'secret'
        }
    };

    assert.equal(
        buildMediaflowUrl(config, 'https://mixdrop.co/e/abc', 'extractor', 'Mixdrop'),
        'https://mfp.example/extractor/video?host=Mixdrop&api_password=secret&d=https%3A%2F%2Fmixdrop.co%2Fe%2Fabc&redirect_stream=true'
    );
    assert.equal(
        buildMediaflowUrl(config, 'https://cdn.example/master.m3u8', 'hls'),
        'https://mfp.example/hls?url=https%3A%2F%2Fcdn.example%2Fmaster.m3u8&api_password=secret&ext=.m3u8'
    );
});



test('mediaflow gateway keeps explicit MaxStream extractor path and lowercase proxy headers', () => {
    const config = { mediaflow: { url: 'https://mfp.example', pass: 'secret' } };

    assert.equal(defaultExtractorPath('Maxstream'), '/extractor/video.m3u8');
    assert.equal(defaultExtractorPath('Maxstream', { extractorPath: '/extractor/video.m3u8' }), '/extractor/video.m3u8');
    assert.equal(
        buildExtractorUrl(config, 'https://uprot.net/msf/abc', 'Maxstream', {
            extractorPath: '/extractor/video.m3u8',
            headers: { Referer: 'https://uprot.net/', Origin: 'https://uprot.net', 'User-Agent': 'UA' }
        }),
        'https://mfp.example/extractor/video.m3u8?host=Maxstream&api_password=secret&d=https%3A%2F%2Fuprot.net%2Fmsf%2Fabc&redirect_stream=true&h_referer=https%3A%2F%2Fuprot.net%2F&h_origin=https%3A%2F%2Fuprot.net&h_user-agent=UA'
    );

    const proxy = buildProxyUrl(config, 'https://cdn.example/master.m3u8', {
        Referer: 'https://player.example/',
        Origin: 'https://player.example',
        'User-Agent': 'UA'
    }, { isHls: true });
    assert.match(proxy, /h_referer=/);
    assert.match(proxy, /h_origin=/);
    assert.match(proxy, /h_user-agent=/);
    assert.doesNotMatch(proxy, /h_Referer=/);
});

test('dedupeStreamsByUrl keeps the first stream for duplicate URLs', () => {
    const output = dedupeStreamsByUrl([
        { url: 'https://video.example/a.m3u8', name: 'first' },
        { url: 'https://video.example/a.m3u8', name: 'second' },
        { url: 'https://video.example/b.m3u8', name: 'third' }
    ]);

    assert.equal(output.length, 2);
    assert.equal(output[0].name, 'first');
    assert.equal(output[1].name, 'third');
});







test('provider registry exposes CB01 metadata', () => {
    const cb01 = getWebProviderDefinition('CB01');

    assert.equal(cb01?.key, 'cb01');
    assert.equal(cb01?.limiterKey, 'webCb01');
    assert.equal(getWebProviderIcon('CB01'), '🎬');
});

test('web formatter expands legacy multi audio markers to concrete ITA and ENG flags', () => {
    const tools = createWebProviderTools({
        Cache: {},
        LIMITERS: {},
        CONFIG: { TIMEOUTS: { SCRAPER: 0 } },
        guardedProviderCall: async () => []
    });

    const formatted = tools.formatWebProviderBuckets({
        guardaFlix: [{
            name: '🎬 GuardaFlix | MixDrop',
            title: 'The Rip\nMixDrop MULTI',
            url: 'https://example.com/master.m3u8',
            quality: '1080p',
            extractor: 'MixDrop',
            behaviorHints: {
                extractor: 'MixDrop',
                vortexMeta: {
                    quality: '1080p',
                    extractor: 'MixDrop',
                    provider: 'GuardaFlix',
                    language: 'MULTI',
                    audioLanguages: ['multi']
                }
            }
        }]
    }, { title: 'The Rip', type: 'movie' }, { formatter: 'leviathan', filters: {} });

    assert.equal(formatted.guardaFlix.length, 1);
    assert.match(formatted.guardaFlix[0].name, /🇮🇹\/🇬🇧/);
    assert.match(formatted.guardaFlix[0].title, /🗣️ 🇮🇹\/🇬🇧 \|/);
    assert.equal(formatted.guardaFlix[0].behaviorHints.vortexMeta.language, 'MULTI ITA/ENG');
});
