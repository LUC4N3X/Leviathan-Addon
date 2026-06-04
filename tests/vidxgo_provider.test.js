'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    searchVidxgo,
    buildPlayerUrl,
    isSeriesRequest,
    normalizeImdbId
} = require('../providers/vidxgo/vidxgo_handler');

test('VidxGo public search export is a callable function', () => {
    assert.equal(typeof searchVidxgo, 'function');
});

test('VidxGo normalizes imdb identifiers from mixed inputs', () => {
    assert.equal(normalizeImdbId('tt9813792'), 'tt9813792');
    assert.equal(normalizeImdbId('TT0903747'), 'tt0903747');
    assert.equal(normalizeImdbId('tt8772296:1:1'), 'tt8772296');
    assert.equal(normalizeImdbId('not-an-id'), null);
});

test('VidxGo detects series requests from type and id shape', () => {
    assert.equal(isSeriesRequest({ type: 'series' }), true);
    assert.equal(isSeriesRequest({ id: 'tt8772296:2:5' }), true);
    assert.equal(isSeriesRequest({ type: 'movie' }), false);
});

test('VidxGo builds movie player url from numeric imdb', () => {
    assert.equal(buildPlayerUrl('tt0903747', { series: false }), 'https://v.vidxgo.co/0903747');
});

test('VidxGo builds series player url with season and episode', () => {
    assert.equal(
        buildPlayerUrl('tt8772296', { series: true, season: 1, episode: 1 }),
        'https://v.vidxgo.co/8772296/1/1'
    );
});

test('VidxGo rejects series player url without a valid season/episode', () => {
    assert.equal(buildPlayerUrl('tt8772296', { series: true, season: null, episode: 3 }), null);
});

test('VidxGo returns nothing when the provider toggle is disabled', async () => {
    const streams = await searchVidxgo({ id: 'tt0903747', type: 'movie' }, { filters: { enableVidxgo: false } });
    assert.deepEqual(streams, []);
});
