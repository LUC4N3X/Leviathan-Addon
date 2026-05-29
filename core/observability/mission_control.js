'use strict';

const runtimeState = require('../runtime_state');
const { getRecentStreamTraces } = require('../lib/stream_trace');

async function safeMissionSection(name, fn) {
    try {
        return await fn();
    } catch (err) {
        return { error: err?.message || String(err || `${name}_failed`) };
    }
}

async function buildMissionControlPayload({
    getStatsSnapshot,
    getRdAuditorStatus,
    dbHelper,
    Cache,
    getCacheHealthStatus,
    traceLimit = 12
} = {}) {
    const snapshot = typeof getStatsSnapshot === 'function' ? (getStatsSnapshot() || {}) : {};
    const [rdScanProgress, externalSnapshots, availabilityCache, postgresCache] = await Promise.all([
        safeMissionSection('rd_scan_progress', async () => (typeof dbHelper?.getRdScanProgress === 'function' ? dbHelper.getRdScanProgress() : null)),
        safeMissionSection('external_snapshots', async () => (typeof dbHelper?.getExternalSnapshotStats === 'function' ? dbHelper.getExternalSnapshotStats() : null)),
        safeMissionSection('availability_cache', async () => (typeof dbHelper?.getAvailabilityCacheStats === 'function' ? dbHelper.getAvailabilityCacheStats() : null)),
        safeMissionSection('postgres_cache_overview', async () => (typeof dbHelper?.getPostgresCacheOverview === 'function' ? dbHelper.getPostgresCacheOverview() : null))
    ]);

    return {
        ok: true,
        status: 'ok',
        timestamp: new Date().toISOString(),
        runtime: snapshot?.runtime || runtimeState.getSnapshot(),
        uptimeSec: snapshot?.uptimeSec,
        cache: {
            health: typeof getCacheHealthStatus === 'function' ? getCacheHealthStatus() : null,
            streamIndex: typeof Cache?.getStreamCacheIndexStats === 'function' ? Cache.getStreamCacheIndexStats() : null,
            counters: snapshot?.cache || null,
            postgres: postgresCache
        },
        debrid: {
            scanner: typeof getRdAuditorStatus === 'function' ? getRdAuditorStatus() : null,
            progress: rdScanProgress,
            availabilityCache
        },
        externalSnapshots,
        providers: snapshot?.providers || {},
        sourceHealth: snapshot?.sourceHealth || {},
        limiters: snapshot?.limiters || {},
        counters: snapshot?.counters || {},
        timers: snapshot?.timers || {},
        recentStreamTraces: getRecentStreamTraces(Math.max(1, Math.min(50, Number(traceLimit || 12) || 12)))
    };
}

module.exports = {
    buildMissionControlPayload,
    safeMissionSection
};
