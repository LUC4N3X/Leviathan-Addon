'use strict';

const DEFAULTS = Object.freeze({
  enabled: String(process.env.BITRATE_RUNTIME_RANKING_ENABLED || 'true').toLowerCase() !== 'false',
  minSizeBytes: Math.max(1, parseInt(process.env.BITRATE_MIN_SIZE_BYTES || String(120 * 1024 * 1024), 10) || (120 * 1024 * 1024)),
  movieFallbackRuntimeMin: Math.max(30, parseInt(process.env.BITRATE_MOVIE_FALLBACK_RUNTIME_MIN || '105', 10) || 105),
  episodeFallbackRuntimeMin: Math.max(10, parseInt(process.env.BITRATE_EPISODE_FALLBACK_RUNTIME_MIN || '45', 10) || 45),
  goodBoost: parseInt(process.env.BITRATE_GOOD_BOOST || '2600', 10) || 2600,
  okBoost: parseInt(process.env.BITRATE_OK_BOOST || '900', 10) || 900,
  tooLowPenalty: parseInt(process.env.BITRATE_TOO_LOW_PENALTY || '-8500', 10) || -8500,
  lowPenalty: parseInt(process.env.BITRATE_LOW_PENALTY || '-4200', 10) || -4200,
  hugePenalty: parseInt(process.env.BITRATE_HUGE_PENALTY || '-1800', 10) || -1800,
  skipSeasonPacks: String(process.env.BITRATE_SKIP_SEASON_PACKS || 'true').toLowerCase() !== 'false'
});

const RANGES = Object.freeze({
  '2160p': { tooLow: 6, low: 10, goodMin: 12, goodMax: 45, huge: 85 },
  '1080p': { tooLow: 1.4, low: 2.5, goodMin: 3.5, goodMax: 18, huge: 36 },
  '720p': { tooLow: 0.55, low: 1.0, goodMin: 1.4, goodMax: 8.5, huge: 18 },
  sd: { tooLow: 0.22, low: 0.4, goodMin: 0.55, goodMax: 4.5, huge: 10 },
  unknown: { tooLow: 0.35, low: 0.8, goodMin: 1.2, goodMax: 20, huge: 45 }
});

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRuntimeMinutes(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (Array.isArray(value)) {
    const numeric = value.map(parseRuntimeMinutes).filter((entry) => entry > 0);
    return numeric.length ? Math.round(numeric.reduce((sum, entry) => sum + entry, 0) / numeric.length) : 0;
  }
  if (typeof value === 'number') {
    if (value > 10000) return Math.round(value / 60);
    return Math.round(value);
  }
  if (typeof value === 'object') {
    return parseRuntimeMinutes(value.runtime || value.duration || value.minutes || value.episode_run_time || value.episodeRuntime);
  }
  const text = String(value || '').trim().toLowerCase();
  const hourMinute = text.match(/(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?\s*(\d+(?:[.,]\d+)?)?\s*m?/i);
  if (hourMinute) {
    return Math.round((parseFloat(hourMinute[1].replace(',', '.')) || 0) * 60 + (parseFloat(String(hourMinute[2] || '0').replace(',', '.')) || 0));
  }
  const minute = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m|min|mins|minutes?|minuti)\b/i);
  if (minute) return Math.round(parseFloat(minute[1].replace(',', '.')) || 0);
  const plain = parseFloat(text.replace(',', '.'));
  return Number.isFinite(plain) && plain > 0 ? Math.round(plain) : 0;
}

function getRuntimeMinutes(meta = {}, item = {}, cfg = DEFAULTS) {
  const direct = [
    item?.runtimeMinutes,
    item?.runtime,
    item?.durationMinutes,
    item?.duration,
    meta?.runtimeMinutes,
    meta?.runtime,
    meta?.durationMinutes,
    meta?.duration,
    meta?.episodeRuntime,
    meta?.episode_run_time,
    meta?.details?.runtime,
    meta?.details?.duration,
    meta?.tmdb?.runtime,
    meta?.tmdb?.episode_run_time,
    meta?.tmdb?.episodeRuntime
  ];
  for (const value of direct) {
    const parsed = parseRuntimeMinutes(value);
    if (parsed > 0) return parsed;
  }
  return (meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0)
    ? cfg.episodeFallbackRuntimeMin
    : cfg.movieFallbackRuntimeMin;
}

function getSizeBytes(item = {}) {
  return Math.max(0, toNumber(item?._size, 0), toNumber(item?.sizeBytes, 0), toNumber(item?.mainFileSize, 0));
}

