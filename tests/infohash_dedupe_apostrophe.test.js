'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSmartToken, dedupeByInfoHash } = require('../core/stream/infohash_deduper');

test('normalizeSmartToken collapses apostrophes so possessives match', () => {
    assert.equal(
        normalizeSmartToken("Lee Cronin's The Mummy"),
        normalizeSmartToken('Lee Cronins The Mummy')
    );
    assert.equal(normalizeSmartToken("Don't Look Up"), 'dont look up');
});

test('forced-torrentio movie duplicates differing only by an apostrophe are merged', () => {
    const options = { meta: { title: 'The Mummy', type: 'movie', year: 2025 } };
    const items = [
        {
            title: "Lee Cronin's The Mummy 1080p WEBRip x265 MIRCREW",
            infoHash: 'a'.repeat(40),
            sizeBytes: 2410000000,
            seeders: 5,
            source: 'ThePirateBay',
            _torrentioExactGuard: true
        },
        {
            title: 'Lee Cronins The Mummy 1080p WEBRip x265 MIRCREW',
            infoHash: 'b'.repeat(40),
            sizeBytes: 2410000000,
            seeders: 11,
            source: 'ThePirateBay',
            _torrentioExactGuard: true
        }
    ];

    const { results, removed } = dedupeByInfoHash(items, options);
    assert.equal(removed, 1);
    assert.equal(results.length, 1);
});
