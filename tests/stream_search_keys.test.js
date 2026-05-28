const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildTitleSearchPipelineKey,
    buildValidatedFileSetKey
} = require('../core/stream/search_keys');

test('title search pipeline key is stable for unordered filter arrays', () => {
    const meta = {
        title: 'The Last of Us',
        originalTitle: 'The Last of Us',
        year: 2023,
        season: 1,
        episode: 2
    };

    const first = buildTitleSearchPipelineKey(meta, 'series', 'ita', false, {
        sourceMode: 'balanced',
        providers: ['Torrentio', 'MediaFusion'],
        qualityAllow: ['1080p', '720p']
    });
    const second = buildTitleSearchPipelineKey(meta, 'series', 'ita', false, {
        sourceMode: 'balanced',
        providers: ['MediaFusion', 'Torrentio'],
        qualityAllow: ['720p', '1080p']
    });

    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{20}$/);
});

test('title search pipeline key changes when effective filters change', () => {
    const meta = { title: 'Dune', year: 2021 };

    const balanced = buildTitleSearchPipelineKey(meta, 'movie', 'ita', false, { no4k: false });
    const no4k = buildTitleSearchPipelineKey(meta, 'movie', 'ita', false, { no4k: true });

    assert.notEqual(balanced, no4k);
});

test('validated file set key preserves hash and episode identity', () => {
    const key = buildValidatedFileSetKey(
        { hash: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' },
        { isSeries: true, season: 2, episode: 4 }
    );

    assert.equal(key, '0123456789ABCDEF0123456789ABCDEF01234567:series:2:4');
});

test('validated file set key returns null without a usable info hash', () => {
    assert.equal(buildValidatedFileSetKey({ title: 'no hash' }, { isSeries: false }), null);
});
