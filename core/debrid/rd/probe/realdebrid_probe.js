'use strict';

const crypto = require('crypto');

const RD_BASE_URL = 'https://api.real-debrid.com/rest/1.0';
const RD_TIMEOUT = 30000;
const RD_FAST_TIMEOUT = 5000;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i;
const PACK_TITLE_PATTERN = /\b(trilog(?:y)?|saga|collection|collezione|pack|complete|completa|integrale|filmografia)\b/i;
const RD_CACHED_STATUSES = new Set(['downloaded']);
const RD_TERMINAL_UNCACHED_STATUSES = new Set(['error', 'magnet_error', 'virus', 'dead']);
const RD_SLOW_RECHECK_ATTEMPTS = 2;
const RD_SLOW_RECHECK_DELAY_MS = 1200;
const REQUIRE_EPISODE_HINT_FOR_PACKS = true;
const RD_CACHED_RECHECK_HOURS = 168;
const RD_PROBE_CACHE_HIT_TTL_MS = Math.max(30_000, Number(process.env.RD_PROBE_CACHE_HIT_TTL_MS || 300_000) || 300_000);
const RD_PROBE_CACHE_MISS_TTL_MS = Math.max(10_000, Number(process.env.RD_PROBE_CACHE_MISS_TTL_MS || 90_000) || 90_000);
const RD_PROBE_CACHE_DEFERRED_TTL_MS = Math.max(5_000, Number(process.env.RD_PROBE_CACHE_DEFERRED_TTL_MS || 35_000) || 35_000);
const RD_PROBE_CACHE_MAX_ENTRIES = Math.max(100, Number(process.env.RD_PROBE_CACHE_MAX_ENTRIES || 2500) || 2500);
const probeResultCache = new Map();
const { findEpisodeFileHint } = require('../../../matching/season_pack_inspector');
const { hasWrongExplicitEpisodeMarker } = require('../../../matching/episode_matcher');
const { scheduleRealDebridRequest } = require('../utils/rd_rate_limiter');
const { withRealDebridMagnetLock } = require('../utils/rd_magnet_lock');
const { scheduleRdProbe } = require('./rd_probe_coordinator');
const { extractRdErrorCode, classifyRdErrorCode } = require('../utils/rd_error_codes');

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

function tokenCacheScope(token = '') {
    return crypto.createHash('sha1').update(String(token || 'no-token')).digest('hex').slice(0, 12);
}

function getProbeCacheKey(item = {}, token = '') {
    const hash = normalizeHash(item?.hash || item?.infoHash);
    if (!hash) return null;
    const season = Number(item?.season || item?._probeSeason || 0) || 0;
    const episode = Number(item?.episode || item?._probeEpisode || 0) || 0;
    const fileIdx = Number.isInteger(Number(item?.fileIdx ?? item?.file_index ?? item?.rd_file_index))
        ? Number(item?.fileIdx ?? item?.file_index ?? item?.rd_file_index)
        : -1;
    return `${tokenCacheScope(token)}:${hash}:s${season}:e${episode}:f${fileIdx}`;
}

function pruneProbeResultCache() {
    if (probeResultCache.size <= RD_PROBE_CACHE_MAX_ENTRIES) return;
    const now = Date.now();
    for (const [key, entry] of probeResultCache.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= now) probeResultCache.delete(key);
    }
    while (probeResultCache.size > RD_PROBE_CACHE_MAX_ENTRIES) {
        const firstKey = probeResultCache.keys().next().value;
        if (firstKey === undefined) break;
        probeResultCache.delete(firstKey);
    }
}

function cloneProbeResult(result = {}) {
    return JSON.parse(JSON.stringify(result || {}));
}

function readProbeResultCache(item = {}, token = '') {
    const key = getProbeCacheKey(item, token);
    if (!key) return null;
    const entry = probeResultCache.get(key);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
        probeResultCache.delete(key);
        return null;
    }
    return cloneProbeResult(entry.result);
}

