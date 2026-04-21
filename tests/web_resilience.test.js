'use strict';

const fs = require('fs').promises;
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PersistentJsonCache,
    SingleFlight,
    TTLCache
} = require('../providers/extractors/resilience');

test('TTLCache returns stale entries only when requested', async () => {
    const cache = new TTLCache({ ttlMs: 30, staleTtlMs: 300, cloneValues: true });
    cache.set('movie', { title: 'Example' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(cache.get('movie'), null);

    const staleEntry = cache.getEntry('movie', { allowStale: true });
    assert.equal(staleEntry?.isStale, true);
    assert.equal(staleEntry?.value?.title, 'Example');
});

test('SingleFlight deduplicates concurrent work', async () => {
    const singleFlight = new SingleFlight();
    let executions = 0;

    const [first, second] = await Promise.all([
        singleFlight.do('shared', async () => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 'ok';
        }),
        singleFlight.do('shared', async () => {
            executions += 1;
            return 'duplicate';
        })
    ]);

    assert.equal(first, 'ok');
    assert.equal(second, 'ok');
    assert.equal(executions, 1);
});

test('PersistentJsonCache serves fresh and stale windows', async () => {
    const cacheFile = `${process.cwd()}\\tmp_web_cache_test.json`;
    const cache = new PersistentJsonCache({
        file: cacheFile,
        ttlMs: 5,
        staleTtlMs: 50,
        saveDebounceMs: 0,
        maxEntries: 8
    });

    try {
        await cache.set('key', { embeds: ['one'] });
        let entry = await cache.get('key');
        assert.equal(entry.isStale, false);
        assert.deepEqual(entry.data, { embeds: ['one'] });

        await new Promise((resolve) => setTimeout(resolve, 10));
        entry = await cache.get('key');
        assert.equal(entry.isStale, true);
        assert.deepEqual(entry.data, { embeds: ['one'] });

        await cache.delete('key');
        entry = await cache.get('key');
        assert.equal(entry.data, null);
    } finally {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fs.rm(cacheFile, { force: true }).catch(() => {});
    }
});