function textForItem(item = {}) {
  return [item?.title, item?.filename, item?.fileName, item?.name, item?.source, item?.provider].filter(Boolean).join(' ');
}

function detectResolution(item = {}) {
  const text = textForItem(item).toLowerCase();
  if (/\b(?:2160p|4k|uhd)\b/.test(text)) return '2160p';
  if (/\b(?:1080p|fhd|full\s*hd)\b/.test(text)) return '1080p';
  if (/\b720p\b/.test(text)) return '720p';
  if (/\b(?:480p|576p|sd)\b/.test(text)) return 'sd';
  return 'unknown';
}

function isSeasonPack(item = {}) {
  const text = textForItem(item);
  return Boolean(item?._isPack || item?.potentialPack || /\b(?:season\s*pack|stagione\s*pack|complete|completa|batch|collection|raccolta|pack)\b/i.test(text));
}

function scoreBitrate(mbps, resolution, cfg = DEFAULTS) {
  const range = RANGES[resolution] || RANGES.unknown;
  if (mbps <= 0) return { delta: 0, bucket: 'unknown' };
  if (mbps < range.tooLow) return { delta: cfg.tooLowPenalty, bucket: 'too_low' };
  if (mbps < range.low) return { delta: cfg.lowPenalty, bucket: 'low' };
  if (mbps >= range.goodMin && mbps <= range.goodMax) return { delta: cfg.goodBoost, bucket: 'good' };
  if (mbps > range.huge) return { delta: cfg.hugePenalty, bucket: 'huge' };
  return { delta: cfg.okBoost, bucket: 'ok' };
}

function calculateBitrateMbps(sizeBytes, runtimeMinutes) {
  if (!(sizeBytes > 0) || !(runtimeMinutes > 0)) return 0;
  return (sizeBytes * 8) / (runtimeMinutes * 60 * 1000 * 1000);
}

function applyBitrateRuntimeRanking(items = [], meta = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const list = Array.isArray(items) ? items : [];
  if (!cfg.enabled || list.length <= 1) return list;

  const counts = { good: 0, ok: 0, low: 0, too_low: 0, huge: 0, skipped: 0, unknown: 0 };
  let changed = false;

  const annotated = list.map((item) => {
    if (cfg.skipSeasonPacks && isSeasonPack(item)) {
      counts.skipped += 1;
      return item;
    }
    const sizeBytes = getSizeBytes(item);
    if (sizeBytes < cfg.minSizeBytes) {
      counts.skipped += 1;
      return item;
    }
    const runtimeMin = getRuntimeMinutes(meta, item, cfg);
    const mbps = calculateBitrateMbps(sizeBytes, runtimeMin);
    const resolution = detectResolution(item);
    const scoring = scoreBitrate(mbps, resolution, cfg);
    counts[scoring.bucket] = (counts[scoring.bucket] || 0) + 1;
    if (!scoring.delta) return item;
    changed = true;
    const currentScore = toNumber(item?._score, 0);
    return {
      ...item,
      _score: currentScore + scoring.delta,
      _bitrateMbps: Number(mbps.toFixed(2)),
      _bitrateScoreDelta: scoring.delta,
      _bitrateBucket: scoring.bucket,
      _rankMeta: item?._rankMeta ? {
        ...item._rankMeta,
        bitrateMbps: Number(mbps.toFixed(2)),
        bitrateBucket: scoring.bucket,
        bitrateDelta: scoring.delta,
        runtimeMinutes: runtimeMin,
        resolution
      } : item?._rankMeta,
      _reasons: Array.isArray(item?._reasons)
        ? [...item._reasons, `BITRATE_${String(scoring.bucket).toUpperCase()}`]
        : [`BITRATE_${String(scoring.bucket).toUpperCase()}`]
    };
  });

  if (changed) {
    annotated.sort((a, b) => {
      const scoreDelta = (toNumber(b?._score, 0) - toNumber(a?._score, 0));
      if (scoreDelta !== 0) return scoreDelta;
      return getSizeBytes(b) - getSizeBytes(a);
    });
  }

  const logger = options?.logger;
  if (logger && typeof logger.info === 'function') {
    const scored = list.length - counts.skipped;
    logger.info(`[BITRATE] scored=${scored} skipped=${counts.skipped} good=${counts.good || 0} ok=${counts.ok || 0} low=${counts.low || 0} tooLow=${counts.too_low || 0} huge=${counts.huge || 0} changed=${changed}`);
  }

  return annotated;
}

module.exports = {
  DEFAULTS,
  parseRuntimeMinutes,
  calculateBitrateMbps,
  applyBitrateRuntimeRanking
};
