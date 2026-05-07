'use strict';

const { hasEpisodeMarker, hasSeasonOnlyMarker } = require('../matching/series_title_matcher');
const { hasWrongExplicitEpisodeMarker } = require('../matching/episode_matcher');
const { findEpisodeFileHint } = require('../matching/season_pack_inspector');

function isSeriesMeta(meta = {}) {
    return Boolean(
        meta?.isSeries ||
        String(meta?.type || meta?.contentType || '').toLowerCase() === 'series' ||
        Number(meta?.season || meta?.imdb_season || 0) > 0 ||
        Number(meta?.episode || meta?.imdb_episode || 0) > 0
    );
}

function getRequestedEpisode(meta = {}, item = {}) {
    const season = Number(meta?.season ?? meta?.imdb_season ?? item?.imdb_season ?? item?.season ?? item?._probeSeason ?? 0);
    const episode = Number(meta?.episode ?? meta?.imdb_episode ?? item?.imdb_episode ?? item?.episode ?? item?._probeEpisode ?? 0);
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0) return null;
    return { season, episode };
}

function parseFileIdx(item = {}) {
    const raw = item?.fileIdx ?? item?.file_index ?? item?.rd_file_index ?? item?.tb_file_id ?? item?.episodeFileHint?.fileIndex ?? item?._episodeFileHint?.fileIndex;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function cleanText(value) {
    return String(value || '').replace(/^\/+/, '').trim();
}

function basename(value) {
    const cleaned = cleanText(value);
    return cleaned.includes('/') ? cleaned.split('/').pop() : cleaned;
}

function unique(values) {
    return [...new Set(values.map(cleanText).filter(Boolean))];
}

function getStrongFileTexts(item = {}) {
    const hint = item?.episodeFileHint || item?._episodeFileHint || {};
    const behavior = item?.behaviorHints || {};
    return unique([
        hint.fileName,
        hint.filePath,
        behavior.filename,
        behavior.fileName,
        behavior.videoHashFilename,
        item?.filename,
        item?.fileName,
        item?.file_title,
        item?.file_path,
        item?.matched_file_title,
        item?.matched_file_path,
        item?.resolvedFilename,
        item?.rd_filename,
        item?.tb_filename
    ].flatMap((value) => [value, basename(value)]));
}

function getWeakTitleTexts(item = {}) {
    return unique([
        item?.title,
        item?.rawTitle,
        item?.name,
        item?.torrent_title,
        item?.packTitle,
        item?.original_filename,
        item?.metaTitle,
        item?.seriesTitle
    ].flatMap((value) => [value, basename(value)]));
}

function proofFromHintObject(item = {}, requested = null) {
    const hint = item?.episodeFileHint || item?._episodeFileHint;
    if (!hint || typeof hint !== 'object') return null;

    const fileIdx = Number(hint.fileIndex ?? hint.fileIdx ?? hint.file_index);
    if (!Number.isInteger(fileIdx) || fileIdx < 0) return null;

    if (requested) {
        const hintSeason = Number(hint.season || 0);
        const hintEpisode = Number(hint.episode || 0);
        if (hintSeason > 0 && hintEpisode > 0) {
            if (hintSeason !== requested.season || hintEpisode !== requested.episode) return null;
            return {
                exact: true,
                source: hint.source || 'episode_file_hint_identity',
                fileIdx,
                fileName: hint.fileName || basename(hint.filePath),
                filePath: hint.filePath || hint.fileName || null,
                confidence: Number(hint.confidence || 1),
                reason: hint.reason || 'hint_identity'
            };
        }
    }

    const texts = unique([hint.fileName, hint.filePath, basename(hint.filePath)]);
    const markerProof = proofFromTexts(texts, requested, fileIdx, { source: hint.source || 'episode_file_hint_marker' });
    if (markerProof) return markerProof;

    if (item?._episodeExact === true || item?._rdEpisodeExact === true || item?._dbEpisodeExact === true) {
        return {
            exact: true,
            source: hint.source || 'trusted_episode_file_hint',
            fileIdx,
            fileName: hint.fileName || basename(hint.filePath),
            filePath: hint.filePath || hint.fileName || null,
            confidence: Number(hint.confidence || 0.99),
            reason: hint.reason || 'trusted_hint'
        };
    }

    return null;
}

function proofFromTexts(texts, requested, fileIdx, options = {}) {
    if (!requested || !Number.isInteger(fileIdx) || fileIdx < 0) return null;
    const strongTexts = unique(texts);
    if (strongTexts.length === 0) return null;

    const ctx = { season: requested.season, episode: requested.episode };
    for (const text of strongTexts) {
        if (!text) continue;
        if (hasWrongExplicitEpisodeMarker(text, ctx)) continue;
        if (hasEpisodeMarker(text, requested.season, requested.episode)) {
            return {
                exact: true,
                source: options.source || 'filename_episode_marker',
                fileIdx,
                fileName: basename(text),
                filePath: text,
                confidence: 0.98,
                reason: 'filename_exact_episode_marker'
            };
        }
    }

    return null;
}

function deriveEpisodeProof(item = {}, meta = {}) {
    if (!isSeriesMeta(meta)) return null;
    const requested = getRequestedEpisode(meta, item);
    if (!requested) return null;
    const fileIdx = parseFileIdx(item);
    if (!Number.isInteger(fileIdx) || fileIdx < 0) return null;

    const trustedFlag = item?._episodeExact === true || item?._rdEpisodeExact === true || item?._dbEpisodeExact === true || item?._packEpisodeExact === true;
    if (item?._rdEpisodeProof?.exact === true || item?.rdEpisodeProof?.exact === true) {
        const proof = item._rdEpisodeProof || item.rdEpisodeProof;
        const proofIdx = Number(proof.fileIdx ?? proof.fileIndex ?? fileIdx);
        if (Number.isInteger(proofIdx) && proofIdx === fileIdx) {
            return { ...proof, exact: true, fileIdx: proofIdx };
        }
    }

    const hintProof = proofFromHintObject(item, requested);
    if (hintProof) return hintProof;

    const strongTextProof = proofFromTexts(getStrongFileTexts(item), requested, fileIdx, { source: 'strong_filename_marker' });
    if (strongTextProof) return strongTextProof;

    // DB/file mapping rows are already scoped to imdb:s:e. They are stronger than a raw fileIdx.
    if (trustedFlag && (item?.matched_file_title || item?.matched_file_index !== undefined || item?._dbEpisodeMapping === true)) {
        return {
            exact: true,
            source: item?._episodeProofSource || 'db_episode_mapping',
            fileIdx,
            fileName: item?.matched_file_title || item?.file_title || item?.filename || null,
            filePath: item?.matched_file_path || item?.file_path || null,
            confidence: 1,
            reason: 'db_imdb_season_episode_mapping'
        };
    }

    // Single-video RD probes are safe enough only when there is no explicit wrong episode marker.
    if ((item?._singleVideoProbe === true || item?._singleVideo === true) && trustedFlag) {
        const weakTexts = unique([...getStrongFileTexts(item), ...getWeakTitleTexts(item)]);
        const hasWrong = weakTexts.some((text) => hasWrongExplicitEpisodeMarker(text, requested));
        if (!hasWrong) {
            return {
                exact: true,
                source: item?._episodeProofSource || 'single_video_probe',
                fileIdx,
                fileName: basename(weakTexts[0] || ''),
                filePath: weakTexts[0] || null,
                confidence: 0.9,
                reason: 'single_video_no_wrong_episode_marker'
            };
        }
    }

    return null;
}

function hasExactEpisodeProof(item = {}, meta = {}) {
    return Boolean(deriveEpisodeProof(item, meta));
}

function applyEpisodePrecisionToItem(item = {}, meta = {}) {
    if (!item || !isSeriesMeta(meta)) return item;
    const proof = deriveEpisodeProof(item, meta);
    if (!proof) return item;

    item._episodeExact = true;
    item._rdEpisodeExact = true;
    item._rdEpisodeProof = proof;
    item.rdEpisodeProof = proof;
    if (Number.isInteger(proof.fileIdx) && proof.fileIdx >= 0) item.fileIdx = proof.fileIdx;
    if (!item.episodeFileHint) {
        item.episodeFileHint = {
            fileIndex: proof.fileIdx,
            fileIdx: proof.fileIdx,
            fileName: proof.fileName || null,
            filePath: proof.filePath || null,
            season: getRequestedEpisode(meta, item)?.season,
            episode: getRequestedEpisode(meta, item)?.episode,
            confidence: proof.confidence,
            reason: proof.reason,
            source: proof.source
        };
        item._episodeFileHint = item.episodeFileHint;
    }
    return item;
}

function inferEpisodeHintFromPackFiles(files = [], meta = {}, extra = {}) {
    const requested = getRequestedEpisode(meta, extra);
    if (!requested) return null;
    const hint = findEpisodeFileHint(files, {
        ...extra,
        ...meta,
        season: requested.season,
        episode: requested.episode,
        title: meta?.title || meta?.name || extra?.title || extra?.seriesTitle || '',
        seriesTitle: meta?.title || meta?.name || extra?.seriesTitle || '',
        metaTitle: meta?.title || meta?.name || extra?.metaTitle || '',
        isAnime: Boolean(meta?.isAnime || meta?.kitsu_id || extra?.isAnime),
        kitsu_id: meta?.kitsu_id || extra?.kitsu_id
    });
    if (!hint || !Number.isInteger(Number(hint.fileIndex)) || Number(hint.fileIndex) < 0) return null;
    return {
        ...hint,
        exact: true,
        source: 'pack_files_filename_inferred'
    };
}

module.exports = {
    isSeriesMeta,
    getRequestedEpisode,
    parseFileIdx,
    getStrongFileTexts,
    deriveEpisodeProof,
    hasExactEpisodeProof,
    applyEpisodePrecisionToItem,
    inferEpisodeHintFromPackFiles
};
