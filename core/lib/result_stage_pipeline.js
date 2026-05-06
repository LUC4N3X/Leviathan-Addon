'use strict';

function getTitleText(item) {
    return String(item?.title || item?.name || '').trim();
}

function detectQualityTier(item) {
    const title = getTitleText(item).toLowerCase();
    const details = item?._releaseDetails || {};
    const codec = String(details.videoCodec || '').toLowerCase();

    if (/remux|bdremux|bluray\s*remux/.test(title)) return 5;
    if (/blu\s*-?ray|bdrip|bdmux/.test(title)) return 4;
    if (/web\s*-?dl|webrip|webcap/.test(title)) return 3;
    if (/hdtv|hdrip|dvdrip/.test(title)) return 2;
    if (/cam|hdcam|ts|telesync|telecine|scr(eener)?/.test(title)) return 0;
    if (codec === 'hevc' || codec === 'h265') return 3;
    return 1;
}

function detectResolutionTier(item) {
    const quality = String(item?._releaseDetails?.quality || '').toLowerCase();
    const title = getTitleText(item).toLowerCase();
    if (quality.includes('4k') || quality.includes('2160') || /2160p|\b4k\b|\buhd\b/.test(title)) return 4;
    if (quality.includes('1080') || /1080p|\bfhd\b/.test(title)) return 3;
    if (quality.includes('720') || /720p/.test(title)) return 2;
    if (quality.includes('480') || /480p|576p/.test(title)) return 1;
    return 0;
}

function detectCachedTier(item) {
    if (item?._dbCachedRd === true || item?.cached_rd === true || item?._tbCached === true) return 2;
    if (String(item?._rdCacheState || item?.rdCacheState || '').toLowerCase() === 'likely_cached') return 1;
    return 0;
}

function compareFallbackBuckets(left, right) {
    const qualityDelta = detectQualityTier(right) - detectQualityTier(left);
    if (qualityDelta !== 0) return qualityDelta;

    const resolutionDelta = detectResolutionTier(right) - detectResolutionTier(left);
    if (resolutionDelta !== 0) return resolutionDelta;

    const cachedDelta = detectCachedTier(right) - detectCachedTier(left);
    if (cachedDelta !== 0) return cachedDelta;

    const seedDelta = (Number(right?.seeders || 0) || 0) - (Number(left?.seeders || 0) || 0);
    if (seedDelta !== 0) return seedDelta;

    const sizeDelta = (Number(right?._size || right?.sizeBytes || 0) || 0) - (Number(left?._size || left?.sizeBytes || 0) || 0);
    if (sizeDelta !== 0) return sizeDelta;

    return getTitleText(left).localeCompare(getTitleText(right));
}

function runFilterStage(items, meta, filters, helpers = {}) {
    let list = Array.isArray(items) ? items : [];
    if (typeof helpers.applyPackKnowledge === 'function') list = helpers.applyPackKnowledge(list, meta);
    if (typeof helpers.applyConfiguredTorrentFilters === 'function') list = helpers.applyConfiguredTorrentFilters(list, filters || {});
    return list;
}

function applyFallbackSort(items) {
    return [...(Array.isArray(items) ? items : [])].sort(compareFallbackBuckets);
}

function runSortStage(items, meta, config, helpers = {}) {
    let list = Array.isArray(items) ? items : [];
    if (typeof helpers.rankAndFilterResults === 'function') list = helpers.rankAndFilterResults(list, meta, config);
    if (typeof helpers.rerankCompositeResults === 'function') list = helpers.rerankCompositeResults(list, meta, config, config?.sort || config?.filters?.sort || 'balanced');
    if (typeof helpers.applyPremiumRankingPolicy === 'function') list = helpers.applyPremiumRankingPolicy(list, meta, config);
    if (config?.filters?.maxPerQuality && typeof helpers.filterByQualityLimit === 'function') list = helpers.filterByQualityLimit(list, config.filters.maxPerQuality);

    const mode = String(config?.filters?.simpleSortFallback || '').toLowerCase();
    const shouldForceFallback = mode === 'force' || mode === 'true';
    const hasRankScores = list.some((item) => typeof item?._score === 'number' || typeof item?._compositeScore === 'number');
    if (shouldForceFallback || !hasRankScores) return applyFallbackSort(list);
    return list;
}

module.exports = {
    detectQualityTier,
    detectResolutionTier,
    detectCachedTier,
    compareFallbackBuckets,
    applyFallbackSort,
    runFilterStage,
    runSortStage
};
