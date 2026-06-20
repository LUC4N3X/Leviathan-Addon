'use strict';

const axios = require('axios');
const tmdbHelper = require('../../core/utils/tmdb_helper');
const {
    buildWebStream,
    detectStreamQuality,
    normalizeQuality,
    probePlaylistIntelligence
} = require('../extractors/common');

const MOFLIX_BASE = String(process.env.MOFLIX_BASE || 'https://moflix-stream.xyz').replace(/\/+$/, '');
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const REQUEST_TIMEOUT = Math.max(4000, Number.parseInt(process.env.MOFLIX_TIMEOUT_MS || '9000', 10) || 9000);
const PLAYLIST_TIMEOUT = Math.max(2500, Number.parseInt(process.env.MOFLIX_PLAYLIST_TIMEOUT_MS || '4500', 10) || 4500);
const MAX_SERVERS = Math.max(1, Math.min(12, Number.parseInt(process.env.MOFLIX_MAX_SERVERS || '6', 10) || 6));

const http = axios.create({
    timeout: REQUEST_TIMEOUT,
    maxRedirects: 5,
    decompress: true,
    validateStatus: () => true,
    proxy: false
});

function envFlag(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (/^(?:1|true|yes|on)$/i.test(String(raw).trim())) return true;
    if (/^(?:0|false|no|off)$/i.test(String(raw).trim())) return false;
    return fallback;
}

function isMoflixRuntimeEnabled(config = {}) {
    return envFlag('MOFLIX_ENABLED', false) && config?.filters?.enableMoflix === true;
}

function toBase64(value) {
    return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function normalizeMediaType(meta = {}, resolved = null) {
    const type = String(resolved?.type || meta?.type || '').toLowerCase();
    if (type === 'series' || type === 'tv' || meta?.isSeries) return 'tv';
    return 'movie';
}

function normalizeEpisodeNumber(...values) {
    for (const value of values) {
        const parsed = Number.parseInt(String(value || ''), 10);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return null;
}

async function resolveMoflixMeta(meta = {}) {
    const type = meta?.isSeries ? 'tv' : 'movie';
    const resolved = await tmdbHelper.resolveFromMeta(meta, { type, language: 'it-IT' }).catch(() => null);
    const explicit = tmdbHelper.normalizeTmdbId(meta?.tmdb_id || meta?.tmdbId || meta?.tmdb || meta?.id);
    const tmdbId = String(resolved?.tmdb_id || resolved?.tmdbId || explicit?.id || '').trim();
    if (!tmdbId) return null;

    const mediaType = normalizeMediaType(meta, resolved);
    return {
        tmdbId,
        mediaType,
        title: resolved?.title || meta?.title || meta?.name || meta?.originalTitle || 'Moflix',
        season: mediaType === 'tv' ? normalizeEpisodeNumber(meta?.season, resolved?.season, explicit?.season) : null,
        episode: mediaType === 'tv' ? normalizeEpisodeNumber(meta?.episode, resolved?.episode, explicit?.episode) : null
    };
}

function buildHeaders(referer = MOFLIX_BASE, accept = 'application/json,text/plain,*/*') {
    return {
        'User-Agent': DEFAULT_UA,
        'Accept': accept,
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': referer || MOFLIX_BASE,
        'Origin': MOFLIX_BASE,
        'Connection': 'keep-alive'
    };
}

function responsePayload(response) {
    if (!response) return null;
    if (response.data && typeof response.data === 'object') return response.data;
    if (typeof response.data === 'string') {
        try { return JSON.parse(response.data); } catch (_) { return null; }
    }
    return null;
}

async function fetchJson(url, referer = MOFLIX_BASE) {
    const response = await http.get(url, { headers: buildHeaders(referer) });
    if (Number(response?.status || 0) < 200 || Number(response?.status || 0) >= 400) return null;
    return responsePayload(response);
}

function collectVideos(payload = {}) {
    const collections = [payload?.videos, payload?.title?.videos, payload?.episode?.videos];
    const out = [];
    for (const list of collections) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (item && typeof item === 'object') out.push(item);
        }
    }
    return out;
}

function buildResolveUrl(value) {
    const raw = String(value || '').trim().replace(/^\/+/, '');
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('api/v1/')) return `${MOFLIX_BASE}/${raw}`;
    return `${MOFLIX_BASE}/api/v1/${raw}`;
}

function normalizeStreamUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        if (/^https?:\/\//i.test(raw)) return new URL(raw).toString();
        if (raw.startsWith('//')) return `https:${raw}`;
        return new URL(raw, MOFLIX_BASE).toString();
    } catch (_) {
        return '';
    }
}

