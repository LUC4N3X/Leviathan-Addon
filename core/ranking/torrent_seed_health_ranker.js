'use strict';

const DEFAULTS = Object.freeze({
  enabled: String(process.env.TORRENT_SEED_HEALTH_RANKING_ENABLED || 'true').toLowerCase() !== 'false',
  healthySeeders: Math.max(1, parseInt(process.env.TORRENT_HEALTHY_SEEDERS || '5', 10) || 5),
  seededSeeders: Math.max(1, parseInt(process.env.TORRENT_SEEDED_SEEDERS || '1', 10) || 1),
  minHealthyToDropDead: Math.max(0, parseInt(process.env.TORRENT_HEALTH_DROP_DEAD_AFTER || '6', 10) || 6),
  minHealthyToDropWeak: Math.max(0, parseInt(process.env.TORRENT_HEALTH_DROP_WEAK_AFTER || '12', 10) || 12),
  healthyBoost: parseInt(process.env.TORRENT_SEED_HEALTHY_BOOST || '10000', 10) || 10000,
  seededBoost: parseInt(process.env.TORRENT_SEED_SEEDED_BOOST || '2500', 10) || 2500,
  weakPenalty: parseInt(process.env.TORRENT_SEED_WEAK_PENALTY || '-6000', 10) || -6000,
  deadPenalty: parseInt(process.env.TORRENT_SEED_DEAD_PENALTY || '-18000', 10) || -18000,
  maxSeederScore: Math.max(0, parseInt(process.env.TORRENT_SEED_HEALTH_MAX_SEEDERS || '500', 10) || 500),
  codecDiversityEnabled: String(process.env.CODEC_DIVERSITY_ENABLED || 'true').toLowerCase() !== 'false',
  codecDiversityMinResults: Math.max(2, parseInt(process.env.CODEC_DIVERSITY_MIN_RESULTS || '6', 10) || 6),
  codecDiversityProtectedTop: Math.max(0, parseInt(process.env.CODEC_DIVERSITY_PROTECTED_TOP || '3', 10) || 3),
  codecDiversityMaxPerRound: Math.max(1, parseInt(process.env.CODEC_DIVERSITY_MAX_PER_ROUND || '2', 10) || 2)
});

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSeeders(item = {}) {
  return Math.max(0, toInt(item?.seeders ?? item?.seeds ?? item?.seed_count ?? item?.seedCount ?? item?.torrent?.seeders, 0));
}

function getCodecText(item = {}) {
  return [
    item?.codec,
    item?.videoCodec,
    item?.video_codec,
    item?.encoding,
    item?.title,
    item?.name,
    item?.filename,
    item?.fileName,
    item?.torrent?.title,
    item?.torrent?.name,
    item?.rawTitle
  ].filter(Boolean).join(' ').toLowerCase();
}

function detectCodec(item = {}) {
  const text = getCodecText(item);
  if (/\b(av1|aom)\b/i.test(text)) return 'av1';
  if (/\b(hevc|h\.?265|x265)\b/i.test(text)) return 'h265';
  if (/\b(avc|h\.?264|x264)\b/i.test(text)) return 'h264';
  if (/\bvp9\b/i.test(text)) return 'vp9';
  if (/\b(xvid|divx)\b/i.test(text)) return 'xvid';
  return 'unknown';
}

function countCodecs(items = []) {
  return items.reduce((acc, item) => {
    const codec = detectCodec(item);
    acc[codec] = (acc[codec] || 0) + 1;
    return acc;
  }, {});
}

function summarizeCodecs(counts = {}) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([codec, count]) => `${codec}=${count}`)
    .join(' ');
}

function applyCodecDiversity(items = [], options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const list = Array.isArray(items) ? items : [];
  if (!cfg.codecDiversityEnabled || list.length < cfg.codecDiversityMinResults) {
    return { items: list, changed: false, counts: countCodecs(list) };
  }

  const counts = countCodecs(list);
  const knownCodecs = Object.keys(counts).filter((codec) => codec !== 'unknown');
  if (knownCodecs.length <= 1) return { items: list, changed: false, counts };

  const protectedCount = Math.min(list.length, cfg.codecDiversityProtectedTop);
  const protectedTop = list.slice(0, protectedCount);
  const tail = list.slice(protectedCount);
  const groups = new Map();

  for (const item of tail) {
    const codec = detectCodec(item);
    if (!groups.has(codec)) groups.set(codec, []);
    groups.get(codec).push(item);
  }

  const orderedCodecs = [...groups.keys()].sort((a, b) => {
    if (a === 'unknown' && b !== 'unknown') return 1;
    if (b === 'unknown' && a !== 'unknown') return -1;
    return (groups.get(b)?.length || 0) - (groups.get(a)?.length || 0);
  });

  const diversifiedTail = [];
  let changed = false;
  while (orderedCodecs.some((codec) => (groups.get(codec) || []).length > 0)) {
    for (const codec of orderedCodecs) {
      const bucket = groups.get(codec) || [];
      for (let i = 0; i < cfg.codecDiversityMaxPerRound && bucket.length > 0; i += 1) {
        diversifiedTail.push(bucket.shift());
      }
    }
  }

  const output = [...protectedTop, ...diversifiedTail];
  for (let i = 0; i < output.length; i += 1) {
    if (output[i] !== list[i]) { changed = true; break; }
  }

  return {
    items: output.map((item) => {
      const codec = detectCodec(item);
      return {
        ...item,
        _codecDiversity: codec,
        _rankMeta: item?._rankMeta ? { ...item._rankMeta, codecDiversity: codec } : item?._rankMeta
      };
    }),
    changed,
    counts
  };
}

