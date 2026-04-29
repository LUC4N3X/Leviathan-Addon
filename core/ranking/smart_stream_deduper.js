'use strict';

const DEFAULTS = Object.freeze({
  enabled: String(process.env.SMART_STREAM_DEDUP_ENABLED || 'true').toLowerCase() !== 'false',
  exactTitleEnabled: String(process.env.SMART_DEDUP_EXACT_TITLE_ENABLED || 'true').toLowerCase() !== 'false',
  smartDetectEnabled: String(process.env.SMART_DEDUP_SMART_DETECT_ENABLED || 'true').toLowerCase() !== 'false',
  minTitleLength: Math.max(8, parseInt(process.env.SMART_DEDUP_MIN_TITLE_LENGTH || '14', 10) || 14),
  sizeBucketMb: Math.max(4, parseInt(process.env.SMART_DEDUP_SIZE_BUCKET_MB || '16', 10) || 16),
  smartSizeBucketMb: Math.max(16, parseInt(process.env.SMART_DEDUP_SMART_SIZE_BUCKET_MB || '96', 10) || 96),
  minTokenOverlap: Math.max(0.75, Math.min(1, Number(process.env.SMART_DEDUP_MIN_TOKEN_OVERLAP || '0.92') || 0.92))
});

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeHash(value) {
  const raw = String(value || '').trim().toUpperCase();
  const match = raw.match(/[A-F0-9]{40}/i);
  return match ? match[0].toUpperCase() : null;
}

function normalizeFileIdx(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function getSizeBytes(item = {}) {
  return Math.max(0, toNumber(item?._size, 0), toNumber(item?.sizeBytes, 0), toNumber(item?.mainFileSize, 0));
}

function getSeeders(item = {}) {
  return Math.max(0, parseInt(item?.seeders ?? item?.seeds ?? item?.seedCount ?? item?.torrent?.seeders ?? 0, 10) || 0);
}

function getCacheWeight(item = {}) {
  const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').toLowerCase();
  if (item?.directUrl || item?._externalDirectUrl || item?.externalDirectUrl) return 50000;
  if (item?._tbCached === true || item?.tbCached === true) return 45000;
  if (item?._dbCachedRd === true || item?.cached_rd === true || state === 'cached') return 43000;
  if (state === 'likely_cached' || state === 'probing') return 16000;
  return 0;
}

function getScore(item = {}) {
  return toNumber(item?._score, 0) + getCacheWeight(item) + Math.min(getSeeders(item), 500) * 30;
}

function textForItem(item = {}) {
  return [
    item?.filename,
    item?.fileName,
    item?.file_title,
    item?.title,
    item?.name,
    item?.rawTitle,
    item?.torrent?.title,
    item?.torrent?.name
  ].filter(Boolean).join(' ');
}

function normalizeTitle(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(?:👤|👥|💾|🧲|📦|✅|❌|🔥|⚡|⭐|🌐|🎬|📺)\b/g, ' ')
    .replace(/\[[^\]]{1,24}\]/g, ' ')
    .replace(/\([^)]{1,24}\)/g, ' ')
    .replace(/\b(?:size|seeders?|seeds?|cached|real\s*debrid|torbox|torrentio|mediafusion|leviathan|p2p|rd|tb)\b/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kb|mb|gb|tb)\b/gi, ' ')
    .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value = '') {
  return new Set(normalizeTitle(value).split(/\s+/).filter((token) => token.length >= 2));
}

function tokenOverlap(a = '', b = '') {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const token of left) if (right.has(token)) matches += 1;
  return matches / Math.min(left.size, right.size);
}

function detectCodec(value = '') {
  const text = String(value || '').toLowerCase();
  if (/\b(?:av1|aom)\b/.test(text)) return 'av1';
  if (/\b(?:hevc|h\.?265|x265)\b/.test(text)) return 'h265';
  if (/\b(?:avc|h\.?264|x264)\b/.test(text)) return 'h264';
  if (/\bvp9\b/.test(text)) return 'vp9';
  return 'unknown';
}

