const axios = require("axios");
const https = require("https");

const {
  TB_CACHE_STATES,
  normalizeTbCacheState,
  tokenFingerprint,
  redactSecretsInText,
  shortTorboxHash
} = require("../availability/torbox_cache_state");
const { computeBackoffDelay, parseRetryAfterMs } = require("../utils/backoff");
const { CircuitBreaker } = require("../utils/circuit_breaker");

const TB_BASE = "https://api.torbox.app/v1/api";
const TB_TIMEOUT = Math.max(5000, Math.min(45000, parseInt(process.env.TB_TIMEOUT_MS || '25000', 10) || 25000));
const LIST_CACHE_TTL = 30000;
const MAX_RETRIES = 4;
const MAX_INFO_POLLS = 4;
// Faster first poll: most cached torrents expose their file list almost immediately,
// so a long fixed initial delay just adds dead latency to the resolve path.
const POLL_DELAYS = [600, 1100, 1800, 3000];

const tbCircuit = new CircuitBreaker("torbox");

const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|iso|m4v|ts)$/i;
const JUNK_PATTERN = /\b(sample|trailer|promo|preview|screens?|proof|nfo|cover|poster|thumb|trailerfix)\b/i;
const EXTRA_PATTERN = /\b(ova|oad|special|extras?|featurette|intervista|interview|behind\s*the\s*scenes|making\s*of|recap|riassunto|ncop|nced|creditless|ost|soundtrack)\b/i;
const RESETTABLE_STATES = new Set(["error", "metadl", "stalled"]);
const COMPLETED_STATES = new Set(["completed", "seeding", "ready"]);

const PUBLIC_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://tracker.leechers-paradise.org:6969/announce",
  "udp://9.rarbg.to:2710/announce",
  "udp://tracker.openbittorrent.com:80/announce",
  "udp://opentracker.i2p.rocks:6969/announce"
];

const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: process.env.TB_INSECURE_SSL === "1" ? false : true,
  maxSockets: 50
});

const COMMON_HEADERS = {
  "User-Agent": "Leviathan/2.0 (TorBoxModule)",
  Accept: "application/json"
};

const userListCache = new Map();

