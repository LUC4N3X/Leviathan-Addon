require('dotenv').config();

const cluster = require('cluster');
const os = require('os');
const { randomUUID } = require('crypto');
const express = require('express');
const path = require('path');
const runtimeState = require('./core/runtime_state');
const { logger, installConsoleBridge } = require('./core/utils/runtime');

installConsoleBridge(logger);

const LOCAL_NODE_ID = String(process.env.LEVI_NODE_ID || randomUUID());
process.env.LEVI_NODE_ID = LOCAL_NODE_ID;

function getAutoWorkerCap(cpuCount) {
    const raw = String(process.env.CLUSTER_WORKERS_AUTO_MAX || '').trim().toLowerCase();
    if (!raw || raw === 'cpu' || raw === 'cpus' || raw === 'max') return Math.max(1, cpuCount || 1);
    if (raw === 'none' || raw === 'off' || raw === 'unlimited') return Math.max(1, cpuCount || 1);
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(1, cpuCount || 1);
    return Math.max(1, Math.min(parsed, cpuCount || parsed));
}

function getClusterWorkerCount() {
    const raw = String(process.env.CLUSTER_WORKERS || '').trim().toLowerCase();
    const cpuCount = Math.max(1, os.cpus().length || 1);
    if (!raw) return 1;
    if (raw === 'auto') return getAutoWorkerCap(cpuCount);
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 1 ? Math.min(parsed, cpuCount) : 1;
}

function shouldUseCluster() {
    return getClusterWorkerCount() > 1;
}

function getClusterRestartPolicy() {
    return {
        windowMs: Math.max(15_000, parseInt(process.env.CLUSTER_RESTART_WINDOW_MS || String(2 * 60 * 1000), 10) || (2 * 60 * 1000)),
        maxRestarts: Math.max(2, parseInt(process.env.CLUSTER_MAX_RESTARTS_PER_WINDOW || '8', 10) || 8),
        baseBackoffMs: Math.max(500, parseInt(process.env.CLUSTER_RESTART_BASE_BACKOFF_MS || '1000', 10) || 1000),
        maxBackoffMs: Math.max(2_000, parseInt(process.env.CLUSTER_RESTART_MAX_BACKOFF_MS || String(30 * 1000), 10) || (30 * 1000))
    };
}

