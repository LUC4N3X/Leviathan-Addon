'use strict';

const HEALTHY_SEEDERS = 5;
const SEEDED_SEEDERS = 1;
const ENOUGH_HEALTHY_MIN = 8;
const ENOUGH_HEALTHY_RATIO = 0.35;
const MAX_WEAK_WHEN_HEALTHY = 3;
const MAX_DEAD_WHEN_NO_ALTERNATIVES = 2;

function normalizeSeeders(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
  const cleaned = String(value).trim().replace(/[^0-9.,-]/g, '');
  if (!cleaned) return null;
  const parsed = Number.parseInt(cleaned.replace(/,(?=[0-9]{3}\b)/g, ''), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function getSeedHealth(seeders) {
  const value = normalizeSeeders(seeders);
  if (value === null) return { health: 'unknown', seeders: null, delta: 0, label: 'unknown' };
  if (value >= HEALTHY_SEEDERS) return { health: 'healthy', seeders: value, delta: 10, label: 'boost=+10' };
  if (value >= SEEDED_SEEDERS) return { health: 'weak', seeders: value, delta: -6, label: 'penalty=-6' };
  return { health: 'dead', seeders: value, delta: -18, label: 'penalty=-18' };
}

function isAvailabilityProtected(item = {}) {
  const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').toLowerCase();
  return Boolean(
    item?._dbCachedRd === true ||
    item?.cached_rd === true ||
    item?._tbCached === true ||
    item?.tbCached === true ||
    state === 'cached' ||
    state === 'likely_cached' ||
    item?._packValidated === true ||
    item?._isPack === true ||
    (Number.isInteger(Number(item?.fileIdx)) && Number(item.fileIdx) >= 0)
  );
}

function annotateSeedHealth(item) {
  const info = getSeedHealth(item?.seeders);
  const annotated = {
    ...item,
    _seedHealth: info.health,
    _seedHealthSeeders: info.seeders,
    _seedHealthDelta: info.delta
  };
  if (info.seeders !== null) annotated.seeders = info.seeders;
  return annotated;
}

function shouldUseStrictHealthyMode(counts, total) {
  if (!total) return false;
  if (counts.healthy >= ENOUGH_HEALTHY_MIN) return true;
  return counts.healthy >= 4 && (counts.healthy / total) >= ENOUGH_HEALTHY_RATIO;
}

function countHealth(counts, health) {
  if (health === 'healthy') counts.healthy += 1;
  else if (health === 'weak') counts.weak += 1;
  else if (health === 'dead') counts.dead += 1;
  else counts.unknown += 1;
}

function applySeedHealthRanking(results = [], options = {}) {
  const list = (Array.isArray(results) ? results : []).map(annotateSeedHealth);
  if (list.length <= 1) {
    return { results: list, stats: buildSeedHealthStats(list, { strict: false, dropped: 0 }) };
  }

  const buckets = { healthy: [], weak: [], dead: [], unknown: [], protected: [] };
  const counts = { healthy: 0, weak: 0, dead: 0, unknown: 0, protected: 0 };
  const rankableCounts = { healthy: 0, weak: 0, dead: 0, unknown: 0, protected: 0 };

  for (const item of list) {
    const health = item._seedHealth || 'unknown';
    const protectedItem = isAvailabilityProtected(item);
    countHealth(counts, health);

    if (protectedItem) {
      counts.protected += 1;
      buckets.protected.push(item);
      continue;
    }

    countHealth(rankableCounts, health);
    if (health === 'healthy') buckets.healthy.push(item);
    else if (health === 'weak') buckets.weak.push(item);
    else if (health === 'dead') buckets.dead.push(item);
    else buckets.unknown.push(item);
  }

  const rankableTotal = Math.max(0, list.length - buckets.protected.length);
  const strict = shouldUseStrictHealthyMode(rankableCounts, rankableTotal);
  let kept;

  if (strict) {
    const weakKeep = Math.max(0, Math.min(MAX_WEAK_WHEN_HEALTHY, Math.floor(buckets.healthy.length * 0.15)));
    kept = [...buckets.protected, ...buckets.healthy, ...buckets.unknown, ...buckets.weak.slice(0, weakKeep)];
  } else if (buckets.healthy.length > 0 || buckets.weak.length > 0) {
    kept = [...buckets.protected, ...buckets.healthy, ...buckets.weak, ...buckets.unknown];
  } else {
    kept = [...buckets.protected, ...buckets.unknown, ...buckets.dead.slice(0, Math.min(MAX_DEAD_WHEN_NO_ALTERNATIVES, buckets.dead.length))];
  }

  if (kept.length === 0 && list.length > 0) kept = list.slice(0, 1);

  const keptSet = new Set(kept);
  const dropped = list.length - keptSet.size;
  const stats = buildSeedHealthStats(list, { strict, dropped, kept: keptSet.size, counts });

  if (options?.preserveOriginalOrder === true) {
    const allowed = new Set(kept);
    return { results: list.filter((item) => allowed.has(item)), stats };
  }

  return { results: kept, stats };
}

function buildSeedHealthStats(list, extra = {}) {
  const counts = extra.counts || { healthy: 0, weak: 0, dead: 0, unknown: 0, protected: 0 };
  if (!extra.counts) {
    for (const item of list) {
      const health = item?._seedHealth || getSeedHealth(item?.seeders).health;
      countHealth(counts, health);
      if (isAvailabilityProtected(item)) counts.protected += 1;
    }
  }
  return {
    total: list.length,
    kept: Number.isInteger(extra.kept) ? extra.kept : list.length,
    dropped: Math.max(0, Number(extra.dropped || 0) || 0),
    strict: Boolean(extra.strict),
    ...counts
  };
}

function getSeedHealthLogSamples(results = [], limit = 6) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(results) ? results : []) {
    const info = getSeedHealth(item?.seeders);
    if (info.health === 'unknown') continue;
    if (seen.has(info.health)) continue;
    seen.add(info.health);
    out.push(`[RANK] seedHealth=${info.health} seeders=${info.seeders} ${info.label}`);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  HEALTHY_SEEDERS,
  SEEDED_SEEDERS,
  applySeedHealthRanking,
  annotateSeedHealth,
  getSeedHealth,
  getSeedHealthLogSamples,
  isAvailabilityProtected,
  normalizeSeeders
};
