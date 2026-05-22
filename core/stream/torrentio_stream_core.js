"use strict";

const crypto = require('crypto');

const TORRENTIO_STREAM_SHARED_TTL = Math.max(60, Number.parseInt(process.env.TORRENTIO_STREAM_SHARED_TTL || String(3 * 24 * 60 * 60), 10) || (3 * 24 * 60 * 60));
const TORRENTIO_STREAM_MEM_TTL = Math.max(60, Number.parseInt(process.env.TORRENTIO_STREAM_MEM_TTL || String(2 * 60 * 60), 10) || (2 * 60 * 60));
const TORRENTIO_STREAM_EMPTY_TTL = Math.max(15, Number.parseInt(process.env.TORRENTIO_STREAM_EMPTY_TTL || '60', 10) || 60);
const TORRENTIO_RESOLVED_URL_TTL = Math.max(60, Number.parseInt(process.env.TORRENTIO_RESOLVED_URL_TTL || String(3 * 60 * 60), 10) || (3 * 60 * 60));
const TORRENTIO_AVAILABILITY_TTL = Math.max(60, Number.parseInt(process.env.TORRENTIO_AVAILABILITY_TTL || String(5 * 24 * 60 * 60), 10) || (5 * 24 * 60 * 60));
const TORRENTIO_QUEUE_MAX_KEYS = Math.max(50, Number.parseInt(process.env.TORRENTIO_NAMED_QUEUE_MAX_KEYS || '200', 10) || 200);
const TORRENTIO_QUEUE_MAX_PENDING = Math.max(1, Number.parseInt(process.env.TORRENTIO_NAMED_QUEUE_MAX_PENDING || '200', 10) || 200);

function normalizeQueueKey(value = '') {
  const raw = String(value || '').replace(/\.json$/i, '').replace(/^ai-recs:/i, '').trim();
  return raw || 'unknown';
}

function createNamedQueue(maxKeys = TORRENTIO_QUEUE_MAX_KEYS) {
  const queues = new Map();
  const cap = Math.max(1, Number(maxKeys) || TORRENTIO_QUEUE_MAX_KEYS);
  let singleFlightHits = 0;
  let queued = 0;
  let evicted = 0;

  function trim() {
    while (queues.size > cap) {
      const oldest = queues.keys().next().value;
      if (oldest === undefined) break;
      const state = queues.get(oldest);
      if (state && state.pending > 0) break;
      queues.delete(oldest);
      evicted += 1;
    }
  }

  async function wrap(key, worker) {
    const queueKey = normalizeQueueKey(key);
    let state = queues.get(queueKey);
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0, lastUsedAt: Date.now() };
      queues.set(queueKey, state);
      trim();
    } else if (state.pending > 0) {
      singleFlightHits += 1;
    }

    state.pending += 1;
    queued += 1;
    state.lastUsedAt = Date.now();

    if (state.pending > TORRENTIO_QUEUE_MAX_PENDING) {
      state.pending = Math.max(0, state.pending - 1);
      const error = new Error(`Torrentio-style named queue overflow for ${queueKey}`);
      error.code = 'TORRENTIO_QUEUE_OVERFLOW';
      throw error;
    }

    const task = state.tail.catch(() => undefined).then(() => Promise.resolve().then(worker));
    state.tail = task.catch(() => undefined).finally(() => {
      state.pending = Math.max(0, state.pending - 1);
      state.lastUsedAt = Date.now();
      if (state.pending === 0 && queues.get(queueKey) === state) queues.delete(queueKey);
    });
    return task;
  }

  function stats() {
    return {
      activeKeys: queues.size,
      queued,
      singleFlightHits,
      evicted,
      maxKeys: cap,
      maxPendingPerKey: TORRENTIO_QUEUE_MAX_PENDING
    };
  }

  return { wrap, stats };
}

function buildTorrentioStreamRequestKey({ type, id, meta } = {}) {
  const normalizedId = normalizeQueueKey(id || meta?.imdb_id || meta?.kitsu_id || meta?.tmdb_id || 'unknown');
  const season = Number(meta?.season || 0) || 0;
  const episode = Number(meta?.episode || 0) || 0;
  return [String(type || 'stream').toLowerCase(), normalizedId, season, episode].join(':');
}

function hashPart(value, length = 12) {
  const raw = String(value || '').trim();
  if (!raw) return 'nohash';
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase().slice(0, length);
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, length);
}

