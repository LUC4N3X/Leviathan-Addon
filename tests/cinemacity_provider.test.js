'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __private } = require('../providers/cinemacity/cc_handler');

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
