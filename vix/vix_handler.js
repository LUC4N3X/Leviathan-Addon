const axios = require("axios");
const { imdbToTmdb } = require("../core/media_identity_resolver");

const VIX_BASE = "https://vixsrc.to";
const DEFAULT_ADDON_URL = "https://leviata96n.questoleviatanormio.dpdns.org";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function buildHeaders(targetUrl, referer) {
    let origin = VIX_BASE;
    try {
        origin = new URL(targetUrl || VIX_BASE).origin;
    } catch {}

    return {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": referer || `${origin}/`,
        "Origin": origin,
    };
}

function safeAbsoluteUrl(raw, baseUrl = VIX_BASE) {
    if (!raw) return null;
    try {
        if (/^https?:\/\//i.test(raw)) return raw;
        if (raw.startsWith("//")) return `https:${raw}`;
        return new URL(raw, baseUrl).toString();
    } catch {
        return null;
    }
}

function ensurePlaylistM3u8(raw) {
    try {
        if (!raw || !raw.includes("/playlist/")) return raw;
        const u = new URL(raw);
        const parts = u.pathname.split("/");
        const idx = parts.indexOf("playlist");
        if (idx === -1 || idx === parts.length - 1) return raw;
        const leaf = parts[idx + 1];
        if (/\.m3u8$/i.test(leaf) || leaf.includes(".")) return raw;
        parts[idx + 1] = `${leaf}.m3u8`;
        u.pathname = parts.join("/");
        return u.toString();
    } catch {
        return raw;
    }
}

function normalizeAddonBase(reqHost) {
    const envUrl = process.env.ADDON_URL || (process.env.SPACE_HOST ? `https://${process.env.SPACE_HOST}` : null);
    const raw = envUrl || reqHost || DEFAULT_ADDON_URL;
    try {
        if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, "");
        return `https://${String(raw).replace(/^\/+/, "").replace(/\/$/, "")}`;
    } catch {
        return DEFAULT_ADDON_URL;
    }
}

function pickFirstMatch(text, regexes) {
    for (const regex of regexes) {
        const match = text.match(regex);
        if (match && match[1]) return match[1];
    }
    return null;
}

