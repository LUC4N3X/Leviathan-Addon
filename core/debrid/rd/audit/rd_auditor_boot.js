'use strict';

function bootRealDebridAuditor({ dbHelper, logger, Cache }) {
    let rdAuditorBoot = { enabled: false, started: false, reason: 'disabled' };
    let getRdAuditorStatus = () => ({ ...rdAuditorBoot });


    if (String(process.env.RD_CACHE_SCANNER_ENABLED || 'true').toLowerCase() !== 'false') {
        try {
            const { startRealDebridAuditor, getRealDebridAuditorStatus: workerStatusGetter } = require('./realdebrid_auditor');
            rdAuditorBoot = startRealDebridAuditor({
                dbHelper,
                logger,
                onBatchUpdated: async ({ hashes }) => {
                    if (Array.isArray(hashes) && hashes.length > 0) {
                        await Cache.invalidateStreamsByHashes(hashes, 'rd_auditor_batch');
                    }
                }
            });
            if (typeof workerStatusGetter === 'function') getRdAuditorStatus = workerStatusGetter;
        } catch (err) {
            rdAuditorBoot = { enabled: true, started: false, reason: err.message || 'boot_error' };
            logger.error(`[RD AUDIT] Boot fallito: ${err.message}`);
        }
    }

    return { rdAuditorBoot, getRdAuditorStatus };
}

module.exports = { bootRealDebridAuditor };
