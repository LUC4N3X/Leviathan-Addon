const axios = require("axios");

const {
  TB_CACHE_STATES,
  normalizeTbCacheState,
  toRdCacheState,
  shouldPersistNegativeTbState,
  shortTorboxHash,
  redactSecretsInText
} = require("./torbox_cache_state");

const TB_BASE_URL = "https://api.torbox.app/v1/api";

const CHUNK_SIZE = 40;
const API_TIMEOUT = 14000;
const MAX_RETRIES = 4;
const RETRY_DELAY_BASE = 1600;
const MAX_CONCURRENCY = 3;
const DEFAULT_SYNC_LIMIT = 20;
const MIN_VIDEO_SIZE = 50 * 1024 * 1024;

const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|webm|iso|m4v|ts)$/i;
const JUNK_PATTERN = /\b(sample|trailer|promo|preview|screens?|proof|nfo|cover|poster|thumb)\b/i;
const EXTRA_PATTERN = /\b(ova|oad|special|extras?|featurette|intervista|interview|behind\s*the\s*scenes|making\s*of|recap|riassunto|ncop|nced|ost|soundtrack)\b/i;

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

function normalizeHash(value) {
  return lower(value).replace(/[^a-f0-9]/g, '');
}

function findTorboxListEntry(data, requestedHash, requestedHashes = []) {
  const normalizedRequested = normalizeHash(requestedHash);
  if (!data) return null;

  if (Array.isArray(data)) {
    for (let index = 0; index < data.length; index += 1) {
      const entry = data[index];
      const candidates = [entry?.hash, entry?.info_hash, entry?.torrent_hash, entry?.hash_value]
        .map(normalizeHash)
        .filter(Boolean);
      if (candidates.includes(normalizedRequested)) return entry;
      if (!candidates.length && normalizeHash(requestedHashes[index]) === normalizedRequested) return entry;
    }
    return null;
  }

  if (typeof data === "object") {
    for (const [hash, info] of Object.entries(data)) {
      if (normalizeHash(hash) === normalizedRequested) return info;
    }
  }

  return null;
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

function isRetryable(error) {
  const status = error?.response?.status;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  return ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(error?.code);
}

function getRetryDelay(error, attempt) {
  const retryAfter = safeInt(error?.response?.headers?.["retry-after"]);
  if (retryAfter > 0) return retryAfter * 1000;
  if (error?.response?.status === 429) return 4000 + attempt * 1000;
  return RETRY_DELAY_BASE * (attempt + 1);
}

async function fetchWithRetry(url, config, retries = MAX_RETRIES) {
  let lastResponse = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await axios.get(url, {
        ...config,
        validateStatus: () => true
      });
      lastResponse = response;
      if (response.status >= 200 && response.status < 300) {
        return response;
      }
      if (attempt < retries - 1 && isRetryable({ response })) {
        await sleep(getRetryDelay({ response }, attempt));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt < retries - 1 && isRetryable(error)) {
        await sleep(getRetryDelay(error, attempt));
        continue;
      }
      throw error;
    }
  }
  return lastResponse;
}

