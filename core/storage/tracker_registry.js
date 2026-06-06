'use strict';

const axios = require('axios');

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function clampFloat(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, normalized));
}

const CORE_TRACKERS = Object.freeze([
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonoid.ch:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.therarbg.to:6969/announce',
  'udp://tracker.doko.moe:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.dler.org:6969/announce'
]);

const DEFAULT_TRACKERS = [...CORE_TRACKERS];

const DEFAULT_SOURCE_URLS = Object.freeze([
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_udp.txt',
  'https://ngosang.github.io/trackerslist/trackers_best.txt'
]);

const TRACKER_PROTOCOL_RE = /^(udp|https?|wss?):\/\/.+/i;

function resolveSourceUrls() {
  const raw = String(process.env.TRACKER_LIST_URLS || '').trim();
  if (!raw) return [...DEFAULT_SOURCE_URLS];
  const parsed = raw
    .split(/[\s,]+/g)
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value));
  return parsed.length > 0 ? parsed : [...DEFAULT_SOURCE_URLS];
}

const SOURCE_URLS = resolveSourceUrls();
const TRACKER_REFRESH_MS = Math.round(clampFloat(process.env.TRACKER_REFRESH_HOURS, 6, 0.25, 168) * 60 * 60 * 1000);
const TRACKER_FETCH_TIMEOUT_MS = clampInt(process.env.TRACKER_FETCH_TIMEOUT_MS, 5000, 1000, 30000);
const TRACKER_ACTIVE_MAX = clampInt(process.env.TRACKER_ACTIVE_MAX, 80, 8, 400);
const MAGNET_MAX_TRACKERS = clampInt(process.env.TRACKER_MAGNET_MAX, 30, 1, 100);

function normalizeInfoHash(infoHash) {
  if (!infoHash) return null;
  const normalized = String(infoHash).trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function isValidTracker(value) {
  return typeof value === 'string' && TRACKER_PROTOCOL_RE.test(value.trim());
}

function dedupeTrackers(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const value = String(entry || '').trim();
    if (!isValidTracker(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function capTrackers(list, max) {
  const limit = clampInt(max, MAGNET_MAX_TRACKERS, 1, 1000);
  if (!Array.isArray(list)) return [];
  return list.length > limit ? list.slice(0, limit) : list;
}

function normalizeTrackerList(raw) {
  if (typeof raw !== 'string') return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return dedupeTrackers(lines);
}

function mergeTrackerSources(core, fetchedLists, max = TRACKER_ACTIVE_MAX) {
  const merged = [...(Array.isArray(core) ? core : [])];
  for (const list of Array.isArray(fetchedLists) ? fetchedLists : []) {
    if (Array.isArray(list)) merged.push(...list);
  }
  return capTrackers(dedupeTrackers(merged), max);
}

let activeTrackers = capTrackers(dedupeTrackers(CORE_TRACKERS), TRACKER_ACTIVE_MAX);
let refreshHandle = null;
let refreshPromise = null;
let lastRefreshAt = null;
let lastRefreshOk = null;
let lastSourceCount = 0;

async function fetchTrackerSource(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      timeout: TRACKER_FETCH_TIMEOUT_MS,
      responseType: 'text',
      headers: { 'User-Agent': 'stremio-leviathan-tracker-registry/2.0' }
    });
    return normalizeTrackerList(response?.data);
  } catch (error) {
    return { __error: error?.message || String(error) };
  }
}

async function updateTrackers(options = {}) {
  if (refreshPromise) return refreshPromise;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : ((url, config) => axios.get(url, config));
  const sources = Array.isArray(options.sources) && options.sources.length > 0 ? options.sources : SOURCE_URLS;

  refreshPromise = (async () => {
    try {
      const settled = await Promise.allSettled(sources.map((url) => fetchTrackerSource(url, fetchImpl)));
      const fetchedLists = [];
      let okSources = 0;
      for (const result of settled) {
        const value = result.status === 'fulfilled' ? result.value : null;
        if (Array.isArray(value) && value.length > 0) {
          fetchedLists.push(value);
          okSources += 1;
        }
      }

      const previous = getActiveTrackers();
      const nextTrackers = okSources > 0
        ? mergeTrackerSources(CORE_TRACKERS, [...fetchedLists, previous], TRACKER_ACTIVE_MAX)
        : mergeTrackerSources(CORE_TRACKERS, [previous], TRACKER_ACTIVE_MAX);

      activeTrackers = nextTrackers;
      lastRefreshAt = new Date();
      lastRefreshOk = okSources > 0;
      lastSourceCount = okSources;

      if (okSources > 0) {
        console.log(`✅ Trackers aggiornati: ${activeTrackers.length} attivi da ${okSources}/${sources.length} sorgenti.`);
      } else {
        console.warn(`⚠️ Nessuna sorgente tracker raggiungibile, mantengo pool attivo (${activeTrackers.length}).`);
      }
    } catch (error) {
      lastRefreshOk = false;
      console.warn(`⚠️ Errore update tracker (uso pool attivo): ${error.message}`);
    } finally {
      refreshPromise = null;
    }
    return getActiveTrackers();
  })();

  return refreshPromise;
}

function initTrackerRegistry({ autoRefresh = true } = {}) {
  if (autoRefresh && !refreshHandle) {
    void updateTrackers();
    refreshHandle = setInterval(() => {
      void updateTrackers();
    }, TRACKER_REFRESH_MS);
    if (typeof refreshHandle.unref === 'function') refreshHandle.unref();
  }
  return getActiveTrackers();
}

function shutdownTrackerRegistry() {
  if (refreshHandle) {
    clearInterval(refreshHandle);
    refreshHandle = null;
  }
}

function getActiveTrackers() {
  return [...activeTrackers];
}

function getTrackerStats() {
  return {
    activeCount: activeTrackers.length,
    coreCount: CORE_TRACKERS.length,
    sourceUrls: [...SOURCE_URLS],
    okSources: lastSourceCount,
    lastRefreshAt: lastRefreshAt ? lastRefreshAt.toISOString() : null,
    lastRefreshOk,
    refreshMs: TRACKER_REFRESH_MS,
    magnetMaxTrackers: MAGNET_MAX_TRACKERS,
    activeMaxTrackers: TRACKER_ACTIVE_MAX
  };
}

function buildMagnet(infoHash, trackers = null) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return null;
  const provided = Array.isArray(trackers) ? trackers : [];
  const merged = capTrackers(dedupeTrackers([...provided, ...activeTrackers]), MAGNET_MAX_TRACKERS);
  const trackerParams = merged.map((tracker) => `tr=${encodeURIComponent(tracker)}`).join('&');
  return `magnet:?xt=urn:btih:${hash}${trackerParams ? `&${trackerParams}` : ''}`;
}

initTrackerRegistry();

module.exports = {
  CORE_TRACKERS,
  DEFAULT_TRACKERS,
  normalizeTrackerList,
  dedupeTrackers,
  mergeTrackerSources,
  capTrackers,
  isValidTracker,
  updateTrackers,
  initTrackerRegistry,
  shutdownTrackerRegistry,
  getActiveTrackers,
  getTrackerStats,
  buildMagnet
};
