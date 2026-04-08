require('dotenv').config();

const express = require("express");
const path = require("path");

const dbHelper = require("./core/storage/db_repository");
const { getManifest } = require("./manifest");
const { handleVixSynthetic } = require("./providers/streamingcommunity/vix_proxy");
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
} = require("./core/utils");
const { generateStream, resolveLazyStreamData } = require("./core/stream_generator");
const { bootRealDebridAuditor } = require("./core/server/bootstrap/rd_auditor_boot");
const { applyCommonMiddleware } = require("./core/server/middleware");
const { createAppServices } = require("./core/server/services/app_services");
const { registerApiRoutes } = require("./core/server/routes/api_routes");
const { registerPlaybackRoutes } = require("./core/server/routes/playback_routes");
const { registerAdminRoutes } = require("./core/server/routes/admin_routes");
const { registerStremioRoutes } = require("./core/server/routes/stremio_routes");

const app = express();
const publicDir = path.join(__dirname, "public");

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
    console.log(`-----------------------------------------------------`);
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
    console.log(`[SCRAPERS] Fallback scrapers ready`);
    console.log(`-----------------------------------------------------`);
});

function gracefulShutdown(signal) {
    logger.info(`[SHUTDOWN] Ricevuto ${signal}, chiusura server in corso...`);
    server.close(() => {
        logger.info("[SHUTDOWN] Server HTTP chiuso correttamente.");
        process.exit(0);
    });
    setTimeout(() => {
        logger.error("[SHUTDOWN] Shutdown forzato per timeout.");
        process.exit(1);
    }, 10000).unref();
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
