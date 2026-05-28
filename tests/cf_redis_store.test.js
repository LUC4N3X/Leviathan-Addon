'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CfRedisStore, hashPart, normalizeOrigin } = require('../providers/utils/cf_redis_store');

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
