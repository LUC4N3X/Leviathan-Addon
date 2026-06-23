'use strict';

const { getSourceState } = require('../debrid/rd/guards/rd_status_guard');
const { createFilterExplain } = require('./filter_explain_engine');
const { applyStreamPolicies } = require('../policies/stream_policy_engine');
const { applySmartDeduperV2 } = require('../stream/smart_deduper_v2');
const { applyPerceptualDedupe } = require('../stream/perceptual_dedupe');
const { queueSelectedStreamPrecache } = require('../precache/precache_selector');

const DEFAULT_STREAM_POLICY_MODE = 'audit';
const DEFAULT_SMART_DEDUPE_MODE = 'conservative';
const DEFAULT_PERCEPTUAL_DEDUPE_MODE = 'conservative';
const DEFAULT_SORT_MODE = 'balanced';
const DEFAULT_EXPLAIN_SAMPLE_LIMIT = 4;
const MAX_EXPLAIN_SAMPLE_LIMIT = 20;

function getTitleText(item) {
  return String(item?.title || item?.name || '').trim();
}

function getLowerTitle(item) {
  return getTitleText(item).toLowerCase();
}

function getReleaseDetails(item) {
  return item?._releaseDetails && typeof item._releaseDetails === 'object'
    ? item._releaseDetails
    : {};
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeInteger(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}

function getExplainSampleLimit() {
  return clamp(
    safeInteger(process.env.LEVIATHAN_FILTER_EXPLAIN_SAMPLES, DEFAULT_EXPLAIN_SAMPLE_LIMIT),
    0,
    MAX_EXPLAIN_SAMPLE_LIMIT
  );
}

function detectQualityTier(item) {
  const title = getLowerTitle(item);
  const details = getReleaseDetails(item);
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
  const details = getReleaseDetails(item);
  const quality = String(details.quality || item?._rankMeta?.quality || '').toLowerCase();
  const title = getLowerTitle(item);

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

function getSeederCount(item) {
  return safeNumber(item?.seeders, 0);
}

function getSizeBytes(item) {
  return safeNumber(item?._size || item?.sizeBytes || 0, 0);
}

function compareFallbackBuckets(left, right) {
  const qualityDelta = detectQualityTier(right) - detectQualityTier(left);
  if (qualityDelta !== 0) return qualityDelta;

  const resolutionDelta = detectResolutionTier(right) - detectResolutionTier(left);
  if (resolutionDelta !== 0) return resolutionDelta;

  const cachedDelta = detectCachedTier(right) - detectCachedTier(left);
  if (cachedDelta !== 0) return cachedDelta;

  const seedDelta = getSeederCount(right) - getSeederCount(left);
  if (seedDelta !== 0) return seedDelta;

  const sizeDelta = getSizeBytes(right) - getSizeBytes(left);
  if (sizeDelta !== 0) return sizeDelta;

  return getTitleText(left).localeCompare(getTitleText(right));
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
    sampleLimit: getExplainSampleLimit()
  });
}

function explainDiff(explain, stage, before, after, reason) {
  if (!explain?.enabled) return;
  explain.stage(stage, before, after, reason);
}

function normalizeList(items) {
  return Array.isArray(items) ? items : [];
}

function normalizeFilters(filters = {}) {
  return filters && typeof filters === 'object' ? filters : {};
}

function getStreamPolicyMode(filters = {}) {
  return filters?.streamPolicyMode || process.env.LEVIATHAN_STREAM_POLICY_MODE || DEFAULT_STREAM_POLICY_MODE;
}

function getSmartDedupeMode(filters = {}) {
  return filters?.smartDedupeV2Mode || process.env.LEVIATHAN_SMART_DEDUPE_V2_MODE || DEFAULT_SMART_DEDUPE_MODE;
}

function getPerceptualDedupeMode(filters = {}) {
  return filters?.perceptualDedupeMode || process.env.LEVIATHAN_PERCEPTUAL_DEDUPE_MODE || DEFAULT_PERCEPTUAL_DEDUPE_MODE;
}

function getSortMode(config = {}) {
  return config?.sort || config?.filters?.sort || DEFAULT_SORT_MODE;
}

