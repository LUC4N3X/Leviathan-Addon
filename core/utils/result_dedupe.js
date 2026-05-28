const { annotateResult, compareRankedItems } = require('../lib/result_ranker');
const { incrementMetric } = require('./runtime');
const { extractSeasonEpisodeFromFilename } = require('./episode_parser');
const { parseSize } = require('./result_parsing');
const { extractInfoHash } = require('./torrent');
const {
    REGEX_QUALITY_FILTER,
    getLanguageInfo,
    isSeasonPack,
    parseTitleDetails
} = require('./text');

function getKnownCacheBoolean(item) {
    if (item?._dbCachedRd === true || item?._dbCachedRd === false) return item._dbCachedRd;
    if (item?.cached_rd === true || item?.cached_rd === false) return Boolean(item.cached_rd);
    return undefined;
}

function getKnownCacheState(item) {
    const rawState = typeof item?._rdCacheState === 'string'
        ? item._rdCacheState
        : (typeof item?.rdCacheState === 'string' ? item.rdCacheState : '');
    const normalizedState = rawState.trim().toLowerCase();
    if (normalizedState === 'cached' || normalizedState === 'likely_cached' || normalizedState === 'unknown' || normalizedState === 'probing' || normalizedState === 'likely_uncached' || normalizedState === 'uncached_terminal') {
        return normalizedState;
    }

    const booleanState = getKnownCacheBoolean(item);
    if (booleanState === true) return 'cached';
    if (booleanState === false) return 'likely_uncached';
    return undefined;
}

function normalizeDedupeSourceLabel(value) {
    const text = String(value || '').trim();
    if (!text || /^(unknown|n\/a|null|undefined)$/i.test(text)) return '';
    return text.slice(0, 48);
}

function collectDedupeSourceLabels(...items) {
    const labels = [];
    const seen = new Set();
    const push = (value) => {
        const normalized = normalizeDedupeSourceLabel(value);
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        labels.push(normalized);
    };

    for (const item of items.flat().filter(Boolean)) {
        push(item.source);
        push(item.provider);
        push(item.providerId);
        push(item.sourceName);
        push(item.externalAddon);
        push(item.externalGroup);
        push(item.behaviorHints?.vortexSource);
        push(item.behaviorHints?.vortexMeta?.provider);
        push(item.behaviorHints?.vortexMeta?.source);
        for (const source of Array.isArray(item._dedupeMergedSources) ? item._dedupeMergedSources : []) push(source);
        for (const source of Array.isArray(item._dedupeEvidence?.sources) ? item._dedupeEvidence.sources : []) push(source);
    }

    return labels;
}

function collectDedupeMergedCount(...items) {
    let count = items.flat().filter(Boolean).length;
    for (const item of items.flat().filter(Boolean)) {
        const direct = Number(item?._dedupeMergedCount || item?._dedupeEvidence?.mergedCount || 0);
        if (Number.isFinite(direct) && direct > count) count = direct;
    }
    return Math.max(1, count);
}

function isLocalDbCandidate(item = {}) {
    return Boolean(
        item?._localDb === true ||
        item?._sourceGroup === 'local_db' ||
        item?._dbEpisodeMapping === true ||
        item?._dbLastCachedCheck ||
        item?._dbNextCachedCheck ||
        item?._dbProvider ||
        item?._rdStalePositive === true
    );
}

function getCacheStateRankForDedupe(item = {}) {
    const state = getKnownCacheState(item) || 'unknown';
    if (state === 'cached') return 5;
    if (state === 'likely_cached') return 4;
    if (state === 'probing') return 3;
    if (state === 'unknown') return 2;
    if (state === 'likely_uncached') return 1;
    return 0;
}

function shouldPreferLocalDbDuplicate(candidate, current, meta = {}) {
    const isSeries = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    if (isSeries) return null;
    const candidateDb = isLocalDbCandidate(candidate);
    const currentDb = isLocalDbCandidate(current);
    if (candidateDb === currentDb) return null;

    const dbItem = candidateDb ? candidate : current;
    const otherItem = candidateDb ? current : candidate;
    const dbRank = getCacheStateRankForDedupe(dbItem);
    const otherRank = getCacheStateRankForDedupe(otherItem);
    if (dbRank + 1 < otherRank) return null;

    return candidateDb ? 'candidate' : 'current';
}

