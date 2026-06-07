'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

let trackerRegistry = null;
try {
  trackerRegistry = require('../storage/tracker_registry');
} catch (_) {
  trackerRegistry = null;
}

const CONNECT_MAGIC = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_SCRAPE = 2;
const MAX_HASHES_PER_REQUEST = 74;

const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce'
];

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function intEnv(name, fallback, min, max) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

const CONFIG = {
  ENABLED: boolEnv('UDP_SCRAPE_ENABLED', false),
  MAX_ITEMS: intEnv('UDP_SCRAPE_MAX_ITEMS', 60, 1, 500),
  MAX_TRACKERS: intEnv('UDP_SCRAPE_MAX_TRACKERS', 5, 1, 30),
  PACKET_TIMEOUT_MS: intEnv('UDP_SCRAPE_PACKET_TIMEOUT_MS', 2500, 250, 15000),
  TRACKER_BUDGET_MS: intEnv('UDP_SCRAPE_TRACKER_BUDGET_MS', 4000, 500, 20000),
  TOTAL_BUDGET_MS: intEnv('UDP_SCRAPE_TOTAL_BUDGET_MS', 6000, 500, 30000),
  REFRESH_AT_OR_BELOW: intEnv('UDP_SCRAPE_REFRESH_AT_OR_BELOW', 3, 0, 100000)
};

function isEnabled() {
  return CONFIG.ENABLED;
}

function normalizeHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(hash) ? hash : null;
}

function decodeInfoHash(hex) {
  const hash = normalizeHash(hex);
  if (!hash) return null;
  return Buffer.from(hash, 'hex');
}

