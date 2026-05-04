'use strict';

const RD_BASE_URL = 'https://api.real-debrid.com/rest/1.0';
const RD_TIMEOUT = 30000;
const RD_FAST_TIMEOUT = 5000;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i;
const PACK_TITLE_PATTERN = /\b(trilog(?:y)?|saga|collection|collezione|pack|complete|completa|integrale|filmografia)\b/i;
const RD_CACHED_STATUSES = new Set(['downloaded']);
const RD_TERMINAL_UNCACHED_STATUSES = new Set(['error', 'magnet_error', 'virus', 'dead']);
// Default fissati nel codice: probe severo sui pack, nessun env necessario.
const RD_SLOW_RECHECK_ATTEMPTS = 2;
const RD_SLOW_RECHECK_DELAY_MS = 1200;
const REQUIRE_EPISODE_HINT_FOR_PACKS = true;
const RD_CACHED_RECHECK_HOURS = 168;
const { findEpisodeFileHint } = require('../core/matching/season_pack_inspector');
const { scheduleRealDebridRequest } = require('../core/utils/rd_rate_limiter');
const { withRealDebridMagnetLock } = require('../core/utils/rd_magnet_lock');

function isVideoFile(path) {
    return VIDEO_EXTENSIONS.test(path || '');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHash(hash) {
    return String(hash || '').trim().toLowerCase();
}

function normalizeStatus(status) {
    return String(status || '').trim().toLowerCase();
}

function isCachedStatus(status) {
    return RD_CACHED_STATUSES.has(normalizeStatus(status));
}

function isTerminalUncachedStatus(status) {
    return RD_TERMINAL_UNCACHED_STATUSES.has(normalizeStatus(status));
}

function buildDeferredProbeResult(hash, status, reason = null) {
    return {
        hash: normalizeHash(hash),
        cached: false,
        deferred: true,
        state: 'probing',
        rd_status: normalizeStatus(status) || 'unknown',
        ...(reason ? { error: reason } : {})
    };
}

function isValidPackName(name) {
    if (!name) return false;
    if (name.length < 10) return false;

    const invalidKeywords = ['magnet', 'invalid', 'torrent', 'download', 'error', '404', 'unavailable'];
    const lowerName = name.toLowerCase();

    if (invalidKeywords.some((keyword) => lowerName.includes(keyword))) {
        const hasReleaseContent = /(?:s\d{1,2}|season|stagion|\d{3,4}p|bluray|blu-ray|web-?dl|web-?rip|hdtv|dvdrip|bdrip|remux|x\.?26[45]|h\.?26[45]|hevc|avc|xvid|mkv|mp4|aac|ac3|dts|dd[p+]?|multi|dual|ita|eng|complete|completa)/i.test(name);
        if (!hasReleaseContent) return false;
    }

    if (/^[a-f0-9]{32,40}$/i.test(name)) return false;
    if (VIDEO_EXTENSIONS.test(name)) return false;
    if (/S\d{1,2}(?![Ee]\d)/i.test(name) && !/S\d{1,2}[Ee]\d{1,3}/i.test(name)) return true;

    const episodeRangePatterns = [
        /S\d{1,2}[Ee]\d{1,3}[-–]\d{1,3}/i,
        /S\d{1,2}[Ee]\d{1,3}[-–][Ee]\d{1,3}/i,
        /S\d{1,2}[-–][Ee][Pp]?\d{1,3}[-–]\d{1,3}/i,
        /S\d{1,2}[Ee][Pp]\d{1,3}[-–]\d{1,3}/i,
        /[Ee][Pp]?\d{1,3}[-–][Ee]?[Pp]?\d{1,3}/i,
        /\d{1,2}x\d{1,3}[-–]\d{1,3}/i
    ];

    if (episodeRangePatterns.some((pattern) => pattern.test(name))) return true;

    const hasSingleEpisode = /S\d{1,2}[Ee]\d{1,3}/i.test(name);
    const hasRange = /[-–]\d{1,3}|[-–][Ee]\d{1,3}/i.test(name);
    if (hasSingleEpisode && !hasRange) return false;

    return true;
}

function isPackTitle(title) {
    return PACK_TITLE_PATTERN.test(title || '');
}

function buildRequestConfig(method, token, data, signal) {
    const config = {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        signal
    };

    if (data) config.body = data;
    return config;
}

async function safeJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

async function rdRequestCore(method, url, token, data = null, options = {}) {
    const {
        timeoutMs = RD_TIMEOUT,
        maxAttempts = 3,
        retryDelayMs = 500,
        deferOnTransient = false
    } = options;

    let attempt = 0;

    while (attempt < maxAttempts) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await scheduleRealDebridRequest(token, () => fetch(url, buildRequestConfig(method, token, data, controller.signal)), `${method} ${url.replace(RD_BASE_URL, '')}`);

            if (response.status === 204 || response.status === 202) return { success: true, _status: response.status };
            if (response.status === 403) return null;

            if (!response.ok) {
                if (response.status === 429 || response.status >= 500) {
                    if (deferOnTransient) return { _deferred: true, _reason: String(response.status) };
                    attempt += 1;
                    if (attempt < maxAttempts) {
                        await sleep(1000 + Math.random() * 1000);
                        continue;
                    }
                    return null;
                }

                await safeJson(response);
                return null;
            }

            const payload = await safeJson(response);
            return payload === null ? { success: true, _status: response.status } : payload;
        } catch (error) {
            if (deferOnTransient) {
                if (error?.name === 'AbortError') return { _deferred: true, _reason: 'timeout' };
                return { _deferred: true, _reason: error?.message || 'request_failed' };
            }

            attempt += 1;
            if (attempt < maxAttempts) {
                await sleep(retryDelayMs);
                continue;
            }
            return null;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    return null;
}

function rdRequest(method, url, token, data = null) {
    return rdRequestCore(method, url, token, data, {
        timeoutMs: RD_TIMEOUT,
        maxAttempts: 3,
        retryDelayMs: 500,
        deferOnTransient: false
    });
}

function rdRequestFast(method, url, token, data = null) {
    return rdRequestCore(method, url, token, data, {
        timeoutMs: RD_FAST_TIMEOUT,
        maxAttempts: 1,
        retryDelayMs: 0,
        deferOnTransient: true
    });
}

async function deleteTorrent(token, torrentId) {
    if (!token || !torrentId) return;
    try {
        await rdRequest('DELETE', `${RD_BASE_URL}/torrents/delete/${torrentId}`, token);
    } catch {}
}

function queueDeleteTorrent(token, torrentId) {
    if (!token || !torrentId) return;
    deleteTorrent(token, torrentId).catch(() => {});
}

function buildMagnetBody(magnet) {
    const body = new URLSearchParams();
    body.append('magnet', magnet);
    return body;
}

function buildSelectAllBody() {
    const body = new URLSearchParams();
    body.append('files', 'all');
    return body;
}


function buildSelectFilesBody(files) {
    const body = new URLSearchParams();
    body.append('files', String(files || 'all'));
    return body;
}

function extractVideoFiles(files) {
    if (!Array.isArray(files) || files.length === 0) return [];
    return files
        .filter((file) => isVideoFile(file?.path) && Number(file?.bytes || 0) > 25 * 1024 * 1024)
        .map((file) => ({
            id: file.id,
            path: file.path,
            bytes: Number(file.bytes || 0)
        }));
}

function pickMainVideoFile(files) {
    if (!Array.isArray(files) || files.length === 0) return { file_title: null, file_size: null, file_index: null };

    const candidate = [...files].sort((a, b) => Number(b?.bytes || 0) - Number(a?.bytes || 0))[0];
    if (!candidate) return { file_title: null, file_size: null, file_index: null };

    const fullPath = candidate.path || '';
    return {
        file_title: fullPath.split('/').pop() || fullPath || null,
        file_size: Number(candidate.bytes || 0) || null,
        file_index: Number.isInteger(Number(candidate.id)) && Number(candidate.id) >= 0 ? Number(candidate.id) : null
    };
}


function getEpisodeProbeContext(context = {}, fallbackTitle = '') {
    if (!hasEpisodeProbeContext(context)) return null;
    return {
        ...context,
        title: context.title || context.seriesTitle || context.metaTitle || fallbackTitle,
        season: Number(context.season || context._probeSeason || 0),
        episode: Number(context.episode || context._probeEpisode || 0),
        fileIdx: context.fileIdx ?? context.file_index ?? context.rd_file_index
    };
}

function chooseProbeFileSelection(files, context = {}, fallbackTitle = '') {
    const videoFiles = extractVideoFiles(files);
    const episodeContext = getEpisodeProbeContext(context, fallbackTitle);

    // Prima rispetta sempre fileIdx/rd_file_index già imparato dal DB.
    // È fondamentale per i pack: se il DB conosce l'episodio, non blocchiamo il probe solo perché il parser titolo non ritrova l'hint.
    const forcedIndex = Number(context?.fileIdx ?? context?.file_index ?? context?.rd_file_index);
    if (Number.isInteger(forcedIndex) && forcedIndex >= 0 && videoFiles.some((file) => Number(file.id) === forcedIndex)) {
        return { files: String(forcedIndex), selectedFileIndex: forcedIndex, episodeFileHint: null, forcedIndex: true };
    }

    if (episodeContext && videoFiles.length > 1) {
        const episodeFileHint = findEpisodeFileHint(videoFiles, episodeContext);
        if (episodeFileHint && Number.isInteger(Number(episodeFileHint.fileIndex))) {
            return {
                files: String(Number(episodeFileHint.fileIndex)),
                selectedFileIndex: Number(episodeFileHint.fileIndex),
                episodeFileHint
            };
        }
        if (REQUIRE_EPISODE_HINT_FOR_PACKS) {
            return {
                files: null,
                missingEpisodeHint: true,
                episodeFileHint: null
            };
        }
    }

    if (videoFiles.length === 1 && Number.isInteger(Number(videoFiles[0].id))) {
        return { files: String(Number(videoFiles[0].id)), selectedFileIndex: Number(videoFiles[0].id), episodeFileHint: null };
    }

    const main = pickMainVideoFile(videoFiles);
    if (Number.isInteger(Number(main.file_index)) && Number(main.file_index) >= 0) {
        return { files: String(Number(main.file_index)), selectedFileIndex: Number(main.file_index), episodeFileHint: null };
    }

    return { files: 'all', selectedFileIndex: null, episodeFileHint: null };
}

async function selectFilesForProbe(request, token, torrentId, info, context = {}) {
    const selection = chooseProbeFileSelection(info?.files, context, info?.filename || info?.original_filename || '');
    if (selection.missingEpisodeHint) return { missingEpisodeHint: true, info, selection };

    const selectedFiles = selection.files || 'all';
    const selectRes = await request('POST', `${RD_BASE_URL}/torrents/selectFiles/${torrentId}`, token, buildSelectFilesBody(selectedFiles));
    if (!selectRes) return { info: null, reason: 'select_failed', selection };
    if (selectRes._deferred) return { deferred: true, reason: selectRes._reason || 'select_deferred', selection };

    const selectedInfo = await request('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
    if (!selectedInfo) return { info: null, reason: 'info_after_select_failed', selection };
    if (selectedInfo._deferred) return { deferred: true, reason: selectedInfo._reason || 'info_after_select_deferred', selection };

    return { info: selectedInfo, selection };
}

function hasEpisodeProbeContext(context = {}) {
    const season = Number(context.season || context._probeSeason || 0);
    const episode = Number(context.episode || context._probeEpisode || 0);
    return Number.isFinite(season) && season > 0 && Number.isFinite(episode) && episode > 0;
}

function buildProbeResult(infoHash, info, context = {}) {
    const hash = normalizeHash(infoHash);
    const files = extractVideoFiles(info?.files);
    const main = pickMainVideoFile(files);
    const torrentTitle = info?.filename || '';
    const originalFilename = info?.original_filename || '';
    const packSource = originalFilename || torrentTitle;
    const validPackName = isValidPackName(packSource) ? packSource : null;
    const isPack = files.length > 1;
    const episodeContext = hasEpisodeProbeContext(context) ? {
        ...context,
        title: context.title || context.seriesTitle || context.metaTitle || torrentTitle || originalFilename,
        season: Number(context.season || context._probeSeason || 0),
        episode: Number(context.episode || context._probeEpisode || 0),
        fileIdx: context.fileIdx ?? context.file_index ?? context.rd_file_index
    } : null;
    const episodeFileHint = episodeContext && isPack ? findEpisodeFileHint(files, episodeContext) : null;
    const selected = episodeFileHint ? {
        file_title: episodeFileHint.fileName || episodeFileHint.filePath || main.file_title,
        file_size: episodeFileHint.fileSize || main.file_size,
        file_index: Number.isInteger(Number(episodeFileHint.fileIndex)) ? Number(episodeFileHint.fileIndex) : main.file_index
    } : main;

    const hasDownloadLinks = Array.isArray(info?.links) && info.links.length > 0;
    const statusCached = isCachedStatus(info?.status) && hasDownloadLinks;
    const requiresEpisodeHint = Boolean(REQUIRE_EPISODE_HINT_FOR_PACKS && statusCached && isPack && episodeContext);
    const cachedForRequestedEpisode = statusCached && (!requiresEpisodeHint || Boolean(episodeFileHint));

    return {
        hash,
        cached: cachedForRequestedEpisode,
        state: cachedForRequestedEpisode ? 'cached' : (isTerminalUncachedStatus(info?.status) ? 'uncached_terminal' : (requiresEpisodeHint ? 'likely_uncached' : 'unknown')),
        rd_status: normalizeStatus(info?.status),
        torrent_title: torrentTitle,
        original_filename: originalFilename,
        pack_name: validPackName,
        is_pack: isPack,
        pack_without_episode_hint: Boolean(requiresEpisodeHint && !episodeFileHint),
        episodeFileHint: episodeFileHint || null,
        file_index: selected.file_index,
        file_title: selected.file_title,
        file_size: selected.file_size,
        size: Number(info?.bytes || 0),
        files: files.map((file) => ({
            id: file.id,
            path: cleanFilePath(file.path),
            bytes: Number(file.bytes || 0) || 0
        }))
    };
}

async function performAvailabilityProbe(infoHash, magnet, token, options = {}) {
    const {
        fast = false,
        backgroundDelete = fast,
        context = {}
    } = options;

    const request = fast ? rdRequestFast : rdRequest;
    const hash = normalizeHash(infoHash);
    let torrentId = null;

    const cleanup = async () => {
        if (!torrentId) return;
        if (backgroundDelete) {
            queueDeleteTorrent(token, torrentId);
            torrentId = null;
            return;
        }
        await deleteTorrent(token, torrentId);
        torrentId = null;
    };

    return withRealDebridMagnetLock(token, hash, async () => {
    try {
        const addRes = await request('POST', `${RD_BASE_URL}/torrents/addMagnet`, token, buildMagnetBody(magnet));
        if (!addRes) return fast ? buildDeferredProbeResult(hash, null, 'Failed to add magnet') : { hash, cached: false, error: 'Failed to add magnet' };
        if (addRes._deferred) return { hash, cached: false, deferred: true, error: addRes._reason };
        if (!addRes.id) return fast ? buildDeferredProbeResult(hash, null, 'No torrent ID') : { hash, cached: false, error: 'No torrent ID' };

        torrentId = addRes.id;

        let info = await request('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
        if (!info) {
            await cleanup();
            return fast ? buildDeferredProbeResult(hash, null, 'Failed to get torrent info') : { hash, cached: false, error: 'Failed to get torrent info' };
        }
        if (info._deferred) {
            await cleanup();
            return { hash, cached: false, deferred: true, error: info._reason };
        }

        let initialStatus = normalizeStatus(info?.status);

        if (initialStatus === 'waiting_files_selection') {
            const selectionResult = await selectFilesForProbe(request, token, torrentId, info, context);
            if (selectionResult?.missingEpisodeHint) {
                const result = {
                    ...buildProbeResult(hash, info, context),
                    cached: false,
                    state: 'likely_uncached',
                    pack_without_episode_hint: true
                };
                await cleanup();
                return result;
            }
            if (selectionResult?.deferred) {
                await cleanup();
                return buildDeferredProbeResult(hash, initialStatus, selectionResult.reason);
            }
            if (!selectionResult?.info) {
                await cleanup();
                return fast ? buildDeferredProbeResult(hash, initialStatus, selectionResult?.reason || 'select_failed') : { hash, cached: false, error: selectionResult?.reason || 'select_failed', rd_status: initialStatus };
            }
            info = selectionResult.info;
            initialStatus = normalizeStatus(info?.status);
        }

        if (isCachedStatus(initialStatus) || isTerminalUncachedStatus(initialStatus)) {
            const result = buildProbeResult(hash, info, context);
            await cleanup();
            return result;
        }

        if (fast) {
            await cleanup();
            return buildDeferredProbeResult(hash, initialStatus);
        }

        let latestInfo = info;
        for (let attempt = 0; attempt < RD_SLOW_RECHECK_ATTEMPTS; attempt += 1) {
            await sleep(RD_SLOW_RECHECK_DELAY_MS);
            latestInfo = await request('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
            if (!latestInfo) {
                await cleanup();
                return buildDeferredProbeResult(hash, initialStatus, 'Failed to re-fetch info');
            }
            if (latestInfo._deferred) {
                await cleanup();
                return buildDeferredProbeResult(hash, latestInfo._reason || initialStatus);
            }

            const polledStatus = normalizeStatus(latestInfo?.status);
            if (isCachedStatus(polledStatus) || isTerminalUncachedStatus(polledStatus)) {
                const result = buildProbeResult(hash, latestInfo, context);
                await cleanup();
                return result;
            }
        }

        await cleanup();
        return buildDeferredProbeResult(hash, latestInfo?.status || initialStatus);
    } catch (error) {
        await cleanup();
        return fast
            ? buildDeferredProbeResult(hash, null, error?.message || 'unknown_error')
            : {
                hash,
                cached: false,
                error: error?.message || 'unknown_error'
            };
    }
    });
}

function inspectSingleHash(infoHash, magnet, token, context = {}) {
    return performAvailabilityProbe(infoHash, magnet, token, { fast: false, backgroundDelete: false, context });
}

function inspectSingleHashFast(infoHash, magnet, token, context = {}) {
    return performAvailabilityProbe(infoHash, magnet, token, { fast: true, backgroundDelete: true, context });
}

async function probeAvailabilityFast(items, token, limit = 5, options = {}) {
    const results = {};
    const deferred = [];
    const toCheck = Array.isArray(items) ? items.slice(0, Math.max(0, limit | 0)) : [];
    const exactForeground = options?.exactForeground === true;
    const exactLimit = Math.max(0, Math.min(toCheck.length, Number.parseInt(options?.exactLimit ?? 0, 10) || 0));

    if (DEBUG_MODE) {
        console.log(`⚡ [RD Probe Fast] Checking ${toCheck.length} hashes... exact=${exactForeground ? exactLimit : 0}`);
    }

    for (let i = 0; i < toCheck.length; i += 1) {
        const item = toCheck[i];
        // I primi risultati visibili meritano una verifica completa, altrimenti RD spesso
        // risponde "magnet_conversion/downloading" per pochi istanti e in UI finisce ⏳
        // anche quando il file è già cached. Il resto resta fast+background.
        const result = exactForeground && i < exactLimit
            ? await inspectSingleHash(item?.hash, item?.magnet, token, item)
            : await inspectSingleHashFast(item?.hash, item?.magnet, token, item);

        if (result.deferred) {
            deferred.push(item);
        } else {
            results[normalizeHash(result.hash)] = {
                cached: result.cached,
                file_title: result.file_title,
                file_size: result.file_size,
                file_index: result.file_index,
                episodeFileHint: result.episodeFileHint || null,
                pack_without_episode_hint: result.pack_without_episode_hint === true,
                rd_status: result.rd_status || null,
                state: result.state || (result.cached === true ? 'cached' : 'unknown'),
                torrent_title: result.torrent_title,
                size: result.size,
                is_pack: result.is_pack,
                pack_name: result.pack_name,
                files: result.files,
                fromLiveCheck: true
            };
        }

        if (i < toCheck.length - 1) {
            await sleep(200);
        }
    }

    if (DEBUG_MODE) {
        console.log(`⚡ [RD Probe Fast] Done: ${Object.values(results).filter((entry) => entry.cached).length} cached, ${deferred.length} deferred`);
    }

    return { results, deferred };
}

function cleanFilePath(path) {
    if (!path) return 'unknown.mkv';
    const cleaned = String(path).replace(/^\/+/, '');
    return cleaned.includes('/') ? cleaned.split('/').pop() : cleaned;
}

async function backfillAvailabilityInBackground(items, token, dbHelper, onUpdated = null) {
    if (!Array.isArray(items) || items.length === 0) return null;

    const timer = setTimeout(() => {
        void (async () => {
            try {
                const normalizedItems = items
                    .filter((item) => item?.hash && item?.magnet)
                    .map((item) => ({ ...item, hash: normalizeHash(item.hash) }));

                if (normalizedItems.length === 0) return;

                let knownHashes = {};
                if (dbHelper && typeof dbHelper.getRdCachedAvailability === 'function') {
                    const dbKnown = await dbHelper.getRdCachedAvailability(normalizedItems.map((item) => item.hash));
                    knownHashes = Object.fromEntries(
                        Object.entries(dbKnown || {}).map(([key, value]) => [normalizeHash(key), value])
                    );
                }

                const results = [];

                for (const item of normalizedItems) {
                    if (knownHashes[item.hash] !== undefined) continue;
                    await sleep(1000);
                    const inspected = await inspectSingleHash(item.hash, item.magnet, token, item);
                    if (!inspected?.deferred) results.push({ ...inspected, _probeContext: item });
                }

                if (results.length === 0) return;

                if (dbHelper && typeof dbHelper.updateRdCacheStatus === 'function') {
                    const availabilityUpdates = results.map((result) => ({
                        hash: normalizeHash(result.hash),
                        state: result.cached ? 'cached' : (isTerminalUncachedStatus(result.rd_status) ? 'uncached_terminal' : 'likely_uncached'),
                        cached: result.cached ? true : (isTerminalUncachedStatus(result.rd_status) ? false : null),
                        torrent_title: result.torrent_title || null,
                        size: result.size || null,
                        file_title: result.file_title || null,
                        file_size: result.file_size || null,
                        rd_file_index: Number.isInteger(Number(result.file_index)) && Number(result.file_index) >= 0 ? Number(result.file_index) : null,
                        next_hours: result.cached ? RD_CACHED_RECHECK_HOURS : (isTerminalUncachedStatus(result.rd_status) ? (24 * 7) : 12),
                        failures: result.cached ? 0 : 1,
                        imdb_id: result._probeContext?.imdb_id || null,
                        imdb_season: Number(result._probeContext?.season || result._probeContext?._probeSeason || 0) > 0 ? Number(result._probeContext?.season || result._probeContext?._probeSeason) : null,
                        imdb_episode: Number(result._probeContext?.episode || result._probeContext?._probeEpisode || 0) > 0 ? Number(result._probeContext?.episode || result._probeContext?._probeEpisode) : null
                    }));

                    await dbHelper.updateRdCacheStatus(availabilityUpdates);

                    if (typeof onUpdated === 'function' && availabilityUpdates.length > 0) {
                        try {
                            await onUpdated(availabilityUpdates);
                        } catch {}
                    }
                }

                if (dbHelper && typeof dbHelper.insertPackFiles === 'function') {
                    for (const result of results) {
                        const shouldPersistPackFiles = result.cached && result.is_pack && (isPackTitle(result.torrent_title) || !!result.pack_name);
                        if (!shouldPersistPackFiles) continue;

                        const ctx = result._probeContext || {};
                        const episodeHint = result.episodeFileHint || null;
                        const hasEpisodeIdentity = ctx.imdb_id && Number(ctx.season || ctx._probeSeason || 0) > 0 && Number(ctx.episode || ctx._probeEpisode || 0) > 0;
                        const videoFiles = episodeHint && hasEpisodeIdentity
                            ? [{ id: episodeHint.fileIndex, path: episodeHint.filePath || episodeHint.fileName, bytes: episodeHint.fileSize, file_title: episodeHint.fileName }]
                            : (result.files || []).filter((file) => isVideoFile(file.path) && Number(file.bytes || 0) > 50 * 1024 * 1024);
                        if (videoFiles.length === 0) continue;

                        try {
                            await dbHelper.insertPackFiles(videoFiles.map((file) => ({
                                pack_hash: normalizeHash(result.hash),
                                imdb_id: hasEpisodeIdentity ? ctx.imdb_id : null,
                                imdb_season: hasEpisodeIdentity ? Number(ctx.season || ctx._probeSeason) : null,
                                imdb_episode: hasEpisodeIdentity ? Number(ctx.episode || ctx._probeEpisode) : null,
                                file_index: file.id,
                                file_path: cleanFilePath(file.path),
                                file_title: file.file_title || cleanFilePath(file.path).split('/').pop(),
                                file_size: Number(file.bytes || 0)
                            })));
                        } catch (error) {
                            console.warn(`⚠️ [RD Probe Backfill] Failed to save pack files: ${error.message}`);
                        }
                    }
                }
            } catch (error) {
                console.error('❌ [RD Probe Backfill] Error:', error?.message || error);
            }
        })();
    }, 5000);

    return timer;
}

module.exports = {
    inspectSingleHash,
    inspectSingleHashFast,
    probeAvailabilityFast,
    backfillAvailabilityInBackground,
    isValidPackName
};

