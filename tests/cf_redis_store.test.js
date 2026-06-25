'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CfRedisStore,
  hashPart,
  normalizeOrigin,
  secondsUntilSessionExpiry,
  secondsUntilNativeExpiry,
  isExpiringSoon
} = require('../providers/utils/cf_redis_store');

test('cf redis store normalizes origins and separates sessions by egress key', () => {
  const store = new CfRedisStore();
  const first = store.providerSessionKey({
    providerName: 'GuardoSerie TV',
    url: 'https://guardoserie.run/path?q=1',
    egressKey: 'direct'
  });
  const sameOrigin = store.providerSessionKey({
    providerName: 'guardoserie tv',
    url: 'https://guardoserie.run/other',
    egressKey: 'direct'
  });
  const differentEgress = store.providerSessionKey({
    providerName: 'guardoserie tv',
    url: 'https://guardoserie.run/other',
    egressKey: 'warp:it-1'
  });

  assert.equal(first, sameOrigin);
  assert.notEqual(first, differentEgress);
  assert.match(first, /^guardoserie_tv:guardoserie\.run:egress_[a-f0-9]{16}$/);
});

test('cf redis native clearance keys are host scoped and egress aware', () => {
  const store = new CfRedisStore();
  assert.equal(normalizeOrigin('https://cb01uno.bar/film/test'), 'https://cb01uno.bar');
  assert.equal(normalizeOrigin('notaurl'), null);
  assert.equal(hashPart('direct').length, 16);

  const direct = store.nativeClearanceKey({ host: 'cb01uno.bar', egressKey: 'direct' });
  const proxy = store.nativeClearanceKey({ host: 'cb01uno.bar', egressKey: 'proxy-a' });
  assert.notEqual(direct, proxy);
  assert.match(direct, /^cb01uno\.bar:egress_[a-f0-9]{16}$/);
});

test('cf redis store TTL helpers compute remaining lifetime for pre-warming', () => {
  const ttlMs = 30 * 60_000;
  const fresh = { timestamp: Date.now() - 60_000 };
  const remaining = secondsUntilSessionExpiry(fresh, ttlMs);
  assert.ok(remaining > 28 * 60 && remaining <= 29 * 60);

  const explicit = { expiresAt: Date.now() + 120_000 };
  assert.ok(secondsUntilSessionExpiry(explicit, ttlMs) > 110);

  assert.equal(secondsUntilSessionExpiry({}, ttlMs), 0);
  assert.equal(secondsUntilNativeExpiry({}), 0);
  assert.ok(secondsUntilNativeExpiry({ expiresAt: Date.now() + 60_000 }) > 50);

  assert.equal(isExpiringSoon(120, 300), true);
  assert.equal(isExpiringSoon(600, 300), false);
});

test('cf redis store meta helpers short-circuit when redis is disabled', async () => {
  const store = new CfRedisStore();
  const sessionMeta = await store.getProviderSessionMeta({
    providerName: 'streamingcommunity',
    url: 'https://vixsrc.to',
    egressKey: 'direct'
  });
  assert.equal(sessionMeta.session, null);
  assert.equal(sessionMeta.expiringSoon, true);

  const nativeMeta = await store.getNativeClearanceMeta({ host: 'vixsrc.to', egressKey: 'direct' });
  assert.equal(nativeMeta.bundle, null);
  assert.equal(nativeMeta.expiringSoon, true);
});