function mergeDuplicateSignals(preferredItem, alternateItem) {
    const merged = { ...preferredItem };
    const sourceLabels = collectDedupeSourceLabels(preferredItem, alternateItem);
    const mergedCount = collectDedupeMergedCount(preferredItem, alternateItem);

    if (sourceLabels.length > 0) merged._dedupeMergedSources = sourceLabels;
    if (mergedCount > 1) merged._dedupeMergedCount = mergedCount;
    if (sourceLabels.length > 0 || mergedCount > 1) {
        merged._dedupeEvidence = {
            ...(merged._dedupeEvidence || {}),
            sources: sourceLabels,
            mergedCount
        };
    }

    const mergedCacheState = getKnownCacheState(preferredItem) || getKnownCacheState(alternateItem);
    if (mergedCacheState) {
        merged._rdCacheState = mergedCacheState;
        merged.rdCacheState = mergedCacheState;
        if (mergedCacheState === 'cached' || mergedCacheState === 'uncached_terminal') {
            const cacheBool = mergedCacheState === 'cached';
            merged._dbCachedRd = cacheBool;
            merged.cached_rd = cacheBool;
        }
    }

    if (!merged._dbLastCachedCheck && alternateItem?._dbLastCachedCheck) merged._dbLastCachedCheck = alternateItem._dbLastCachedCheck;
    if (!merged._dbNextCachedCheck && alternateItem?._dbNextCachedCheck) merged._dbNextCachedCheck = alternateItem._dbNextCachedCheck;
    if ((merged._dbFailures === undefined || merged._dbFailures === null) && alternateItem?._dbFailures !== undefined && alternateItem?._dbFailures !== null) {
        merged._dbFailures = alternateItem._dbFailures;
    }

    if ((merged.fileIdx === undefined || merged.fileIdx === null) && alternateItem?.fileIdx !== undefined && alternateItem?.fileIdx !== null) {
        merged.fileIdx = alternateItem.fileIdx;
    }
    if ((!merged._size || merged._size <= 0) && (alternateItem?._size > 0 || alternateItem?.sizeBytes > 0)) {
        merged._size = alternateItem._size || alternateItem.sizeBytes;
    }
    if ((!merged.sizeBytes || merged.sizeBytes <= 0) && (alternateItem?.sizeBytes > 0 || alternateItem?._size > 0)) {
        merged.sizeBytes = alternateItem.sizeBytes || alternateItem._size;
    }
    if (!merged._tbCached && alternateItem?._tbCached) merged._tbCached = true;
    if (!merged._isPack && alternateItem?._isPack) merged._isPack = true;
    if (!merged._localDb && isLocalDbCandidate(alternateItem)) merged._localDb = true;
    if (!merged._sourceGroup && alternateItem?._sourceGroup) merged._sourceGroup = alternateItem._sourceGroup;
    if (!merged._dbProvider && alternateItem?._dbProvider) merged._dbProvider = alternateItem._dbProvider;

    return merged;
}

