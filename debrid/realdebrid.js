const axios = require("axios");
const https = require("https");

const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";
const RD_TIMEOUT = 30000;
const MAX_POLL = 30;
const POLL_DELAY = 1000;
const MAX_INSTANT_HASHES_PER_BATCH = 80;
const MAX_ACTIVE_CACHE = 300;
const ACTIVE_TORRENT_TTL = 10 * 60 * 1000;
const INSTANT_CACHE_TTL = 90 * 1000;
const STREAM_LINK_CACHE_TTL = 3 * 60 * 1000;
const REQUEST_MIN_INTERVAL = Number.parseInt(process.env.RD_MIN_INTERVAL_MS || "350", 10);

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 64,
    keepAliveMsecs: 30000,
});

const rdClient = axios.create({
    baseURL: RD_API_BASE,
    timeout: RD_TIMEOUT,
    httpsAgent,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
});

const requestQueues = new Map();
const activeTorrentCache = new Map();
const instantAvailabilityCache = new Map();
const streamLinkCache = new Map();

function getQueue(token) {
    const key = String(token || "").trim();
    let queue = requestQueues.get(key);
    if (!queue) {
        let tail = Promise.resolve();
        queue = async (task) => {
            const start = tail.catch(() => undefined);
            const run = start.then(async () => {
                if (REQUEST_MIN_INTERVAL > 0) await sleep(REQUEST_MIN_INTERVAL);
                return task();
            });
            tail = run.catch(() => undefined);
            return run;
        };
        requestQueues.set(key, queue);
    }
    return queue;
}

function setExpiringMap(map, key, value, ttlMs) {
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (map.size > MAX_ACTIVE_CACHE) {
        const first = map.keys().next();
        if (!first.done) map.delete(first.value);
    }
}

function getExpiringMap(map, key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        map.delete(key);
        return null;
    }
    return entry.value;
}

