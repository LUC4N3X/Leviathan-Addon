const { buildMagnet } = require('../../../storage/tracker_registry');
const RealDebridProbe = require('../probe/realdebrid_probe');
const { getRdProbeCoordinatorStatus } = require('../probe/rd_probe_coordinator');

let started = false;
const auditorState = {
    enabled: false,
    started: false,
    running: false,
    reason: 'disabled',
    batchSize: 0,
    sleepMs: 0,
    idleMs: 0,
    currentHash: null,
    currentTitle: null,
    lastOutcome: null,
    lastError: null,
    lastBatchSize: 0,
    totalScanned: 0,
    totalUpdated: 0,
    lastActivityAt: null,
    lastBatchAt: null,
    lastProgress: null
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// Leviathan RD Audit v2: default fissati nel codice, non nel file .env.
const RD_CACHED_RECHECK_HOURS = 168; // 7 giorni
const RD_SCAN_BATCH = 2;
const RD_SCAN_SLEEP_MS = 15000;
const RD_SCAN_IDLE_MS = 90000;
const RD_SCAN_NORMALIZE_CHUNK = 10000;
const RD_SCAN_ENABLE_BY_DEFAULT = true;
const PACK_VIDEO_MIN_BYTES = 25 * 1024 * 1024;
const VIDEO_EXT_RE = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i;
const TERMINAL_RD_NEGATIVE_STATUSES = new Set(['error', 'magnet_error', 'virus', 'dead']);

function normalizeAuditVideoFile(file) {
    const id = Number(file?.id);
    const bytes = Number(file?.bytes || 0);
    const rawPath = String(file?.path || '');
    if (!VIDEO_EXT_RE.test(rawPath) || bytes <= PACK_VIDEO_MIN_BYTES) return null;
    return {
        id: Number.isInteger(id) && id >= 0 ? id : null,
        path: rawPath,
        bytes
    };
}

function cleanAuditFilePath(path) {
    if (!path) return 'unknown.mkv';
    const cleaned = String(path).replace(/^\/+/, '');
    return cleaned.includes('/') ? cleaned.split('/').pop() : cleaned;
}

function getAuditVideoFiles(files) {
    return (Array.isArray(files) ? files : [])
        .map(normalizeAuditVideoFile)
        .filter(Boolean)
        .sort((a, b) => Number(b?.bytes || 0) - Number(a?.bytes || 0));
}

function buildPackRowsFromAudit(hash, files) {
    const videoFiles = getAuditVideoFiles(files);
    if (videoFiles.length <= 1) return [];
    return videoFiles.map((file) => ({
        pack_hash: hash,
        file_index: file.id,
        file_path: cleanAuditFilePath(file.path),
        file_title: cleanAuditFilePath(file.path),
        file_size: file.bytes
    }));
}

function mapAuditorProbeResult(hash, result = {}) {
    const normalizedHash = String(result.hash || hash || '').trim().toLowerCase();
    const status = String(result.rd_status || '').trim().toLowerCase();
    const files = getAuditVideoFiles(result.files);
    const requestedFileIndex = Number(result.file_index ?? result.episodeFileHint?.fileIndex);
    const selectedFileIndex = Number.isInteger(requestedFileIndex) && requestedFileIndex >= 0
        ? requestedFileIndex
        : null;
    const matchingFile = selectedFileIndex !== null
        ? files.find((file) => Number(file.id) === selectedFileIndex)
        : files[0];
    const selectedFileSize = Number(result.file_size || matchingFile?.bytes || 0) || null;
    const base = {
        hash: normalizedHash,
        cached: null,
        rd_file_index: selectedFileIndex,
        rd_file_size: selectedFileSize,
        files,
        is_pack: result.is_pack === true || files.length > 1
    };

    if (result.cached === true) {
        return {
            ...base,
            state: 'likely_cached',
            verified: true,
            failures: 0,
            next_hours: RD_CACHED_RECHECK_HOURS,
            reason: 'personal_scan_cached_hint'
        };
    }

    if (TERMINAL_RD_NEGATIVE_STATUSES.has(status)) {
        return {
            ...base,
            state: 'likely_uncached',
            verified: true,
            failures: 1,
            next_hours: RD_CACHED_RECHECK_HOURS,
            reason: `personal_scan_terminal_hint:${status}`
        };
    }

    if (result.deferred === true || result.state === 'probing' || result.error) {
        return {
            ...base,
            state: 'probing',
            verified: false,
            failures: 1,
            next_hours: 12,
            reason: `personal_scan_deferred:${result.error || status || 'unknown'}`
        };
    }

    if (result.state === 'likely_cached' || result.pack_without_episode_hint === true) {
        return {
            ...base,
            state: 'likely_cached',
            verified: true,
            failures: 0,
            next_hours: RD_CACHED_RECHECK_HOURS,
            reason: 'personal_scan_likely_cached_hint'
        };
    }

    return {
        ...base,
        state: 'likely_uncached',
        verified: false,
        failures: 1,
        next_hours: 12,
        reason: `personal_scan_inconclusive:${status || result.state || 'unknown'}`
    };
}

async function auditHashSlow(hash, token, dependencies = {}) {
    const probe = dependencies.RealDebridProbe || RealDebridProbe;
    try {
        const magnet = buildMagnet(hash);
        const result = await probe.inspectSingleHash(hash, magnet, token, {}, { priority: 'auditor' });
        return mapAuditorProbeResult(hash, result);
    } catch (err) {
        return mapAuditorProbeResult(hash, {
            hash,
            cached: false,
            deferred: true,
            state: 'probing',
            error: err?.message || 'request_error'
        });
    }
}

function formatProgress(progress) {
    if (!progress) return 'progress=n/a';
    const total = Number(progress.total_with_hash || 0);
    const pending = Number(progress.pending_first_scan || 0);
    const scanned = Number(progress.already_scanned || 0);
    const cached = Number(progress.cached_true || 0);
    const uncached = Number(progress.cached_false || 0);
    return `totale=${total} pending=${pending} scanned=${scanned} cached=${cached} uncached=${uncached}`;
}

function getRealDebridAuditorStatus() {
    return { ...auditorState, probeCoordinator: getRdProbeCoordinatorStatus() };
}

function startRealDebridAuditor({ dbHelper, logger = console, onBatchUpdated = null } = {}) {
    const enabled = RD_SCAN_ENABLE_BY_DEFAULT && String(process.env.RD_CACHE_SCANNER_ENABLED || 'true').toLowerCase() !== 'false';
    const token = process.env.RD_SCAN_TOKEN || process.env.RD_API_KEY || '';

    auditorState.enabled = enabled;

    if (!enabled) {
        auditorState.reason = 'env_off';
        return { enabled: false, started: false, reason: 'env_off' };
    }
    if (started) {
        auditorState.started = true;
        auditorState.running = true;
        auditorState.reason = 'already_started';
        return { enabled: true, started: true, reason: 'already_started' };
    }
    if (!dbHelper || typeof dbHelper.getRdScanBatch !== 'function' || typeof dbHelper.updateRdCacheStatus !== 'function') {
        auditorState.reason = 'db_methods_missing';
        return { enabled: true, started: false, reason: 'db_methods_missing' };
    }
    if (!token) {
        auditorState.reason = 'missing_token';
        return { enabled: true, started: false, reason: 'missing_token' };
    }

    started = true;
    const batchSize = RD_SCAN_BATCH;
    const sleepMs = RD_SCAN_SLEEP_MS;
    const idleMs = RD_SCAN_IDLE_MS;

    Object.assign(auditorState, {
        started: true,
        running: true,
        reason: 'started',
        batchSize,
        sleepMs,
        idleMs,
        lastError: null,
        lastActivityAt: new Date().toISOString()
    });

    (async () => {
        if (typeof dbHelper.normalizePendingRdCacheState === 'function') {
            const normalized = await dbHelper.normalizePendingRdCacheState({
                chunkSize: Math.max(batchSize * 5000, RD_SCAN_NORMALIZE_CHUNK)
            });
            logger.info?.(`[RD AUDIT] Bootstrap normalize | applied=${normalized?.applied ? 'true' : 'false'} | updated=${normalized?.updated || 0} | reason=${normalized?.reason || 'n/a'}`);
        }
        logger.info?.(`[RD AUDIT] Avvio completato | batch=${batchSize} sleep=${sleepMs}ms idle=${idleMs}ms`);
        if (typeof dbHelper.getRdScanProgress === 'function') {
            const progress = await dbHelper.getRdScanProgress();
            auditorState.lastProgress = progress || null;
            logger.info?.(`[RD AUDIT] Stato iniziale | ${formatProgress(progress)}`);
        }
        while (true) {
            try {
                const batch = await dbHelper.getRdScanBatch(batchSize);
                auditorState.lastActivityAt = new Date().toISOString();
                auditorState.lastBatchSize = Array.isArray(batch) ? batch.length : 0;
                if (!Array.isArray(batch) || batch.length === 0) {
                    logger.info?.(`[RD AUDIT] Nessun hash pronto | sleep=${idleMs}ms`);
                    await sleep(idleMs);
                    continue;
                }

                logger.info?.(`[RD AUDIT] Batch preso dal DB | elementi=${batch.length}`);
                const results = [];
                const packRows = [];
                for (const item of batch) {
                    const hash = String(item?.hash || '').trim().toLowerCase();
                    if (!hash) continue;
                    auditorState.currentHash = hash;
                    auditorState.currentTitle = String(item?.title || '').slice(0, 180) || null;
                    logger.info?.(`[RD AUDIT] Controllo hash=${hash} | title=${auditorState.currentTitle || 'n/a'}`);
                    const outcome = await auditHashSlow(hash, token);
                    auditorState.lastOutcome = { ...outcome, at: new Date().toISOString() };
                    auditorState.totalScanned += 1;
                    logger.info?.(`[RD AUDIT] Esito hash=${hash} | cached=${outcome.cached} | state=${outcome.state || 'n/a'} | reason=${outcome.reason || 'n/a'} | file=${outcome.rd_file_index ?? 'n/a'} | size=${outcome.rd_file_size ?? 'n/a'} | packFiles=${Array.isArray(outcome.files) ? outcome.files.length : 0} | next_hours=${outcome.next_hours}`);
                    if (outcome.verified === true && outcome.state === 'likely_cached' && outcome.is_pack === true) {
                        packRows.push(...buildPackRowsFromAudit(hash, outcome.files));
                    }
                    results.push(outcome);
                    await sleep(sleepMs);
                }

                if (results.length > 0) {
                    const updated = await dbHelper.updateRdCacheStatus(results);
                    if (packRows.length > 0 && typeof dbHelper.insertPackFiles === 'function') {
                        try {
                            const packInsert = await dbHelper.insertPackFiles(packRows);
                            logger.info?.(`[RD AUDIT] Pack files salvati | rows=${packRows.length} inserted=${packInsert?.inserted || 0}`);
                        } catch (packError) {
                            logger.warn?.(`[RD AUDIT] Pack files non salvati: ${packError.message}`);
                        }
                    }
                    auditorState.totalUpdated += Number(updated || 0);
                    auditorState.lastBatchAt = new Date().toISOString();
                    auditorState.currentHash = null;
                    auditorState.currentTitle = null;
                    if (typeof dbHelper.getRdScanProgress === 'function') {
                        const progress = await dbHelper.getRdScanProgress();
                        auditorState.lastProgress = progress || null;
                        logger.info?.(`[RD AUDIT] Batch completato | scansiti=${results.length} aggiornati=${updated} | ${formatProgress(progress)}`);
                    } else {
                        logger.info?.(`[RD AUDIT] Batch completato | scansiti=${results.length} aggiornati=${updated}`);
                    }
                    if (typeof onBatchUpdated === 'function') {
                        try {
                            await onBatchUpdated({
                                updated,
                                hashes: results.map((entry) => entry.hash).filter(Boolean),
                                results
                            });
                        } catch (callbackError) {
                            logger.warn?.(`[RD AUDIT] Callback post-batch fallita: ${callbackError.message}`);
                        }
                    }
                }
            } catch (err) {
                auditorState.lastError = String(err?.message || err);
                auditorState.lastActivityAt = new Date().toISOString();
                logger.error?.(`[RD AUDIT] Errore loop: ${err.message}`);
                await sleep(idleMs);
            }
        }
    })().catch((err) => {
        auditorState.running = false;
        auditorState.lastError = String(err?.message || err);
        logger.error?.(`[RD AUDIT] Fatal: ${err.message}`);
    });

    return { enabled: true, started: true, reason: 'started' };
}

module.exports = {
    startRealDebridAuditor,
    getRealDebridAuditorStatus,
    __private: {
        auditHashSlow,
        buildPackRowsFromAudit,
        mapAuditorProbeResult
    }
};