function detectResolution(value = '') {
  const text = String(value || '').toLowerCase();
  if (/\b(?:2160p|4k|uhd)\b/.test(text)) return '2160p';
  if (/\b(?:1080p|fhd|full\s*hd)\b/.test(text)) return '1080p';
  if (/\b720p\b/.test(text)) return '720p';
  if (/\b(?:480p|576p|sd)\b/.test(text)) return 'sd';
  return 'unknown';
}

function detectSource(value = '') {
  const text = String(value || '').toLowerCase();
  if (/\bremux\b/.test(text)) return 'remux';
  if (/\b(?:blu[-.\s]?ray|bdrip|brrip)\b/.test(text)) return 'bluray';
  if (/\bweb[-.\s]?dl\b/.test(text)) return 'webdl';
  if (/\bwebrip\b/.test(text)) return 'webrip';
  if (/\bhdtv\b/.test(text)) return 'hdtv';
  if (/\b(?:cam|hdcam|telesync|\bts\b)\b/.test(text)) return 'cam';
  return 'unknown';
}

function detectReleaseGroup(item = {}) {
  const title = String(item?.title || item?.filename || '');
  const source = String(item?.source || item?.provider || '');
  const suffix = title.match(/-([A-Za-z0-9_]{2,20})(?:\s|$)/);
  if (suffix?.[1]) return suffix[1].toLowerCase();
  const trusted = `${title} ${source}`.match(/\b(?:mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo|rarbg|yts|yify|qxr|tgx|galaxyrg|framestor|epsilon|ntb|ctrlhd|flux|playweb)\b/i);
  return trusted?.[0] ? trusted[0].toLowerCase() : 'generic';
}

function episodeKey(meta = {}, item = {}) {
  const season = Number(meta?.season || item?.season || 0) || 0;
  const episode = Number(meta?.episode || item?.episode || 0) || 0;
  if (season > 0 || episode > 0) return `s${season}e${episode}`;
  return 'movie';
}

function sizeBucket(sizeBytes, mb) {
  const value = Math.max(0, Number(sizeBytes || 0) || 0);
  if (value <= 0) return 'nosize';
  const bucket = Math.max(1, Number(mb || DEFAULTS.sizeBucketMb) || DEFAULTS.sizeBucketMb) * 1024 * 1024;
  return String(Math.round(value / bucket));
}

function buildKeys(item = {}, meta = {}, cfg = DEFAULTS) {
  const keys = [];
  const hash = normalizeHash(item?.hash || item?.infoHash || item?.magnet || item?.url);
  const fileIdx = normalizeFileIdx(item?.fileIdx ?? item?.file_index ?? item?.fileId);
  if (hash && fileIdx !== null) keys.push(`hashfile:${hash}:${fileIdx}`);

  const text = textForItem(item);
  const normalized = normalizeTitle(text);
  const size = getSizeBytes(item);

  if (cfg.exactTitleEnabled && normalized.length >= cfg.minTitleLength) {
    keys.push(`title:${episodeKey(meta, item)}:${normalized}:${sizeBucket(size, cfg.sizeBucketMb)}`);
  }

  if (cfg.smartDetectEnabled && normalized.length >= cfg.minTitleLength && size > 0) {
    const source = detectSource(text);
    const codec = detectCodec(text);
    const resolution = detectResolution(text);
    const group = detectReleaseGroup(item);
    if (group !== 'generic' || source !== 'unknown') {
      keys.push(`smart:${episodeKey(meta, item)}:${resolution}:${source}:${codec}:${group}:${sizeBucket(size, cfg.smartSizeBucketMb)}`);
    }
  }

  return keys;
}

