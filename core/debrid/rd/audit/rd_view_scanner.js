'use strict';

const crypto = require('crypto');

const dbHelper = require('../../../storage/db_repository');
const RealDebridProbe = require('../probe/realdebrid_probe');
const EpisodePrecision = require('../../../stream/episode_precision');
const RdOracle = require('../state/cache_oracle');
const { shouldSkipRecentWork } = require('../../../recent_work');
let RawStreamCache = null;
try {
    RawStreamCache = require('../../../cache/raw_stream_cache');
} catch (_) {
    RawStreamCache = null;
}

// RD View Scanner: quando uno stream viene mostrato con stato unknown/probing,
// non blocca Stremio, ma parte subito dietro le quinte per confermare RD e invalidare
// le cache collegate. Default fissati nel codice per evitare nuove env obbligatorie.
const RD_VIEW_SCAN_ENABLED = true;
const RD_VIEW_SCAN_TOP = 14;
const RD_VIEW_SCAN_BATCH_SIZE = 5;
const RD_VIEW_SCAN_EXACT_LIMIT = 3;
const RD_VIEW_SCAN_DEDUP_MS = 2 * 60 * 1000;
const RD_VIEW_SCAN_COLLECTION_DEDUP_MS = 12 * 1000;
const RD_VIEW_SCAN_MAX_QUEUE = 120;
const RD_VIEW_SCAN_START_DELAY_MS = 250;
const RD_VIEW_SCAN_BETWEEN_BATCH_MS = 350;
const RD_VIEW_SCAN_PRIORITY = Object.freeze({ high: 100, normal: 50, low: 10 });
const AVAILABILITY_CACHE_HIT_TTL = 24 * 60 * 60;
const AVAILABILITY_CACHE_NEGATIVE_TTL = 6 * 60 * 60;
const AVAILABILITY_CACHE_PROBING_TTL = 120;

const inFlightByHash = new Map();
const recentCollections = new Map();
const pendingQueue = [];
let queueRunning = false;

const VALID_RD_STATES = new Set(['cached', 'likely_cached', 'probing', 'likely_uncached', 'uncached_terminal', 'unknown']);
const TERMINAL_RD_NEGATIVE_STATUSES = new Set(['error', 'magnet_error', 'virus', 'dead']);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeHash(value) {
    const raw = String(value || '').trim().toUpperCase();
    return /^[A-F0-9]{40}$/.test(raw) ? raw : '';
}

function normalizeRdStateValue(state) {
    const normalized = String(state || '').trim().toLowerCase();
    return VALID_RD_STATES.has(normalized) ? normalized : null;
}

function normalizeFileIdxForAvailability(fileIdx) {
    if (fileIdx === undefined || fileIdx === null || fileIdx === '') return 'auto';
    const parsed = Number.parseInt(fileIdx, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? String(parsed) : 'auto';
}

function normalizePriorityLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'visible' || normalized === 'foreground') return 'high';
    if (normalized === 'warmup' || normalized === 'background') return 'low';
    return Object.prototype.hasOwnProperty.call(RD_VIEW_SCAN_PRIORITY, normalized) ? normalized : 'normal';
}

function getPriorityValue(value) {
    return RD_VIEW_SCAN_PRIORITY[normalizePriorityLabel(value)] || RD_VIEW_SCAN_PRIORITY.normal;
}

function getAvailabilityCacheKey(service, hash, fileIdx = null) {
    const normalizedService = String(service || 'rd').trim().toLowerCase();
    const normalizedHash = normalizeHash(hash);
    if (!normalizedHash) return null;
    return `${normalizedService}:${normalizedHash}:${normalizeFileIdxForAvailability(fileIdx)}`;
}

function getCandidateHash(item = {}) {
    return normalizeHash(item.hash || item.infoHash || item.info_hash || item.info_hash_norm || item.btih);
}

