const axios = require('axios');
const { buildMagnet } = require('../../../storage/tracker_registry');

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
const RD_SCAN_HTTP_TIMEOUT_MS = 30000;
const RD_SCAN_MAX_POLLS = 2;
const RD_SCAN_POLL_MS = 8000;
const RD_SCAN_BATCH = 2;
const RD_SCAN_SLEEP_MS = 15000;
const RD_SCAN_IDLE_MS = 90000;
const RD_SCAN_NORMALIZE_CHUNK = 10000;
const RD_SCAN_ENABLE_BY_DEFAULT = true;
const PACK_VIDEO_MIN_BYTES = 25 * 1024 * 1024;
const VIDEO_EXT_RE = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i;

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

function pickAuditFileId(files) {
    const best = getAuditVideoFiles(files)[0];
    const id = Number(best?.id);
    return Number.isInteger(id) && id >= 0 ? id : null;
}

function getAuditFileSize(files, selectedId = null) {
    const videoFiles = getAuditVideoFiles(files);
    const exact = selectedId !== null ? videoFiles.find((file) => Number(file?.id) === Number(selectedId)) : null;
    return Number((exact || videoFiles[0])?.bytes || 0) || null;
}

function buildAuditSelection(files) {
    const videoFiles = getAuditVideoFiles(files);
    const fileIds = videoFiles
        .map((file) => Number(file.id))
        .filter((id) => Number.isInteger(id) && id >= 0);

    // Se RD espone un pack, lo verifichiamo selezionando TUTTI i file video.
    // Così non segniamo ⚡ un pack dove è pronto solo il file più grande ma non l'episodio richiesto.
    const primary = videoFiles[0] || null;
    return {
        videoFiles,
        primaryFileId: Number.isInteger(Number(primary?.id)) ? Number(primary.id) : null,
        filesToSelect: fileIds.length > 1 ? fileIds.join(',') : (fileIds.length === 1 ? String(fileIds[0]) : 'all')
    };
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

function createRealDebridHttpClient(token) {
    return axios.create({
        baseURL: 'https://api.real-debrid.com/rest/1.0',
        timeout: RD_SCAN_HTTP_TIMEOUT_MS,
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
        if (!torrentId) return { hash, state: 'probing', cached: null, failures: 1, next_hours: 12, reason: 'missing_torrent_id' };

        const pollCount = RD_SCAN_MAX_POLLS;
        const pollSleepMs = RD_SCAN_POLL_MS;

        let selectedFileId = null;

        for (let attempt = 0; attempt < pollCount; attempt += 1) {
            await sleep(pollSleepMs);
            let infoRes = await http.get(`/torrents/info/${torrentId}`);
            let data = infoRes?.data || {};
            let status = String(data.status || '').toLowerCase();
            let files = Array.isArray(data.files) ? data.files : [];

            if (status === 'waiting_files_selection') {
                const selection = buildAuditSelection(files);
                selectedFileId = selection.primaryFileId;
                try {
                    await http.post(`/torrents/selectFiles/${torrentId}`, `files=${encodeURIComponent(selection.filesToSelect || 'all')}`);
                    await sleep(Math.max(1000, Math.min(3000, Math.floor(pollSleepMs / 2))));
                    infoRes = await http.get(`/torrents/info/${torrentId}`);
                    data = infoRes?.data || {};
                    status = String(data.status || '').toLowerCase();
                    files = Array.isArray(data.files) ? data.files : files;
                } catch (selectError) {
                    return { hash, state: 'probing', cached: null, failures: 1, next_hours: 4, reason: `select_failed:${selectError?.response?.status || selectError.message}` };
                }
            }

            if (status === 'downloaded' && Array.isArray(data.links) && data.links.length > 0) {
                const videoFiles = getAuditVideoFiles(files);
                const selectedId = Number.isInteger(selectedFileId) ? selectedFileId : pickAuditFileId(files);
                return {
                    hash,
                    state: 'cached',
                    cached: true,
                    rd_file_index: selectedId,
                    rd_file_size: getAuditFileSize(files, selectedId),
                    files: videoFiles,
                    is_pack: videoFiles.length > 1,
                    failures: 0,
                    next_hours: RD_CACHED_RECHECK_HOURS,
                    reason: 'downloaded_links'
                };
            }

            if (['error', 'magnet_error', 'virus', 'dead'].includes(status)) {
                return { hash, state: 'uncached_terminal', cached: false, failures: 0, next_hours: 24 * 7, reason: status };
            }
        }

        return { hash, state: 'likely_uncached', cached: null, failures: 1, next_hours: 12, reason: 'poll_exhausted' };
    } catch (err) {
        const status = Number(err?.response?.status || 0);
        const retryHours = status === 429 || status === 503 ? 24 : 12;
        return { hash, state: 'probing', cached: null, failures: 1, next_hours: retryHours, reason: status ? `http_${status}` : (err?.message || 'request_error') };
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
    const http = createRealDebridHttpClient(token);
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
                    const outcome = await auditHashSlow(http, hash);
                    auditorState.lastOutcome = { ...outcome, at: new Date().toISOString() };
                    auditorState.totalScanned += 1;
                    logger.info?.(`[RD AUDIT] Esito hash=${hash} | cached=${outcome.cached} | state=${outcome.state || 'n/a'} | reason=${outcome.reason || 'n/a'} | file=${outcome.rd_file_index ?? 'n/a'} | size=${outcome.rd_file_size ?? 'n/a'} | packFiles=${Array.isArray(outcome.files) ? outcome.files.length : 0} | next_hours=${outcome.next_hours}`);
                    if (outcome.cached === true && outcome.is_pack === true) {
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

module.exports = { startRealDebridAuditor, getRealDebridAuditorStatus };