function mergeDuplicateSignals(preferred = {}, duplicate = {}) {
  const merged = { ...preferred };
  const providers = new Set();
  for (const item of [preferred, duplicate]) {
    for (const value of [item?.source, item?.provider, item?.externalAddon, ...(Array.isArray(item?._mergedProviders) ? item._mergedProviders : [])]) {
      const text = String(value || '').trim();
      if (text) providers.add(text);
    }
  }
  if (providers.size > 0) merged._mergedProviders = [...providers];
  merged._dedupMerged = (Number(preferred?._dedupMerged || 0) || 0) + 1 + (Number(duplicate?._dedupMerged || 0) || 0);

  const copyIfMissing = ['directUrl', '_externalDirectUrl', 'externalDirectUrl', 'url', 'fileIdx', 'fileId', 'filename', 'fileName', 'sizeBytes', '_size'];
  for (const field of copyIfMissing) {
    if ((merged[field] === undefined || merged[field] === null || merged[field] === '' || merged[field] === 0) && duplicate[field] !== undefined && duplicate[field] !== null && duplicate[field] !== '') {
      merged[field] = duplicate[field];
    }
  }
  if (!merged._tbCached && duplicate?._tbCached) merged._tbCached = true;
  if (!merged._dbCachedRd && duplicate?._dbCachedRd) merged._dbCachedRd = true;
  if (!merged.cached_rd && duplicate?.cached_rd) merged.cached_rd = true;
  const state = String(merged?._rdCacheState || merged?.rdCacheState || '').toLowerCase();
  const dupState = String(duplicate?._rdCacheState || duplicate?.rdCacheState || '').toLowerCase();
  if (!state && dupState) {
    merged._rdCacheState = dupState;
    merged.rdCacheState = dupState;
  }
  return merged;
}

function chooseWinner(a = {}, b = {}) {
  const scoreA = getScore(a);
  const scoreB = getScore(b);
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
  const seedDelta = getSeeders(a) - getSeeders(b);
  if (seedDelta !== 0) return seedDelta > 0 ? a : b;
  return getSizeBytes(a) >= getSizeBytes(b) ? a : b;
}

function itemsCompatibleForSmartDedupe(existing = {}, candidate = {}, cfg = DEFAULTS) {
  const a = textForItem(existing);
  const b = textForItem(candidate);
  const overlap = tokenOverlap(a, b);
  if (overlap >= cfg.minTokenOverlap) return true;
  const groupA = detectReleaseGroup(existing);
  const groupB = detectReleaseGroup(candidate);
  return groupA !== 'generic' && groupA === groupB && detectResolution(a) === detectResolution(b) && detectSource(a) === detectSource(b);
}

function applySmartStreamDedup(items = [], meta = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const list = Array.isArray(items) ? items : [];
  if (!cfg.enabled || list.length <= 1) return list;

  const selected = [];
  const keyIndex = new Map();
  let removed = 0;
  const byReason = { hashfile: 0, title: 0, smart: 0 };

  for (const item of list) {
    const keys = buildKeys(item, meta, cfg);
    let matchIndex = -1;
    let matchReason = null;

    for (const key of keys) {
      const idx = keyIndex.get(key);
      if (idx === undefined) continue;
      const reason = key.split(':', 1)[0];
      if (reason === 'smart' && !itemsCompatibleForSmartDedupe(selected[idx], item, cfg)) continue;
      matchIndex = idx;
      matchReason = reason;
      break;
    }

    if (matchIndex < 0) {
      const newIndex = selected.length;
      selected.push(item);
      for (const key of keys) keyIndex.set(key, newIndex);
      continue;
    }

    const existing = selected[matchIndex];
    const winner = chooseWinner(existing, item);
    const loser = winner === existing ? item : existing;
    selected[matchIndex] = mergeDuplicateSignals(winner, loser);
    for (const key of buildKeys(selected[matchIndex], meta, cfg)) keyIndex.set(key, matchIndex);
    removed += 1;
    byReason[matchReason] = (byReason[matchReason] || 0) + 1;
  }

  const logger = options?.logger;
  if (logger && typeof logger.info === 'function') {
    logger.info(`[SMART DEDUP] input=${list.length} output=${selected.length} removed=${removed} hashfile=${byReason.hashfile || 0} title=${byReason.title || 0} smart=${byReason.smart || 0}`);
  }

  return selected;
}

module.exports = {
  DEFAULTS,
  normalizeTitle,
  tokenOverlap,
  applySmartStreamDedup
};
