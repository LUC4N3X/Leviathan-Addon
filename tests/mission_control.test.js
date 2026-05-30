'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMissionControlPayload } = require('../core/observability/mission_control');

test('mission control aggregates runtime, cache, debrid and external snapshot stats', async () => {
  const payload = await buildMissionControlPayload({
    getStatsSnapshot: () => ({
      uptimeSec: 42,
      runtime: { lifecycle: { ready: true } },
      cache: { stream: { hit: 9, miss: 1, hitRate: 90 } },
      providers: { torrentio: { ok: 2 } },
      sourceHealth: { mediafusion: { fail: 1 } },
      counters: { 'cache.stream.invalidations': 3 },
      timers: { stream: { avgMs: 12 } }
    }),
    getRdAuditorStatus: () => ({ enabled: true, running: true }),
    getRdProbeCoordinatorStatus: () => ({
      running: 2,
      queued: { foreground: 1, view_scan: 0, backfill: 0, auditor: 3, total: 4 },
      metrics: { coalescedHits: 5 }
    }),
    dbHelper: {
      getRdScanProgress: async () => ({ total_with_hash: 10, cached_true: 7 }),
      getExternalSnapshotStats: async () => ({ active: 5, torrentio: 3, mediafusion: 2 }),
      getAvailabilityCacheStats: async () => ([{ service: 'rd', active: 8 }])
    },
    Cache: { getStreamCacheIndexStats: () => ({ trackedKeys: 4 }) },
    getCacheHealthStatus: () => 'ok',
    traceLimit: 2
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.cache.health, 'ok');
  assert.equal(payload.debrid.progress.cached_true, 7);
  assert.equal(payload.externalSnapshots.mediafusion, 2);
  assert.equal(payload.debrid.availabilityCache[0].service, 'rd');
  assert.equal(payload.debrid.probeCoordinator.running, 2);
  assert.equal(payload.debrid.probeCoordinator.metrics.coalescedHits, 5);
  assert.equal(payload.providers.torrentio.ok, 2);
});
