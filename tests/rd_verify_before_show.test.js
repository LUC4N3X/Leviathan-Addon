'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../core/stream_generator');
const { isUnverifiedDbRdPositive, getRdCandidateState } = __private;

function withEnv(overrides, fn) {
    const saved = {};
    for (const key of Object.keys(overrides)) {
        saved[key] = process.env[key];
        if (overrides[key] === undefined) delete process.env[key];
        else process.env[key] = overrides[key];
    }
    try {
        return fn();
    } finally {
        for (const key of Object.keys(saved)) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    }
}

test('unverified DB stale positive is treated as unknown (verify before show)', () => {
    withEnv({ RD_VERIFY_BEFORE_SHOW: undefined, RD_TORRENTIO_OVER_DB: undefined }, () => {
        const item = { _localDb: true, _sourceGroup: 'local_db', _rdStalePositive: true, _rdCacheState: 'likely_cached', _dbCachedRd: null };
        assert.equal(isUnverifiedDbRdPositive(item), true);
        assert.equal(getRdCandidateState(item), 'unknown');
    });
});

test('Torrentio authority item is exempt (Torrentio over DB)', () => {
    withEnv({ RD_VERIFY_BEFORE_SHOW: undefined, RD_TORRENTIO_OVER_DB: undefined }, () => {
        const item = { _localDb: true, _rdStalePositive: true, _rdCacheState: 'likely_cached', _torrentioRdAuthority: true };
        assert.equal(isUnverifiedDbRdPositive(item), false);
        // Torrentio keeps its likely_cached state, it is trusted ahead of the DB.
        assert.equal(getRdCandidateState(item), 'likely_cached');
    });
});

test('fresh DB-verified positive is kept as-is', () => {
    withEnv({ RD_VERIFY_BEFORE_SHOW: undefined }, () => {
        const item = { _localDb: true, _dbCachedRd: true, _rdStalePositive: false, _rdCacheState: 'cached' };
        assert.equal(isUnverifiedDbRdPositive(item), false);
        assert.equal(getRdCandidateState(item), 'cached');
    });
});

test('live-verified item is never downgraded', () => {
    withEnv({ RD_VERIFY_BEFORE_SHOW: undefined }, () => {
        const item = { _localDb: true, _rdStalePositive: true, _rdCacheState: 'likely_cached', cached: true };
        assert.equal(isUnverifiedDbRdPositive(item), false);
    });
});

test('non-DB item is not affected', () => {
    withEnv({ RD_VERIFY_BEFORE_SHOW: undefined }, () => {
        const item = { _rdCacheState: 'likely_cached' };
        assert.equal(isUnverifiedDbRdPositive(item), false);
        assert.equal(getRdCandidateState(item), 'likely_cached');
    });
});

test('flag off disables the downgrade', () => {
    withEnv({ RD_VERIFY_BEFORE_SHOW: 'false' }, () => {
        const item = { _localDb: true, _rdStalePositive: true, _rdCacheState: 'likely_cached', _dbCachedRd: null };
        assert.equal(isUnverifiedDbRdPositive(item), false);
        assert.equal(getRdCandidateState(item), 'likely_cached');
    });
});
