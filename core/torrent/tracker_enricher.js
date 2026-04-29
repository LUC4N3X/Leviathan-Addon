'use strict';

const { getActiveTrackers, DEFAULT_TRACKERS } = require('../storage/tracker_registry');

const DEFAULTS = Object.freeze({
  enabled: String(process.env.TRACKER_ENRICHER_ENABLED || 'true').toLowerCase() !== 'false',
  maxTrackers: Math.max(4, Math.min(64, parseInt(process.env.TRACKER_ENRICHER_MAX_TRACKERS || '24', 10) || 24)),
  minTrackers: Math.max(0, Math.min(32, parseInt(process.env.TRACKER_ENRICHER_MIN_TRACKERS || '8', 10) || 8)),
  addDhtSource: String(process.env.TRACKER_ENRICHER_ADD_DHT || 'true').toLowerCase() !== 'false'
});

const ANIME_TRACKERS = Object.freeze([
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce'
]);

function normalizeHash(value) {
  const raw = String(value || '').trim();
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toUpperCase();
  return null;
}

function extractInfoHashFromMagnet(magnet) {
  const text = String(magnet || '');
  const match = text.match(/btih:([a-f0-9]{40})/i);
  return match ? normalizeHash(match[1]) : null;
}

function getItemHash(item = {}) {
  return normalizeHash(item?.hash) || normalizeHash(item?.infoHash) || normalizeHash(item?.info_hash) || extractInfoHashFromMagnet(item?.magnet || item?.magnetLink);
}

function decodeComponentSafe(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch (_) { return String(value || ''); }
}

function normalizeTracker(value) {
  const clean = decodeComponentSafe(value).trim();
  if (!/^(udp|http|https):\/\//i.test(clean)) return null;
  return clean;
}

function getTrackersFromMagnet(magnet) {
  const out = [];
  const text = String(magnet || '');
  const re = /[?&]tr=([^&]+)/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const tracker = normalizeTracker(match[1]);
    if (tracker) out.push(tracker);
  }
  return out;
}

function uniqueTrackers(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const tracker = normalizeTracker(value);
    if (!tracker) continue;
    const key = tracker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tracker);
  }
  return out;
}

function isAnimeContext(meta = {}, type = '') {
  return Boolean(meta?.kitsu_id || meta?.isAnime || String(type || '').toLowerCase() === 'anime');
}

function buildEnrichedMagnet(hash, displayName, trackers = []) {
  const cleanHash = getItemHash({ hash });
  if (!cleanHash) return null;
  const params = [`xt=urn:btih:${cleanHash}`];
  const dn = String(displayName || '').trim();
  if (dn) params.push(`dn=${encodeURIComponent(dn.slice(0, 180))}`);
  for (const tracker of trackers) params.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${params.join('&')}`;
}

function getTrackerPool(meta = {}, type = '', options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  let active = [];
  try { active = getActiveTrackers(); } catch (_) { active = []; }
  const base = Array.isArray(active) && active.length > 0 ? active : DEFAULT_TRACKERS;
  const pool = isAnimeContext(meta, type) ? [...ANIME_TRACKERS, ...base] : base;
  return uniqueTrackers(pool).slice(0, cfg.maxTrackers);
}

function enrichTorrentTrackers(items = [], meta = {}, type = '', options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const list = Array.isArray(items) ? items : [];
  if (!cfg.enabled || list.length === 0) return list;

  const pool = getTrackerPool(meta, type, cfg);
  if (pool.length === 0) return list;

  let touched = 0;
  const output = list.map((item) => {
    const hash = getItemHash(item);
    if (!hash) return item;
    const originalMagnet = item?.magnet || item?.magnetLink || '';
    const existing = getTrackersFromMagnet(originalMagnet);
    const needsEnrichment = !/^magnet:\?/i.test(String(originalMagnet || '')) || existing.length < cfg.minTrackers;
    if (!needsEnrichment) {
      const sources = Array.isArray(item?.sources) ? item.sources : [];
      if (cfg.addDhtSource && !sources.some((source) => String(source).toLowerCase() === `dht:${hash.toLowerCase()}`)) {
        return { ...item, hash, infoHash: item?.infoHash || hash, sources: [...sources, `dht:${hash}`] };
      }
      return item;
    }

    const trackers = uniqueTrackers([...existing, ...pool]).slice(0, cfg.maxTrackers);
    const magnet = buildEnrichedMagnet(hash, item?.title || item?.name || item?.filename, trackers);
    if (!magnet) return item;
    touched += 1;
    const sources = Array.isArray(item?.sources) ? [...item.sources] : [];
    for (const tracker of trackers) {
      const source = `tracker:${tracker}`;
      if (!sources.some((entry) => String(entry).toLowerCase() === source.toLowerCase())) sources.push(source);
    }
    if (cfg.addDhtSource && !sources.some((source) => String(source).toLowerCase() === `dht:${hash.toLowerCase()}`)) sources.push(`dht:${hash}`);

    return {
      ...item,
      magnet,
      magnetLink: item?.magnetLink || magnet,
      hash,
      infoHash: item?.infoHash || hash,
      sources,
      _trackerEnriched: true,
      _trackerCount: trackers.length
    };
  });

  const logger = options?.logger;
  if (touched > 0 && logger && typeof logger.info === 'function') {
    logger.info(`[TRACKERS] enriched items=${touched}/${list.length} max=${cfg.maxTrackers} anime=${isAnimeContext(meta, type)} dht=${cfg.addDhtSource}`);
  }

  return output;
}

module.exports = {
  DEFAULTS,
  ANIME_TRACKERS,
  getItemHash,
  getTrackersFromMagnet,
  getTrackerPool,
  enrichTorrentTrackers,
  buildEnrichedMagnet
};
