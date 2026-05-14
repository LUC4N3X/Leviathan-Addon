'use strict';

const { getSourceState } = require('../debrid/guards/rd_status_guard');
const { createFilterExplain } = require('./filter_explain_engine');
const { applyStreamPolicies } = require('../policies/stream_policy_engine');
const { applySmartDeduperV2 } = require('../stream/smart_deduper_v2');
const { queueSelectedStreamPrecache } = require('../precache/precache_selector');

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
    const state = getSourceState(item);
    if (state === 'cached') return 2;
    if (state === 'likely_cached') return 1;
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

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function getRequestKey(meta = {}) {
    const type = meta?.type || meta?.requestType || (meta?.isSeries ? 'series' : 'movie');
    const id = meta?.id || meta?.imdb_id || meta?.tmdb_id || meta?.title || meta?.name || 'unknown';
    const season = meta?.season !== undefined ? `:${meta.season}` : '';
    const episode = meta?.episode !== undefined ? `:${meta.episode}` : '';
    return `${type}:${id}${season}${episode}`;
}

function createStageExplain(meta = {}, filters = {}, helpers = {}) {
    const enabled = filters?.explainFilters !== false
        && filters?.filterExplain !== false
        && envFlag('LEVIATHAN_FILTER_EXPLAIN', true);

    return createFilterExplain({
        enabled,
        requestKey: getRequestKey(meta),
        logger: helpers.logger,
        compact: String(process.env.LEVIATHAN_FILTER_EXPLAIN_COMPACT || '1') !== '0',
        sampleLimit: Math.max(0, Math.min(20, parseInt(process.env.LEVIATHAN_FILTER_EXPLAIN_SAMPLES || '4', 10) || 4))
    });
}

function explainDiff(explain, stage, before, after, reason) {
    if (!explain || !explain.enabled) return;
    explain.stage(stage, before, after, reason);
}

function runFilterStage(items, meta, filters, helpers = {}) {
    let list = Array.isArray(items) ? items : [];
    const explain = createStageExplain(meta, filters || {}, helpers);

    explain.input('filter.input', list);

    if (typeof helpers.applyPackKnowledge === 'function') {
        const before = list;
        list = helpers.applyPackKnowledge(list, meta);
        explainDiff(explain, 'packKnowledge', before, list, 'pack_knowledge_removed');
    }

    if (typeof helpers.applyConfiguredTorrentFilters === 'function') {
        const before = list;
        list = helpers.applyConfiguredTorrentFilters(list, filters || {});
        explainDiff(explain, 'configuredTorrentFilters', before, list, 'configured_torrent_filter_removed');
    }

    const policyResult = applyStreamPolicies(list, {
        meta,
        filters: filters || {},
        explain,
        logger: helpers.logger,
        mode: filters?.streamPolicyMode || process.env.LEVIATHAN_STREAM_POLICY_MODE || 'audit'
    });
    list = policyResult.items;
    if (policyResult.stats?.removed > 0 || policyResult.stats?.matched > 0) {
        explain.note('streamPolicy', policyResult.stats);
    }

    const dedupeResult = applySmartDeduperV2(list, {
        meta,
        filters: filters || {},
        explain,
        logger: helpers.logger,
        mode: filters?.smartDedupeV2Mode || process.env.LEVIATHAN_SMART_DEDUPE_V2_MODE || 'conservative'
    });
    list = dedupeResult.items;
    if (dedupeResult.stats?.merged > 0 || dedupeResult.stats?.groups > 0) {
        explain.note('smartDedupeV2', dedupeResult.stats);
    }

    explain.final(list, { stage: 'filter' });
    return list;
}

function applyFallbackSort(items) {
    return [...(Array.isArray(items) ? items : [])].sort(compareFallbackBuckets);
}

function runSortStage(items, meta, config, helpers = {}) {
    let list = Array.isArray(items) ? items : [];
    const explain = createStageExplain(meta, config?.filters || {}, helpers);

    explain.input('sort.input', list);

    if (typeof helpers.rankAndFilterResults === 'function') {
        const before = list;
        list = helpers.rankAndFilterResults(list, meta, config);
        explainDiff(explain, 'rankAndFilterResults', before, list, 'rank_filter_removed');
    }

    if (typeof helpers.rerankCompositeResults === 'function') {
        const before = list;
        list = helpers.rerankCompositeResults(list, meta, config, config?.sort || config?.filters?.sort || 'balanced');
        explainDiff(explain, 'rerankCompositeResults', before, list, 'composite_rerank_removed');
    }

    if (typeof helpers.applyPremiumRankingPolicy === 'function') {
        const before = list;
        list = helpers.applyPremiumRankingPolicy(list, meta, config);
        explainDiff(explain, 'premiumRankingPolicy', before, list, 'premium_policy_removed');
    }

    if (config?.filters?.maxPerQuality && typeof helpers.filterByQualityLimit === 'function') {
        const before = list;
        list = helpers.filterByQualityLimit(list, config.filters.maxPerQuality);
        explainDiff(explain, 'maxPerQuality', before, list, 'max_per_quality_removed');
    }

    const mode = String(config?.filters?.simpleSortFallback || '').toLowerCase();
    const shouldForceFallback = mode === 'force' || mode === 'true';
    const hasRankScores = list.some((item) => typeof item?._score === 'number' || typeof item?._compositeScore === 'number');
    if (shouldForceFallback || !hasRankScores) {
        list = applyFallbackSort(list);
    }

    queueSelectedStreamPrecache(list, {
        meta,
        config,
        logger: helpers.logger,
        selector: config?.filters?.precacheSelector || process.env.LEVIATHAN_PRECACHE_SELECTOR
    });

    explain.final(list, { stage: 'sort' });
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
