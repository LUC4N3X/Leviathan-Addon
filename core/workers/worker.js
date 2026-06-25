require('dotenv').config();

const { randomUUID } = require('crypto');
const runtimeState = require('../runtime_state');
const { logger, installConsoleBridge } = require('../utils/runtime');
const dbHelper = require('../storage/db_repository');
const { Cache } = require('../utils');
const { createTorrentioTmdbScanner } = require('../prewarm/torrentio_tmdb_scanner');
const { normalizeExternalCandidateForPipeline } = require('../stream_generator');
const trackerRegistry = require('../storage/tracker_registry');
const { startCfPrewarmJob } = require('./cf_prewarm_worker');

installConsoleBridge(logger);

process.env.LEVI_PROCESS_ROLE = 'worker';
process.env.LEVI_NODE_ID = String(process.env.LEVI_NODE_ID || randomUUID());

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

async function bootstrapWorker() {
  runtimeState.markNotReady('worker_booting');
  runtimeState.setClusterRole('background-worker', { enabled: false, leader: true, slot: -1 });

  dbHelper.initDatabase();

  if (Cache && typeof Cache.startInvalidationSync === 'function') {
    Cache.startInvalidationSync().catch((error) => {
      logger.warn(`[WORKER] Cache invalidation sync bootstrap failed: ${error.message}`);
    });
  }

  if (trackerRegistry && typeof trackerRegistry.initTrackerRegistry === 'function') {
    trackerRegistry.initTrackerRegistry({ autoRefresh: true });
    logger.info(`[WORKER] Tracker registry refresh attivo | trackers=${trackerRegistry.getActiveTrackers().length}`);
  }

  const scanner = createTorrentioTmdbScanner({
    dbHelper,
    logger,
    normalizeExternalCandidateForPipeline
  });

  const scannerEnabled = envFlag('LEVIATHAN_WORKER_SCANNER_ENABLED', true);
  if (scannerEnabled) {
    scanner.start({ leader: true });
  } else {
    logger.info('[WORKER] Torrentio/TMDB scanner disattivato da LEVIATHAN_WORKER_SCANNER_ENABLED=false');
  }

  const cfPrewarmJob = startCfPrewarmJob({
    enabled: envFlag('CF_PREWARM_ENABLED', true)
  });

  runtimeState.markReady('worker_started');
  logger.info(`[WORKER] Leviathan background worker avviato | pid=${process.pid} node=${process.env.LEVI_NODE_ID}`);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    runtimeState.markDraining(signal, { rejectNewRequests: true });
    logger.info(`[WORKER] Ricevuto ${signal}, chiusura worker...`);

    const forceTimer = setTimeout(() => {
      logger.error('[WORKER] Shutdown forzato per timeout.');
      process.exit(1);
    }, Math.max(5000, parseInt(process.env.SHUTDOWN_FORCE_MS || '12000', 10) || 12000));
    forceTimer.unref();

    try {
      if (cfPrewarmJob && typeof cfPrewarmJob.stop === 'function') cfPrewarmJob.stop();
      if (scanner && typeof scanner.stop === 'function') await scanner.stop();
      if (Cache && typeof Cache.stopInvalidationSync === 'function') await Cache.stopInvalidationSync();
      if (trackerRegistry && typeof trackerRegistry.shutdownTrackerRegistry === 'function') trackerRegistry.shutdownTrackerRegistry();
      if (typeof dbHelper.shutdownDatabase === 'function') await dbHelper.shutdownDatabase();
      clearTimeout(forceTimer);
      logger.info('[WORKER] Chiuso correttamente.');
      process.exit(0);
    } catch (error) {
      logger.error('[WORKER] Errore durante la chiusura', { error: error.message });
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('[WORKER] Unhandled Promise Rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('[WORKER] Uncaught Exception', { error: error.message, stack: error.stack });
    runtimeState.markDraining('uncaught_exception', { rejectNewRequests: true });
    setTimeout(() => process.exit(1), 250).unref();
  });
}

bootstrapWorker().catch((error) => {
  logger.error(`[WORKER] Bootstrap failed: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
