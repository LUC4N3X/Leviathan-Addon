// =====================================================
// RD CACHE CHECKER - LEVIATHAN EDITION
// =====================================================
// Verifica proattiva della cache RealDebrid usando il metodo
// Add → Status → Delete. Funziona anche con instantAvailability disabilitata.

const RD_BASE_URL = 'https://api.real-debrid.com/rest/1.0';
const RD_TIMEOUT = 30000;
const RD_FAST_TIMEOUT = 5000; // 5 seconds for foreground fast check (no retry)
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// Video extensions for filtering
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i;

/**
 * Check if file is a video file
 */
function isVideoFile(path) {
    return VIDEO_EXTENSIONS.test(path || '');
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Verifica se un nome torrent è un nome pack VALIDO
 */
function isValidPackName(name) {
    if (!name) return false;

    if (name.length < 10) return false;

    const INVALID_KEYWORDS = ['magnet', 'invalid', 'torrent', 'download', 'error', '404', 'unavailable'];
    const lowerName = name.toLowerCase();
    const hasInvalidKeyword = INVALID_KEYWORDS.some(n => lowerName.includes(n));
    if (hasInvalidKeyword) {
        const hasReleaseContent = /(?:s\d{1,2}|season|stagion|\d{3,4}p|bluray|blu-ray|web-?dl|web-?rip|hdtv|dvdrip|bdrip|remux|x\.?26[45]|h\.?26[45]|hevc|avc|xvid|mkv|mp4|aac|ac3|dts|dd[p+]?|multi|dual|ita|eng|complete|completa)/i.test(name);
        if (!hasReleaseContent) return false; 
    }

    if (/^[a-f0-9]{32,40}$/i.test(name)) return false;
    if (VIDEO_EXTENSIONS.test(name)) return false;

    if (/S\d{1,2}(?![Ee]\d)/i.test(name) && !/S\d{1,2}[Ee]\d{1,3}/i.test(name)) return true; 

    const EPISODE_RANGE_PATTERNS = [
        /S\d{1,2}[Ee]\d{1,3}[-–]\d{1,3}/i,          
        /S\d{1,2}[Ee]\d{1,3}[-–][Ee]\d{1,3}/i,       
        /S\d{1,2}[-–][Ee][Pp]?\d{1,3}[-–]\d{1,3}/i,  
        /S\d{1,2}[Ee][Pp]\d{1,3}[-–]\d{1,3}/i,       
        /[Ee][Pp]?\d{1,3}[-–][Ee]?[Pp]?\d{1,3}/i,    
        /\d{1,2}x\d{1,3}[-–]\d{1,3}/i,               
    ];
    if (EPISODE_RANGE_PATTERNS.some(pattern => pattern.test(name))) return true; 

    const hasSingleEpisode = /S\d{1,2}[Ee]\d{1,3}/i.test(name);
    const hasRange = /[-–]\d{1,3}|[-–][Ee]\d{1,3}/i.test(name);
    if (hasSingleEpisode && !hasRange) return false; 

    return true;
}

/**
 * Generic RD API request with retry logic
 */
async function rdRequest(method, url, token, data = null) {
    let attempt = 0;
    while (attempt < 3) {
        try {
            const config = {
                method,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            };

            if (data) config.body = data;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), RD_TIMEOUT);
            config.signal = controller.signal;

            const response = await fetch(url, config);
            clearTimeout(timeoutId);

            if (response.status === 204) return { success: true };

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                if (response.status === 403) return null;
                if (response.status === 429 || response.status >= 500) {
                    await sleep(1000 + Math.random() * 1000);
                    attempt++;
                    continue;
                }
                return null;
            }

            return await response.json();
        } catch (error) {
            attempt++;
            if (attempt < 3) await sleep(500);
        }
    }
    return null;
}

/**
 * Fast RD API request - single attempt, no retry, low timeout.
 */
async function rdRequestFast(method, url, token, data = null) {
    try {
        const config = {
            method,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        };
        if (data) config.body = data;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), RD_FAST_TIMEOUT);
        config.signal = controller.signal;

        const response = await fetch(url, config);
        clearTimeout(timeoutId);

        if (response.status === 204) return { success: true };
        if (response.status === 429) return { _deferred: true, _reason: '429' };
        if (!response.ok) {
            if (response.status === 403) return null;
            if (response.status >= 500) return { _deferred: true, _reason: `${response.status}` };
            return null;
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') return { _deferred: true, _reason: 'timeout' };
        return { _deferred: true, _reason: error.message };
    }
}

/**
 * Delete a torrent from RD account
 */
async function deleteTorrent(token, torrentId) {
    try {
        await rdRequest('DELETE', `${RD_BASE_URL}/torrents/delete/${torrentId}`, token);
    } catch (e) {
        // Silently fail on background delete
    }
}

/**
 * Check if a single hash is cached in RealDebrid
 */