function getAvailabilityState(item = {}) {
  return String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').trim().toLowerCase();
}

function isProtectedByAvailability(item = {}) {
  const state = getAvailabilityState(item);
  return Boolean(
    item?.directUrl ||
    item?._externalDirectUrl ||
    item?.externalDirectUrl ||
    item?.url && /^https?:\/\//i.test(String(item.url)) ||
    item?._tbCached === true ||
    item?.tbCached === true ||
    item?._dbCachedRd === true ||
    item?.cached_rd === true ||
    state === 'cached' ||
    state === 'likely_cached' ||
    state === 'probing'
  );
}

function classifySeedHealth(item = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const seeders = getSeeders(item);
  const protectedByAvailability = isProtectedByAvailability(item);

  if (protectedByAvailability) {
    return {
      seeders,
      health: seeders >= cfg.healthySeeders ? 'healthy_cached' : 'cached',
      protected: true,
      delta: seeders >= cfg.healthySeeders ? Math.round(cfg.healthyBoost * 0.6) : Math.round(cfg.seededBoost * 0.8),
      reason: 'availability'
    };
  }

  if (seeders >= cfg.healthySeeders) {
    const scaled = Math.min(cfg.maxSeederScore, seeders) / Math.max(1, cfg.maxSeederScore);
    return {
      seeders,
      health: 'healthy',
      protected: false,
      delta: cfg.healthyBoost + Math.round(cfg.healthyBoost * 0.35 * scaled),
      reason: 'seeders'
    };
  }

  if (seeders >= cfg.seededSeeders) {
    return {
      seeders,
      health: 'weak',
      protected: false,
      delta: cfg.weakPenalty + cfg.seededBoost,
      reason: 'low_seeders'
    };
  }

  return {
    seeders,
    health: 'dead',
    protected: false,
    delta: cfg.deadPenalty,
    reason: 'zero_seeders'
  };
}

function shouldDropBySeedHealth(healthInfo, counts, options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  if (!healthInfo || healthInfo.protected) return false;
  if (healthInfo.health === 'dead' && counts.healthy >= cfg.minHealthyToDropDead) return true;
  if (healthInfo.health === 'weak' && counts.healthy >= cfg.minHealthyToDropWeak) return true;
  return false;
}

function applyTorrentSeedHealthRanking(items = [], options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const list = Array.isArray(items) ? items : [];
  if (!cfg.enabled || list.length <= 1) return list;

  const annotated = list.map((item) => {
    const seedHealth = classifySeedHealth(item, cfg);
    const currentScore = Number(item?._score || 0) || 0;
    return {
      ...item,
      _score: currentScore + seedHealth.delta,
      _seedHealth: seedHealth.health,
      _seedHealthDelta: seedHealth.delta,
      _seedHealthProtected: seedHealth.protected,
      _rankMeta: item?._rankMeta ? {
        ...item._rankMeta,
        seedHealth: seedHealth.health,
        seedHealthDelta: seedHealth.delta,
        seedHealthProtected: seedHealth.protected,
        seeders: seedHealth.seeders
      } : item?._rankMeta,
      _reasons: Array.isArray(item?._reasons) ? [...item._reasons, `SEED_${seedHealth.health.toUpperCase()}`] : [`SEED_${seedHealth.health.toUpperCase()}`]
    };
  });

  const counts = annotated.reduce((acc, item) => {
    const health = item?._seedHealth;
    if (health === 'healthy' || health === 'healthy_cached') acc.healthy += 1;
    else if (health === 'weak') acc.weak += 1;
    else if (health === 'dead') acc.dead += 1;
    else if (health === 'cached') acc.cached += 1;
    if (item?._seedHealthProtected) acc.protected += 1;
    return acc;
  }, { healthy: 0, weak: 0, dead: 0, cached: 0, protected: 0 });

  let droppedWeak = 0;
  let droppedDead = 0;
  const filtered = annotated.filter((item) => {
    const drop = shouldDropBySeedHealth({ health: item?._seedHealth, protected: item?._seedHealthProtected }, counts, cfg);
    if (drop && item?._seedHealth === 'weak') droppedWeak += 1;
    if (drop && item?._seedHealth === 'dead') droppedDead += 1;
    return !drop;
  });

  filtered.sort((a, b) => {
    if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
    return getSeeders(b) - getSeeders(a);
  });

  const codecDiversity = applyCodecDiversity(filtered, cfg);
  const finalItems = codecDiversity.items;

  const logger = options?.logger;
  if (logger && typeof logger.info === 'function') {
    const top = finalItems[0];
    logger.info(`[RANK] seedHealth healthy=${counts.healthy} weak=${counts.weak} dead=${counts.dead} protected=${counts.protected} droppedWeak=${droppedWeak} droppedDead=${droppedDead} top=${top?._seedHealth || 'none'} seeders=${getSeeders(top)}`);
    if (cfg.codecDiversityEnabled && filtered.length >= cfg.codecDiversityMinResults) {
      logger.info(`[CODEC] diversity ${summarizeCodecs(codecDiversity.counts)} reordered=${codecDiversity.changed}`);
    }
  }

  return finalItems;
}

module.exports = {
  DEFAULTS,
  getSeeders,
  detectCodec,
  applyCodecDiversity,
  classifySeedHealth,
  applyTorrentSeedHealthRanking
};
