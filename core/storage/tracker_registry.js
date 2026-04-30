const axios = require('axios');

const TRACKERS_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
const TRACKER_REFRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonoid.ch:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.therarbg.to:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce'
];

let activeTrackers = [...DEFAULT_TRACKERS];
let refreshHandle = null;
let refreshPromise = null;

function normalizeInfoHash(infoHash) {
  if (!infoHash) return null;
  const normalized = String(infoHash).trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeTrackerList(raw) {
  if (typeof raw !== 'string') return [];
  const protocols = [/^udp:\/\//i, /^wss?:\/\//i, /^https?:\/\//i];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => protocols.some((pattern) => pattern.test(line)));
  return [...new Set(lines)];
}

async function updateTrackers() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const response = await axios.get(TRACKERS_URL, {
        timeout: 5000,
        responseType: 'text',
        headers: { 'User-Agent': 'stremio-addon-storage/1.0' }
      });
      const nextTrackers = normalizeTrackerList(response.data);
      if (nextTrackers.length > 0) {
        activeTrackers = nextTrackers;
        console.log(`✅ Trackers aggiornati: ${activeTrackers.length} attivi.`);
      } else {
        console.warn('⚠️ Lista tracker remota vuota/non valida, mantengo fallback.');
      }
    } catch (error) {
      console.warn(`⚠️ Errore update tracker (uso fallback): ${error.message}`);
    } finally {
      refreshPromise = null;
    }
    return [...activeTrackers];
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

function buildMagnet(infoHash, trackers = activeTrackers) {
  const hash = normalizeInfoHash(infoHash);
  if (!hash) return null;
  const trackerParams = (Array.isArray(trackers) ? trackers : [])
    .filter((tracker) => typeof tracker === 'string' && tracker.trim())
    .map((tracker) => `tr=${encodeURIComponent(tracker.trim())}`)
    .join('&');
  return `magnet:?xt=urn:btih:${hash}${trackerParams ? `&${trackerParams}` : ''}`;
}

initTrackerRegistry();

module.exports = {
  DEFAULT_TRACKERS,
  normalizeTrackerList,
  updateTrackers,
  initTrackerRegistry,
  shutdownTrackerRegistry,
  getActiveTrackers,
  buildMagnet
};
