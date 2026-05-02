'use strict';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(value) {
  const input = String(value || '').replace(/=+$/g, '').toUpperCase();
  let bits = '';
  let hex = '';

  for (const char of input) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) return null;
    bits += idx.toString(2).padStart(5, '0');
  }

  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }

  return /^[a-f0-9]{40}$/i.test(hex) ? hex.toUpperCase() : null;
}

function normalizeInfoHash(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value || '').trim();
  if (!raw) return null;

  const btih = raw.match(/(?:urn:)?btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
  if (btih) return normalizeInfoHash(btih[1]);

  const dht = raw.match(/^dht:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})$/i);
  if (dht) return normalizeInfoHash(dht[1]);

  if (/^[A-Fa-f0-9]{40}$/.test(raw)) return raw.toUpperCase();
  if (/^[A-Za-z2-7]{32}$/.test(raw)) return base32ToHex(raw);

  return null;
}

function pushCandidate(candidates, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) pushCandidate(candidates, item);
    return;
  }
  if (typeof value === 'object') {
    pushCandidate(candidates, value.infoHash);
    pushCandidate(candidates, value.infohash);
    pushCandidate(candidates, value.info_hash);
    pushCandidate(candidates, value.hash);
    pushCandidate(candidates, value.btih);
    pushCandidate(candidates, value.magnet);
    pushCandidate(candidates, value.magnetLink);
    pushCandidate(candidates, value.url);
    return;
  }
  const text = String(value || '').trim();
  if (text) candidates.push(text);
}

function extractInfoHash(item = {}) {
  const candidates = [];

  pushCandidate(candidates, item.infoHash);
  pushCandidate(candidates, item.infohash);
  pushCandidate(candidates, item.info_hash);
  pushCandidate(candidates, item.hash);
  pushCandidate(candidates, item.btih);
  pushCandidate(candidates, item.magnet);
  pushCandidate(candidates, item.magnetLink);
  pushCandidate(candidates, item.url);
  pushCandidate(candidates, item.directUrl);
  pushCandidate(candidates, item.externalDirectUrl);
  pushCandidate(candidates, item._externalDirectUrl);
  pushCandidate(candidates, item.sources);
  pushCandidate(candidates, item.behaviorHints?.infoHash);
  pushCandidate(candidates, item.behaviorHints?.infohash);
  pushCandidate(candidates, item.behaviorHints?.info_hash);
  pushCandidate(candidates, item.behaviorHints?.hash);
  pushCandidate(candidates, item.behaviorHints?.btih);
  pushCandidate(candidates, item.behaviorHints?.magnet);
  pushCandidate(candidates, item.behaviorHints?.sources);

  for (const candidate of candidates) {
    const normalized = normalizeInfoHash(candidate);
    if (normalized) return normalized;
  }

  return null;
}

function cacheTier(item = {}) {
  const state = String(item?._rdCacheState || item?.rdCacheState || item?.cacheState || '').toLowerCase();
  if (item?._dbCachedRd === true || item?.cached_rd === true || item?._tbCached === true || /⚡/.test(`${item?.name || ''} ${item?.title || ''}`) || state === 'cached') return 5;
  if (state === 'likely_cached') return 4;
  if (state === 'probing') return 2;
  if (state === 'likely_uncached') return 1;
  if (state === 'uncached_terminal') return 0;
  return 3;
}

function sourcePriority(item = {}) {
  const text = String(`${item?.source || ''} ${item?.provider || ''} ${item?.externalAddon || ''} ${item?.externalGroup || ''} ${item?.name || ''} ${item?.title || ''}`).toLowerCase();
  if (/torrentio/.test(text)) return 40;
  if (/mediafusion/.test(text)) return 20;
  if (/db|database|saved/.test(text)) return 5;
  return 10;
}

