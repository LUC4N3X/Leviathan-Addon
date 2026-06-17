'use strict';

process.env.DB_MAINTENANCE_RETRY_ATTEMPTS = '3';

const test = require('node:test');
const assert = require('node:assert');

const { ensureDatabaseOptimizations } = require('../core/storage/db/schema');

function makeMockPool(handler) {
  const calls = [];
  return {
    options: {},
    calls,
    async query(arg) {
      const text = typeof arg === 'string' ? arg : (arg && arg.text) || '';
      calls.push(text);
      if (handler) return handler(text, calls);
      return { rows: [], rowCount: 0 };
    }
  };
}

function deadlockError() {
  const error = new Error('deadlock detected');
  error.code = '40P01';
  return error;
}

test('ensureDatabaseOptimizations runs every statement once on success', async () => {
  const pool = makeMockPool();
  await ensureDatabaseOptimizations(pool);

  assert.ok(pool.calls.length > 50, `expected many statements, got ${pool.calls.length}`);
  assert.ok(pool.calls.some((sql) => sql.includes('cache_metrics_history')), 'cleanup statement ran');
  assert.ok(pool.calls.some((sql) => sql.includes('uq_torrents_hash_file_idx_norm')), 'unique index ran');

  const target = pool.calls.filter((sql) => sql.includes('DELETE FROM shared_stream_cache'));
  assert.strictEqual(target.length, 1, 'no retries when there are no errors');
});

test('a transient deadlock is retried and then succeeds', async () => {
  let failed = false;
  const pool = makeMockPool((text) => {
    if (text.includes('DELETE FROM torrent_rank_history') && !failed) {
      failed = true;
      throw deadlockError();
    }
    return { rows: [], rowCount: 0 };
  });

  await ensureDatabaseOptimizations(pool);

  const attempts = pool.calls.filter((sql) => sql.includes('DELETE FROM torrent_rank_history'));
  assert.strictEqual(attempts.length, 2, 'statement retried exactly once after a deadlock');
});

test('a non-retryable error is attempted once and swallowed', async () => {
  const pool = makeMockPool((text) => {
    if (text.includes('DELETE FROM shared_stream_cache')) {
      const error = new Error('relation does not exist');
      error.code = '42P01';
      throw error;
    }
    return { rows: [], rowCount: 0 };
  });

  await assert.doesNotReject(ensureDatabaseOptimizations(pool));

  const attempts = pool.calls.filter((sql) => sql.includes('DELETE FROM shared_stream_cache'));
  assert.strictEqual(attempts.length, 1, 'non-retryable error is not retried');
});
