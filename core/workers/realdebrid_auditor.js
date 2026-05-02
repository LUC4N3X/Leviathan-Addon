const axios = require('axios');
const { buildMagnet } = require('../storage/tracker_registry');

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

function createRealDebridHttpClient(token) {
    return axios.create({
        baseURL: 'https://api.real-debrid.com/rest/1.0',
        timeout: Math.max(10000, parseInt(process.env.RD_SCAN_HTTP_TIMEOUT || '30000', 10)),
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
}

async function auditHashSlow(http, hash) {
    let torrentId = null;
    try {
        const magnet = buildMagnet(hash);
        const addRes = await http.post('/torrents/addMagnet', `magnet=${encodeURIComponent(magnet)}`);
        torrentId = addRes?.data?.id;
        if (!torrentId) return { hash, cached: null, failures: 1, next_hours: 12, reason: 'missing_torrent_id' };

        const pollCount = Math.max(1, parseInt(process.env.RD_SCAN_MAX_POLLS || '2', 10));
        const pollSleepMs = Math.max(3000, parseInt(process.env.RD_SCAN_POLL_MS || '8000', 10));

        for (let attempt = 0; attempt < pollCount; attempt += 1) {
            await sleep(pollSleepMs);
            const infoRes = await http.get(`/torrents/info/${torrentId}`);
            const data = infoRes?.data || {};
            const status = String(data.status || '').toLowerCase();
            const files = Array.isArray(data.files) ? data.files : [];
            const biggest = files
                .filter((file) => Number(file?.bytes || 0) > 0)
                .sort((a, b) => Number(b?.bytes || 0) - Number(a?.bytes || 0))[0];

            if (status === 'downloaded') {
                return {
                    hash,
                    state: 'cached',
                    cached: true,
                    rd_file_index: biggest?.id ?? null,
                    rd_file_size: biggest?.bytes ?? null,
                    failures: 0,
                    next_hours: 24 * 30,
                    reason: status
                };
            }

            if (status === 'waiting_files_selection') {
                return { hash, state: 'probing', cached: null, failures: 1, next_hours: 6, reason: status };
            }

            if (['error', 'magnet_error', 'virus', 'dead'].includes(status)) {
                return { hash, state: 'uncached_terminal', cached: false, failures: 0, next_hours: 24 * 7, reason: status };
            }
        }

        return { hash, state: 'likely_uncached', cached: null, failures: 1, next_hours: 12, reason: 'poll_exhausted' };
    } catch (err) {
        const status = Number(err?.response?.status || 0);
        const retryHours = status === 429 || status === 503 ? 24 : 12;
        return { hash, cached: null, failures: 1, next_hours: retryHours, reason: status ? `http_${status}` : (err?.message || 'request_error') };
    } finally {
        if (torrentId) {
            try {
                await http.delete(`/torrents/delete/${torrentId}`);
            } catch (_) {}
        }
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
    return { ...auditorState };
}

function startRealDebridAuditor({ dbHelper, logger = console, onBatchUpdated = null } = {}) {
    const enabled = String(process.env.RD_CACHE_SCANNER_ENABLED || '').toLowerCase() === 'true';
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
    const http = createRealDebridHttpClient(token);
    const batchSize = Math.max(1, Math.min(10, parseInt(process.env.RD_SCAN_BATCH || '2', 10)));
    const sleepMs = Math.max(5000, parseInt(process.env.RD_SCAN_SLEEP_MS || '15000', 10));
    const idleMs = Math.max(15000, parseInt(process.env.RD_SCAN_IDLE_MS || '90000', 10));

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
                chunkSize: Math.max(batchSize * 5000, parseInt(process.env.RD_SCAN_NORMALIZE_CHUNK || '10000', 10) || 10000)
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
                for (const item of batch) {
                    const hash = String(item?.hash || '').trim().toLowerCase();
                    if (!hash) continue;
                    auditorState.currentHash = hash;
                    auditorState.currentTitle = String(item?.title || '').slice(0, 180) || null;
                    logger.info?.(`[RD AUDIT] Controllo hash=${hash} | title=${auditorState.currentTitle || 'n/a'}`);
                    const outcome = await auditHashSlow(http, hash);
                    auditorState.lastOutcome = { ...outcome, at: new Date().toISOString() };
                    auditorState.totalScanned += 1;
                    logger.info?.(`[RD AUDIT] Esito hash=${hash} | cached=${outcome.cached} | reason=${outcome.reason || 'n/a'} | file=${outcome.rd_file_index ?? 'n/a'} | size=${outcome.rd_file_size ?? 'n/a'} | next_hours=${outcome.next_hours}`);
                    results.push(outcome);
                    await sleep(sleepMs);
                }

                if (results.length > 0) {
                    const updated = await dbHelper.updateRdCacheStatus(results);
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

module.exports = { startRealDebridAuditor, getRealDebridAuditorStatus };