if (cluster.isPrimary && shouldUseCluster()) {
    const workerCount = getClusterWorkerCount();
    const restartPolicy = getClusterRestartPolicy();
    const slotState = new Map();
    const MAX_CLUSTER_RESTART_HISTORY = Math.max(4, parseInt(process.env.CLUSTER_RESTART_HISTORY_CAP || '16', 10) || 16);
    let shuttingDown = false;
    let primaryForceTimer = null;

    runtimeState.setClusterRole('primary', { enabled: true, leader: true, slot: -1 });
    console.log(`[CLUSTER] Primary ${process.pid} avvia ${workerCount} worker HTTP`);

    function getSlotStats(slot) {
        const key = Number(slot);
        if (!slotState.has(key)) {
            slotState.set(key, { restarts: [], spawnCount: 0, currentWorkerId: null });
        }
        return slotState.get(key);
    }

    function computeBackoffMs(slot) {
        const stats = getSlotStats(slot);
        const now = Date.now();
        stats.restarts = stats.restarts.filter((ts) => (now - ts) <= restartPolicy.windowMs).slice(-MAX_CLUSTER_RESTART_HISTORY);
        if (stats.restarts.length >= restartPolicy.maxRestarts) return restartPolicy.maxBackoffMs;
        const exponent = Math.max(0, stats.restarts.length - 1);
        return Math.min(restartPolicy.maxBackoffMs, restartPolicy.baseBackoffMs * (2 ** exponent));
    }

    function spawnWorker(slot, leader, delayMs = 0) {
        const boot = () => {
            if (shuttingDown) return;
            const stats = getSlotStats(slot);
            stats.spawnCount += 1;
            const worker = cluster.fork({
                LEVI_CLUSTER_HTTP: '1',
                LEVI_CLUSTER_LEADER: leader ? 'true' : 'false',
                LEVI_CLUSTER_SLOT: String(slot),
                LEVI_NODE_ID: LOCAL_NODE_ID
            });
            stats.currentWorkerId = worker.id;
            worker.__leviSlot = slot;
            worker.__leviLeader = leader;
            console.log(`[CLUSTER] Spawn worker slot=${slot} pid=${worker.process.pid} leader=${leader}`);
        };

        if (delayMs > 0) {
            console.warn(`[CLUSTER] Respawn worker slot=${slot} in ${delayMs}ms`);
            const timer = setTimeout(boot, delayMs);
            timer.unref();
            return;
        }
        boot();
    }

    for (let i = 0; i < workerCount; i += 1) {
        spawnWorker(i, i === 0, 0);
    }

    cluster.on('exit', (worker, code, signal) => {
        const slot = Number.isInteger(worker.__leviSlot) ? worker.__leviSlot : 0;
        const stats = getSlotStats(slot);
        stats.restarts.push(Date.now());
        if (stats.restarts.length > MAX_CLUSTER_RESTART_HISTORY) stats.restarts = stats.restarts.slice(-MAX_CLUSTER_RESTART_HISTORY);
        stats.currentWorkerId = null;
        console.warn(`[CLUSTER] Worker ${worker.process.pid} terminato (slot=${slot} code=${code} signal=${signal || 'n/a'})`);

        if (shuttingDown) {
            if (Object.keys(cluster.workers || {}).length === 0) {
                if (primaryForceTimer) clearTimeout(primaryForceTimer);
                slotState.clear();
                process.exit(0);
            }
            return;
        }

        const delayMs = computeBackoffMs(slot);
        const shouldLead = worker.__leviLeader === true || slot === 0;
        spawnWorker(slot, shouldLead, delayMs);
    });

    function gracefulPrimaryShutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        runtimeState.markDraining(`primary_${signal}`, { rejectNewRequests: true });
        console.log(`[CLUSTER] Primary riceve ${signal}, arresto coordinato dei worker...`);

        primaryForceTimer = setTimeout(() => {
            console.error('[CLUSTER] Timeout shutdown primary, kill forzato dei worker.');
            for (const worker of Object.values(cluster.workers || {})) {
                try { worker.process.kill('SIGKILL'); } catch (_) {}
            }
            slotState.clear();
            process.exit(1);
        }, Math.max(5000, parseInt(process.env.SHUTDOWN_FORCE_MS || '15000', 10) || 15000));
        primaryForceTimer.unref();

        const workers = Object.values(cluster.workers || {});
        if (workers.length === 0) {
            clearTimeout(primaryForceTimer);
            slotState.clear();
            process.exit(0);
        }
        for (const worker of workers) {
            try { worker.process.kill(signal); } catch (_) {}
        }
    }

    process.on('SIGTERM', () => gracefulPrimaryShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulPrimaryShutdown('SIGINT'));
    return;
}

const dbHelper = require('./core/storage/db_repository');
const { getManifest } = require('./manifest');
const { handleVixSynthetic } = require('./providers/streamingcommunity/vix_proxy');
const {
    Cache,
    LIMITERS,
    CONFIG,
    ADMIN_PASS,
    cloudBuildInflight,
    safeCompare,
    getConfig,
    validateStreamRequest,
    withTimeout,
    buildTrackerMagnet,
    getStatsSnapshot,
    recordDuration,
    recordProviderMetric,
    incrementMetric,
    streamInflight
} = require('./core/utils');
const { generateStream, resolveLazyStreamData } = require('./core/stream_generator');
const { bootRealDebridAuditor } = require('./core/server/bootstrap/rd_auditor_boot');
const { applyCommonMiddleware } = require('./core/server/middleware');
const { createAppServices } = require('./core/server/services/app_services');
const { registerApiRoutes } = require('./core/server/routes/api_routes');
const { registerPlaybackRoutes } = require('./core/server/routes/playback_routes');
const { registerAdminRoutes } = require('./core/server/routes/admin_routes');
const { registerStremioRoutes } = require('./core/server/routes/stremio_routes');