async function resolvePlayableUrl(video) {
    const src = normalizeStreamUrl(video?.src);
    if (src) return src;

    const resolveUrl = buildResolveUrl(video?.playback_resolve_url);
    if (!resolveUrl) return '';

    const videoId = String(video?.id || '').trim();
    const referer = videoId ? `${MOFLIX_BASE}/watch/${videoId}` : MOFLIX_BASE;
    const payload = await fetchJson(resolveUrl, referer).catch(() => null);
    return normalizeStreamUrl(payload?.src);
}

async function decorateMoflixQuality(client, url, fallback = 'Unknown') {
    const detected = normalizeQuality(detectStreamQuality(url, fallback));
    if (!/\.m3u8(?:$|[?#])/i.test(String(url || ''))) return detected;

    const intelligence = await probePlaylistIntelligence(client, url, {
        headers: buildHeaders(MOFLIX_BASE, 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*'),
        timeout: PLAYLIST_TIMEOUT
    }).catch(() => null);
    return normalizeQuality(intelligence?.quality || detected || 'Unknown');
}

function buildMoflixTitle(metaInfo, serverName, quality) {
    const episodeTag = metaInfo.mediaType === 'tv' && metaInfo.season && metaInfo.episode
        ? ` S${String(metaInfo.season).padStart(2, '0')}E${String(metaInfo.episode).padStart(2, '0')}`
        : '';
    return `${metaInfo.title}${episodeTag}\n🧪 Moflix POC • ${serverName || 'Mirror'} • ${quality || 'Unknown'}`;
}

async function getMoflixServers(metaInfo) {
    if (metaInfo.mediaType === 'tv') {
        if (!metaInfo.season || !metaInfo.episode) return [];
        const titleId = toBase64(`tmdb|series|${metaInfo.tmdbId}`);
        const titlePayload = await fetchJson(`${MOFLIX_BASE}/api/v1/titles/${encodeURIComponent(titleId)}?loader=titlePage`).catch(() => null);
        const mediaId = String(titlePayload?.title?.id || titleId).trim();
        const episodeUrl = `${MOFLIX_BASE}/api/v1/titles/${encodeURIComponent(mediaId)}/seasons/${metaInfo.season}/episodes/${metaInfo.episode}?loader=episodePage`;
        return collectVideos(await fetchJson(episodeUrl).catch(() => null));
    }

    const movieId = toBase64(`tmdb|movie|${metaInfo.tmdbId}`);
    const payload = await fetchJson(`${MOFLIX_BASE}/api/v1/titles/${encodeURIComponent(movieId)}?loader=titlePage`).catch(() => null);
    return collectVideos(payload);
}

function isPlayableVideo(video = {}) {
    if (video?.premium_locked === true) return false;
    return Boolean(String(video?.src || '').trim() || String(video?.playback_resolve_url || '').trim());
}

async function searchMoflix(meta, config = {}, reqHost) {
    if (!isMoflixRuntimeEnabled(config)) return [];

    try {
        const metaInfo = await resolveMoflixMeta(meta);
        if (!metaInfo?.tmdbId) return [];

        const videos = (await getMoflixServers(metaInfo)).filter(isPlayableVideo).slice(0, MAX_SERVERS);
        if (!videos.length) return [];

        const streams = [];
        for (const video of videos) {
            const url = await resolvePlayableUrl(video).catch(() => '');
            if (!url) continue;
            const serverName = String(video?.name || video?.type || 'Mirror').trim();
            const quality = await decorateMoflixQuality(http, url, detectStreamQuality(serverName, 'Unknown'));
            const headers = buildHeaders(MOFLIX_BASE, /\.m3u8(?:$|[?#])/i.test(url) ? 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*' : '*/*');
            streams.push(buildWebStream({
                name: '🧪 Moflix | POC',
                title: buildMoflixTitle(metaInfo, serverName, quality),
                url,
                extractor: 'Moflix',
                provider: 'Moflix',
                providerCode: 'MOFLIX',
                quality,
                headers,
                addonBase: reqHost,
                extraBehaviorHints: {
                    vortexMeta: {
                        poc: true,
                        tmdbId: metaInfo.tmdbId,
                        mediaType: metaInfo.mediaType,
                        serverName
                    }
                },
                extra: { _priority: 13 }
            }));
        }

        return streams;
    } catch (error) {
        console.error(`[WEB][Moflix] error | ${error.message}`);
        return [];
    }
}

module.exports = {
    searchMoflix,
    isMoflixRuntimeEnabled,
    resolveMoflixMeta
};
