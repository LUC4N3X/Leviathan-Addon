const axios = require("axios");
const crypto = require("crypto");
const { computeBackoffDelay, parseRetryAfterMs } = require("../../utils/backoff");
const { CircuitBreaker } = require("../../utils/circuit_breaker");
const { extractRdErrorCode, classifyRdErrorCode } = require("../utils/rd_error_codes");

const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";

const RD_TIMEOUT = 32000;
const RD_MAX_RETRIES = 4;
const RD_READY_POLL_ATTEMPTS = 12;
const RD_READY_POLL_DELAY = 1000;

const rdCircuit = new CircuitBreaker("realdebrid");

function rdCircuitKey(token) {
    return crypto.createHash("sha1").update(String(token || "no-token")).digest("hex").slice(0, 12);
}

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

function normalizeForwardableIp(ip) {
    if (!ip) return null;
    let value = String(ip).trim();
    if (!value) return null;
    const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) value = mapped[1];
    if (value === "::1" || /^127\./.test(value)) return null;
    if (/^10\./.test(value) || /^192\.168\./.test(value) || /^169\.254\./.test(value)) return null;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return null;
    if (/^(fc|fd)/i.test(value)) return null;
    if (/^fe[89ab][0-9a-f]:/i.test(value)) return null;
    return value;
}

