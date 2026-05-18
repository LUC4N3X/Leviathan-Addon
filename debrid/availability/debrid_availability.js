'use strict';

const crypto = require('crypto');

const dbHelper = require('../../storage/db_repository');
const RealDebridProbe = require('../rd/probe/realdebrid_probe');
const { buildMagnet: buildTrackerMagnet } = require('../../storage/tracker_registry');
const { extractInfoHash, withSharedPromise, isSeasonPack, extractSeasonEpisodeFromFilename } = require('../../utils');
const { shouldSkipRecentWork } = require('../../recent_work');
const RdOracle = require('../rd/state/cache_oracle');
const EpisodePrecision = require('../../stream/episode_precision');
const { normalizeTbCacheState, toRdCacheState } = require('../tb/availability/torbox_cache_state');

const LOCAL_DB_CACHE_TTL = 25;
const RD_PRIORITY_DEDUP_MS = 15000;
const RD_FOREGROUND_VISIBLE_WINDOW = 9;
const RD_FOREGROUND_CACHE_LIMIT = 9;
const RD_FOREGROUND_MIN_KNOWN = 4;
const RD_FOREGROUND_FALLBACK_PROBE_LIMIT = 3;
const RD_FOREGROUND_EXACT_LIMIT = 4;
const RD_PRIORITY_TOP = 18;
const RD_PRIORITY_WINDOW_MIN = 5;
const RD_HIDE_DUBIOUS_WHEN_ENOUGH_SAFE = true;
const RD_MIN_EXACT_SAFE_RESULTS = 3;
const AVAILABILITY_CACHE_HIT_TTL = 24 * 60 * 60;
const AVAILABILITY_CACHE_NEGATIVE_TTL = 6 * 60 * 60;
const AVAILABILITY_CACHE_PROBING_TTL = 120;
const DEBRID_CACHE_CHECK_MARKER_TTL = 30 * 60;
const LOCAL_AVAILABILITY_MAX_ENTRIES = 8000;
const LOCAL_CHECK_MARKER_MAX_ENTRIES = 3000;
const LOCAL_DB_LOOKUP_INFLIGHT_MAX_ENTRIES = 2000;

const localDbLookupInflight = new Map();
const recentRdPriorityRequests = new Map();
const localAvailabilityCache = new Map();
const localDebridCheckMarkers = new Map();

const VALID_RD_STATES = new Set(['cached', 'likely_cached', 'probing', 'likely_uncached', 'uncached_terminal', 'unknown']);
const TERMINAL_RD_NEGATIVE_STATUSES = new Set(['error', 'magnet_error', 'virus', 'dead']);
const TRUSTED_RELEASE_GROUP_RE = /\b(rarbg|yts|yify|qxr|ntb|evo|tgx|galaxyrg|vxt|cmrg|tigole|framestor|epsilon|sparks|ctrlhd|flux|playweb|webrip|web-dl|bluray|remux)\b/i;

function normalizeRdStateValue(state) {
    const normalized = String(state || '').trim().toLowerCase();
    return VALID_RD_STATES.has(normalized) ? normalized : null;
}

function isFreshFuture(value, skewMs = 15000) {
    if (!value) return false;
    const ts = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(ts) && ts > Date.now() + skewMs;
}

function deriveDbTbAvailability(row = {}) {
    const rawState = normalizeTbCacheState(row?.tb_cache_state, null);
    const cachedBool = row?.tb_cached === true ? true : (row?.tb_cached === false ? false : null);
    const state = rawState || (cachedBool === true ? 'cached_verified' : (cachedBool === false ? 'uncached' : null));
    const fresh = isFreshFuture(row?.tb_next_cached_check);
    return {
        state,
        rdState: state ? toRdCacheState(state) : null,
        cached: state === 'cached_verified' ? true : (state === 'uncached' ? false : cachedBool),
        fresh
    };
}

