'use strict';

const EpisodePrecision = require('../../../stream/episode_precision');

const VALID_RD_STATES = new Set(['cached', 'likely_cached', 'probing', 'likely_uncached', 'uncached_terminal', 'unknown']);
const POSITIVE_STATES = new Set(['cached', 'likely_cached']);
const SOFT_STATES = new Set(['likely_cached', 'probing', 'likely_uncached', 'unknown']);

function normalizeRdStateValue(state) {
  const normalized = String(state || '').trim().toLowerCase();
  return VALID_RD_STATES.has(normalized) ? normalized : null;
}

function getRdStateRank(state) {
  switch (normalizeRdStateValue(state)) {
    case 'cached': return 60;
    case 'likely_cached': return 50;
    case 'probing': return 30;
    case 'unknown': return 20;
    case 'likely_uncached': return 10;
    case 'uncached_terminal': return 0;
    default: return -1;
  }
}

function isSeriesMeta(meta = {}) {
  return Boolean(
    meta?.isSeries ||
    String(meta?.type || meta?.contentType || '').toLowerCase() === 'series' ||
    Number(meta?.season || 0) > 0 ||
    Number(meta?.episode || 0) > 0
  );
}

function hasConcreteFileIdx(item = {}) {
  const value = item?.fileIdx ?? item?.file_index ?? item?.rd_file_index ?? item?.tb_file_id;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0;
}

