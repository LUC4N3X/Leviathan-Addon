'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Cache } = require('../core/utils/cache');

test('fetchWithCache cacheOnly wins over bypass and never calls provider fetcher', async () => {
    await Cache.flushAll();

    let calls = 0;
    const result = await Cache.fetchWithCache('UnitProvider', 'movie:tt123', 60, async () => {
        calls += 1;
        return [{ title: 'should not run' }];
    }, {
        cacheOnly: true,
        bypassCache: true
    });

    assert.deepEqual(result, []);
    assert.equal(calls, 0);
});

test('fetchWithCache keeps bypass inflight separate from normal cached fetches', async () => {
    await Cache.flushAll();

    let releaseNormal;
    let calls = 0;

    const normalPromise = Cache.fetchWithCache('UnitProvider', 'series:tt456:1:1', 60, async () => {
        calls += 1;
        return new Promise((resolve) => {
            releaseNormal = () => resolve([{ source: 'normal' }]);
        });
    });

    const bypassResult = await Cache.fetchWithCache('UnitProvider', 'series:tt456:1:1', 60, async () => {
        calls += 1;
        return [{ source: 'bypass' }];
    }, {
        bypassCache: true
    });

    assert.deepEqual(bypassResult, [{ source: 'bypass' }]);

    releaseNormal();
    const normalResult = await normalPromise;

    assert.deepEqual(normalResult, [{ source: 'normal' }]);
    assert.equal(calls, 2);
});

test('fetchWithCache normalizes provider payloads without caching null entries', async () => {
    await Cache.flushAll();

    const result = await Cache.fetchWithCache('UnitProvider', 'mixed-payload', 60, async () => [
        { title: 'ok' },
        null,
        undefined
    ]);

    assert.deepEqual(result, [{ title: 'ok' }]);
});