function extractStreamData(html, baseUrl) {
    const scriptBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    const haystacks = [html, ...scriptBlocks];

    let token = null;
    let expires = null;
    let serverUrl = null;
    let canPlayFHD = false;

    for (const block of haystacks) {
        token ||= pickFirstMatch(block, [
            /["']token["']\s*:\s*["']([^"']+)["']/i,
            /\btoken\b\s*[:=]\s*["']([^"']+)["']/i,
            /setAttribute\(\s*["']token["']\s*,\s*["']([^"']+)["']\s*\)/i,
        ]);

        expires ||= pickFirstMatch(block, [
            /["']expires["']\s*:\s*["']?(\d+)["']?/i,
            /\bexpires\b\s*[:=]\s*["']?(\d+)["']?/i,
        ]);

        serverUrl ||= pickFirstMatch(block, [
            /\burl\b\s*[:=]\s*["']([^"']*(?:\/playlist\/|\.m3u8)[^"']*)["']/i,
            /\bfile\b\s*[:=]\s*["']([^"']*(?:\/playlist\/|\.m3u8)[^"']*)["']/i,
            /\bsrc\b\s*[:=]\s*["']([^"']*(?:\/playlist\/|\.m3u8)[^"']*)["']/i,
            /(https?:\/\/[^"'\s<>]+(?:\/playlist\/[^"'\s<>]+|\.m3u8(?:\?[^"'\s<>]*)?))/i,
            /(\/[^"'\s<>]*(?:\/playlist\/[^"'\s<>]+|\.m3u8(?:\?[^"'\s<>]*)?))/i,
        ]);

        if (/window\.canPlayFHD\s*=\s*true/i.test(block) || /canPlayFHD\s*[:=]\s*true/i.test(block)) {
            canPlayFHD = true;
        }
    }

    if (!serverUrl) return null;

    const absoluteServerUrl = ensurePlaylistM3u8(safeAbsoluteUrl(serverUrl, baseUrl) || serverUrl);
    return {
        token,
        expires,
        serverUrl: absoluteServerUrl,
        canPlayFHD,
    };
}

function extractIframeSrc(html, currentUrl) {
    const match = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    return match ? safeAbsoluteUrl(match[1], currentUrl) : null;
}

async function getRealVixPage(url) {
    let currentUrl = url;
    let referer = `${new URL(VIX_BASE).origin}/`;

    for (let hop = 0; hop < 4; hop += 1) {
        const response = await axios.get(currentUrl, {
            headers: buildHeaders(currentUrl, referer),
            timeout: 9000,
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400,
        });

        const html = typeof response.data === "string" ? response.data : String(response.data || "");
        const iframeSrc = extractIframeSrc(html, currentUrl);

        if (!iframeSrc || iframeSrc === currentUrl) {
            return { html, finalReferer: currentUrl, finalUrl: currentUrl };
        }

        referer = currentUrl;
        currentUrl = iframeSrc;
    }

    return null;
}

function buildMasterSource(data) {
    const url = new URL(ensurePlaylistM3u8(data.serverUrl));

    if (data.token && !url.searchParams.has("token")) {
        url.searchParams.set("token", data.token);
    }
    if (data.expires && !url.searchParams.has("expires")) {
        url.searchParams.set("expires", data.expires);
    }
    if (data.canPlayFHD && !url.searchParams.has("h")) {
        url.searchParams.set("h", "1");
    }

    return url.toString();
}

async function resolveTmdbId(meta) {
    const rawId = meta.tmdb_id || meta.tmdbId || meta.imdb_id || meta.id;
    if (!rawId) return null;

    if (typeof rawId === "string" && rawId.startsWith("tt")) {
        const converted = await imdbToTmdb(rawId);
        return converted && converted.tmdbId ? String(converted.tmdbId) : null;
    }

    return String(rawId);
}

function generateRichDescription(meta, qualityLabel) {
    const lines = [];
    const episodeLabel = meta.isSeries && Number.isFinite(meta.season) && Number.isFinite(meta.episode)
        ? ` • S${String(meta.season).padStart(2, "0")}E${String(meta.episode).padStart(2, "0")}`
        : "";

    lines.push(`🎬 ${meta.title || meta.originalTitle || "Video"}${episodeLabel}`);
    lines.push(`🇮🇹 ITA • 🎞️ HLS ${qualityLabel}`);
    lines.push(`☁️ StreamingCommunity • ⚡ Instant`);
    return lines.join("\n");
}

function buildBehaviorHints(group) {
    return {
        notWebReady: false,
        bingeGroup: group,
        bingieGroup: group,
    };
}

async function searchVix(meta, config = {}, reqHost) {
    if (!config.filters || (!config.filters.enableVix && !config.filters.enableSC)) return [];

    try {
        const tmdbId = await resolveTmdbId(meta);
        if (!tmdbId) return [];

        const addonBase = normalizeAddonBase(reqHost);
        const targetUrl = meta.isSeries
            ? `${VIX_BASE}/tv/${tmdbId}/${meta.season}/${meta.episode}/`
            : `${VIX_BASE}/movie/${tmdbId}/`;

        const pageData = await getRealVixPage(targetUrl);
        if (!pageData) return [];

        const data = extractStreamData(pageData.html, pageData.finalUrl || targetUrl);
        if (!data || !data.serverUrl) return [];

        const masterSource = buildMasterSource(data);
        const referer = pageData.finalReferer || targetUrl;
        const qualityMode = config.filters.scQuality || "all";
        const streams = [];

        const pushStream = (label, maxFlag, group) => {
            const proxyUrl = `${addonBase}/vixsynthetic.m3u8?src=${encodeURIComponent(masterSource)}&max=${maxFlag}&referer=${encodeURIComponent(referer)}`;
            streams.push({
                name: `🌪️ StreamingCommunity\n${label}`,
                title: generateRichDescription(meta, label.replace(/[📺💎]\s*/, "")),
                url: proxyUrl,
                behaviorHints: buildBehaviorHints(group),
            });
        };

        if (qualityMode === "all" || qualityMode === "720") {
            pushStream("📺 720p", 0, "vix-sc-720");
        }

        if ((qualityMode === "all" || qualityMode === "1080") && data.canPlayFHD) {
            pushStream("💎 1080p", 1, "vix-sc-1080");
        }

        if (!streams.length) {
            pushStream("📺 Auto", 0, "vix-sc-auto");
        }

        return streams.reverse();
    } catch (error) {
        console.error("Errore searchVix:", error.message);
        return [];
    }
}

module.exports = { searchVix };
