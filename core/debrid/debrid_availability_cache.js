'use strict';

const DEFAULTS = Object.freeze({
  enabled: String(process.env.DEBRID_AVAILABILITY_CACHE_ENABLED || 'true').toLowerCase() !== 'false',
  hitTtl: Math.max(300, parseInt(process.env.DEBRID_AVAILABILITY_CACHE_HIT_TTL || String(24 * 60 * 60), 10) || (24 * 60 * 60)),
  negativeTtl: Math.max(120, parseInt(process.env.DEBRID_AVAILABILITY_CACHE_NEGATIVE_TTL || String(6 * 60 * 60), 10) || (6 * 60 * 60)),
  probingTtl: Math.max(60, parseInt(process.env.DEBRID_AVAILABILITY_CACHE_PROBING_TTL || '120', 10) || 120)
});

const VALID_STATES = new Set(['cached', 'likely_cached', 'probing', 'likely_uncached', 'uncached_terminal', 'unknown']);

function normalizeService(service) {
  const normalized = String(service || '').trim().toLowerCase();
  if (normalized === 'realdebrid') return 'rd';
  if (normalized === 'torbox') return 'tb';
  return normalized || 'rd';
}

function normalizeHash(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return /^[A-F0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeFileIdx(value) {
  if (value === undefined || value === null || value === '') return -1;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

function normalizeState(state) {
  const normalized = String(state || '').trim().toLowerCase();
  return VALID_STATES.has(normalized) ? normalized : null;
}

function getHashFromItem(item = {}) {
  return normalizeHash(item?.hash || item?.infoHash || item?.info_hash || item?.btih);
}

function getFileIdxFromItem(item = {}) {
  return normalizeFileIdx(item?.fileIdx ?? item?.file_index ?? item?.fileId ?? item?.file_id);
}

function buildKey(service, hash, fileIdx = -1) {
  const cleanHash = normalizeHash(hash);
  if (!cleanHash) return null;
  return `${normalizeService(service)}:${cleanHash}:${normalizeFileIdx(fileIdx)}`;
}

function buildHashKey(service, hash) {
  const cleanHash = normalizeHash(hash);
  if (!cleanHash) return null;
  return `${normalizeService(service)}:${cleanHash}`;
}

function getKeysForItem(service, item = {}) {
  const hash = getHashFromItem(item);
  if (!hash) return [];
  const fileIdx = getFileIdxFromItem(item);
  const keys = [buildKey(service, hash, fileIdx)];
  if (fileIdx !== -1) keys.push(buildKey(service, hash, -1));
  keys.push(buildHashKey(service, hash));
  return [...new Set(keys.filter(Boolean))];
}

function buildPayload(statePayload = {}, item = {}, result = null) {
  const state = normalizeState(statePayload.state) || null;
  const fileIdx = normalizeFileIdx(
    statePayload.fileIdx ??
    statePayload.file_id ??
    statePayload.fileIndex ??
    result?.file_id ??
    result?.file_index ??
    result?.rd_file_index ??
    result?.tb_file_id ??
    item?.fileIdx
  );
  return {
    state,
    cached: statePayload.cached === true ? true : statePayload.cached === false ? false : null,
    failures: Math.max(0, Number(statePayload.failures || 0) || 0),
    fileSize: Number(result?.file_size || result?.rd_file_size || result?.tb_file_size || item?._size || item?.sizeBytes || 0) || 0,
    fileIdx,
    ts: Date.now()
  };
}

function getTtlForPayload(payload = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const state = normalizeState(payload?.state);
  if (state === 'cached' || payload?.cached === true) return cfg.hitTtl;
  if (state === 'uncached_terminal' || payload?.cached === false) return cfg.negativeTtl;
  return cfg.probingTtl;
}

function applyPayloadToItem(item = {}, payload = {}, service = 'rd') {
  if (!item || !payload || !normalizeState(payload.state)) return false;
  const normalizedService = normalizeService(service);
  if (normalizedService === 'tb') {
    item._tbCached = payload.cached === true || payload.state === 'cached' ? true : item._tbCached;
    item.tbCached = item._tbCached === true;
  } else {
    item._rdCacheState = payload.state;
    item.rdCacheState = payload.state;
    item._dbCachedRd = payload.cached === true ? true : payload.cached === false ? false : item._dbCachedRd;
    item.cached_rd = payload.cached === true ? true : payload.cached === false ? false : item.cached_rd;
    item._dbFailures = Math.max(0, Number(payload.failures || item._dbFailures || 0) || 0);
  }

  if (Number(payload.fileSize) > 0) {
    item._size = Math.max(Number(item._size || item.sizeBytes || 0) || 0, Number(payload.fileSize));
    item.sizeBytes = Math.max(Number(item.sizeBytes || item._size || 0) || 0, Number(payload.fileSize));
  }
  if ((item.fileIdx === undefined || item.fileIdx === null || item.fileIdx === '') && Number.isInteger(payload.fileIdx) && payload.fileIdx >= 0) {
    item.fileIdx = payload.fileIdx;
  }
  item._availabilityCacheHit = true;
  return true;
}

async function get(Cache, service, item = {}) {
  if (!DEFAULTS.enabled || !Cache || typeof Cache.getAvailability !== 'function') return null;
  for (const key of getKeysForItem(service, item)) {
    const payload = await Cache.getAvailability(key);
    if (payload && normalizeState(payload.state)) return { key, payload };
  }
  return null;
}

async function set(Cache, service, item = {}, payloadInput = {}, ttl = null) {
  if (!DEFAULTS.enabled || !Cache || typeof Cache.cacheAvailability !== 'function') return false;
  const hash = getHashFromItem(item);
  if (!hash) return false;
  const payload = buildPayload(payloadInput, item, payloadInput);
  if (!normalizeState(payload.state)) return false;
  const effectiveTtl = ttl || getTtlForPayload(payload);
  const keys = getKeysForItem(service, { ...item, fileIdx: payload.fileIdx });
  await Promise.all(keys.map((key) => Cache.cacheAvailability(key, payload, effectiveTtl)));
  return true;
}

async function hydrateItems(Cache, service, items = {}, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!DEFAULTS.enabled || !Cache || typeof Cache.getAvailability !== 'function') return list;
  let hits = 0;
  let misses = 0;
  for (const item of list) {
    const cached = await get(Cache, service, item);
    if (cached?.payload && applyPayloadToItem(item, cached.payload, service)) hits += 1;
    else misses += 1;
  }
  const logger = options?.logger;
  if ((hits > 0 || options?.verbose) && logger && typeof logger.info === 'function') {
    logger.info(`[DEBRID CACHE] availability service=${normalizeService(service)} hits=${hits} misses=${misses} keyScope=infoHash:fileIdx`);
  }
  return list;
}

module.exports = {
  DEFAULTS,
  normalizeService,
  normalizeHash,
  normalizeFileIdx,
  normalizeState,
  getHashFromItem,
  getFileIdxFromItem,
  buildKey,
  buildHashKey,
  getKeysForItem,
  buildPayload,
  applyPayloadToItem,
  get,
  set,
  hydrateItems,
  getTtlForPayload
};