function startSharedStreamCacheCleanupJob({ dbHelper, logger, enabled }) {
    if (!enabled) return null;
    if (!dbHelper || typeof dbHelper.cleanupExpiredSharedStreamCache !== 'function') return null;

    const intervalMs = Math.max(60 * 1000, parseInt(process.env.SHARED_STREAM_CACHE_CLEANUP_INTERVAL_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000));
    const batchLimit = Math.max(100, parseInt(process.env.SHARED_STREAM_CACHE_CLEANUP_BATCH || '5000', 10) || 5000);
    const maxBatchesPerRun = Math.max(1, Math.min(12, parseInt(process.env.SHARED_STREAM_CACHE_CLEANUP_MAX_BATCHES || '4', 10) || 4));
    const initialDelayMs = Math.max(5 * 1000, parseInt(process.env.SHARED_STREAM_CACHE_CLEANUP_BOOT_DELAY_MS || String(30 * 1000), 10) || (30 * 1000));
    const vacuumThreshold = Math.max(batchLimit, parseInt(process.env.SHARED_STREAM_CACHE_VACUUM_THRESHOLD || String(batchLimit * 2), 10) || (batchLimit * 2));
    const vacuumCooldownMs = Math.max(5 * 60 * 1000, parseInt(process.env.SHARED_STREAM_CACHE_VACUUM_COOLDOWN_MS || String(60 * 60 * 1000), 10) || (60 * 60 * 1000));
    let lastVacuumAt = 0;
    let vacuumInFlight = false;

    const maybeVacuum = async (totalDeleted) => {
        if (totalDeleted < vacuumThreshold) return false;
        if (vacuumInFlight) {
            incrementMetric('sharedStreamCacheCleanup.vacuumSkippedBusy');
            return false;
        }
        if ((Date.now() - lastVacuumAt) < vacuumCooldownMs) {
            incrementMetric('sharedStreamCacheCleanup.vacuumSkippedCooldown');
            return false;
        }
        if (typeof dbHelper.vacuumAnalyzeSharedStreamCache !== 'function') return false;

        vacuumInFlight = true;
        const startedAt = Date.now();
        try {
            const ok = await dbHelper.vacuumAnalyzeSharedStreamCache();
            if (ok) {
                lastVacuumAt = Date.now();
                incrementMetric('sharedStreamCacheCleanup.vacuumRuns');
                recordDuration('sharedStreamCacheCleanup.vacuum', Date.now() - startedAt);
                logger.info(`[CACHE] Shared stream VACUUM ANALYZE completato | deleted=${totalDeleted}`);
                return true;
            }
        } catch (error) {
            incrementMetric('sharedStreamCacheCleanup.vacuumErrors');
            logger.warn(`[CACHE] Shared stream VACUUM ANALYZE failed | error=${error.message}`);
        } finally {
            vacuumInFlight = false;
        }
        return false;
    };

    const runCleanup = async () => {
        const startedAt = Date.now();
        let totalDeleted = 0;
        let batches = 0;
        try {
            for (let index = 0; index < maxBatchesPerRun; index += 1) {
                const deleted = await dbHelper.cleanupExpiredSharedStreamCache({ limit: batchLimit });
                batches += 1;
                totalDeleted += deleted;
                if (deleted < batchLimit) break;
            }

            incrementMetric('sharedStreamCacheCleanup.runs');
            if (totalDeleted > 0) {
                incrementMetric('sharedStreamCacheCleanup.deletedRows', totalDeleted);
                logger.info(`[CACHE] Shared stream cleanup | deleted=${totalDeleted} | batches=${batches} | batchSize=${batchLimit}`);
                await maybeVacuum(totalDeleted);
            }
        } catch (error) {
            incrementMetric('sharedStreamCacheCleanup.errors');
            logger.warn(`[CACHE] Shared stream cleanup failed | error=${error.message}`);
        } finally {
            recordDuration('sharedStreamCacheCleanup.run', Date.now() - startedAt);
        }
    };

    const bootstrapTimer = setTimeout(() => {
        runCleanup().catch(() => {});
    }, initialDelayMs);
    bootstrapTimer.unref();

    const timer = setInterval(() => {
        runCleanup().catch(() => {});
    }, intervalMs);
    timer.unref();

    return {
        stop() {
            clearTimeout(bootstrapTimer);
            clearInterval(timer);
        }
    };
}