class TorboxApiError extends Error {
  constructor(code, message, options = {}) {
    super(redactSecretsInText(message || code || "torbox_error"));
    this.name = "TorboxApiError";
    this.code = code || "torbox_error";
    this.status = options.status || null;
    this.transient = Boolean(options.transient);
    this.cacheState = normalizeTbCacheState(options.cacheState || TB_CACHE_STATES.ERROR, TB_CACHE_STATES.ERROR);
    this.safeMessage = redactSecretsInText(options.safeMessage || this.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function safeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeNum(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableKeyFingerprint(key) {
  return tokenFingerprint(key);
}

function getCacheEntry(key) {
  const cacheKey = stableKeyFingerprint(key);
  if (!userListCache.has(cacheKey)) {
    userListCache.set(cacheKey, { data: null, timestamp: 0, pending: null });
  }
  return userListCache.get(cacheKey);
}

function invalidateUserList(key) {
  if (key) {
    userListCache.delete(stableKeyFingerprint(key));
    return;
  }
  userListCache.clear();
}

function pruneExpiredCache() {
  const now = Date.now();
  for (const [key, entry] of userListCache.entries()) {
    if (!entry.pending && (!entry.timestamp || now - entry.timestamp > LIST_CACHE_TTL * 3)) {
      userListCache.delete(key);
    }
  }
}

function logTorboxEvent(event, payload = {}, level = "info") {
  const safePayload = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (/token|api.?key|authorization/i.test(key)) continue;
    safePayload[key] = typeof value === "string" ? redactSecretsInText(value) : value;
  }
  const message = `[${event}] ${Object.entries(safePayload).map(([k, v]) => `${k}=${v}`).join(" ")}`.trim();
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.info(message);
}

function getRetryDelay(error, attempt) {
  const status = error?.response?.status;
  const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.["retry-after"]);
  const baseMs = status === 429 ? 2500 : 800;
  return computeBackoffDelay(attempt, { baseMs, maxMs: 20000, retryAfterMs });
}

function isRetryableError(error) {
  const status = error?.response?.status;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  return ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(error?.code);
}

function mapTorboxError(responseOrError, context = "request") {
  const status = responseOrError?.status || responseOrError?.response?.status || null;
  const data = responseOrError?.data || responseOrError?.response?.data || {};
  const detailRaw = data?.detail || data?.error || data?.message || responseOrError?.message || `HTTP ${status || "unknown"}`;
  const detail = redactSecretsInText(typeof detailRaw === "object" ? JSON.stringify(detailRaw) : String(detailRaw || ""));

  if (status === 401 || status === 403) {
    return new TorboxApiError("auth_error", `${context}: ${detail}`, { status, safeMessage: "TorBox authentication failed" });
  }
  if (status === 429) {
    return new TorboxApiError("rate_limited", `${context}: ${detail}`, { status, transient: true, safeMessage: "TorBox rate limited the request" });
  }
  if (status >= 500) {
    return new TorboxApiError("server_error", `${context}: ${detail}`, { status, transient: true, safeMessage: "TorBox server error" });
  }
  if (responseOrError?.code === "ECONNABORTED" || responseOrError?.code === "ETIMEDOUT") {
    return new TorboxApiError("timeout", `${context}: timeout`, { transient: true, safeMessage: "TorBox timeout" });
  }
  if (status >= 400) {
    return new TorboxApiError("request_error", `${context}: ${detail}`, { status, safeMessage: "TorBox request failed" });
  }
  return new TorboxApiError("network_error", `${context}: ${detail}`, { transient: true, safeMessage: "TorBox network error" });
}

async function tbRequest(method, endpoint, key, { data = null, params = null, timeout = TB_TIMEOUT, json = false, op = endpoint } = {}) {
  const circuitKey = stableKeyFingerprint(key);
  if (!tbCircuit.canRequest(circuitKey)) {
    logTorboxEvent("torbox.circuit.open", { op }, "warn");
    // Synthetic transient response so callers keep their existing error handling.
    return { status: 503, data: { detail: "torbox_circuit_open" }, headers: {}, _circuitOpen: true };
  }

  let lastResponse = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const headers = { ...COMMON_HEADERS };
      if (key) headers.Authorization = `Bearer ${key}`;

      const config = {
        method,
        url: `${TB_BASE}${endpoint}`,
        headers,
        timeout,
        params,
        httpsAgent,
        validateStatus: () => true
      };

      if (method === "POST" && data) {
        if (json) {
          config.data = data;
          config.headers["Content-Type"] = "application/json";
        } else {
          const form = new URLSearchParams();
          for (const [k, v] of Object.entries(data)) {
            if (v == null) continue;
            form.append(k, String(v));
          }
          config.data = form;
          config.headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
      }

      const response = await axios(config);
      lastResponse = response;
      if (response.status >= 200 && response.status < 300) {
        tbCircuit.recordSuccess(circuitKey);
        return response;
      }
      if (attempt < MAX_RETRIES - 1 && isRetryableError({ response })) {
        await sleep(getRetryDelay({ response }, attempt));
        continue;
      }
      // Server answered (even with an error status) -> upstream is reachable.
      // Only sustained 5xx counts against the breaker; 4xx/429 do not.
      if (response.status >= 500) tbCircuit.recordFailure(circuitKey);
      else tbCircuit.recordSuccess(circuitKey);
      return response;
    } catch (error) {
      if (attempt < MAX_RETRIES - 1 && isRetryableError(error)) {
        await sleep(getRetryDelay(error, attempt));
        continue;
      }
      const response = error?.response || lastResponse || null;
      if (response) {
        if (response.status >= 500) tbCircuit.recordFailure(circuitKey);
        return response;
      }
      tbCircuit.recordFailure(circuitKey);
      throw mapTorboxError(error, op);
    }
  }
  return lastResponse;
}

async function fetchUserList(key, extraParams = null) {
  const res = await tbRequest("GET", "/torrents/mylist", key, {
    params: { bypass_cache: true, ...(extraParams || {}) },
    op: "mylist"
  });
  if (!res?.data?.data) return null;
  const data = Array.isArray(res.data.data) ? res.data.data.slice() : [res.data.data];
  data.sort((a, b) => safeInt(b?.id) - safeInt(a?.id));
  return data;
}

async function getUserList(key, forceRefresh = false) {
  pruneExpiredCache();
  const entry = getCacheEntry(key);
  const age = Date.now() - entry.timestamp;

  if (!forceRefresh && entry.data && age < LIST_CACHE_TTL) {
    return entry.data;
  }
  if (entry.pending) {
    return entry.pending;
  }

  entry.pending = (async () => {
    const list = await fetchUserList(key);
    if (list) {
      entry.data = list;
      entry.timestamp = Date.now();
    }
    entry.pending = null;
    return list;
  })();

  return entry.pending;
}

function normalizeName(value) {
  return lower(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\[\](){}]/g, " ")
    .replace(/[_+.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFileName(file) {
  return String(file?.name || file?.short_name || "");
}

function getFileId(file) {
  const raw = file?.id ?? file?.file_id ?? null;
  const parsed = safeInt(raw, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFileSize(file) {
  return Math.max(0, safeNum(file?.size, 0));
}

function getFileById(files, targetId) {
  const normalizedId = safeInt(targetId, NaN);
  if (!Number.isFinite(normalizedId) || normalizedId < 0) return null;
  return (Array.isArray(files) ? files : []).find((file) => getFileId(file) === normalizedId) || null;
}

function isVideoFile(file) {
  const name = getFileName(file);
  return VIDEO_EXTENSIONS.test(name) && !JUNK_PATTERN.test(name);
}

function isExtraFile(file) {
  return EXTRA_PATTERN.test(getFileName(file));
}

function getVideoFiles(files) {
  return (Array.isArray(files) ? files : []).filter((file) => isVideoFile(file) && !isExtraFile(file));
}

function isSeasonPackName(name, season) {
  if (!season) return false;
  return new RegExp(`\\bseason\\s*0*${season}\\b|\\bcomplete\\b|\\bpack\\b|\\b全集\\b|\\bcollection\\b|\\bintegrale\\b|\\bstagione\\s*0*${season}\\b`, "i").test(name);
}

function parseEpisodeRange(name) {
  const patterns = [
    /\bE?(\d{1,3})\s*[-~]\s*E?(\d{1,3})\b/i,
    /\b(?:episodes?|eps?)\s*(\d{1,3})\s*[-~]\s*(\d{1,3})\b/i
  ];
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (!match) continue;
    const start = safeInt(match[1], 0);
    const end = safeInt(match[2], 0);
    if (start > 0 && end >= start) {
      return { start, end };
    }
  }
  return null;
}

function buildEpisodeRegexes(season, episode) {
  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const e2 = String(e).padStart(2, "0");
  return [
    { score: 1600, regex: new RegExp(`\\bS(?:eason)?\\s*0*${s}\\s*[-_. ]*E(?:pisode)?\\s*0*${e}\\b`, "i") },
    { score: 1550, regex: new RegExp(`\\b0*${s}x0*${e}\\b`, "i") },
    { score: 1500, regex: new RegExp(`\\bS0*${s}[^a-z0-9]{0,4}E0*${e}\\b`, "i") },
    { score: 1380, regex: new RegExp(`(^|\\D)${s}${e2}(\\D|$)`, "i") },
    { score: 1320, regex: new RegExp(`\\bepisode\\s*0*${e}\\b|\\bep\\s*0*${e}\\b`, "i") },
    { score: 980, regex: new RegExp(`(?:^|[\\s._\\-\\[\]()])0*${e}(?:$|[\\s._\\-\\]\[()])`, "i") }
  ];
}

function parseExplicitEpisodeHints(name) {
  const hints = new Set();
  const patterns = [
    /\bS(?:eason)?\s*0*(\d{1,2})\s*[-_. ]*E(?:pisode)?\s*0*(\d{1,3})\b/gi,
    /\b(\d{1,2})x(\d{1,3})\b/gi,
    /\b(?:episode|ep)\s*0*(\d{1,3})\b/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(name)) !== null) {
      const season = match.length >= 3 ? safeInt(match[1], 0) : 0;
      const episode = safeInt(match[match.length - 1], 0);
      if (episode > 0) hints.add(`${season}:${episode}`);
    }
  }
  return hints;
}

function hasConflictingExplicitEpisode(name, season, episode) {
  const hints = parseExplicitEpisodeHints(name);
  if (hints.size === 0) return false;
  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  if (hints.has(`${s}:${e}`) || hints.has(`0:${e}`)) return false;
  for (const hint of hints) {
    const [hintSeason, hintEpisode] = hint.split(":").map((v) => safeInt(v, 0));
    if (hintSeason === 0 && hintEpisode === e) return false;
    if (hintSeason === s && hintEpisode === e) return false;
  }
  return true;
}

function buildMovieScore(file) {
  const name = normalizeName(getFileName(file));
  const size = getFileSize(file);
  let score = 0;
  if (isVideoFile(file)) score += 400;
  score += Math.min(size / (1024 * 1024 * 40), 180);
  if (isExtraFile(file)) score -= 300;
  if (/\b(sample|trailer|extras?|featurette|making of)\b/i.test(name)) score -= 350;
  if (/\b(2160p|1080p|720p|bluray|bdrip|web[- ]?dl|webrip|remux)\b/i.test(name)) score += 25;
  return score;
}

function buildEpisodeScore(file, season, episode) {
  const rawName = getFileName(file);
  const name = normalizeName(rawName);
  const size = getFileSize(file);
  let score = 0;

  if (!isVideoFile(file)) return -Infinity;
  if (isExtraFile(file)) return -Infinity;
  if (hasConflictingExplicitEpisode(rawName, season, episode)) return -Infinity;

  score += 300;
  score += Math.min(size / (1024 * 1024 * 50), 150);

  let matched = false;
  for (const { score: bonus, regex } of buildEpisodeRegexes(season, episode)) {
    if (regex.test(rawName) || regex.test(name)) {
      score += bonus;
      matched = true;
      break;
    }
  }

  const range = parseEpisodeRange(rawName) || parseEpisodeRange(name);
  const targetEpisode = safeInt(episode, 0);
  if (range) {
    if (targetEpisode >= range.start && targetEpisode <= range.end) {
      score -= 260;
    } else {
      score -= 800;
    }
  }

  if (!matched && isSeasonPackName(name, season)) score -= 260;
  if (/\b(batch|multi|全集|complete|collection|pack)\b/i.test(name)) score -= 180;
  if (/\b(2160p|1080p|720p|bluray|bdrip|web[- ]?dl|webrip|remux)\b/i.test(name)) score += 20;

  return score;
}

function resolveForcedFileId(files, forcedFileIdx, season = 0, episode = 0) {
  if (forcedFileIdx == null) return null;
  const raw = safeInt(forcedFileIdx, NaN);
  if (!Number.isFinite(raw) || raw < 0) return null;

  const byId = files.find((file) => getFileId(file) === raw);
  const selected = byId || (raw < files.length ? files[raw] : null);
  if (!selected) return null;
  if (season > 0 && episode > 0 && hasConflictingExplicitEpisode(getFileName(selected), season, episode)) {
    return null;
  }
  return getFileId(selected);
}

function rankCandidateFiles(files, season, episode) {
  const list = Array.isArray(files) ? files.slice() : [];
  if (list.length === 0) return [];

  const videoFiles = getVideoFiles(list);
  const candidates = videoFiles.length > 0 ? videoFiles : list;

  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const isMovie = s <= 0 && e <= 0;

  return candidates
    .map((file) => ({
      file,
      score: isMovie ? buildMovieScore(file) : buildEpisodeScore(file, s, e),
      size: getFileSize(file)
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => (b.score - a.score) || (b.size - a.size));
}

function chooseBestFile(files, season, episode) {
  return rankCandidateFiles(files, season, episode)[0]?.file || null;
}

function confidenceForRankedMatch(ranked, isSeries) {
  const best = ranked[0] || null;
  if (!best) return 0;
  if (!isSeries) return ranked.length === 1 ? 1 : 0.82;
  if (best.score >= 1500) return 1;
  if (best.score >= 1320) return 0.95;
  if (best.score >= 980) return ranked.length === 1 ? 0.88 : 0.72;
  return ranked.length === 1 ? 0.55 : 0.25;
}

function matchFileDetailed(files, season, episode, forcedFileIdx = null) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) {
    return { fileId: null, file: null, confidence: 0, reason: "no_files", score: -Infinity };
  }

  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const isSeries = s > 0 && e > 0;

  const forced = resolveForcedFileId(list, forcedFileIdx, s, e);
  if (forced != null) {
    const forcedFile = getFileById(list, forced);
    return { fileId: forced, file: forcedFile, confidence: 1, reason: "forced_file_id", score: Infinity };
  }

  const ranked = rankCandidateFiles(list, s, e);
  const selected = ranked[0]?.file || null;
  const confidence = confidenceForRankedMatch(ranked, isSeries);

  if (selected && (!isSeries || confidence >= 0.75)) {
    return {
      fileId: getFileId(selected),
      file: selected,
      confidence,
      reason: isSeries ? "episode_file_match" : "movie_file_match",
      score: ranked[0].score
    };
  }

  if (isSeries) {
    const videos = getVideoFiles(list);
    if (videos.length === 1 && !hasConflictingExplicitEpisode(getFileName(videos[0]), s, e)) {
      return {
        fileId: getFileId(videos[0]),
        file: videos[0],
        confidence: 0.62,
        reason: "single_video_uncertain",
        score: ranked[0]?.score ?? 0
      };
    }
    return {
      fileId: null,
      file: null,
      confidence,
      reason: "no_confident_episode_file",
      score: ranked[0]?.score ?? -Infinity
    };
  }

  if (selected) {
    return {
      fileId: getFileId(selected),
      file: selected,
      confidence,
      reason: "movie_file_match",
      score: ranked[0].score
    };
  }

  return { fileId: null, file: null, confidence: 0, reason: "no_video_file", score: -Infinity };
}

function matchFile(files, season, episode, forcedFileIdx = null) {
  return matchFileDetailed(files, season, episode, forcedFileIdx).fileId;
}

function extractHash(magnet) {
  const value = String(magnet || "");
  const match = value.match(/btih:([a-zA-Z0-9]{32,40})/i);
  return match ? match[1].toLowerCase() : null;
}

function enhanceMagnet(magnet) {
  const raw = String(magnet || "").trim();
  if (!raw) return raw;
  const lowerMagnet = raw.toLowerCase();
  const missing = PUBLIC_TRACKERS.filter((tracker) => !lowerMagnet.includes(encodeURIComponent(tracker).toLowerCase()) && !lowerMagnet.includes(tracker.toLowerCase()));
  if (missing.length === 0) return raw;
  return `${raw}${missing.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join("")}`;
}

async function deleteTorrent(key, torrentId) {
  const res = await tbRequest("POST", "/torrents/controltorrent", key, {
    data: { torrent_id: torrentId, operation: "delete" },
    json: true,
    op: "controltorrent.delete"
  });
  invalidateUserList(key);
  return Boolean(res?.data?.success || (res?.status >= 200 && res?.status < 300));
}

function shouldResetTorrent(torrent) {
  const state = lower(torrent?.download_state);
  const progress = safeNum(torrent?.progress, 0);
  return RESETTABLE_STATES.has(state) && progress < 100;
}

function pickDeletionVictim(list) {
  if (!Array.isArray(list) || list.length === 0) return null;

  const sortOldest = (items) => items
    .slice()
    .sort((a, b) => new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime())[0] || null;

  const completed = list.filter((t) => COMPLETED_STATES.has(lower(t?.download_state)));
  if (completed.length > 0) return sortOldest(completed);

  const resettable = list.filter((t) => RESETTABLE_STATES.has(lower(t?.download_state)));
  if (resettable.length > 0) return sortOldest(resettable);

  return null;
}

async function freeUpSpace(key) {
  const list = await getUserList(key, true);
  const victim = pickDeletionVictim(list);
  if (!victim?.id) return false;
  const ok = await deleteTorrent(key, victim.id);
  if (ok) await sleep(900);
  return ok;
}

async function findTorrentByHash(key, hash) {
  if (!hash) return null;
  const list = await getUserList(key);
  return list?.find((torrent) => lower(torrent?.hash) === lower(hash)) || null;
}

async function refreshTorrentInfo(key, torrentId) {
  if (!torrentId) return null;
  const list = await fetchUserList(key, { id: torrentId });
  if (!list || list.length === 0) return null;
  return list.find((torrent) => safeInt(torrent?.id) === safeInt(torrentId)) || list[0] || null;
}

async function waitForFiles(key, torrentId, initialFiles = null) {
  if (Array.isArray(initialFiles) && initialFiles.length > 0) return initialFiles;
  for (let i = 0; i < MAX_INFO_POLLS; i += 1) {
    await sleep(POLL_DELAYS[i] || POLL_DELAYS[POLL_DELAYS.length - 1]);
    const info = await refreshTorrentInfo(key, torrentId);
    if (Array.isArray(info?.files) && info.files.length > 0) return info.files;
    if (COMPLETED_STATES.has(lower(info?.download_state)) && Array.isArray(info?.files)) {
      return info.files;
    }
  }
  return initialFiles;
}

async function createTorrent(key, magnet) {
  const postData = { magnet, seed: "1", allow_zip: "false" };
  let createRes = await tbRequest("POST", "/torrents/createtorrent", key, { data: postData, op: "createtorrent" });

  const detail = createRes?.data?.detail || createRes?.data?.error || "";
  const detailStr = redactSecretsInText(typeof detail === "object" ? JSON.stringify(detail) : String(detail || ""));

  if (!createRes?.data?.success && /limit|active|storage|space/i.test(detailStr)) {
    const freed = await freeUpSpace(key);
    if (freed) {
      createRes = await tbRequest("POST", "/torrents/createtorrent", key, { data: postData, op: "createtorrent.retry" });
    }
  }

  return createRes;
}

function findCheckcachedEntry(data, requestedHash, requestedHashes = []) {
  const normalize = (value) => lower(value).replace(/[^a-f0-9]/g, '');
  const target = normalize(requestedHash);
  if (!data) return null;

  if (Array.isArray(data)) {
    for (let index = 0; index < data.length; index += 1) {
      const entry = data[index];
      const candidates = [entry?.hash, entry?.info_hash, entry?.torrent_hash, entry?.hash_value]
        .map(normalize)
        .filter(Boolean);
      if (candidates.includes(target)) return entry;
      if (!candidates.length && normalize(requestedHashes[index]) === target) return entry;
    }
    return null;
  }

  if (typeof data === "object") {
    for (const [hash, info] of Object.entries(data)) {
      if (normalize(hash) === target) return info;
    }
  }

  return null;
}

function normalizeCheckcachedInfo(hash, info) {
  if (!info) {
    return {
      hash: lower(hash),
      cached: false,
      state: TB_CACHE_STATES.UNCACHED,
      cache_state: TB_CACHE_STATES.UNCACHED,
      confidence: 0
    };
  }

  const hasFiles = Array.isArray(info?.files) && info.files.length > 0;
  if (hasFiles) {
    return {
      hash: lower(hash),
      cached: true,
      state: TB_CACHE_STATES.CACHED_VERIFIED,
      cache_state: TB_CACHE_STATES.CACHED_VERIFIED,
      confidence: 0.8
    };
  }

  // An explicit `cached` flag is a real (if unverified) cache signal.
  if (info?.cached === true) {
    return {
      hash: lower(hash),
      cached: null,
      state: TB_CACHE_STATES.LIKELY_CACHED,
      cache_state: TB_CACHE_STATES.LIKELY_CACHED,
      confidence: 0.5
    };
  }

  // A bare `size` with no file list and no cached flag is just torrent metadata,
  // not a cache hit. Treating it as likely_cached produced false-positive badges.
  if (safeNum(info?.size, 0) > 0) {
    return {
      hash: lower(hash),
      cached: null,
      state: TB_CACHE_STATES.UNCERTAIN,
      cache_state: TB_CACHE_STATES.UNCERTAIN,
      confidence: 0.2
    };
  }

  return {
    hash: lower(hash),
    cached: false,
    state: TB_CACHE_STATES.UNCACHED,
    cache_state: TB_CACHE_STATES.UNCACHED,
    confidence: 0
  };
}

async function requestDownloadLink(key, torrentId, fileId, userIp = null) {
  const params = {
    token: key,
    torrent_id: torrentId,
    file_id: fileId,
    zip_link: "false",
    redirect: "false",
    append_name: "false"
  };
  if (userIp) params.user_ip = userIp;
  return tbRequest("GET", "/torrents/requestdl", key, { params, op: "requestdl" });
}

const TB = {
  listSavedTorrents: async (key, options = {}) => {
    const list = await getUserList(key, Boolean(options.forceRefresh));
    const limit = Math.max(1, Math.min(250, safeInt(options.limit, 100)));
    return Array.isArray(list) ? list.slice(0, limit) : [];
  },

  getSavedTorrentInfo: async (key, torrentId) => {
    if (!torrentId) return null;
    return refreshTorrentInfo(key, torrentId);
  },

  resolveSavedTorrentFile: async (key, torrentId, fileId, userIp = null) => {
    const info = await refreshTorrentInfo(key, torrentId);
    const files = Array.isArray(info?.files) ? info.files : [];
    const resolvedFileId = safeInt(fileId, NaN);
    if (!Number.isFinite(resolvedFileId)) return null;
    const selectedFile = getFileById(files, resolvedFileId);
    const linkRes = await requestDownloadLink(key, torrentId, resolvedFileId, userIp);
    if (linkRes?.data?.success && linkRes.data.data) {
      const resolvedSize = getFileSize(selectedFile);
      return {
        url: linkRes.data.data,
        filename: getFileName(selectedFile) || null,
        file_size: resolvedSize || null,
        size: resolvedSize || null,
        tb_file_size: resolvedSize || null,
        tb_file_id: Number.isFinite(resolvedFileId) ? resolvedFileId : null,
        file_id: Number.isFinite(resolvedFileId) ? resolvedFileId : null,
        tb_cache_state: TB_CACHE_STATES.CACHED_VERIFIED
      };
    }
    return null;
  },

  checkCachedDetailed: async (key, hashes) => {
    const clean = Array.from(new Set((Array.isArray(hashes) ? hashes : [])
      .map((hash) => lower(hash))
      .filter(Boolean)));
    if (clean.length === 0) return {};

    const res = await tbRequest("GET", "/torrents/checkcached", key, {
      params: {
        hash: clean.join(","),
        format: "list",
        list_files: "true"
      },
      timeout: 20000,
      op: "checkcached"
    });

    if (!res || res.status < 200 || res.status >= 300) {
      const err = mapTorboxError(res || {}, "checkcached");
      const out = {};
      for (const hash of clean) {
        out[hash] = {
          hash,
          cached: null,
          state: TB_CACHE_STATES.ERROR,
          cache_state: TB_CACHE_STATES.ERROR,
          error_code: err.code,
          http_status: err.status
        };
      }
      return out;
    }

    const out = {};
    for (const hash of clean) {
      const info = findCheckcachedEntry(res?.data?.data, hash, clean);
      out[hash] = normalizeCheckcachedInfo(hash, info);
    }
    return out;
  },

  checkCached: async (key, hashes) => {
    const detailed = await TB.checkCachedDetailed(key, hashes);
    return Object.entries(detailed)
      .filter(([, value]) => value?.state === TB_CACHE_STATES.CACHED_VERIFIED && value?.cached === true)
      .map(([hash]) => lower(hash));
  },

  getStreamLink: async (key, magnet, season = null, episode = null, hash = null, forcedFileIdx = null, userIp = null) => {
    const targetHash = lower(hash || extractHash(magnet));
    try {
      let torrentId = null;
      let files = null;
      const enhancedMagnet = enhanceMagnet(magnet);

      logTorboxEvent("torbox.resolve.start", {
        hash: shortTorboxHash(targetHash),
        season: safeInt(season, 0) || "",
        episode: safeInt(episode, 0) || "",
        forcedFileIdx: forcedFileIdx ?? ""
      });

      if (targetHash) {
        const existing = await findTorrentByHash(key, targetHash);
        if (existing) {
          if (shouldResetTorrent(existing)) {
            logTorboxEvent("torbox.fallback.used", {
              hash: shortTorboxHash(targetHash),
              action: "reset_stale_torrent",
              torrentId: existing.id,
              state: lower(existing.download_state)
            }, "warn");
            await deleteTorrent(key, existing.id);
            await sleep(800);
          } else {
            torrentId = existing.id;
            files = existing.files;
          }
        }
      }

      if (!torrentId) {
        const createRes = await createTorrent(key, enhancedMagnet);

        if (!createRes?.data?.success) {
          const detail = createRes?.data?.detail || createRes?.data?.error || "Unknown";
          const detailStr = redactSecretsInText(typeof detail === "object" ? JSON.stringify(detail) : String(detail));

          if (/exists/i.test(detailStr) && targetHash) {
            const existing = await findTorrentByHash(key, targetHash);
            if (existing) {
              torrentId = existing.id;
              files = existing.files;
            }
          }

          if (!torrentId) {
            throw new TorboxApiError("create_failed", `Add Failed: ${detailStr}`, {
              status: createRes?.status || null,
              transient: createRes?.status >= 500 || createRes?.status === 429,
              safeMessage: "TorBox torrent creation failed"
            });
          }
        } else {
          torrentId = createRes.data.data?.torrent_id || createRes.data.data?.id || null;
          files = createRes.data.data?.files || null;
          invalidateUserList(key);
        }
      }

      if (!torrentId) {
        throw new TorboxApiError("torrent_id_missing", "Torrent ID not available", {
          safeMessage: "TorBox torrent id not available"
        });
      }

      files = await waitForFiles(key, torrentId, files);
      let match = matchFileDetailed(files, season, episode, forcedFileIdx);
      let resolvedFileId = match.fileId;

      logTorboxEvent("torbox.pack.match", {
        hash: shortTorboxHash(targetHash),
        torrentId,
        fileId: resolvedFileId ?? "none",
        confidence: match.confidence,
        reason: match.reason,
        score: Number.isFinite(match.score) ? Math.round(match.score) : String(match.score)
      }, resolvedFileId == null ? "warn" : "info");

      if (resolvedFileId == null) {
        throw new TorboxApiError("stream_not_found", "File not found inside torrent", {
          cacheState: TB_CACHE_STATES.UNCERTAIN,
          safeMessage: "TorBox file match not found"
        });
      }

      let selectedFile = getFileById(files, resolvedFileId);
      let linkRes = await requestDownloadLink(key, torrentId, resolvedFileId, userIp);

      if ((!linkRes?.data?.success || !linkRes?.data?.data) && (!files || files.length === 0)) {
        files = await waitForFiles(key, torrentId, files);
        match = matchFileDetailed(files, season, episode, forcedFileIdx);
        const retryFileId = match.fileId;
        if (retryFileId != null && retryFileId !== resolvedFileId) {
          resolvedFileId = retryFileId;
          selectedFile = getFileById(files, resolvedFileId);
          linkRes = await requestDownloadLink(key, torrentId, resolvedFileId, userIp);
        }
      }

      if (linkRes?.data?.success && linkRes.data.data) {
        const resolvedSize = getFileSize(selectedFile);
        return {
          url: linkRes.data.data,
          filename: getFileName(selectedFile) || null,
          file_size: resolvedSize || null,
          size: resolvedSize || null,
          tb_file_size: resolvedSize || null,
          tb_file_id: Number.isFinite(resolvedFileId) ? resolvedFileId : null,
          file_id: Number.isFinite(resolvedFileId) ? resolvedFileId : null,
          tb_cache_state: TB_CACHE_STATES.CACHED_VERIFIED,
          cacheState: TB_CACHE_STATES.CACHED_VERIFIED,
          confidence: match.confidence,
          match_reason: match.reason
        };
      }

      const err = mapTorboxError(linkRes || {}, "requestdl");
      throw err;
    } catch (error) {
      const err = error instanceof TorboxApiError ? error : mapTorboxError(error, "resolve");
      logTorboxEvent("torbox.resolve.error", {
        hash: shortTorboxHash(targetHash),
        code: err.code,
        status: err.status || "n/a",
        transient: err.transient,
        message: err.safeMessage || err.message
      }, err.transient ? "warn" : "error");
      return null;
    }
  },

  __private: {
    TorboxApiError,
    matchFile,
    matchFileDetailed,
    chooseBestFile,
    hasConflictingExplicitEpisode,
    normalizeCheckcachedInfo,
    mapTorboxError,
    stableKeyFingerprint,
    redactSecretsInText
  }
};

module.exports = TB;