function shouldForceFallbackSort(config = {}, list = []) {
  const mode = String(config?.filters?.simpleSortFallback || '').toLowerCase();
  if (mode === 'force' || mode === 'true') return true;

  return !list.some((item) => (
    typeof item?._score === 'number' ||
    typeof item?._compositeScore === 'number'
  ));
}

function runFilterStage(items, meta, filters, helpers = {}) {
  let list = normalizeList(items);
  const safeFilters = normalizeFilters(filters);
  const explain = createStageExplain(meta, safeFilters, helpers);

  explain.input('filter.input', list);

  if (typeof helpers.applyPackKnowledge === 'function') {
    const before = list;
    list = helpers.applyPackKnowledge(list, meta);
    explainDiff(explain, 'packKnowledge', before, list, 'pack_knowledge_removed');
  }

  if (typeof helpers.applyConfiguredTorrentFilters === 'function') {
    const before = list;
    list = helpers.applyConfiguredTorrentFilters(list, safeFilters);
    explainDiff(explain, 'configuredTorrentFilters', before, list, 'configured_torrent_filter_removed');
  }

  const policyResult = applyStreamPolicies(list, {
    meta,
    filters: safeFilters,
    explain,
    logger: helpers.logger,
    mode: getStreamPolicyMode(safeFilters)
  });

  list = normalizeList(policyResult.items);

  if (policyResult.stats?.removed > 0 || policyResult.stats?.matched > 0) {
    explain.note('streamPolicy', policyResult.stats);
  }

  const dedupeResult = applySmartDeduperV2(list, {
    meta,
    filters: safeFilters,
    explain,
    logger: helpers.logger,
    mode: getSmartDedupeMode(safeFilters)
  });

  list = normalizeList(dedupeResult.items);

  if (dedupeResult.stats?.merged > 0 || dedupeResult.stats?.groups > 0) {
    explain.note('smartDedupeV2', dedupeResult.stats);
  }

  const perceptualResult = applyPerceptualDedupe(list, {
    meta,
    filters: safeFilters,
    explain,
    logger: helpers.logger,
    mode: getPerceptualDedupeMode(safeFilters)
  });

  list = normalizeList(perceptualResult.items);

  if (perceptualResult.stats?.merged > 0 || perceptualResult.stats?.groups > 0) {
    explain.note('perceptualDedupe', perceptualResult.stats);
  }

  explain.final(list, { stage: 'filter' });
  return list;
}

function applyFallbackSort(items) {
  return [...normalizeList(items)].sort(compareFallbackBuckets);
}

function runSortStage(items, meta, config = {}, helpers = {}) {
  let list = normalizeList(items);
  const safeConfig = config && typeof config === 'object' ? config : {};
  const safeFilters = normalizeFilters(safeConfig.filters);
  const explain = createStageExplain(meta, safeFilters, helpers);

  explain.input('sort.input', list);

  if (typeof helpers.rankAndFilterResults === 'function') {
    const before = list;
    list = helpers.rankAndFilterResults(list, meta, safeConfig);
    explainDiff(explain, 'rankAndFilterResults', before, list, 'rank_filter_removed');
  }

  if (typeof helpers.rerankCompositeResults === 'function') {
    const before = list;
    list = helpers.rerankCompositeResults(list, meta, safeConfig, getSortMode(safeConfig));
    explainDiff(explain, 'rerankCompositeResults', before, list, 'composite_rerank_removed');
  }

  if (typeof helpers.applyPremiumRankingPolicy === 'function') {
    const before = list;
    list = helpers.applyPremiumRankingPolicy(list, meta, safeConfig);
    explainDiff(explain, 'premiumRankingPolicy', before, list, 'premium_policy_removed');
  }

  if (safeFilters.maxPerQuality && typeof helpers.filterByQualityLimit === 'function') {
    const before = list;
    list = helpers.filterByQualityLimit(list, safeFilters.maxPerQuality);
    explainDiff(explain, 'maxPerQuality', before, list, 'max_per_quality_removed');
  }

  list = normalizeList(list);

  if (shouldForceFallbackSort(safeConfig, list)) {
    list = applyFallbackSort(list);
  }

  queueSelectedStreamPrecache(list, {
    meta,
    config: safeConfig,
    logger: helpers.logger,
    selector: safeFilters.precacheSelector || process.env.LEVIATHAN_PRECACHE_SELECTOR
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
