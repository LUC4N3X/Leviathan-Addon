require('dotenv').config();

const cluster = require('cluster');
const os = require('os');
const express = require('express');
const path = require('path');

function getClusterWorkerCount() {
    const raw = String(process.env.CLUSTER_WORKERS || '').trim().toLowerCase();
    if (!raw) return 1;
    if (raw === 'auto') return Math.max(1, Math.min(os.cpus().length || 1, 4));
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 1 ? Math.min(parsed, os.cpus().length || parsed) : 1;
}

function shouldUseCluster() {
    return getClusterWorkerCount() > 1;
}

if (cluster.isPrimary && shouldUseCluster()) {
    const workerCount = getClusterWorkerCount();
    console.log(`[CLUSTER] Primary ${process.pid} avvia ${workerCount} worker HTTP`);

    for (let i = 0; i < workerCount; i += 1) {
        cluster.fork({
            LEVI_CLUSTER_HTTP: '1',
            LEVI_CLUSTER_LEADER: i === 0 ? 'true' : 'false'
        });
    }

    cluster.on('exit', (worker, code, signal) => {
        console.warn(`[CLUSTER] Worker ${worker.process.pid} terminato (code=${code} signal=${signal || 'n/a'})`);
        cluster.fork({
            LEVI_CLUSTER_HTTP: '1',
            LEVI_CLUSTER_LEADER: 'false'
        });
    });
    return;
}

const dbHelper = require('./core/storage/db_repository');
const { getManifest } = require('./manifest');
const { handleVixSynthetic } = require('./providers/streamingcommunity/vix_proxy');
const {
    logger,
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
    incrementMetric
} = require('./core/utils');
const { generateStream, resolveLazyStreamData } = require('./core/stream_generator');
const { bootRealDebridAuditor } = require('./core/server/bootstrap/rd_auditor_boot');
const { applyCommonMiddleware } = require('./core/server/middleware');
const { createAppServices } = require('./core/server/services/app_services');
const { registerApiRoutes } = require('./core/server/routes/api_routes');
const { registerPlaybackRoutes } = require('./core/server/routes/playback_routes');
const { registerAdminRoutes } = require('./core/server/routes/admin_routes');
const { registerStremioRoutes } = require('./core/server/routes/stremio_routes');

function bootstrapServer() {
    const app = express();
    const publicDir = path.join(__dirname, 'public');
    const isClusterLeader = String(process.env.LEVI_CLUSTER_LEADER || 'false').toLowerCase() === 'true';
    if (shouldUseCluster() && !isClusterLeader) {
        process.env.RD_CACHE_SCANNER_ENABLED = 'false';
    }

    dbHelper.initDatabase();

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
        safeCompare
    });

    registerStremioRoutes(app, {
        publicDir,
        getManifest,
        handleVixSynthetic,
        cloneManifest: appServices.cloneManifest,
        getConfig,
        validateStreamRequest,
        generateStream,
        logger
    });

    const PORT = process.env.PORT || 7000;
    const server = app.listen(PORT, () => {
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
        console.log(`[WEBSTREAMR] Fallback attivo`);
        console.log(`[TRAILER] Attivabile da config`);
        console.log(`📦 TORBOX: ADVANCED SMART CACHE`);
        console.log(`[PARSER] Enhanced`);
        console.log(`[P2P] Handler attivo`);
        console.log(`[CORE] Optimized for High Reliability`);
        console.log(`[CACHE] Global raw + user level active`);
        console.log(`[CACHE] Shared L2 ${process.env.SHARED_STREAM_CACHE_ENABLED === 'false' ? 'disabled' : 'active'}`);
        console.log(`[SCRAPERS] Fallback scrapers ready`);
        if (shouldUseCluster()) console.log(`[CLUSTER] worker=${process.pid} leader=${isClusterLeader}`);
        console.log('-----------------------------------------------------');
    });

    let shuttingDown = false;

    function gracefulShutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`[SHUTDOWN] Ricevuto ${signal}, chiusura server in corso...`);

        const forceTimer = setTimeout(() => {
            logger.error('[SHUTDOWN] Shutdown forzato per timeout.');
            process.exit(1);
        }, 10000);
        forceTimer.unref();

        server.close(async () => {
            try {
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
        setTimeout(() => process.exit(1), 250).unref();
    });
}

bootstrapServer();