function getFileId(file) {
  const raw = file?.id ?? file?.file_id ?? null;
  const parsed = safeInt(raw, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFileName(file) {
  return String(file?.name || file?.short_name || "");
}

function getFileSize(file) {
  return Math.max(0, safeNum(file?.size, 0));
}

function isVideoCandidate(file) {
  const name = getFileName(file);
  return VIDEO_EXTENSIONS.test(name) && !JUNK_PATTERN.test(name) && getFileSize(file) >= MIN_VIDEO_SIZE;
}

function isExtraFile(file) {
  return EXTRA_PATTERN.test(getFileName(file));
}

function isSeasonPackName(name, season) {
  if (!season) return false;
  return new RegExp(`\\bseason\\s*0*${season}\\b|\\bcomplete\\b|\\bpack\\b|\\bcollection\\b|\\bintegrale\\b|\\bstagione\\s*0*${season}\\b`, "i").test(name);
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
    { score: 1200, regex: new RegExp(`\\bS(?:eason)?\\s*0*${s}\\s*[-_. ]*E(?:pisode)?\\s*0*${e}\\b`, "i") },
    { score: 1180, regex: new RegExp(`\\b0*${s}x0*${e}\\b`, "i") },
    { score: 1140, regex: new RegExp(`\\bS0*${s}[^a-z0-9]{0,4}E0*${e}\\b`, "i") },
    { score: 1090, regex: new RegExp(`\\b${s}${e2}\\b`) },
    { score: 980, regex: new RegExp(`\\bepisode\\s*0*${e}\\b|\\bep\\s*0*${e}\\b`, "i") },
    { score: 760, regex: new RegExp(`(?:^|\\D)0*${e}(?:\\D|$)`) }
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

function getNested(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function extractItemMeta(item) {
  const hash = lower(item?.hash || item?.infoHash || item?.btih || item?.info_hash);
  const season = safeInt(
    item?.season ?? item?.season_number ?? item?.meta?.season ?? getNested(item, ["series", "season"]),
    0
  );
  const episode = safeInt(
    item?.episode ?? item?.episode_number ?? item?.meta?.episode ?? getNested(item, ["series", "episode"]),
    0
  );
  const type = lower(item?.type || item?.media_type || item?.meta?.type || "");
  const title = String(item?.title || item?.name || item?.meta?.name || item?.meta?.title || "");
  const imdbId = String(item?.imdb_id || item?.imdbId || item?.meta?.imdb_id || item?.meta?.imdbId || "").trim().toLowerCase();

  return {
    hash,
    season,
    episode,
    imdbId: /^tt\d+$/.test(imdbId) ? imdbId : null,
    isEpisodeRequest: season > 0 || episode > 0 || type === "series" || type === "episode" || type === "anime",
    title
  };
}

function buildMovieScore(file) {
  const name = normalizeName(getFileName(file));
  const size = getFileSize(file);
  let score = 0;
  score += 380;
  score += Math.min(size / (1024 * 1024 * 40), 180);
  if (isExtraFile(file)) score -= 320;
  if (/\b(2160p|1080p|720p|bluray|bdrip|web[- ]?dl|webrip|remux)\b/i.test(name)) score += 25;
  return score;
}

function buildEpisodeScore(file, season, episode) {
  const rawName = getFileName(file);
  const name = normalizeName(rawName);
  const size = getFileSize(file);
  let score = 0;

  if (hasConflictingExplicitEpisode(rawName, season, episode)) return -Infinity;

  score += 300;
  score += Math.min(size / (1024 * 1024 * 50), 150);
  if (isExtraFile(file)) score -= 320;

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
      score -= 220;
    } else {
      score -= 500;
    }
  }

  if (!matched && isSeasonPackName(name, season)) score -= 180;
  if (/\b(batch|multi|complete|collection|pack|全集)\b/i.test(name)) score -= 120;
  if (/\b(2160p|1080p|720p|bluray|bdrip|web[- ]?dl|webrip|remux)\b/i.test(name)) score += 20;

  return score;
}

function pickBestFile(files, meta) {
  const candidates = files.filter(isVideoCandidate);
  if (candidates.length === 0) {
    return { file: null, confidence: 0, score: -Infinity, reason: "no_video_candidates" };
  }

  const isEpisodeRequest = Boolean(meta?.isEpisodeRequest);
  const ranked = candidates
    .map((file) => ({
      file,
      score: isEpisodeRequest
        ? buildEpisodeScore(file, meta?.season || 0, meta?.episode || 0)
        : buildMovieScore(file),
      size: getFileSize(file)
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => (b.score - a.score) || (b.size - a.size));

  const best = ranked[0] || null;
  if (!best) return { file: null, confidence: 0, score: -Infinity, reason: "no_confident_episode_file" };

  let confidence = 0;
  if (!isEpisodeRequest) {
    confidence = candidates.length === 1 ? 1 : 0.82;
  } else if (best.score >= 1100) {
    confidence = 1;
  } else if (best.score >= 900) {
    confidence = 0.92;
  } else if (best.score >= 760) {
    confidence = candidates.length === 1 ? 0.9 : 0.68;
  } else {
    confidence = candidates.length === 1 ? 0.6 : 0.35;
  }

  return {
    file: best.file,
    confidence,
    score: best.score,
    reason: confidence >= 0.75 ? "file_match_confident" : "file_match_uncertain"
  };
}

function makeCacheResult(state, extra = {}) {
  const normalized = normalizeTbCacheState(state);
  return {
    cached: normalized === TB_CACHE_STATES.CACHED_VERIFIED ? true : (normalized === TB_CACHE_STATES.UNCACHED ? false : null),
    state: normalized,
    cache_state: normalized,
    tb_cache_state: normalized,
    rd_cache_state: toRdCacheState(normalized),
    confidence: 0,
    ...extra
  };
}

function parseHashResult(hash, info, meta = null) {
  const lowerHash = lower(hash);

  if (!info) {
    return [lowerHash, makeCacheResult(TB_CACHE_STATES.UNCACHED, {
      match_reason: "hash_not_returned"
    })];
  }

  const apiState = lower(info?.download_state || info?.state || info?.status);
  if (/(queued|pending|downloading|processing)/i.test(apiState)) {
    return [lowerHash, makeCacheResult(TB_CACHE_STATES.QUEUED, {
      torrent_title: info.name || null,
      size: safeNum(info.size, 0) || null,
      match_reason: `api_state_${apiState || "queued"}`
    })];
  }

  const hasFiles = Array.isArray(info?.files) && info.files.length > 0;
  const totalSize = safeNum(info?.size, 0);

  if (!hasFiles) {
    if (info?.cached === true || totalSize > 0) {
      return [lowerHash, makeCacheResult(TB_CACHE_STATES.LIKELY_CACHED, {
        torrent_title: info.name || null,
        size: totalSize || null,
        confidence: 0.45,
        match_reason: "metadata_without_files"
      })];
    }
    return [lowerHash, makeCacheResult(TB_CACHE_STATES.UNCACHED, {
      match_reason: "no_files_no_size"
    })];
  }

  const validVideoFiles = info.files.filter(isVideoCandidate);
  if (validVideoFiles.length === 0) {
    return [lowerHash, makeCacheResult(TB_CACHE_STATES.UNCACHED, {
      torrent_title: info.name || null,
      size: totalSize || null,
      match_reason: "no_video_files"
    })];
  }

  const { file: bestFile, confidence, score, reason } = pickBestFile(validVideoFiles, meta);
  const bestSize = bestFile ? getFileSize(bestFile) : Math.max(...validVideoFiles.map(getFileSize), 0);
  const bestId = bestFile ? getFileId(bestFile) : null;
  const isEpisodeRequest = Boolean(meta?.isEpisodeRequest);
  const shouldExposeFileId = confidence >= 0.75 && bestId != null;
  const verified = Boolean(bestFile && (!isEpisodeRequest || shouldExposeFileId));

  if (verified) {
    return [lowerHash, makeCacheResult(TB_CACHE_STATES.CACHED_VERIFIED, {
      torrent_title: info.name || null,
      size: bestSize || totalSize || null,
      file_title: getFileName(bestFile) || null,
      file_size: bestSize || null,
      file_id: bestId,
      confidence,
      match_score: score,
      match_reason: reason || "file_verified"
    })];
  }

  return [lowerHash, makeCacheResult(TB_CACHE_STATES.UNCERTAIN, {
    torrent_title: info.name || null,
    size: bestSize || totalSize || null,
    file_title: confidence >= 0.5 && bestFile ? getFileName(bestFile) : null,
    file_size: confidence >= 0.5 ? bestSize || null : null,
    file_id: null,
    confidence,
    match_score: score,
    match_reason: reason || "file_match_uncertain"
  })];
}

function errorStateForResponse(response, fallbackMessage = "torbox_api_error") {
  const status = response?.status || 0;
  let code = "api_error";
  if (status === 401 || status === 403) code = "auth_error";
  else if (status === 429) code = "rate_limited";
  else if (status >= 500) code = "server_error";
  else if (status >= 400) code = "request_error";
  return { status, code, message: fallbackMessage };
}

function buildErrorResults(entries, errorInfo) {
  const results = {};
  for (const entry of entries) {
    results[entry.hash] = makeCacheResult(TB_CACHE_STATES.ERROR, {
      error_code: errorInfo.code,
      http_status: errorInfo.status || null,
      match_reason: errorInfo.message || "api_error"
    });
  }
  return results;
}

function logCacheEvent(event, payload = {}, level = "info") {
  const safePayload = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (/token|key|authorization/i.test(key)) continue;
    safePayload[key] = value;
  }
  const message = `[${event}] ${Object.entries(safePayload).map(([k, v]) => `${k}=${v}`).join(" ")}`.trim();
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.info(message);
}

function summarizeStates(results) {
  const counts = {
    cached_verified: 0,
    likely_cached: 0,
    uncertain: 0,
    queued: 0,
    uncached: 0,
    error: 0
  };
  for (const value of Object.values(results || {})) {
    const state = normalizeTbCacheState(value?.state || value?.cache_state || (value?.cached === true ? TB_CACHE_STATES.CACHED_VERIFIED : TB_CACHE_STATES.UNCACHED));
    counts[state] = (counts[state] || 0) + 1;
  }
  return counts;
}

async function checkChunk(entries, token) {
  const hashes = entries.map((entry) => entry.hash).filter(Boolean);
  const results = {};
  if (hashes.length === 0) return results;

  logCacheEvent("torbox.cache.check.start", {
    hashes: hashes.length,
    sample: hashes.slice(0, 3).map(shortTorboxHash).join(",")
  });

  try {
    const response = await fetchWithRetry(`${TB_BASE_URL}/torrents/checkcached`, {
      params: {
        hash: hashes.join(","),
        format: "list",
        list_files: "true"
      },
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "Leviathan/2.0 (TB Cache)"
      },
      timeout: API_TIMEOUT
    });

    if (!response || response.status < 200 || response.status >= 300) {
      const errorInfo = errorStateForResponse(response, `http_${response?.status || "unknown"}`);
      const errorResults = buildErrorResults(entries, errorInfo);
      logCacheEvent("torbox.cache.check.result", {
        hashes: hashes.length,
        error: hashes.length,
        code: errorInfo.code,
        status: errorInfo.status || "n/a"
      }, errorInfo.status === 429 || errorInfo.status >= 500 ? "warn" : "error");
      return errorResults;
    }

    const data = response?.data;
    if (data?.success && data?.data) {
      for (const entry of entries) {
        const info = findTorboxListEntry(data.data, entry.hash, hashes);
        const [key, value] = parseHashResult(entry.hash, info, entry.meta);
        results[key] = value;
      }
    } else {
      const detail = redactSecretsInText(data?.detail || data?.error || "missing_data");
      Object.assign(results, buildErrorResults(entries, {
        status: response.status,
        code: "malformed_response",
        message: detail
      }));
    }

    const counts = summarizeStates(results);
    logCacheEvent("torbox.cache.check.result", {
      hashes: hashes.length,
      verified: counts.cached_verified,
      likely: counts.likely_cached,
      uncertain: counts.uncertain,
      queued: counts.queued,
      uncached: counts.uncached,
      error: counts.error
    });
  } catch (error) {
    const message = redactSecretsInText(error?.message || String(error));
    Object.assign(results, buildErrorResults(entries, {
      status: error?.response?.status || null,
      code: error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" ? "timeout" : "network_error",
      message
    }));
    logCacheEvent("torbox.cache.check.result", {
      hashes: hashes.length,
      error: hashes.length,
      code: error?.code || "network_error"
    }, "warn");
  }

  return results;
}

function buildEntries(items, limit) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const meta = extractItemMeta(item);
    if (!meta.hash || seen.has(meta.hash)) continue;
    seen.add(meta.hash);
    out.push({ hash: meta.hash, meta, raw: item });
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

async function runInBatches(chunks, token) {
  const allResults = {};
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENCY) {
    const batch = chunks.slice(i, i + MAX_CONCURRENCY);
    const partials = await Promise.all(batch.map((chunk) => checkChunk(chunk, token)));
    for (const partial of partials) {
      Object.assign(allResults, partial);
    }
  }
  return allResults;
}

async function checkHashes(entries, token) {
  if (!Array.isArray(entries) || entries.length === 0) return {};

  const chunks = [];
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    chunks.push(entries.slice(i, i + CHUNK_SIZE));
  }

  return runInBatches(chunks, token);
}

