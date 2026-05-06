'use strict';

function textOf(item = {}) {
  return String([
    item?.title,
    item?.name,
    item?.quality,
    item?.resolution,
    item?._releaseDetails?.quality,
    item?.behaviorHints?.videoResolution
  ].filter(Boolean).join(' '));
}

function detectResolutionTier(item = {}) {
  const text = textOf(item).toLowerCase();
  if (/\b(?:2160p|4k|uhd)\b/.test(text)) return 4;
  if (/\b(?:1080p|fhd|full[-.\s]?hd)\b/.test(text)) return 3;
  if (/\b720p\b/.test(text)) return 2;
  if (/\b(?:576p|540p|480p|360p|sd)\b/.test(text)) return 1;
  return 0;
}

function detectCacheTier(item = {}) {
  const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').toLowerCase();
  if (item?.isSavedCloud || item?._savedCloud || item?.savedCloud) return 5;
  if (item?._dbCachedRd === true || item?.cached_rd === true || item?._tbCached === true || item?.tb_cached === true || item?.cached === true || state === 'cached') return 4;
  if (state === 'likely_cached' || item?.likely_cached === true) return 3;
  if (state === 'probing' || item?.probing === true) return 2;
  if (state === 'likely_uncached') return 1;
  if (state === 'uncached_terminal') return 0;
  return 2;
}

function detectSourceBucket(item = {}) {
  const text = String(`${item?.source || ''} ${item?.provider || ''} ${item?.externalAddon || ''} ${item?.externalGroup || ''} ${item?.name || ''}`).toLowerCase();
  if (/torrentio/.test(text)) return 'torrentio';
  if (/mediafusion/.test(text)) return 'mediafusion';
  if (/database|leviathandb|\bdb\b/.test(text)) return 'db';
  if (/web|guard|cinema|anime|stream/.test(text) || item?.type === 'web') return 'web';
  return 'other';
}

function scoreOf(item = {}) {
  return Number(item?._compositeScore ?? item?._score ?? 0) || 0;
}

function sizeOf(item = {}) {
  return Number(item?._size || item?.sizeBytes || item?.size || 0) || 0;
}

function seedersOf(item = {}) {
  return Number(item?.seeders || item?.seeds || item?.peers || 0) || 0;
}

function shouldPromoteHigherResolution(candidate, current, options = {}) {
  const candidateRes = detectResolutionTier(candidate);
  const currentRes = detectResolutionTier(current);
  if (candidateRes <= currentRes) return false;
  if (candidateRes - currentRes < 2) return false;
  if (detectCacheTier(candidate) !== detectCacheTier(current)) return false;
  if (detectSourceBucket(candidate) !== detectSourceBucket(current)) return false;

  const scoreDeltaAgainstCandidate = scoreOf(current) - scoreOf(candidate);
  const maxScoreGap = Number(options.maxScoreGap ?? 12000) || 12000;
  if (scoreDeltaAgainstCandidate > maxScoreGap) return false;

  const currentSeeders = seedersOf(current);
  const candidateSeeders = seedersOf(candidate);
  if (currentSeeders >= 50 && candidateSeeders <= 1) return false;

  const currentSize = sizeOf(current);
  const candidateSize = sizeOf(candidate);
  if (currentSize > 0 && candidateSize > 0 && candidateSize < currentSize * 0.35) return false;

  return true;
}

function applyStrictResolutionOrdering(items = [], options = {}) {
  const list = Array.isArray(items) ? items : [];
  const annotated = list.map((item, index) => ({ item, index }));

  annotated.sort((left, right) => {
    const resolutionDelta = detectResolutionTier(right.item) - detectResolutionTier(left.item);
    if (resolutionDelta !== 0) return resolutionDelta;

    const cacheDelta = detectCacheTier(right.item) - detectCacheTier(left.item);
    if (cacheDelta !== 0) return cacheDelta;

    const sourceDelta = String(detectSourceBucket(left.item)).localeCompare(String(detectSourceBucket(right.item)));
    if (sourceDelta !== 0) return sourceDelta;

    const scoreDelta = scoreOf(right.item) - scoreOf(left.item);
    if (scoreDelta !== 0) return scoreDelta;

    const seedDelta = seedersOf(right.item) - seedersOf(left.item);
    if (seedDelta !== 0) return seedDelta;

    const sizeDelta = sizeOf(right.item) - sizeOf(left.item);
    if (sizeDelta !== 0) return sizeDelta;

    return left.index - right.index;
  });

  const reordered = annotated.map((entry) => entry.item);
  const moved = reordered.reduce((count, item, index) => count + (item !== list[index] ? 1 : 0), 0);
  if (moved > 0 && options?.logger && typeof options.logger.info === 'function') {
    options.logger.info(`[RANK] resolution guard strict | moved=${moved} | total=${list.length}`);
  }
  return reordered;
}

function applyResolutionOrderingGuard(items = [], options = {}) {
  const list = Array.isArray(items) ? [...items] : [];
  if (list.length < 2) return list;

  if (options?.strict === true || String(options?.sortMode || '').toLowerCase() === 'resolution') {
    return applyStrictResolutionOrdering(list, options);
  }

  const maxLookahead = Math.max(2, Math.min(8, Number(options.maxLookahead || 5) || 5));
  let promoted = 0;

  for (let i = 0; i < list.length - 1; i += 1) {
    let bestIndex = -1;
    for (let j = i + 1; j < Math.min(list.length, i + 1 + maxLookahead); j += 1) {
      if (shouldPromoteHigherResolution(list[j], list[i], options)) {
        if (bestIndex === -1 || detectResolutionTier(list[j]) > detectResolutionTier(list[bestIndex])) bestIndex = j;
      }
    }
    if (bestIndex !== -1) {
      const [picked] = list.splice(bestIndex, 1);
      list.splice(i, 0, picked);
      promoted += 1;
    }
  }

  if (promoted > 0 && options?.logger && typeof options.logger.info === 'function') {
    options.logger.info(`[RANK] resolution guard | promoted=${promoted} | total=${list.length}`);
  }

  return list;
}

module.exports = {
  applyResolutionOrderingGuard,
  applyStrictResolutionOrdering,
  detectResolutionTier,
  detectCacheTier,
  detectSourceBucket,
  shouldPromoteHigherResolution
};
