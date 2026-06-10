require('dotenv').config();

const { logger, installConsoleBridge } = require('./core/utils/runtime');
const { getLocalNodeId, maybeRunPrimaryCluster, shouldUseCluster } = require('./core/server/cluster_runtime');

installConsoleBridge(logger);

if (maybeRunPrimaryCluster()) {
    return;
}

const express = require('express');
const path = require('path');
const runtimeState = require('./core/runtime_state');

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function shouldStartInlineBackgroundWorkers() {
    return envFlag('LEVIATHAN_API_BACKGROUND_WORKERS', false);
}

const dbHelper = require('./core/storage/db_repository');
const { getManifest } = require('./manifest');
const { handleVixSynthetic } = require('./providers/streamingcommunity/vix_proxy');
const { handleCinemaCityProxy, CC_MANIFEST_ROUTE, CC_STREAM_ROUTE } = require('./providers/cinemacity/cc_proxy');
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
const { generateStream, resolveLazyStreamData, normalizeExternalCandidateForPipeline } = require('./core/stream_generator');
const { createTorrentioTmdbScanner } = require('./core/prewarm/torrentio_tmdb_scanner');
const { bootRealDebridAuditor } = require('./core/debrid/rd/audit/rd_auditor_boot');
const { applyCommonMiddleware } = require('./core/server/middleware');
const { applyEdgeGatewayGuard } = require('./core/server/edge_gateway');
const { getRawStreamCacheStats } = require('./core/cache/raw_stream_cache');
const { createAppServices } = require('./core/server/services/app_services');
const { registerApiRoutes } = require('./core/server/routes/api_routes');
const { registerPlaybackRoutes } = require('./core/server/routes/playback_routes');
const { registerAdminRoutes } = require('./core/server/routes/admin_routes');
const { registerStremioRoutes } = require('./core/server/routes/stremio_routes');
const { registerEdgeRoutes } = require('./core/server/routes/edge_routes');

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

    const torrentioTmdbScanner = createTorrentioTmdbScanner({
        dbHelper,
        logger,
        normalizeExternalCandidateForPipeline
    });
    const inlineBackgroundWorkers = shouldStartInlineBackgroundWorkers();
    if (inlineBackgroundWorkers) {
        torrentioTmdbScanner.start({ leader: isClusterLeader || !shouldUseCluster() });
    } else {
        logger.info('[WORKER] API background scanner disabled; use npm run worker / leviathan-worker for scraping outside HTTP requests');
    }

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

    applyEdgeGatewayGuard(app);

    if (typeof handleCinemaCityProxy === 'function') {
        app.all(CC_MANIFEST_ROUTE, handleCinemaCityProxy);
        app.all(CC_STREAM_ROUTE, handleCinemaCityProxy);
    }

    const sharedStreamCleanupJob = startSharedStreamCacheCleanupJob({
        dbHelper,
        logger,
        enabled: String(process.env.SHARED_STREAM_CACHE_ENABLED || 'true').toLowerCase() !== 'false' && (isClusterLeader || !shouldUseCluster())
    });

    applyCommonMiddleware(app, { staticDir: publicDir });

    registerEdgeRoutes(app, { logger });

    registerApiRoutes(app, {
        getStatsSnapshot,
        getRdAuditorStatus,
        dbHelper,
        Cache,
        withTimeout,
        CONFIG,
        logger,
        getCacheHealthStatus: appServices.getCacheHealthStatus,
        publicDir,
        torrentioTmdbScanner
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
        markPlayableResultAsUnavailable: appServices.markPlayableResultAsUnavailable,
        queueCloudBuild: appServices.queueCloudBuild,
        getBuildKey: appServices.getBuildKey,
        dbHelper
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
        handleCinemaCityProxy,
        cinemaCityProxyRoutes: { manifest: CC_MANIFEST_ROUTE, stream: CC_STREAM_ROUTE },
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
        console.log(`[WORKER] API inline background scanner: ${inlineBackgroundWorkers ? 'enabled' : 'disabled (separate worker)'}`);
        console.log(`[CACHE] Global raw + user level active`);
        console.log(`[CACHE] Shared L2 ${process.env.SHARED_STREAM_CACHE_ENABLED === 'false' ? 'disabled' : 'active'}`);
        const rawStreamCacheStats = getRawStreamCacheStats();
        console.log(`[RAW CACHE] active compressed=${rawStreamCacheStats.compressed} ttl=${rawStreamCacheStats.ttlSeconds}s maxBytes=${rawStreamCacheStats.maxBytes}`);
        console.log(`[RANK] Seed health smart gate active healthy>=5 weak>=1`);
        console.log(`[TRACKER] Enricher active + availability cache infoHash:fileIdx`);
        console.log(`[EDGE] Gateway guard ${process.env.LEVIATHAN_EDGE_ENABLED === 'true' ? 'enabled' : 'optional/disabled'}`);
        console.log(`[PROXY HEADERS] normalizer active referer/origin/auth/range dedupe`);
        console.log(`[SECURITY] API guard active + plain config token mode`);
        console.log(`[SCRAPERS] Fallback scrapers ready`);
        console.log(`[NODE] instance=${getLocalNodeId()}`);
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
                if (torrentioTmdbScanner && typeof torrentioTmdbScanner.stop === 'function') {
                    await torrentioTmdbScanner.stop();
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