function buildDbUpdate(hash, apiRes, meta = null) {
  const state = normalizeTbCacheState(
    apiRes?.state || apiRes?.cache_state || apiRes?.tb_cache_state || (apiRes?.cached === true ? TB_CACHE_STATES.CACHED_VERIFIED : (apiRes?.cached === false ? TB_CACHE_STATES.UNCACHED : TB_CACHE_STATES.UNCERTAIN))
  );
  const cached = state === TB_CACHE_STATES.CACHED_VERIFIED ? true : (shouldPersistNegativeTbState(state) ? false : null);

  return {
    hash,
    cached,
    torrent_title: apiRes?.torrent_title || null,
    size: apiRes?.size || null,
    file_title: apiRes?.file_title || null,
    file_size: state === TB_CACHE_STATES.CACHED_VERIFIED ? apiRes?.file_size || null : null,
    file_id: state === TB_CACHE_STATES.CACHED_VERIFIED && apiRes?.file_id != null ? apiRes.file_id : null,
    imdb_id: meta?.imdbId || null,
    imdb_season: meta?.isEpisodeRequest && meta?.season > 0 ? meta.season : null,
    imdb_episode: meta?.isEpisodeRequest && meta?.episode > 0 ? meta.episode : null,
    tb_cache_state: state,
    confidence: apiRes?.confidence || 0
  };
}