function appendUnrestrictIp(body, userIp) {
    const fwdIp = normalizeForwardableIp(userIp);
    if (fwdIp) body.append("ip", fwdIp);
    return body;
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

function normalizeFileId(file) {
    const rawId = file?.id ?? file?.file_index ?? file?.index ?? file?.fileIdx;
    const parsed = Number.parseInt(rawId, 10);
    return Number.isInteger(parsed) ? parsed : null;
}

function pickBestMovieFileId(files) {
    const candidates = getValidVideoFiles(files);
    if (!candidates.length) return null;

    const scored = candidates.map((file) => {
        const path = String(file.path || "").toLowerCase();
        let score = Number(file.bytes) || 0;

        if (/\/extras?\//i.test(path) || /\\extras?\\/i.test(path)) score -= 5e12;
        if (/\/specials?\//i.test(path) || /\\specials?\\/i.test(path)) score -= 5e12;
        if (/commentary/i.test(path)) score -= 3e12;

        const depth = path.split(/[\\/]/).length;
        score -= depth * 1e9;

        return { id: normalizeFileId(file), score };
    }).filter((entry) => Number.isInteger(entry.id));

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.id ?? null;
}

function matchFile(files, season, episode) {
    if (!files || !season || !episode) return null;

    const s = parseInt(season, 10);
    const e = parseInt(episode, 10);
    if (!Number.isInteger(s) || !Number.isInteger(e) || s <= 0 || e <= 0) return null;

    const eStr = String(e).padStart(2, "0");
    const videoFiles = getValidVideoFiles(files);
    if (videoFiles.length === 0) return null;

    const regexStandard = new RegExp(`S0*${s}.*?E0*${e}\\b`, "i");
    const regexX = new RegExp(`\\b${s}x0*${e}\\b`, "i");
    const compactNum = `${s}${eStr}`;
    const regexCompact = new RegExp(`(^|\\D)${compactNum}(\\D|$)`, "i");
    const regexExplicitEp = new RegExp(`(ep|episode|episodio)[^0-9]*0*${e}\\b`, "i");
    const regexAbsolute = new RegExp(`[ \\-\\[_]0*${e}[ \\-\\]_]`, "i");

    let found = videoFiles.find((f) => regexStandard.test(String(f.path || "")));
    if (!found) found = videoFiles.find((f) => regexX.test(String(f.path || "")));
    if (!found && s < 100) found = videoFiles.find((f) => regexCompact.test(String(f.path || "")));
    if (!found) found = videoFiles.find((f) => regexExplicitEp.test(String(f.path || "")));
    if (!found) found = videoFiles.find((f) => regexAbsolute.test(String(f.path || "")));

    return found ? normalizeFileId(found) : null;
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
    const circuitKey = rdCircuitKey(token);
    if (!rdCircuit.canRequest(circuitKey)) {
        console.warn("[RD CIRCUIT] open, skipping request fast-fail");
        return null;
    }

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
                rdCircuit.recordSuccess(circuitKey);
                return response.data;
            }

            const errorCode = status >= 400 ? extractRdErrorCode(response.data) : null;
            const errorClass = classifyRdErrorCode(errorCode);

            if (status === 401 || status === 403 || status === 404) {
                rdCircuit.recordSuccess(circuitKey);
                if (status === 401 || status === 403) {
                    const path = String(url).replace(RD_API_BASE, "");
                    console.warn(`[RD] HTTP ${status}${Number.isInteger(errorCode) ? ` (error_code=${errorCode})` : ""} on ${method} ${path} — Real-Debrid rejected the API token (expired / regenerated / wrong account?). Regenerate it at https://real-debrid.com/apitoken`);
                }
                return null;
            }

            if (errorClass === "terminal_uncached") {
                rdCircuit.recordSuccess(circuitKey);
                const path = String(url).replace(RD_API_BASE, "");
                console.warn(`[RD] terminal error_code=${errorCode} on ${method} ${path} — torrent not cacheable (infringing / too big / invalid), skipping retries`);
                return null;
            }

            if (isRetryableStatus(status)) {
                if (attempt < RD_MAX_RETRIES - 1) {
                    const retryAfterMs = parseRetryAfterMs(response.headers?.["retry-after"]);
                    const backoff = computeBackoffDelay(attempt, {
                        baseMs: status === 429 ? 1500 : 800,
                        maxMs: 15000,
                        retryAfterMs
                    });
                    await sleep(backoff);
                    continue;
                }
                if (status >= 500) rdCircuit.recordFailure(circuitKey);
                return null;
            }

            rdCircuit.recordSuccess(circuitKey);
            return null;
        } catch (error) {
            if (attempt < RD_MAX_RETRIES - 1 && isRetryableNetworkError(error)) {
                const retryAfterMs = parseRetryAfterMs(error?.response?.headers?.["retry-after"]);
                const backoff = computeBackoffDelay(attempt, { baseMs: 800, maxMs: 15000, retryAfterMs });
                await sleep(backoff);
                continue;
            }
            rdCircuit.recordFailure(circuitKey);
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
        if (idx >= 0 && info.links[idx]) return info.links[idx];
    }

    return info.links[0] || null;
}

function getSelectedFileInfo(info, selectedFileId = null, resolvedLink = null) {
    const files = normalizeFiles(info?.files);
    if (files.length === 0) return null;

    if (Number.isInteger(selectedFileId)) {
        const exact = files.find((file) => normalizeFileId(file) === selectedFileId);
        if (exact) return exact;
    }

    const selectedFiles = files.filter((file) => Number(file?.selected) === 1);
    if (selectedFiles.length === 1) return selectedFiles[0];

    if (selectedFiles.length > 1 && Array.isArray(info?.links) && info.links.length === selectedFiles.length && resolvedLink) {
        const linkIndex = info.links.findIndex((link) => String(link || "") === String(resolvedLink || ""));
        if (linkIndex >= 0 && selectedFiles[linkIndex]) return selectedFiles[linkIndex];
    }

    return getValidVideoFiles(selectedFiles)[0] || getValidVideoFiles(files)[0] || selectedFiles[0] || files[0] || null;
}

function getSelectedFileName(file) {
    const rawPath = String(file?.path || "").trim();
    if (!rawPath) return null;
    const parts = rawPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || rawPath;
}

function chooseSeriesFileId(files, season, episode, forcedFileIdx = null) {
    const matchedId = matchFile(files, season, episode);
    if (Number.isInteger(matchedId)) return matchedId;

    const forcedIndex = Number.parseInt(forcedFileIdx, 10);
    if (Number.isInteger(forcedIndex) && forcedIndex >= 0) {
        const forcedMatch = getValidVideoFiles(files).find((file) => normalizeFileId(file) === forcedIndex);
        if (forcedMatch) return forcedIndex;
    }

    const validVideoFiles = getValidVideoFiles(files);
    if (validVideoFiles.length === 1) return normalizeFileId(validVideoFiles[0]);
    return null;
}

const RD = {
    listSavedTorrents: async (token, options = {}) => {
        const limit = Math.max(1, Math.min(250, toInt(options.limit, 100)));
        const page = Math.max(1, toInt(options.page, 1));
        const data = await rdRequest("GET", `${RD_API_BASE}/torrents?limit=${limit}&page=${page}`, token);
        return Array.isArray(data) ? data : [];
    },

    getSavedTorrentInfo: async (token, torrentId) => {
        if (!torrentId) return null;
        return getTorrentInfo(token, torrentId);
    },

    resolveSavedTorrentFile: async (token, torrentId, selectedFileId = null, userIp = null) => {
        const info = await getTorrentInfo(token, torrentId);
        if (!info || info.status !== "downloaded") return null;
        const selectedId = selectedFileId === null || selectedFileId === undefined || selectedFileId === ""
            ? null
            : toInt(selectedFileId, NaN);
        const linkToUnrestrict = resolveSelectedLink(info, Number.isFinite(selectedId) ? selectedId : null);
        if (!linkToUnrestrict) return null;

        const unBody = new URLSearchParams();
        unBody.append("link", linkToUnrestrict);
        appendUnrestrictIp(unBody, userIp);
        const unrestrictRes = await rdRequest("POST", `${RD_API_BASE}/unrestrict/link`, token, unBody);
        if (!unrestrictRes || !unrestrictRes.download) return null;

        const selectedFile = getSelectedFileInfo(info, Number.isFinite(selectedId) ? selectedId : null, linkToUnrestrict);
        const resolvedFileId = Number.isFinite(selectedId) ? selectedId : normalizeFileId(selectedFile);
        const selectedFileSize = Number(selectedFile?.bytes) || 0;
        return {
            type: "ready",
            url: unrestrictRes.download,
            filename: unrestrictRes.filename || getSelectedFileName(selectedFile),
            file_path: selectedFile?.path || null,
            size: toInt(unrestrictRes.filesize, 0) || selectedFileSize,
            file_size: toInt(unrestrictRes.filesize, 0) || selectedFileSize || null,
            rd_file_size: toInt(unrestrictRes.filesize, 0) || selectedFileSize || null,
            selectedFileId: Number.isInteger(resolvedFileId) ? resolvedFileId : null,
            rd_file_index: Number.isInteger(resolvedFileId) ? resolvedFileId : null,
            file_index: Number.isInteger(resolvedFileId) ? resolvedFileId : null
        };
    },

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

            if (!addRes || !addRes.id) {
                console.warn(`[RD] prepareTorrentForCloud: addMagnet returned no torrent id — likely an auth/token error (see preceding [RD] log) or RD rejected the magnet`);
                return null;
            }
            torrentId = addRes.id;

            let info = await getTorrentInfo(token, torrentId);
            if (!info) return null;

            let selectedFileId = null;
            let selectedFileSize = null;

            if (info.status === "waiting_files_selection") {
                let fileIdToSelect = options?.selectAll ? "all" : null;

                if (!fileIdToSelect && Array.isArray(info.files)) {
                    const validVideoFiles = getValidVideoFiles(info.files);
                    if (validVideoFiles.length === 1) {
                        const singleId = normalizeFileId(validVideoFiles[0]);
                        if (Number.isInteger(singleId)) {
                            selectedFileId = singleId;
                            selectedFileSize = Number(validVideoFiles[0]?.bytes) || 0;
                            fileIdToSelect = String(singleId);
                        }
                    }
                }

                if (!fileIdToSelect) fileIdToSelect = "all";

                const selBody = new URLSearchParams();
                selBody.append("files", String(fileIdToSelect));
                await rdRequest(
                    "POST",
                    `${RD_API_BASE}/torrents/selectFiles/${torrentId}`,
                    token,
                    selBody
                );

                info = await getTorrentInfo(token, torrentId);
                if (!info) return null;
            }

            const shouldPoll = options?.poll !== false;
            if (shouldPoll && info.status !== "downloaded") {
                info = await waitUntilReady(
                    token,
                    torrentId,
                    Math.max(1, toInt(options?.pollAttempts, RD_READY_POLL_ATTEMPTS)),
                    Math.max(250, toInt(options?.pollDelayMs, RD_READY_POLL_DELAY))
                );
            }

            if (Array.isArray(info?.files) && info.files.length > 0 && !Number.isInteger(selectedFileId)) {
                const firstVideo = getValidVideoFiles(info.files)[0];
                const firstId = normalizeFileId(firstVideo);
                if (Number.isInteger(firstId)) {
                    selectedFileId = firstId;
                    selectedFileSize = Number(firstVideo?.bytes) || selectedFileSize || 0;
                }
            }

            return {
                ready: info?.status === "downloaded",
                torrentId,
                selectedFileId: Number.isInteger(selectedFileId) ? selectedFileId : null,
                selectedFileSize: Number.isFinite(Number(selectedFileSize)) && Number(selectedFileSize) > 0 ? Number(selectedFileSize) : null,
                status: info?.status || null
            };
        } catch (e) {
            console.error("RD Cloud Build Error:", e?.message || e);
            if (torrentId) {
                try { await RD.deleteTorrent(token, torrentId); } catch (_) {}
            }
            return null;
        }
    },

    getStreamLink: async (token, magnet, season = null, episode = null, forcedFileIdx = null, options = {}) => {
        let torrentId = null;
        const userIp = options && typeof options === "object" ? (options.userIp || null) : null;

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
                    const chosenId = chooseSeriesFileId(info.files, season, episode, forcedFileIdx);
                    if (Number.isInteger(chosenId)) {
                        selectedFileId = chosenId;
                        fileIdToSelect = chosenId;
                        console.log(`🎯 RD Match: selezionato file ID ${chosenId} per S${season}E${episode}`);
                    } else {
                        await RD.deleteTorrent(token, torrentId);
                        return null;
                    }
                } else if (info.files) {
                    const bestMovieFileId = pickBestMovieFileId(info.files);
                    if (Number.isInteger(bestMovieFileId)) {
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
            appendUnrestrictIp(unBody, userIp);

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

            const selectedFile = getSelectedFileInfo(info, selectedFileId, linkToUnrestrict);
            const selectedFileSize = Number(selectedFile?.bytes) || 0;
            const resolvedFileId = Number.isInteger(selectedFileId)
                ? selectedFileId
                : normalizeFileId(selectedFile);

            return {
                type: "ready",
                url: unrestrictRes.download,
                filename: unrestrictRes.filename || getSelectedFileName(selectedFile),
                file_path: selectedFile?.path || null,
                size: toInt(unrestrictRes.filesize, 0) || selectedFileSize,
                file_size: toInt(unrestrictRes.filesize, 0) || selectedFileSize || null,
                rd_file_size: toInt(unrestrictRes.filesize, 0) || selectedFileSize || null,
                selectedFileId: Number.isInteger(resolvedFileId) ? resolvedFileId : null,
                rd_file_index: Number.isInteger(resolvedFileId) ? resolvedFileId : null,
                file_index: Number.isInteger(resolvedFileId) ? resolvedFileId : null
            };
        } catch (e) {
            console.error("RD Error:", e?.message || e);
            if (torrentId) await RD.deleteTorrent(token, torrentId);
            return null;
        }
    }
};

module.exports = RD;
