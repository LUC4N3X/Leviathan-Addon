'use strict';

const {
    buildSeriesContext,
    hasWrongExplicitEpisodeMarker,
    matchesCandidateTitle,
    parseSeasonEpisode
} = require('./episode_matcher');
const {
    getCandidateValues,
    hasEpisodeMarker,
    hasSeasonOnlyMarker,
    normalizeForMatch
} = require('./series_title_matcher');
const {
    findEpisodeFileHint,
    hasFolderSizeSeasonPackSignal,
    isLikelySeasonPackTitle
} = require('./season_pack_inspector');

function positiveInt(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function clampConfidence(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(1, parsed));
}

function unique(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text) continue;
        const key = normalizeForMatch(text);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function collectCandidateText(candidate = {}) {
    const values = getCandidateValues(candidate);
    const behaviorHints = candidate?.behaviorHints || {};
    values.push(
        candidate.filename,
        candidate.fileName,
        candidate.filePath,
        candidate.path,
        candidate.url,
        behaviorHints.filename,
        behaviorHints.videoHash,
        behaviorHints.bingeGroup,
        behaviorHints.vortexMeta?.title,
        behaviorHints.vortexMeta?.filename
    );

    if (Array.isArray(behaviorHints.files)) {
        for (const file of behaviorHints.files.slice(0, 12)) {
            values.push(file?.path, file?.name, file?.file_title);
        }
    }

    return unique(values);
}

function extractRequestedContext(input = {}) {
    const meta = input.meta || input.context || input;
    const parsed = parseSeasonEpisode(meta.search || meta.query || meta.title || meta.name || '');
    const season = positiveInt(meta.season, meta.s, meta._probeSeason, meta.requestedSeason, parsed.season) || null;
    const episode = positiveInt(meta.episode, meta.e, meta._probeEpisode, meta.requestedEpisode, parsed.episode) || null;
    const isSeries = Boolean(meta.isSeries || meta.type === 'series' || season || episode);
    const isAnime = Boolean(meta.isAnime || meta.kitsu_id || meta.kitsuId || String(meta.type || '').toLowerCase() === 'anime');
    const title = meta.cinemetaTitle || meta.title || meta.name || meta.seriesTitle || '';
    const aliases = unique([meta.aliases, meta.altTitles, meta.alternativeTitles].flat(Infinity).filter(Boolean));

    return {
        title,
        aliases,
        season,
        episode,
        isSeries,
        isAnime,
        fileIdx: meta.fileIdx ?? meta.file_index ?? meta.rd_file_index ?? null
    };
}

function detectExplicitEpisode(candidateTexts = [], requested = {}) {
    const season = requested.season || 1;
    const episode = requested.episode;
    if (!episode) return null;

    for (const text of candidateTexts) {
        if (hasEpisodeMarker(text, season, episode)) return { text, season, episode, reason: 'explicit_episode_marker' };
    }

    return null;
}

function detectSeasonPack(candidate = {}, candidateTexts = [], requested = {}) {
    const season = requested.season || 1;
    if (!season) return null;

    for (const text of candidateTexts) {
        if (hasSeasonOnlyMarker(text, season) || isLikelySeasonPackTitle(text, season)) {
            return { text, season, reason: 'season_pack_marker' };
        }
    }

    if (hasFolderSizeSeasonPackSignal(candidate)) {
        return { text: candidate.title || candidate.name || '', season, reason: 'folder_size_pack_signal' };
    }

    return null;
}

function buildDecision({ ok, type, confidence, requested, detected = {}, reasons = [], penalties = [], evidence = {}, fileHint = null }) {
    return {
        ok: Boolean(ok),
        type,
        confidence: Number(clampConfidence(confidence).toFixed(3)),
        requested: {
            title: requested.title || '',
            season: requested.season || null,
            episode: requested.episode || null,
            isAnime: Boolean(requested.isAnime)
        },
        detected,
        reasons,
        penalties,
        evidence,
        fileHint
    };
}

