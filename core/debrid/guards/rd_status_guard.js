'use strict';

const { extractInfoHash, extractFileIdx } = require('../../stream/infohash_deduper');

const RD_STATUS_FIELDS = [
  '_rdCacheState',
  'rdCacheState',
  'cacheState',
  'rd_status',
  'rdStatus',
  'cached',
  'cached_rd',
  '_dbCachedRd',
  '_tbCached',
  'tb_cached',
  'likely_cached',
  'probing',
  'debridService',
  'service',
  '_nexusBridgeRdChecked',
  '_externalRdChecked'
];

const STATE_PRIORITY = {
  uncached_terminal: 0,
  likely_uncached: 1,
  unknown: 2,
  probing: 3,
  likely_cached: 4,
  cached: 5
};

function normalizeState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (state === 'rd_cached' || state === 'instant' || state === 'instant_available') return 'cached';
  if (state === 'likely' || state === 'maybe_cached') return 'likely_cached';
  if (state === 'uncached' || state === 'not_cached') return 'likely_uncached';
  if (Object.prototype.hasOwnProperty.call(STATE_PRIORITY, state)) return state;
  return '';
}

function statePriority(value) {
  const state = normalizeState(value);
  return state ? STATE_PRIORITY[state] : -1;
}

function bestState(...values) {
  let best = '';
  let bestPriority = -1;
  for (const value of values) {
    const state = normalizeState(value);
    const priority = statePriority(state);
    if (priority > bestPriority) {
      best = state;
      bestPriority = priority;
    }
  }
  return best;
}

function hasMeaningfulBoolean(value) {
  return value === true || value === false;
}

function hasMeaningfulValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function getSourceState(item = {}) {
  if (item?._dbCachedRd === true || item?.cached_rd === true || item?._tbCached === true || item?.tb_cached === true || item?.cached === true) return 'cached';
  if (item?.likely_cached === true) return 'likely_cached';
  if (item?.probing === true) return 'probing';
  return bestState(item?._rdCacheState, item?.rdCacheState, item?.cacheState, item?.rd_status, item?.rdStatus, item?.state);
}

function applyState(out, state) {
  if (!state) return out;
  const current = getSourceState(out);
  if (statePriority(current) < statePriority(state)) {
    if (!out._rdCacheState || statePriority(out._rdCacheState) < statePriority(state)) out._rdCacheState = state;
    if (!out.rdCacheState || statePriority(out.rdCacheState) < statePriority(state)) out.rdCacheState = state;
    if (!out.cacheState || statePriority(out.cacheState) < statePriority(state)) out.cacheState = state;
  } else {
    if (!out._rdCacheState && statePriority(current) >= statePriority(state)) out._rdCacheState = state;
    if (!out.rdCacheState && statePriority(current) >= statePriority(state)) out.rdCacheState = state;
    if (!out.cacheState && statePriority(current) >= statePriority(state)) out.cacheState = state;
  }

  if (state === 'cached') {
    out.cached = true;
    out.cached_rd = out.cached_rd === false ? out.cached_rd : true;
    out._dbCachedRd = out._dbCachedRd === false ? out._dbCachedRd : true;
    if (out.probing === undefined) out.probing = false;
  } else if (state === 'likely_cached') {
    if (out.cached !== true && out.cached !== false) out.cached = null;
    if (out.likely_cached !== true) out.likely_cached = true;
  } else if (state === 'probing') {
    if (out.cached !== true && out.cached !== false) out.cached = null;
    if (out.probing !== true) out.probing = true;
  }

  return out;
}

function preserveScalarFields(out, source) {
  for (const field of RD_STATUS_FIELDS) {
    const current = out[field];
    const value = source?.[field];
    if (!hasMeaningfulValue(value)) continue;

    if (field === 'cached' && out.cached === true) continue;
    if (field === 'cached' && hasMeaningfulBoolean(out.cached) && value !== true) continue;
    if (field === 'cached_rd' && out.cached_rd === true) continue;
    if (field === '_dbCachedRd' && out._dbCachedRd === true) continue;
    if (field === '_tbCached' && out._tbCached === true) continue;
    if (field === 'tb_cached' && out.tb_cached === true) continue;
    if (!hasMeaningfulValue(current) || value === true) out[field] = value;
  }
}

function preserveBehaviorHints(out, source) {
  const hints = source?.behaviorHints;
  if (!hints || typeof hints !== 'object') return;
  const outHints = out.behaviorHints && typeof out.behaviorHints === 'object' ? out.behaviorHints : {};
  const mergedHints = { ...outHints };
  for (const field of ['bingeGroup', 'videoSize', 'filename', 'fileIdx', 'infoHash']) {
    if (!hasMeaningfulValue(mergedHints[field]) && hasMeaningfulValue(hints[field])) mergedHints[field] = hints[field];
  }
  if (hints.cached === true && mergedHints.cached !== true) mergedHints.cached = true;
  if (hasMeaningfulValue(hints.cacheState) && statePriority(hints.cacheState) > statePriority(mergedHints.cacheState)) mergedHints.cacheState = normalizeState(hints.cacheState);
  if (Object.keys(mergedHints).length > 0) out.behaviorHints = mergedHints;
}

function preserveRdStatus(target = {}, ...sources) {
  const out = { ...(target || {}) };
  let restored = 0;

  for (const source of sources.flat().filter(Boolean)) {
    const beforeState = getSourceState(out);
    const sourceState = getSourceState(source);
    preserveScalarFields(out, source);
    preserveBehaviorHints(out, source);
    applyState(out, sourceState);
    const afterState = getSourceState(out);
    if (afterState !== beforeState || sourceState && statePriority(afterState) >= statePriority(sourceState)) restored += 1;
  }

  return { item: out, restored };
}

function streamIdentityKeys(item = {}) {
  const keys = [];
  const hash = extractInfoHash(item);
  const fileIdx = extractFileIdx(item);
  if (hash && fileIdx !== null) keys.push(`hashFile:${hash}:${fileIdx}`);
  if (hash) keys.push(`hash:${hash}`);
  const url = String(item?.url || item?.externalUrl || item?.directUrl || '').trim();
  if (url) keys.push(`url:${url}`);
  const title = String(item?.title || item?.name || '').trim().toLowerCase();
  if (title) keys.push(`title:${title}`);
  return [...new Set(keys)];
}

function indexSources(sources = []) {
  const map = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    for (const key of streamIdentityKeys(source)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(source);
    }
  }
  return map;
}

function preserveRdStatusList(sourceList = [], targetList = [], options = {}) {
  if (!Array.isArray(targetList) || targetList.length === 0) return [];
  const sourceMap = indexSources(sourceList);
  let restored = 0;
  const results = targetList.map((target) => {
    const matched = [];
    for (const key of streamIdentityKeys(target)) {
      const entries = sourceMap.get(key);
      if (entries) matched.push(...entries);
    }
    if (matched.length === 0) return target;
    const { item, restored: itemRestored } = preserveRdStatus(target, [...new Set(matched)]);
    restored += itemRestored > 0 ? 1 : 0;
    return item;
  });

  if (restored > 0 && options?.logger && typeof options.logger.info === 'function') {
    options.logger.info(`[RD AUDIT] status preserved | stage=${options.stage || 'stream'} | restored=${restored}/${targetList.length}`);
  }

  return results;
}

module.exports = {
  preserveRdStatus,
  preserveRdStatusList,
  getSourceState,
  normalizeState,
  statePriority
};
