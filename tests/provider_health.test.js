'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isProviderCoolingDown,
  markProviderError,
  markProviderSuccess,
  resetProviderHealth,
  snapshotProviderHealth,
  withProviderHealth
} = require('../providers/utils/provider_health');

test('provider health enters cooldown after repeated errors and recovers on success', () => {
  resetProviderHealth();

  markProviderError('Example Provider', new Error('timeout'), {}, {
    cooldownMs: 60_000,
    maxConsecutiveErrors: 2
  });
  let snapshot = snapshotProviderHealth('Example Provider');
  assert.equal(snapshot.consecutiveErrors, 1);
  assert.equal(snapshot.cooldownUntil, 0);

  markProviderError('Example Provider', new Error('timeout'), {}, {
    cooldownMs: 60_000,
    maxConsecutiveErrors: 2
  });
  snapshot = snapshotProviderHealth('Example Provider');
  assert.equal(snapshot.consecutiveErrors, 2);
  assert.equal(isProviderCoolingDown('Example Provider').active, true);

  markProviderSuccess('Example Provider', { resultCount: 3, durationMs: 5 });
  snapshot = snapshotProviderHealth('Example Provider');
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.consecutiveErrors, 0);
  assert.equal(snapshot.cooldownUntil, 0);
});

test('withProviderHealth skips cooled down providers when skipCooldown is enabled', async () => {
  resetProviderHealth();
  let calls = 0;

  markProviderError('Cooldown Provider', { statusCode: 429, message: 'Too Many Requests' }, {}, {
    cooldownMs: 60_000,
    maxConsecutiveErrors: 10
  });

  const result = await withProviderHealth('Cooldown Provider', async () => {
    calls += 1;
    return ['unexpected'];
  }, {
    fallbackValue: ['fallback'],
    skipCooldown: true,
    swallowErrors: true
  });

  assert.deepEqual(result, ['fallback']);
  assert.equal(calls, 0);
  assert.equal(snapshotProviderHealth('Cooldown Provider').status, 'cooldown');
});

test('provider health writes high-signal events to injected logger', () => {
  resetProviderHealth();
  const entries = [];
  const logger = {
    info: (message) => entries.push({ level: 'info', message }),
    warn: (message) => entries.push({ level: 'warn', message })
  };

  markProviderError('Logged Provider', { statusCode: 429, message: 'Too Many Requests' }, { durationMs: 7 }, {
    cooldownMs: 60_000,
    logger
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'warn');
  assert.match(entries[0].message, /\[PROVIDER HEALTH\] logged_provider error/);
  assert.match(entries[0].message, /status=rate_limited/);
});