function getCandidateState(item = {}, meta = {}, getRdAvailabilityState = null) {
    if (typeof getRdAvailabilityState === 'function') {
        try {
            return normalizeRdStateValue(getRdAvailabilityState('rd', item, meta)) || 'unknown';
        } catch (_) {}
    }

    return normalizeRdStateValue(
        item.rd_cache_state ||
        item.rdCacheState ||
        item.rd_status ||
        item.rdStatus ||
        item._rdStatus ||
        item._rdCacheState ||
        (item.cached_rd === true || item._cached === true || item.cached === true ? 'cached' : null)
    ) || 'unknown';
}

function hasEnoughProbeData(item = {}) {
    return Boolean(getCandidateHash(item) && item.magnet);
}

function buildViewScanKey(service, item = {}) {
    const hash = getCandidateHash(item);
    if (!hash) return null;
    return `${String(service || 'rd').toLowerCase()}:${hash}:${normalizeFileIdxForAvailability(item.fileIdx ?? item.file_index ?? item.rd_file_index)}`;
}

function getMetaLabel(meta = {}) {
    const imdb = String(meta.imdb_id || meta.imdbId || meta.id || '').trim().toLowerCase();
    const season = Number(meta.season || 0) || 0;
    const episode = Number(meta.episode || 0) || 0;
    if (imdb && season > 0 && episode > 0) return `${imdb}:${season}:${episode}`;

    const rawId = String(meta.id || '').replace(/\.json$/i, '').trim().toLowerCase();
    const idMatch = rawId.match(/^(tt\d+|tmdb:\d+|kitsu:\d+|\d+)(?::(\d+))?(?::(\d+))?$/i);
    if (idMatch) {
        const base = String(idMatch[1] || '').toLowerCase();
        const s = Number(idMatch[2] || 0) || 0;
        const e = Number(idMatch[3] || 0) || 0;
        if (base && s > 0 && e > 0) return `${base}:${s}:${e}`;
        if (base && s > 0) return `${base}:${s}`;
        return base;
    }

    return imdb || String(meta.kitsu_id || meta.tmdb_id || meta.title || 'n/a').slice(0, 80);
}

function getJobPageLabel(job = {}) {
    return getMetaLabel(job.requestPage || job.meta || {});
}

function getJobKindLabel(job = {}) {
    return String(job.kind || job.requestPage?.source || 'visible').trim().toLowerCase();
}

