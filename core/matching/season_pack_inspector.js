'use strict';

const { hasEpisodeMarker, hasSeasonOnlyMarker, normalizeForMatch } = require('./series_title_matcher');
const { hasWrongExplicitEpisodeMarker } = require('./episode_matcher');

const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i;

function isVideoFilePath(value) {
    return VIDEO_EXTENSIONS.test(String(value || ''));
}

function cleanFilePath(value) {
    const cleaned = String(value || '').replace(/^\/+/, '');
    return cleaned || '';
}

function baseName(value) {
    const cleaned = cleanFilePath(value);
    return cleaned.includes('/') ? cleaned.split('/').pop() : cleaned;
}

function parseFileIndex(file = {}) {
    const raw = file.id ?? file.file_id ?? file.file_index ?? file.fileIdx ?? file.index;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseFileSize(file = {}) {
    const raw = file.bytes ?? file.size ?? file.file_size ?? file.filesize;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}


function parseSizeBytes(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const text = String(value || '').trim();
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB)\b/i);
    if (!match) return 0;
    const amount = Number(String(match[1]).replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const unit = match[2].toUpperCase();
    const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
    return Math.round(amount * Math.pow(1024, powers[unit] || 0));
}

function getItemFileSizeBytes(item = {}) {
    const values = [item._size, item.sizeBytes, item.fileSize, item.file_size, item.mainFileSize, item.size, item.behaviorHints?.videoSize];
    for (const value of values) {
        const parsed = parseSizeBytes(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
}

function getItemFolderSizeBytes(item = {}) {
    const values = [item.folderSize, item.folder_size, item.totalPackSize, item.packSize, item.behaviorHints?.folderSize, item.behaviorHints?.folder_size];
    for (const value of values) {
        const parsed = parseSizeBytes(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
}

function hasFolderSizeSeasonPackSignal(item = {}) {
    const fileSize = getItemFileSizeBytes(item);
    const folderSize = getItemFolderSizeBytes(item);
    if (!(fileSize > 0 && folderSize > 0)) return false;
    if (folderSize <= fileSize) return false;
    const ratio = folderSize / fileSize;
    const absoluteDelta = folderSize - fileSize;
    return ratio >= 2 || absoluteDelta >= 900 * 1024 * 1024;
}

function normalizeVideoFiles(files) {
    return (Array.isArray(files) ? files : [])
        .map((file) => {
            const path = cleanFilePath(file?.path || file?.name || file?.file_path || file?.file_title || '');
            const name = baseName(path || file?.name || file?.file_title || '');
            return {
                raw: file,
                fileIndex: parseFileIndex(file),
                fileName: name,
                filePath: path,
                fileSize: parseFileSize(file)
            };
        })
        .filter((file) => file.filePath || file.fileName)
        .filter((file) => isVideoFilePath(file.filePath || file.fileName) || file.fileSize > 25 * 1024 * 1024);
}

function hasEpisodeOnlyMarker(value, episode) {
    const ep = Number(episode);
    if (!Number.isFinite(ep) || ep <= 0) return false;
    return new RegExp(`\\b(?:ep|episode|episodio|e)\\.?[\\W_]*0*${ep}(?!\\d)`, 'i').test(String(value || ''));
}

function hasSeasonFolderCue(value, season) {
    return hasSeasonOnlyMarker(value, season)
        || new RegExp(`(?:^|[\\/\\s._-])0*${Number(season)}(?:[\\/\\s._-]|$)`, 'i').test(String(value || ''));
}

function isExplicitRequestedFile(file, requestedFileIdx) {
    if (!Number.isInteger(requestedFileIdx) || requestedFileIdx < 0) return false;
    return file.fileIndex === requestedFileIdx;
}

function scoreFileForEpisode(file, ctx = {}) {
    const season = Number(ctx.season || 0) || 1;
    const episode = Number(ctx.episode || 0);
    if (!Number.isFinite(episode) || episode <= 0) return null;

    const text = [file.filePath, file.fileName].filter(Boolean).join(' ');
    if (isExplicitRequestedFile(file, ctx.fileIdx)) {
        return { score: 120, reason: 'explicit_file_index' };
    }

    if (hasWrongExplicitEpisodeMarker(text, { season, episode })) return null;

    if (hasEpisodeMarker(text, season, episode)) {
        return { score: 110, reason: 'exact_sxxexx' };
    }

    if (hasEpisodeOnlyMarker(text, episode) && hasSeasonFolderCue(file.filePath, season)) {
        return { score: 90, reason: 'episode_marker_with_season_folder' };
    }

    if (hasEpisodeOnlyMarker(text, episode) && ctx.allowEpisodeOnly === true) {
        return { score: 72, reason: 'episode_marker_only' };
    }

    return null;
}

function findEpisodeFileHint(files, context = {}) {
    const season = Number(context.season || context._probeSeason || 0) || 1;
    const episode = Number(context.episode || context._probeEpisode || 0);
    if (!Number.isFinite(episode) || episode <= 0) return null;

    const requestedFileIdxRaw = context.fileIdx ?? context.file_index ?? context.rd_file_index;
    const requestedFileIdx = Number.isInteger(Number(requestedFileIdxRaw)) && Number(requestedFileIdxRaw) >= 0
        ? Number(requestedFileIdxRaw)
        : null;

    const videoFiles = normalizeVideoFiles(files);
    if (videoFiles.length === 0) return null;

    const ctx = {
        season,
        episode,
        fileIdx: requestedFileIdx,
        allowEpisodeOnly: Boolean(context.allowEpisodeOnly || context.kitsu_id || context.isAnime)
    };

    const candidates = [];
    for (const file of videoFiles) {
        const scored = scoreFileForEpisode(file, ctx);
        if (!scored) continue;
        const seasonFolderBonus = hasSeasonFolderCue(file.filePath, season) ? 8 : 0;
        const sizeBonus = Math.min(8, Math.floor(Math.log10(Math.max(file.fileSize, 1))));
        const normalizedTitle = normalizeForMatch(context.title || context.seriesTitle || context.metaTitle || '');
        const normalizedPath = normalizeForMatch(file.filePath || file.fileName || '');
        const titleBonus = normalizedTitle && normalizedPath.includes(normalizedTitle) ? 4 : 0;
        candidates.push({
            ...file,
            confidence: Math.min(1, (scored.score + seasonFolderBonus + sizeBonus + titleBonus) / 130),
            score: scored.score + seasonFolderBonus + sizeBonus + titleBonus,
            reason: scored.reason
        });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score || b.fileSize - a.fileSize || (a.fileIndex ?? 999999) - (b.fileIndex ?? 999999));
    const best = candidates[0];

    return {
        fileIndex: best.fileIndex,
        fileIdx: best.fileIndex,
        fileName: best.fileName,
        filePath: best.filePath,
        fileSize: best.fileSize,
        season,
        episode,
        confidence: Number(best.confidence.toFixed(3)),
        reason: best.reason
    };
}

function isLikelySeasonPackTitle(value, season) {
    const text = String(value || '');
    return hasSeasonOnlyMarker(text, season)
        || /\b(?:pack|batch|complete|completa|integrale|collection|raccolta)\b/i.test(text);
}

module.exports = {
    VIDEO_EXTENSIONS,
    parseSizeBytes,
    getItemFileSizeBytes,
    getItemFolderSizeBytes,
    hasFolderSizeSeasonPackSignal,
    cleanFilePath,
    normalizeVideoFiles,
    findEpisodeFileHint,
    isLikelySeasonPackTitle
};
