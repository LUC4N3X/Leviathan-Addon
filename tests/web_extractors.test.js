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
const { resolveExtractorDefinition } = require('../providers/extractors/registry');
const { getWebProviderDefinition, getWebProviderIcon } = require('../providers/extractors/provider_registry');
const { createWebProviderTools } = require('../core/stream/web_providers');

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
    assert.equal(resolveExtractorDefinition('https://supervideo.tv/e/xyz').key, 'supervideo');
    assert.equal(resolveExtractorDefinition('https://vixcloud.co/embed/xyz').key, 'vixcloud');
    assert.equal(resolveExtractorDefinition('https://streamtape.com/e/xyz').key, 'streamtape');
    assert.equal(resolveExtractorDefinition('https://vidoza.net/embed-xyz').key, 'vidoza');
    assert.equal(resolveExtractorDefinition('https://example.com/player'), null);
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

test('provider registry exposes CinemaCity metadata', () => {
    const definition = getWebProviderDefinition('CinemaCity');

    assert.equal(definition?.key, 'cinemaCity');
    assert.equal(definition?.limiterKey, 'webCc');
    assert.equal(getWebProviderIcon('CinemaCity'), '🏙️');
});

test('fetchWebProviderBuckets does not crash when CinemaCity limiter is missing', async () => {
    const calls = [];
    const tools = createWebProviderTools({
        Cache: {
            fetchWithCache: async (_name, _key, _ttl, factory) => factory()
        },
        LIMITERS: {},
        CONFIG: { TIMEOUTS: { SCRAPER: 1 } },
        guardedProviderCall: async (providerName, limiter) => {
            calls.push({ providerName, hasLimiter: Boolean(limiter && typeof limiter.schedule === 'function') });
            await limiter.schedule(() => Promise.resolve('scheduled'));
            return [];
        }
    });

    const buckets = await tools.fetchWebProviderBuckets({
        type: 'movie',
        originalId: 'tt33046197',
        finalId: 'tt33046197',
        meta: { title: 'Fratelli demolitori', type: 'movie' },
        config: { filters: { enableCc: true } },
        reqHost: null,
        allowItalianWebProviders: true,
        dbOnlyMode: false
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].providerName, 'CinemaCityV3');
    assert.equal(calls[0].hasLimiter, true);
    assert.deepEqual(buckets.cinemaCity, []);
});

test('web formatter keeps CinemaCity quality and avoids duplicate provider lines', () => {
    const tools = createWebProviderTools({
        Cache: {},
        LIMITERS: {},
        CONFIG: { TIMEOUTS: { SCRAPER: 0 } },
        guardedProviderCall: async () => []
    });

    const formatted = tools.formatWebProviderBuckets({
        cinemaCity: [{
            name: '🏙️ CinemaCity | CCCDN',
            title: 'Agente Zeta HD\n☁️ CCCDN • 🇮🇹 ITA',
            url: 'https://example.com/master.m3u8',
            quality: '1080p',
            extractor: 'CCCDN',
            behaviorHints: {
                extractor: 'CCCDN',
                vortexMeta: {
                    quality: '1080p',
                    extractor: 'CCCDN',
                    provider: 'CinemaCity'
                }
            }
        }]
    }, { title: 'Agente Zeta HD', type: 'movie' }, { formatter: 'leviathan', filters: {} });

    assert.equal(formatted.cinemaCity.length, 1);
    assert.match(formatted.cinemaCity[0].name, /^🌊\s/i);
    assert.match(formatted.cinemaCity[0].title, /1080/i);
    assert.match(formatted.cinemaCity[0].title, /CCCDN/i);
    assert.equal((formatted.cinemaCity[0].title.match(/CinemaCity/g) || []).length, 1);
    assert.doesNotMatch(formatted.cinemaCity[0].title, /HLS Proxy/i);
});

test('web formatter normalizes legacy CinemaCity proxy labels to CCCDN', () => {
    const tools = createWebProviderTools({
        Cache: {},
        LIMITERS: {},
        CONFIG: { TIMEOUTS: { SCRAPER: 0 } },
        guardedProviderCall: async () => []
    });

    const formatted = tools.formatWebProviderBuckets({
        cinemaCity: [{
            name: '🏙️ CinemaCity | MFP',
            title: 'Agente Zeta HD\n☁️ Proxy • 🇮🇹 ITA',
            url: 'https://example.com/master.m3u8',
            quality: '1080p',
            extractor: 'HLS Proxy',
            behaviorHints: {
                extractor: 'HLS Proxy',
                vortexMeta: {
                    quality: '1080p',
                    extractor: 'HLS Proxy',
                    provider: 'CinemaCity'
                }
            }
        }]
    }, { title: 'Agente Zeta HD', type: 'movie' }, { formatter: 'leviathan', filters: {} });

    assert.equal(formatted.cinemaCity.length, 1);
    assert.match(formatted.cinemaCity[0].title, /CCCDN/i);
    assert.doesNotMatch(formatted.cinemaCity[0].title, /HLS Proxy/i);
});
