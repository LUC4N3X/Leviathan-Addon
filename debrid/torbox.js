const axios = require("axios");
const https = require("https");

const TB_BASE = "https://api.torbox.app/v1/api";
const TB_TIMEOUT = 60000;
const LIST_CACHE_TTL = 30000;
const MAX_RETRIES = 4;
const MAX_INFO_POLLS = 4;
const POLL_DELAYS = [1200, 1800, 2500, 3500];

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
  const str = String(key || "");
  if (!str) return "__empty__";
  if (str.length <= 10) return str;
  return `${str.slice(0, 4)}:${str.slice(-4)}`;
}

function getCacheEntry(key) {
  if (!userListCache.has(key)) {
    userListCache.set(key, { data: null, timestamp: 0, pending: null });
  }
  return userListCache.get(key);
}

function invalidateUserList(key) {
  if (key) {
    userListCache.delete(key);
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

function getRetryDelay(error, attempt) {
  const status = error?.response?.status;
  const retryAfter = safeInt(error?.response?.headers?.["retry-after"]);
  if (retryAfter > 0) return retryAfter * 1000;
  if (status === 429) return 4000 + attempt * 1200;
  return 1200 * (attempt + 1);
}

function isRetryableError(error) {
  const status = error?.response?.status;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  return ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(error?.code);
}

async function tbRequest(method, endpoint, key, { data = null, params = null, timeout = TB_TIMEOUT } = {}) {
  let lastResponse = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const config = {
        method,
        url: `${TB_BASE}${endpoint}`,
        headers: { ...COMMON_HEADERS, Authorization: `Bearer ${key}` },
        timeout,
        params,
        httpsAgent,
        validateStatus: () => true
      };

      if (method === "POST" && data) {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(data)) {
          if (v == null) continue;
          form.append(k, String(v));
        }
        config.data = form;
        config.headers["Content-Type"] = "application/x-www-form-urlencoded";
      }

      const response = await axios(config);
      lastResponse = response;
      if (response.status >= 200 && response.status < 300) {
        return response;
      }
      if (attempt < MAX_RETRIES - 1 && isRetryableError({ response })) {
        await sleep(getRetryDelay({ response }, attempt));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt < MAX_RETRIES - 1 && isRetryableError(error)) {
        await sleep(getRetryDelay(error, attempt));
        continue;
      }
      return error?.response || lastResponse || null;
    }
  }
  return lastResponse;
}