function evaluateEpisodeTruth(candidate = {}, contextInput = {}, options = {}) {
    const requested = extractRequestedContext(contextInput);
    const reasons = [];
    const penalties = [];
    const candidateTexts = collectCandidateText(candidate);

    if (!requested.isSeries || !requested.episode) {
        return buildDecision({
            ok: true,
            type: 'not_required',
            confidence: 0.7,
            requested,
            reasons: ['movie_or_episode_not_requested'],
            evidence: { checkedTexts: candidateTexts.slice(0, 6) }
        });
    }

    const seriesCtx = buildSeriesContext({
        cinemetaTitle: requested.title,
        aliases: requested.aliases,
        season: requested.season,
        episode: requested.episode,
        search: `${requested.title || ''} S${String(requested.season || 1).padStart(2, '0')}E${String(requested.episode).padStart(2, '0')}`
    });

    const titleOk = matchesCandidateTitle(candidate, seriesCtx, { allowSeasonPack: true });
    if (titleOk) reasons.push('title_match_or_unchecked');
    else penalties.push('title_mismatch');

    const files = candidate.files || candidate.behaviorHints?.files || candidate.fileList || [];
    const fileHint = findEpisodeFileHint(files, {
        title: requested.title,
        season: requested.season,
        episode: requested.episode,
        fileIdx: requested.fileIdx,
        allowEpisodeOnly: requested.isAnime || options.allowEpisodeOnly === true,
        isAnime: requested.isAnime
    });
    if (fileHint && titleOk) {
        return buildDecision({
            ok: true,
            type: 'season_pack_file_match',
            confidence: Math.max(0.86, fileHint.confidence || 0),
            requested,
            detected: { season: fileHint.season, episode: fileHint.episode, fileIdx: fileHint.fileIdx },
            reasons: [...reasons, 'episode_file_hint', fileHint.reason].filter(Boolean),
            penalties,
            evidence: { text: fileHint.filePath || fileHint.fileName, checkedTexts: candidateTexts.slice(0, 6) },
            fileHint
        });
    }

    const wrongMarkerText = candidateTexts.find((text) => hasWrongExplicitEpisodeMarker(text, seriesCtx));
    if (wrongMarkerText) {
        return buildDecision({
            ok: false,
            type: 'episode_mismatch_risk',
            confidence: 0.15,
            requested,
            detected: parseSeasonEpisode(wrongMarkerText),
            reasons,
            penalties: [...penalties, 'wrong_explicit_episode_marker_detected'],
            evidence: { text: wrongMarkerText, checkedTexts: candidateTexts.slice(0, 6) }
        });
    }

    const exact = detectExplicitEpisode(candidateTexts, requested);
    if (exact && titleOk) {
        return buildDecision({
            ok: true,
            type: 'exact_episode',
            confidence: 0.96,
            requested,
            detected: { season: exact.season, episode: exact.episode },
            reasons: [...reasons, exact.reason],
            penalties,
            evidence: { text: exact.text, checkedTexts: candidateTexts.slice(0, 6) }
        });
    }

    const pack = detectSeasonPack(candidate, candidateTexts, requested);
    if (pack && titleOk) {
        return buildDecision({
            ok: true,
            type: 'season_pack_candidate',
            confidence: 0.78,
            requested,
            detected: { season: pack.season },
            reasons: [...reasons, pack.reason],
            penalties,
            evidence: { text: pack.text, checkedTexts: candidateTexts.slice(0, 6) }
        });
    }

    if (requested.isAnime && exact) {
        return buildDecision({
            ok: true,
            type: 'anime_absolute_episode',
            confidence: titleOk ? 0.82 : 0.62,
            requested,
            detected: { episode: exact.episode },
            reasons: [...reasons, 'anime_episode_marker'],
            penalties,
            evidence: { text: exact.text, checkedTexts: candidateTexts.slice(0, 6) }
        });
    }

    return buildDecision({
        ok: options.strict === true ? false : titleOk,
        type: titleOk ? 'episode_uncertain' : 'title_or_episode_uncertain',
        confidence: titleOk ? 0.52 : 0.28,
        requested,
        reasons: titleOk ? [...reasons, 'no_explicit_episode_proof'] : reasons,
        penalties: titleOk ? [...penalties, 'episode_proof_missing'] : [...penalties, 'title_mismatch', 'episode_proof_missing'],
        evidence: { checkedTexts: candidateTexts.slice(0, 6) }
    });
}

function annotateEpisodeTruth(item = {}, context = {}, options = {}) {
    const truth = evaluateEpisodeTruth(item, context, options);
    return {
        ...item,
        _episodeTruth: truth,
        _episodeTruthType: truth.type,
        _episodeTruthConfidence: truth.confidence,
        _episodeTruthOk: truth.ok
    };
}

function applyEpisodeTruthToList(items = [], context = {}, options = {}) {
    const annotated = (Array.isArray(items) ? items : []).map((item) => annotateEpisodeTruth(item, context, options));
    if (options.rejectUnsafe !== true) return annotated;
    return annotated.filter((item) => item._episodeTruthOk !== false);
}

function formatEpisodeTruthLog(truth = {}) {
    const req = truth.requested || {};
    const state = truth.ok ? 'accept' : 'reject';
    const requested = req.episode ? `S${String(req.season || 1).padStart(2, '0')}E${String(req.episode).padStart(2, '0')}` : 'movie';
    const reason = [...(truth.reasons || []), ...(truth.penalties || [])][0] || truth.type || 'unknown';
    return `[EPISODE TRUTH] ${state} ${truth.type || 'unknown'} | title="${req.title || ''}" requested=${requested} confidence=${truth.confidence ?? 0} reason=${reason}`;
}

module.exports = {
    applyEpisodeTruthToList,
    annotateEpisodeTruth,
    collectCandidateText,
    evaluateEpisodeTruth,
    extractRequestedContext,
    formatEpisodeTruthLog
};