function compactTitle(item = {}) {
    return String(item.title || item.name || item.filename || item.packTitle || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function scoreVisibleCandidate(entry = {}) {
    const item = entry.item || {};
    const indexScore = Math.max(0, 30 - Number(entry.index || 0));
    const qualityText = String(item.quality || item.resolution || item.title || '').toLowerCase();
    const qualityScore = /2160p|4k/.test(qualityText) ? 22 : /1080p/.test(qualityText) ? 16 : /720p/.test(qualityText) ? 8 : 0;
    const langText = [item.language, item.languages, item.title, item.name].flat().join(' ').toLowerCase();
    const langScore = /\bita\b|italian|italiano|multi/.test(langText) ? 14 : 0;
    const seederScore = Math.min(12, Math.max(0, Number(item.seeders || item.seeds || item._seeders || 0) || 0) / 8);
    const state = String(entry.state || 'unknown');
    const stateScore = state === 'unknown' ? 10 : state === 'probing' ? 8 : state === 'likely_cached' ? 5 : 0;
    return indexScore + qualityScore + langScore + seederScore + stateScore;
}

function collectViewScanCandidates(items = [], meta = {}, options = {}) {
    const list = Array.isArray(items) ? items : [];
    const limit = Math.max(1, Math.min(50, Number(options.maxScan || RD_VIEW_SCAN_TOP) || RD_VIEW_SCAN_TOP));
    const getRdAvailabilityState = options.getRdAvailabilityState;
    const seen = new Set();
    const collected = [];
    let known = 0;
    let unknown = 0;
    let probing = 0;
    let likely = 0;
    let skippedCached = 0;

    for (let index = 0; index < list.length; index += 1) {
        const item = list[index];
        const hash = getCandidateHash(item);
        if (!hash || !hasEnoughProbeData(item)) continue;

        const state = getCandidateState(item, meta, getRdAvailabilityState);
        if (state === 'cached' || state === 'uncached_terminal' || state === 'likely_uncached') {
            known += 1;
            if (state === 'cached') skippedCached += 1;
            continue;
        }

        if (state === 'unknown') unknown += 1;
        else if (state === 'probing') probing += 1;
        else if (state === 'likely_cached') likely += 1;

        const key = buildViewScanKey('rd', item);
        if (!key || seen.has(key)) continue;
        seen.add(key);

        collected.push({ item, hash, key, state, index, score: scoreVisibleCandidate({ item, state, index }) });
    }

    collected.sort((a, b) => b.score - a.score || a.index - b.index);
    return {
        candidates: collected.slice(0, limit).map((entry) => ({
            ...entry.item,
            hash: entry.hash,
            infoHash: entry.hash,
            _rdViewScanState: entry.state,
            _rdViewScanIndex: entry.index,
            _rdViewScanScore: entry.score,
            _probeSeason: Number(meta.season || 0) || entry.item?._probeSeason,
            _probeEpisode: Number(meta.episode || 0) || entry.item?._probeEpisode,
            season: entry.item?.season || Number(meta.season || 0) || undefined,
            episode: entry.item?.episode || Number(meta.episode || 0) || undefined,
            seriesTitle: entry.item?.seriesTitle || meta.title || meta.name || '',
            metaTitle: entry.item?.metaTitle || meta.title || meta.name || '',
            imdb_id: entry.item?.imdb_id || meta.imdb_id || null,
            kitsu_id: entry.item?.kitsu_id || meta.kitsu_id || null,
            isAnime: entry.item?.isAnime || Boolean(meta.isAnime || meta.kitsu_id)
        })),
        stats: { total: list.length, collected: collected.length, returned: Math.min(collected.length, limit), known, unknown, probing, likely, skippedCached }
    };
}

function isTerminalUncachedStatus(status) {
    return TERMINAL_RD_NEGATIVE_STATUSES.has(String(status || '').toLowerCase());
}

function mapProbeResultToState(result = {}) {
    if (result.cached === true) return { state: 'cached', cached: true, failures: 0, next_hours: 24 * 30 };
    if (result.state === 'likely_cached' || result.pack_without_episode_hint === true) {
        return { state: 'likely_cached', cached: null, failures: 0, next_hours: 6 };
    }
    if (isTerminalUncachedStatus(result.rd_status)) {
        return { state: 'uncached_terminal', cached: false, failures: 3, permanent: true, next_hours: 24 * 7 };
    }
    return { state: 'likely_uncached', cached: null, failures: 1, next_hours: 12 };
}

function buildAvailabilityCachePayload(statePayload = {}, item = {}, result = null) {
    const proof = item._rdEpisodeProof || item.rdEpisodeProof || result?.episodeFileHint || null;
    return {
        state: normalizeRdStateValue(statePayload.state) || null,
        cached: statePayload.cached === true ? true : statePayload.cached === false ? false : null,
        failures: Math.max(0, Number(statePayload.failures || 0) || 0),
        permanent: statePayload.permanent === true,
        source: 'rd_view_scan',
        updatedAt: Date.now(),
        fileIdx: Number.isInteger(Number(item.fileIdx ?? result?.file_index)) && Number(item.fileIdx ?? result?.file_index) >= 0
            ? Number(item.fileIdx ?? result?.file_index)
            : null,
        fileSize: Number(result?.file_size || item.sizeBytes || item._size || 0) || null,
        proof
    };
}

async function persistAvailabilityPayload(Cache, db, item, statePayload, result, logger) {
    if (!Cache || typeof Cache.cacheAvailability !== 'function') return;
    const key = getAvailabilityCacheKey('rd', item.hash, item.fileIdx ?? result?.file_index);
    if (!key) return;
    const ttl = statePayload.state === 'cached'
        ? AVAILABILITY_CACHE_HIT_TTL
        : statePayload.state === 'uncached_terminal'
            ? AVAILABILITY_CACHE_NEGATIVE_TTL
            : AVAILABILITY_CACHE_PROBING_TTL;
    const payload = buildAvailabilityCachePayload(statePayload, item, result);
    try {
        await Cache.cacheAvailability(key, payload, ttl);
        if (db && typeof db.setDebridAvailabilityCache === 'function') {
            await db.setDebridAvailabilityCache({ cache_key: key, payload, ttlSeconds: ttl });
        }
    } catch (err) {
        logger?.warn?.(`[RD VIEW SCAN] availability cache update failed | hash=${item.hash} | error=${err.message}`);
    }
}

function buildDbUpdate(item = {}, result = {}, statePayload = {}, meta = {}) {
    const fileIndex = Number(result.file_index ?? result.episodeFileHint?.fileIndex ?? item.fileIdx ?? item.file_index);
    const fileSize = Number(result.file_size ?? result.episodeFileHint?.fileSize ?? item.sizeBytes ?? item._size ?? 0);
    return {
        hash: normalizeHash(item.hash),
        state: statePayload.state,
        cached: statePayload.cached,
        rd_file_index: Number.isInteger(fileIndex) && fileIndex >= 0 ? fileIndex : null,
        rd_file_size: Number.isFinite(fileSize) && fileSize > 0 ? fileSize : null,
        torrent_title: result.torrent_title || item.title || item.name || null,
        size: Number(result.size || item.folderSize || item.totalPackSize || item._size || item.sizeBytes || 0) || 0,
        imdb_id: meta.imdb_id || item.imdb_id || null,
        imdb_season: Number(meta.season || item.season || item._probeSeason || 0) > 0 ? Number(meta.season || item.season || item._probeSeason) : null,
        imdb_episode: Number(meta.episode || item.episode || item._probeEpisode || 0) > 0 ? Number(meta.episode || item.episode || item._probeEpisode) : null,
        failures: statePayload.failures,
        permanent: statePayload.permanent === true,
        next_hours: statePayload.next_hours
    };
}

function buildPackFileInsert(item = {}, result = {}, meta = {}) {
    const hint = result.episodeFileHint || null;
    if (!hint || result.cached !== true || !meta.imdb_id || !(Number(meta.season) > 0) || !(Number(meta.episode) > 0)) return null;
    const hintedFileIndex = Number(hint.fileIndex ?? result.file_index);
    const hintedFileSize = Number(hint.fileSize ?? result.file_size ?? 0);
    return {
        pack_hash: item.hash,
        imdb_id: meta.imdb_id,
        imdb_season: Number(meta.season),
        imdb_episode: Number(meta.episode),
        file_index: Number.isInteger(hintedFileIndex) && hintedFileIndex >= 0 ? hintedFileIndex : null,
        file_path: hint.filePath || result.file_title || null,
        file_title: hint.fileName || result.file_title || null,
        file_size: Number.isFinite(hintedFileSize) && hintedFileSize > 0 ? hintedFileSize : null
    };
}


function cleanupInflightMap(now = Date.now()) {
    for (const [key, entry] of inFlightByHash.entries()) {
        const ts = typeof entry === 'object' ? Number(entry.ts || 0) : Number(entry || 0);
        if (!ts || (now - ts) > RD_VIEW_SCAN_DEDUP_MS) inFlightByHash.delete(key);
    }
}

function removePendingCandidateByKey(key, minPriorityValue) {
    if (!key || pendingQueue.length === 0) return 0;
    let removed = 0;
    for (let i = pendingQueue.length - 1; i >= 0; i -= 1) {
        const job = pendingQueue[i];
        if (Number(job?.priorityValue || 0) >= minPriorityValue) continue;
        const before = Array.isArray(job.candidates) ? job.candidates.length : 0;
        job.candidates = (job.candidates || []).filter((item) => buildViewScanKey('rd', item) !== key);
        removed += before - job.candidates.length;
        if (!job.candidates.length) pendingQueue.splice(i, 1);
    }
    return removed;
}

function reserveViewScanKey(key, priorityValue, meta = {}) {
    if (!key) return false;
    cleanupInflightMap();
    const now = Date.now();
    const previous = inFlightByHash.get(key);
    const previousTs = typeof previous === 'object' ? Number(previous.ts || 0) : Number(previous || 0);
    const previousPriority = typeof previous === 'object' ? Number(previous.priorityValue || 0) : 0;

    if (previousTs > 0 && (now - previousTs) < RD_VIEW_SCAN_DEDUP_MS) {
        if (priorityValue > previousPriority) {
            removePendingCandidateByKey(key, priorityValue);
            inFlightByHash.set(key, { ts: now, priorityValue, page: getMetaLabel(meta) });
            return true;
        }
        return false;
    }

    inFlightByHash.set(key, { ts: now, priorityValue, page: getMetaLabel(meta) });
    return true;
}

function sortPendingQueue() {
    pendingQueue.sort((a, b) => Number(b.priorityValue || 0) - Number(a.priorityValue || 0) || Number(a.enqueuedAt || 0) - Number(b.enqueuedAt || 0));
}

async function flushUpdates({ Cache, db, logger, updates, packFileInserts, reason, requestPage }) {
    if (!Array.isArray(updates) || updates.length === 0) return { updated: 0, invalidated: 0 };
    let updated = 0;
    if (db && typeof db.updateRdCacheStatus === 'function') {
        updated = await db.updateRdCacheStatus(updates);
    }

    if (Array.isArray(packFileInserts) && packFileInserts.length > 0 && db && typeof db.insertPackFiles === 'function') {
        try {
            const inserted = await db.insertPackFiles(packFileInserts);
            logger?.info?.(`[RD VIEW SCAN] pack hints saved=${Number(inserted?.inserted || 0)}/${packFileInserts.length}`);
        } catch (err) {
            logger?.warn?.(`[RD VIEW SCAN] pack hints save failed: ${err.message}`);
        }
    }

    let invalidated = 0;
    if (Cache && typeof Cache.invalidateStreamsByHashes === 'function') {
        const outcome = await Cache.invalidateStreamsByHashes(updates.map((row) => row.hash).filter(Boolean), reason || 'rd_view_scan');
        invalidated = Number(outcome?.invalidated || 0) + Number(outcome?.sharedDeleted || 0);
    }
    let rawInvalidated = 0;
    if (requestPage?.type && requestPage?.id && RawStreamCache && typeof RawStreamCache.invalidateRawStreamCacheByPage === 'function') {
        try {
            const rawOutcome = RawStreamCache.invalidateRawStreamCacheByPage(requestPage.type, requestPage.id, {
                logger,
                reason: reason || 'rd_view_scan'
            });
            rawInvalidated = Number(rawOutcome?.invalidated || 0) || 0;
        } catch (err) {
            logger?.warn?.(`[RD VIEW SCAN] raw cache invalidation failed | page=${getMetaLabel(requestPage)} | error=${err.message}`);
        }
    }
    return { updated: Number(updated || 0), invalidated, rawInvalidated };
}

async function processBatch(job, batch) {
    const { apiKey, meta = {}, Cache, logger = console, db = dbHelper } = job;
    const normalizedBatch = batch.filter((item) => normalizeHash(item.hash) && item.magnet);
    if (normalizedBatch.length === 0) return { updated: 0, scanned: 0, changed: 0 };

    logger.info?.(`[RD VIEW SCAN] probing batch size=${normalizedBatch.length} page=${getJobPageLabel(job)} kind=${getJobKindLabel(job)} priority=${job.priority || 'normal'}`);

    const { results = {}, deferred = [] } = await RealDebridProbe.probeAvailabilityFast(
        normalizedBatch,
        apiKey,
        normalizedBatch.length,
        { exactForeground: true, exactLimit: Math.min(RD_VIEW_SCAN_EXACT_LIMIT, normalizedBatch.length) }
    );

    const updates = [];
    const packFileInserts = [];
    let changed = 0;

    for (const item of normalizedBatch) {
        const hash = normalizeHash(item.hash);
        const result = results[hash.toLowerCase()] || results[hash] || results[String(hash).toLowerCase()];
        if (!result) continue;

        const previous = normalizeRdStateValue(item._rdViewScanState) || 'unknown';
        const statePayload = mapProbeResultToState(result);

        if (Number.isInteger(Number(result.file_index)) && Number(result.file_index) >= 0) item.fileIdx = Number(result.file_index);
        if (result.episodeFileHint) {
            item._episodeExact = true;
            item._rdEpisodeExact = true;
            item._rdEpisodeProof = {
                exact: true,
                source: result.episodeFileHint.source || 'rd_view_scan_episode_file_hint',
                fileIdx: Number(result.episodeFileHint.fileIndex ?? result.file_index),
                fileName: result.episodeFileHint.fileName || result.file_title || null,
                filePath: result.episodeFileHint.filePath || result.file_title || null,
                confidence: Number(result.episodeFileHint.confidence || 1),
                reason: result.episodeFileHint.reason || 'rd_view_scan_exact_episode'
            };
            item.rdEpisodeProof = item._rdEpisodeProof;
            try { EpisodePrecision.applyEpisodePrecisionToItem(item, meta); } catch (_) {}
        }

        try {
            RdOracle.applyRdStateToItem(item, statePayload.state, {
                cached: statePayload.cached === true ? true : (statePayload.cached === false ? false : null),
                clearNegative: statePayload.state === 'cached' || statePayload.state === 'likely_cached'
            });
        } catch (_) {}

        const dbUpdate = buildDbUpdate(item, result, statePayload, meta);
        updates.push(dbUpdate);
        const packInsert = buildPackFileInsert(item, result, meta);
        if (packInsert) packFileInserts.push(packInsert);
        await persistAvailabilityPayload(Cache, db, item, statePayload, result, logger);

        if (previous !== statePayload.state) {
            changed += 1;
            logger.info?.(`[RD VIEW SCAN] status changed hash=${hash.toLowerCase()} ${previous} -> ${statePayload.state}`);
        }
    }

    if (Array.isArray(deferred) && deferred.length > 0) {
        for (const item of deferred) {
            const statePayload = { state: 'probing', cached: null, failures: item?._dbFailures || 0 };
            await persistAvailabilityPayload(Cache, db, item, statePayload, null, logger);
        }
        RealDebridProbe.backfillAvailabilityInBackground(deferred, apiKey, db, async (backgroundUpdates) => {
            const hashes = (backgroundUpdates || []).map((entry) => entry.hash).filter(Boolean);
            if (Cache && typeof Cache.invalidateStreamsByHashes === 'function' && hashes.length > 0) {
                await Cache.invalidateStreamsByHashes(hashes, 'rd_view_scan_backfill');
            }
            logger.info?.(`[RD VIEW SCAN] deferred backfill updated=${hashes.length} page=${getJobPageLabel(job)} kind=${getJobKindLabel(job)}`);
        });
    }

    const persisted = await flushUpdates({ Cache, db, logger, updates, packFileInserts, reason: 'rd_view_scan', requestPage: job.requestPage });
    return { ...persisted, scanned: normalizedBatch.length, changed, deferred: deferred.length };
}

async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
        while (pendingQueue.length > 0) {
            const job = pendingQueue.shift();
            const { logger = console, candidates = [], meta = {} } = job;
            let scanned = 0;
            let updated = 0;
            let changed = 0;
            let rawInvalidated = 0;
            for (let i = 0; i < candidates.length; i += RD_VIEW_SCAN_BATCH_SIZE) {
                const batch = candidates.slice(i, i + RD_VIEW_SCAN_BATCH_SIZE);
                const outcome = await processBatch(job, batch);
                scanned += Number(outcome.scanned || 0);
                updated += Number(outcome.updated || 0);
                changed += Number(outcome.changed || 0);
                rawInvalidated += Number(outcome.rawInvalidated || 0);
                await sleep(RD_VIEW_SCAN_BETWEEN_BATCH_MS);
            }
            logger.info?.(`[RD VIEW SCAN] completed page=${getJobPageLabel(job)} kind=${getJobKindLabel(job)} priority=${job.priority || 'normal'} scanned=${scanned} updated=${updated} changed=${changed} rawInvalidated=${rawInvalidated}`);
        }
    } catch (err) {
        // Non deve mai rompere la richiesta stream: è solo backfill in background.
        console.warn(`[RD VIEW SCAN] queue error: ${err.message}`);
    } finally {
        queueRunning = false;
        if (pendingQueue.length > 0) setTimeout(() => { void runQueue(); }, 0);
    }
}

