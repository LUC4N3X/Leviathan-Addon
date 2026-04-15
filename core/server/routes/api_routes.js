'use strict';

const axios = require('axios');

function escapeLabelValue(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/"/g, '\\"');
}

function metricName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}

function pushMetric(lines, name, type, help, value, labels = null) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;

    const normalizedName = metricName(name);
    if (!lines.__meta.has(normalizedName)) {
        lines.push(`# HELP ${normalizedName} ${help}`);
        lines.push(`# TYPE ${normalizedName} ${type}`);
        lines.__meta.add(normalizedName);
    }

    const labelPart = labels && Object.keys(labels).length > 0
        ? `{${Object.entries(labels)
            .map(([key, labelValue]) => `${metricName(key)}="${escapeLabelValue(labelValue)}"`)
            .join(',')}}`
        : '';

    lines.push(`${normalizedName}${labelPart} ${numericValue}`);
}

function buildPrometheusMetrics(snapshot) {
    const lines = [];
    lines.__meta = new Set();

    const startedAt = Date.parse(snapshot?.startedAt || 0);
    pushMetric(lines, 'leviathan_uptime_seconds', 'gauge', 'Process uptime in seconds.', Number(snapshot?.uptimeSec || 0));
    if (Number.isFinite(startedAt) && startedAt > 0) {
        pushMetric(lines, 'leviathan_started_at_seconds', 'gauge', 'Unix start timestamp.', Math.floor(startedAt / 1000));
    }

    for (const [kind, count] of Object.entries(snapshot?.inflight || {})) {
        pushMetric(lines, 'leviathan_inflight_requests', 'gauge', 'Current inflight operations by kind.', Number(count || 0), { kind });
    }

    for (const [cacheName, stats] of Object.entries(snapshot?.cache || {})) {
        if (!stats || typeof stats !== 'object' || Array.isArray(stats)) continue;
        if (typeof stats.hit === 'number') pushMetric(lines, 'leviathan_cache_hits_total', 'counter', 'Cache hits by cache bucket.', stats.hit, { cache: cacheName });
        if (typeof stats.miss === 'number') pushMetric(lines, 'leviathan_cache_misses_total', 'counter', 'Cache misses by cache bucket.', stats.miss, { cache: cacheName });
        if (typeof stats.set === 'number') pushMetric(lines, 'leviathan_cache_sets_total', 'counter', 'Cache sets by cache bucket.', stats.set, { cache: cacheName });
        if (typeof stats.hitRate === 'number') pushMetric(lines, 'leviathan_cache_hit_rate', 'gauge', 'Cache hit rate percentage.', stats.hitRate, { cache: cacheName });

        for (const [subKey, subValue] of Object.entries(stats)) {
            if (['hit', 'miss', 'set', 'hitRate'].includes(subKey)) continue;
            if (typeof subValue === 'number') {
                pushMetric(lines, 'leviathan_cache_detail', 'gauge', 'Additional cache details.', subValue, { cache: cacheName, metric: subKey });
            }
        }
    }

    for (const [name, value] of Object.entries(snapshot?.counters || {})) {
        pushMetric(lines, 'leviathan_counter_total', 'counter', 'Custom runtime counters.', Number(value || 0), { name });
    }

    for (const [name, timer] of Object.entries(snapshot?.timers || {})) {
        if (!timer || typeof timer !== 'object') continue;
        if (typeof timer.count === 'number') pushMetric(lines, 'leviathan_timer_count', 'counter', 'Number of timer samples.', timer.count, { name });
        if (typeof timer.totalMs === 'number') pushMetric(lines, 'leviathan_timer_total_milliseconds', 'counter', 'Total accumulated milliseconds.', timer.totalMs, { name });
        if (typeof timer.avgMs === 'number') pushMetric(lines, 'leviathan_timer_avg_milliseconds', 'gauge', 'Average milliseconds.', timer.avgMs, { name });
        if (typeof timer.minMs === 'number' && Number.isFinite(timer.minMs)) pushMetric(lines, 'leviathan_timer_min_milliseconds', 'gauge', 'Minimum milliseconds.', timer.minMs, { name });
        if (typeof timer.maxMs === 'number') pushMetric(lines, 'leviathan_timer_max_milliseconds', 'gauge', 'Maximum milliseconds.', timer.maxMs, { name });
    }

    for (const [provider, stats] of Object.entries(snapshot?.providers || {})) {
        if (!stats || typeof stats !== 'object') continue;
        for (const metricKey of ['calls', 'ok', 'fail', 'timeout', 'totalMs', 'avgMs']) {
            if (typeof stats[metricKey] !== 'number') continue;
            const metricType = metricKey === 'avgMs' ? 'gauge' : 'counter';
            pushMetric(lines, 'leviathan_provider_metric', metricType, 'Per-provider runtime metrics.', stats[metricKey], { provider, metric: metricKey });
        }
        const lastSeenAt = Date.parse(stats.lastSeenAt || 0);
        if (Number.isFinite(lastSeenAt) && lastSeenAt > 0) {
            pushMetric(lines, 'leviathan_provider_last_seen_seconds', 'gauge', 'Unix timestamp of last provider activity.', Math.floor(lastSeenAt / 1000), { provider });
        }
    }

    for (const [limiter, stats] of Object.entries(snapshot?.limiters || {})) {
        if (!stats || typeof stats !== 'object') continue;
        for (const [metric, value] of Object.entries(stats)) {
            if (typeof value === 'number') {
                pushMetric(lines, 'leviathan_limiter_metric', 'gauge', 'Limiter counts and queue depth.', value, { limiter, metric });
            }
        }
    }

    for (const [source, stats] of Object.entries(snapshot?.sourceHealth || {})) {
        if (!stats || typeof stats !== 'object') continue;
        for (const [metric, value] of Object.entries(stats)) {
            if (typeof value === 'number') {
                pushMetric(lines, 'leviathan_source_health_metric', 'gauge', 'Source health values.', value, { source, metric });
            }
        }
    }

    delete lines.__meta;
    return `${lines.join('\n')}\n`;
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
        res.type('text/plain; version=0.0.4; charset=utf-8').send(buildPrometheusMetrics(snapshot));
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
