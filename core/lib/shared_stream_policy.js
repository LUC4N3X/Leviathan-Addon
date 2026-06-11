'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SHARED_STREAM_FRESH_SKIP_HOURS = 96;

const QUALITY_4K_REGEX = /\b(?:2160p|4k|uhd)\b/i;
const QUALITY_1080_REGEX = /\b(?:1080p|fhd|full[-.\s]?hd)\b/i;
const QUALITY_720_REGEX = /\b(?:720p|hd)\b/i;
const CAM_REGEX = /\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i;

const FRESHNESS_BUCKETS = Object.freeze(['ultra_fresh', 'fresh', 'settling', 'stable']);
const QUALITY_ORDER = Object.freeze({
  sd: 0,
  '720p': 1,
  '1080p': 2,
  '4k': 3
});

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isSeriesMeta(meta = {}) {
  return Boolean(meta?.isSeries || safeNumber(meta?.season, 0) > 0 || safeNumber(meta?.episode, 0) > 0);
}

function parseDateCandidate(value) {
  if (!value) return null;

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { date: new Date(value.getTime()), precision: 'day' };
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? { date, precision: 'day' } : null;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) ? { date, precision: 'day' } : null;
  }

  if (/^\d{4}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}-01T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) ? { date, precision: 'month' } : null;
  }

  if (/^\d{4}$/.test(raw)) {
    const date = new Date(`${raw}-01-01T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) ? { date, precision: 'year' } : null;
  }

  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? { date: parsed, precision: 'day' } : null;
}

function normalizeFreshnessBucket(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return FRESHNESS_BUCKETS.includes(normalized) ? normalized : 'stable';
}

function getQualityBucket(text) {
  const raw = String(text || '');
  if (QUALITY_4K_REGEX.test(raw)) return '4k';
  if (QUALITY_1080_REGEX.test(raw)) return '1080p';
  if (QUALITY_720_REGEX.test(raw)) return '720p';
  return 'sd';
}

function compareQuality(a, b) {
  return (QUALITY_ORDER[a] || 0) - (QUALITY_ORDER[b] || 0);
}

function pickBestQuality(values = []) {
  let best = 'sd';

  for (const value of safeArray(values)) {
    const bucket = getQualityBucket(value);
    if (compareQuality(bucket, best) > 0) best = bucket;
  }

  return best;
}

function selectContentDateCandidate(meta = {}) {
  const candidates = [
    { value: meta?.episodeAirDate, source: 'episode_air_date' },
    { value: meta?.airDate, source: 'air_date' },
    { value: meta?.releaseDate, source: 'release_date' },
    { value: meta?.firstAirDate, source: 'first_air_date' },
    { value: meta?.releaseInfo, source: 'release_info' },
    { value: meta?.year, source: 'year' }
  ];

  for (const candidate of candidates) {
    const parsed = parseDateCandidate(candidate.value);
    if (!parsed) continue;

    return {
      contentDate: parsed.date,
      contentDateIso: parsed.date.toISOString(),
      contentDateSource: candidate.source,
      contentDatePrecision: parsed.precision
    };
  }

  return null;
}

function getFreshnessBucket(selected, nowMs) {
  if (!selected?.contentDate) return 'stable';

  const ageMs = nowMs - selected.contentDate.getTime();
  const ageHours = ageMs / HOUR_MS;
  const ageDays = ageMs / DAY_MS;

  let bucket = 'stable';

  if (ageHours < 48) bucket = 'ultra_fresh';
  else if (ageHours < 7 * 24) bucket = 'fresh';
  else if (ageHours < 21 * 24) bucket = 'settling';

  if (selected.contentDatePrecision === 'year') {
    const contentYear = selected.contentDate.getUTCFullYear();
    const nowYear = new Date(nowMs).getUTCFullYear();
    if (contentYear >= nowYear && bucket === 'stable') bucket = 'settling';
  } else if (selected.contentDatePrecision === 'month' && bucket === 'stable' && ageDays < 60) {
    bucket = 'settling';
  }

  return bucket;
}

function resolveContentTimeline(meta = {}, nowMs = Date.now()) {
  const selected = selectContentDateCandidate(meta);

  if (!selected) {
    return {
      contentDate: null,
      contentDateIso: null,
      contentDateSource: 'unknown',
      contentDatePrecision: 'unknown',
      ageHours: null,
      ageDays: null,
      freshnessBucket: 'stable'
    };
  }

  const ageMs = nowMs - selected.contentDate.getTime();

  return {
    ...selected,
    ageHours: ageMs / HOUR_MS,
    ageDays: ageMs / DAY_MS,
    freshnessBucket: getFreshnessBucket(selected, nowMs)
  };
}

function getItemText(item = {}) {
  return compactText(`${item?.name || ''} ${item?.title || ''}`);
}

function hasConfirmedCache(item = {}) {
  const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').toLowerCase();

  return item?.cached_rd === true
    || item?._dbCachedRd === true
    || item?._tbCached === true
    || item?.tb_cached === true
    || item?.tbCached === true
    || item?.isCached === true
    || item?.cached === true
    || state === 'cached';
}

function hasExactFileIndex(item = {}) {
  if (item?.fileIdx === undefined || item?.fileIdx === null || item?.fileIdx === '') return false;
  const value = Number(item.fileIdx);
  return Number.isInteger(value) && value >= 0;
}

function hasExactEpisodeMatch(title, meta = {}) {
  if (!isSeriesMeta(meta) || !title) return false;

  const season = safeNumber(meta?.season, 0);
  const episode = safeNumber(meta?.episode, 0);
  if (season <= 0 || episode <= 0) return false;

  const exactRegexes = [
    new RegExp(`\\bS0*${season}E0*${episode}\\b`, 'i'),
    new RegExp(`\\b${season}x0*${episode}\\b`, 'i'),
    new RegExp(`\\bseason\\s*0*${season}\\s*episode\\s*0*${episode}\\b`, 'i'),
    new RegExp(`\\bstagione\\s*0*${season}\\s*episodio\\s*0*${episode}\\b`, 'i')
  ];

  return exactRegexes.some((regex) => regex.test(title));
}

function addSource(sourceSet, value) {
  const source = compactText(value);
  if (source) sourceSet.add(source);
}

function summarizeCleanResults(meta = {}, cleanResults = [], sourceSet, qualityTexts) {
  let cachedCount = 0;
  let exactEpisodeCount = 0;
  let exactFileIdxCount = 0;
  let packValidatedCount = 0;
  let camCount = 0;

  for (const item of safeArray(cleanResults)) {
    const title = String(item?.title || '');

    addSource(sourceSet, item?.source || item?.provider);
    if (title) qualityTexts.push(title);

    if (hasConfirmedCache(item)) cachedCount += 1;
    if (isSeriesMeta(meta) && hasExactFileIndex(item)) exactFileIdxCount += 1;
    if (item?._packValidated === true) packValidatedCount += 1;
    if (CAM_REGEX.test(title)) camCount += 1;
    if (hasExactEpisodeMatch(title, meta)) exactEpisodeCount += 1;
  }

  return {
    cachedCount,
    exactEpisodeCount,
    exactFileIdxCount,
    packValidatedCount,
    camCount
  };
}

function summarizeFinalStreams(finalStreams = [], qualityTexts) {
  let camCount = 0;

  for (const stream of safeArray(finalStreams)) {
    const text = compactText(`${stream?.name || ''} ${stream?.title || ''}`);
    if (!text) continue;

    qualityTexts.push(text);
    if (CAM_REGEX.test(text)) camCount += 1;
  }

  return { camCount };
}

function computeSearchCoverageScore(context = {}, cleanResults = []) {
  const enabledWebProvidersCount = clamp(context.enabledWebProvidersCount || 0, 0, 8);

  return clamp(
    (context.hasDebridKey ? 12 : 0)
      + (context.isP2PEnabled ? 4 : 0)
      + (context.dbOnlyMode ? 8 : 0)
      + (enabledWebProvidersCount * 4)
      + (Math.min(cleanResults.length, 4) * 4),
    0,
    40
  );
}

function summarizeCacheOutcome(meta = {}, context = {}) {
  const cleanResults = safeArray(context.cleanResults);
  const rankedResults = safeArray(context.rankedResults);
  const finalStreams = safeArray(context.finalStreams);
  const debridStreams = safeArray(context.debridStreams);
  const webStreams = safeArray(context.webStreams);
  const p2pStreams = safeArray(context.p2pStreams);
  const sourceSet = new Set();
  const qualityTexts = [];

  const cleanSummary = summarizeCleanResults(meta, cleanResults, sourceSet, qualityTexts);
  const streamSummary = summarizeFinalStreams(finalStreams, qualityTexts);

  if (debridStreams.length > 0) addSource(sourceSet, String(context.debridService || 'debrid').toUpperCase());
  if (p2pStreams.length > 0) addSource(sourceSet, 'P2P');

  for (const providerName of safeArray(context.webBucketNames)) {
    addSource(sourceSet, providerName);
  }

  return {
    resultCount: cleanResults.length,
    rankedCount: rankedResults.length,
    streamCount: finalStreams.length,
    debridStreamCount: debridStreams.length,
    webStreamCount: webStreams.length,
    p2pStreamCount: p2pStreams.length,
    cachedCount: cleanSummary.cachedCount,
    exactEpisodeCount: cleanSummary.exactEpisodeCount,
    exactFileIdxCount: cleanSummary.exactFileIdxCount,
    packValidatedCount: cleanSummary.packValidatedCount,
    camCount: cleanSummary.camCount + streamSummary.camCount,
    distinctSourceCount: sourceSet.size,
    sourceMix: [...sourceSet].slice(0, 8),
    bestQuality: pickBestQuality(qualityTexts),
    searchCoverageScore: computeSearchCoverageScore(context, cleanResults),
    isEmpty: finalStreams.length === 0,
    hasPositiveStreams: finalStreams.length > 0
  };
}

function computeConfidenceScore(meta = {}, summary = {}) {
  let score = 0;

  if (summary.hasPositiveStreams) score += 18;

  score += Math.min(summary.streamCount || 0, 4) * 6;
  score += Math.min(summary.cachedCount || 0, 3) * 10;
  score += Math.min(summary.debridStreamCount || 0, 2) * 8;
  score += Math.min(summary.webStreamCount || 0, 2) * 4;
  score += Math.min(summary.p2pStreamCount || 0, 2) * 3;
  score += Math.min(summary.distinctSourceCount || 0, 4) * 5;
  score += Math.min(summary.packValidatedCount || 0, 2) * 7;
  score += Math.min(summary.exactFileIdxCount || 0, 3) * 6;
  score += Math.min(summary.exactEpisodeCount || 0, 2) * 9;

  if (summary.bestQuality === '4k') score += 10;
  else if (summary.bestQuality === '1080p') score += 8;
  else if (summary.bestQuality === '720p') score += 5;

  score -= Math.min(summary.camCount || 0, 3) * 18;

  if (!summary.hasPositiveStreams) {
    score = Math.max(score, Math.round((summary.searchCoverageScore || 0) * 0.9));
    if ((summary.searchCoverageScore || 0) < 16) score -= 10;
  }

  if (
    isSeriesMeta(meta)
    && !summary.hasPositiveStreams
    && (summary.exactEpisodeCount || 0) === 0
    && (summary.exactFileIdxCount || 0) === 0
  ) {
    score -= 12;
  }

  return clamp(score, 0, 100);
}

function buildEmptyPolicy(bucket, summary, confidenceScore) {
  const coverage = safeNumber(summary?.searchCoverageScore, 0);
  let localTtl = 60;
  let sharedTtl = 0;
  let staleGraceTtl = 0;
  let allowSharedWrite = false;
  let allowSharedStale = false;

  if (bucket === 'ultra_fresh') {
    localTtl = coverage >= 20 ? 45 : 30;
  } else if (bucket === 'fresh') {
    localTtl = coverage >= 20 ? 75 : 45;
  } else if (bucket === 'settling') {
    localTtl = coverage >= 20 ? 120 : 90;
  } else {
    localTtl = coverage >= 24 ? 180 : 120;

    if (coverage >= 18 && confidenceScore >= 18) {
      allowSharedWrite = true;
      sharedTtl = coverage >= 28 ? 90 : 45;
      staleGraceTtl = 30;
    }
  }

  return {
    localTtl,
    sharedTtl,
    staleGraceTtl,
    allowSharedWrite,
    allowSharedStale
  };
}

function buildPositivePolicy(bucket, confidenceScore) {
  let localTtl = 300;
  let sharedTtl = 0;
  let staleGraceTtl = 0;
  let allowSharedWrite = false;
  let allowSharedStale = false;

  if (bucket === 'ultra_fresh') {
    localTtl = confidenceScore >= 85 ? 240 : confidenceScore >= 72 ? 150 : 90;

    if (confidenceScore >= 86) {
      allowSharedWrite = true;
      sharedTtl = 180;
      staleGraceTtl = 45;
    } else if (confidenceScore >= 76) {
      allowSharedWrite = true;
      sharedTtl = 75;
      staleGraceTtl = 30;
    }
  } else if (bucket === 'fresh') {
    localTtl = confidenceScore >= 85 ? 480 : confidenceScore >= 65 ? 300 : 180;

    if (confidenceScore >= 84) {
      allowSharedWrite = true;
      sharedTtl = 480;
      staleGraceTtl = 120;
      allowSharedStale = true;
    } else if (confidenceScore >= 68) {
      allowSharedWrite = true;
      sharedTtl = 180;
      staleGraceTtl = 90;
    }
  } else if (bucket === 'settling') {
    localTtl = confidenceScore >= 80 ? 900 : confidenceScore >= 60 ? 600 : 360;
    allowSharedWrite = true;

    if (confidenceScore >= 76) {
      sharedTtl = 900;
      staleGraceTtl = 240;
    } else if (confidenceScore >= 58) {
      sharedTtl = 480;
      staleGraceTtl = 180;
    } else {
      sharedTtl = 180;
      staleGraceTtl = 90;
    }

    allowSharedStale = confidenceScore >= 55;
  } else {
    localTtl = confidenceScore >= 80 ? 1800 : confidenceScore >= 60 ? 1200 : 900;
    allowSharedWrite = true;

    if (confidenceScore >= 80) {
      sharedTtl = 1800;
      staleGraceTtl = 300;
    } else if (confidenceScore >= 60) {
      sharedTtl = 1200;
      staleGraceTtl = 240;
    } else {
      sharedTtl = 600;
      staleGraceTtl = 180;
    }

    allowSharedStale = true;
  }

  return {
    localTtl,
    sharedTtl,
    staleGraceTtl,
    allowSharedWrite,
    allowSharedStale
  };
}

function applySharedFreshSkip(ttlPolicy, sharedFreshSkip) {
  if (!sharedFreshSkip) return ttlPolicy;

  return {
    ...ttlPolicy,
    sharedTtl: 0,
    staleGraceTtl: 0,
    allowSharedWrite: false,
    allowSharedStale: false
  };
}

function buildSharedStreamCachePolicy(meta = {}, context = {}) {
  const timeline = resolveContentTimeline(meta, context?.nowMs);
  const summary = summarizeCacheOutcome(meta, context);
  const confidenceScore = computeConfidenceScore(meta, summary);
  const basePolicy = summary.isEmpty
    ? buildEmptyPolicy(timeline.freshnessBucket, summary, confidenceScore)
    : buildPositivePolicy(timeline.freshnessBucket, confidenceScore);
  const sharedFreshSkip = Number.isFinite(timeline.ageHours)
    && timeline.ageHours >= 0
    && timeline.ageHours < SHARED_STREAM_FRESH_SKIP_HOURS;
  const ttlPolicy = applySharedFreshSkip(basePolicy, sharedFreshSkip);

  return {
    version: 3,
    ...timeline,
    ...summary,
    confidenceScore,
    localTtl: ttlPolicy.localTtl,
    sharedTtl: ttlPolicy.sharedTtl,
    staleGraceTtl: ttlPolicy.staleGraceTtl,
    allowSharedWrite: ttlPolicy.allowSharedWrite,
    allowSharedStale: ttlPolicy.allowSharedStale,
    sharedFreshSkip
  };
}

function buildSharedReadContext(meta = {}, extra = {}) {
  const nowMs = extra?.nowMs || Date.now();
  const timeline = resolveContentTimeline(meta, nowMs);

  return {
    freshnessBucket: timeline.freshnessBucket,
    contentDateSource: timeline.contentDateSource,
    contentDatePrecision: timeline.contentDatePrecision,
    nowMs
  };
}

function getRowAgeHours(row = {}, requestContext = {}) {
  const contentTimeline = parseDateCandidate(row?.content_date);
  if (!contentTimeline?.date) return null;

  return ((requestContext?.nowMs || Date.now()) - contentTimeline.date.getTime()) / HOUR_MS;
}

function shouldUseEmptySharedEntry(requestBucket, confidence, allowStale) {
  if (allowStale) return false;
  return requestBucket === 'stable' && confidence >= 18;
}

function shouldUsePositiveSharedEntry(requestBucket, entryBucket, confidence, allowStale) {
  if (requestBucket === 'ultra_fresh') {
    return allowStale ? confidence >= 88 : confidence >= 75;
  }

  if (requestBucket === 'fresh') {
    return allowStale ? confidence >= 70 : confidence >= 60;
  }

  if (requestBucket === 'settling') {
    return allowStale ? confidence >= 55 : confidence >= 45;
  }

  if (allowStale) return confidence >= 35 || entryBucket === 'stable';

  return true;
}

function shouldUseSharedStreamEntry(row = {}, requestContext = {}, options = {}) {
  const requestBucket = normalizeFreshnessBucket(requestContext?.freshnessBucket);
  const entryBucket = normalizeFreshnessBucket(row?.freshness_bucket);
  const confidence = clamp(row?.confidence_score || 0, 0, 100);
  const resultCount = safeNumber(row?.result_count, 0);
  const policyVersion = safeNumber(row?.policy_version, 0);
  const allowStale = options?.allowStale === true;
  const rowAgeHours = getRowAgeHours(row, requestContext);

  if (requestBucket !== 'stable' && policyVersion < 2) return false;
  if (
    requestBucket !== 'stable'
    && Number.isFinite(rowAgeHours)
    && rowAgeHours >= 0
    && rowAgeHours < SHARED_STREAM_FRESH_SKIP_HOURS
  ) {
    return false;
  }

  if (resultCount <= 0) {
    return shouldUseEmptySharedEntry(requestBucket, confidence, allowStale);
  }

  return shouldUsePositiveSharedEntry(requestBucket, entryBucket, confidence, allowStale);
}

module.exports = {
  resolveContentTimeline,
  summarizeCacheOutcome,
  computeConfidenceScore,
  buildSharedStreamCachePolicy,
  buildSharedReadContext,
  shouldUseSharedStreamEntry
};
