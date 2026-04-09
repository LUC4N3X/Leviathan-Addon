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

function normalizePositiveInt(value) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
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

function getFileById(files, fileId) {
    const normalizedFileId = normalizePositiveInt(fileId);
    if (normalizedFileId === null) return null;
    const normalized = normalizeFiles(files);
    return normalized.find((file) => normalizePositiveInt(file?.id) === normalizedFileId) || null;
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

function matchFile(files, season, episode) {
    if (!files || !season || !episode) return null;

    const s = parseInt(season, 10);
    const e = parseInt(episode, 10);
    const eStr = e.toString().padStart(2, "0");

    const videoFiles = files.filter((f) => {
        const name = String(f.path || "").toLowerCase();
        const isVideo = name.match(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/);
        const notSample = !name.includes("sample");
        return isVideo && notSample;
    });

    if (videoFiles.length === 0) return null;

    const regexStandard = new RegExp(`S0*${s}.*?E0*${e}\\b`, "i");
    const regexX = new RegExp(`\\b${s}x0*${e}\\b`, "i");
    const compactNum = `${s}${eStr}`;
    const regexCompact = new RegExp(`(^|\\D)${compactNum}(\\D|$)`);
    const regexExplicitEp = new RegExp(`(ep|episode)[^0-9]*0*${e}\\b`, "i");
    const regexAbsolute = new RegExp(`[ \\-\\[_]0*${e}[ \\-\\]_]`);

    let found = videoFiles.find((f) => regexStandard.test(f.path));
    if (!found) found = videoFiles.find((f) => regexX.test(f.path));
    if (!found && s < 100) found = videoFiles.find((f) => regexCompact.test(f.path));
    if (!found) found = videoFiles.find((f) => regexExplicitEp.test(f.path));
    if (!found) found = videoFiles.find((f) => regexAbsolute.test(f.path));

    return found ? found.id : null;
}

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

async function waitUntilReady(token, torrentId, attempts = RD_READY_POLL_ATTEMPTS, delayMs = RD_READY_POLL_DELAY) {
    let lastInfo = null;

    for (let i = 0; i < attempts; i++) {
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

        await sleep(delayMs);
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

function buildSelectBody(fileSelection) {
    const body = new URLSearchParams();
    body.append("files", String(fileSelection));
    return body;
}

function chooseFileSelection(info, options = {}) {
    const files = Array.isArray(info?.files) ? info.files : [];
    const explicitFileIdx = normalizePositiveInt(options.fileIdx);
    const explicitFile = getFileById(files, explicitFileIdx);
    if (explicitFile && isVideoFilePath(explicitFile.path) && !isSampleOrJunk(explicitFile.path)) {
        return {
            selectedFileId: explicitFile.id,
            fileSelection: explicitFile.id,
            reason: "explicit_fileIdx"
        };
    }

    if (options.season && options.episode && files.length > 0) {
        const matchedId = matchFile(files, options.season, options.episode);
        if (matchedId !== null && matchedId !== undefined) {
            return {
                selectedFileId: matchedId,
                fileSelection: matchedId,
                reason: "season_episode_match"
            };
        }
    }

    if (files.length > 0) {
        const bestMovieFileId = pickBestMovieFileId(files);
        if (bestMovieFileId !== null && bestMovieFileId !== undefined) {
            return {
                selectedFileId: bestMovieFileId,
                fileSelection: bestMovieFileId,
                reason: "best_movie_file"
            };
        }
    }

    return {
        selectedFileId: null,
        fileSelection: options.selectAll ? "all" : "all",
        reason: "select_all_fallback"
    };
}

function extractSelectedFileDetails(info, selectedFileId = null) {
    const files = Array.isArray(info?.files) ? info.files : [];
    const exact = getFileById(files, selectedFileId);
    if (exact) {
        return {
            fileIdx: normalizePositiveInt(exact.id),
            size: toInt(exact.bytes, 0)
        };
    }

    const selected = files.find((file) => Number(file?.selected) === 1 && isVideoFilePath(file?.path) && !isSampleOrJunk(file?.path));
    if (selected) {
        return {
            fileIdx: normalizePositiveInt(selected.id),
            size: toInt(selected.bytes, 0)
        };
    }

    const best = getValidVideoFiles(files).sort((a, b) => toInt(b?.bytes, 0) - toInt(a?.bytes, 0))[0];
    if (best) {
        return {
            fileIdx: normalizePositiveInt(best.id),
            size: toInt(best.bytes, 0)
        };
    }

    return {
        fileIdx: normalizePositiveInt(selectedFileId),
        size: 0
    };
}

async function selectFilesForTorrent(token, torrentId, info, options = {}) {
    if (!torrentId || !info || info.status !== "waiting_files_selection") {
        return {
            info,
            selectedFileId: normalizePositiveInt(options.fileIdx),
            selectionReason: "selection_not_required"
        };
    }

    const selection = chooseFileSelection(info, options);
    const selected = await rdRequest(
        "POST",
        `${RD_API_BASE}/torrents/selectFiles/${torrentId}`,
        token,
        buildSelectBody(selection.fileSelection)
    );

    if (!selected && selection.fileSelection !== "all") {
        await rdRequest(
            "POST",
            `${RD_API_BASE}/torrents/selectFiles/${torrentId}`,
            token,
            buildSelectBody("all")
        );

        const fallbackInfo = await getTorrentInfo(token, torrentId);
        return {
            info: fallbackInfo,
            selectedFileId: null,
            selectionReason: `${selection.reason}_fallback_all`
        };
    }

    const refreshedInfo = await getTorrentInfo(token, torrentId);
    return {
        info: refreshedInfo,
        selectedFileId: selection.selectedFileId,
        selectionReason: selection.reason
    };
}

const RD = {
    deleteTorrent: async (token, torrentId) => {
        if (!torrentId) return;
        try {
            await rdRequest("DELETE", `${RD_API_BASE}/torrents/delete/${torrentId}`, token);
        } catch (_) {}
    },

    prepareTorrentForCloud: async (token, magnet, options = {}) => {
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

            if (!addRes?.id) return null;
            torrentId = addRes.id;

            let info = await getTorrentInfo(token, torrentId);
            if (!info) {
                await RD.deleteTorrent(token, torrentId);
                return null;
            }

            let selectedFileId = null;
            let selectionReason = "none";

            const selectionResult = await selectFilesForTorrent(token, torrentId, info, {
                fileIdx: options.fileIdx,
                season: options.season,
                episode: options.episode,
                selectAll: options.selectAll !== false
            });

            info = selectionResult.info;
            selectedFileId = selectionResult.selectedFileId;
            selectionReason = selectionResult.selectionReason;

            if (!info) {
                await RD.deleteTorrent(token, torrentId);
                return null;
            }

            if (info.status !== "downloaded" && options.poll === true) {
                info = await waitUntilReady(
                    token,
                    torrentId,
                    Math.max(1, Number.parseInt(options.pollAttempts, 10) || 3),
                    Math.max(300, Number.parseInt(options.pollDelayMs, 10) || RD_READY_POLL_DELAY)
                );
            }

            const fileDetails = extractSelectedFileDetails(info, selectedFileId);

            return {
                torrentId,
                info,
                status: String(info?.status || "").toLowerCase(),
                ready: String(info?.status || "").toLowerCase() === "downloaded" && Array.isArray(info?.links) && info.links.length > 0,
                selectionReason,
                selectedFileId: fileDetails.fileIdx,
                selectedFileSize: fileDetails.size
            };
        } catch (e) {
            console.error("RD Cloud Prepare Error:", e?.message || e);
            if (torrentId) await RD.deleteTorrent(token, torrentId);
            return null;
        }
    },

    getStreamLink: async (token, magnet, season = null, episode = null, fileIdx = null) => {
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

            let selectedFileId = normalizePositiveInt(fileIdx);

            if (info.status === "waiting_files_selection") {
                const selectionResult = await selectFilesForTorrent(token, torrentId, info, {
                    fileIdx,
                    season,
                    episode,
                    selectAll: false
                });

                info = selectionResult.info;
                selectedFileId = selectionResult.selectedFileId;
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

            const fileDetails = extractSelectedFileDetails(info, selectedFileId);
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
                fileIdx: fileDetails.fileIdx,
                rd_file_index: fileDetails.fileIdx,
                rd_file_size: fileDetails.size > 0 ? fileDetails.size : toInt(unrestrictRes.filesize, 0)
            };
        } catch (e) {
            console.error("RD Error:", e?.message || e);
            if (torrentId) await RD.deleteTorrent(token, torrentId);
            return null;
        }
    }
};

module.exports = RD;
