'use strict';

const runtimeState = require('../../runtime_state');
const {
    normalizeHash,
    parseMagnetInput,
    parseTorrentInput,
    inferPackMappings
} = require('../../lib/manual_import_parser');

function normalizeHashes(values) {
    return [...new Set((Array.isArray(values) ? values : [values])
        .map((value) => normalizeHash(value))
        .filter(Boolean))];
}

function normalizePackFileEntries(values = []) {
    return (Array.isArray(values) ? values : []).map((entry) => ({
        file_index: entry?.file_index ?? entry?.fileIdx,
        imdb_id: entry?.imdb_id || entry?.imdbId,
        imdb_season: entry?.imdb_season ?? entry?.season,
        imdb_episode: entry?.imdb_episode ?? entry?.episode,
        file_path: entry?.file_path || entry?.filePath,
        file_title: entry?.file_title || entry?.fileTitle || entry?.title,
        file_size: entry?.file_size || entry?.size
    })).filter((entry) => Number.isInteger(Number(entry.file_index)) && Number(entry.file_index) >= 0);
}

function getLargestPackFileIndex(files = []) {
    const largest = [...files].sort((left, right) => (Number(right?.file_size || 0) || 0) - (Number(left?.file_size || 0) || 0))[0];
    return Number.isInteger(Number(largest?.file_index)) && Number(largest.file_index) >= 0 ? Number(largest.file_index) : null;
}

function normalizeManualImportPayload(body = {}) {
    let torrentMeta = null;
    const magnet = parseMagnetInput(body.magnet || body.magnetUri || body.magnetURI || body.magnet_url || body.magnetUrl || '');
    const torrentSource = body.torrent || body.torrentB64 || body.torrentBase64 || body.torrentFile || body.torrent_file || null;
    if (torrentSource) torrentMeta = parseTorrentInput(torrentSource);

    const imdbId = String(body.imdbId || body.imdb_id || '').trim().toLowerCase();
    const season = Number.isInteger(Number(body.season)) && Number(body.season) > 0 ? Number(body.season) : null;
    const episode = Number.isInteger(Number(body.episode)) && Number(body.episode) > 0 ? Number(body.episode) : null;
    const requestedFileIndex = Number.isInteger(Number(body.fileIdx ?? body.file_index)) && Number(body.fileIdx ?? body.file_index) >= 0
        ? Number(body.fileIdx ?? body.file_index)
        : null;
    const inferredType = String(body.type || (season || episode ? 'series' : 'movie')).trim().toLowerCase();
    const hash = normalizeHash(body.hash || body.infoHash || body.info_hash) || magnet?.infoHash || torrentMeta?.infoHash || null;
    const normalizedPackFiles = normalizePackFileEntries(body.packFiles || body.pack_files || []);
    const inferredPackFiles = normalizedPackFiles.length > 0
        ? normalizedPackFiles
        : inferPackMappings(torrentMeta?.files || [], {
            imdbId,
            type: inferredType,
            season,
            episode,
            isAnime: body.isAnime === true || body.anime === true
        });

    let autoFileIndex = requestedFileIndex;
    if (autoFileIndex === null && season && episode) {
        const mappedFile = inferredPackFiles.find((entry) => Number(entry?.imdb_season) === season && Number(entry?.imdb_episode) === episode);
        if (mappedFile && Number.isInteger(Number(mappedFile.file_index))) autoFileIndex = Number(mappedFile.file_index);
    }
    if (autoFileIndex === null && torrentMeta?.files?.length === 1) autoFileIndex = 0;
    if (autoFileIndex === null) autoFileIndex = getLargestPackFileIndex(inferredPackFiles.length > 0 ? inferredPackFiles : (torrentMeta?.files || []));

    const size = Number.isFinite(Number(body.size)) && Number(body.size) > 0
        ? Number(body.size)
        : (Number(torrentMeta?.totalSize || 0) || 0);
    const service = ['rd', 'tb'].includes(String(body.service || '').trim().toLowerCase()) ? String(body.service).trim().toLowerCase() : null;

    return {
        hash,
        magnet: magnet?.magnet || String(body.magnet || body.magnetUri || body.magnetURI || '').trim() || null,
        title: String(body.title || '').trim() || magnet?.title || torrentMeta?.title || hash,
        provider: String(body.provider || body.source || 'MANUAL').trim() || 'MANUAL',
        imdbId: /^tt\d+$/.test(imdbId) ? imdbId : null,
        type: inferredType,
        season,
        episode,
        fileIndex: autoFileIndex,
        size,
        service,
        apiKey: String(body.apiKey || body.api_key || '').trim() || null,
        packFiles: inferredPackFiles,
        torrentMeta,
        importSource: torrentMeta ? 'torrent' : (magnet ? 'magnet' : 'hash')
    };
}