function bootstrapServer() {
    const app = express();
    const publicDir = path.join(__dirname, 'public');
    const isClusterWorker = String(process.env.LEVI_CLUSTER_HTTP || '0').toLowerCase() === '1';
    const isClusterLeader = String(process.env.LEVI_CLUSTER_LEADER || 'false').toLowerCase() === 'true';
    const clusterSlot = Number.parseInt(process.env.LEVI_CLUSTER_SLOT || '-1', 10);
    runtimeState.markNotReady('booting');
    runtimeState.setClusterRole(isClusterWorker ? 'worker' : 'standalone', {
        enabled: isClusterWorker,
        leader: isClusterLeader,
        slot: Number.isInteger(clusterSlot) ? clusterSlot : -1
    });

    if (shouldUseCluster() && !isClusterLeader) {
        process.env.RD_CACHE_SCANNER_ENABLED = 'false';
    }

    dbHelper.initDatabase();
    if (Cache && typeof Cache.startInvalidationSync === 'function') {
        Cache.startInvalidationSync().catch((error) => {
            logger.warn(`[CACHE] Invalidation sync bootstrap failed: ${error.message}`);
        });
    }

    const { getRdAuditorStatus } = bootRealDebridAuditor({
        dbHelper,
        logger,
        Cache
    });

    const appServices = createAppServices({
        Cache,
        LIMITERS,
        cloudBuildInflight,
        buildTrackerMagnet,
        dbHelper,
        logger,
        recordDuration,
        recordProviderMetric
    });

    const sharedStreamCleanupJob = startSharedStreamCacheCleanupJob({
        dbHelper,
        logger,
        enabled: String(process.env.SHARED_STREAM_CACHE_ENABLED || 'true').toLowerCase() !== 'false' && (isClusterLeader || !shouldUseCluster())
    });

    applyCommonMiddleware(app, { staticDir: publicDir });

    registerApiRoutes(app, {
        getStatsSnapshot,
        getRdAuditorStatus,
        dbHelper,
        Cache,
        withTimeout,
        CONFIG,
        logger,
        getCacheHealthStatus: appServices.getCacheHealthStatus
    });

    registerPlaybackRoutes(app, {
        Cache,
        LIMITERS,
        getConfig,
        buildTrackerMagnet,
        resolveLazyStreamData,
        logger,
        recordDuration,
        recordProviderMetric,
        incrementMetric,
        markPlayableResultAsCached: appServices.markPlayableResultAsCached,
        queueCloudBuild: appServices.queueCloudBuild,
        getBuildKey: appServices.getBuildKey
    });

    registerAdminRoutes(app, {
        Cache,
        ADMIN_PASS,
        safeCompare,
        dbHelper,
        logger,
        queueCloudBuild: appServices.queueCloudBuild
    });

    registerStremioRoutes(app, {
        publicDir,
        getManifest,
        handleVixSynthetic,
        cloneManifest: appServices.cloneManifest,
        getConfig,
        validateStreamRequest,
        generateStream,
        logger,
        streamInflight,
        Cache
    });

    const PORT = process.env.PORT || 7000;
    const server = app.listen(PORT, () => {
        server.keepAliveTimeout = Math.max(5000, parseInt(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || '65000', 10) || 65000);
        server.headersTimeout = Math.max(server.keepAliveTimeout + 1000, parseInt(process.env.HTTP_HEADERS_TIMEOUT_MS || '70000', 10) || 70000);
        console.log(`[BOOT] Leviathan (God Tier) attivo su porta interna ${PORT}`);
        console.log('-----------------------------------------------------');
        console.log(`[MODE] FULL LAZY`);
        console.log(`[SERIES] Full Lazy Mode`);
        console.log(`[INDEXER] URL: ${CONFIG.INDEXER_URL}`);
        console.log(`[METADATA] TMDB Primary`);
        console.log(`[DB WRITE] Locale`);
        console.log(`[DB READ] Locale attiva`);
        console.log(`[SPETTRO] Modulo Attivo`);
        console.log(`[SIZE LIMITER] Modulo Attivo`);
        console.log(`[GUARDA HD] Modulo integrato e pronto`);
        console.log(`[GUARDA SERIE] Modulo integrato e pronto`);
        console.log(`[ANIMEWORLD] Modulo integrato e pronto`);
        console.log(`[GUARDAFLIX] Modulo integrato`);
        console.log(`[CINEMACITY] Modulo integrato`);
        console.log(`[TRAILER] Attivabile da config`);
        console.log(`📦 TORBOX: ADVANCED SMART CACHE`);
        console.log(`[PARSER] Enhanced`);
        console.log(`[P2P] Handler attivo`);
        console.log(`[CORE] Optimized for High Reliability`);
        console.log(`[CACHE] Global raw + user level active`);
        console.log(`[CACHE] Shared L2 ${process.env.SHARED_STREAM_CACHE_ENABLED === 'false' ? 'disabled' : 'active'}`);
        console.log(`[SCRAPERS] Fallback scrapers ready`);
        console.log(`[NODE] instance=${LOCAL_NODE_ID}`);
        if (shouldUseCluster()) console.log(`[CLUSTER] worker=${process.pid} leader=${isClusterLeader} slot=${clusterSlot}`);
        console.log('-----------------------------------------------------');
        runtimeState.markReady('http_listening');
    });

    let shuttingDown = false;

    function gracefulShutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        runtimeState.markDraining(signal, { rejectNewRequests: true });
        logger.info(`[SHUTDOWN] Ricevuto ${signal}, chiusura server in corso...`);

        const forceTimer = setTimeout(() => {
            logger.error('[SHUTDOWN] Shutdown forzato per timeout.');
            process.exit(1);
        }, Math.max(5000, parseInt(process.env.SHUTDOWN_FORCE_MS || '12000', 10) || 12000));
        forceTimer.unref();

        server.close(async () => {
            try {
                if (sharedStreamCleanupJob && typeof sharedStreamCleanupJob.stop === 'function') {
                    sharedStreamCleanupJob.stop();
                }
                if (Cache && typeof Cache.stopInvalidationSync === 'function') {
                    await Cache.stopInvalidationSync();
                }
                if (typeof dbHelper.shutdownDatabase === 'function') {
                    await dbHelper.shutdownDatabase();
                }
                logger.info('[SHUTDOWN] Server HTTP e DB chiusi correttamente.');
                clearTimeout(forceTimer);
                process.exit(0);
            } catch (error) {
                logger.error('[SHUTDOWN] Errore durante la chiusura', { error: error.message });
                process.exit(1);
            }
        });
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled Promise Rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
    });
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
        runtimeState.markDraining('uncaught_exception', { rejectNewRequests: true });
        setTimeout(() => process.exit(1), 250).unref();
    });
}

bootstrapServer();
