'use strict';

const axios = require('axios');
const runtimeState = require('../../runtime_state');

const DEBRID_VALIDATE_TIMEOUT_MS = Math.max(1500, parseInt(process.env.DEBRID_VALIDATE_TIMEOUT_MS || '5000', 10) || 5000);

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

    pushMetric(lines, 'leviathan_runtime_draining', 'gauge', 'Whether the instance is draining.', snapshot?.runtime?.lifecycle?.draining ? 1 : 0);
    pushMetric(lines, 'leviathan_runtime_active_requests', 'gauge', 'Current active HTTP requests.', Number(snapshot?.runtime?.lifecycle?.activeRequests || 0));

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

function buildCacheHealthPayload(Cache, getCacheHealthStatus, snapshot) {
    return {
        status: getCacheHealthStatus(),
        runtime: snapshot?.runtime || runtimeState.getSnapshot(),
        streamIndex: typeof Cache.getStreamCacheIndexStats === 'function' ? Cache.getStreamCacheIndexStats() : null,
        counters: snapshot?.cache || null
    };
}

async function validateRealDebridKey(key) {
    try {
        const response = await axios.get('https://api.real-debrid.com/rest/1.0/user', {
            headers: {
                Authorization: `Bearer ${key}`
            },
            timeout: DEBRID_VALIDATE_TIMEOUT_MS,
            validateStatus: () => true
        });

        if (response.status >= 200 && response.status < 300 && response.data) {
            return {
                ok: true,
                service: 'rd',
                code: 'ok',
                username: String(response.data.username || '').trim() || null,
                email: String(response.data.email || '').trim() || null,
                type: String(response.data.type || '').trim() || null,
                expiration: response.data.expiration || null,
                points: Number(response.data.points || 0) || 0,
                message: 'Token Real-Debrid valido.'
            };
        }

        if (response.status === 401 || response.status === 403) {
            return {
                ok: false,
                service: 'rd',
                code: 'invalid_token',
                message: 'Token Real-Debrid non valido o scaduto.'
            };
        }

        if (response.status === 429) {
            return {
                ok: false,
                service: 'rd',
                code: 'rate_limited',
                transient: true,
                message: 'Real-Debrid sta limitando le richieste. Riprova tra poco.'
            };
        }

        return {
            ok: false,
            service: 'rd',
            code: `http_${Number(response.status || 0) || 0}`,
            transient: true,
            message: 'Real-Debrid non ha risposto correttamente alla verifica.'
        };
    } catch (error) {
        const timeout = error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''));
        return {
            ok: false,
            service: 'rd',
            code: timeout ? 'timeout' : 'network_error',
            transient: true,
            message: timeout
                ? 'Timeout durante la verifica di Real-Debrid.'
                : 'Errore di rete durante la verifica di Real-Debrid.'
        };
    }
}

async function validateTorBoxKey(key) {
    try {
        const response = await axios.get('https://api.torbox.app/v1/api/torrents/mylist', {
            headers: {
                Authorization: `Bearer ${key}`,
                Accept: 'application/json'
            },
            params: {
                bypass_cache: true
            },
            timeout: DEBRID_VALIDATE_TIMEOUT_MS,
            validateStatus: () => true
        });

        if (response.status >= 200 && response.status < 300) {
            const items = Array.isArray(response.data?.data)
                ? response.data.data.length
                : (response.data?.data ? 1 : 0);
            return {
                ok: true,
                service: 'tb',
                code: 'ok',
                items,
                message: 'Token TorBox valido.'
            };
        }

        if (response.status === 401 || response.status === 403) {
            return {
                ok: false,
                service: 'tb',
                code: 'invalid_token',
                message: 'Token TorBox non valido o scaduto.'
            };
        }

        if (response.status === 429) {
            return {
                ok: false,
                service: 'tb',
                code: 'rate_limited',
                transient: true,
                message: 'TorBox sta limitando le richieste. Riprova tra poco.'
            };
        }

        return {
            ok: false,
            service: 'tb',
            code: `http_${Number(response.status || 0) || 0}`,
            transient: true,
            message: 'TorBox non ha risposto correttamente alla verifica.'
        };
    } catch (error) {
        const timeout = error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''));
        return {
            ok: false,
            service: 'tb',
            code: timeout ? 'timeout' : 'network_error',
            transient: true,
            message: timeout
                ? 'Timeout durante la verifica di TorBox.'
                : 'Errore di rete durante la verifica di TorBox.'
        };
    }
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
    app.get('/api/runtime', (req, res) => res.json(runtimeState.getSnapshot()));
    app.get('/api/providers', (req, res) => {
        const snapshot = getStatsSnapshot();
        res.json({
            runtime: snapshot?.runtime || runtimeState.getSnapshot(),
            providers: snapshot?.providers || {},
            sourceHealth: snapshot?.sourceHealth || {},
            limiters: snapshot?.limiters || {}
        });
    });
    app.get('/api/cache-health', (req, res) => {
        const snapshot = getStatsSnapshot();
        res.json(buildCacheHealthPayload(Cache, getCacheHealthStatus, snapshot));
    });
    app.post('/api/debrid/validate', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        const service = String(req.body?.service || '').trim().toLowerCase();
        const key = String(req.body?.key || req.body?.apiKey || '').trim();

        if (!service) {
            return res.status(400).json({
                ok: false,
                code: 'missing_service',
                message: 'Specifica il servizio Debrid da verificare.'
            });
        }

        if (!['rd', 'tb'].includes(service)) {
            return res.status(501).json({
                ok: false,
                supported: false,
                service,
                code: 'unsupported_service',
                message: 'Verifica live disponibile solo per Real-Debrid e TorBox.'
            });
        }

        if (!key) {
            return res.status(400).json({
                ok: false,
                service,
                code: 'missing_key',
                message: 'Inserisci una API key da verificare.'
            });
        }

        const payload = service === 'tb'
            ? await validateTorBoxKey(key)
            : await validateRealDebridKey(key);
        const statusCode = payload.ok
            ? 200
            : payload.code === 'invalid_token'
                ? 401
                : payload.code === 'rate_limited'
                    ? 429
                    : 502;

        return res.status(statusCode).json(payload);
    });
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
        const runtime = runtimeState.getSnapshot();
        const checks = { status: runtime.lifecycle.draining ? 'draining' : 'ok', timestamp: new Date().toISOString(), runtime, services: {} };
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
        const httpStatus = checks.status === 'ok' ? 200 : checks.status === 'draining' ? 503 : 503;
        res.status(httpStatus).json(checks);
    });
}

module.exports = { registerApiRoutes };