async function fetchUserList(key, extraParams = null) {
  const res = await tbRequest("GET", "/torrents/mylist", key, {
    params: { bypass_cache: true, ...(extraParams || {}) }
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

function isVideoFile(file) {
  const name = getFileName(file);
  return VIDEO_EXTENSIONS.test(name) && !JUNK_PATTERN.test(name);
}

function isExtraFile(file) {
  return EXTRA_PATTERN.test(getFileName(file));
}

function isSeasonPackName(name, season) {
  if (!season) return false;
  return new RegExp(`\bseason\s*0*${season}\b|\bcomplete\b|\bpack\b|\b全集\b|\bcollection\b|\bintegrale\b|\bstagione\s*0*${season}\b`, "i").test(name);
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
    { score: 1200, regex: new RegExp(`\bS(?:eason)?\s*0*${s}\s*[-_. ]*E(?:pisode)?\s*0*${e}\b`, "i") },
    { score: 1180, regex: new RegExp(`\b0*${s}x0*${e}\b`, "i") },
    { score: 1140, regex: new RegExp(`\bS0*${s}[^a-z0-9]{0,4}E0*${e}\b`, "i") },
    { score: 1090, regex: new RegExp(`\b${s}${e2}\b`) },
    { score: 980, regex: new RegExp(`\bepisode\s*0*${e}\b|\bep\s*0*${e}\b`, "i") },
    { score: 760, regex: new RegExp(`(?:^|\D)0*${e}(?:\D|$)`) }
  ];
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
  const name = normalizeName(getFileName(file));
  const size = getFileSize(file);
  let score = 0;

  if (!isVideoFile(file)) return -Infinity;

  score += 300;
  score += Math.min(size / (1024 * 1024 * 50), 150);
  if (isExtraFile(file)) score -= 320;

  for (const { score: bonus, regex } of buildEpisodeRegexes(season, episode)) {
    if (regex.test(name)) {
      score += bonus;
      break;
    }
  }

  const range = parseEpisodeRange(name);
  const targetEpisode = safeInt(episode, 0);
  if (range) {
    if (targetEpisode >= range.start && targetEpisode <= range.end) {
      score -= 220;
    } else {
      score -= 500;
    }
  }

  if (isSeasonPackName(name, season)) score -= 180;
  if (/\b(batch|multi|全集|complete|collection|pack)\b/i.test(name)) score -= 120;
  if (/\b(2160p|1080p|720p|bluray|bdrip|web[- ]?dl|webrip|remux)\b/i.test(name)) score += 20;

  return score;
}

function resolveForcedFileId(files, forcedFileIdx) {
  if (forcedFileIdx == null) return null;
  const raw = safeInt(forcedFileIdx, NaN);
  if (!Number.isFinite(raw) || raw < 0) return null;

  const byId = files.find((file) => getFileId(file) === raw);
  if (byId) return getFileId(byId);

  if (raw < files.length) {
    return getFileId(files[raw]);
  }

  return null;
}

function chooseBestFile(files, season, episode) {
  const list = Array.isArray(files) ? files.slice() : [];
  if (list.length === 0) return null;

  const videoFiles = list.filter((file) => isVideoFile(file));
  const candidates = videoFiles.length > 0 ? videoFiles : list;

  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const isMovie = s <= 0 && e <= 0;

  const ranked = candidates
    .map((file) => ({
      file,
      score: isMovie ? buildMovieScore(file) : buildEpisodeScore(file, s, e),
      size: getFileSize(file)
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => (b.score - a.score) || (b.size - a.size));

  return ranked[0]?.file || null;
}

function matchFile(files, season, episode, forcedFileIdx = null) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return null;

  const forced = resolveForcedFileId(list, forcedFileIdx);
  if (forced != null) return forced;

  const selected = chooseBestFile(list, season, episode);
  return selected ? getFileId(selected) : null;
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
    data: { torrent_id: torrentId, operation: "delete" }
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
  let createRes = await tbRequest("POST", "/torrents/createtorrent", key, { data: postData });

  const detail = createRes?.data?.detail || createRes?.data?.error || "";
  const detailStr = typeof detail === "object" ? JSON.stringify(detail) : String(detail || "");

  if (!createRes?.data?.success && /limit|active|storage|space/i.test(detailStr)) {
    const freed = await freeUpSpace(key);
    if (freed) {
      createRes = await tbRequest("POST", "/torrents/createtorrent", key, { data: postData });
    }
  }

  return createRes;
}

async function requestDownloadLink(key, torrentId, fileId, userIp = null) {
  const params = {
    token: key,
    torrent_id: torrentId,
    file_id: fileId,
    zip_link: "false"
  };
  if (userIp) params.user_ip = userIp;
  return tbRequest("GET", "/torrents/requestdl", key, { params });
}

const TB = {
  checkCached: async (key, hashes) => {
    const clean = Array.from(new Set((Array.isArray(hashes) ? hashes : [])
      .map((hash) => lower(hash))
      .filter(Boolean)));
    if (clean.length === 0) return [];

    const res = await tbRequest("GET", "/torrents/checkcached", key, {
      params: {
        hash: clean.join(","),
        format: "object",
        list_files: "false"
      },
      timeout: 20000
    });

    if (!res?.data?.data) return [];

    const cached = [];
    for (const [hash, info] of Object.entries(res.data.data)) {
      if (info?.cached || (Array.isArray(info?.files) && info.files.length > 0) || safeNum(info?.size, 0) > 0) {
        cached.push(lower(hash));
      }
    }
    return cached;
  },

  getStreamLink: async (key, magnet, season = null, episode = null, hash = null, forcedFileIdx = null, userIp = null) => {
    try {
      let torrentId = null;
      let files = null;
      const targetHash = lower(hash || extractHash(magnet));
      const enhancedMagnet = enhanceMagnet(magnet);

      if (targetHash) {
        const existing = await findTorrentByHash(key, targetHash);
        if (existing) {
          if (shouldResetTorrent(existing)) {
            console.log(`🧹 [TorBox:${stableKeyFingerprint(key)}] reset torrent ${existing.id} state=${lower(existing.download_state)}`);
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
          const detailStr = typeof detail === "object" ? JSON.stringify(detail) : String(detail);

          if (/exists/i.test(detailStr) && targetHash) {
            const existing = await findTorrentByHash(key, targetHash);
            if (existing) {
              torrentId = existing.id;
              files = existing.files;
            }
          }

          if (!torrentId) {
            throw new Error(`Add Failed: ${detailStr}`);
          }
        } else {
          torrentId = createRes.data.data?.torrent_id || createRes.data.data?.id || null;
          files = createRes.data.data?.files || null;
          invalidateUserList(key);
        }
      }

      if (!torrentId) {
        throw new Error("Torrent ID not available");
      }

      files = await waitForFiles(key, torrentId, files);
      const fileId = matchFile(files, season, episode, forcedFileIdx);

      if (fileId == null) {
        throw new Error("File not found inside torrent");
      }

      let linkRes = await requestDownloadLink(key, torrentId, fileId, userIp);

      if ((!linkRes?.data?.success || !linkRes?.data?.data) && (!files || files.length === 0)) {
        files = await waitForFiles(key, torrentId, files);
        const retryFileId = matchFile(files, season, episode, forcedFileIdx);
        if (retryFileId != null && retryFileId !== fileId) {
          linkRes = await requestDownloadLink(key, torrentId, retryFileId, userIp);
        }
      }

      if (linkRes?.data?.success && linkRes.data.data) {
        return { url: linkRes.data.data };
      }

      const detail = linkRes?.data?.detail || linkRes?.data?.error || `HTTP ${linkRes?.status || "unknown"}`;
      const detailStr = typeof detail === "object" ? JSON.stringify(detail) : String(detail);
      throw new Error(`Link Request Failed: ${detailStr}`);
    } catch (error) {
      console.error(`💥 [TorBox:${stableKeyFingerprint(key)}] ${error?.message || error}`);
      return null;
    }
  }
};

module.exports = TB;