function writeProbeResultCache(item = {}, token = '', result = {}) {
    const key = getProbeCacheKey(item, token);
    if (!key || !result || !result.hash) return false;
    const ttl = (result.cached === true || result.state === 'uncached_terminal')
        ? RD_PROBE_CACHE_HIT_TTL_MS
        : (result.deferred === true || result.state === 'probing' ? RD_PROBE_CACHE_DEFERRED_TTL_MS : RD_PROBE_CACHE_MISS_TTL_MS);
    probeResultCache.set(key, { result: cloneProbeResult(result), expiresAt: Date.now() + ttl });
    pruneProbeResultCache();
    return true;
}

function shouldDeferCachedProbeResult(result = {}) {
    return result.deferred === true || result.state === 'probing';
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

function buildTerminalUncachedProbeResult(hash, reason = null, errorCode = null) {
    return {
        hash: normalizeHash(hash),
        cached: false,
        deferred: false,
        state: 'uncached_terminal',
        rd_status: 'error',
        ...(Number.isInteger(errorCode) ? { rd_error_code: errorCode } : {}),
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

                const errorBody = await safeJson(response);
                const errorCode = extractRdErrorCode(errorBody);
                const errorClass = classifyRdErrorCode(errorCode);
                if (errorClass === 'terminal_uncached') {
                    // Infringing / too-big / invalid torrent: never going to become cached.
                    return { _terminalUncached: true, _errorCode: errorCode, _reason: `rd_error_${errorCode}` };
                }
                if (errorClass === 'rate_limit') {
                    // Throttling surfaced as a 4xx body code instead of an HTTP 429.
                    if (deferOnTransient) return { _deferred: true, _reason: `rd_error_${errorCode}` };
                    attempt += 1;
                    if (attempt < maxAttempts) {
                        await sleep(1000 + Math.random() * 1000);
                        continue;
                    }
                    return null;
                }
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

function hasTrustedEpisodeFileIndex(context = {}, episodeContext = null, forcedIndex = null) {
    if (!episodeContext) return true;
    if (!Number.isInteger(forcedIndex) || forcedIndex < 0) return false;
    if (context?._episodeExact === true || context?._rdEpisodeExact === true || context?._dbEpisodeExact === true || context?._dbEpisodeMapping === true) return true;
    const proof = context?._rdEpisodeProof || context?.rdEpisodeProof || null;
    const proofIndex = Number(proof?.fileIdx ?? proof?.fileIndex ?? proof?.file_index);
    if (proof?.exact === true && Number.isInteger(proofIndex) && proofIndex === forcedIndex) return true;
    const hint = context?.episodeFileHint || context?._episodeFileHint || null;
    const hintIndex = Number(hint?.fileIndex ?? hint?.fileIdx ?? hint?.file_index);
    const hintSeason = Number(hint?.season || 0);
    const hintEpisode = Number(hint?.episode || 0);
    if (Number.isInteger(hintIndex) && hintIndex === forcedIndex) {
        if (hintSeason > 0 && hintEpisode > 0) return hintSeason === episodeContext.season && hintEpisode === episodeContext.episode;
        if (hint?.source || hint?.reason) return true;
    }
    return false;
}

function chooseProbeFileSelection(files, context = {}, fallbackTitle = '') {
    const videoFiles = extractVideoFiles(files);
    const episodeContext = getEpisodeProbeContext(context, fallbackTitle);

    // Rispetta fileIdx/rd_file_index solo se è già provato come episodio richiesto.
    // Un fileIdx grezzo dentro un pack può puntare all'episodio sbagliato: in quel caso
    // cerchiamo prima un episodeFileHint tramite i nomi reali dei file RD.
    const forcedIndex = Number(context?.fileIdx ?? context?.file_index ?? context?.rd_file_index);
    const forcedIndexExists = Number.isInteger(forcedIndex) && forcedIndex >= 0 && videoFiles.some((file) => Number(file.id) === forcedIndex);
    if (forcedIndexExists && hasTrustedEpisodeFileIndex(context, episodeContext, forcedIndex)) {
        return { files: String(forcedIndex), selectedFileIndex: forcedIndex, episodeFileHint: context?.episodeFileHint || context?._episodeFileHint || null, forcedIndex: true };
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
    if (selectRes._terminalUncached) return { terminalUncached: true, errorCode: selectRes._errorCode, reason: selectRes._reason || 'select_terminal', selection };
    if (selectRes._deferred) return { deferred: true, reason: selectRes._reason || 'select_deferred', selection };

    const selectedInfo = await request('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
    if (!selectedInfo) return { info: null, reason: 'info_after_select_failed', selection };
    if (selectedInfo._terminalUncached) return { terminalUncached: true, errorCode: selectedInfo._errorCode, reason: selectedInfo._reason || 'info_after_select_terminal', selection };
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
    const episodeFileHint = episodeContext ? findEpisodeFileHint(files, episodeContext) : null;
    const selected = episodeFileHint ? {
        file_title: episodeFileHint.fileName || episodeFileHint.filePath || main.file_title,
        file_size: episodeFileHint.fileSize || main.file_size,
        file_index: Number.isInteger(Number(episodeFileHint.fileIndex)) ? Number(episodeFileHint.fileIndex) : main.file_index
    } : main;

    const hasDownloadLinks = Array.isArray(info?.links) && info.links.length > 0;
    const statusCached = isCachedStatus(info?.status) && hasDownloadLinks;
    const singleVideoTexts = [main.file_title, torrentTitle, originalFilename].filter(Boolean).join(' ');
    const singleVideoHasWrongEpisode = episodeContext ? hasWrongExplicitEpisodeMarker(singleVideoTexts, episodeContext) : false;
    const singleVideoExact = Boolean(statusCached && episodeContext && !isPack && !singleVideoHasWrongEpisode && Number.isInteger(Number(main.file_index)) && Number(main.file_index) >= 0);
    const requiresEpisodeHint = Boolean(REQUIRE_EPISODE_HINT_FOR_PACKS && statusCached && isPack && episodeContext);
    const cachedForRequestedEpisode = statusCached && (!requiresEpisodeHint || Boolean(episodeFileHint));

    return {
        hash,
        cached: cachedForRequestedEpisode,
        state: cachedForRequestedEpisode ? 'cached' : (isTerminalUncachedStatus(info?.status) ? 'uncached_terminal' : (requiresEpisodeHint ? 'likely_cached' : 'unknown')),
        rd_status: normalizeStatus(info?.status),
        torrent_title: torrentTitle,
        original_filename: originalFilename,
        pack_name: validPackName,
        is_pack: isPack,
        pack_without_episode_hint: Boolean(requiresEpisodeHint && !episodeFileHint),
        single_video_exact: singleVideoExact,
        episodeFileHint: episodeFileHint || (singleVideoExact ? {
            fileIndex: selected.file_index,
            fileIdx: selected.file_index,
            fileName: selected.file_title,
            filePath: selected.file_title,
            fileSize: selected.file_size,
            season: episodeContext.season,
            episode: episodeContext.episode,
            confidence: 0.9,
            reason: 'single_video_probe',
            source: 'rd_probe_single_video'
        } : null),
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
        if (!addRes) return buildDeferredProbeResult(hash, null, 'Failed to add magnet');
        if (addRes._terminalUncached) return buildTerminalUncachedProbeResult(hash, addRes._reason, addRes._errorCode);
        if (addRes._deferred) return buildDeferredProbeResult(hash, null, addRes._reason);
        if (!addRes.id) return buildDeferredProbeResult(hash, null, 'No torrent ID');

        torrentId = addRes.id;

        let info = await request('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
        if (!info) {
            await cleanup();
            return buildDeferredProbeResult(hash, null, 'Failed to get torrent info');
        }
        if (info._terminalUncached) {
            await cleanup();
            return buildTerminalUncachedProbeResult(hash, info._reason, info._errorCode);
        }
        if (info._deferred) {
            await cleanup();
            return buildDeferredProbeResult(hash, null, info._reason);
        }

        let initialStatus = normalizeStatus(info?.status);

        if (initialStatus === 'waiting_files_selection') {
            const selectionResult = await selectFilesForProbe(request, token, torrentId, info, context);
            if (selectionResult?.missingEpisodeHint) {
                const result = {
                    ...buildProbeResult(hash, info, context),
                    cached: false,
                    state: 'likely_cached',
                    pack_without_episode_hint: true
                };
                await cleanup();
                return result;
            }
            if (selectionResult?.terminalUncached) {
                await cleanup();
                return buildTerminalUncachedProbeResult(hash, selectionResult.reason, selectionResult.errorCode);
            }
            if (selectionResult?.deferred) {
                await cleanup();
                return buildDeferredProbeResult(hash, initialStatus, selectionResult.reason);
            }
            if (!selectionResult?.info) {
                await cleanup();
                return buildDeferredProbeResult(hash, initialStatus, selectionResult?.reason || 'select_failed');
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
            if (latestInfo._terminalUncached) {
                await cleanup();
                return buildTerminalUncachedProbeResult(hash, latestInfo._reason, latestInfo._errorCode);
            }
            if (latestInfo._deferred) {
                await cleanup();
                return buildDeferredProbeResult(hash, initialStatus, latestInfo._reason);
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
        return buildDeferredProbeResult(hash, null, error?.message || 'unknown_error');
    }
    });
}

function resolveProbePriority(options = {}) {
    if (options.priority) return options.priority;
    return options.fast === true ? 'view_scan' : 'foreground';
}

function scheduleAvailabilityProbe(infoHash, magnet, token, options = {}, dependencies = {}) {
    const coordinatorSchedule = dependencies.scheduleRdProbe || scheduleRdProbe;
    const executeProbe = dependencies.performAvailabilityProbe || performAvailabilityProbe;
    return coordinatorSchedule({
        token,
        hash: infoHash,
        context: options.context || {},
        priority: resolveProbePriority(options),
        execute: () => executeProbe(infoHash, magnet, token, options)
    });
}

function inspectSingleHash(infoHash, magnet, token, context = {}, options = {}) {
    return scheduleAvailabilityProbe(infoHash, magnet, token, {
        ...options,
        fast: false,
        backgroundDelete: false,
        context
    });
}

function inspectSingleHashFast(infoHash, magnet, token, context = {}, options = {}) {
    return scheduleAvailabilityProbe(infoHash, magnet, token, {
        ...options,
        fast: true,
        backgroundDelete: true,
        context
    });
}

function projectProbeResultForBatch(result = {}) {
    return {
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
        const cachedResult = readProbeResultCache(item, token);
        if (cachedResult) {
            if (shouldDeferCachedProbeResult(cachedResult)) {
                deferred.push(item);
                continue;
            }
            results[normalizeHash(cachedResult.hash)] = projectProbeResultForBatch(cachedResult);
            continue;
        }

        const result = exactForeground && i < exactLimit
            ? await inspectSingleHash(item?.hash, item?.magnet, token, item, { priority: options?.priority || 'foreground' })
            : await inspectSingleHashFast(item?.hash, item?.magnet, token, item, { priority: options?.priority || 'view_scan' });
        writeProbeResultCache(item, token, result);

        if (result.deferred) {
            deferred.push(item);
        } else {
            results[normalizeHash(result.hash)] = projectProbeResultForBatch(result);
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
                    const inspected = await inspectSingleHash(item.hash, item.magnet, token, item, { priority: 'backfill' });
                    if (!inspected?.deferred) results.push({ ...inspected, _probeContext: item });
                }

                if (results.length === 0) return;

                if (dbHelper && typeof dbHelper.updateRdCacheStatus === 'function') {
                    const availabilityUpdates = results.map((result) => ({
                        hash: normalizeHash(result.hash),
                        state: result.cached ? 'cached' : (isTerminalUncachedStatus(result.rd_status) ? 'uncached_terminal' : (result.pack_without_episode_hint ? 'likely_cached' : 'likely_uncached')),
                        cached: result.cached ? true : (isTerminalUncachedStatus(result.rd_status) ? false : null),
                        torrent_title: result.torrent_title || null,
                        size: result.size || null,
                        file_title: result.file_title || null,
                        file_size: result.file_size || null,
                        rd_file_index: Number.isInteger(Number(result.file_index)) && Number(result.file_index) >= 0 ? Number(result.file_index) : null,
                        next_hours: (result.cached || result.pack_without_episode_hint) ? RD_CACHED_RECHECK_HOURS : (isTerminalUncachedStatus(result.rd_status) ? (24 * 7) : 12),
                        failures: (result.cached || result.pack_without_episode_hint) ? 0 : 1,
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
    isValidPackName,
    __private: {
        buildDeferredProbeResult,
        performAvailabilityProbe,
        resolveProbePriority,
        scheduleAvailabilityProbe,
        shouldDeferCachedProbeResult
    }
};
