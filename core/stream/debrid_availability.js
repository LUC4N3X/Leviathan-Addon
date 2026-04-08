'use strict';

const crypto = require('crypto');

const dbHelper = require('../storage/db_repository');
const RealDebridProbe = require('../../debrid/realdebrid_probe.js');
const { buildMagnet: buildTrackerMagnet } = require('../storage/tracker_registry');
const { extractInfoHash, withSharedPromise } = require('../utils');

const LOCAL_DB_CACHE_TTL = Math.max(5, Math.min(300, parseInt(process.env.LOCAL_DB_CACHE_TTL || '25', 10) || 25));
const RD_PRIORITY_DEDUP_MS = Math.max(1000, Math.min(120000, parseInt(process.env.RD_PRIORITY_DEDUP_MS || '15000', 10) || 15000));

const localDbLookupInflight = new Map();
const recentRdPriorityRequests = new Map();

function cleanupRecentMap(map, ttlMs, maxEntries = 2000) {
    if (!(map instanceof Map) || map.size === 0) return;
    const now = Date.now();
    for (const [key, ts] of map) {
        if ((now - Number(ts || 0)) > ttlMs) map.delete(key);
    }
    while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function shouldSkipRecentWork(map, key, ttlMs) {
    if (!key) return false;
    cleanupRecentMap(map, ttlMs);
    const now = Date.now();
    const previous = Number(map.get(key) || 0);
    if (previous > 0 && (now - previous) < ttlMs) return true;
    map.set(key, now);
    return false;
}

function createDebridAvailabilityTools({ Cache, logger, LIMITERS, CONFIG, incrementMetric, isSeasonPack, getMetaDbLookupKey }) {
    function normalizeDbResultItem(row) {
        const hash = extractInfoHash(row?.info_hash || row?.hash || row?.infoHash || '');
        if (!hash) return null;
        const fileIdx = row?.rd_file_index !== null && row?.rd_file_index !== undefined
            ? Number(row.rd_file_index)
            : (row?.file_index !== null && row?.file_index !== undefined ? Number(row.file_index) : undefined);
        return {
            hash,
            title: row?.title || `DB Torrent ${hash}`,
            source: row?.provider || 'LocalDB',
            seeders: Number(row?.seeders || 0),
            magnet: row?.magnet || buildTrackerMagnet(hash),
            fileIdx: Number.isInteger(fileIdx) && fileIdx >= 0 ? fileIdx : undefined,
            _size: Number(row?.rd_file_size || row?.size || row?.sizeBytes || 0),
            sizeBytes: Number(row?.rd_file_size || row?.size || row?.sizeBytes || 0),
            _dbCachedRd: row?.cached_rd === null || row?.cached_rd === undefined ? null : Boolean(row.cached_rd),
            _dbLastCachedCheck: row?.last_cached_check || null,
            _dbNextCachedCheck: row?.next_cached_check || null,
            _dbFailures: Number(row?.cache_check_failures || 0)
        };
    }

    async function fetchLocalDbResults(meta) {
        if (!dbHelper || typeof dbHelper.getTorrents !== 'function' || !meta?.imdb_id) return [];
        const cacheKey = getMetaDbLookupKey(meta);
        if (!cacheKey) return [];

        const cachedRows = await Cache.getDbTorrents(cacheKey);
        if (cachedRows !== null) return Array.isArray(cachedRows) ? cachedRows : [];

        try {
            return await withSharedPromise(localDbLookupInflight, `db_lookup:${cacheKey}`, async () => {
                const cachedAgain = await Cache.getDbTorrents(cacheKey);
                if (cachedAgain !== null) return Array.isArray(cachedAgain) ? cachedAgain : [];

                const rows = await dbHelper.getTorrents(meta.imdb_id, meta.season, meta.episode);
                const normalizedRows = (Array.isArray(rows) ? rows : []).map(normalizeDbResultItem).filter(Boolean);
                await Cache.cacheDbTorrents(cacheKey, normalizedRows, LOCAL_DB_CACHE_TTL);
                return normalizedRows;
            });
        } catch (err) {
            logger.warn(`[DB READ] Lookup locale fallito: ${err.message}`);
            return [];
        }
    }

    function getRdAvailabilityState(service, item) {
        const normalizedService = String(service || '').toLowerCase();

        const explicitState = typeof item?._rdCacheState === 'string'
            ? String(item._rdCacheState).trim().toLowerCase()
            : (typeof item?.rdCacheState === 'string' ? String(item.rdCacheState).trim().toLowerCase() : '');
        if (explicitState === 'cached' || explicitState === 'uncached' || explicitState === 'unknown' || explicitState === 'probing') {
            return explicitState;
        }

        if (normalizedService === 'tb') {
            return item?._tbCached ? 'cached' : 'unknown';
        }

        if (normalizedService !== 'rd' && normalizedService !== 'ad') {
            return 'unknown';
        }

        if (item?._rdCacheState) return String(item._rdCacheState);
        if (item?.rdCacheState) return String(item.rdCacheState);

        if (item?._dbCachedRd === true || item?.cached_rd === true) return 'cached';
        if (item?._dbCachedRd === false || item?.cached_rd === false) return 'uncached';

        return 'unknown';
    }

    function propagateRdKnownStatesByHash(items) {
        const list = Array.isArray(items) ? items : [];
        const stateByHash = new Map();

        const stateRank = (state) => {
            if (state === 'cached') return 3;
            if (state === 'uncached') return 2;
            if (state === 'probing') return 1;
            return 0;
        };

        for (const item of list) {
            const hash = String(item?.hash || item?.infoHash || '').trim().toUpperCase();
            if (!/^[A-F0-9]{40}$/.test(hash)) continue;
            const state = getRdAvailabilityState('rd', item);
            if (state === 'unknown') continue;

            const current = stateByHash.get(hash);
            if (!current || stateRank(state) > stateRank(current.state)) {
                stateByHash.set(hash, {
                    state,
                    cached: state === 'cached' ? true : state === 'uncached' ? false : null,
                    sizeBytes: Number(item?._size || item?.sizeBytes || 0) || 0
                });
            }
        }

        if (stateByHash.size === 0) return list;

        for (const item of list) {
            const hash = String(item?.hash || item?.infoHash || '').trim().toUpperCase();
            const known = stateByHash.get(hash);
            if (!known) continue;

            const currentState = getRdAvailabilityState('rd', item);
            if (currentState === 'unknown') {
                item._rdCacheState = known.state;
                item.rdCacheState = known.state;
                if (known.cached === true || known.cached === false) {
                    item._dbCachedRd = known.cached;
                    item.cached_rd = known.cached;
                }
            }

            if (known.sizeBytes > 0 && !(Number(item?._size || item?.sizeBytes || 0) > 0)) {
                item._size = known.sizeBytes;
                item.sizeBytes = known.sizeBytes;
            }
        }

        return list;
    }

    async function hydrateRdDbStatesByHash(items) {
        const list = Array.isArray(items) ? items : [];
        if (list.length === 0) return list;
        if (!dbHelper || typeof dbHelper.getRdCacheStatusByHashes !== 'function') return list;

        const hashes = [...new Set(list
            .map((item) => String(item?.hash || item?.infoHash || '').trim().toLowerCase())
            .filter((hash) => /^[a-f0-9]{40}$/.test(hash)))];

        if (hashes.length === 0) return list;

        try {
            const rows = await dbHelper.getRdCacheStatusByHashes(hashes);
            const byHash = new Map((Array.isArray(rows) ? rows : [])
                .filter((row) => row?.hash)
                .map((row) => [String(row.hash).trim().toLowerCase(), row]));

            for (const item of list) {
                const hash = String(item?.hash || item?.infoHash || '').trim().toLowerCase();
                if (!hash) continue;
                const row = byHash.get(hash);
                if (!row) continue;

                if (row.cached_rd === true || row.cached_rd === false) {
                    item._dbCachedRd = row.cached_rd;
                    item.cached_rd = row.cached_rd;
                    item._dbLastCachedCheck = row.last_cached_check || item._dbLastCachedCheck || null;
                    item._dbNextCachedCheck = row.next_cached_check || item._dbNextCachedCheck || null;
                    item._dbFailures = Number(row.cache_check_failures || item._dbFailures || 0);

                    const currentState = getRdAvailabilityState('rd', item);
                    if (currentState === 'unknown') {
                        const state = row.cached_rd === true ? 'cached' : 'uncached';
                        item._rdCacheState = state;
                        item.rdCacheState = state;
                    }
                }

                if (!(Number(item?._size || item?.sizeBytes || 0) > 0)) {
                    const knownSize = Number(row.rd_file_size || row.size || 0);
                    if (knownSize > 0) {
                        item._size = knownSize;
                        item.sizeBytes = knownSize;
                    }
                }

                if ((item?.fileIdx === undefined || item?.fileIdx === null) && Number.isInteger(row?.rd_file_index) && row.rd_file_index >= 0) {
                    item.fileIdx = row.rd_file_index;
                }
            }
        } catch (err) {
            logger.warn(`[DB READ] Overlay stato RD per hash fallito: ${err.message}`);
        }

        return propagateRdKnownStatesByHash(list);
    }

    function applyRdDbAvailabilityPriority(items, config) {
        const list = Array.isArray(items) ? items : [];
        const cachedOnly = config?.filters?.rdCachedOnly === true;
        const cached = [];
        const unknown = [];
        const uncached = [];

        for (const item of list) {
            if (item?._dbCachedRd === true) cached.push(item);
            else if (item?._dbCachedRd === false) uncached.push(item);
            else unknown.push(item);
        }

        return cachedOnly ? [...cached] : [...cached, ...unknown, ...uncached];
    }

    function isGuaranteedCachedExternal(item) {
        return Boolean(item?.isExternal || item?.externalAddon);
    }

    async function hydrateRdForegroundAvailability(items, apiKey, options = {}) {
        const list = Array.isArray(items) ? items : [];
        if (!apiKey || list.length === 0) return list;

        const visibleWindow = Math.max(
            1,
            Math.min(
                CONFIG.MAX_RESULTS || 70,
                parseInt(options.visibleWindow ?? process.env.RD_FOREGROUND_VISIBLE_WINDOW ?? '9', 10) || 9
            )
        );
        const probeLimit = Math.max(
            1,
            Math.min(
                visibleWindow,
                parseInt(options.probeLimit ?? process.env.RD_FOREGROUND_CACHE_LIMIT ?? '9', 10) || 9
            )
        );
        const minKnownStates = Math.max(
            1,
            Math.min(
                visibleWindow,
                parseInt(options.minKnownStates ?? process.env.RD_FOREGROUND_MIN_KNOWN ?? '4', 10) || 4
            )
        );

        const visibleSlice = list.slice(0, visibleWindow);
        const knownStates = visibleSlice.filter((item) => {
            const state = getRdAvailabilityState('rd', item);
            return state === 'cached' || state === 'uncached' || state === 'probing';
        }).length;

        if (knownStates >= minKnownStates) {
            logger.info(`[RD PROBE] Skip live check | known=${knownStates}/${visibleSlice.length} | threshold=${minKnownStates}`);
            return list;
        }

        const unknownCandidates = visibleSlice
            .filter((item) => !isGuaranteedCachedExternal(item) && getRdAvailabilityState('rd', item) === 'unknown' && item?.hash && item?.magnet)
            .slice(0, probeLimit);

        if (unknownCandidates.length === 0) return list;

        logger.info(`[RD PROBE] Verifico disponibilita live per ${unknownCandidates.length} risultati unknown...`);

        try {
            const { results = {}, deferred = [] } = await LIMITERS.rdResolve.schedule(() =>
                RealDebridProbe.probeAvailabilityFast(unknownCandidates, apiKey, unknownCandidates.length)
            );

            const dbUpdates = [];

            for (const item of unknownCandidates) {
                const hash = String(item?.hash || '').trim().toLowerCase();
                const result = results[hash];
                if (!result) continue;

                const availabilityState = result.cached === true ? 'cached' : 'uncached';
                item._rdCacheState = availabilityState;
                item.rdCacheState = availabilityState;
                item._dbCachedRd = result.cached === true;
                item.cached_rd = result.cached === true;

                if (Number.isFinite(result.file_size) && result.file_size > 0) {
                    item._size = Math.max(Number(item._size || item.sizeBytes || 0), Number(result.file_size));
                    item.sizeBytes = Math.max(Number(item.sizeBytes || item._size || 0), Number(result.file_size));
                }

                dbUpdates.push({
                    hash: item.hash,
                    cached: result.cached === true,
                    rd_file_size: Number.isFinite(result.file_size) && result.file_size > 0 ? Number(result.file_size) : null,
                    failures: 0,
                    next_hours: result.cached === true ? (24 * 30) : (24 * 7)
                });
            }

            if (dbUpdates.length > 0 && typeof dbHelper.updateRdCacheStatus === 'function') {
                try {
                    await dbHelper.updateRdCacheStatus(dbUpdates);
                    await Cache.invalidateStreamsByHashes(dbUpdates.map((row) => row.hash), 'rd_foreground_live_check');
                } catch (err) {
                    logger.warn(`[RD PROBE] Persistenza stato disponibilita fallita: ${err.message}`);
                }
            }

            if (Array.isArray(deferred) && deferred.length > 0) {
                for (const item of deferred) {
                    item._rdCacheState = 'probing';
                    item.rdCacheState = 'probing';
                }
                RealDebridProbe.backfillAvailabilityInBackground(deferred, apiKey, dbHelper, async (updates) => {
                    await Cache.invalidateStreamsByHashes((updates || []).map((entry) => entry.hash), 'rd_background_backfill');
                });
            }

            logger.info(`[RD PROBE] Live check completato | cached=${dbUpdates.filter((row) => row.cached).length} | uncached=${dbUpdates.filter((row) => !row.cached).length} | deferred=${Array.isArray(deferred) ? deferred.length : 0}`);
        } catch (err) {
            logger.warn(`[RD PROBE] Verifica disponibilita live fallita: ${err.message}`);
        }

        return list;
    }

    function queueRdPriorityAudit(meta, results, config, reason = 'visible_results') {
        if (String(config?.service || 'rd').toLowerCase() !== 'rd') return;
        if (!dbHelper || typeof dbHelper.prioritizeRdHashes !== 'function') return;

        const maxPriority = Math.max(1, Math.min(30, parseInt(process.env.RD_PRIORITY_TOP || '18', 10) || 18));
        const priorityMinutes = Math.max(0, Math.min(120, parseInt(process.env.RD_PRIORITY_WINDOW_MIN || '5', 10) || 5));
        const candidateHashes = [...new Set((Array.isArray(results) ? results : [])
            .filter((item) => !isGuaranteedCachedExternal(item) && getRdAvailabilityState('rd', item) === 'unknown' && item?.hash)
            .slice(0, maxPriority)
            .map((item) => item.hash))];

        if (candidateHashes.length === 0) return;

        const prioritySig = crypto.createHash('sha1').update(candidateHashes.slice(0, 12).join('|')).digest('hex').slice(0, 12);
        const priorityKey = `${getMetaDbLookupKey(meta) || meta?.imdb_id || 'n/a'}:${reason}:${prioritySig}`;
        if (shouldSkipRecentWork(recentRdPriorityRequests, priorityKey, RD_PRIORITY_DEDUP_MS)) {
            incrementMetric('rdPriority.skippedCooldown', candidateHashes.length);
            return;
        }

        incrementMetric('rdPriority.requested', candidateHashes.length);

        setTimeout(() => {
            (async () => {
                let updated = 0;
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    const outcome = await dbHelper.prioritizeRdHashes(candidateHashes, { limit: maxPriority, priorityMinutes });
                    updated = Number(outcome?.updated || 0);
                    if (updated > 0) break;
                    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
                }

                incrementMetric(updated > 0 ? 'rdPriority.applied' : 'rdPriority.noop', candidateHashes.length);
                logger.info(`[RD PRIORITY] reason=${reason} | imdb=${meta?.imdb_id || 'n/a'} | hashes=${candidateHashes.length} | updated=${updated}`);
            })().catch((err) => logger.warn(`[RD PRIORITY] Errore scheduling: ${err.message}`));
        }, 0);
    }

    async function reprioritizeRdRankedList(rankedList, meta, config, hasDebridKey) {
        const service = String(config?.service || 'rd').toLowerCase();
        if (service !== 'rd' || !hasDebridKey) return rankedList;

        let prioritized = applyRdDbAvailabilityPriority(rankedList, config);
        const apiKey = config.key || config.rd;
        await hydrateRdForegroundAvailability(prioritized, apiKey);
        prioritized = applyRdDbAvailabilityPriority(prioritized, config);
        queueRdPriorityAudit(meta, prioritized, config, 'stream_open');
        return prioritized;
    }

    async function persistResolvedDebridAvailability(meta, item, streamData, service, reason = 'direct_resolve') {
        const normalizedService = String(service || '').toLowerCase();
        if (!item?.hash) return false;
        if (!['rd', 'ad'].includes(normalizedService)) return false;
        if (!dbHelper || typeof dbHelper.updateRdCacheStatus !== 'function') return false;

        const rawFileIndex = streamData?.rd_file_index ?? streamData?.file_index ?? streamData?.fileIdx ?? item?.fileIdx;
        const rawFileSize = streamData?.rd_file_size ?? streamData?.file_size ?? streamData?.filesize ?? streamData?.size ?? item?._size ?? item?.sizeBytes ?? null;
        const parsedFileIndex = Number(rawFileIndex);
        const parsedFileSize = Number(rawFileSize);
        const resolvedTitle = streamData?.filename || item?.title || String(item.hash);

        try {
            if ((!meta?.imdb_id) && typeof dbHelper.ensureTorrentRecord === 'function') {
                await dbHelper.ensureTorrentRecord({
                    info_hash: item.hash,
                    title: resolvedTitle,
                    size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : Number(item?._size || item?.sizeBytes || 0),
                    seeders: Number(item?.seeders || 0) || 0,
                    provider: item?.source || normalizedService.toUpperCase(),
                    file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : (item?.fileIdx !== undefined ? item.fileIdx : undefined)
                });
            }
            if (meta?.imdb_id && typeof dbHelper.insertTorrent === 'function') {
                await dbHelper.insertTorrent(meta, {
                    info_hash: item.hash,
                    title: resolvedTitle,
                    size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : Number(item?._size || item?.sizeBytes || 0),
                    seeders: Number(item?.seeders || 0) || 0,
                    provider: item?.source || normalizedService.toUpperCase(),
                    file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : (item?.fileIdx !== undefined ? item.fileIdx : undefined),
                    is_pack: Boolean(item?._isPack || isSeasonPack(resolvedTitle))
                });
            }

            const updated = await dbHelper.updateRdCacheStatus([{
                hash: item.hash,
                cached: true,
                rd_file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : null,
                rd_file_size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : null,
                failures: 0,
                permanent: true
            }]);

            if (updated > 0) {
                await Cache.invalidateStreamsByHashes([item.hash], `${reason}_cached`);
                if (meta?.imdb_id) await Cache.invalidateStreamsByImdb(meta.imdb_id, `${reason}_cached`);
                const dbLookupKey = getMetaDbLookupKey(meta);
                if (dbLookupKey) await Cache.invalidateDbTorrents(dbLookupKey, `${reason}_cached`);
                logger.info(`[RD AVAILABILITY] Persisted resolved hit | reason=${reason} | service=${normalizedService} | hash=${item.hash} | updated=${updated}`);
                return true;
            }
        } catch (err) {
            logger.warn(`[RD AVAILABILITY] Persist resolved hit fallita | reason=${reason} | service=${normalizedService} | hash=${item.hash} | error=${err.message}`);
        }

        return false;
    }

    return {
        fetchLocalDbResults,
        propagateRdKnownStatesByHash,
        hydrateRdDbStatesByHash,
        reprioritizeRdRankedList,
        getRdAvailabilityState,
        isGuaranteedCachedExternal,
        persistResolvedDebridAvailability
    };
}

module.exports = { createDebridAvailabilityTools };
