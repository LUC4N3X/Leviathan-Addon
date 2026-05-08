'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = '../core/cache/raw_stream_cache';
const RUNTIME_PATH = '../core/utils/runtime';
const ENV_KEYS = [
    'RAW_STREAM_CACHE_ENABLED',
    'RAW_STREAM_CACHE_TTL_SECONDS',
    'RAW_STREAM_CACHE_COMPRESS',
    'RAW_STREAM_CACHE_MAX_BYTES',
    'RAW_STREAM_CACHE_MAX_KEYS'
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearEnv() {
    for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv() {
    clearEnv();
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value !== undefined) process.env[key] = value;
    }
}

function loadRawStreamCache(env = {}) {
    clearEnv();
    Object.assign(process.env, env);
    const resolved = require.resolve(MODULE_PATH);
    const runtimeResolved = require.resolve(RUNTIME_PATH);
    delete require.cache[resolved];
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
    return require(MODULE_PATH);
}

test.afterEach(() => {
    restoreEnv();
    const resolved = require.resolve(MODULE_PATH);
    const runtimeResolved = require.resolve(RUNTIME_PATH);
    delete require.cache[resolved];
    delete require.cache[runtimeResolved];
});

test('raw stream cache keeps conservative defaults without env overrides', () => {
    const cache = loadRawStreamCache();

    assert.equal(cache.RAW_STREAM_CACHE_ENABLED, true);
    assert.equal(cache.RAW_STREAM_CACHE_TTL_SECONDS, 900);
    assert.equal(cache.RAW_STREAM_CACHE_COMPRESS, true);
    assert.equal(cache.RAW_STREAM_CACHE_MAX_BYTES, 500000);
    assert.equal(cache.RAW_STREAM_CACHE_MAX_KEYS, 12000);
    assert.equal(cache.getRawStreamCacheStats().maxKeys, 12000);
});

test('raw stream cache reads bounded environment overrides', () => {
    const cache = loadRawStreamCache({
        RAW_STREAM_CACHE_TTL_SECONDS: '45',
        RAW_STREAM_CACHE_COMPRESS: 'false',
        RAW_STREAM_CACHE_MAX_BYTES: '8192',
        RAW_STREAM_CACHE_MAX_KEYS: '256'
    });

    assert.equal(cache.RAW_STREAM_CACHE_TTL_SECONDS, 45);
    assert.equal(cache.RAW_STREAM_CACHE_COMPRESS, false);
    assert.equal(cache.RAW_STREAM_CACHE_MAX_BYTES, 8192);
    assert.equal(cache.RAW_STREAM_CACHE_MAX_KEYS, 256);
});

test('raw stream cache can be disabled for live debugging', async () => {
    const cache = loadRawStreamCache({
        RAW_STREAM_CACHE_ENABLED: 'false'
    });

    const payload = { streams: [{ name: 'LEVIATHAN', title: 'Example 1080p' }] };
    const saved = await cache.setRawStreamCache('movie', 'tt123', 'conf', payload);
    const cached = await cache.getRawStreamCache('movie', 'tt123', 'conf');

    assert.equal(cache.RAW_STREAM_CACHE_ENABLED, false);
    assert.equal(saved, false);
    assert.equal(cached, null);
});
