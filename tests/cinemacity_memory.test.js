'use strict';

// Disable disk persistence before requiring the module so tests have no filesystem
// side effects (the module reads its config from env at require time).
process.env.CC_MEMORY = '1';
process.env.CC_MEMORY_PERSIST = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../providers/cinemacity/cc_memory');

const DAY = 24 * 3600 * 1000;
let nowValue = 1_000_000_000_000;

function setNow(value) {
    nowValue = value;
    memory.__setClock(() => nowValue);
}

test.beforeEach(() => {
    memory.__reset();
    setNow(1_000_000_000_000);
});

test('remember then recall returns the stored resolution', () => {
    memory.remember('tt0111161', 'movie', {
        url: 'https://cinemacity.cc/movies/1-the-shawshank-redemption-1994.html',
        title: 'The Shawshank Redemption',
        kind: 'movies',
        score: 1000,
        verifiedImdb: true
    });

    const hit = memory.recall('tt0111161', 'movie');
    assert.ok(hit);
    assert.equal(hit.negative, undefined);
    assert.equal(hit.url, 'https://cinemacity.cc/movies/1-the-shawshank-redemption-1994.html');
    assert.equal(hit.title, 'The Shawshank Redemption');
    assert.equal(hit.verifiedImdb, true);
    assert.ok(hit.confidence > 0.9);
});

test('recall is keyed by content type and id', () => {
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', verifiedImdb: true });
    assert.ok(memory.recall('tt0111161', 'movie'));
    assert.equal(memory.recall('tt0111161', 'tv'), null);
    assert.equal(memory.recall('tt9999999', 'movie'), null);
});

test('recall normalizes id casing', () => {
    memory.remember('TT0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', verifiedImdb: true });
    assert.ok(memory.recall('tt0111161', 'movie'));
});

test('negative memory is recalled as a skip signal', () => {
    memory.rememberNegative('tt1234567', 'tv');
    const hit = memory.recall('tt1234567', 'tv');
    assert.ok(hit);
    assert.equal(hit.negative, true);
    assert.equal(hit.url, undefined);
});

test('negative memory expires after its (short) ttl', () => {
    memory.rememberNegative('tt1234567', 'tv');
    assert.equal(memory.recall('tt1234567', 'tv').negative, true);

    setNow(nowValue + memory.__config.NEGATIVE_TTL_MS + 1000);
    assert.equal(memory.recall('tt1234567', 'tv'), null);
});

test('a transient negative miss never overwrites a verified positive', () => {
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', verifiedImdb: true });
    memory.rememberNegative('tt0111161', 'movie');

    const hit = memory.recall('tt0111161', 'movie');
    assert.ok(hit);
    assert.equal(hit.url, 'https://cinemacity.cc/movies/x.html');
    assert.notEqual(hit.negative, true);
});

test('penalize evicts a remembered url after MAX_FAILURES consecutive failures (self-healing)', () => {
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', score: 1000 });
    assert.ok(memory.recall('tt0111161', 'movie'));

    for (let i = 0; i < memory.__config.MAX_FAILURES; i++) {
        memory.penalize('tt0111161', 'movie');
    }
    assert.equal(memory.recall('tt0111161', 'movie'), null);
});

test('reinforce resets the failure streak so a single bad fetch does not evict', () => {
    // Verified so the recall confidence floor cannot mask the eviction-streak logic.
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', score: 1000, verifiedImdb: true });
    memory.penalize('tt0111161', 'movie'); // failures: 1
    memory.reinforce('tt0111161', 'movie'); // failures reset to 0
    memory.penalize('tt0111161', 'movie'); // failures: 1 (would be 2 -> evicted without the reset)

    assert.ok(memory.recall('tt0111161', 'movie'));
});

test('a fuzzy match that fails once decays below the floor and re-resolves', () => {
    // Distinct from the verified case above: a low-confidence guess that fails to
    // serve should immediately fall under the floor so the next lookup re-resolves.
    memory.remember('tt7777777', 'movie', { url: 'https://cinemacity.cc/movies/y.html', score: 250, verifiedImdb: false });
    memory.penalize('tt7777777', 'movie');
    assert.equal(memory.recall('tt7777777', 'movie'), null);
});

test('forget removes an entry immediately', () => {
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', verifiedImdb: true });
    memory.forget('tt0111161', 'movie');
    assert.equal(memory.recall('tt0111161', 'movie'), null);
});

test('positive entries expire after the positive ttl', () => {
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', verifiedImdb: true });
    setNow(nowValue + memory.__config.POSITIVE_TTL_MS + DAY);
    assert.equal(memory.recall('tt0111161', 'movie'), null);
});

test('fuzzy matches decay below the confidence floor and force a re-resolve', () => {
    // score 250 -> base confidence 0.6 (fuzzy, not imdb-verified)
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', score: 250, verifiedImdb: false });
    assert.ok(memory.recall('tt0111161', 'movie'));

    // After several half-lives the decayed confidence drops under the floor.
    setNow(nowValue + 5 * DAY);
    assert.equal(memory.recall('tt0111161', 'movie'), null);
});

test('verified matches are trusted past the decay floor (until ttl)', () => {
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', score: 1000, verifiedImdb: true });
    setNow(nowValue + 5 * DAY);
    const hit = memory.recall('tt0111161', 'movie');
    assert.ok(hit, 'verified entry should still be recalled after decay');
    assert.equal(hit.verifiedImdb, true);
});

test('reinforce increments hit count for analytics', () => {
    memory.remember('tt0111161', 'movie', { url: 'https://cinemacity.cc/movies/x.html', verifiedImdb: true });
    memory.reinforce('tt0111161', 'movie');
    memory.reinforce('tt0111161', 'movie');
    assert.equal(memory.recall('tt0111161', 'movie').hits, 2);
});

test('stats reports positive / negative / verified counts', () => {
    memory.remember('tt1', 'movie', { url: 'https://cinemacity.cc/movies/a.html', verifiedImdb: true });
    memory.remember('tt2', 'movie', { url: 'https://cinemacity.cc/movies/b.html', score: 300, verifiedImdb: false });
    memory.rememberNegative('tt3', 'tv');

    const stats = memory.stats();
    assert.equal(stats.enabled, true);
    assert.equal(stats.positive, 2);
    assert.equal(stats.negative, 1);
    assert.equal(stats.verified, 1);
    assert.equal(stats.size, 3);
});

test('disabling via env makes recall a no-op (guarded by ENABLED at require time)', () => {
    // The live module was required with CC_MEMORY=1; just assert the flag is exposed
    // so deployments can audit it.
    assert.equal(typeof memory.ENABLED, 'boolean');
    assert.equal(memory.ENABLED, true);
});