function playablePriority(item = {}) {
  const url = String(item?.url || '');
  if (/^https?:\/\//i.test(url) && !/\/play_lazy\//i.test(url)) return 20;
  if (url) return 5;
  return 0;
}

function getSeederCount(item = {}) {
  const explicit = parseInt(item?.seeders ?? item?.peers ?? item?.seeds ?? item?.seedCount ?? '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const text = `${item?.name || ''}\n${item?.title || ''}`;
  const match = text.match(/(?:👥|seed(?:er)?s?\s*[:=]?|seeds?\s*[:=]?)\s*([0-9]{1,6})/i);
  return match ? parseInt(match[1], 10) || 0 : 0;
}

function getSizeBytes(item = {}) {
  const numeric = [item?._size, item?.sizeBytes, item?.fileSize, item?.file_size, item?.mainFileSize, item?.size]
    .find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (numeric) return numeric;
  return 0;
}

function choiceScore(item = {}) {
  const explicitScore = Number(item?._compositeScore || item?._score || item?._dedupeScore || 0) || 0;
  return cacheTier(item) * 1_000_000
    + sourcePriority(item) * 10_000
    + playablePriority(item) * 1_000
    + Math.min(5000, Math.max(0, getSeederCount(item))) * 5
    + Math.min(5000, Math.floor((getSizeBytes(item) || 0) / (1024 * 1024)))
    + Math.max(-100000, Math.min(100000, explicitScore));
}

function preferItem(next, current) {
  const nextScore = choiceScore(next);
  const currentScore = choiceScore(current);
  if (nextScore !== currentScore) return nextScore > currentScore;
  const nextSize = getSizeBytes(next);
  const currentSize = getSizeBytes(current);
  if (nextSize !== currentSize) return nextSize > currentSize;
  return false;
}

function mergeSignals(winner = {}, loser = {}, hash = null) {
  const out = { ...winner };
  const normalizedHash = hash || extractInfoHash(winner) || extractInfoHash(loser);

  if (normalizedHash) {
    out.infoHash = out.infoHash || normalizedHash;
    out.hash = out.hash || normalizedHash;
  }
  if ((out.fileIdx === undefined || out.fileIdx === null || out.fileIdx === -1) && loser?.fileIdx !== undefined && loser?.fileIdx !== null) out.fileIdx = loser.fileIdx;
  if ((!out.episodeFileHint || typeof out.episodeFileHint !== 'object') && loser?.episodeFileHint) out.episodeFileHint = loser.episodeFileHint;
  if ((!out._episodeFileHint || typeof out._episodeFileHint !== 'object') && loser?._episodeFileHint) out._episodeFileHint = loser._episodeFileHint;
  if (!out._rdCacheState && loser?._rdCacheState) out._rdCacheState = loser._rdCacheState;
  if (!out.rdCacheState && loser?.rdCacheState) out.rdCacheState = loser.rdCacheState;
  if (!out.cacheState && loser?.cacheState) out.cacheState = loser.cacheState;
  if (out._dbCachedRd !== true && loser?._dbCachedRd === true) out._dbCachedRd = true;
  if (out.cached_rd !== true && loser?.cached_rd === true) out.cached_rd = true;
  if (out._tbCached !== true && loser?._tbCached === true) out._tbCached = true;
  return out;
}

function dedupeByInfoHash(items = [], options = {}) {
  const list = Array.isArray(items) ? items : [];
  const enabledValue = options.enabled !== undefined ? options.enabled : process.env.INFOHASH_DEDUPE;
  if (String(enabledValue ?? '1') === '0' || list.length < 2) {
    return { results: list, removed: 0, groups: 0 };
  }

  const kept = [];
  const hashToIndex = new Map();
  let removed = 0;
  let groups = 0;

  for (const item of list) {
    const hash = extractInfoHash(item);
    if (!hash) {
      kept.push(item);
      continue;
    }

    const existingIndex = hashToIndex.get(hash);
    if (existingIndex === undefined) {
      hashToIndex.set(hash, kept.length);
      kept.push(mergeSignals(item, {}, hash));
      continue;
    }

    removed += 1;
    groups += 1;
    const current = kept[existingIndex];
    if (preferItem(item, current)) {
      kept[existingIndex] = mergeSignals(item, current, hash);
    } else {
      kept[existingIndex] = mergeSignals(current, item, hash);
    }
  }

  return { results: kept, removed, groups };
}

module.exports = {
  normalizeInfoHash,
  extractInfoHash,
  dedupeByInfoHash
};
