'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTorrentRepository } = require('../core/storage/db/torrent_repository');

function makeNormalizers() {
  return {
    clampInt(value, fallback, min, max) {
      const parsed = Number.parseInt(value, 10);
      const numeric = Number.isFinite(parsed) ? parsed : fallback;
      return Math.min(max, Math.max(min, numeric));
    },
    toNullableInt(value) {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) ? parsed : null;
    },
    toSafeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    sanitizeText(value) {
      return String(value ?? '').trim();
    },
    normalizeInfoHash(value) {
      const text = String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
      return text.length === 40 ? text : null;
    },
    normalizeUniqueInfoHashes(values) {
      return [...new Set((Array.isArray(values) ? values : [values]).map((value) => this.normalizeInfoHash(value)).filter(Boolean))];
    },
    normalizeImdbId(value) {
      const text = String(value || '').trim().toLowerCase();
      return /^tt\d+$/.test(text) ? text : null;
    },
    normalizeFileIndex(value) {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    },
    normalizeFileIndexNorm(value) {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
    },
    normalizeRdCacheState(value) {
      const text = String(value || '').trim().toLowerCase();
      return text || null;
    },
    deriveStoredCacheState(value) { return value || null; },
    deriveCachedBooleanFromState(value) { return value === 'cached' ? true : null; },
    extractOriginalProvider() { return null; },
    normalizeUniqueTextList(values) {
      return [...new Set((Array.isArray(values) ? values : [values]).flatMap((value) => String(value || '').split(/[,|;]/)).map((value) => value.trim()).filter(Boolean))];
    },
    toDateOrNull(value) { return value ? new Date(value) : null; }
  };
}

test('external snapshots upsert Nexus addon streams with episode/file identity', async () => {
  const queries = [];
  const repo = createTorrentRepository({
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
    withClient: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
    runInTransaction: async (fn) => fn({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
    }),
    awaitDatabaseOptimizations: async () => {},
    trackerRegistry: {},
    normalizers: makeNormalizers()
  });

  const result = await repo.upsertExternalStreamSnapshots(
    { imdb_id: 'tt1234567', season: 2, episode: 4, isSeries: true },
    [{
      title: 'Example S02E04 1080p ITA',
      hash: 'a'.repeat(40),
      fileIdx: 7,
      externalAddon: 'Torrentio',
      externalGroup: 'torrentio',
      provider: 'Torrentio IT',
      languages: ['ita'],
      seeders: 21,
      sizeBytes: 123456789,
      _rdCacheState: 'cached',
      cached_rd: true
    }],
    { type: 'series', ttlSeconds: 3600 }
  );

  assert.equal(result.processed, 1);
  assert.equal(result.upserted, 1);
  assert.match(queries[0].sql, /external_stream_snapshots/);
  assert.equal(queries[0].params[1], 'tt1234567');
  assert.equal(queries[0].params[2], 2);
  assert.equal(queries[0].params[3], 4);
  assert.equal(queries[0].params[4], 'series');
  assert.equal(queries[0].params[5], 'A'.repeat(40));
  assert.equal(queries[0].params[6], 7);
  assert.equal(queries[0].params[9], 'torrentio');
});