function deduplicateResults(results, meta = {}, config = {}) {
    const grouped = new Map();

    const normalizeFileIdxValue = (value) => {
        if (value === undefined || value === null || value === '') return null;
        const parsed = parseInt(value, 10);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    };

    const getEpisodeContext = (item) => {
        const directSeason = parseInt(item?.season, 10);
        const directEpisode = parseInt(item?.episode, 10);
        if (Number.isInteger(directSeason) && Number.isInteger(directEpisode) && directEpisode > 0) {
            return { season: directSeason, episode: directEpisode };
        }
        return extractSeasonEpisodeFromFilename(item?.title || '', 1, { anime: Boolean(meta?.kitsu_id || meta?.isAnime) });
    };

    const buildDedupeKey = (hash, item) => {
        const fileIdx = normalizeFileIdxValue(item?.fileIdx);
        if (fileIdx !== null) return `${hash}:${fileIdx}`;
        const ep = getEpisodeContext(item);
        if (ep && Number.isInteger(ep.season) && Number.isInteger(ep.episode)) return `${hash}:s${ep.season}e${ep.episode}`;
        if (item?._isPack || isSeasonPack(item?.title)) return `${hash}:pack`;
        return `${hash}:base`;
    };

    for (const item of results) {
        if (!item?.magnet) continue;
        const rawHash = item.infoHash || item.hash || extractInfoHash(item.magnet);
        const finalHash = rawHash ? rawHash.toUpperCase() : null;
        if (!finalHash || finalHash.length !== 40) continue;

        item.hash = finalHash;
        item.infoHash = finalHash;
        item.fileIdx = normalizeFileIdxValue(item.fileIdx);
        item._size = parseSize(item._size || item.sizeBytes || item.size);
        item.seeders = parseInt(item.seeders, 10) || 0;
        const rankedItem = annotateResult(item, meta, {
            ...config,
            profile: 'dedupe',
            keepByLanguage: false,
            sortMode: 'balanced'
        });
        item._score = rankedItem._score;
        item._reasons = rankedItem._reasons;
        item._rankMeta = rankedItem._rankMeta;
        item._rankProfile = rankedItem._rankProfile;
        item._dedupeScore = rankedItem._score;

        const dedupeKey = buildDedupeKey(finalHash, item);
        const existing = grouped.get(dedupeKey);
        if (!existing) {
            grouped.set(dedupeKey, item);
            continue;
        }

        const localDbPreference = shouldPreferLocalDbDuplicate(item, existing, meta);
        const comparison = compareRankedItems(item, existing, meta, {
            ...config,
            profile: 'dedupe',
            keepByLanguage: false,
            sortMode: 'balanced'
        });
        const winner = localDbPreference === 'candidate' ? item : (localDbPreference === 'current' ? existing : (comparison < 0 ? item : existing));
        const loser = winner === item ? existing : item;
        const mergedWinner = mergeDuplicateSignals(winner, loser);
        mergedWinner._score = winner._score;
        mergedWinner._reasons = winner._reasons;
        mergedWinner._rankMeta = winner._rankMeta;
        mergedWinner._rankProfile = winner._rankProfile;
        mergedWinner._dedupeScore = winner._dedupeScore || winner._score || 0;
        grouped.set(dedupeKey, mergedWinner);
    }
    const deduped = Array.from(grouped.values());
    incrementMetric('dedupe.input', Array.isArray(results) ? results.length : 0);
    incrementMetric('dedupe.output', deduped.length);
    incrementMetric('dedupe.removed', Math.max(0, (Array.isArray(results) ? results.length : 0) - deduped.length));
    return deduped;
}

function filterByQualityLimit(results, limit) {
    if (!limit || limit === 0 || limit === '0') return results;
    const limitNum = parseInt(limit, 10);
    if (Number.isNaN(limitNum)) return results;
    const counts = { '4K': 0, '1080p': 0, '720p': 0, 'SD': 0 };
    const filtered = [];
    for (const item of results) {
        const t = (item.title || '').toLowerCase();
        let q = 'SD';
        if (REGEX_QUALITY_FILTER['4K'].test(t)) q = '4K';
        else if (REGEX_QUALITY_FILTER['1080p'].test(t)) q = '1080p';
        else if (REGEX_QUALITY_FILTER['720p'].test(t)) q = '720p';
        if (counts[q] < limitNum) {
            filtered.push(item);
            counts[q] += 1;
        }
    }
    return filtered;
}

function isSafeForItalian(item) {
    if (!item || !item.title) return false;
    const parsedInfo = parseTitleDetails(item.title);
    const langInfo = getLanguageInfo(item.title, null, item.source || item.provider || null, parsedInfo);
    return !!(langInfo.isItalian || (langInfo.confidence || 0) >= 4 || langInfo.isMaybeItalian);
}

module.exports = {
    deduplicateResults,
    filterByQualityLimit,
    isSafeForItalian
};
