const test = require('node:test');
const assert = require('node:assert/strict');

const {
    cleanupTimedCache,
    getTimedCacheValue,
    setTimedCacheValue
} = require('../core/stream/timed_cache');

test('timed cache returns fresh values and removes expired entries', () => {
    const originalNow = Date.now;
    let now = 10_000;
    Date.now = () => now;

    try {
        const cache = new Map();

        setTimedCacheValue(cache, 'movie:tt123', { streams: 2 }, 500, 5);
        assert.deepEqual(getTimedCacheValue(cache, 'movie:tt123'), { streams: 2 });

        now += 501;

        assert.equal(getTimedCacheValue(cache, 'movie:tt123'), null);
        assert.equal(cache.has('movie:tt123'), false);
    } finally {
        Date.now = originalNow;
    }
});

test('timed cache trims the oldest entries when over capacity', () => {
    const originalNow = Date.now;
    let now = 20_000;
    Date.now = () => now;

    try {
        const cache = new Map();

        setTimedCacheValue(cache, 'first', 1, 10_000, 2);
        setTimedCacheValue(cache, 'second', 2, 10_000, 2);
        setTimedCacheValue(cache, 'third', 3, 10_000, 2);

        assert.equal(cache.has('first'), false);
        assert.equal(getTimedCacheValue(cache, 'second'), 2);
        assert.equal(getTimedCacheValue(cache, 'third'), 3);
    } finally {
        Date.now = originalNow;
    }
});

test('forced timed cache cleanup prunes expired entries immediately', () => {
    const originalNow = Date.now;
    let now = 30_000;
    Date.now = () => now;

    try {
        const cache = new Map([
            ['expired', { value: 'old', expiresAt: now - 1 }],
            ['fresh', { value: 'new', expiresAt: now + 1_000 }]
        ]);

        cleanupTimedCache(cache, 10, { force: true });

        assert.equal(cache.has('expired'), false);
        assert.equal(cache.has('fresh'), true);
    } finally {
        Date.now = originalNow;
    }
});
