const test = require('node:test');
const assert = require('node:assert/strict');

const {
    applyFinalStreamUserSort,
    applyPremiumRankingPolicy,
    getConfiguredSortMode,
    getFinalStreamCacheState,
    getFinalStreamResolutionTier
} = require('../core/stream/ranking_policy');

const silentLogger = { info() {} };

test('configured sort mode accepts Italian and compact aliases', () => {
    assert.equal(getConfiguredSortMode({ filters: { sortBy: 'qualita' } }), 'resolution');
    assert.equal(getConfiguredSortMode({ sort: 'peso' }), 'size');
    assert.equal(getConfiguredSortMode({ ranking: { sortMode: 'balanced' } }), 'balanced');
});

test('final stream sort by resolution keeps cached streams ahead on ties', () => {
    const streams = [
        { title: 'A 720p', cacheState: 'cached' },
        { title: 'B 1080p', cacheState: 'uncached_terminal' },
        { title: 'C 1080p', cacheState: 'cached' }
    ];

    const sorted = applyFinalStreamUserSort(streams, { filters: { sortMode: 'resolution' } }, { logger: silentLogger });

    assert.deepEqual(sorted.map((stream) => stream.title), ['C 1080p', 'B 1080p', 'A 720p']);
});

test('final stream sort by size keeps cache priority before comparing size', () => {
    const streams = [
        { title: 'Cached small 1 GB', cacheState: 'cached' },
        { title: 'Uncached huge 80 GB', cacheState: 'uncached_terminal' },
        { title: 'Cached large 12 GB', cacheState: 'cached' }
    ];

    const sorted = applyFinalStreamUserSort(streams, { sortMode: 'size' }, { logger: silentLogger });

    assert.deepEqual(sorted.map((stream) => stream.title), [
        'Cached large 12 GB',
        'Cached small 1 GB',
        'Uncached huge 80 GB'
    ]);
});

test('premium diversity ranking is bypassed for explicit user sort modes', () => {
    const streams = [
        { title: 'A 1080p x265-GROUP' },
        { title: 'B 1080p x265-GROUP' },
        { title: 'C 1080p x265-GROUP' }
    ];

    assert.equal(applyPremiumRankingPolicy(streams, {}, { sortMode: 'resolution' }), streams);
    assert.equal(applyPremiumRankingPolicy(streams, {}, { sortMode: 'size' }), streams);
});

test('final stream helpers read quality and cache state from visible and behavior hint text', () => {
    const stream = {
        name: 'Leviathan RD 4K',
        behaviorHints: {
            filename: 'movie.2160p.mkv',
            cacheState: 'likely_cached'
        }
    };

    assert.equal(getFinalStreamResolutionTier(stream), 4);
    assert.equal(getFinalStreamCacheState(stream), 'likely_cached');
});
