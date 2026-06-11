"use strict";

const crypto = require("crypto");
const RD = require("../rd/clients/realdebrid_client");
const TB = require("../tb/clients/torbox_client");
const { getCachedAppSettings } = require("../../config/app_settings");
const SnapshotRepo = require("./saved_cloud_snapshot_repository");

const APP_SETTINGS = getCachedAppSettings();
const DEFAULT_MAX_RESULTS = Math.max(1, Math.min(20, parseInt(process.env.SAVED_CLOUD_MAX || "6", 10) || 6));
const DEFAULT_SCAN_LIMIT = Math.max(20, Math.min(500, parseInt(process.env.SAVED_CLOUD_SCAN_LIMIT || String(APP_SETTINGS.savedCloud.scanLimit || 180), 10) || APP_SETTINGS.savedCloud.scanLimit || 180));
const SAVED_CACHE_TTL_MS = Math.max(15_000, Math.min(10 * 60_000, parseInt(process.env.SAVED_CLOUD_CACHE_TTL_MS || "90000", 10) || 90_000));
const VIDEO_EXT_RE = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|iso)$/i;
const JUNK_RE = /\b(sample|trailer|extras?|featurettes?|behind[\s._-]?the[\s._-]?scenes|interview|proof|preview|screens?|nfo|cover|poster|thumb|ost|soundtrack|creditless|ncop|nced)\b/i;
const SERIES_MARKER_RE = /\b(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|season\s*\d{1,2}|stagione\s*\d{1,2})\b/i;

const savedSearchCache = new Map();
const DEBUG_ENABLED = String(process.env.SAVED_CLOUD_DEBUG || "1") !== "0";
const DEBUG_SAMPLE_LIMIT = Math.max(0, Math.min(12, parseInt(process.env.SAVED_CLOUD_DEBUG_SAMPLES || "5", 10) || 5));

function debugLog(logger, message) {
  if (!DEBUG_ENABLED) return;
  logger?.info?.(`[SAVED CLOUD] ${message}`);
}

function safeDebugText(value, max = 96) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function incStat(stats, key) {
  stats[key] = (stats[key] || 0) + 1;
}

function addSample(samples, reason, title, extra = "") {
  if (!DEBUG_ENABLED || samples.length >= DEBUG_SAMPLE_LIMIT) return;
  const text = safeDebugText(title || "n/a");
  const suffix = extra ? ` | ${safeDebugText(extra, 80)}` : "";
  samples.push(`${reason}: ${text}${suffix}`);
}