function parseUdpTracker(url) {
  const value = String(url || '').trim();
  if (!/^udp:\/\//i.test(value)) return null;
  const stripped = value.replace(/^udp:\/\//i, '').split('/')[0];
  const lastColon = stripped.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const host = stripped.slice(0, lastColon);
  const port = parseInt(stripped.slice(lastColon + 1), 10);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function extractUdpTrackersFromMagnet(magnet) {
  const text = String(magnet || '');
  if (!text) return [];
  const out = [];
  const regex = /[?&]tr=([^&]+)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (/^udp:\/\//i.test(decoded)) out.push(decoded);
    } catch (_) { /* malformed tracker param */ }
  }
  return out;
}

function udpScrape(trackerUrl, infoHashes, { packetTimeoutMs, budgetMs }) {
  return new Promise((resolve) => {
    const target = parseUdpTracker(trackerUrl);
    const results = new Map();
    const decoded = (Array.isArray(infoHashes) ? infoHashes : [])
      .map((hash) => ({ hash, buf: decodeInfoHash(hash) }))
      .filter((entry) => entry.buf);

    if (!target || decoded.length === 0) {
      resolve(results);
      return;
    }

    const socket = dgram.createSocket('udp4');
    const deadline = Date.now() + Math.max(packetTimeoutMs, budgetMs);
    let settled = false;
    let activeTimer = null;
    let activeListener = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (activeTimer) clearTimeout(activeTimer);
      if (activeListener) socket.removeListener('message', activeListener);
      try { socket.close(); } catch (_) { /* already closed */ }
      resolve(results);
    };

    const waitFor = (transactionId) => new Promise((res) => {
      const settle = (value) => {
        if (activeTimer) clearTimeout(activeTimer);
        if (activeListener) socket.removeListener('message', activeListener);
        activeTimer = null;
        activeListener = null;
        res(value);
      };
      activeTimer = setTimeout(() => settle(null), Math.min(packetTimeoutMs, Math.max(1, deadline - Date.now())));
      activeListener = (msg) => {
        if (msg.length >= 8 && msg.readUInt32BE(4) === transactionId) settle(msg);
      };
      socket.on('message', activeListener);
    });

    socket.on('error', finish);

    (async () => {
      try {
        const connectTid = crypto.randomBytes(4).readUInt32BE(0);
        const connectReq = Buffer.alloc(16);
        connectReq.writeBigUInt64BE(CONNECT_MAGIC, 0);
        connectReq.writeUInt32BE(ACTION_CONNECT, 8);
        connectReq.writeUInt32BE(connectTid, 12);
        socket.send(connectReq, target.port, target.host);

        const connectResp = await waitFor(connectTid);
        if (!connectResp || connectResp.length < 16 || connectResp.readUInt32BE(0) !== ACTION_CONNECT) {
          finish();
          return;
        }
        const connectionId = connectResp.subarray(8, 16);

        for (let offset = 0; offset < decoded.length && Date.now() < deadline; offset += MAX_HASHES_PER_REQUEST) {
          const chunk = decoded.slice(offset, offset + MAX_HASHES_PER_REQUEST);
          const scrapeTid = crypto.randomBytes(4).readUInt32BE(0);
          const scrapeReq = Buffer.alloc(16 + chunk.length * 20);
          connectionId.copy(scrapeReq, 0);
          scrapeReq.writeUInt32BE(ACTION_SCRAPE, 8);
          scrapeReq.writeUInt32BE(scrapeTid, 12);
          chunk.forEach((entry, index) => entry.buf.copy(scrapeReq, 16 + index * 20));
          socket.send(scrapeReq, target.port, target.host);

          const scrapeResp = await waitFor(scrapeTid);
          if (!scrapeResp || scrapeResp.length < 8 || scrapeResp.readUInt32BE(0) !== ACTION_SCRAPE) continue;

          const available = Math.floor((scrapeResp.length - 8) / 12);
          for (let i = 0; i < chunk.length && i < available; i += 1) {
            results.set(chunk[i].hash, scrapeResp.readUInt32BE(8 + i * 12));
          }
        }
      } catch (_) { /* best-effort */ }
      finish();
    })();
  });
}

function collectTrackers(items, maxTrackers) {
  const counts = new Map();
  for (const item of items) {
    for (const tracker of extractUdpTrackersFromMagnet(item?.magnet || item?.magnetLink)) {
      const target = parseUdpTracker(tracker);
      if (!target) continue;
      const key = `udp://${target.host}:${target.port}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const magnetTrackers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);

  const seen = new Set();
  const ordered = [];
  const push = (url) => {
    const target = parseUdpTracker(url);
    if (!target) return;
    const key = `udp://${target.host}:${target.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(key);
  };

  const active = typeof trackerRegistry?.getActiveTrackers === 'function' ? trackerRegistry.getActiveTrackers() : [];
  for (const tracker of magnetTrackers) push(tracker);
  for (const tracker of Array.isArray(active) ? active : []) push(tracker);
  for (const tracker of FALLBACK_TRACKERS) push(tracker);

  return ordered.slice(0, maxTrackers);
}

function selectCandidates(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const hash = normalizeHash(item?.hash || item?.infoHash);
    if (!hash || seen.has(hash)) continue;
    const known = Number(item?.seeders);
    if (Number.isFinite(known) && known > CONFIG.REFRESH_AT_OR_BELOW) continue;
    seen.add(hash);
    out.push({ item, hash });
    if (out.length >= CONFIG.MAX_ITEMS) break;
  }
  return out;
}

async function enrichItemsWithLiveSeeders(items) {
  const stats = { enabled: isEnabled(), candidates: 0, trackers: 0, updated: 0, scraped: 0 };
  if (!isEnabled() || !Array.isArray(items) || items.length === 0) return stats;

  const candidates = selectCandidates(items);
  stats.candidates = candidates.length;
  if (candidates.length === 0) return stats;

  const trackers = collectTrackers(candidates.map((entry) => entry.item), CONFIG.MAX_TRACKERS);
  stats.trackers = trackers.length;
  if (trackers.length === 0) return stats;

  const hashes = candidates.map((entry) => entry.hash);
  const best = new Map();
  const deadline = Date.now() + CONFIG.TOTAL_BUDGET_MS;

  for (const tracker of trackers) {
    if (Date.now() >= deadline) break;
    const trackerResults = await udpScrape(tracker, hashes, {
      packetTimeoutMs: CONFIG.PACKET_TIMEOUT_MS,
      budgetMs: Math.min(CONFIG.TRACKER_BUDGET_MS, deadline - Date.now())
    });
    for (const [hash, seeders] of trackerResults) {
      stats.scraped += 1;
      const current = best.get(hash);
      if (current === undefined || seeders > current) best.set(hash, seeders);
    }
  }

  for (const { item, hash } of candidates) {
    if (!best.has(hash)) continue;
    const live = best.get(hash);
    const previous = Number(item?.seeders);
    const next = Number.isFinite(previous) ? Math.max(previous, live) : live;
    item._udpSeeders = live;
    if (!Number.isFinite(previous) || next !== previous) {
      item.seeders = next;
      stats.updated += 1;
    }
  }

  return stats;
}

module.exports = {
  isEnabled,
  enrichItemsWithLiveSeeders,
  udpScrape,
  parseUdpTracker,
  extractUdpTrackersFromMagnet,
  collectTrackers
};
