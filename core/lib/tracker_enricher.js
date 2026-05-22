'use strict';

let trackerRegistry = null;
try {
  trackerRegistry = require('../storage/tracker_registry');
} catch (_) {
  trackerRegistry = null;
}

const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.therarbg.to:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.dler.org:6969/announce'
];

const MAX_TRACKERS = 24;

function base32ToHex(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  let hex = '';
  const input = String(base32 || '').replace(/=+$/g, '').toUpperCase();
  for (const ch of input) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function normalizeInfoHash(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toUpperCase();
  if (/^[a-z2-7]{32}$/i.test(raw)) {
    const hex = base32ToHex(raw);
    return hex && /^[a-f0-9]{40}$/i.test(hex) ? hex.toUpperCase() : null;
  }
  return null;
}

function extractHashFromMagnet(value) {
  const text = String(value || '');
  const match = text.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
  return match ? normalizeInfoHash(match[1]) : null;
}

function extractInfoHash(item = {}) {
  return normalizeInfoHash(item?.hash)
    || normalizeInfoHash(item?.infoHash)
    || extractHashFromMagnet(item?.magnet)
    || extractHashFromMagnet(item?.magnetLink)
    || extractHashFromMagnet(item?.url)
    || null;
}

function extractTrackersFromMagnet(value) {
  const text = String(value || '');
  if (!/^magnet:/i.test(text)) return [];
  const out = [];
  const regex = /[?&]tr=([^&]+)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]).trim();
      if (/^(udp|http|https|ws|wss):\/\//i.test(decoded)) out.push(decoded);
    } catch (_) {}
  }
  return out;
}

function buildTrackerMagnetLocal(hash, trackers = []) {
  const cleanHash = normalizeInfoHash(hash);
  if (!cleanHash) return null;
  if (trackerRegistry && typeof trackerRegistry.buildMagnet === 'function') {
    const built = trackerRegistry.buildMagnet(cleanHash, trackers);
    if (built) return built;
  }
  const params = [`xt=urn:btih:${cleanHash}`];
  for (const tracker of uniqueTrackers(trackers)) params.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${params.join('&')}`;
}
function uniqueTrackers(list = []) {
  const seen = new Set();
  const out = [];
  for (const tracker of list) {
    const value = String(tracker || '').trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_TRACKERS) break;
  }
  return out;
}

function isDirectPlayableUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function getRuntimeTrackers() {
  const active = typeof trackerRegistry?.getActiveTrackers === 'function' ? trackerRegistry.getActiveTrackers() : [];
  const defaults = Array.isArray(trackerRegistry?.DEFAULT_TRACKERS) ? trackerRegistry.DEFAULT_TRACKERS : FALLBACK_TRACKERS;
  return uniqueTrackers([...(Array.isArray(active) ? active : []), ...defaults, ...FALLBACK_TRACKERS]);
}

function enrichTorrentItem(item = {}) {
  if (!item || typeof item !== 'object') return item;
  const hash = extractInfoHash(item);
  if (!hash) return item;

  const existingMagnet = String(item.magnet || item.magnetLink || '').trim();
  const directUrl = isDirectPlayableUrl(item.directUrl || item.url || item._externalDirectUrl || item.externalDirectUrl)
    ? String(item.directUrl || item.url || item._externalDirectUrl || item.externalDirectUrl).trim()
    : null;
  const existingTrackers = extractTrackersFromMagnet(existingMagnet);
  const trackers = uniqueTrackers([...existingTrackers, ...getRuntimeTrackers()]);
  const enrichedMagnet = buildTrackerMagnetLocal(hash, trackers) || existingMagnet;
  const shouldReplaceMagnet = !directUrl && (!existingMagnet || /^magnet:/i.test(existingMagnet));

  const next = {
    ...item,
    hash,
    infoHash: hash,
    _trackerEnriched: true,
    _trackerCount: trackers.length,
    _trackerAdded: Math.max(0, trackers.length - existingTrackers.length)
  };

  if (shouldReplaceMagnet && enrichedMagnet) next.magnet = enrichedMagnet;
  if (!next.magnetLink && /^magnet:/i.test(next.magnet || '')) next.magnetLink = next.magnet;
  if (!Array.isArray(next.sources) || next.sources.length === 0) {
    next.sources = trackers.map((tracker) => `tracker:${tracker}`);
    next.sources.push(`dht:${hash}`);
  }

  return next;
}

function enrichTorrentItems(items = []) {
  const input = Array.isArray(items) ? items : [];
  let enriched = 0;
  let trackersAdded = 0;
  const results = input.map((item) => {
    const beforeTrackers = Number(item?._trackerCount || 0) || extractTrackersFromMagnet(item?.magnet || item?.magnetLink).length;
    const next = enrichTorrentItem(item);
    if (next?._trackerEnriched) {
      enriched += 1;
      trackersAdded += Math.max(0, Number(next._trackerCount || 0) - beforeTrackers);
    }
    return next;
  });

  return {
    results,
    stats: {
      total: input.length,
      enriched,
      trackersAdded,
      maxTrackers: MAX_TRACKERS
    }
  };
}

module.exports = {
  MAX_TRACKERS,
  enrichTorrentItem,
  enrichTorrentItems,
  extractInfoHash,
  extractTrackersFromMagnet,
  normalizeInfoHash,
  uniqueTrackers
};
