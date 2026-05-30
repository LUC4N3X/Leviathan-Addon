const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../core/debrid/availability/debrid_availability');
const {
    buildDebridUserHash,
    resolveDebridCheckUserHash,
    isGlobalCacheService,
    buildDebridCheckMarkerLocalKey
} = __private;

const meta = { imdb_id: 'tt1234567', season: 1, episode: 2 };

test('global-cache services are classified correctly', () => {
    assert.equal(isGlobalCacheService('tb'), true);
    assert.equal(isGlobalCacheService('torbox'), true);
    assert.equal(isGlobalCacheService('TB'), true);
    assert.equal(isGlobalCacheService('rd'), false);
    assert.equal(isGlobalCacheService('realdebrid'), false);
});

test('TorBox check marker is shared globally across users', () => {
    const hashA = resolveDebridCheckUserHash('tb', 'tokenA');
    const hashB = resolveDebridCheckUserHash('tb', 'tokenB');
    assert.equal(hashA, 'global');
    assert.equal(hashB, 'global');

    const keyA = buildDebridCheckMarkerLocalKey('tb', 'tokenA', meta);
    const keyB = buildDebridCheckMarkerLocalKey('tb', 'tokenB', meta);
    assert.equal(keyA, keyB, 'two TorBox users must hit the same marker key');
    assert.match(keyA, /^tb:global:/);
});

test('Real-Debrid check marker stays per-user', () => {
    const hashA = resolveDebridCheckUserHash('rd', 'tokenA');
    const hashB = resolveDebridCheckUserHash('rd', 'tokenB');
    assert.notEqual(hashA, 'global');
    assert.notEqual(hashA, hashB, 'distinct RD tokens must produce distinct markers');
    assert.equal(hashA, buildDebridUserHash('tokenA'));

    const keyA = buildDebridCheckMarkerLocalKey('rd', 'tokenA', meta);
    const keyB = buildDebridCheckMarkerLocalKey('rd', 'tokenB', meta);
    assert.notEqual(keyA, keyB);
});

test('global cache sharing can be disabled via env flag', () => {
    const previous = process.env.DEBRID_GLOBAL_CACHE_CHECK_ENABLED;
    process.env.DEBRID_GLOBAL_CACHE_CHECK_ENABLED = 'false';
    try {
        const hashA = resolveDebridCheckUserHash('tb', 'tokenA');
        const hashB = resolveDebridCheckUserHash('tb', 'tokenB');
        assert.notEqual(hashA, 'global');
        assert.notEqual(hashA, hashB);
    } finally {
        if (previous === undefined) delete process.env.DEBRID_GLOBAL_CACHE_CHECK_ENABLED;
        else process.env.DEBRID_GLOBAL_CACHE_CHECK_ENABLED = previous;
    }
});