function enqueueRdViewScan(params = {}) {
    if (!RD_VIEW_SCAN_ENABLED) return { queued: false, reason: 'disabled' };
    const service = String(params.config?.service || params.service || 'rd').toLowerCase();
    if (service !== 'rd') return { queued: false, reason: 'service_not_rd' };
    const apiKey = params.apiKey || params.config?.key || params.config?.rd || params.config?.realdebrid || null;
    if (!apiKey) return { queued: false, reason: 'missing_api_key' };

    const logger = params.logger || console;
    const meta = params.meta || {};
    const requestPage = params.requestPage || meta;
    const kind = String(params.kind || requestPage?.source || 'visible').trim().toLowerCase();
    const priority = normalizePriorityLabel(params.priority || (kind === 'warmup' || kind === 'binge_warmup' ? 'low' : 'high'));
    const priorityValue = getPriorityValue(priority);
    const { candidates, stats } = collectViewScanCandidates(params.items || params.results || [], meta, {
        maxScan: params.maxScan || RD_VIEW_SCAN_TOP,
        getRdAvailabilityState: params.getRdAvailabilityState
    });

    if (candidates.length === 0) {
        logger.info?.(`[RD VIEW SCAN] collected unknown=0 probing=0 likely=0 page=${getMetaLabel(requestPage)} kind=${kind} priority=${priority} | skip=no_candidates`);
        return { queued: false, reason: 'no_candidates', stats };
    }

    const fingerprint = crypto.createHash('sha1')
        .update(`${getMetaLabel(requestPage)}|${kind}|${candidates.map((item) => buildViewScanKey('rd', item)).join('|')}`)
        .digest('hex')
        .slice(0, 16);
    const collectionKey = `${getMetaLabel(requestPage)}:${kind}:${fingerprint}`;
    if (priority !== 'high' && shouldSkipRecentWork(recentCollections, collectionKey, RD_VIEW_SCAN_COLLECTION_DEDUP_MS)) {
        return { queued: false, reason: 'collection_cooldown', stats };
    }
    if (priority === 'high') recentCollections.set(collectionKey, Date.now());

    const deduped = [];
    for (const item of candidates) {
        const key = buildViewScanKey('rd', item);
        if (!key) continue;
        if (!reserveViewScanKey(key, priorityValue, requestPage)) {
            logger.info?.(`[RD VIEW SCAN] skip duplicate hash=${String(item.hash).toLowerCase()} fileIdx=${item.fileIdx ?? 'auto'} page=${getMetaLabel(requestPage)} priority=${priority}`);
            continue;
        }
        deduped.push(item);
    }

    if (deduped.length === 0) return { queued: false, reason: 'deduped', stats };
    pendingQueue.push({
        apiKey,
        meta,
        requestPage,
        kind,
        priority,
        priorityValue,
        enqueuedAt: Date.now(),
        config: params.config || {},
        Cache: params.Cache,
        logger,
        db: params.db || dbHelper,
        candidates: deduped
    });
    sortPendingQueue();
    while (pendingQueue.length > RD_VIEW_SCAN_MAX_QUEUE) pendingQueue.pop();

    logger.info?.(`[RD VIEW SCAN] collected unknown=${stats.unknown} probing=${stats.probing} likely=${stats.likely} queued=${deduped.length}/${stats.total} page=${getMetaLabel(requestPage)} kind=${kind} priority=${priority}`);
    setTimeout(() => { void runQueue(); }, RD_VIEW_SCAN_START_DELAY_MS);
    return { queued: true, count: deduped.length, stats };
}

function getRdViewScannerStatus() {
    return {
        enabled: RD_VIEW_SCAN_ENABLED,
        pending: pendingQueue.length,
        running: queueRunning,
        inflightKeys: inFlightByHash.size,
        highPriorityPending: pendingQueue.filter((job) => job.priority === 'high').length,
        recentCollections: recentCollections.size
    };
}

module.exports = {
    enqueueRdViewScan,
    getRdViewScannerStatus,
    collectViewScanCandidates,
    __private: {
        normalizeHash,
        getAvailabilityCacheKey,
        mapProbeResultToState,
        buildDbUpdate,
        normalizePriorityLabel,
        getPriorityValue
    }
};
