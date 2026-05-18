'use strict';

function normalizeHash(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const btih = raw.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    const candidate = btih ? btih[1] : raw;
    if (/^[A-Fa-f0-9]{40}$/.test(candidate) || /^[A-Za-z2-7]{32}$/.test(candidate)) return candidate.toUpperCase();
    return null;
}

function normalizeFileIndex(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function getCandidateHash(item = {}) {
    return normalizeHash(item.hash || item.infoHash || item.info_hash || item.magnet || item.magnetLink || item.url || item.directUrl);
}

function getEpisodeIdentity(meta = {}) {
    const imdbId = String(meta.imdb_id || meta.imdbId || '').trim();
    const season = Number(meta.season ?? meta.imdb_season ?? 0);
    const episode = Number(meta.episode ?? meta.imdb_episode ?? 0);
    const isEpisode = Boolean(imdbId && Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0);
    return { imdbId, season, episode, isEpisode };
}

function getSizeBytes(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
    }
    return 0;
}

function makeHint(row = {}) {
    const fileIdx = normalizeFileIndex(row.file_index ?? row.fileIdx ?? row.fileIndex);
    if (fileIdx === null) return null;
    return {
        fileIdx,
        fileIndex: fileIdx,
        fileName: row.file_title || row.file_path || row.title || null,
        filePath: row.file_path || null,
        fileSize: getSizeBytes(row.file_size, row.size),
        source: row.source || 'torrent_info_ledger',
        confidence: Number(row.confidence || 1) || 1,
        reason: row.reason || 'ledger_file_index_learning'
    };
}

async function hydrateCandidatesWithLedger(items, meta = {}, deps = {}) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return list;

    const { dbHelper, logger, rememberValidatedFileSet } = deps;
    if (!dbHelper || typeof dbHelper.getEpisodePackFileHintsByHashes !== 'function') return list;

    const identity = getEpisodeIdentity(meta);
    if (!identity.isEpisode) return list;

    const hashes = [...new Set(list.map(getCandidateHash).filter(Boolean))];
    if (hashes.length === 0) return list;

    let hints = [];
    try {
        hints = await dbHelper.getEpisodePackFileHintsByHashes(hashes, {
            imdb_id: identity.imdbId,
            season: identity.season,
            episode: identity.episode
        });
    } catch (error) {
        try { logger?.warn?.(`[TORRENT LEDGER] hydrate failed | imdb=${identity.imdbId} S${identity.season}E${identity.episode} | error=${error.message}`); } catch (_) {}
        return list;
    }

    if (!Array.isArray(hints) || hints.length === 0) return list;

    const bestByHash = new Map();
    for (const row of hints) {
        const hash = normalizeHash(row.hash || row.info_hash || row.pack_hash);
        const hint = makeHint(row);
        if (!hash || !hint) continue;
        const existing = bestByHash.get(hash);
        if (!existing || hint.confidence > existing.confidence || hint.fileSize > existing.fileSize) bestByHash.set(hash, hint);
    }
    if (bestByHash.size === 0) return list;

    let applied = 0;
    const hydrated = list.map((item) => {
        if (!item) return item;
        const hash = getCandidateHash(item);
        const hint = hash ? bestByHash.get(hash) : null;
        if (!hint) return item;

        const currentFileIdx = normalizeFileIndex(item.fileIdx ?? item.fileIndex ?? item.file_index);
        if (currentFileIdx === null) {
            item.fileIdx = hint.fileIdx;
            item.fileIndex = hint.fileIdx;
            item.file_index = hint.fileIdx;
            applied += 1;
        }

        item.episodeFileHint = item.episodeFileHint || hint;
        item._episodeFileHint = item._episodeFileHint || hint;
        item._packValidated = true;
        item._ledgerFileIndexLearned = true;
        item._ledgerHintReason = hint.reason;

        if (typeof rememberValidatedFileSet === 'function') {
            try {
                rememberValidatedFileSet(item, meta, {
                    title: hint.fileName || item.title,
                    titleSource: hint.source || 'torrent_info_ledger',
                    packName: item.packTitle || item.title || null,
                    files: [],
                    raw: {
                        title: hint.fileName || item.title,
                        filename: hint.fileName || null,
                        fileIndex: hint.fileIdx,
                        fileIdx: hint.fileIdx,
                        fileName: hint.fileName || null,
                        fileSize: hint.fileSize || null,
                        source: hint.source || 'torrent_info_ledger'
                    }
                });
            } catch (_) {}
        }

        return item;
    });

    if (applied > 0) {
        try { logger?.info?.(`[TORRENT LEDGER] fileIdx learned | imdb=${identity.imdbId} S${identity.season}E${identity.episode} | applied=${applied}/${list.length} | hints=${bestByHash.size}`); } catch (_) {}
    }

    return hydrated;
}