function normalizeFileIdxForAvailability(fileIdx) {
    if (fileIdx === undefined || fileIdx === null || fileIdx === '') return 'auto';
    const parsed = Number.parseInt(fileIdx, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? String(parsed) : 'auto';
}


function buildDebridUserHash(apiKey) {
    const raw = String(apiKey || '').trim();
    if (!raw) return 'global';
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function buildDebridMediaId(meta = {}) {
    const imdb = String(meta?.imdb_id || meta?.imdbId || meta?.id || '').trim().toLowerCase();
    const tmdb = String(meta?.tmdb_id || meta?.tmdbId || meta?.tmdb || '').trim().toLowerCase();
    const kitsu = String(meta?.kitsu_id || meta?.kitsuId || '').trim().toLowerCase();
    const providerId = imdb || (tmdb ? `tmdb:${tmdb}` : '') || (kitsu ? `kitsu:${kitsu}` : '');
    if (!providerId) return null;
    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    if (season > 0 && episode > 0) return `${providerId}:s${season}:e${episode}`;
    return providerId;
}

function encodeAvailabilityMediaId(mediaId) {
    const raw = String(mediaId || '').trim().toLowerCase();
    if (!raw) return null;
    return raw.replace(/[^a-z0-9:_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 220) || null;
}

function getAvailabilityMediaId(meta = {}) {
    return encodeAvailabilityMediaId(buildDebridMediaId(meta));
}

function isSeriesAvailabilityMeta(meta = {}) {
    return Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
}

function pruneTimedMap(map, maxEntries) {
    if (!map || map.size <= maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of map.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= now) map.delete(key);
    }
    while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

function getTimedMapValue(map, key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return null;
    const entry = map.get(normalizedKey);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
        map.delete(normalizedKey);
        return null;
    }
    return entry.value;
}

function setTimedMapValue(map, key, value, ttlSeconds, maxEntries) {
    const normalizedKey = String(key || '').trim();
    const ttl = Math.max(1, Number(ttlSeconds || 0) || 0);
    if (!normalizedKey || value === undefined || value === null || ttl <= 0) return false;
    if (map.has(normalizedKey)) map.delete(normalizedKey);
    map.set(normalizedKey, { value, expiresAt: Date.now() + ttl * 1000 });
    pruneTimedMap(map, maxEntries);
    return true;
}

function getLocalAvailabilityPayload(cacheKey, legacyKey = null) {
    return getTimedMapValue(localAvailabilityCache, cacheKey) ||
        (legacyKey && legacyKey !== cacheKey ? getTimedMapValue(localAvailabilityCache, legacyKey) : null);
}

function rememberLocalAvailabilityPayload(cacheKey, payload, ttlSeconds) {
    if (!cacheKey || !payload || typeof payload !== 'object') return false;
    return setTimedMapValue(localAvailabilityCache, cacheKey, payload, ttlSeconds, LOCAL_AVAILABILITY_MAX_ENTRIES);
}

function buildDebridCheckMarkerLocalKey(service, apiKey, meta = {}) {
    const mediaId = buildDebridMediaId(meta);
    if (!mediaId) return null;
    return `${String(service || 'rd').trim().toLowerCase() || 'rd'}:${buildDebridUserHash(apiKey)}:${mediaId}`;
}

async function isRecentDebridMediaCheck(service, apiKey, meta, logger = console) {
    const mediaId = buildDebridMediaId(meta);
    if (!mediaId) return false;

    const localKey = buildDebridCheckMarkerLocalKey(service, apiKey, meta);
    if (getTimedMapValue(localDebridCheckMarkers, localKey) === true) return true;

    if (!dbHelper || typeof dbHelper.isDebridCacheCheckMarked !== 'function') return false;
    try {
        const marked = await dbHelper.isDebridCacheCheckMarked({
            service,
            userHash: buildDebridUserHash(apiKey),
            mediaId
        });
        if (marked && localKey) {
            setTimedMapValue(localDebridCheckMarkers, localKey, true, DEBRID_CACHE_CHECK_MARKER_TTL, LOCAL_CHECK_MARKER_MAX_ENTRIES);
        }
        return marked;
    } catch (err) {
        logger.warn?.(`[DEBRID CHECK MARKER] read failed: ${err.message}`);
        return false;
    }
}

async function markDebridMediaCheckDone(service, apiKey, meta, logger = console) {
    const mediaId = buildDebridMediaId(meta);
    if (!mediaId) return false;

    const localKey = buildDebridCheckMarkerLocalKey(service, apiKey, meta);
    if (localKey) {
        setTimedMapValue(localDebridCheckMarkers, localKey, true, DEBRID_CACHE_CHECK_MARKER_TTL, LOCAL_CHECK_MARKER_MAX_ENTRIES);
    }

    if (!dbHelper || typeof dbHelper.markDebridCacheCheckDone !== 'function') return Boolean(localKey);
    try {
        return await dbHelper.markDebridCacheCheckDone({
            service,
            userHash: buildDebridUserHash(apiKey),
            mediaId,
            ttlSeconds: DEBRID_CACHE_CHECK_MARKER_TTL
        });
    } catch (err) {
        logger.warn?.(`[DEBRID CHECK MARKER] write failed: ${err.message}`);
        return Boolean(localKey);
    }
}

function getAvailabilityCacheKey(service, hash, fileIdx = null, meta = null) {
    const normalizedService = String(service || 'rd').trim().toLowerCase();
    const normalizedHash = String(hash || '').trim().toUpperCase();
    if (!/^[A-F0-9]{40}$/.test(normalizedHash)) return null;
    const baseKey = `${normalizedService}:${normalizedHash}:${normalizeFileIdxForAvailability(fileIdx)}`;
    const mediaId = getAvailabilityMediaId(meta);
    return mediaId ? `${baseKey}:${mediaId}` : baseKey;
}

function getAvailabilityCacheKeys(service, hash, fileIdx = null, meta = {}) {
    const primary = getAvailabilityCacheKey(service, hash, fileIdx, meta);
    if (!primary) return { primary: null, fallbacks: [] };

    const normalizedService = String(service || 'rd').trim().toLowerCase();
    const normalizedHash = String(hash || '').trim().toUpperCase();
    const filePart = normalizeFileIdxForAvailability(fileIdx);
    const fallbacks = [];
    const fileScoped = `${normalizedService}:${normalizedHash}:${filePart}`;

    if (fileScoped !== primary) fallbacks.push(fileScoped);
    // Hash-only legacy cache is safe for movies. For series it can leak a pack
    // result from another episode, so allow it only when a concrete file id exists.
    if (!isSeriesAvailabilityMeta(meta) || filePart !== 'auto') fallbacks.push(`${normalizedService}:${normalizedHash}`);

    return { primary, fallbacks: [...new Set(fallbacks.filter(Boolean))] };
}

function getLegacyAvailabilityCacheKey(service, hash) {
    const normalizedService = String(service || 'rd').trim().toLowerCase();
    const normalizedHash = String(hash || '').trim().toUpperCase();
    if (!/^[A-F0-9]{40}$/.test(normalizedHash)) return null;
    return `${normalizedService}:${normalizedHash}`;
}

function buildAvailabilityCachePayload(statePayload = {}, item = {}, result = null, meta = {}) {
    const proof = item?._rdEpisodeProof || item?.rdEpisodeProof || result?.episodeFileHint || null;
    const episodeExact = item?._episodeExact === true || item?._rdEpisodeExact === true || proof?.exact === true;
    return {
        state: normalizeRdStateValue(statePayload.state) || null,
        cached: statePayload.cached === true ? true : statePayload.cached === false ? false : null,
        failures: Math.max(0, Number(statePayload.failures || 0) || 0),
        fileSize: Number(result?.file_size || item?._size || item?.sizeBytes || 0) || 0,
        fileIdx: Number.isInteger(Number(item?.fileIdx)) && Number(item.fileIdx) >= 0 ? Number(item.fileIdx) : null,
        mediaId: getAvailabilityMediaId(meta),
        imdbId: String(meta?.imdb_id || meta?.imdbId || '').trim().toLowerCase() || null,
        season: Number(meta?.season || 0) > 0 ? Number(meta.season) : null,
        episode: Number(meta?.episode || 0) > 0 ? Number(meta.episode) : null,
        proofLevel: episodeExact ? 'episode_file' : (Number.isInteger(Number(item?.fileIdx)) && Number(item.fileIdx) >= 0 ? 'file' : 'hash'),
        episodeExact,
        episodeProof: proof && typeof proof === 'object' ? proof : null,
        episodeFileHint: item?.episodeFileHint || item?._episodeFileHint || result?.episodeFileHint || null,
        ts: Date.now()
    };
}

function applyAvailabilityCachePayload(item, payload, meta = {}) {
    if (!item || !payload || !payload.state) return false;
    const incomingState = normalizeRdStateValue(payload.state);
    if (!incomingState) return false;

    if (payload.episodeFileHint && typeof payload.episodeFileHint === 'object') {
        item.episodeFileHint = item.episodeFileHint || payload.episodeFileHint;
        item._episodeFileHint = item._episodeFileHint || payload.episodeFileHint;
    }
    if (payload.episodeExact === true || payload.episodeProof?.exact === true) {
        item._episodeExact = true;
        item._rdEpisodeExact = true;
        item._rdEpisodeProof = payload.episodeProof || item._rdEpisodeProof || null;
        item.rdEpisodeProof = item._rdEpisodeProof;
    }
    EpisodePrecision.applyEpisodePrecisionToItem(item, meta);

    const effectiveIncoming = RdOracle.resolveEffectiveRdState({
        ...item,
        _rdCacheState: incomingState,
        rdCacheState: incomingState,
        _dbCachedRd: payload.cached === true ? true : (payload.cached === false ? false : item?._dbCachedRd),
        cached_rd: payload.cached === true ? true : (payload.cached === false ? false : item?.cached_rd),
        fileIdx: Number.isInteger(payload.fileIdx) && payload.fileIdx >= 0 ? payload.fileIdx : item?.fileIdx
    }, meta);
    const currentState = RdOracle.resolveEffectiveRdState(item, meta);
    if (!RdOracle.shouldUpgradeState(currentState, effectiveIncoming) && currentState !== 'unknown') return false;
    RdOracle.applyRdStateToItem(item, effectiveIncoming, {
        cached: payload.cached === true && effectiveIncoming === 'cached' ? true : (effectiveIncoming === 'uncached_terminal' && payload.cached === false ? false : null),
        fileIdx: Number.isInteger(payload.fileIdx) && payload.fileIdx >= 0 ? payload.fileIdx : undefined,
        fileSize: Number(payload.fileSize || 0) || 0,
        clearNegative: effectiveIncoming === 'cached' || effectiveIncoming === 'likely_cached'
    });
    item._dbFailures = Math.max(0, Number(payload.failures || 0) || 0);
    return true;
}

function getRdStateRank(state) {
    return RdOracle.getRdStateRank(state);
}

function hasHeavyNegativeProtection(item) {
    const title = String(item?.title || item?.torrent_title || '').toLowerCase();
    const explicitFile = Number.isInteger(Number(item?.fileIdx)) && Number(item?.fileIdx) >= 0;
    const previousPositive = item?._dbCachedRd === true || normalizeRdStateValue(item?._rdCacheState || item?.rdCacheState) === 'cached';
    return Boolean(
        explicitFile ||
        previousPositive ||
        item?._isPack ||
        /\b(pack|complete|season|stagione|integrale|collection|collezione|trilogy|saga)\b/i.test(title) ||
        TRUSTED_RELEASE_GROUP_RE.test(title)
    );
}

function isPastDueDate(value, skewMs = 15000) {
    if (!value) return false;
    const ts = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(ts) && ts <= (Date.now() + skewMs);
}

function deriveDbRdAvailability(row = {}) {
    const rawState = normalizeRdStateValue(row?.rd_cache_state);
    const cachedBool = row?.cached_rd === true ? true : (row?.cached_rd === false ? false : null);
    const stalePositive = (cachedBool === true || rawState === 'cached') && isPastDueDate(row?.next_cached_check);

    if (stalePositive) {
                        
        return {
            state: 'likely_cached',
            cached: null,
            stale: true
        };
    }

    return {
        state: rawState || (cachedBool === true ? 'cached' : (cachedBool === false ? 'likely_uncached' : null)),
        cached: cachedBool,
        stale: false
    };
}


function shouldPersistResolvedAsPack(item = {}, resolvedTitle = '', meta = {}) {
    const season = Number(meta?.season || 0);
    const episode = Number(meta?.episode || 0);
    const isSeries = Boolean(meta?.isSeries || (season > 0 && episode > 0));
    if (!isSeries) return false;

    const title = String(resolvedTitle || item?.title || '');
    const filename = String(item?.filename || item?.file_title || '');
    const joined = [title, filename, item?.packTitle, item?.rawDescription].filter(Boolean).join(' ');

    if (season > 0 && episode > 0) {
        for (const text of [title, filename]) {
            const parsed = extractSeasonEpisodeFromFilename(String(text || ''), season);
            if (parsed && !parsed.isRange && !parsed.isBatch && parsed.season === season && parsed.episode === episode) return false;
        }
    }

    if (/\bS\d{1,2}E\d{1,3}\s*(?:-|~|to|a)\s*(?:E)?\d{1,3}\b/i.test(joined)) return true;
    if (/\b(?:episodes?|episodi?)\s*\d{1,3}\s*(?:-|~|to|a)\s*\d{1,3}\b/i.test(joined)) return true;
    if (/\b(?:batch|complete|completa|full|integrale|collection|raccolta)\b/i.test(joined)) return true;
    if (/\bS\d{1,2}E\d{1,3}\b/i.test(joined) || /\b\d{1,2}x\d{1,3}\b/i.test(joined)) return false;

    return Boolean(item?._isPack || item?.potentialPack || item?.packTitle || isSeasonPack(title));
}

function resolveRdNegativeDecision(item, result) {
    const rdStatus = String(result?.rd_status || '').trim().toLowerCase();
    const previousFailures = Math.max(0, Number(item?._dbFailures || 0));
    const heavyProtected = hasHeavyNegativeProtection(item);
    const terminal = TERMINAL_RD_NEGATIVE_STATUSES.has(rdStatus);

    if (!terminal) {
        return {
            state: 'likely_uncached',
            cached: null,
            failures: previousFailures + 1,
            next_hours: heavyProtected ? 6 : 12
        };
    }

    if (heavyProtected && previousFailures < 2) {
        return {
            state: 'likely_uncached',
            cached: null,
            failures: previousFailures + 1,
            next_hours: 6
        };
    }

    return {
        state: 'uncached_terminal',
        cached: false,
        failures: previousFailures + 1,
        next_hours: heavyProtected ? 24 : (24 * 7)
    };
}


function createDebridAvailabilityTools({ Cache, logger, LIMITERS, CONFIG, incrementMetric, isSeasonPack, getMetaDbLookupKey }) {
    function normalizeDbResultItem(row, meta = {}) {
        const hash = extractInfoHash(row?.info_hash || row?.hash || row?.infoHash || '');
        if (!hash) return null;
        const preferredSize = Number(row?.rd_file_size || row?.tb_file_size || row?.size || row?.sizeBytes || 0);
        const fileIdx = row?.rd_file_index !== null && row?.rd_file_index !== undefined
            ? Number(row.rd_file_index)
            : (row?.file_index !== null && row?.file_index !== undefined ? Number(row.file_index) : undefined);
        const rdDb = deriveDbRdAvailability(row);
        const tbDb = deriveDbTbAvailability(row);
        const matchedFileIndex = row?.matched_file_index !== null && row?.matched_file_index !== undefined
            ? Number(row.matched_file_index)
            : undefined;
        const matchedFileTitle = row?.matched_file_title || row?.file_title || null;
        const hasEpisodeMapping = isSeriesMeta(meta) && Number.isInteger(matchedFileIndex) && matchedFileIndex >= 0;
        const item = {
            hash,
            title: row?.title || `DB Torrent ${hash}`,
            source: row?.provider || 'LocalDB',
            seeders: Number(row?.seeders || 0),
            magnet: row?.magnet || buildTrackerMagnet(hash),
            fileIdx: Number.isInteger(fileIdx) && fileIdx >= 0 ? fileIdx : undefined,
            matched_file_index: Number.isInteger(matchedFileIndex) && matchedFileIndex >= 0 ? matchedFileIndex : undefined,
            matched_file_title: matchedFileTitle || undefined,
            _size: preferredSize,
            sizeBytes: preferredSize,
            _localDb: true,
            _sourceGroup: 'local_db',
            _dbProvider: row?.provider || null,
            _dbCachedRd: rdDb.cached,
            _rdCacheState: rdDb.state,
            rdCacheState: rdDb.state,
            _rdStalePositive: rdDb.stale === true,
            _dbLastCachedCheck: row?.last_cached_check || null,
            _dbNextCachedCheck: row?.next_cached_check || null,
            _dbFailures: Number(row?.cache_check_failures || 0),
            _tbDbCachedHint: tbDb.cached === true && tbDb.fresh === true,
            _tbDbLastCachedCheck: row?.tb_last_cached_check || null,
            _tbDbNextCachedCheck: row?.tb_next_cached_check || null,
            _tbDbCacheConfidence: Number(row?.tb_cache_confidence || 0) || 0,
            _tbCacheStateRaw: tbDb.state || null,
            tb_cache_state: tbDb.state || null,
            _tbCacheState: tbDb.rdState || null,
            tbCacheState: tbDb.rdState || null,
            _tbCacheMatchReason: row?.tb_cache_match_reason || null,
            _tbCached: tbDb.cached === true && tbDb.fresh === true,
            tbCached: tbDb.cached === true && tbDb.fresh === true
        };
        if (hasEpisodeMapping) {
            item.fileIdx = matchedFileIndex;
            item._dbEpisodeMapping = true;
            item._episodeExact = true;
            item._rdEpisodeExact = true;
            item._episodeProofSource = 'local_db_episode_mapping';
            item.episodeFileHint = {
                fileIndex: matchedFileIndex,
                fileIdx: matchedFileIndex,
                fileName: matchedFileTitle || undefined,
                filePath: matchedFileTitle || undefined,
                fileSize: preferredSize || undefined,
                season: Number(meta?.season || 0) || undefined,
                episode: Number(meta?.episode || 0) || undefined,
                confidence: 1,
                reason: 'db_imdb_season_episode_mapping',
                source: 'local_db'
            };
            item._episodeFileHint = item.episodeFileHint;
        }
        return EpisodePrecision.applyEpisodePrecisionToItem(item, meta);
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
                const normalizedRows = (Array.isArray(rows) ? rows : []).map((row) => normalizeDbResultItem(row, meta)).filter(Boolean);
                await Cache.cacheDbTorrents(cacheKey, normalizedRows, LOCAL_DB_CACHE_TTL);
                return normalizedRows;
            }, {
                maxEntries: LOCAL_DB_LOOKUP_INFLIGHT_MAX_ENTRIES
            });
        } catch (err) {
            logger.warn(`[DB READ] Lookup locale fallito: ${err.message}`);
            return [];
        }
    }

    function getRdAvailabilityState(service, item, meta = {}) {
        const normalizedService = String(service || '').toLowerCase();

        if (normalizedService === 'tb') {
            if (item?._savedCloud === true || item?.isSavedCloud === true) return 'cached';
            if ((item?._tbCached === true || item?.tbCached === true || item?.tb_cached === true) && item?._tbLiveChecked === true) return 'cached';
            const explicitTbState = normalizeRdStateValue(item?._tbCacheState || item?.tbCacheState);
            return explicitTbState || (item?._tbDbCachedHint === true ? 'likely_cached' : 'unknown');
        }

        if (normalizedService !== 'rd') return 'unknown';
        return RdOracle.resolveEffectiveRdState(item, meta);
    }

    function propagateRdKnownStatesByHash(items, meta = {}) {
        const list = Array.isArray(items) ? items : [];
        const stateByHash = new Map();

        const stateRank = (state) => getRdStateRank(state);

        for (const item of list) {
            const hash = String(item?.hash || item?.infoHash || '').trim().toUpperCase();
            if (!/^[A-F0-9]{40}$/.test(hash)) continue;
            const state = getRdAvailabilityState('rd', item, meta);
            if (state === 'unknown') continue;

            const current = stateByHash.get(hash);
            if (!current || stateRank(state) > stateRank(current.state)) {
                stateByHash.set(hash, {
                    state,
                    cached: state === 'cached' ? true : state === 'uncached_terminal' ? false : null,
                    sizeBytes: Number(item?._size || item?.sizeBytes || 0) || 0
                });
            }
        }

        if (stateByHash.size === 0) return list;

        for (const item of list) {
            const hash = String(item?.hash || item?.infoHash || '').trim().toUpperCase();
            const known = stateByHash.get(hash);
            if (!known) continue;

            const currentState = getRdAvailabilityState('rd', item, meta);
            const siblingState = RdOracle.getHashPositiveStateForSibling(known.state, item, meta);
            if (RdOracle.shouldUpgradeState(currentState, siblingState)) {
                RdOracle.applyRdStateToItem(item, siblingState, {
                    cached: known.cached === true && siblingState === 'cached' ? true : null,
                    clearNegative: siblingState === 'cached' || siblingState === 'likely_cached'
                });
            }

            if (known.sizeBytes > 0 && !(Number(item?._size || item?.sizeBytes || 0) > 0)) {
                item._size = known.sizeBytes;
                item.sizeBytes = known.sizeBytes;
            }
        }

        return list;
    }

    async function hydrateRdDbStatesByHash(items, meta = {}) {
        const list = Array.isArray(items) ? items : [];
        if (list.length === 0) return list;
        if (!dbHelper || typeof dbHelper.getRdCacheStatusByHashes !== 'function') return list;

        const hashes = [...new Set(list
            .map((item) => String(item?.hash || item?.infoHash || '').trim().toLowerCase())
            .filter((hash) => /^[a-f0-9]{40}$/.test(hash)))];

        if (hashes.length === 0) return list;

        if (isSeriesMeta(meta)) {
            for (const item of list) EpisodePrecision.applyEpisodePrecisionToItem(item, meta);
        }

        try {
            const rows = await dbHelper.getRdCacheStatusByHashes(hashes);
            const byHash = new Map((Array.isArray(rows) ? rows : [])
                .filter((row) => row?.hash)
                .map((row) => [String(row.hash).trim().toLowerCase(), row]));

            let episodeHintsByHash = new Map();
            if (isSeriesMeta(meta) && typeof dbHelper.getEpisodePackFileHintsByHashes === 'function') {
                try {
                    const hints = await dbHelper.getEpisodePackFileHintsByHashes(hashes, meta);
                    episodeHintsByHash = new Map((Array.isArray(hints) ? hints : [])
                        .filter((hint) => hint?.hash)
                        .map((hint) => [String(hint.hash).trim().toLowerCase(), hint]));
                } catch (hintErr) {
                    logger.warn(`[DB READ] Pack episode hints falliti: ${hintErr.message}`);
                }
            }

            for (const item of list) {
                const hash = String(item?.hash || item?.infoHash || '').trim().toLowerCase();
                if (!hash) continue;
                const row = byHash.get(hash);
                const episodeHint = episodeHintsByHash.get(hash);
                if (episodeHint) {
                    const hintedIdx = Number(episodeHint.file_index);
                    if (Number.isInteger(hintedIdx) && hintedIdx >= 0) item.fileIdx = hintedIdx;
                    if (episodeHint.file_title || episodeHint.file_path) {
                        item._episodeFileHint = {
                            fileIndex: Number.isInteger(hintedIdx) && hintedIdx >= 0 ? hintedIdx : undefined,
                            fileName: episodeHint.file_title || String(episodeHint.file_path || '').split('/').pop(),
                            filePath: episodeHint.file_path || episodeHint.file_title || null,
                            fileSize: Number(episodeHint.file_size || 0) || undefined
                        };
                        item.episodeFileHint = item._episodeFileHint;
                    }
                    if (Number(episodeHint.file_size) > 0) {
                        item._size = Math.max(Number(item._size || item.sizeBytes || 0) || 0, Number(episodeHint.file_size));
                        item.sizeBytes = Math.max(Number(item.sizeBytes || item._size || 0) || 0, Number(episodeHint.file_size));
                    }
                    item._packValidated = true;
                    item._isPack = true;
                    item.potentialPack = true;
                    item._dbEpisodeMapping = true;
                    item._episodeExact = true;
                    item._rdEpisodeExact = true;
                    item._episodeProofSource = episodeHint.source || 'pack_files_episode_mapping';
                    item._rdEpisodeProof = {
                        exact: true,
                        source: episodeHint.source || 'pack_files_episode_mapping',
                        fileIdx: Number.isInteger(hintedIdx) && hintedIdx >= 0 ? hintedIdx : undefined,
                        fileName: episodeHint.file_title || String(episodeHint.file_path || '').split('/').pop() || null,
                        filePath: episodeHint.file_path || episodeHint.file_title || null,
                        confidence: Number(episodeHint.confidence || 1),
                        reason: episodeHint.reason || 'db_pack_file_episode_mapping'
                    };
                    item.rdEpisodeProof = item._rdEpisodeProof;
                    EpisodePrecision.applyEpisodePrecisionToItem(item, meta);
                }
                if (!row && !episodeHint) continue;

                const rdDb = deriveDbRdAvailability(row || { cached_rd: episodeHint ? true : null, rd_cache_state: episodeHint ? 'cached' : null });
                const rowState = rdDb.state;
                if (rdDb.cached === true || rdDb.cached === false || rowState) {
                    item._dbCachedRd = rdDb.cached;
                    item.cached_rd = rdDb.cached === true || rdDb.cached === false ? rdDb.cached : item.cached_rd;
                    item._rdStalePositive = rdDb.stale === true || item._rdStalePositive === true;
                    item._dbLastCachedCheck = row?.last_cached_check || item._dbLastCachedCheck || null;
                    item._dbNextCachedCheck = row?.next_cached_check || item._dbNextCachedCheck || null;
                    item._dbFailures = Number(row?.cache_check_failures || item._dbFailures || 0);

                    const currentState = getRdAvailabilityState('rd', item, meta);
                    const incomingState = RdOracle.getHashPositiveStateForSibling(rowState, item, meta);
                    if ((rdDb.stale === true && incomingState) || RdOracle.shouldUpgradeState(currentState, incomingState)) {
                        RdOracle.applyRdStateToItem(item, incomingState, {
                            cached: rdDb.cached === true && incomingState === 'cached' ? true : (incomingState === 'uncached_terminal' && rdDb.cached === false ? false : null),
                            clearNegative: incomingState === 'cached' || incomingState === 'likely_cached'
                        });
                    }
                }

                if (!(Number(item?._size || item?.sizeBytes || 0) > 0)) {
                    const knownSize = Number(row?.rd_file_size || row?.size || 0);
                    if (knownSize > 0) {
                        item._size = knownSize;
                        item.sizeBytes = knownSize;
                    }
                }

                if ((item?.fileIdx === undefined || item?.fileIdx === null) && Number.isInteger(row?.rd_file_index) && row.rd_file_index >= 0) {
                    item.fileIdx = row.rd_file_index;
                }
                if (isSeriesMeta(meta)) EpisodePrecision.applyEpisodePrecisionToItem(item, meta);
            }
        } catch (err) {
            logger.warn(`[DB READ] Overlay stato RD per hash fallito: ${err.message}`);
        }

        return propagateRdKnownStatesByHash(list, meta);
    }

    function isSeriesMeta(meta = {}) {
        return Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    }

    function isTorrentioSeriesPreferredItem(item, meta = {}) {
        if (!isSeriesMeta(meta)) return false;
        const addon = String(item?.externalAddon || item?._externalAddon || '').toLowerCase();
        const group = String(item?.externalGroup || item?._externalGroup || '').toLowerCase();
        const source = String(item?.source || item?.provider || '').toLowerCase();
        return Boolean(
            item?._preferTorrentioSeries === true ||
            group === 'torrentio' ||
            addon.startsWith('torrentio') ||
            source.includes('torrentio')
        );
    }

    function preferTorrentioSeriesItems(bucket, meta = {}) {
        const list = Array.isArray(bucket) ? bucket : [];
        if (!isSeriesMeta(meta) || list.length < 2) return list;
        return list
            .map((item, index) => ({ item, index, torrentio: isTorrentioSeriesPreferredItem(item, meta) }))
            .sort((a, b) => Number(b.torrentio) - Number(a.torrentio) || a.index - b.index)
            .map((entry) => entry.item);
    }

    function isMovieDbPrimaryCandidate(item = {}, meta = {}) {
        if (isSeriesMeta(meta)) return false;
        const group = String(item?._sourceGroup || item?.sourceGroup || '').toLowerCase();
        if (item?._externalSnapshot === true || item?._fromExternalSnapshot === true || group === 'external_snapshot') return false;
        return Boolean(
            item?._dbPrimary === true ||
            item?._myDb === true ||
            item?._remoteDb === true ||
            item?._localDb === true ||
            group === 'db' ||
            group === 'remote_db' ||
            group === 'local_db'
        );
    }

    function applyRdDbAvailabilityPriority(items, config, meta = {}) {
        const list = Array.isArray(items) ? items : [];
        const cachedOnly = config?.filters?.rdCachedOnly === true;
        const definitiveCached = [];
        const softCached = [];
        const probing = [];
        const unknown = [];
        const softNegative = [];
        const hardNegative = [];

        for (const item of list) {
            const state = getRdAvailabilityState('rd', item, meta);
            if (state === 'cached') definitiveCached.push(item);
            else if (state === 'likely_cached') softCached.push(item);
            else if (state === 'probing') probing.push(item);
            else if (state === 'likely_uncached') softNegative.push(item);
            else if (state === 'uncached_terminal') hardNegative.push(item);
            else unknown.push(item);
        }

        const cachedBucket = preferTorrentioSeriesItems(definitiveCached, meta);
        const minExactSafe = Math.max(1, Number(config?.filters?.rdMinExactSafeResults || RD_MIN_EXACT_SAFE_RESULTS) || RD_MIN_EXACT_SAFE_RESULTS);
        const hideDubiousWhenSafe = config?.filters?.rdHideDubiousWhenSafe === undefined
            ? RD_HIDE_DUBIOUS_WHEN_ENOUGH_SAFE
            : config?.filters?.rdHideDubiousWhenSafe !== false;

        if (cachedOnly) return [...cachedBucket];

        if (hideDubiousWhenSafe && cachedBucket.length >= minExactSafe) {
            const ambiguousBucket = [
                ...preferTorrentioSeriesItems(softCached, meta),
                ...preferTorrentioSeriesItems(probing, meta),
                ...preferTorrentioSeriesItems(unknown, meta)
            ];
            const preserveMovieDbPrimaryWhenSafe = config?.filters?.rdPreserveDbPrimaryWhenSafe === true
                || String(process.env.RD_PRESERVE_DB_PRIMARY_WHEN_SAFE || '').trim() === '1';
            const protectedDbPrimary = preserveMovieDbPrimaryWhenSafe
                ? ambiguousBucket.filter((item) => isMovieDbPrimaryCandidate(item, meta))
                : [];
            const hiddenCount = softCached.length + probing.length + unknown.length - protectedDbPrimary.length;
            logger.info(`[RD SORT] exact=${cachedBucket.length} >= ${minExactSafe} -> hiding dubious RD hits likely/probing/unknown=${Math.max(0, hiddenCount)} preservingDbPrimary=${protectedDbPrimary.length}${preserveMovieDbPrimaryWhenSafe ? '' : ' exactOnly=true'}`);
            return [...cachedBucket, ...protectedDbPrimary];
        }

        return [
            ...cachedBucket,
            ...preferTorrentioSeriesItems(softCached, meta),
            ...preferTorrentioSeriesItems(probing, meta),
            ...preferTorrentioSeriesItems(unknown, meta),
            ...preferTorrentioSeriesItems(softNegative, meta),
            ...preferTorrentioSeriesItems(hardNegative, meta)
        ];
    }

    function isGuaranteedCachedExternal(item, meta = {}) {
        return Boolean(
            (item?._mediafusionRdChecked === true || item?._nexusBridgeRdChecked === true || item?._externalRdChecked === true) &&
            getRdAvailabilityState('rd', item, meta) === 'cached'
        );
    }

    async function hydrateRdForegroundAvailability(items, apiKey, meta = {}, options = {}) {
        const list = Array.isArray(items) ? items : [];
        if (!apiKey || list.length === 0) return list;

        const visibleWindow = Math.max(
            1,
            Math.min(
                CONFIG.MAX_RESULTS || 70,
                parseInt(options.visibleWindow ?? RD_FOREGROUND_VISIBLE_WINDOW, 10) || RD_FOREGROUND_VISIBLE_WINDOW
            )
        );
        const probeLimit = Math.max(
            1,
            Math.min(
                visibleWindow,
                parseInt(options.probeLimit ?? RD_FOREGROUND_CACHE_LIMIT, 10) || RD_FOREGROUND_CACHE_LIMIT
            )
        );
        const minKnownStates = Math.max(
            1,
            Math.min(
                visibleWindow,
                parseInt(options.minKnownStates ?? RD_FOREGROUND_MIN_KNOWN, 10) || RD_FOREGROUND_MIN_KNOWN
            )
        );
        const fallbackProbeLimit = Math.max(
            0,
            Math.min(
                probeLimit,
                parseInt(options.fallbackProbeLimit ?? RD_FOREGROUND_FALLBACK_PROBE_LIMIT, 10) || RD_FOREGROUND_FALLBACK_PROBE_LIMIT
            )
        );

        const visibleSlice = list.slice(0, visibleWindow);
        const knownStates = visibleSlice.filter((item) => {
            const state = getRdAvailabilityState('rd', item, meta);
            return state === 'cached' || state === 'likely_cached' || state === 'likely_uncached' || state === 'uncached_terminal' || state === 'probing';
        }).length;

        const allUnknownCandidates = visibleSlice
            .filter((item) => !isGuaranteedCachedExternal(item, meta) && getRdAvailabilityState('rd', item, meta) === 'unknown' && item?.hash && item?.magnet);

        if (allUnknownCandidates.length === 0) return list;

        const cachedUnknownCandidates = [];
        let availabilityCacheHits = 0;
        for (const item of allUnknownCandidates) {
                const { primary: cacheKey, fallbacks } = getAvailabilityCacheKeys('rd', item?.hash, item?.fileIdx, meta);
            if (!cacheKey || typeof Cache.getAvailability !== 'function') {
                cachedUnknownCandidates.push(item);
                continue;
            }
            try {
                    let cachedPayload = getLocalAvailabilityPayload(cacheKey, fallbacks[0] || null);
                if (!cachedPayload) {
                    cachedPayload = await Cache.getAvailability(cacheKey);
                        for (const fallbackKey of fallbacks) {
                            if (cachedPayload) break;
                            cachedPayload = await Cache.getAvailability(fallbackKey);
                        }
                    if (cachedPayload) {
                        rememberLocalAvailabilityPayload(cacheKey, cachedPayload, Math.min(AVAILABILITY_CACHE_HIT_TTL, 3600));
                    }
                }
                if (!cachedPayload && typeof dbHelper?.getDebridAvailabilityCache === 'function') {
                        const lookupKeys = [cacheKey, ...fallbacks].filter(Boolean);
                        const persisted = await dbHelper.getDebridAvailabilityCache(lookupKeys);
                        cachedPayload = persisted?.[cacheKey] || fallbacks.map((key) => persisted?.[key]).find(Boolean) || null;
                    if (cachedPayload) {
                        rememberLocalAvailabilityPayload(cacheKey, cachedPayload, Math.min(AVAILABILITY_CACHE_HIT_TTL, 3600));
                    }
                    if (cachedPayload && typeof Cache.cacheAvailability === 'function') {
                        await Cache.cacheAvailability(cacheKey, cachedPayload, Math.min(AVAILABILITY_CACHE_HIT_TTL, 3600));
                    }
                }
                if (applyAvailabilityCachePayload(item, cachedPayload, meta)) availabilityCacheHits += 1;
                else cachedUnknownCandidates.push(item);
            } catch (_) {
                cachedUnknownCandidates.push(item);
            }
        }

        if (availabilityCacheHits > 0) logger.info(`[AVAILABILITY CACHE] hit=${availabilityCacheHits}/${allUnknownCandidates.length} key=infoHash:fileIdx service=rd`);

        const recentMediaCheck = await isRecentDebridMediaCheck('rd', apiKey, meta, logger);
        if (recentMediaCheck && (availabilityCacheHits > 0 || knownStates >= minKnownStates)) {
            logger.info(`[DEBRID CHECK MARKER] skip repeated live probe | service=rd media=${buildDebridMediaId(meta) || 'n/a'} known=${knownStates}/${visibleSlice.length} cacheHits=${availabilityCacheHits}/${allUnknownCandidates.length}`);
            return list;
        }

        if (cachedUnknownCandidates.length === 0) return list;

        const shouldReduceProbe = knownStates >= minKnownStates;
        const unknownCandidates = cachedUnknownCandidates
            .slice(0, shouldReduceProbe ? fallbackProbeLimit : probeLimit);

        if (unknownCandidates.length === 0) return list;

        if (shouldReduceProbe) {
            logger.info(`[RD PROBE] Live check ridotto | known=${knownStates}/${visibleSlice.length} | probing=${unknownCandidates.length}/${allUnknownCandidates.length}`);
        } else {
            logger.info(`[RD PROBE] Verifico disponibilita live per ${unknownCandidates.length} risultati unknown...`);
        }

        try {
            if (isSeriesMeta(meta)) {
                for (const item of unknownCandidates) {
                    item._probeSeason = Number(meta?.season || 0) || item._probeSeason;
                    item._probeEpisode = Number(meta?.episode || 0) || item._probeEpisode;
                    item.season = item.season || item._probeSeason;
                    item.episode = item.episode || item._probeEpisode;
                    item.seriesTitle = item.seriesTitle || meta?.title || meta?.name || '';
                    item.metaTitle = item.metaTitle || meta?.title || meta?.name || '';
                    item.imdb_id = item.imdb_id || meta?.imdb_id || null;
                    item.kitsu_id = item.kitsu_id || meta?.kitsu_id || null;
                    item.isAnime = item.isAnime || Boolean(meta?.isAnime || meta?.kitsu_id);
                }
            }

            const { results = {}, deferred = [] } = await LIMITERS.rdResolve.schedule(() =>
                RealDebridProbe.probeAvailabilityFast(unknownCandidates, apiKey, unknownCandidates.length, {
                    exactForeground: true,
                    exactLimit: RD_FOREGROUND_EXACT_LIMIT
                })
            );

            const dbUpdates = [];
            const packFileInserts = [];

            for (const item of unknownCandidates) {
                const hash = String(item?.hash || '').trim().toLowerCase();
                const result = results[hash];
                if (!result) continue;

                let statePayload;
                if (result.cached === true) {
                    statePayload = { state: 'cached', cached: true, failures: 0, next_hours: 24 * 30 };
                } else if (result.state === 'likely_cached' || result.pack_without_episode_hint === true) {
                                        
                    statePayload = { state: 'likely_cached', cached: null, failures: 0, next_hours: 6 };
                } else {
                    statePayload = resolveRdNegativeDecision(item, result);
                }

                RdOracle.applyRdStateToItem(item, statePayload.state, {
                    cached: statePayload.cached === true ? true : (statePayload.state === 'uncached_terminal' && statePayload.cached === false ? false : null),
                    clearNegative: statePayload.state === 'cached' || statePayload.state === 'likely_cached'
                });
                item._dbFailures = Number(statePayload.failures || 0);

                if (Number.isInteger(Number(result.file_index)) && Number(result.file_index) >= 0) {
                    item.fileIdx = Number(result.file_index);
                }
                if (result.single_video_exact === true) {
                    item._singleVideoProbe = true;
                    item._episodeExact = true;
                    item._rdEpisodeExact = true;
                    item._episodeProofSource = 'rd_probe_single_video';
                    EpisodePrecision.applyEpisodePrecisionToItem(item, meta);
                }

                if (result.episodeFileHint && typeof result.episodeFileHint === 'object') {
                    item.episodeFileHint = result.episodeFileHint;
                    item._episodeFileHint = result.episodeFileHint;
                    item._packValidated = result.cached === true;
                    item._isPack = result.is_pack === true || item._isPack === true;
                    item.potentialPack = result.is_pack === true || item.potentialPack === true;
                    item.packTitle = item.packTitle || result.pack_name || result.torrent_title || item.title;
                    item._episodeExact = true;
                    item._rdEpisodeExact = true;
                    item._rdEpisodeProof = {
                        exact: true,
                        source: result.episodeFileHint.source || 'rd_probe_episode_file_hint',
                        fileIdx: Number(result.episodeFileHint.fileIndex ?? result.file_index),
                        fileName: result.episodeFileHint.fileName || result.file_title || null,
                        filePath: result.episodeFileHint.filePath || result.file_title || null,
                        confidence: Number(result.episodeFileHint.confidence || 1),
                        reason: result.episodeFileHint.reason || 'rd_probe_exact_episode'
                    };
                    item.rdEpisodeProof = item._rdEpisodeProof;
                    EpisodePrecision.applyEpisodePrecisionToItem(item, meta);
                }

                if (result.pack_without_episode_hint === true) {
                    item._packMissingEpisodeHint = true;
                    item._packValidated = false;
                }

                if (Number.isFinite(result.file_size) && result.file_size > 0) {
                    item._size = Math.max(Number(item._size || item.sizeBytes || 0), Number(result.file_size));
                    item.sizeBytes = Math.max(Number(item.sizeBytes || item._size || 0), Number(result.file_size));
                }

                const totalPackSize = Number(result.size || result.folderSize || result.totalPackSize || 0);
                if (Number.isFinite(totalPackSize) && totalPackSize > 0 && (result.is_pack === true || totalPackSize > Number(result.file_size || 0) * 2)) {
                    item.folderSize = totalPackSize;
                    item.totalPackSize = totalPackSize;
                }

                const hintedFileSize = Number(result.episodeFileHint?.fileSize || result.file_size || 0);
                const hintedFileIndex = Number(result.episodeFileHint?.fileIndex ?? result.file_index);
                if (result.cached === true && result.episodeFileHint && meta?.imdb_id && Number(meta?.season) > 0 && Number(meta?.episode) > 0) {
                    packFileInserts.push({
                        pack_hash: item.hash,
                        imdb_id: meta.imdb_id,
                        imdb_season: Number(meta.season),
                        imdb_episode: Number(meta.episode),
                        file_index: Number.isInteger(hintedFileIndex) && hintedFileIndex >= 0 ? hintedFileIndex : null,
                        file_path: result.episodeFileHint.filePath || result.file_title || null,
                        file_title: result.episodeFileHint.fileName || result.file_title || null,
                        file_size: Number.isFinite(hintedFileSize) && hintedFileSize > 0 ? hintedFileSize : null
                    });
                }

                dbUpdates.push({
                    hash: item.hash,
                    state: statePayload.state,
                    cached: statePayload.cached,
                    rd_file_index: Number.isInteger(Number(item?.fileIdx)) && Number(item.fileIdx) >= 0 ? Number(item.fileIdx) : null,
                    rd_file_size: Number.isFinite(result.file_size) && result.file_size > 0 ? Number(result.file_size) : null,
                    torrent_title: result.torrent_title || item.title || null,
                    size: Number(result.size || item._size || item.sizeBytes || 0) || 0,
                    imdb_id: meta?.imdb_id || null,
                    imdb_season: Number(meta?.season) > 0 ? Number(meta.season) : null,
                    imdb_episode: Number(meta?.episode) > 0 ? Number(meta.episode) : null,
                    failures: statePayload.failures,
                    next_hours: statePayload.next_hours
                });

                if (typeof Cache.cacheAvailability === 'function') {
                    const availabilityCacheKey = getAvailabilityCacheKey('rd', item.hash, item?.fileIdx, meta);
                    if (availabilityCacheKey) {
                        const availabilityTtl = statePayload.state === 'cached' ? AVAILABILITY_CACHE_HIT_TTL : (statePayload.state === 'uncached_terminal' ? AVAILABILITY_CACHE_NEGATIVE_TTL : AVAILABILITY_CACHE_PROBING_TTL);
                        const availabilityPayload = buildAvailabilityCachePayload(statePayload, item, result, meta);
                        await Cache.cacheAvailability(availabilityCacheKey, availabilityPayload, availabilityTtl);
                        rememberLocalAvailabilityPayload(availabilityCacheKey, availabilityPayload, availabilityTtl);
                        if (typeof dbHelper?.setDebridAvailabilityCache === 'function') {
                            await dbHelper.setDebridAvailabilityCache({ cache_key: availabilityCacheKey, payload: availabilityPayload, ttlSeconds: availabilityTtl });
                        }
                    }
                }
            }

            if (dbUpdates.length > 0 && typeof dbHelper.updateRdCacheStatus === 'function') {
                try {
                    await dbHelper.updateRdCacheStatus(dbUpdates);
                    if (packFileInserts.length > 0 && typeof dbHelper.insertPackFiles === 'function') {
                        const inserted = await dbHelper.insertPackFiles(packFileInserts);
                        logger.info(`[PACK HINT] saved=${Number(inserted?.inserted || 0)}/${packFileInserts.length} episodeFileHint mappings`);
                    }
                    await Cache.invalidateStreamsByHashes(dbUpdates.map((row) => row.hash), 'rd_foreground_live_check');
                } catch (err) {
                    logger.warn(`[RD PROBE] Persistenza stato disponibilita fallita: ${err.message}`);
                }
            }

            if (Array.isArray(deferred) && deferred.length > 0) {
                for (const item of deferred) {
                    const currentState = getRdAvailabilityState('rd', item, meta);
                    if (!['cached', 'likely_cached'].includes(currentState)) {
                        RdOracle.applyRdStateToItem(item, 'probing', { cached: null });
                    }
                    if (typeof Cache.cacheAvailability === 'function') {
                        const availabilityCacheKey = getAvailabilityCacheKey('rd', item?.hash, item?.fileIdx, meta);
                        if (availabilityCacheKey) {
                            const probingPayload = buildAvailabilityCachePayload({ state: 'probing', cached: null, failures: item?._dbFailures || 0 }, item, null, meta);
                            await Cache.cacheAvailability(availabilityCacheKey, probingPayload, AVAILABILITY_CACHE_PROBING_TTL);
                            rememberLocalAvailabilityPayload(availabilityCacheKey, probingPayload, AVAILABILITY_CACHE_PROBING_TTL);
                            if (typeof dbHelper?.setDebridAvailabilityCache === 'function') {
                                await dbHelper.setDebridAvailabilityCache({ cache_key: availabilityCacheKey, payload: probingPayload, ttlSeconds: AVAILABILITY_CACHE_PROBING_TTL });
                            }
                        }
                    }
                }
                RealDebridProbe.backfillAvailabilityInBackground(deferred, apiKey, dbHelper, async (updates) => {
                    await Cache.invalidateStreamsByHashes((updates || []).map((entry) => entry.hash), 'rd_background_backfill');
                });
            }

            await markDebridMediaCheckDone('rd', apiKey, meta, logger);
            logger.info(`[RD PROBE] Live check completato | cached=${dbUpdates.filter((row) => row.state === 'cached').length} | likely_uncached=${dbUpdates.filter((row) => row.state === 'likely_uncached').length} | uncached_terminal=${dbUpdates.filter((row) => row.state === 'uncached_terminal').length} | deferred=${Array.isArray(deferred) ? deferred.length : 0}`);
        } catch (err) {
            logger.warn(`[RD PROBE] Verifica disponibilita live fallita: ${err.message}`);
        }

        return list;
    }

    function queueRdPriorityAudit(meta, results, config, reason = 'visible_results') {
        if (String(config?.service || 'rd').toLowerCase() !== 'rd') return;
        if (!dbHelper || typeof dbHelper.prioritizeRdHashes !== 'function') return;

        const maxPriority = RD_PRIORITY_TOP;
        const priorityMinutes = RD_PRIORITY_WINDOW_MIN;
        const candidateHashes = [...new Set((Array.isArray(results) ? results : [])
            .filter((item) => !isGuaranteedCachedExternal(item, meta) && getRdAvailabilityState('rd', item, meta) === 'unknown' && item?.hash)
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

        let prioritized = applyRdDbAvailabilityPriority(rankedList, config, meta);
        const apiKey = config.key || config.rd;
        await hydrateRdForegroundAvailability(prioritized, apiKey, meta);
        prioritized = applyRdDbAvailabilityPriority(prioritized, config, meta);
        queueRdPriorityAudit(meta, prioritized, config, 'stream_open');
        return prioritized;
    }

    async function persistResolvedDebridAvailability(meta, item, streamData, service, reason = 'direct_resolve') {
        const normalizedService = String(service || '').toLowerCase();
        if (!item?.hash) return false;
        if (!['rd', 'tb'].includes(normalizedService)) return false;
        if (!dbHelper) return false;

        const isTb = normalizedService === 'tb';
        const updateFn = isTb ? dbHelper.updateTbCacheStatus : dbHelper.updateRdCacheStatus;
        if (typeof updateFn !== 'function') return false;

        const rawFileIndex = streamData?.rd_file_index ?? streamData?.tb_file_id ?? streamData?.file_id ?? streamData?.file_index ?? streamData?.fileIdx ?? item?.fileIdx;
        const rawFileSize = streamData?.rd_file_size ?? streamData?.tb_file_size ?? streamData?.file_size ?? streamData?.filesize ?? streamData?.size ?? item?._size ?? item?.sizeBytes ?? null;
        const parsedFileIndex = rawFileIndex === null || rawFileIndex === undefined || rawFileIndex === ''
            ? NaN
            : Number(rawFileIndex);
        const parsedFileSize = Number(rawFileSize);
        const resolvedTitle = streamData?.filename || item?.title || String(item.hash);
        const scopedIdentity = meta?.imdb_id ? {
            imdb_id: meta.imdb_id,
            imdb_season: Number(meta?.season) > 0 ? Number(meta.season) : null,
            imdb_episode: Number(meta?.episode) > 0 ? Number(meta.episode) : null
        } : {};

        try {
            if ((!meta?.imdb_id) && typeof dbHelper.ensureTorrentRecord === 'function') {
                await dbHelper.ensureTorrentRecord({
                    info_hash: item.hash,
                    title: resolvedTitle,
                    size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : Number(item?._size || item?.sizeBytes || 0),
                    seeders: Number(item?.seeders || 0) || 0,
                    provider: item?.source || normalizedService.toUpperCase(),
                    type: meta?.isAnime ? 'anime' : (meta?.isSeries || Number(meta?.season) > 0 ? 'series' : 'movie'),
                    trackers: item?.trackers || item?.sources || undefined,
                    languages: item?.languages || item?.language || item?._languages || undefined,
                    resolution: item?.resolution || item?.quality || undefined,
                    quality: item?.quality || undefined,
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
                    type: meta?.isAnime ? 'anime' : (meta?.isSeries || Number(meta?.season) > 0 ? 'series' : 'movie'),
                    trackers: item?.trackers || item?.sources || undefined,
                    languages: item?.languages || item?.language || item?._languages || undefined,
                    resolution: item?.resolution || item?.quality || undefined,
                    quality: item?.quality || undefined,
                    file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : (item?.fileIdx !== undefined ? item.fileIdx : undefined),
                    is_pack: shouldPersistResolvedAsPack(item, resolvedTitle, meta)
                });
            }

            const updatePayload = isTb
                ? {
                    hash: item.hash,
                    cached: true,
                    tb_file_id: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : null,
                    tb_file_size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : null,
                    failures: 0,
                    permanent: true,
                    ...scopedIdentity
                }
                : {
                    hash: item.hash,
                    state: 'cached',
                    cached: true,
                    rd_file_index: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : null,
                    rd_file_size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : null,
                    failures: 0,
                    permanent: true,
                    ...scopedIdentity
                };

            const updated = await updateFn([updatePayload]);

            if (updated > 0) {
                await Cache.invalidateStreamsByHashes([item.hash], `${reason}_cached`);
                if (meta?.imdb_id && Number.isInteger(meta?.season) && meta.season > 0 && Number.isInteger(meta?.episode) && meta.episode > 0 && typeof Cache.invalidateStreamsByEpisode === 'function') await Cache.invalidateStreamsByEpisode({ imdbId: meta.imdb_id, season: meta.season, episode: meta.episode }, `${reason}_cached`);
                else if (meta?.imdb_id) await Cache.invalidateStreamsByImdb(meta.imdb_id, `${reason}_cached`);
                const dbLookupKey = getMetaDbLookupKey(meta);
                if (dbLookupKey) await Cache.invalidateDbTorrents(dbLookupKey, `${reason}_cached`);
                if (typeof Cache.cacheAvailability === 'function') {
                    const availabilityKey = getAvailabilityCacheKey(normalizedService, item.hash, Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : item?.fileIdx, meta);
                    if (availabilityKey) {
                        const directPayload = buildAvailabilityCachePayload({ state: 'cached', cached: true, failures: 0 }, { ...item, fileIdx: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : item?.fileIdx }, { file_size: Number.isFinite(parsedFileSize) && parsedFileSize > 0 ? parsedFileSize : null }, meta);
                        await Cache.cacheAvailability(availabilityKey, directPayload, AVAILABILITY_CACHE_HIT_TTL);
                        rememberLocalAvailabilityPayload(availabilityKey, directPayload, AVAILABILITY_CACHE_HIT_TTL);
                        if (typeof dbHelper?.setDebridAvailabilityCache === 'function') {
                            await dbHelper.setDebridAvailabilityCache({ cache_key: availabilityKey, payload: directPayload, ttlSeconds: AVAILABILITY_CACHE_HIT_TTL });
                        }
                        logger.info(`[AVAILABILITY CACHE] saved key=infoHash:fileIdx service=${normalizedService} state=cached`);
                    }
                }
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
        applyRdDisplayPriority: applyRdDbAvailabilityPriority,
        persistResolvedDebridAvailability
    };
}

module.exports = {
    createDebridAvailabilityTools,
    __private: {
        buildDebridMediaId,
        getAvailabilityMediaId,
        getAvailabilityCacheKey,
        getAvailabilityCacheKeys,
        buildAvailabilityCachePayload
    }
};