function cleanPart(value, fallback = 'x') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[|]+/g, ' ')
    .replace(/[^a-z0-9+._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return normalized || fallback;
}

function normalizeTorrentioBingeGroup({ service, quality, hdr, codec, audio, language, group, infoHash, fileIdx } = {}) {
  return [
    'Leviathan',
    cleanPart(service, 'svc'),
    cleanPart(quality, 'q'),
    cleanPart(hdr, 'sdr'),
    cleanPart(codec, 'codec'),
    cleanPart(audio, 'audio'),
    cleanPart(language, 'lang'),
    cleanPart(group || (infoHash ? `hash-${hashPart(infoHash)}` : 'group'), 'group'),
    Number.isInteger(Number(fileIdx)) && Number(fileIdx) >= 0 ? `file-${Number(fileIdx)}` : 'file-auto'
  ].join('|');
}

function getText(stream = {}) {
  return [
    stream?.name,
    stream?.title,
    stream?.description,
    stream?.behaviorHints?.filename,
    stream?.behaviorHints?.bingeGroup,
    stream?.behaviorHints?.vortexMeta?.quality,
    stream?.behaviorHints?.vortexMeta?.seeders,
    stream?.behaviorHints?.seeders,
    stream?.seeders
  ].filter(Boolean).join(' ');
}

function getQualityTier(value = '') {
  const text = String(value || '').toLowerCase();
  if (/\b(?:4320p|8k)\b/.test(text)) return 5;
  if (/\b(?:2160p|4k|uhd)\b/.test(text)) return 4;
  if (/\b(?:1440p|2k|qhd)\b/.test(text)) return 3.5;
  if (/\b(?:1080p|1080i|fhd|full[-.\s]?hd)\b/.test(text)) return 3;
  if (/\b(?:720p|hd)\b/.test(text)) return 2;
  if (/\b(?:576p|480p|sd)\b/.test(text)) return 1;
  return 0;
}

function getSeeders(stream = {}) {
  const direct = [
    stream?.seeders,
    stream?.behaviorHints?.seeders,
    stream?.behaviorHints?.vortexMeta?.seeders,
    stream?.behaviorHints?.rankMeta?.seeders
  ];
  for (const value of direct) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const text = getText(stream);
  const matches = [
    text.match(/(?:👥|seeders?|seeds?|fonti)\s*[:：]?\s*(\d{1,6})/i),
    text.match(/(\d{1,6})\s*(?:seeders?|seeds?|fonti)\b/i)
  ].filter(Boolean);
  for (const match of matches) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function getSizeBytes(stream = {}) {
  const direct = [
    stream?.sizeBytes,
    stream?.size,
    stream?.folderSize,
    stream?.behaviorHints?.sizeBytes,
    stream?.behaviorHints?.fileSize,
    stream?.behaviorHints?.folderSize,
    stream?.behaviorHints?.vortexMeta?.sizeBytes
  ];
  for (const value of direct) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const match = getText(stream).match(/(\d+(?:[.,]\d+)?)\s*(tib|tb|gib|gb|mib|mb)\b/i);
  if (!match) return 0;
  const value = Number.parseFloat(String(match[1]).replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return 0;
  const unit = match[2].toLowerCase();
  if (unit === 'tib' || unit === 'tb') return value * 1024 ** 4;
  if (unit === 'gib' || unit === 'gb') return value * 1024 ** 3;
  return value * 1024 ** 2;
}

function getCacheTier(stream = {}) {
  const raw = String(stream?.cacheState || stream?.rdCacheState || stream?.behaviorHints?.cacheState || stream?.behaviorHints?.rdCacheState || '').toLowerCase();
  if (raw === 'cached') return 0;
  if (raw === 'likely_cached' || raw === 'probing' || raw === 'unknown') return 1;
  if (raw === 'likely_uncached') return 2;
  if (raw === 'uncached_terminal' || raw === 'download') return 3;
  const visibleText = `${stream?.name || ''}\n${stream?.title || ''}`;
  if (/⚡/.test(visibleText) && /\b(RD|TB)\b/i.test(visibleText)) return 0;
  if (/☁️/.test(visibleText) && /\b(RD|TB)\b/i.test(visibleText)) return 3;
  return 1;
}

function getTorrentioSortMeta(stream = {}, index = 0) {
  const text = getText(stream);
  return {
    stream,
    index,
    cacheTier: getCacheTier(stream),
    qualityTier: getQualityTier(text),
    seeders: getSeeders(stream),
    sizeBytes: getSizeBytes(stream),
    exactFile: Number.isInteger(Number(stream?.fileIdx ?? stream?.behaviorHints?.fileIdx)) && Number(stream?.fileIdx ?? stream?.behaviorHints?.fileIdx) >= 0 ? 1 : 0,
    rankScore: Number.isFinite(Number(stream?.behaviorHints?.rankScore)) ? Number(stream.behaviorHints.rankScore) : 0
  };
}

function sortTorrentioStyleStreams(streams = [], options = {}) {
  const list = Array.isArray(streams) ? streams : [];
  const mode = String(options.sortMode || 'quality').toLowerCase();
  return list
    .map(getTorrentioSortMeta)
    .sort((a, b) => {
      if (a.cacheTier !== b.cacheTier) return a.cacheTier - b.cacheTier;
      if (mode === 'size') {
        const sizeDelta = b.sizeBytes - a.sizeBytes;
        if (sizeDelta !== 0) return sizeDelta;
      }
      const qualityDelta = b.qualityTier - a.qualityTier;
      if (qualityDelta !== 0) return qualityDelta;
      const seedDelta = b.seeders - a.seeders;
      if (seedDelta !== 0) return seedDelta;
      const exactDelta = b.exactFile - a.exactFile;
      if (exactDelta !== 0) return exactDelta;
      const sizeDelta = b.sizeBytes - a.sizeBytes;
      if (sizeDelta !== 0) return sizeDelta;
      const rankDelta = b.rankScore - a.rankScore;
      if (rankDelta !== 0) return rankDelta;
      return a.index - b.index;
    })
    .map((entry) => entry.stream);
}

function buildTorrentioLayeredCachePolicy(basePolicy = {}, context = {}) {
  const finalStreams = Array.isArray(context.finalStreams) ? context.finalStreams : [];
  const enabled = context.torrentPipelineEnabled === true || context.cacheScope === 'torrent';
  if (!enabled) return basePolicy;

  if (finalStreams.length === 0) {
    return {
      ...basePolicy,
      localTtl: Math.min(Math.max(Number(basePolicy.localTtl || 0) || TORRENTIO_STREAM_EMPTY_TTL, 1), TORRENTIO_STREAM_EMPTY_TTL),
      sharedTtl: 0,
      staleGraceTtl: Math.min(Number(basePolicy.staleGraceTtl || 0) || 0, TORRENTIO_STREAM_EMPTY_TTL),
      allowSharedWrite: false,
      torrentioCacheLayer: 'empty'
    };
  }

  const confidence = Number(basePolicy.confidenceScore || 0) || 0;
  const allowShared = basePolicy.allowSharedWrite !== false && context.sourceModeFlags?.useSharedCache !== false && !basePolicy.sharedFreshSkip;
  return {
    ...basePolicy,
    localTtl: Math.max(Number(basePolicy.localTtl || 0) || 0, TORRENTIO_STREAM_MEM_TTL),
    sharedTtl: allowShared ? Math.max(Number(basePolicy.sharedTtl || 0) || 0, confidence >= 55 ? TORRENTIO_STREAM_SHARED_TTL : Math.floor(TORRENTIO_STREAM_SHARED_TTL / 3)) : 0,
    staleGraceTtl: allowShared ? Math.max(Number(basePolicy.staleGraceTtl || 0) || 0, Math.min(12 * 60 * 60, TORRENTIO_STREAM_SHARED_TTL)) : 0,
    allowSharedWrite: allowShared,
    allowSharedStale: allowShared ? true : basePolicy.allowSharedStale,
    torrentioCacheLayer: 'stream'
  };
}

function normalizeTorrentioSources(item = {}) {
  const values = [];
  const push = (entry) => {
    const value = String(entry || '').trim();
    if (!value) return;
    if (/^(tracker:|dht:|udp:\/\/|https?:\/\/|wss?:\/\/)/i.test(value)) values.push(value.startsWith('tracker:') || value.startsWith('dht:') ? value : `tracker:${value}`);
  };
  for (const entry of Array.isArray(item?.sources) ? item.sources : []) push(entry);
  const magnet = String(item?.magnet || item?.magnetLink || '').trim();
  const regex = /[?&]tr=([^&]+)/gi;
  let match;
  while ((match = regex.exec(magnet)) !== null) {
    try { push(decodeURIComponent(match[1])); } catch (_) {}
  }
  const hash = String(item?.hash || item?.infoHash || '').trim().toUpperCase();
  if (/^[A-F0-9]{40}$/.test(hash)) values.push(`dht:${hash}`);
  return [...new Set(values)].slice(0, 32);
}

const streamRequestQueue = createNamedQueue(TORRENTIO_QUEUE_MAX_KEYS);

module.exports = {
  TORRENTIO_STREAM_SHARED_TTL,
  TORRENTIO_STREAM_MEM_TTL,
  TORRENTIO_STREAM_EMPTY_TTL,
  TORRENTIO_RESOLVED_URL_TTL,
  TORRENTIO_AVAILABILITY_TTL,
  createNamedQueue,
  streamRequestQueue,
  buildTorrentioStreamRequestKey,
  normalizeTorrentioBingeGroup,
  sortTorrentioStyleStreams,
  getTorrentioSortMeta,
  buildTorrentioLayeredCachePolicy,
  normalizeTorrentioSources
};
