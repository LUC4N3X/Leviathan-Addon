'use strict';

const fs = require('fs');
const path = require('path');

const GRAPH_FILE = path.join(process.cwd(), 'leviathan-evidence-graph.json');
const GRAPH_VERSION = 1;
const MAX_STREAM_NODES = 5000;
const MAX_PROVIDER_NODES = 250;
const MAX_RECORD_BATCH = 180;
const SAVE_DEBOUNCE_MS = 1500;

let loaded = false;
let dirty = false;
let saveTimer = null;

const state = {
  version: GRAPH_VERSION,
  createdAt: new Date().toISOString(),
  updatedAt: null,
  streams: {},
  providers: {}
};

function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function compactText(value, max = 160) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function normalizeKeyText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadGraph() {
  if (loaded) return;
  loaded = true;
  const data = safeReadJson(GRAPH_FILE);
  if (!data || typeof data !== 'object') return;
  if (data.version) state.version = data.version;
  if (data.createdAt) state.createdAt = data.createdAt;
  if (data.updatedAt) state.updatedAt = data.updatedAt;
  if (data.streams && typeof data.streams === 'object') state.streams = data.streams;
  if (data.providers && typeof data.providers === 'object') state.providers = data.providers;
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function pruneMapObject(object, max, scoreField = 'score') {
  const keys = Object.keys(object || {});
  if (keys.length <= max) return;
  keys
    .map(key => ({ key, value: object[key] || {} }))
    .sort((a, b) => {
      const scoreDelta = Number(a.value[scoreField] || 0) - Number(b.value[scoreField] || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return Number(a.value.lastSeenAtMs || a.value.lastUpdatedAtMs || 0) - Number(b.value.lastSeenAtMs || b.value.lastUpdatedAtMs || 0);
    })
    .slice(0, Math.max(0, keys.length - max))
    .forEach(entry => { delete object[entry.key]; });
}

function flushGraph() {
  if (!dirty) return;
  dirty = false;
  state.updatedAt = nowIso();
  pruneMapObject(state.streams, MAX_STREAM_NODES, 'trustScore');
  pruneMapObject(state.providers, MAX_PROVIDER_NODES, 'healthScore');
  try { writeJsonAtomic(GRAPH_FILE, state); } catch (_) {}
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushGraph();
  }, SAVE_DEBOUNCE_MS);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function extractInfoHash(value) {
  const text = String(value || '');
  const btih = text.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  if (btih) return btih[1].toLowerCase();
  const hex = text.match(/\b([a-fA-F0-9]{40})\b/);
  return hex ? hex[1].toLowerCase() : '';
}

function getInfoHash(item = {}) {
  return extractInfoHash(item.hash || item.infoHash || item.info_hash || item.magnet || item.magnetLink || item.url || item.externalUrl || item.title || item.name);
}

function getFileIndex(item = {}) {
  const raw = item.fileIdx ?? item.fileIndex ?? item.file_index ?? item.file_id ?? item.fileId ?? item.index;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function getProviderName(item = {}, fallback = 'unknown') {
  return compactText(item.provider || item.source || item.sourceName || item.addon || item.addonName || item._source || fallback, 64) || fallback;
}

function getStreamKey(item = {}) {
  const infoHash = getInfoHash(item);
  const fileIdx = getFileIndex(item);
  if (infoHash) return `hash:${infoHash}:${fileIdx == null ? 'any' : fileIdx}`;
  const provider = normalizeKeyText(getProviderName(item));
  const title = normalizeKeyText(item.title || item.name || item.filename || item.url || item.externalUrl).slice(0, 160);
  if (!title) return '';
  return `title:${provider}:${title}`;
}

function detectQuality(item = {}) {
  const text = String(item.quality || item.resolution || item.title || item.name || '').toLowerCase();
  if (/\b(?:2160p|4k|uhd)\b/.test(text)) return '4k';
  if (/\b1080p\b/.test(text)) return '1080p';
  if (/\b720p\b/.test(text)) return '720p';
  if (/\b480p|576p|sd\b/.test(text)) return 'sd';
  return '';
}

function detectLanguage(item = {}) {
  const text = String(item.language || item.languages || item.title || item.name || '').toLowerCase();
  if (/\b(?:ita|italian|italiano)\b/.test(text)) return 'ita';
  if (/\b(?:eng|english)\b/.test(text)) return 'eng';
  if (/\bmulti\b/.test(text)) return 'multi';
  return '';
}

function detectCacheStatus(item = {}) {
  const raw = String(
    item.rdStatus || item.cacheStatus || item.cachedStatus || item._rdStatus || item._rdCacheStatus || item.debridStatus || ''
  ).toLowerCase();
  if (item.cached === true || item.rdCached === true || item._rdCached === true || item._tbCached === true) return 'cached_safe';
  if (/cached[_-]?safe|safe[_-]?cached|definite|confirmed/.test(raw)) return 'cached_safe';
  if (/dubious|maybe|probable|weak/.test(raw)) return 'cached_dubious';
  if (/uncached|not[_-]?cached|missing/.test(raw)) return 'uncached';
  if (/pending|unknown|uncertain|hourglass/.test(raw)) return 'uncertain';
  return '';
}

function bumpCounter(object, key, amount = 1) {
  if (!key) return;
  object[key] = (Number(object[key] || 0) || 0) + amount;
}

function recordStreamEvidence(item = {}, context = {}) {
  loadGraph();
  const key = getStreamKey(item);
  if (!key) return null;

  const now = nowMs();
  const provider = getProviderName(item, context.provider || context.source || 'unknown');
  const quality = detectQuality(item);
  const language = detectLanguage(item);
  const cacheStatus = detectCacheStatus(item);
  const title = compactText(item.title || item.name || item.filename || context.title, 220);
  const infoHash = getInfoHash(item);
  const fileIdx = getFileIndex(item);

  const node = state.streams[key] || {
    key,
    firstSeenAt: nowIso(),
    firstSeenAtMs: now,
    seen: 0,
    providers: {},
    qualities: {},
    languages: {},
    cache: {},
    trustScore: 0
  };

  node.lastSeenAt = nowIso();
  node.lastSeenAtMs = now;
  node.seen = (Number(node.seen || 0) || 0) + 1;
  node.title = title || node.title;
  node.infoHash = infoHash || node.infoHash;
  if (fileIdx != null) node.fileIdx = fileIdx;
  if (context.type) node.type = compactText(context.type, 16);
  if (context.id) node.id = compactText(context.id, 96);
  if (context.season != null) node.season = Number(context.season) || context.season;
  if (context.episode != null) node.episode = Number(context.episode) || context.episode;
  bumpCounter(node.providers, provider);
  bumpCounter(node.qualities, quality);
  bumpCounter(node.languages, language);
  bumpCounter(node.cache, cacheStatus);

  if (cacheStatus === 'cached_safe') node.trustScore = clamp((node.trustScore || 0) + 5, -100, 1000);
  else if (cacheStatus === 'cached_dubious') node.trustScore = clamp((node.trustScore || 0) + 1, -100, 1000);
  else if (cacheStatus === 'uncached') node.trustScore = clamp((node.trustScore || 0) - 1, -100, 1000);
  else node.trustScore = clamp((node.trustScore || 0) + 0.15, -100, 1000);

  if (item._rankMeta?.exactEpisode === true) node.exactEpisodeSeen = (Number(node.exactEpisodeSeen || 0) || 0) + 1;
  if (item._rankMeta?.isItalian === true || language === 'ita') node.italianSeen = (Number(node.italianSeen || 0) || 0) + 1;
  if (Number.isFinite(Number(item._score))) {
    node.lastRankScore = Number(item._score);
    node.bestRankScore = Math.max(Number(node.bestRankScore || -Infinity), Number(item._score));
  }

  state.streams[key] = node;
  scheduleSave();
  return node;
}

function recordStreamEvidenceBatch(items = [], context = {}) {
  if (!Array.isArray(items) || !items.length) return 0;
  let count = 0;
  for (const item of items.slice(0, MAX_RECORD_BATCH)) {
    try {
      if (recordStreamEvidence(item, context)) count += 1;
    } catch (_) {}
  }
  return count;
}

function getStreamEvidence(item = {}) {
  loadGraph();
  const key = getStreamKey(item);
  return key ? state.streams[key] || null : null;
}

function getStreamEvidenceScore(item = {}) {
  const node = getStreamEvidence(item);
  if (!node) return { score: 0, reasons: [] };

  const reasons = [];
  let score = 0;
  const seen = Number(node.seen || 0) || 0;
  const trust = Number(node.trustScore || 0) || 0;
  const cachedSafe = Number(node.cache?.cached_safe || 0) || 0;
  const cachedDubious = Number(node.cache?.cached_dubious || 0) || 0;
  const uncached = Number(node.cache?.uncached || 0) || 0;

  if (cachedSafe > 0) {
    const delta = Math.min(2200, 900 + cachedSafe * 180);
    score += delta;
    reasons.push(`cached_safe:${cachedSafe}`);
  } else if (cachedDubious > 0) {
    const delta = Math.min(600, 150 + cachedDubious * 70);
    score += delta;
    reasons.push(`cached_dubious:${cachedDubious}`);
  }

  if (seen >= 3) {
    const delta = Math.min(700, Math.floor(Math.log2(seen) * 180));
    score += delta;
    reasons.push(`seen:${seen}`);
  }

  if (Number(node.exactEpisodeSeen || 0) > 0) {
    score += Math.min(900, 250 + Number(node.exactEpisodeSeen || 0) * 120);
    reasons.push('exact_episode_seen');
  }

  if (uncached > cachedSafe && cachedSafe === 0) {
    const penalty = Math.min(800, uncached * 140);
    score -= penalty;
    reasons.push(`uncached:${uncached}`);
  }

  if (trust < -2) {
    const penalty = Math.min(600, Math.abs(Math.floor(trust * 10)));
    score -= penalty;
    reasons.push('low_trust');
  }

  return {
    score: clamp(Math.round(score), -1800, 4200),
    reasons,
    seen,
    trustScore: Math.round(trust * 100) / 100,
    cachedSafe,
    key: node.key
  };
}

function recordProviderEvidence(provider, outcome, details = {}) {
  loadGraph();
  const key = normalizeKeyText(provider || details.provider || 'unknown') || 'unknown';
  const now = nowMs();
  const node = state.providers[key] || {
    provider: key,
    firstSeenAt: nowIso(),
    firstSeenAtMs: now,
    events: 0,
    ok: 0,
    failures: 0,
    challenges: 0,
    cooldowns: 0,
    healthScore: 0
  };

  const normalizedOutcome = normalizeKeyText(outcome || 'event') || 'event';
  node.events += 1;
  node.lastUpdatedAt = nowIso();
  node.lastUpdatedAtMs = now;
  node.lastOutcome = normalizedOutcome;
  if (details.ms != null && Number.isFinite(Number(details.ms))) {
    const ms = Math.max(0, Number(details.ms));
    node.avgMs = node.avgMs == null ? ms : Math.round((node.avgMs * 0.85) + (ms * 0.15));
  }

  if (/ok|success|reused|solution/.test(normalizedOutcome)) {
    node.ok += 1;
    node.healthScore = clamp((node.healthScore || 0) + 4, -100, 1000);
  } else if (/challenge|403|429|503/.test(normalizedOutcome)) {
    node.challenges += 1;
    node.healthScore = clamp((node.healthScore || 0) - 3, -100, 1000);
  } else if (/cooldown|overflow/.test(normalizedOutcome)) {
    node.cooldowns += 1;
    node.healthScore = clamp((node.healthScore || 0) - 2, -100, 1000);
  } else if (/fail|error|rejected|timeout|empty/.test(normalizedOutcome)) {
    node.failures += 1;
    node.healthScore = clamp((node.healthScore || 0) - 4, -100, 1000);
  }

  if (details.url) node.lastUrl = compactText(details.url, 180);
  if (details.status != null) node.lastStatus = Number(details.status) || details.status;
  state.providers[key] = node;
  scheduleSave();
  return node;
}

function getProviderEvidence(provider) {
  loadGraph();
  const key = normalizeKeyText(provider || 'unknown') || 'unknown';
  return state.providers[key] || null;
}

function getEvidenceGraphStats() {
  loadGraph();
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    streams: Object.keys(state.streams || {}).length,
    providers: Object.keys(state.providers || {}).length,
    dirty
  };
}

process.once('exit', () => {
  try { flushGraph(); } catch (_) {}
});

module.exports = {
  recordStreamEvidence,
  recordStreamEvidenceBatch,
  getStreamEvidence,
  getStreamEvidenceScore,
  recordProviderEvidence,
  getProviderEvidence,
  getEvidenceGraphStats,
  flushGraph,
  _private: {
    getStreamKey,
    getInfoHash,
    detectCacheStatus,
    normalizeKeyText
  }
};