function dropActiveTorrentCache(hash) {
    if (!hash) return;
    activeTorrentCache.delete(String(hash).toLowerCase());
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function coerceBytes(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function normalizeId(value) {
    return value === undefined || value === null ? null : String(value);
}

function normalizeInt(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
}

function isVideo(path) {
    return /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i.test(String(path || ""));
}

function isJunkVideo(path) {
    return /(^|[\s._\-/])(sample|trailer|featurette|extras?|behind[\s._-]?the[\s._-]?scenes)([\s._\-/]|$)/i.test(String(path || ""));
}

function getVideoFiles(files) {
    return (Array.isArray(files) ? files : []).filter((file) => isVideo(file?.path) && !isJunkVideo(file?.path));
}

function sortByLargest(files) {
    return [...files].sort((a, b) => coerceBytes(b?.bytes) - coerceBytes(a?.bytes));
}

function extractBtihHash(magnet) {
    const match = String(magnet || "").match(/btih:([A-Za-z0-9]+)/i);
    return match ? match[1].toLowerCase() : null;
}

const Status = {
    ERROR: (status) => ["error", "magnet_error", "virus", "compressing", "upload_error"].includes(status),
    WAITING_SELECTION: (status) => status === "waiting_files_selection",
    DOWNLOADING: (status) => ["downloading", "uploading", "queued", "magnet_conversion"].includes(status),
    DOWNLOADED: (status) => status === "downloaded",
    DEAD: (status) => status === "dead",
    READY: (status, info) => status === "downloaded" || (status === "downloading" && Number(info?.progress) === 100 && Array.isArray(info?.links) && info.links.length > 0),
};

function buildEpisodePatterns(season, episode) {
    const s = normalizeInt(season);
    const e = normalizeInt(episode);
    if (!s || !e) return [];

    const escapedS = String(s);
    const escapedE = String(e);
    const patterns = [
        new RegExp(`(?:^|[^a-z0-9])s0?${escapedS}[ ._\-]*e0?${escapedE}(?:[^a-z0-9]|$)`, "i"),
        new RegExp(`(?:^|[^a-z0-9])${escapedS}x0?${escapedE}(?:[^a-z0-9]|$)`, "i"),
        new RegExp(`(?:season|stagione)[ ._\-]*0?${escapedS}.*?(?:episode|episodio|ep)[ ._\-]*0?${escapedE}(?:[^a-z0-9]|$)`, "i"),
    ];

    if (s === 1) {
        patterns.push(new RegExp(`(?:^|[^a-z0-9])(?:ep|episode|episodio|e)[ ._\-]*0?${escapedE}(?:[^a-z0-9]|$)`, "i"));
    }

    return patterns;
}

function sanitizePathForLooseMatch(path) {
    return String(path || "")
        .toLowerCase()
        .replace(/\b(?:2160p|1080p|720p|480p|x264|h264|x265|h265|hevc|aac|ac3|dts|ddp?\d(?:\.\d)?|truehd|atmos|bluray|webrip|web-dl|remux)\b/g, " ")
        .replace(/\b(?:5\.1|7\.1|2\.0)\b/g, " ")
        .replace(/[._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function matchFile(files, season, episode, fileIdx) {
    const videoFiles = getVideoFiles(files);
    if (videoFiles.length === 0) return null;

    const normalizedFileIdx = normalizeId(fileIdx);
    if (normalizedFileIdx && normalizedFileIdx !== "-1") {
        const exactMatch = videoFiles.find((file) => normalizeId(file?.id) === normalizedFileIdx);
        if (exactMatch) return exactMatch.id;
    }

    const s = normalizeInt(season);
    const e = normalizeInt(episode);

    if (!s || !e) {
        const largest = sortByLargest(videoFiles)[0];
        return largest ? largest.id : null;
    }

    const strictPatterns = buildEpisodePatterns(s, e);
    for (const pattern of strictPatterns) {
        const found = videoFiles.find((file) => pattern.test(String(file?.path || "")));
        if (found) return found.id;
    }

    if (videoFiles.length === 1) {
        return videoFiles[0].id;
    }

    const looseMatch = videoFiles.find((file) => {
        const cleaned = sanitizePathForLooseMatch(file?.path);
        const hasSeason = new RegExp(`(?:^|\\b)(?:season|stagione|s)\\s*0?${s}(?:\\b|$)`, "i").test(cleaned);
        const hasEpisode = new RegExp(`(?:^|\\b)(?:episode|episodio|ep|e)?\\s*0?${e}(?:\\b|$)`, "i").test(cleaned);
        return hasSeason && hasEpisode;
    });

    return looseMatch ? looseMatch.id : null;
}

function buildSelectedLinkMap(info) {
    const selectedFiles = (Array.isArray(info?.files) ? info.files : []).filter((file) => Number(file?.selected) === 1);
    const links = Array.isArray(info?.links) ? info.links : [];
    const map = new Map();

    selectedFiles.forEach((file, index) => {
        if (links[index]) {
            map.set(normalizeId(file.id), links[index]);
        }
    });

    return map;
}

function pickTargetLink(info, season, episode, fileIdx) {
    const selectedLinkMap = buildSelectedLinkMap(info);
    if (selectedLinkMap.size === 0) return null;

    const targetFileId = matchFile(info?.files, season, episode, fileIdx);
    if (targetFileId !== null && targetFileId !== undefined) {
        const exact = selectedLinkMap.get(normalizeId(targetFileId));
        if (exact) return exact;
    }

    const selectedVideoFiles = (Array.isArray(info?.files) ? info.files : []).filter(
        (file) => Number(file?.selected) === 1 && isVideo(file?.path) && !isJunkVideo(file?.path)
    );

    if (!normalizeInt(season) || !normalizeInt(episode)) {
        const largestSelected = sortByLargest(selectedVideoFiles)[0];
        if (largestSelected) {
            const link = selectedLinkMap.get(normalizeId(largestSelected.id));
            if (link) return link;
        }
    }

    if (selectedVideoFiles.length === 1) {
        const fallback = selectedLinkMap.get(normalizeId(selectedVideoFiles[0].id));
        if (fallback) return fallback;
    }

    const firstLink = Array.isArray(info?.links) ? info.links[0] : null;
    return firstLink || null;
}

async function rdRequest(method, endpoint, token, data = null) {
    const authToken = String(token || "").trim();
    if (!authToken) {
        console.error("[RD AUTH] Token mancante.");
        return null;
    }

    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const response = await getQueue(authToken)(() => rdClient({
                method,
                url: endpoint,
                headers: { Authorization: `Bearer ${authToken}` },
                data,
            }));
            return response.data;
        } catch (error) {
            const status = error.response?.status;

            if (status === 401) {
                console.error("[RD AUTH] Token non valido o revocato.");
                return null;
            }

            if (status === 403) {
                console.error("[RD AUTH] Accesso negato da Real-Debrid (premium scaduto, token senza permessi o account limitato).");
                return null;
            }

            if (status === 404) {
                return null;
            }

            const transientNetworkError = ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(error.code);
            const shouldRetry = status === 429 || (status >= 500 && status < 600) || transientNetworkError;

            if (!shouldRetry) {
                console.error(`[RD ERROR] ${endpoint} -> ${error.message}`);
                return null;
            }

            const retryAfterHeader = Number(error.response?.headers?.["retry-after"]);
            const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : null;
            const waitTime = retryAfterMs || (status === 429 ? (2000 + attempt * 1000) : (1000 + attempt * 500));

            if (status === 429) {
                console.warn(`[RD 429] Rate limit. Retry tra ${waitTime}ms.`);
            }

            await sleep(waitTime);
        }
    }

    return null;
}

async function waitForTorrentReady(token, torrentId, initialInfo = null) {
    let info = initialInfo || await rdRequest("GET", `/torrents/info/${torrentId}`, token);
    if (!info) return null;

    for (let i = 0; i < MAX_POLL; i++) {
        if (Status.ERROR(info.status) || Status.DEAD(info.status) || Status.READY(info.status, info)) {
            return info;
        }

        await sleep(POLL_DELAY);
        info = await rdRequest("GET", `/torrents/info/${torrentId}`, token);
        if (!info) return null;
    }

    return info;
}


function getStreamCacheKey(hash, season, episode, fileIdx) {
    return `${String(hash || '').toLowerCase()}:${normalizeInt(season) || 0}:${normalizeInt(episode) || 0}:${normalizeId(fileIdx) || '-1'}`;
}

async function getOrCreateTorrent(token, magnet, hash) {
    const normalizedHash = String(hash || '').toLowerCase();
    const cached = normalizedHash ? getExpiringMap(activeTorrentCache, normalizedHash) : null;
    if (cached?.id) {
        const info = await rdRequest('GET', `/torrents/info/${cached.id}`, token);
        if (info && !Status.ERROR(info.status) && !Status.DEAD(info.status)) {
            return { id: cached.id, requiresDelete: false, info };
        }
        dropActiveTorrentCache(normalizedHash);
    }

    const body = new URLSearchParams();
    body.append('magnet', magnet);
    const add = await rdRequest('POST', '/torrents/addMagnet', token, body);
    if (!add?.id) {
        return null;
    }
    if (normalizedHash) {
        setExpiringMap(activeTorrentCache, normalizedHash, { id: add.id }, ACTIVE_TORRENT_TTL);
    }
    return { id: add.id, requiresDelete: true, info: null };
}

async function waitForTorrentReadyAfterSelection(token, torrentId, initialInfo = null) {
    let info = initialInfo || await rdRequest('GET', `/torrents/info/${torrentId}`, token);
    if (!info) return null;

    for (let i = 0; i < Math.min(MAX_POLL, 12); i++) {
        if (Status.ERROR(info.status) || Status.DEAD(info.status) || Status.READY(info.status, info)) {
            return info;
        }
        await sleep(POLL_DELAY);
        info = await rdRequest('GET', `/torrents/info/${torrentId}`, token);
        if (!info) return null;
    }
    return info;
}

const RD = {
    deleteTorrent: async (token, id) => {
        if (!id) return;
        try {
            await rdRequest("DELETE", `/torrents/delete/${id}`, token);
        } catch {
            // ignore cleanup errors
        }
    },

    checkCacheLeviathan: async (token, magnet, hash) => {
        let torrentId = null;
        try {
            const body = new URLSearchParams();
            body.append("magnet", magnet);

            const add = await rdRequest("POST", "/torrents/addMagnet", token, body);
            if (!add?.id) return { cached: false, hash };
            torrentId = add.id;

            let info = await rdRequest("GET", `/torrents/info/${torrentId}`, token);
            if (!info) {
                await RD.deleteTorrent(token, torrentId);
                return { cached: false, hash };
            }

            if (Status.WAITING_SELECTION(info.status)) {
                const selectAll = new URLSearchParams();
                selectAll.append("files", "all");
                await rdRequest("POST", `/torrents/selectFiles/${torrentId}`, token, selectAll);
                info = await waitForTorrentReady(token, torrentId);
            }

            const videoFiles = sortByLargest(getVideoFiles(info?.files));
            const mainFile = videoFiles[0] || null;
            const isCached = Status.DOWNLOADED(info?.status);

            await RD.deleteTorrent(token, torrentId);

            return {
                hash,
                cached: isCached,
                filename: mainFile ? String(mainFile.path || "").split("/").pop() : null,
                filesize: mainFile ? coerceBytes(mainFile.bytes) : null,
            };
        } catch (error) {
            if (torrentId) await RD.deleteTorrent(token, torrentId);
            return { cached: false, hash, error: error.message };
        }
    },
    getStreamLink: async (token, magnet, season = null, episode = null, fileIdx = undefined) => {
        const targetHash = extractBtihHash(magnet);
        const cacheKey = getStreamCacheKey(targetHash, season, episode, fileIdx);
        const cachedStream = getExpiringMap(streamLinkCache, cacheKey);
        if (cachedStream?.url) {
            return cachedStream;
        }

        let torrentId = null;
        let requiresDelete = true;

        try {
            const torrent = await getOrCreateTorrent(token, magnet, targetHash);
            if (!torrent?.id) {
                throw new Error('Magnet add failed');
            }

            torrentId = torrent.id;
            requiresDelete = torrent.requiresDelete;

            let info = torrent.info || await rdRequest('GET', `/torrents/info/${torrentId}`, token);
            if (!info) {
                throw new Error('Info retrieval failed');
            }

            if (Status.ERROR(info.status) || Status.DEAD(info.status)) {
                if (requiresDelete) await RD.deleteTorrent(token, torrentId);
                else dropActiveTorrentCache(targetHash);
                return null;
            }

            if (Status.WAITING_SELECTION(info.status)) {
                const matchedFileId = matchFile(info.files, season, episode, fileIdx);
                const videoFiles = getVideoFiles(info.files);

                if (normalizeInt(season) && normalizeInt(episode) && !matchedFileId && videoFiles.length > 1) {
                    if (requiresDelete) await RD.deleteTorrent(token, torrentId);
                    return null;
                }

                const selectionBody = new URLSearchParams();
                selectionBody.append('files', matchedFileId !== null && matchedFileId !== undefined ? matchedFileId : 'all');
                const selectionOk = await rdRequest('POST', `/torrents/selectFiles/${torrentId}`, token, selectionBody);
                if (selectionOk === null) {
                    if (requiresDelete) await RD.deleteTorrent(token, torrentId);
                    return null;
                }

                info = await waitForTorrentReadyAfterSelection(token, torrentId);
                if (!info || Status.ERROR(info.status) || Status.DEAD(info.status) || !Status.READY(info.status, info)) {
                    if (requiresDelete) await RD.deleteTorrent(token, torrentId);
                    return null;
                }
            } else if (!Status.READY(info.status, info)) {
                info = await waitForTorrentReadyAfterSelection(token, torrentId, info);
                if (!info || !Status.READY(info.status, info)) {
                    if (requiresDelete) await RD.deleteTorrent(token, torrentId);
                    return null;
                }
            }

            const targetLink = pickTargetLink(info, season, episode, fileIdx);
            if (!targetLink) {
                if (requiresDelete) await RD.deleteTorrent(token, torrentId);
                return null;
            }

            const unrestrictBody = new URLSearchParams();
            unrestrictBody.append('link', targetLink);
            const unrestrict = await rdRequest('POST', '/unrestrict/link', token, unrestrictBody);

            if (requiresDelete) {
                await RD.deleteTorrent(token, torrentId);
            } else if (targetHash) {
                setExpiringMap(activeTorrentCache, targetHash, { id: torrentId }, ACTIVE_TORRENT_TTL);
            }

            if (!unrestrict?.download) {
                return null;
            }

            const result = {
                type: 'ready',
                url: unrestrict.download,
                filename: unrestrict.filename,
                size: unrestrict.filesize,
            };
            setExpiringMap(streamLinkCache, cacheKey, result, STREAM_LINK_CACHE_TTL);
            return result;
        } catch {
            if (torrentId && requiresDelete) {
                await RD.deleteTorrent(token, torrentId);
            }
            return null;
        }
    },

    checkInstantAvailability: async (token, hashes) => {
        const normalizedHashes = [...new Set((Array.isArray(hashes) ? hashes : [])
            .map((hash) => String(hash || '').trim().toLowerCase())
            .filter(Boolean))];

        if (normalizedHashes.length === 0) {
            return {};
        }

        const output = {};
        const missing = [];
        for (const hash of normalizedHashes) {
            const cached = getExpiringMap(instantAvailabilityCache, hash);
            if (cached) output[hash] = cached;
            else missing.push(hash);
        }

        for (let i = 0; i < missing.length; i += MAX_INSTANT_HASHES_PER_BATCH) {
            const batch = missing.slice(i, i + MAX_INSTANT_HASHES_PER_BATCH);
            const partial = await rdRequest('GET', `/torrents/instantAvailability/${batch.join('/')}`, token);
            if (partial && typeof partial === 'object') {
                for (const [hash, value] of Object.entries(partial)) {
                    Object.assign(output, { [hash.toLowerCase()]: value });
                    setExpiringMap(instantAvailabilityCache, hash.toLowerCase(), value, INSTANT_CACHE_TTL);
                }
            }
        }

        return output;
    },
};

module.exports = RD;