async function checkSingleHash(infoHash, magnet, token) {
    let torrentId = null;

    try {
        const addBody = new URLSearchParams();
        addBody.append('magnet', magnet);

        const addRes = await rdRequest('POST', `${RD_BASE_URL}/torrents/addMagnet`, token, addBody);
        if (!addRes || !addRes.id) return { hash: infoHash, cached: false, error: 'Failed to add magnet' };
        torrentId = addRes.id;

        let info = await rdRequest('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
        if (!info) {
            await deleteTorrent(token, torrentId);
            return { hash: infoHash, cached: false, error: 'Failed to get torrent info' };
        }

        if (info.status === 'waiting_files_selection') {
            const selBody = new URLSearchParams();
            selBody.append('files', 'all');
            await rdRequest('POST', `${RD_BASE_URL}/torrents/selectFiles/${torrentId}`, token, selBody);
            info = await rdRequest('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
        }

        const isCached = info?.status === 'downloaded';
        let mainFileName = '';
        let mainFileSize = 0;
        let torrentTitle = info?.filename || ''; 
        let torrentSize = info?.bytes || 0;     
        let allVideoFiles = [];

        if (info?.files && Array.isArray(info.files)) {
            const videoFiles = info.files
                .filter(f => VIDEO_EXTENSIONS.test(f.path))
                .sort((a, b) => (b.bytes || 0) - (a.bytes || 0));

            allVideoFiles = info.files
                .filter(f => VIDEO_EXTENSIONS.test(f.path) && f.bytes > 25 * 1024 * 1024)
                .map(f => ({ id: f.id, path: f.path, bytes: f.bytes }));

            if (videoFiles.length > 0) {
                const fullPath = videoFiles[0].path;
                mainFileName = fullPath.split('/').pop() || fullPath;
                mainFileSize = videoFiles[0].bytes || 0;
            }
        }

        await deleteTorrent(token, torrentId);

        const packName = info?.original_filename || info?.filename || '';
        const isPack = allVideoFiles.length > 1;
        const validPackName = isValidPackName(packName) ? packName : null;

        return {
            hash: infoHash,
            cached: isCached,
            torrent_title: torrentTitle,
            original_filename: info?.original_filename || '',
            pack_name: validPackName,
            is_pack: isPack,
            size: torrentSize,
            file_title: mainFileName || null,
            file_size: mainFileSize || null,
            files: allVideoFiles
        };

    } catch (error) {
        if (torrentId) await deleteTorrent(token, torrentId);
        return { hash: infoHash, cached: false, error: error.message };
    }
}

/**
 * Fast check if a single hash is cached in RealDebrid.
 */
async function checkSingleHashFast(infoHash, magnet, token) {
    let torrentId = null;
    try {
        const addBody = new URLSearchParams();
        addBody.append('magnet', magnet);
        const addRes = await rdRequestFast('POST', `${RD_BASE_URL}/torrents/addMagnet`, token, addBody);
        
        if (!addRes) return { hash: infoHash, cached: false, error: 'Failed to add magnet' };
        if (addRes._deferred) return { hash: infoHash, cached: false, deferred: true, error: addRes._reason };
        if (!addRes.id) return { hash: infoHash, cached: false, error: 'No torrent ID' };
        torrentId = addRes.id;

        let info = await rdRequestFast('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
        if (!info || info._deferred) {
            deleteTorrent(token, torrentId).catch(() => {});
            if (info?._deferred) return { hash: infoHash, cached: false, deferred: true, error: info._reason };
            return { hash: infoHash, cached: false, error: 'Failed to get torrent info' };
        }

        if (info.status === 'waiting_files_selection') {
            const selBody = new URLSearchParams();
            selBody.append('files', 'all');
            const selRes = await rdRequestFast('POST', `${RD_BASE_URL}/torrents/selectFiles/${torrentId}`, token, selBody);
            if (selRes?._deferred) {
                deleteTorrent(token, torrentId).catch(() => {});
                return { hash: infoHash, cached: false, deferred: true, error: selRes._reason };
            }
            info = await rdRequestFast('GET', `${RD_BASE_URL}/torrents/info/${torrentId}`, token);
            if (!info || info._deferred) {
                deleteTorrent(token, torrentId).catch(() => {});
                if (info?._deferred) return { hash: infoHash, cached: false, deferred: true, error: info._reason };
                return { hash: infoHash, cached: false, error: 'Failed to re-fetch info' };
            }
        }

        const isCached = info?.status === 'downloaded';

        let mainFileName = '';
        let mainFileSize = 0;
        let torrentTitle = info?.filename || '';
        let torrentSize = info?.bytes || 0;
        let allVideoFiles = [];

        if (info?.files && Array.isArray(info.files)) {
            const videoFiles = info.files
                .filter(f => VIDEO_EXTENSIONS.test(f.path))
                .sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
            allVideoFiles = info.files
                .filter(f => VIDEO_EXTENSIONS.test(f.path) && f.bytes > 25 * 1024 * 1024)
                .map(f => ({ id: f.id, path: f.path, bytes: f.bytes }));
            if (videoFiles.length > 0) {
                const fullPath = videoFiles[0].path;
                mainFileName = fullPath.split('/').pop() || fullPath;
                mainFileSize = videoFiles[0].bytes || 0;
            }
        }

        deleteTorrent(token, torrentId).catch(() => {});

        const packName = info?.original_filename || info?.filename || '';
        const isPack = allVideoFiles.length > 1;
        const validPackName = isValidPackName(packName) ? packName : null;

        return {
            hash: infoHash,
            cached: isCached,
            torrent_title: torrentTitle,
            original_filename: info?.original_filename || '',
            pack_name: validPackName,
            is_pack: isPack,
            size: torrentSize,
            file_title: mainFileName || null,
            file_size: mainFileSize || null,
            files: allVideoFiles
        };
    } catch (error) {
        if (torrentId) deleteTorrent(token, torrentId).catch(() => {});
        return { hash: infoHash, cached: false, deferred: true, error: error.message };
    }
}

/**
 * Fast synchronous cache check for foreground
 */
async function checkCacheSyncFast(items, token, limit = 5) {
    const results = {};
    const deferred = [];
    const toCheck = items.slice(0, limit);

    if (DEBUG_MODE) console.log(`⚡ [RD Fast] Checking ${toCheck.length} hashes...`);

    for (let i = 0; i < toCheck.length; i++) {
        const item = toCheck[i];
        const result = await checkSingleHashFast(item.hash, item.magnet, token);

        if (result.deferred) {
            deferred.push(item);
        } else {
            results[result.hash.toLowerCase()] = {
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

        if (i < toCheck.length - 1) await sleep(200);
    }

    if (DEBUG_MODE) console.log(`⚡ [RD Fast] Done: ${Object.values(results).filter(r => r.cached).length} cached, ${deferred.length} deferred`);
    return { results, deferred };
}

/**
 * Helper to check if title indicates a pack
 */
function isPackTitle(title) {
    if (!title) return false;
    return /\b(trilog|saga|collection|collezione|pack|completa|integrale|filmografia)\b/i.test(title);
}

/**
 * Enrich cache in background (non-blocking)
 */
async function enrichCacheBackground(items, token, dbHelper) {
    if (!items || items.length === 0) return;

    setTimeout(() => {
        (async () => {
            try {
                const results = [];
                let alreadyCachedHashes = {};
                
                if (dbHelper && typeof dbHelper.getRdCachedAvailability === 'function') {
                    const allHashes = items.map(i => i.hash);
                    alreadyCachedHashes = await dbHelper.getRdCachedAvailability(allHashes);
                }

                for (const item of items) {
                    if (alreadyCachedHashes[item.hash] !== undefined) continue;

                    await sleep(1000); // Respect RD API limits
                    const result = await checkSingleHash(item.hash, item.magnet, token);
                    results.push(result);
                }

                if (dbHelper && typeof dbHelper.updateRdCacheStatus === 'function') {
                    const cacheUpdates = results.map(r => ({
                        hash: r.hash,
                        cached: r.cached,
                        torrent_title: r.torrent_title || null,
                        size: r.size || null,
                        file_title: r.file_title || null,
                        file_size: r.file_size || null
                    }));
                    await dbHelper.updateRdCacheStatus(cacheUpdates);
                }

                if (dbHelper && typeof dbHelper.insertPackFiles === 'function') {
                    for (const result of results) {
                        const isPack = isPackTitle(result.torrent_title) && result.files && result.files.length > 1;

                        if (result.cached && isPack) {
                            try {
                                const cleanFilePath = (p) => {
                                    if (!p) return 'unknown.mkv';
                                    const cleaned = p.replace(/^\/+/, ''); 
                                    return cleaned.includes('/') ? cleaned.split('/').pop() : cleaned;
                                };

                                const videoFiles = result.files.filter(f => isVideoFile(f.path) && f.bytes > 50 * 1024 * 1024);
                                if (videoFiles.length === 0) continue;

                                const packFilesData = videoFiles.map(f => ({
                                    pack_hash: result.hash.toLowerCase(),
                                    imdb_id: null,
                                    file_index: f.id,
                                    file_path: cleanFilePath(f.path), 
                                    file_size: f.bytes || 0
                                }));
                                await dbHelper.insertPackFiles(packFilesData);
                            } catch (packErr) {
                                console.warn(`⚠️ [RD Cache Background] Failed to save pack files: ${packErr.message}`);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ [RD Cache Background] Error:`, error.message);
            }
        })();
    }, 5000); 
}

// Export module
module.exports = {
    checkSingleHash,
    checkSingleHashFast,
    checkCacheSyncFast,
    enrichCacheBackground,
    isValidPackName
};
