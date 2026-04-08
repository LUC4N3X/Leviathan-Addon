'use strict';

const axios = require('axios');

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
