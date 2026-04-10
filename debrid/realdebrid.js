const axios = require("axios");

const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";
const RD_TIMEOUT = 120000;
const RD_MAX_RETRIES = 4;
const RD_READY_POLL_ATTEMPTS = 8;
const RD_READY_POLL_DELAY = 900;

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i;
const JUNK_VIDEO_RE =
    /\b(sample|trailer|extras?|featurettes?|behind[\s._-]?the[\s._-]?scenes|interview|proof|preview)\b/i;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback = 0) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function isVideoFilePath(filePath) {
    return typeof filePath === "string" && VIDEO_EXT_RE.test(filePath);
}

function isSampleOrJunk(filePath) {
    if (typeof filePath !== "string") return true;
    const lower = filePath.toLowerCase();
    return lower.includes("sample") || JUNK_VIDEO_RE.test(lower);
}

function normalizeFiles(files) {
    if (!Array.isArray(files)) return [];
    return files.filter(
        (f) =>
            f &&
            typeof f.path === "string" &&
            f.path.trim() &&
            (typeof f.id !== "undefined")
    );
}

function getValidVideoFiles(files) {
    return normalizeFiles(files).filter(
        (f) => isVideoFilePath(f.path) && !isSampleOrJunk(f.path)
    );
}

function pickBestMovieFileId(files) {
    const candidates = getValidVideoFiles(files);
    if (!candidates.length) return null;

    const scored = candidates.map((file) => {
        const path = file.path.toLowerCase();
        let score = 0;

        const size = Number(file.bytes) || 0;
        score += size;

        if (/\/extras?\//i.test(path) || /\\extras?\\/i.test(path)) score -= 5e12;
        if (/\/specials?\//i.test(path) || /\\specials?\\/i.test(path)) score -= 5e12;
        if (/commentary/i.test(path)) score -= 3e12;


        const depth = path.split(/[\\/]/).length;
        score -= depth * 1e9;

        return { id: file.id, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.id ?? null;
}


function normalizeFileId(file) {
    const rawId = file?.id ?? file?.file_index ?? file?.index ?? file?.fileIdx;
    const parsed = Number.parseInt(rawId, 10);
    return Number.isInteger(parsed) ? parsed : null;
}

function parseEpisodeSignature(filePath, defaultSeason) {
    const value = String(filePath || "").replace(/[._-]+/g, " ");
    const patterns = [
        /(?:^|\b)s(\d{1,2})\s*e(\d{1,3})(?:\b|[^\d])/i,
        /(?:^|\b)(\d{1,2})x(\d{1,3})(?:\b|[^\d])/i,
        /season\s*(\d{1,2}).{0,20}?episode\s*(\d{1,3})/i,
        /stagione\s*(\d{1,2}).{0,20}?episodio\s*(\d{1,3})/i,
        /(?:^|[^a-z])ep?\.?\s*(\d{1,3})(?:[^\d]|$)/i,
        /(?:^|[^\d])(\d{3})(?:[^\d]|$)/
    ];

    for (let index = 0; index < patterns.length; index += 1) {
        const match = value.match(patterns[index]);
        if (!match) continue;
        if (index <= 3) return { season: toInt(match[1]), episode: toInt(match[2]), exact: true };
        if (index === 4) return { season: toInt(defaultSeason || 1), episode: toInt(match[1]), exact: false };
        const raw = toInt(match[1]);
        if (raw >= 100) return { season: Math.floor(raw / 100), episode: raw % 100, exact: false };
    }

    return null;
}

function matchFile(files, season, episode, forcedFileIdx = null) {
    const targetSeason = toInt(season, 0);
    const targetEpisode = toInt(episode, 0);
    const videoFiles = getValidVideoFiles(files);
    if (!videoFiles.length) return null;

    const forcedIndex = Number.parseInt(forcedFileIdx, 10);
    if (Number.isInteger(forcedIndex) && forcedIndex >= 0) {
        const forcedMatch = videoFiles.find((file) => normalizeFileId(file) === forcedIndex);
        if (forcedMatch) return normalizeFileId(forcedMatch);
    }

    if (!targetSeason || !targetEpisode) {
        if (videoFiles.length === 1) return normalizeFileId(videoFiles[0]);
        return null;
    }

    let best = null;
    let bestScore = -Infinity;

    for (const file of videoFiles) {
        const fileId = normalizeFileId(file);
        if (!Number.isInteger(fileId)) continue;

        const parsed = parseEpisodeSignature(file.path, targetSeason);
        if (!parsed) continue;
        if (parsed.season !== targetSeason || parsed.episode !== targetEpisode) continue;

        let score = 0;
        const lowered = String(file.path || "").toLowerCase();
        if (parsed.exact) score += 1000;
        if (/\bs\d{1,2}\s*e\d{1,3}\b/i.test(lowered)) score += 80;
        if (/\b\d{1,2}x\d{1,3}\b/i.test(lowered)) score += 60;
        if (/episode|episodio|\bep\b/i.test(lowered)) score += 25;
        if (/sample|trailer|extras?|featurettes?|behind[\s._-]?the[\s._-]?scenes|interview|preview/i.test(lowered)) score -= 500;
        score += Math.min(Math.floor((Number(file.bytes) || 0) / (200 * 1024 * 1024)), 50);

        if (score > bestScore) {
            bestScore = score;
            best = file;
        }
    }

    if (best) return normalizeFileId(best);
    return videoFiles.length === 1 ? normalizeFileId(videoFiles[0]) : null;
}

// ============================================================================

function isRetryableStatus(status) {
    return status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(error) {
    const code = error?.code;
    return (
        code === "ECONNABORTED" ||
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        code === "EAI_AGAIN" ||
        code === "ENOTFOUND"
    );
}

async function rdRequest(method, url, token, data = null) {
    for (let attempt = 0; attempt < RD_MAX_RETRIES; attempt++) {
        try {
            const config = {
                method,
                url,
                headers: {
                    Authorization: `Bearer ${token}`
                },
                timeout: RD_TIMEOUT,
                maxRedirects: 5,
                validateStatus: () => true
            };

            if (data) {
                config.data = data;
                if (data instanceof URLSearchParams) {
                    config.headers["Content-Type"] = "application/x-www-form-urlencoded";
                }
            }

            const response = await axios(config);
            const status = response.status;

            if (status >= 200 && status < 300) {
                return response.data;
            }

            if (status === 401 || status === 403 || status === 404) {
                return null;
            }

            if (isRetryableStatus(status)) {
                const backoff = 900 + attempt * 700 + Math.floor(Math.random() * 400);
                await sleep(backoff);
                continue;
            }

            return null;
        } catch (error) {
            if (attempt < RD_MAX_RETRIES - 1 && isRetryableNetworkError(error)) {
                const backoff = 900 + attempt * 700 + Math.floor(Math.random() * 400);
                await sleep(backoff);
                continue;
            }
            return null;
        }
    }

    return null;
}

async function getTorrentInfo(token, torrentId) {
    return rdRequest("GET", `${RD_API_BASE}/torrents/info/${torrentId}`, token);
}

async function waitUntilReady(token, torrentId) {
    let lastInfo = null;

    for (let i = 0; i < RD_READY_POLL_ATTEMPTS; i++) {
        lastInfo = await getTorrentInfo(token, torrentId);
        if (!lastInfo) return null;

        if (
            lastInfo.status === "downloaded" &&
            Array.isArray(lastInfo.links) &&
            lastInfo.links.length > 0
        ) {
            return lastInfo;
        }

        if (
            lastInfo.status === "error" ||
            lastInfo.status === "magnet_error" ||
            lastInfo.status === "virus" ||
            lastInfo.status === "dead"
        ) {
            return lastInfo;
        }

        await sleep(RD_READY_POLL_DELAY);
    }

    return lastInfo;
}

function resolveSelectedLink(info, selectedFileId = null) {
    if (!info || !Array.isArray(info.links) || !info.links.length) return null;
    if (info.links.length === 1) return info.links[0];

    const files = Array.isArray(info.files) ? info.files : [];
    const selectedFiles = files.filter((f) => Number(f.selected) === 1);

    if (selectedFileId != null && selectedFiles.length === info.links.length) {
        const idx = selectedFiles.findIndex(
            (f) => String(f.id) === String(selectedFileId)
        );
        if (idx >= 0 && info.links[idx]) {
            return info.links[idx];
        }
    }

    return info.links[0] || null;
}

const RD = {
    deleteTorrent: async (token, torrentId) => {
        if (!torrentId) return;
        try {
            await rdRequest("DELETE", `${RD_API_BASE}/torrents/delete/${torrentId}`, token);
        } catch (_) {}
    },

    checkInstantAvailability: async (token, hashes) => {
        try {
            if (!Array.isArray(hashes) || hashes.length === 0) return {};
            const cleanHashes = hashes.filter(Boolean);
            if (!cleanHashes.length) return {};

            const hashString = cleanHashes.join("/");
            const url = `${RD_API_BASE}/torrents/instantAvailability/${hashString}`;
            return (await rdRequest("GET", url, token)) || {};
        } catch (_) {
            return {};
        }
    },

    getStreamLink: async (token, magnet, season = null, episode = null, forcedFileIdx = null) => {
        let torrentId = null;

        try {

            const addBody = new URLSearchParams();
            addBody.append("magnet", magnet);

            const addRes = await rdRequest(
                "POST",
                `${RD_API_BASE}/torrents/addMagnet`,
                token,
                addBody
            );

            if (!addRes || !addRes.id) return null;
            torrentId = addRes.id;


            let info = await getTorrentInfo(token, torrentId);
            if (!info) {
                await RD.deleteTorrent(token, torrentId);
                return null;
            }


            let selectedFileId = null;

            if (info.status === "waiting_files_selection") {
                let fileIdToSelect = "all";

 
                if (season && episode && info.files) {
                    const matchedId = matchFile(info.files, season, episode, forcedFileIdx);
                    if (matchedId) {
                        selectedFileId = matchedId;
                        fileIdToSelect = matchedId;
                        console.log(
                            `🎯 RD Match: selezionato file ID ${matchedId} per S${season}E${episode}`
                        );
                    } else {
                        const validVideoFiles = getValidVideoFiles(info.files);
                        if (validVideoFiles.length === 1) {
                            const singleId = normalizeFileId(validVideoFiles[0]);
                            if (Number.isInteger(singleId)) {
                                selectedFileId = singleId;
                                fileIdToSelect = singleId;
                            }
                        } else {
                            await RD.deleteTorrent(token, torrentId);
                            return null;
                        }
                    }
                } else if (info.files) {

                    const bestMovieFileId = pickBestMovieFileId(info.files);
                    if (bestMovieFileId) {
                        selectedFileId = bestMovieFileId;
                        fileIdToSelect = bestMovieFileId;
                    }
                }

                const selBody = new URLSearchParams();
                selBody.append("files", String(fileIdToSelect));

                const selRes = await rdRequest(
                    "POST",
                    `${RD_API_BASE}/torrents/selectFiles/${torrentId}`,
                    token,
                    selBody
                );

                if (!selRes && fileIdToSelect !== "all") {

                    const fallbackBody = new URLSearchParams();
                    fallbackBody.append("files", "all");

                    await rdRequest(
                        "POST",
                        `${RD_API_BASE}/torrents/selectFiles/${torrentId}`,
                        token,
                        fallbackBody
                    );

                    selectedFileId = null;
                }

                info = await getTorrentInfo(token, torrentId);
                if (!info) {
                    await RD.deleteTorrent(token, torrentId);
                    return null;
                }
            }


            if (info.status !== "downloaded") {
                info = await waitUntilReady(token, torrentId);
            }

            if (!info || info.status !== "downloaded") {
                await RD.deleteTorrent(token, torrentId);
                return null;
            }

            if (!Array.isArray(info.links) || info.links.length === 0) {
                await RD.deleteTorrent(token, torrentId);
                return null;
            }


            const linkToUnrestrict = resolveSelectedLink(info, selectedFileId);
            if (!linkToUnrestrict) {
                await RD.deleteTorrent(token, torrentId);
                return null;
            }

 
            const unBody = new URLSearchParams();
            unBody.append("link", linkToUnrestrict);

            const unrestrictRes = await rdRequest(
                "POST",
                `${RD_API_BASE}/unrestrict/link`,
                token,
                unBody
            );

            if (!unrestrictRes || !unrestrictRes.download) {
                await RD.deleteTorrent(token, torrentId);
                return null;
            }

            return {
                type: "ready",
                url: unrestrictRes.download,
                filename: unrestrictRes.filename || null,
                size: toInt(unrestrictRes.filesize, 0),
                rd_file_index: Number.isInteger(selectedFileId) ? selectedFileId : null
            };
        } catch (e) {
            console.error("RD Error:", e?.message || e);
            if (torrentId) await RD.deleteTorrent(token, torrentId);
            return null;
        }
    }
};

module.exports = RD;