function registerAdminRoutes(app, {
    Cache,
    ADMIN_PASS,
    safeCompare,
    dbHelper,
    logger,
    queueCloudBuild
}) {
    const authMiddleware = (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!ADMIN_PASS) return res.status(503).json({ error: 'Admin disabilitato: configura ADMIN_PASS nell\'ambiente' });
        const rawAuthHeader = String(req.headers.authorization || '').trim();
        if (safeCompare(rawAuthHeader.toLowerCase().startsWith('bearer ') ? rawAuthHeader.slice(7).trim() : rawAuthHeader, ADMIN_PASS)) {
            return next();
        }
        return res.status(403).json({ error: 'Password errata' });
    };

    app.get('/admin/keys', authMiddleware, async (req, res) => res.json(await Cache.listKeys()));
    app.delete('/admin/key', authMiddleware, async (req, res) => {
        if (!req.query.key) return res.json({ error: 'Key mancante' });
        await Cache.deleteKey(req.query.key);
        return res.json({ success: true });
    });
    app.post('/admin/flush', authMiddleware, async (req, res) => {
        await Cache.flushAll();
        res.json({ success: true });
    });

    app.post('/admin/cache/invalidate', authMiddleware, async (req, res) => {
        const hashes = normalizeHashes(req.body?.hashes || req.body?.hash || []);
        const imdbId = String(req.body?.imdbId || req.body?.imdb_id || '').trim().toLowerCase();
        const season = Number.isInteger(Number(req.body?.season)) ? Number(req.body.season) : null;
        const episode = Number.isInteger(Number(req.body?.episode)) ? Number(req.body.episode) : null;
        const dbKey = String(req.body?.dbLookupKey || '').trim();
        const reason = String(req.body?.reason || 'manual_admin_invalidation').trim();

        const outcomes = {};
        if (hashes.length > 0) outcomes.hashes = await Cache.invalidateStreamsByHashes(hashes, reason);
        if (/^tt\d+$/.test(imdbId) && season > 0 && episode > 0) outcomes.episode = await Cache.invalidateStreamsByEpisode({ imdbId, season, episode }, reason);
        else if (/^tt\d+$/.test(imdbId)) outcomes.imdb = await Cache.invalidateStreamsByImdb(imdbId, reason);
        if (dbKey) outcomes.dbLookup = await Cache.invalidateDbTorrents(dbKey, reason);

        res.json({ success: true, outcomes });
    });

    app.post('/admin/runtime/drain', authMiddleware, async (req, res) => {
        const enableDrain = req.body?.enabled !== false;
        const reason = String(req.body?.reason || 'manual_admin_drain').trim();
        if (enableDrain) runtimeState.markDraining(reason, { rejectNewRequests: req.body?.rejectNewRequests !== false });
        else runtimeState.clearDraining();
        res.json({ success: true, runtime: runtimeState.getSnapshot() });
    });

    app.post('/admin/manual-import', authMiddleware, async (req, res) => {
        let payload;
        try {
            payload = normalizeManualImportPayload(req.body || {});
        } catch (error) {
            return res.status(400).json({ success: false, error: `Import torrent non valido: ${error.message}` });
        }

        if (!payload.hash) {
            return res.status(400).json({ error: 'Fornisci hash/infoHash, magnet o torrent valido.' });
        }

        const summary = {
            importSource: payload.importSource,
            ensured: false,
            mapped: false,
            episodeMapped: false,
            packFilesInserted: 0,
            cacheInvalidated: null,
            cloudBuildQueued: false
        };

        try {
            summary.ensured = await dbHelper.ensureTorrentRecord({
                info_hash: payload.hash,
                title: payload.title,
                provider: payload.provider,
                size: payload.size,
                file_index: payload.fileIndex,
                magnet: payload.magnet || undefined
            });

            if (payload.imdbId) {
                summary.mapped = await dbHelper.insertTorrent({
                    imdb_id: payload.imdbId,
                    type: payload.type,
                    season: payload.season,
                    episode: payload.episode
                }, {
                    info_hash: payload.hash,
                    title: payload.title,
                    provider: payload.provider,
                    size: payload.size,
                    file_index: payload.fileIndex,
                    magnet: payload.magnet || undefined,
                    is_pack: payload.packFiles.length > 1
                });

                if (payload.type !== 'movie' && payload.season && payload.episode) {
                    const episodeInsert = await dbHelper.insertEpisodeFiles([{
                        info_hash: payload.hash,
                        file_index: payload.fileIndex,
                        imdb_id: payload.imdbId,
                        imdb_season: payload.season,
                        imdb_episode: payload.episode,
                        title: payload.title,
                        size: payload.size
                    }]);
                    summary.episodeMapped = Number(episodeInsert?.processed || 0) > 0;
                }

                if (payload.packFiles.length > 0 && typeof dbHelper.insertPackFiles === 'function') {
                    const packInsert = await dbHelper.insertPackFiles(payload.packFiles.map((entry) => ({
                        pack_hash: payload.hash,
                        file_index: entry?.file_index ?? entry?.fileIdx,
                        imdb_id: entry?.imdb_id || entry?.imdbId || payload.imdbId,
                        imdb_season: entry?.imdb_season ?? entry?.season,
                        imdb_episode: entry?.imdb_episode ?? entry?.episode,
                        file_path: entry?.file_path || entry?.filePath,
                        file_title: entry?.file_title || entry?.fileTitle || entry?.title,
                        file_size: entry?.file_size || entry?.size
                    })));
                    summary.packFilesInserted = Number(packInsert?.processed || 0);
                }

                if (payload.season && payload.episode) {
                    summary.cacheInvalidated = await Cache.invalidateStreamsByEpisode({ imdbId: payload.imdbId, season: payload.season, episode: payload.episode }, 'manual_import');
                } else {
                    summary.cacheInvalidated = await Cache.invalidateStreamsByImdb(payload.imdbId, 'manual_import');
                }
            } else {
                summary.cacheInvalidated = await Cache.invalidateStreamsByHashes([payload.hash], 'manual_import');
            }

            if (payload.service && payload.apiKey && typeof queueCloudBuild === 'function') {
                await queueCloudBuild(payload.service, payload.hash, payload.apiKey);
                summary.cloudBuildQueued = true;
            }

            logger.info('[ADMIN] Manual import completed', {
                hash: payload.hash,
                imdbId: payload.imdbId,
                season: payload.season,
                episode: payload.episode,
                service: payload.service,
                importSource: payload.importSource,
                cloudBuildQueued: summary.cloudBuildQueued,
                packFilesInserted: summary.packFilesInserted
            });

            return res.json({ success: true, payload: {
                ...payload,
                torrentMeta: payload.torrentMeta ? {
                    title: payload.torrentMeta.title,
                    totalSize: payload.torrentMeta.totalSize,
                    files: payload.torrentMeta.files
                } : null
            }, summary });
        } catch (error) {
            logger.error('[ADMIN] Manual import failed', { error: error.message, hash: payload.hash, imdbId: payload.imdbId, importSource: payload.importSource });
            return res.status(500).json({ success: false, error: error.message, payload, summary });
        }
    });
}

module.exports = { registerAdminRoutes };
