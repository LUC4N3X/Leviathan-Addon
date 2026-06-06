'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../providers/cinemacity/cc_handler');

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

test('CinemaCity anime detection recognizes kitsu/anime metadata', () => {
    assert.equal(__private.looksLikeAnimeMeta({
        type: 'anime',
        id: 'kitsu:12345:7',
        title: 'Solo Leveling'
    }), true);

    assert.equal(__private.looksLikeAnimeMeta({
        type: 'series',
        title: 'The Last of Us',
        genres: ['Drama']
    }), false);
});

test('CinemaCity content type matcher prioritizes anime routes', () => {
    assert.equal(__private.isCinemaCityContentUrlForType('https://cinemacity.cc/anime/123-naruto-shippuden.html', 'anime'), true);
    assert.equal(__private.isCinemaCityContentUrlForType('https://cinemacity.cc/tv-series/456-breaking-bad.html', 'anime'), true);
    assert.equal(__private.isCinemaCityContentUrlForType('https://cinemacity.cc/movies/789-dune.html', 'anime'), false);
});

test('CinemaCity listing extractor parses anime entries', () => {
    const html = [
        '<a href="/anime/123-solo-leveling.html">Solo Leveling</a>',
        '<a href="/tv-series/456-naruto-shippuden.html">Naruto Shippuden</a>'
    ].join('\n');

    const results = __private.extractCandidateLinksFromListing(html, 'anime');

    assert.equal(results.length, 2);
    assert.equal(results[0].url, 'https://cinemacity.cc/anime/123-solo-leveling.html');
    assert.equal(results[1].url, 'https://cinemacity.cc/tv-series/456-naruto-shippuden.html');
});

test('CinemaCity anime search variants include normalized titles and anime listing base', () => {
    const queries = __private.buildSearchQueryVariants([
        'Ore dake Level Up na Ken',
        'Solo Leveling'
    ]);

    assert.match(queries.join(' | '), /Solo Leveling/i);
    assert.ok(__private.getListingBaseUrls('anime').some((url) => /\/anime\/$/i.test(url)));
});

test('CinemaCity infers concrete audio languages from selected playback labels', () => {
    assert.deepEqual(__private.inferCinemaCityAudioLanguages('Server ITA ENG 1080p'), ['ita', 'eng']);
    assert.deepEqual(__private.inferCinemaCityAudioLanguages('Multi audio HD'), ['ita', 'eng']);
    assert.deepEqual(__private.inferCinemaCityAudioLanguages('Server ITA'), ['ita']);
    assert.deepEqual(__private.inferCinemaCityAudioLanguages('Server ENG'), ['eng']);
});

test('CinemaCity merges selected playback label and playlist audio languages', () => {
    assert.deepEqual(
        __private.mergeCinemaCityAudioLanguages(['ita'], { audioLanguages: ['eng'] }),
        ['ita', 'eng']
    );
});

test('CinemaCity builds generic forward URLs from the shared FORWARD_PROXY env', () => {
    withEnvironment({
        FORWARD_PROXY: 'https://proxy.example/forward?url=',
        CINEMACITY_FORWARD_PROXY: 'https://legacy.example/cinemacity/fetch?d='
    }, () => {
        assert.equal(
            __private.buildCinemaCityKrakenForwardUrl('https://cinemacity.cc/movies/one.html', {
                'User-Agent': 'Leviathan Test',
                Referer: 'https://cinemacity.cc/',
                Origin: 'https://cinemacity.cc'
            }),
            'https://proxy.example/forward?url=https%3A%2F%2Fcinemacity.cc%2Fmovies%2Fone.html&h_user-agent=Leviathan+Test&h_referer=https%3A%2F%2Fcinemacity.cc%2F&h_origin=https%3A%2F%2Fcinemacity.cc'
        );
    });
});

test('CinemaCity derives extractor base from the shared generic forward endpoint', () => {
    withEnvironment({
        FORWARD_PROXY: 'https://proxy.example/forward?url=',
        CINEMACITY_FORWARD_PROXY: 'https://legacy.example/cinemacity/fetch?d=',
        CINEMACITY_PAGE_EXTRACTOR_BASE: undefined,
        CINEMACITY_KRAKEN_EXTRACTOR_URL: undefined,
        KRAKEN_PROXY_URL: undefined,
        MEDIAFLOW_PROXY_URL: undefined,
        MEDIAFLOW_URL: undefined,
        MFP_URL: undefined,
        MFP_BASE_URL: undefined,
        KRAKEN_URL: undefined,
        KRAKEN_BASE_URL: undefined
    }, () => {
        assert.equal(__private.getCinemaCityPageExtractorBase({}), 'https://proxy.example');
    });
});