function summarizeStats(stats) {
  return Object.entries(stats)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function buildMetaDebug(meta = {}) {
  return [
    `title="${safeDebugText(meta.title || meta.name || "n/a", 70)}"`,
    `imdb=${meta.imdb_id || meta.imdb || "n/a"}`,
    `tmdb=${meta.tmdb_id || meta.id || "n/a"}`,
    `year=${meta.year || "n/a"}`,
    `s=${meta.season || 0}`,
    `e=${meta.episode || 0}`,
    `series=${isSeriesMeta(meta)}`,
    `anime=${Boolean(meta.kitsu_id || meta.isAnime)}`
  ].join(" ");
}

function safeInt(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeNum(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableKeyFingerprint(key) {
  const raw = String(key || "");
  if (!raw) return "empty";
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

function isSeriesMeta(meta = {}) {
  return Boolean(
    meta.isSeries ||
    safeInt(meta.season, 0) > 0 ||
    safeInt(meta.episode, 0) > 0
  );
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[\[\](){}]/g, " ")
    .replace(/[._+:-]+/g, " ")
    .replace(/\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10?|dv|dolby\s*vision|hevc|x265|x264|h265|h264|bluray|blu\s*ray|brrip|bdrip|web\s*dl|webrip|web|hdtv|remux|proper|repack|rerip|internal|extended|uncut|remastered|aac|ac3|eac3|ddp\d*\.?\d*|dts|truehd|atmos|ita|italian|eng|english|multi|dual|sub|subs|vostfr|dubbed|audio)\b/g, " ")
    .replace(/\b(?:19\d{2}|20\d{2})\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeName(value).split(/\s+/).filter((token) => token && token.length >= 2);
}

function stripExtension(value) {
  return String(value || "").replace(/\.[a-z0-9]{2,5}$/i, "");
}

function basename(value) {
  const parts = String(value || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(value || "");
}

function getTitleVariants(meta = {}) {
  return Array.from(new Set([
    meta.title,
    meta.originalTitle,
    meta.original_title,
    meta.originalName,
    meta.original_name,
    meta.name,
    meta.englishTitle,
    meta.english_title,
    meta.romajiTitle,
    meta.romaji_title,
    meta.nativeTitle,
    meta.native_title
  ].map((value) => String(value || "").trim()).filter(Boolean)));
}

function hasTitleMatch(text, meta = {}) {
  const haystack = normalizeName(text);
  if (!haystack) return false;
  const variants = getTitleVariants(meta);

  for (const variant of variants) {
    const tokens = tokenize(variant);
    if (tokens.length === 0) continue;
    const required = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.72);
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    if (hits >= required) return true;
  }

  return false;
}

function hasYearMismatch(text, meta = {}) {
  const metaYear = safeInt(meta.year, 0);
  if (!metaYear) return false;
  const match = String(text || "").match(/\b(19\d{2}|20\d{2})\b/);
  if (!match) return false;
  return Math.abs(safeInt(match[1], metaYear) - metaYear) > 1;
}

function isVideoName(value) {
  const raw = String(value || "");
  return VIDEO_EXT_RE.test(raw) && !JUNK_RE.test(raw);
}

function getRdFileName(file = {}) {
  return basename(file.path || file.filename || file.name || "");
}

function getRdFileSize(file = {}) {
  return Math.max(0, safeNum(file.bytes ?? file.size ?? file.filesize, 0));
}

function getRdFileId(file = {}) {
  const parsed = safeInt(file.id ?? file.file_index ?? file.index ?? file.fileIdx, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function getTbFileName(file = {}) {
  return basename(file.name || file.short_name || file.path || "");
}

function getTbFileSize(file = {}) {
  return Math.max(0, safeNum(file.size ?? file.bytes ?? file.filesize, 0));
}

function getTbFileId(file = {}) {
  const parsed = safeInt(file.id ?? file.file_id ?? file.fileId, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function getTorrentHash(torrent = {}, info = {}) {
  return String(info.hash || info.info_hash || torrent.hash || torrent.info_hash || torrent.infoHash || "").trim().toLowerCase();
}

function getTorrentTitle(torrent = {}, info = {}) {
  return String(info.filename || info.name || torrent.filename || torrent.name || torrent.title || "").trim();
}

function parseEpisodeRange(name) {
  const raw = String(name || "");
  const patterns = [
    /\bE?(\d{1,3})\s*[-~]\s*E?(\d{1,3})\b/i,
    /\b(?:episodes?|eps?|episodi)\s*(\d{1,3})\s*[-~]\s*(\d{1,3})\b/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const start = safeInt(match[1], 0);
    const end = safeInt(match[2], 0);
    if (start > 0 && end >= start) return { start, end };
  }

  return null;
}

function episodeRegexes(season, episode, anime = false) {
  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const e2 = String(e).padStart(2, "0");
  const list = [
    { score: 2200, regex: new RegExp(`\\bS(?:eason)?\\s*0*${s}\\s*[-_. ]*E(?:pisode)?\\s*0*${e}\\b`, "i") },
    { score: 2100, regex: new RegExp(`\\bS0*${s}[^a-z0-9]{0,4}E0*${e}\\b`, "i") },
    { score: 2050, regex: new RegExp(`\\b0*${s}x0*${e}\\b`, "i") },
    { score: 1600, regex: new RegExp(`(^|\\D)${s}${e2}(\\D|$)`, "i") },
    { score: 1420, regex: new RegExp(`\\b(?:episode|episodio|ep)\\s*0*${e}\\b`, "i") }
  ];

  if (anime) {
    list.push({ score: 1350, regex: new RegExp(`(?:^|[\\s._\\-\\[\\]()])0*${e}(?:$|[\\s._\\-\\]\\[()])`, "i") });
  }

  return list;
}

function hasConflictingEpisode(name, season, episode, anime = false) {
  const raw = String(name || "");
  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const hints = [];
  const patterns = [
    /\bS(?:eason)?\s*0*(\d{1,2})\s*[-_. ]*E(?:pisode)?\s*0*(\d{1,3})\b/gi,
    /\b(\d{1,2})x(\d{1,3})\b/gi,
    /\b(?:episode|episodio|ep)\s*0*(\d{1,3})\b/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      if (match.length === 3) hints.push({ season: safeInt(match[1], 0), episode: safeInt(match[2], 0) });
      else hints.push({ season: anime ? 0 : s, episode: safeInt(match[1], 0) });
    }
  }

  if (hints.length === 0) return false;
  return !hints.some((hint) => hint.episode === e && (hint.season === s || (anime && hint.season === 0)));
}

function scoreSeriesFile(name, size, meta = {}) {
  const season = safeInt(meta.season, 1) || 1;
  const episode = safeInt(meta.episode, 0);
  if (!episode) return -Infinity;

  const raw = String(name || "");
  const anime = Boolean(meta.kitsu_id || meta.isAnime);
  if (!isVideoName(raw)) return -Infinity;
  if (hasConflictingEpisode(raw, season, episode, anime)) return -Infinity;

  let score = 0;
  for (const entry of episodeRegexes(season, episode, anime)) {
    if (entry.regex.test(raw)) score = Math.max(score, entry.score);
  }

  const range = parseEpisodeRange(raw);
  if (range && episode >= range.start && episode <= range.end) score = Math.max(score, 980);
  if (score <= 0) return -Infinity;
  if (hasTitleMatch(raw, meta)) score += 250;
  if (/\b(?:complete|pack|season|stagione)\b/i.test(raw)) score -= 120;
  if (/\b(?:2160p|1080p|720p|web[- .]?dl|bluray|remux|hevc|x265|x264)\b/i.test(raw)) score += 40;
  score += Math.min(size / (1024 * 1024 * 70), 180);
  return score;
}

function scoreMovieFile(name, size, meta = {}, torrentTitle = "") {
  const raw = String(name || "");
  const combined = `${torrentTitle} ${raw}`;
  if (!isVideoName(raw)) return -Infinity;
  if (SERIES_MARKER_RE.test(combined)) return -Infinity;
  if (hasYearMismatch(combined, meta)) return -Infinity;
  if (!hasTitleMatch(combined, meta) && !hasTitleMatch(raw, meta)) return -Infinity;

  let score = 500;
  if (/\b(?:2160p|4k|uhd)\b/i.test(combined)) score += 70;
  else if (/\b(?:1080p|fhd)\b/i.test(combined)) score += 55;
  else if (/\b(?:720p|hd)\b/i.test(combined)) score += 35;
  if (/\b(?:remux|bluray|web[- .]?dl|webrip|hevc|x265|x264)\b/i.test(combined)) score += 30;
  score += Math.min(size / (1024 * 1024 * 45), 260);
  return score;
}

function chooseBestFile(files, meta = {}, service, torrentTitle = "") {
  const list = Array.isArray(files) ? files : [];
  const isSeries = isSeriesMeta(meta);
  const mapped = list
    .map((file) => {
      const name = service === "rd" ? getRdFileName(file) : getTbFileName(file);
      const size = service === "rd" ? getRdFileSize(file) : getTbFileSize(file);
      const id = service === "rd" ? getRdFileId(file) : getTbFileId(file);
      const score = isSeries ? scoreSeriesFile(name, size, meta) : scoreMovieFile(name, size, meta, torrentTitle);
      return { file, name, size, id, score };
    })
    .filter((entry) => Number.isFinite(entry.score) && entry.score > -Infinity && entry.id !== null);

  mapped.sort((a, b) => b.score - a.score || b.size - a.size);
  return mapped[0] || null;
}

function getRdPlayableFiles(info = {}) {
  const files = Array.isArray(info.files) ? info.files : [];
  const selected = files.filter((file) => Number(file.selected) === 1);
  const source = selected.length > 0 ? selected : files;
  return source.filter((file) => isVideoName(getRdFileName(file)) && !JUNK_RE.test(getRdFileName(file)));
}

function getTbPlayableFiles(torrent = {}) {
  return (Array.isArray(torrent.files) ? torrent.files : [])
    .filter((file) => isVideoName(getTbFileName(file)) && !JUNK_RE.test(getTbFileName(file)));
}

function normalizeExistingHashes(existingHashes) {
  return new Set(Array.from(existingHashes || []).map((hash) => String(hash || "").trim().toLowerCase()).filter(Boolean));
}

function getMode(filters = {}) {
  if (filters.enableSavedCloud !== true) return "off";
  const raw = String(filters.savedCloudMode || "smart").toLowerCase();
  if (["off", "smart", "fallback", "always"].includes(raw)) return raw;
  return "smart";
}

function getLimit(filters = {}, explicitMax = null) {
  const raw = explicitMax ?? filters.savedCloudMax ?? DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(20, safeInt(raw, DEFAULT_MAX_RESULTS)));
}

function getCacheKey({ service, apiKey, meta, mode, max, existingHashes }) {
  const hashSig = Array.from(existingHashes || []).sort().slice(0, 80).join(",");
  const metaId = meta?.imdb_id || meta?.imdb || meta?.tmdb_id || meta?.id || meta?.title || meta?.name || "";
  const year = meta?.year || "";
  const season = meta?.season || 0;
  const episode = meta?.episode || 0;
  const anime = meta?.kitsu_id || meta?.isAnime ? "anime" : "std";

  return [
    service,
    stableKeyFingerprint(apiKey),
    mode,
    max,
    metaId,
    year,
    season,
    episode,
    anime,
    hashSig
  ].join(":");
}

function getFreshCached(key) {
  const cached = savedSearchCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.t > SAVED_CACHE_TTL_MS) {
    savedSearchCache.delete(key);
    return null;
  }
  savedSearchCache.delete(key);
  savedSearchCache.set(key, cached);
  return cached.v;
}

function setCached(key, value) {
  if (savedSearchCache.has(key)) savedSearchCache.delete(key);
  while (savedSearchCache.size >= 400) {
    const first = savedSearchCache.keys().next().value;
    if (!first) break;
    savedSearchCache.delete(first);
  }
  savedSearchCache.set(key, { t: Date.now(), v: value });
  return value;
}

function isCloudTorrentReady(service, torrent = {}, info = {}) {
  const normalizedService = String(service || "").toLowerCase();

  if (normalizedService === "rd") {
    const status = String(info.status || torrent.status || "").toLowerCase();
    return !status || status === "downloaded";
  }

  if (normalizedService === "tb") {
    const state = String(torrent.download_state || torrent.state || torrent.status || info.status || "").toLowerCase();
    const progress = safeNum(torrent.progress ?? info.progress, 0);
    return !state || ["completed", "seeding", "ready"].includes(state) || progress >= 100;
  }

  return false;
}

function createCloudItem({ service, torrent, info, fileEntry, meta }) {
  const hash = getTorrentHash(torrent, info);
  const torrentTitle = getTorrentTitle(torrent, info);
  const sourceLabel = service === "tb" ? "TorBox" : "Real-Debrid";
  const title = fileEntry.name || torrentTitle || `${sourceLabel} ${hash}`;

  return {
    title,
    fileTitle: fileEntry.name || title,
    filename: fileEntry.name || title,
    source: sourceLabel,
    provider: sourceLabel,
    service,
    hash: hash ? hash.toUpperCase() : null,
    infoHash: hash ? hash.toUpperCase() : null,
    torrentId: String(torrent.id || info.id || ""),
    fileIdx: fileEntry.id,
    fileId: fileEntry.id,
    size: fileEntry.size,
    _size: fileEntry.size,
    sizeBytes: fileEntry.size,
    seeders: 0,
    season: meta?.season || 0,
    episode: meta?.episode || 0,
    isSavedCloud: true,
    _savedCloud: true,
    _rdCacheState: "cached",
    rdCacheState: "cached",
    _dbCachedRd: true,
    cached_rd: true,
    _tbCached: service === "tb",
    magnet: null
  };
}

function getSnapshotScanLimit(filters = {}) {
  return Math.max(20, Math.min(1000, safeInt(filters.savedCloudScanLimit, APP_SETTINGS.savedCloud.snapshotWarmMax || DEFAULT_SCAN_LIMIT)));
}

function getSnapshotTtlSeconds(filters = {}) {
  return Math.max(60, Math.min(604800, safeInt(filters.savedCloudSnapshotTtlSeconds, APP_SETTINGS.savedCloud.snapshotTtlSec || 21600)));
}

function isSnapshotEnabled(filters = {}) {
  if (filters.savedCloudSnapshotEnabled === false) return false;
  return APP_SETTINGS.savedCloud.snapshotEnabled !== false;
}

function createCloudItemFromSnapshot(snapshot = {}, meta = {}, logger = null) {
  const service = String(snapshot.service || "").toLowerCase();
  const torrent = {
    ...(snapshot.torrent || {}),
    id: snapshot.torrent?.id || snapshot.torrentId,
    torrent_id: snapshot.torrent?.torrent_id || snapshot.torrentId,
    hash: snapshot.torrent?.hash || snapshot.hash,
    info_hash: snapshot.torrent?.info_hash || snapshot.hash,
    name: snapshot.torrent?.name || snapshot.title,
    filename: snapshot.torrent?.filename || snapshot.title
  };
  const info = {
    ...(snapshot.info || {}),
    id: snapshot.info?.id || snapshot.torrentId,
    hash: snapshot.info?.hash || snapshot.hash,
    info_hash: snapshot.info?.info_hash || snapshot.hash,
    filename: snapshot.info?.filename || snapshot.title,
    name: snapshot.info?.name || snapshot.title,
    status: snapshot.info?.status || (service === "rd" ? "downloaded" : snapshot.state),
    files: Array.isArray(snapshot.files) ? snapshot.files : (Array.isArray(snapshot.info?.files) ? snapshot.info.files : [])
  };

  if (service === "tb") {
    torrent.files = Array.isArray(snapshot.files) ? snapshot.files : (Array.isArray(torrent.files) ? torrent.files : []);
  }

  const state = String(service === "tb" ? (torrent.download_state || torrent.state || torrent.status || snapshot.state || "") : (info.status || snapshot.state || "")).toLowerCase();
  const progress = safeNum(torrent.progress ?? info.progress ?? snapshot.progress, 0);

  if (service === "rd" && state && state !== "downloaded") return null;
  if (service === "tb" && state && !["completed", "seeding", "ready"].includes(state) && progress < 100) return null;

  const title = getTorrentTitle(torrent, info);
  if (title && hasYearMismatch(title, meta)) return null;
  if (title && !hasTitleMatch(title, meta) && !isSeriesMeta(meta)) return null;

  const files = service === "tb" ? getTbPlayableFiles(torrent) : getRdPlayableFiles(info);
  if (!files.length) return null;

  const best = chooseBestFile(files, meta, service, title);
  if (!best) return null;
  if (isSeriesMeta(meta) && !hasTitleMatch(`${title} ${best.name}`, meta)) return null;

  debugLog(logger, `${service.toUpperCase()} snapshot match | hash=${getTorrentHash(torrent, info).slice(0, 12) || "n/a"} torrentId=${torrent.id || torrent.torrent_id || "n/a"} fileId=${best.id} file="${safeDebugText(best.name)}"`);
  return createCloudItem({ service, torrent, info, fileEntry: best, meta });
}

async function findSavedCloudItemsFromSnapshots({ service, apiKey, meta, max, existingHashes, filters, logger }) {
  if (!isSnapshotEnabled(filters)) return [];

  const snapshots = await SnapshotRepo.getFreshSavedCloudSnapshots({
    service,
    apiKey,
    limit: getSnapshotScanLimit(filters)
  });

  if (!Array.isArray(snapshots) || snapshots.length === 0) return [];

  const skipHashes = normalizeExistingHashes(existingHashes);
  const out = [];

  for (const snapshot of snapshots) {
    if (out.length >= max) break;
    const hash = String(snapshot.hash || snapshot.torrent?.hash || snapshot.info?.hash || "").toLowerCase();
    if (hash && skipHashes.has(hash)) continue;

    const item = createCloudItemFromSnapshot({ ...snapshot, service }, meta, logger);
    if (!item) continue;

    if (item.hash) skipHashes.add(String(item.hash).toLowerCase());
    item._savedCloudSnapshot = true;
    item._savedCloudSnapshotSeenCount = snapshot.seenCount || 0;
    item._savedCloudSnapshotLastSeenAt = snapshot.lastSeenAt || null;
    out.push(item);
  }

  if (out.length > 0) {
    logger?.info?.(`[SAVED CLOUD] snapshot hit | service=${String(service).toUpperCase()} count=${out.length} scanned=${snapshots.length}`);
  }

  return out;
}

async function findRdSavedCloudItems({ apiKey, meta, max, existingHashes, logger }) {
  const out = [];
  const stats = {
    scanned: 0,
    duplicate_list_hash: 0,
    list_year_mismatch: 0,
    list_title_no_match: 0,
    missing_torrent_id: 0,
    info_missing: 0,
    not_downloaded: 0,
    duplicate_info_hash: 0,
    info_year_mismatch: 0,
    info_title_no_match: 0,
    no_playable_files: 0,
    no_best_file: 0,
    series_title_no_match: 0,
    added: 0
  };
  const samples = [];
  const skipHashes = normalizeExistingHashes(existingHashes);

  debugLog(logger, `RD scan start | max=${max} scanLimit=${DEFAULT_SCAN_LIMIT} existingHashes=${skipHashes.size} ${buildMetaDebug(meta)}`);

  const list = await RD.listSavedTorrents(apiKey, { limit: DEFAULT_SCAN_LIMIT });
  const safeList = Array.isArray(list) ? list : [];

  debugLog(logger, `RD list response | torrents=${safeList.length}`);

  for (const torrent of safeList) {
    if (out.length >= max) break;
    stats.scanned++;

    const listHash = getTorrentHash(torrent);
    const listTitle = getTorrentTitle(torrent);

    if (listHash && skipHashes.has(listHash)) {
      incStat(stats, "duplicate_list_hash");
      addSample(samples, "dup_hash_list", listTitle, listHash.slice(0, 12));
      continue;
    }

    if (listTitle && hasYearMismatch(listTitle, meta)) {
      incStat(stats, "list_year_mismatch");
      addSample(samples, "year_mismatch_list", listTitle);
      continue;
    }

    if (listTitle && !hasTitleMatch(listTitle, meta) && !isSeriesMeta(meta)) {
      incStat(stats, "list_title_no_match");
      addSample(samples, "title_no_match_list", listTitle);
      continue;
    }

    if (!torrent?.id) {
      incStat(stats, "missing_torrent_id");
      addSample(samples, "missing_torrent_id", listTitle);
      continue;
    }

    let info;
    try {
      info = await RD.getSavedTorrentInfo(apiKey, torrent.id);
    } catch (error) {
      incStat(stats, "info_missing");
      addSample(samples, "info_error", listTitle, error?.message || String(error));
      continue;
    }

    if (!info) {
      incStat(stats, "info_missing");
      addSample(samples, "info_missing", listTitle);
      continue;
    }

    if (isSnapshotEnabled({ savedCloudSnapshotEnabled: true })) {
      SnapshotRepo.upsertSavedCloudSnapshots({
        service: "rd",
        apiKey,
        torrents: [{ torrent, info }],
        ttlSeconds: getSnapshotTtlSeconds({})
      }).catch(() => {});
    }

    if (info.status !== "downloaded") {
      incStat(stats, "not_downloaded");
      addSample(samples, "not_downloaded", listTitle || getTorrentTitle(torrent, info), String(info.status || "unknown"));
      continue;
    }

    const hash = getTorrentHash(torrent, info);
    if (hash && skipHashes.has(hash)) {
      incStat(stats, "duplicate_info_hash");
      addSample(samples, "dup_hash_info", listTitle || getTorrentTitle(torrent, info), hash.slice(0, 12));
      continue;
    }

    const torrentTitle = getTorrentTitle(torrent, info);

    if (hasYearMismatch(torrentTitle, meta)) {
      incStat(stats, "info_year_mismatch");
      addSample(samples, "year_mismatch_info", torrentTitle);
      continue;
    }

    if (!hasTitleMatch(torrentTitle, meta) && !isSeriesMeta(meta)) {
      incStat(stats, "info_title_no_match");
      addSample(samples, "title_no_match_info", torrentTitle);
      continue;
    }

    const files = getRdPlayableFiles(info);
    if (files.length === 0) {
      incStat(stats, "no_playable_files");
      addSample(samples, "no_playable_files", torrentTitle, `files=${Array.isArray(info.files) ? info.files.length : 0}`);
      continue;
    }

    const best = chooseBestFile(files, meta, "rd", torrentTitle);
    if (!best) {
      incStat(stats, "no_best_file");
      addSample(samples, "no_best_file", torrentTitle, `playable=${files.length}`);
      continue;
    }

    if (isSeriesMeta(meta) && !hasTitleMatch(`${torrentTitle} ${best.name}`, meta)) {
      incStat(stats, "series_title_no_match");
      addSample(samples, "series_title_no_match", `${torrentTitle} / ${best.name}`);
      continue;
    }

    stats.added++;
    if (hash) skipHashes.add(hash);
    debugLog(logger, `RD match | hash=${hash ? hash.slice(0, 12) : "n/a"} torrentId=${torrent.id} fileId=${best.id} size=${best.size || 0} score=${Math.round(best.score || 0)} file="${safeDebugText(best.name)}"`);
    out.push(createCloudItem({ service: "rd", torrent, info, fileEntry: best, meta }));
  }

  logger?.info?.(`[SAVED CLOUD] RD scan done | found=${out.length} ${summarizeStats(stats) || "no_stats"}`);
  if (samples.length > 0) debugLog(logger, `RD skip samples | ${samples.join(" || ")}`);

  return out;
}

async function findTbSavedCloudItems({ apiKey, meta, max, existingHashes, logger }) {
  const out = [];
  const stats = {
    scanned: 0,
    not_ready: 0,
    duplicate_hash: 0,
    year_mismatch: 0,
    title_no_match: 0,
    no_playable_files: 0,
    no_best_file: 0,
    series_title_no_match: 0,
    missing_torrent_id: 0,
    added: 0
  };
  const samples = [];
  const skipHashes = normalizeExistingHashes(existingHashes);

  debugLog(logger, `TB scan start | max=${max} scanLimit=${DEFAULT_SCAN_LIMIT} existingHashes=${skipHashes.size} ${buildMetaDebug(meta)}`);

  const list = await TB.listSavedTorrents(apiKey, { limit: DEFAULT_SCAN_LIMIT });
  const safeList = Array.isArray(list) ? list : [];

  debugLog(logger, `TB list response | torrents=${safeList.length}`);

  if (safeList.length > 0 && isSnapshotEnabled({ savedCloudSnapshotEnabled: true })) {
    SnapshotRepo.upsertSavedCloudSnapshots({
      service: "tb",
      apiKey,
      torrents: safeList,
      ttlSeconds: getSnapshotTtlSeconds({})
    }).catch(() => {});
  }

  for (const torrent of safeList) {
    if (out.length >= max) break;
    stats.scanned++;

    const state = String(torrent.download_state || torrent.state || torrent.status || "").toLowerCase();
    const progress = safeNum(torrent.progress, 0);
    const torrentTitle = getTorrentTitle(torrent);

    if (state && !["completed", "seeding", "ready"].includes(state) && progress < 100) {
      incStat(stats, "not_ready");
      addSample(samples, "not_ready", torrentTitle, `state=${state || "n/a"} progress=${progress}`);
      continue;
    }

    const hash = getTorrentHash(torrent);
    if (hash && skipHashes.has(hash)) {
      incStat(stats, "duplicate_hash");
      addSample(samples, "dup_hash", torrentTitle, hash.slice(0, 12));
      continue;
    }

    if (hasYearMismatch(torrentTitle, meta)) {
      incStat(stats, "year_mismatch");
      addSample(samples, "year_mismatch", torrentTitle);
      continue;
    }

    if (torrentTitle && !hasTitleMatch(torrentTitle, meta) && !isSeriesMeta(meta)) {
      incStat(stats, "title_no_match");
      addSample(samples, "title_no_match", torrentTitle);
      continue;
    }

    if (!torrent?.id && !torrent?.torrent_id) {
      incStat(stats, "missing_torrent_id");
      addSample(samples, "missing_torrent_id", torrentTitle);
      continue;
    }

    const files = getTbPlayableFiles(torrent);
    if (files.length === 0) {
      incStat(stats, "no_playable_files");
      addSample(samples, "no_playable_files", torrentTitle, `files=${Array.isArray(torrent.files) ? torrent.files.length : 0}`);
      continue;
    }

    const best = chooseBestFile(files, meta, "tb", torrentTitle);
    if (!best) {
      incStat(stats, "no_best_file");
      addSample(samples, "no_best_file", torrentTitle, `playable=${files.length}`);
      continue;
    }

    if (isSeriesMeta(meta) && !hasTitleMatch(`${torrentTitle} ${best.name}`, meta)) {
      incStat(stats, "series_title_no_match");
      addSample(samples, "series_title_no_match", `${torrentTitle} / ${best.name}`);
      continue;
    }

    stats.added++;
    if (hash) skipHashes.add(hash);
    debugLog(logger, `TB match | hash=${hash ? hash.slice(0, 12) : "n/a"} torrentId=${torrent.id || torrent.torrent_id} fileId=${best.id} size=${best.size || 0} score=${Math.round(best.score || 0)} file="${safeDebugText(best.name)}"`);
    out.push(createCloudItem({ service: "tb", torrent, info: torrent, fileEntry: best, meta }));
  }

  logger?.info?.(`[SAVED CLOUD] TB scan done | found=${out.length} ${summarizeStats(stats) || "no_stats"}`);
  if (samples.length > 0) debugLog(logger, `TB skip samples | ${samples.join(" || ")}`);

  return out;
}

async function findSavedCloudDuplicateHashes(options = {}) {
  const service = String(options.service || "").toLowerCase();
  const existing = normalizeExistingHashes(options.existingHashes);
  const apiKey = options.apiKey;
  const meta = options.meta || {};
  const logger = options.logger;

  if (!apiKey || !existing.size || !["rd", "tb"].includes(service)) {
    debugLog(logger, `duplicate scan skip | service=${service || "n/a"} existing=${existing.size} hasKey=${Boolean(apiKey)}`);
    return [];
  }

  try {
    const list = service === "tb"
      ? await TB.listSavedTorrents(apiKey, { limit: DEFAULT_SCAN_LIMIT })
      : await RD.listSavedTorrents(apiKey, { limit: DEFAULT_SCAN_LIMIT });
    const safeList = Array.isArray(list) ? list : [];
    const matches = new Map();
    const stats = {
      scanned: 0,
      missing_hash: 0,
      not_ready: 0,
      not_existing: 0,
      year_mismatch: 0,
      matched: 0
    };
    const samples = [];

    for (const torrent of safeList) {
      stats.scanned++;

      const hash = getTorrentHash(torrent, torrent);
      const title = getTorrentTitle(torrent, torrent) || "Magnet";

      if (!hash) {
        incStat(stats, "missing_hash");
        continue;
      }

      if (!isCloudTorrentReady(service, torrent, torrent)) {
        incStat(stats, "not_ready");
        addSample(samples, "dup_not_ready", title, hash.slice(0, 12));
        continue;
      }

      if (!existing.has(hash)) {
        incStat(stats, "not_existing");
        continue;
      }

      if (title && hasYearMismatch(title, meta)) {
        incStat(stats, "year_mismatch");
        addSample(samples, "dup_year_mismatch", title, hash.slice(0, 12));
        continue;
      }

      if (!matches.has(hash)) {
        matches.set(hash, {
          service,
          hash: hash.toUpperCase(),
          infoHash: hash.toUpperCase(),
          title,
          torrentId: String(torrent.id || ""),
          source: service === "tb" ? "TorBox" : "Real-Debrid",
          provider: service === "tb" ? "TorBox" : "Real-Debrid",
          duplicateOnly: true,
          isSavedCloudDuplicate: true,
          isSavedCloud: true,
          _savedCloud: true
        });
        incStat(stats, "matched");
        addSample(samples, "dup_cloud_match", title, hash.slice(0, 12));
      }
    }

    debugLog(logger, `${service.toUpperCase()} duplicate scan done | matches=${matches.size} ${summarizeStats(stats) || "no_stats"}`);
    if (samples.length) debugLog(logger, `${service.toUpperCase()} duplicate samples | ${samples.join(" || ")}`);
    return Array.from(matches.values());
  } catch (error) {
    logger?.warn?.(`[SAVED CLOUD] ${service.toUpperCase()} duplicate scan failed: ${error?.message || error}`);
    return [];
  }
}

async function findSavedCloudItems(options = {}) {
  const service = String(options.service || "").toLowerCase();
  const filters = options.filters || {};
  const mode = getMode(filters);
  const keyFp = stableKeyFingerprint(options.apiKey || "");
  const existingHashes = normalizeExistingHashes(options.existingHashes);

  debugLog(options.logger, `resolver enter | service=${service || "n/a"} mode=${mode} enabled=${filters.enableSavedCloud === true} hasKey=${Boolean(options.apiKey)} keyfp=${keyFp} existingHashes=${existingHashes.size} ${buildMetaDebug(options.meta || {})}`);

  if (mode === "off") {
    debugLog(options.logger, "resolver stop | reason=mode_off_or_toggle_disabled");
    return [];
  }

  if (!options.apiKey) {
    debugLog(options.logger, "resolver stop | reason=missing_api_key");
    return [];
  }

  if (!["rd", "tb"].includes(service)) {
    debugLog(options.logger, `resolver stop | reason=invalid_service service=${service || "n/a"}`);
    return [];
  }

  const max = getLimit(filters, options.max);
  const cacheKey = getCacheKey({
    service,
    apiKey: options.apiKey,
    meta: options.meta || {},
    mode,
    max,
    existingHashes
  });
  const cached = getFreshCached(cacheKey);

  if (cached) {
    options.logger?.info?.(`[SAVED CLOUD] cache hit | service=${service.toUpperCase()} count=${Array.isArray(cached) ? cached.length : 0} mode=${mode}`);
    return cached;
  }

  try {
    const snapshotResults = await findSavedCloudItemsFromSnapshots({
      service,
      apiKey: options.apiKey,
      meta: options.meta || {},
      max,
      existingHashes,
      filters,
      logger: options.logger
    });

    const liveFallback = APP_SETTINGS.savedCloud.liveFallback !== false;

    if (snapshotResults.length >= max || !liveFallback) {
      const slicedSnapshots = snapshotResults.slice(0, max);
      debugLog(options.logger, `resolver done | service=${service.toUpperCase()} source=snapshot returned=${slicedSnapshots.length} max=${max}`);
      return setCached(cacheKey, slicedSnapshots);
    }

    const snapshotHashes = new Set([
      ...Array.from(existingHashes),
      ...snapshotResults.map((item) => String(item.hash || item.infoHash || "").toLowerCase()).filter(Boolean)
    ]);
    const args = {
      apiKey: options.apiKey,
      meta: options.meta || {},
      max,
      existingHashes: snapshotHashes,
      logger: options.logger
    };
    const liveResults = service === "tb"
      ? await findTbSavedCloudItems(args)
      : await findRdSavedCloudItems(args);
    const results = [...snapshotResults, ...liveResults].slice(0, max);

    if (results.length > 0) {
      debugLog(
        options.logger,
        `resolver results | service=${service.toUpperCase()} items=${results.map((item) => `${item._savedCloudSnapshot ? "snapshot" : "live"}:${safeDebugText(item.fileTitle || item.title, 48)}`).join(" | ")}`
      );
    }

    debugLog(options.logger, `resolver done | service=${service.toUpperCase()} snapshot=${snapshotResults.length} live=${liveResults.length} returned=${results.length} max=${max}`);
    return setCached(cacheKey, results);
  } catch (error) {
    options.logger?.warn?.(`[SAVED CLOUD] ${service.toUpperCase()} fallito: ${error?.message || error}`);
    return setCached(cacheKey, []);
  }
}

module.exports = {
  findSavedCloudItems,
  findSavedCloudDuplicateHashes,
  getMode,
  getLimit,
  getSnapshotScanLimit,
  getSnapshotTtlSeconds,
  normalizeName
};