function getConcreteFileIdx(item = {}) {
  const value = item?.fileIdx ?? item?.file_index ?? item?.rd_file_index ?? item?.tb_file_id;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function hasEpisodeIdentity(item = {}, meta = {}) {
  const season = Number(item?.imdb_season ?? item?.season ?? meta?.season ?? 0);
  const episode = Number(item?.imdb_episode ?? item?.episode ?? meta?.episode ?? 0);
  return Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0;
}

function isPositiveBoolean(item = {}) {
  return Boolean(
    item?._dbCachedRd === true ||
    item?.cached_rd === true ||
    item?.isCached === true ||
    item?._mediafusionRdChecked === true ||
    item?._nexusBridgeRdChecked === true ||
    item?._externalRdChecked === true ||
    item?._savedCloud === true ||
    item?.isSavedCloud === true ||
    item?._tbCached === true ||
    item?.tbCached === true ||
    item?.tb_cached === true
  );
}

function isHardNegativeBoolean(item = {}) {
  return Boolean(
    item?._dbCachedRd === false ||
    item?.cached_rd === false
  );
}

function normalizeStoredCachedBool(state, cached) {
  const normalized = normalizeRdStateValue(state);
  if (normalized === 'cached') return true;
  if (normalized === 'uncached_terminal') return false;
  if (cached === true) return true;
  if (cached === false && normalized === 'uncached_terminal') return false;
  return null;
}

function resolveEffectiveRdState(item = {}, meta = {}) {
  const explicitState = normalizeRdStateValue(item?._rdCacheState || item?.rdCacheState || item?.cacheState);
  const positive = isPositiveBoolean(item);
  const series = isSeriesMeta(meta);
  const concreteFileIdx = hasConcreteFileIdx(item);
  const episodeIdentity = hasEpisodeIdentity(item, meta);
  const hasEpisodeFileHint = Boolean(item?.episodeFileHint || item?._episodeFileHint);

  if (item?._savedCloud === true || item?.isSavedCloud === true) return 'cached';

  // A verified positive always wins over a stale/probing/unknown marker.
  // For series/season packs, a positive hash without an exact file remains a soft hit:
  // UI still shows ⚡, but we avoid claiming exact cached if fileIdx is still unknown.
  if (positive || explicitState === 'cached' || explicitState === 'likely_cached') {
    if (series) {
      // Serie/pack: un infoHash cached non basta. Cached forte solo con prova episodio
      // (DB imdb:s:e -> fileIdx, episodeFileHint RD, filename SxxEyy, single-video probe trusted).
      if (EpisodePrecision.hasExactEpisodeProof(item, meta)) return 'cached';
      return 'likely_cached';
    }
    return explicitState === 'likely_cached' ? 'likely_cached' : 'cached';
  }

  if (explicitState === 'uncached_terminal') return 'uncached_terminal';
  if (explicitState === 'probing') return 'probing';
  if (explicitState === 'likely_uncached') return 'likely_uncached';
  if (explicitState === 'unknown') return 'unknown';

  if (isHardNegativeBoolean(item)) return 'likely_uncached';
  return 'unknown';
}

function shouldUpgradeState(currentState, incomingState) {
  const current = normalizeRdStateValue(currentState) || 'unknown';
  const incoming = normalizeRdStateValue(incomingState) || 'unknown';
  if (incoming === 'unknown') return current === 'unknown' || current === null;
  if (POSITIVE_STATES.has(incoming) && !POSITIVE_STATES.has(current)) return true;
  return getRdStateRank(incoming) > getRdStateRank(current);
}

function applyRdStateToItem(item = {}, state, options = {}) {
  const normalized = normalizeRdStateValue(state) || 'unknown';
  item._rdCacheState = normalized;
  item.rdCacheState = normalized;

  const cachedBool = options.cached !== undefined
    ? options.cached
    : normalizeStoredCachedBool(normalized, options.cached);

  if (cachedBool === true) {
    item._dbCachedRd = true;
    item.cached_rd = true;
  } else if (cachedBool === false && normalized === 'uncached_terminal') {
    item._dbCachedRd = false;
    item.cached_rd = false;
  } else if (options.clearNegative === true && (item._dbCachedRd === false || item.cached_rd === false)) {
    item._dbCachedRd = null;
    item.cached_rd = null;
  } else if (item._dbCachedRd === undefined) {
    item._dbCachedRd = null;
  }

  if (Number.isInteger(options.fileIdx) && options.fileIdx >= 0) item.fileIdx = options.fileIdx;
  if (Number(options.fileSize) > 0) {
    item._size = Math.max(Number(item._size || item.sizeBytes || 0) || 0, Number(options.fileSize));
    item.sizeBytes = Math.max(Number(item.sizeBytes || item._size || 0) || 0, Number(options.fileSize));
  }
  return item;
}

function mergeRdStateIntoItem(item = {}, incoming = {}, meta = {}) {
  const current = resolveEffectiveRdState(item, meta);
  const incomingState = resolveEffectiveRdState(incoming, meta);
  if (shouldUpgradeState(current, incomingState)) {
    applyRdStateToItem(item, incomingState, {
      cached: normalizeStoredCachedBool(incomingState, incoming?._dbCachedRd ?? incoming?.cached_rd),
      fileIdx: getConcreteFileIdx(incoming),
      fileSize: incoming?.rd_file_size || incoming?.file_size || incoming?._size || incoming?.sizeBytes,
      clearNegative: POSITIVE_STATES.has(incomingState)
    });
  }
  return item;
}

function getHashPositiveStateForSibling(knownState, item = {}, meta = {}) {
  const normalized = normalizeRdStateValue(knownState);
  if (normalized !== 'cached' && normalized !== 'likely_cached') return normalized || 'unknown';
  if (isSeriesMeta(meta) && !EpisodePrecision.hasExactEpisodeProof(item, meta)) return 'likely_cached';
  return normalized;
}

module.exports = {
  VALID_RD_STATES,
  normalizeRdStateValue,
  getRdStateRank,
  isSeriesMeta,
  hasConcreteFileIdx,
  getConcreteFileIdx,
  hasExactEpisodeProof: EpisodePrecision.hasExactEpisodeProof,
  normalizeStoredCachedBool,
  resolveEffectiveRdState,
  shouldUpgradeState,
  applyRdStateToItem,
  mergeRdStateIntoItem,
  getHashPositiveStateForSibling
};
