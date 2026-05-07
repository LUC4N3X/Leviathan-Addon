'use strict';

const axios = require('axios');
const runtimeState = require('../../runtime_state');
const { safeCompare } = require('../../utils/common');
const { getRequestOrigin } = require('../../utils/url');
const { validateConfig, MAX_CONFIG_LENGTH, decodeConfigBase64 } = require('../../config/schema');
const { getRecentStreamTraces } = require('../../lib/stream_trace');

const DEBRID_VALIDATE_TIMEOUT_MS = Math.max(1500, parseInt(process.env.DEBRID_VALIDATE_TIMEOUT_MS || '5000', 10) || 5000);

function isTruthyEnv(value) {
    return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function extractTelemetryPassword(req) {
    const rawAuthHeader = String(req.headers.authorization || '').trim();
    if (/^bearer\s+/i.test(rawAuthHeader)) return rawAuthHeader.replace(/^bearer\s+/i, '').trim();
    if (/^basic\s+/i.test(rawAuthHeader)) {
        try {
            const decoded = Buffer.from(rawAuthHeader.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf8');
            const colonIndex = decoded.indexOf(':');
            return colonIndex >= 0 ? decoded.slice(colonIndex + 1).trim() : decoded.trim();
        } catch (_) {
            return '';
        }
    }
    return String(req.headers['x-telemetry-pass'] || req.headers['x-admin-pass'] || '').trim();
}

function createTelemetryAuthMiddleware() {
    const telemetryPass = String(process.env.TELEMETRY_PASS || process.env.ADMIN_PASS || '').trim();
    const publicTelemetry = isTruthyEnv(process.env.PUBLIC_TELEMETRY);

    return (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (publicTelemetry) return next();
        if (!telemetryPass) {
            return res.status(503).json({
                error: 'Telemetry disabilitata: configura TELEMETRY_PASS o ADMIN_PASS, oppure PUBLIC_TELEMETRY=true.'
            });
        }

        const provided = extractTelemetryPassword(req);
        if (safeCompare(provided, telemetryPass)) return next();

        res.setHeader('WWW-Authenticate', 'Basic realm="Leviathan telemetry", charset="UTF-8"');
        return res.status(401).json({ error: 'Telemetry protetta: password mancante o non valida.' });
    };
}

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

async function runReadinessChecks({ dbHelper, withTimeout, CONFIG, getCacheHealthStatus, logger }) {
    const runtime = runtimeState.getSnapshot();
    const services = {};
    let ready = runtime?.lifecycle?.ready === true && runtime?.lifecycle?.draining !== true;
    let status = ready ? 'ready' : (runtime?.lifecycle?.draining ? 'draining' : 'starting');

    try {
        if (dbHelper.healthCheck) await withTimeout(dbHelper.healthCheck(), 1000, 'DB Health');
        services.database = 'ok';
    } catch (err) {
        services.database = 'down';
        ready = false;
        status = runtime?.lifecycle?.draining ? 'draining' : 'degraded';
        logger.error('Readiness DB Fail', { error: err.message });
    }

    try {
        if (!CONFIG.INDEXER_URL) services.indexer = 'disabled';
        else {
            await withTimeout(axios.get(`${CONFIG.INDEXER_URL}/health`, { timeout: 1000 }), 1000, 'Indexer Health');
            services.indexer = 'ok';
        }
    } catch (err) {
        services.indexer = 'down';
        ready = false;
        status = runtime?.lifecycle?.draining ? 'draining' : 'degraded';
    }

    services.cache = getCacheHealthStatus();
    if (String(services.cache).startsWith('degraded')) {
        ready = false;
        status = runtime?.lifecycle?.draining ? 'draining' : 'degraded';
    }

    return {
        ready,
        status,
        runtime,
        services,
        timestamp: new Date().toISOString()
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
    const telemetryAuthMiddleware = createTelemetryAuthMiddleware();

    app.get('/api/stats', telemetryAuthMiddleware, (req, res) => res.json(getStatsSnapshot()));
    app.get('/api/runtime', telemetryAuthMiddleware, (req, res) => res.json(runtimeState.getSnapshot()));
    app.get('/api/providers', telemetryAuthMiddleware, (req, res) => {
        const snapshot = getStatsSnapshot();
        res.json({
            runtime: snapshot?.runtime || runtimeState.getSnapshot(),
            providers: snapshot?.providers || {},
            sourceHealth: snapshot?.sourceHealth || {},
            limiters: snapshot?.limiters || {}
        });
    });
    app.get('/api/stream-traces', telemetryAuthMiddleware, (req, res) => {
        const limit = Math.max(1, Math.min(100, parseInt(req.query?.limit || '40', 10) || 40));
        res.json({
            ok: true,
            limit,
            traces: getRecentStreamTraces(limit)
        });
    });
    app.get('/api/cache-health', telemetryAuthMiddleware, (req, res) => {
        const snapshot = getStatsSnapshot();
        res.json(buildCacheHealthPayload(Cache, getCacheHealthStatus, snapshot));
    });

    async function decodeConfigForEditor(req, res) {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');

        try {
            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const rawToken = String(
                req.query?.conf ||
                req.query?.token ||
                body.conf ||
                body.token ||
                body.configToken ||
                body.manifestPath ||
                body.manifestUrl ||
                ''
            ).trim();

            if (!rawToken) {
                return res.status(400).json({
                    ok: false,
                    code: 'missing_config_token',
                    message: 'Token configurazione mancante.'
                });
            }

            const extractedToken = rawToken
                .replace(/^stremio:\/\//i, '')
                .split(/[?#]/)[0]
                .split('/')
                .filter(Boolean)
                .find((part) => part.length > 10 && !/^(?:configure|manifest\.json)$/i.test(part)) || rawToken;

            if (extractedToken.length > Math.max(MAX_CONFIG_LENGTH * 4, 65536)) {
                return res.status(413).json({
                    ok: false,
                    code: 'config_token_too_large',
                    message: 'Token configurazione troppo grande.'
                });
            }

            const decoded = decodeConfigBase64(extractedToken);
            const parsed = JSON.parse(decoded);
            const config = validateConfig(parsed);

            return res.json({
                ok: true,
                encrypted: /^lcfg1_/i.test(extractedToken),
                config
            });
        } catch (error) {
            logger.warn('[SECURITY] Config decode failed', { error: error.message });
            return res.status(400).json({
                ok: false,
                code: 'config_decode_failed',
                message: 'Impossibile leggere la configurazione salvata.'
            });
        }
    }

    app.get('/api/config/decode', decodeConfigForEditor);
    app.post('/api/config/decode', decodeConfigForEditor);

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
    app.get('/metrics', telemetryAuthMiddleware, (req, res) => {
        const snapshot = getStatsSnapshot();
        res.type('text/plain; version=0.0.4; charset=utf-8').send(buildPrometheusMetrics(snapshot));
    });
    app.get('/api/rd-scanner-status', telemetryAuthMiddleware, (req, res) => res.json(getRdAuditorStatus()));
    app.get('/api/rd-scanner-dashboard', telemetryAuthMiddleware, async (req, res) => {
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

    app.get('/livez', (req, res) => {
        const runtime = runtimeState.getSnapshot();
        res.status(200).json({
            status: 'alive',
            timestamp: new Date().toISOString(),
            pid: runtime.pid,
            uptimeSeconds: runtime.uptimeSeconds,
            runtime: {
                role: runtime.role,
                cluster: runtime.cluster,
                lifecycle: {
                    draining: runtime.lifecycle.draining,
                    activeRequests: runtime.lifecycle.activeRequests
                }
            }
        });
    });

    app.get('/readyz', async (req, res) => {
        const readiness = await runReadinessChecks({ dbHelper, withTimeout, CONFIG, getCacheHealthStatus, logger });
        res.status(readiness.ready ? 200 : 503).json(readiness);
    });

    app.get('/health', async (req, res) => {
        const readiness = await runReadinessChecks({ dbHelper, withTimeout, CONFIG, getCacheHealthStatus, logger });
        const status = readiness.ready ? 'ok' : readiness.status;
        res.status(readiness.ready ? 200 : 503).json({
            status,
            timestamp: readiness.timestamp,
            runtime: readiness.runtime,
            services: readiness.services
        });
    });
}

module.exports = { registerApiRoutes };
