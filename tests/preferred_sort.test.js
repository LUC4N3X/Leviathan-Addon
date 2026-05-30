const test = require('node:test');
const assert = require('node:assert/strict');

const { applyFinalStreamUserSort } = require('../core/stream/ranking_policy');

const silentLogger = { info() {} };

test('preferred visual-tag list reorders streams within the same cache tier', () => {
    const streams = [
        { title: 'Movie 1080p WEBRip ENG', cacheState: 'cached' },
        { title: 'Movie 1080p REMUX ITA', cacheState: 'cached' },
        { title: 'Movie 1080p WEB-DL ITA', cacheState: 'cached' }
    ];
    const sorted = applyFinalStreamUserSort(streams, {
        filters: { preferredQualities: ['remux', 'web-dl', 'webrip'] }
    }, { logger: silentLogger });
    assert.deepEqual(sorted.map((s) => s.title), [
        'Movie 1080p REMUX ITA',
        'Movie 1080p WEB-DL ITA',
        'Movie 1080p WEBRip ENG'
    ]);
});

test('preferred language list breaks ties after cache and resolution', () => {
    const streams = [
        { title: 'Show 1080p WEB-DL ENG', cacheState: 'cached' },
        { title: 'Show 1080p WEB-DL ITA', cacheState: 'cached' }
    ];
    const sorted = applyFinalStreamUserSort(streams, {
        filters: { preferredLanguages: ['ita', 'eng'] }
    }, { logger: silentLogger });
    assert.deepEqual(sorted.map((s) => s.title), [
        'Show 1080p WEB-DL ITA',
        'Show 1080p WEB-DL ENG'
    ]);
});

test('cache priority still wins over preferred lists', () => {
    const streams = [
        { title: 'A 1080p WEBRip ITA', cacheState: 'cached' },
        { title: 'B 1080p REMUX ITA', cacheState: 'uncached_terminal' }
    ];
    const sorted = applyFinalStreamUserSort(streams, {
        filters: { preferredQualities: ['remux', 'webrip'] }
    }, { logger: silentLogger });
    // Cached WEBRip must stay ahead of the uncached REMUX despite the preference.
    assert.deepEqual(sorted.map((s) => s.title), ['A 1080p WEBRip ITA', 'B 1080p REMUX ITA']);
});

test('no preferred lists leaves ordering identical to baseline', () => {
    const streams = [
        { title: 'A 720p', cacheState: 'cached' },
        { title: 'B 1080p', cacheState: 'uncached_terminal' },
        { title: 'C 1080p', cacheState: 'cached' }
    ];
    const sorted = applyFinalStreamUserSort(streams, { filters: { sortMode: 'resolution' } }, { logger: silentLogger });
    assert.deepEqual(sorted.map((s) => s.title), ['C 1080p', 'B 1080p', 'A 720p']);
});

test('preferred language aliases only match complete normalized tokens', () => {
    const streams = [
        { title: 'Titanic 1080p WEB-DL ENG', cacheState: 'cached' },
        { title: 'Movie 1080p WEB-DL ITA', cacheState: 'cached' }
    ];
    const sorted = applyFinalStreamUserSort(streams, {
        filters: { preferredLanguages: ['ita', 'eng'] }
    }, { logger: silentLogger });
    assert.deepEqual(sorted.map((stream) => stream.title), [
        'Movie 1080p WEB-DL ITA',
        'Titanic 1080p WEB-DL ENG'
    ]);
});
