'use strict';

const axios = require('axios');


function flattenMetricObject(prefix, value, lines) {
    if (value === null || value === undefined) return;
    if (typeof value === 'number') {
        lines.push(`${prefix} ${Number.isFinite(value) ? value : 0}`);
        return;
    }
    if (typeof value === 'boolean') {
        lines.push(`${prefix} ${value ? 1 : 0}`);
        return;
    }
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
        lines.push(`${prefix} ${value.length}`);
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        const safeKey = String(key).replace(/[^a-zA-Z0-9_]/g, '_');
        flattenMetricObject(`${prefix}_${safeKey}`, child, lines);
    }
}

function buildPrometheusMetrics(snapshot) {
    const lines = [];
    const startedAt = Date.parse(snapshot?.startedAt || 0);
    const uptimeSec = Number(snapshot?.uptimeSec || 0);
    lines.push('# TYPE leviathan_uptime_seconds gauge');
    lines.push(`leviathan_uptime_seconds ${Number.isFinite(uptimeSec) ? uptimeSec : 0}`);
    if (Number.isFinite(startedAt) && startedAt > 0) {
        lines.push('# TYPE leviathan_started_at_seconds gauge');
        lines.push(`leviathan_started_at_seconds ${Math.floor(startedAt / 1000)}`);
    }
    flattenMetricObject('leviathan_counters', snapshot?.counters || {}, lines);
    flattenMetricObject('leviathan_timers', snapshot?.timers || {}, lines);
    flattenMetricObject('leviathan_cache', snapshot?.cache || {}, lines);
    flattenMetricObject('leviathan_limiters', snapshot?.limiters || {}, lines);
    flattenMetricObject('leviathan_source_health', snapshot?.sourceHealth || {}, lines);
    return lines.join('\n') + '\n';
}

function registerApiRoutes(app, {
    getStatsSnapshot,
    getRdAuditorStatus,
    dbHelper,
    Cache,
    withTimeout,
    CONFIG,
    logger,
    getCacheHealthStatus
}) {
    app.get('/api/stats', (req, res) => res.json(getStatsSnapshot()));
    app.get('/metrics', (req, res) => {
        const snapshot = getStatsSnapshot();
        res.type('text/plain').send(buildPrometheusMetrics(snapshot));
    });
    app.get('/api/rd-scanner-status', (req, res) => res.json(getRdAuditorStatus()));
    app.get('/api/rd-scanner-dashboard', async (req, res) => {
        let progress = null;
        try {
            if (typeof dbHelper.getRdScanProgress === 'function') progress = await dbHelper.getRdScanProgress();
        } catch (err) {
            progress = { error: err.message };
        }

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            scanner: getRdAuditorStatus(),
            progress,
            runtime: getStatsSnapshot(),
            streamCache: typeof Cache.getStreamCacheIndexStats === 'function' ? Cache.getStreamCacheIndexStats() : null
        });
    });

    app.get('/favicon.ico', (req, res) => res.status(204).end());

    app.get('/health', async (req, res) => {
        const checks = { status: 'ok', timestamp: new Date().toISOString(), services: {} };
        try {
            if (dbHelper.healthCheck) await withTimeout(dbHelper.healthCheck(), 1000, 'DB Health');
            checks.services.database = 'ok (Write-Only)';
        } catch (err) {
            checks.services.database = 'down';
            checks.status = 'degraded';
            logger.error('Health Check DB Fail', { error: err.message });
        }

        try {
            if (!CONFIG.INDEXER_URL) checks.services.indexer = 'disabled';
            else {
                await withTimeout(axios.get(`${CONFIG.INDEXER_URL}/health`, { timeout: 1000 }), 1000, 'Indexer Health');
                checks.services.indexer = 'ok';
            }
        } catch (err) {
            checks.services.indexer = 'down';
            checks.status = 'degraded';
        }

        checks.services.cache = getCacheHealthStatus();
        if (String(checks.services.cache).startsWith('degraded')) checks.status = 'degraded';
        res.status(checks.status === 'ok' ? 200 : 503).json(checks);
    });
}

module.exports = { registerApiRoutes };
