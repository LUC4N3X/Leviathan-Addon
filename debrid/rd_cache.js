'use strict';

const RD_BASE_URL = 'https://api.real-debrid.com/rest/1.0';
const RD_TIMEOUT = 30000;
const RD_FAST_TIMEOUT = 5000;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i;
const PACK_TITLE_PATTERN = /\b(trilog(?:y)?|saga|collection|collezione|pack|complete|completa|integrale|filmografia)\b/i;

function isVideoFile(path) {
    return VIDEO_EXTENSIONS.test(path || '');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeHash(hash) {
    return String(hash || '').trim().toLowerCase();
}

function isValidPackName(name) {
    if (!name) return false;
    if (name.length < 10) return false;

    const invalidKeywords = ['magnet', 'invalid', 'torrent', 'download', 'error', '404', 'unavailable'];
    const lowerName = name.toLowerCase();

    if (invalidKeywords.some(keyword => lowerName.includes(keyword))) {
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

    if (episodeRangePatterns.some(pattern => pattern.test(name))) return true;

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
            const response = await fetch(url, buildRequestConfig(method, token, data, controller.signal));

            if (response.status === 204) return { success: true };
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

            return await safeJson(response);
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

function extractVideoFiles(files) {
    if (!Array.isArray(files) || files.length === 0) return [];
    return files
        .filter(file => isVideoFile(file?.path) && Number(file?.bytes || 0) > 25 * 1024 * 1024)
        .map(file => ({
            id: file.id,
            path: file.path,
            bytes: Number(file.bytes || 0)
        }));
}

function pickMainVideoFile(files) {
    if (!Array.isArray(files) || files.length === 0) return { file_title: null, file_size: null };

    const candidate = [...files].sort((a, b) => Number(b?.bytes || 0) - Number(a?.bytes || 0))[0];
    if (!candidate) return { file_title: null, file_size: null };

    const fullPath = candidate.path || '';
    return {
        file_title: fullPath.split('/').pop() || fullPath || null,
        file_size: Number(candidate.bytes || 0) || null
    };
}

function buildCheckResult(infoHash, info) {
    const hash = normalizeHash(infoHash);
    const files = extractVideoFiles(info?.files);
    const main = pickMainVideoFile(files);
    const torrentTitle = info?.filename || '';
    const originalFilename = info?.original_filename || '';
    const packSource = originalFilename || torrentTitle;
    const validPackName = isValidPackName(packSource) ? packSource : null;
    const isPack = files.length > 1;

    return {
        hash,
        cached: info?.status === 'downloaded',
        torrent_title: torrentTitle,
        original_filename: originalFilename,
        pack_name: validPackName,
        is_pack: isPack,
        size: Number(info?.bytes || 0),
        file_title: main.file_title,
        file_size: main.file_size,
        files
    };
}

async function performCacheCheck(infoHash, magnet, token, options = {}) {
    const {
        fast = false,
        backgroundDelete = fast
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

    try {
        const addRes = await request('POST', `${RD_BASE_URL}/torrents/addMagnet`, token, buildMagnetBody(magnet));
        if (!addRes) return { hash, cached: false, error: 'Failed to add magnet' };
        if (addRes._deferred) return { hash, cached: false, deferred: true, error: addRes._reason };
        if (!addRes.id) return { hash, cached: false, error: 'No torrent ID' };

        torrentId = addRes.id;

        let info = await request('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
        if (!info) {
            await cleanup();
            return { hash, cached: false, error: 'Failed to get torrent info' };
        }
        if (info._deferred) {
            await cleanup();
            return { hash, cached: false, deferred: true, error: info._reason };
        }

        if (info.status === 'waiting_files_selection') {
            const selectRes = await request('POST', `${RD_BASE_URL}/torrents/selectFiles/${torrentId}`, token, buildSelectAllBody());
            if (!selectRes) {
                await cleanup();
                return { hash, cached: false, error: 'Failed to select files' };
            }
            if (selectRes._deferred) {
                await cleanup();
                return { hash, cached: false, deferred: true, error: selectRes._reason };
            }

            info = await request('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
            if (!info) {
                await cleanup();
                return { hash, cached: false, error: 'Failed to re-fetch info' };
            }
            if (info._deferred) {
                await cleanup();
                return { hash, cached: false, deferred: true, error: info._reason };
            }
        }

        const result = buildCheckResult(hash, info);
        await cleanup();
        return result;
    } catch (error) {
        await cleanup();
        return {
            hash,
            cached: false,
            ...(fast ? { deferred: true } : {}),
            error: error?.message || 'unknown_error'
        };
    }
}

function checkSingleHash(infoHash, magnet, token) {
    return performCacheCheck(infoHash, magnet, token, { fast: false, backgroundDelete: false });
}

function checkSingleHashFast(infoHash, magnet, token) {
    return performCacheCheck(infoHash, magnet, token, { fast: true, backgroundDelete: true });
}

async function checkCacheSyncFast(items, token, limit = 5) {
    const results = {};
    const deferred = [];
    const toCheck = Array.isArray(items) ? items.slice(0, Math.max(0, limit | 0)) : [];

    if (DEBUG_MODE) {
        console.log(`⚡ [RD Fast] Checking ${toCheck.length} hashes...`);
    }

    for (let i = 0; i < toCheck.length; i += 1) {
        const item = toCheck[i];
        const result = await checkSingleHashFast(item?.hash, item?.magnet, token);

        if (result.deferred) {
            deferred.push(item);
        } else {
            results[normalizeHash(result.hash)] = {
                cached: result.cached,
                file_title: result.file_title,
                file_size: result.file_size,
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
        console.log(`⚡ [RD Fast] Done: ${Object.values(results).filter(entry => entry.cached).length} cached, ${deferred.length} deferred`);
    }

    return { results, deferred };
}

function cleanFilePath(path) {
    if (!path) return 'unknown.mkv';
    const cleaned = String(path).replace(/^\/+/, '');
    return cleaned.includes('/') ? cleaned.split('/').pop() : cleaned;
}

async function enrichCacheBackground(items, token, dbHelper, onUpdated = null) {
    if (!Array.isArray(items) || items.length === 0) return null;

    const timer = setTimeout(() => {
        void (async () => {
            try {
                const normalizedItems = items
                    .filter(item => item?.hash && item?.magnet)
                    .map(item => ({ ...item, hash: normalizeHash(item.hash) }));

                if (normalizedItems.length === 0) return;

                let knownHashes = {};
                if (dbHelper && typeof dbHelper.getRdCachedAvailability === 'function') {
                    const dbKnown = await dbHelper.getRdCachedAvailability(normalizedItems.map(item => item.hash));
                    knownHashes = Object.fromEntries(
                        Object.entries(dbKnown || {}).map(([key, value]) => [normalizeHash(key), value])
                    );
                }

                const results = [];

                for (const item of normalizedItems) {
                    if (knownHashes[item.hash] !== undefined) continue;
                    await sleep(1000);
                    results.push(await checkSingleHash(item.hash, item.magnet, token));
                }

                if (results.length === 0) return;

                if (dbHelper && typeof dbHelper.updateRdCacheStatus === 'function') {
                    const cacheUpdates = results.map(result => ({
                        hash: normalizeHash(result.hash),
                        cached: result.cached,
                        torrent_title: result.torrent_title || null,
                        size: result.size || null,
                        file_title: result.file_title || null,
                        file_size: result.file_size || null
                    }));

                    await dbHelper.updateRdCacheStatus(cacheUpdates);

                    if (typeof onUpdated === 'function' && cacheUpdates.length > 0) {
                        try {
                            await onUpdated(cacheUpdates);
                        } catch {}
                    }
                }

                if (dbHelper && typeof dbHelper.insertPackFiles === 'function') {
                    for (const result of results) {
                        const shouldPersistPackFiles = result.cached && result.is_pack && (isPackTitle(result.torrent_title) || !!result.pack_name);
                        if (!shouldPersistPackFiles) continue;

                        const videoFiles = (result.files || []).filter(file => isVideoFile(file.path) && Number(file.bytes || 0) > 50 * 1024 * 1024);
                        if (videoFiles.length === 0) continue;

                        try {
                            await dbHelper.insertPackFiles(videoFiles.map(file => ({
                                pack_hash: normalizeHash(result.hash),
                                imdb_id: null,
                                file_index: file.id,
                                file_path: cleanFilePath(file.path),
                                file_size: Number(file.bytes || 0)
                            })));
                        } catch (error) {
                            console.warn(`⚠️ [RD Cache Background] Failed to save pack files: ${error.message}`);
                        }
                    }
                }
            } catch (error) {
                console.error('❌ [RD Cache Background] Error:', error?.message || error);
            }
        })();
    }, 5000);

    return timer;
}

module.exports = {
    checkSingleHash,
    checkSingleHashFast,
    checkCacheSyncFast,
    enrichCacheBackground,
    isValidPackName
};