async function recordResolvedFileIndex({ meta = {}, item = {}, streamData = {}, service = 'rd', dbHelper, logger, reason = 'playback_resolve' } = {}) {
    if (!dbHelper || !item) return false;
    const identity = getEpisodeIdentity(meta);
    if (!identity.isEpisode) return false;

    const hash = getCandidateHash(item) || normalizeHash(streamData.hash || streamData.infoHash || streamData.info_hash);
    if (!hash) return false;

    const resolvedFileIndex = normalizeFileIndex(
        streamData.rd_file_index ??
        streamData.tb_file_id ??
        streamData.file_id ??
        streamData.file_index ??
        streamData.fileIdx ??
        item.fileIdx ??
        item.fileIndex ??
        item.file_index
    );
    if (resolvedFileIndex === null) return false;

    const resolvedSize = getSizeBytes(
        streamData.rd_file_size,
        streamData.tb_file_size,
        streamData.file_size,
        streamData.filesize,
        streamData.size,
        item.sizeBytes,
        item._size,
        item.size
    );
    const title = streamData.filename || item.filename || item.file_title || item.title || null;
    const normalizedService = String(service || 'rd').toLowerCase() === 'tb' ? 'tb' : 'rd';

    try {
        if (normalizedService === 'tb' && typeof dbHelper.updateTbCacheStatus === 'function') {
            await dbHelper.updateTbCacheStatus([{
                hash,
                cached: true,
                tb_file_id: resolvedFileIndex,
                tb_file_size: resolvedSize || null,
                title,
                imdb_id: identity.imdbId,
                imdb_season: identity.season,
                imdb_episode: identity.episode
            }]);
        } else if (typeof dbHelper.updateRdCacheStatus === 'function') {
            await dbHelper.updateRdCacheStatus([{
                hash,
                cached: true,
                state: 'cached',
                rd_file_index: resolvedFileIndex,
                rd_file_size: resolvedSize || null,
                title,
                failures: 0,
                next_hours: 168,
                imdb_id: identity.imdbId,
                imdb_season: identity.season,
                imdb_episode: identity.episode
            }]);
        }

        if (typeof dbHelper.insertPackFiles === 'function') {
            await dbHelper.insertPackFiles([{
                info_hash: hash,
                file_index: resolvedFileIndex,
                file_path: title,
                file_title: title,
                file_size: resolvedSize || 0,
                imdb_id: identity.imdbId,
                imdb_season: identity.season,
                imdb_episode: identity.episode
            }]);
        }

        try { logger?.info?.(`[TORRENT LEDGER] learned playback fileIdx | service=${normalizedService.toUpperCase()} hash=${hash.slice(0, 12)} idx=${resolvedFileIndex} imdb=${identity.imdbId} S${identity.season}E${identity.episode} reason=${reason}`); } catch (_) {}
        return true;
    } catch (error) {
        try { logger?.warn?.(`[TORRENT LEDGER] record failed | hash=${hash.slice(0, 12)} | error=${error.message}`); } catch (_) {}
        return false;
    }
}

module.exports = {
    normalizeHash,
    normalizeFileIndex,
    getCandidateHash,
    hydrateCandidatesWithLedger,
    recordResolvedFileIndex
};
