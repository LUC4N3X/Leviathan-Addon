'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const DB_REPOSITORY_PATH = '../core/storage/db_repository';
const RUNTIME_PATH = '../core/utils/runtime';

const dbRepositoryResolved = require.resolve(DB_REPOSITORY_PATH);
require.cache[dbRepositoryResolved] = {
    id: dbRepositoryResolved,
    filename: dbRepositoryResolved,
    loaded: true,
    exports: {}
};

const runtimeResolved = require.resolve(RUNTIME_PATH);
require.cache[runtimeResolved] = {
    id: runtimeResolved,
    filename: runtimeResolved,
    loaded: true,
    exports: {
        logger: {
            info() {},
            warn() {},
            error() {}
        },
        incrementMetric() {},
        registerCacheAccess() {},
        registerCacheSet() {}
    }
};

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

test('fetchWithCache uses rate-limit TTL for provider 429 failures', async () => {
    await Cache.flushAll();

    let calls = 0;
    const error = new Error('too many requests');
    error.status = 429;

    const first = await Cache.fetchWithCache('UnitProvider', 'rate-limited', 60, async () => {
        calls += 1;
        throw error;
    }, {
        errorTtl: 1,
        rateLimitTtl: 60
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const second = await Cache.fetchWithCache('UnitProvider', 'rate-limited', 60, async () => {
        calls += 1;
        return [{ title: 'should stay cached empty' }];
    });

    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    assert.equal(calls, 1);
});

test('fetchWithCache keeps timeout failures on short temporary TTL', async () => {
    await Cache.flushAll();

    let calls = 0;
    const error = new Error('provider timeout');
    error.code = 'ETIMEDOUT';

    const first = await Cache.fetchWithCache('UnitProvider', 'timeout-short', 60, async () => {
        calls += 1;
        throw error;
    }, {
        errorTtl: 1,
        rateLimitTtl: 60
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const second = await Cache.fetchWithCache('UnitProvider', 'timeout-short', 60, async () => {
        calls += 1;
        return [{ title: 'fresh after timeout ttl' }];
    });

    assert.deepEqual(first, []);
    assert.deepEqual(second, [{ title: 'fresh after timeout ttl' }]);
    assert.equal(calls, 2);
});

test('fetchWithCache serves stale positive provider data when refresh fails', async () => {
    await Cache.flushAll();

    let calls = 0;
    const first = await Cache.fetchWithCache('UnitProvider', 'stale-positive', 1, async () => {
        calls += 1;
        return [{ title: 'cached positive' }];
    }, {
        errorTtl: 1
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const error = new Error('provider unavailable');
    error.code = 'ETIMEDOUT';
    const second = await Cache.fetchWithCache('UnitProvider', 'stale-positive', 60, async () => {
        calls += 1;
        throw error;
    }, {
        errorTtl: 1
    });

    assert.deepEqual(first, [{ title: 'cached positive' }]);
    assert.deepEqual(second, [{ title: 'cached positive' }]);
    assert.equal(calls, 2);
});