async function flushDbUpdates(dbHelper, updates) {
  if (!dbHelper || typeof dbHelper.updateTbCacheStatus !== "function" || updates.length === 0) {
    return;
  }
  try {
    await dbHelper.updateTbCacheStatus(updates);
  } catch (_) {}
}

async function checkCacheSync(items, token, dbHelper, limit = DEFAULT_SYNC_LIMIT) {
  const safeItems = Array.isArray(items) ? items : [];
  const cappedLimit = limit == null ? DEFAULT_SYNC_LIMIT : Math.max(0, safeInt(limit, DEFAULT_SYNC_LIMIT));
  const entries = buildEntries(safeItems, cappedLimit);

  if (entries.length === 0) return {};

  const apiResults = await checkHashes(entries, token);
  const results = {};
  const updates = [];

  for (const entry of entries) {
    const apiRes = apiResults[entry.hash] || makeCacheResult(TB_CACHE_STATES.UNCACHED, { match_reason: "not_returned" });
    const state = normalizeTbCacheState(apiRes.state || apiRes.cache_state || (apiRes.cached === true ? TB_CACHE_STATES.CACHED_VERIFIED : (apiRes.cached === false ? TB_CACHE_STATES.UNCACHED : TB_CACHE_STATES.UNCERTAIN)));
    results[entry.hash] = {
      cached: state === TB_CACHE_STATES.CACHED_VERIFIED,
      state,
      cache_state: state,
      tb_cache_state: state,
      rd_cache_state: toRdCacheState(state),
      confidence: apiRes.confidence || 0,
      file_title: state === TB_CACHE_STATES.CACHED_VERIFIED ? apiRes.file_title || null : null,
      file_size: state === TB_CACHE_STATES.CACHED_VERIFIED ? apiRes.file_size || null : null,
      file_id: state === TB_CACHE_STATES.CACHED_VERIFIED && apiRes.file_id != null ? apiRes.file_id : null,
      match_reason: apiRes.match_reason || null,
      error_code: apiRes.error_code || null
    };
    updates.push(buildDbUpdate(entry.hash, apiRes, entry.meta));
  }

  await flushDbUpdates(dbHelper, updates);
  return results;
}

async function enrichCacheBackground(items, token, dbHelper) {
  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length <= DEFAULT_SYNC_LIMIT) return;

  const entries = buildEntries(safeItems.slice(DEFAULT_SYNC_LIMIT), 0);
  if (entries.length === 0) return;

  const apiResults = await checkHashes(entries, token);
  const updates = entries.map((entry) => buildDbUpdate(entry.hash, apiResults[entry.hash] || makeCacheResult(TB_CACHE_STATES.UNCACHED, { match_reason: "not_returned" }), entry.meta));
  await flushDbUpdates(dbHelper, updates);
}

module.exports = {
  checkCacheSync,
  enrichCacheBackground,
  __private: {
    buildDbUpdate,
    extractItemMeta,
    parseHashResult,
    pickBestFile,
    normalizeTbCacheState,
    TB_CACHE_STATES
  }
};
