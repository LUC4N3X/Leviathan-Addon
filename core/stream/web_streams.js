'use strict';

const aioFormatter = require('../lib/pulse_formatter.cjs');
const { formatStreamSelector } = require('../lib/stream_formatter');
const { searchVix: searchStreamingCommunity } = require('../../providers/streamingcommunity/vix_handler');
const { searchGuardaHD } = require('../../providers/guardahd/ghd_handler');
const { searchGuardaserie } = require('../../providers/guardaserie/gs_handler');
const { searchAnimeWorld } = require('../../providers/animeworld/aw_handler');
const { searchGuardaFlix } = require('../../providers/guardaflix/gf_handler');

function isStreamingCommunityEnabled(filters = {}) {
    return filters?.enableStreamingCommunity === true || filters?.enableVix === true;
}

function isStreamingCommunityLastEnabled(filters = {}) {
    return filters?.streamingCommunityLast === true || filters?.vixLast === true;
}

function applyAioWebStyle(streamList, sourceName, meta) {
    if (!Array.isArray(streamList) || streamList.length === 0) return [];

    const isAnimeWorld = sourceName.includes('AnimeWorld');
    return streamList.map((stream) => {
        const textToCheck = `${stream?.title || ''} ${stream?.name || ''}`.toUpperCase().replace(/GUARDAHD|STREAMINGCOMMUNITY|LEVIATHAN|VIX|GUARDAFLIX/g, '');
        let quality = 'WebStreams';
        let qIcon = '📺';

        if (/\b(4K|2160P|UHD)\b/.test(textToCheck)) {
            quality = '4K';
            qIcon = '🔥';
        } else if (/\b(1080P|FHD|FULLHD)\b/.test(textToCheck)) {
            quality = '1080p';
            qIcon = '🔥';
        } else if (/\b(720P|HD)\b/.test(textToCheck)) {
            quality = '720p';
            qIcon = '🔥';
        } else if (/\b(480P|SD)\b/.test(textToCheck)) {
            quality = 'SD';
            qIcon = '🔥';
        }

        if ((sourceName.includes('StreamingCommunity') || sourceName.includes('Vix')) && quality === 'SD' && !/\b(480P|SD)\b/.test(textToCheck)) {
            quality = '1080p';
            qIcon = '🔥';
        }

        if (isAnimeWorld) {
            stream.name = aioFormatter.formatStreamName({ service: 'web', cached: true, quality: 'HD' });
            stream.title = aioFormatter.formatStreamTitle({ title: meta.title, size: 'Web', language: '🇯🇵 JPN/ITA', source: 'AnimeWorld', techInfo: '⛩️ Anime' });
            stream.behaviorHints = stream.behaviorHints || {};
            stream.behaviorHints.bingieGroup = 'Leviathan|HD|Web|AnimeWorld';
            return stream;
        }

        stream.name = aioFormatter.formatStreamName({ service: 'web', cached: true, quality });
        stream.title = aioFormatter.formatStreamTitle({ title: meta.title, size: 'Web', language: '🇮🇹 ITA', source: sourceName, seeders: null, techInfo: `🎞️ ${quality} ${qIcon}` });
        stream.behaviorHints = stream.behaviorHints || {};
        stream.behaviorHints.bingieGroup = `Leviathan|${quality}|Web|${sourceName.replace(/\W/g, '')}`;
        return stream;
    });
}

function applyWebFormatter(streamList, sourceName, meta, config) {
    if (!streamList || !Array.isArray(streamList)) return [];
    return streamList.map((stream) => {
        let quality = 'HD';
        const upperName = (stream.name || '').toUpperCase();
        if (upperName.includes('4K') || upperName.includes('2160P')) quality = '4K';
        else if (upperName.includes('1080P') || upperName.includes('FHD')) quality = '1080p';
        else if (upperName.includes('720P')) quality = '720p';
        else if (upperName.includes('SD') || upperName.includes('480P')) quality = 'SD';

        let fileTitle = meta.title;
        const rawTitleToCheck = (stream.title || '').toUpperCase();
        if (stream.title) {
            const cleanRaw = stream.title.split('\n')[0].replace(/[🎬⚡🌪️⛩️🍿🦁🎥🌐]/g, '').trim();
            if (cleanRaw.length > 2) fileTitle = cleanRaw;
        }

        let langTag = 'ITA';
        let providerIcon = '🌐';
        const sLower = sourceName.toLowerCase();
        if (sLower.includes('animeworld')) {
            providerIcon = '⛩️';
            langTag = (rawTitleToCheck.includes('JPN') || rawTitleToCheck.includes('SUB') || rawTitleToCheck.includes('VOST')) ? 'JPN' : 'ITA';
        } else if (sLower.includes('streamingcommunity')) providerIcon = '🌪️';
        else if (sLower.includes('guardaserie')) providerIcon = '🍿';
        else if (sLower.includes('guardahd')) providerIcon = '🦁';
        else if (sLower.includes('guardaflix')) providerIcon = '🎥';

        const formatted = formatStreamSelector(`${fileTitle} ${quality} ${langTag} WEB-DL AAC`, sourceName, 0, null, 'WEB', config, null, false, false);
        const cleanTitle = formatted.title.replace(/🧲/g, '⛵').replace(/🦈/g, providerIcon).replace(/🧲\s*\d+(\.\d+)?\s*(GB|MB)/gi, '☁️ Web Stream');
        return {
            name: formatted.name.replace(/🧲/g, '⛵').replace(/🦈/g, providerIcon),
            title: cleanTitle,
            url: stream.url,
            behaviorHints: stream.behaviorHints || { notWebReady: false, bingieGroup: `Leviathan|${quality}|Web|${sourceName}` }
        };
    });
}

function createWebStreamTools({ Cache, LIMITERS, CONFIG, guardedProviderCall }) {
    async function fetchWebProviderBuckets({ type, originalId, finalId, meta, config, reqHost, allowItalianWebProviders, dbOnlyMode }) {
        const empty = {
            streamingCommunity: [],
            guardaHD: [],
            guardaSerie: [],
            animeWorld: [],
            guardaFlix: []
        };

        if (dbOnlyMode || !allowItalianWebProviders) return empty;

        const rawId = `${type}:${finalId}:${meta.season || 0}:${meta.episode || 0}`;
        const providerSpecs = [
            {
                key: 'streamingCommunity',
                cacheName: 'StreamingCommunity',
                enabled: isStreamingCommunityEnabled(config.filters),
                limiter: LIMITERS.webVix,
                runner: () => searchStreamingCommunity(meta, config, reqHost)
            },
            {
                key: 'guardaHD',
                cacheName: 'GuardaHD',
                enabled: config.filters?.enableGhd,
                limiter: LIMITERS.webGhd,
                runner: () => searchGuardaHD(meta, config)
            },
            {
                key: 'guardaSerie',
                cacheName: 'GuardaSerie',
                enabled: config.filters?.enableGs,
                limiter: LIMITERS.webGs,
                runner: () => searchGuardaserie(meta, config)
            },
            {
                key: 'animeWorld',
                cacheName: 'AnimeWorld',
                enabled: config.filters?.enableAnimeWorld,
                limiter: LIMITERS.webAw,
                runner: () => searchAnimeWorld(originalId, meta, config)
            },
            {
                key: 'guardaFlix',
                cacheName: 'GuardaFlix',
                enabled: config.filters?.enableGf,
                limiter: LIMITERS.webGf,
                runner: () => searchGuardaFlix(meta, config)
            }
        ];

        const settled = await Promise.allSettled(providerSpecs.map((spec) => {
            if (!spec.enabled) return Promise.resolve([]);
            return Cache.fetchWithCache(spec.cacheName, rawId, 43200, () =>
                guardedProviderCall(spec.cacheName, spec.limiter, CONFIG.TIMEOUTS.SCRAPER, spec.runner)
            );
        }));

        return providerSpecs.reduce((acc, spec, index) => {
            acc[spec.key] = settled[index]?.status === 'fulfilled' ? settled[index].value : [];
            return acc;
        }, empty);
    }

    function formatWebProviderBuckets(webBuckets, meta, config) {
        const buckets = {
            streamingCommunity: Array.isArray(webBuckets?.streamingCommunity) ? [...webBuckets.streamingCommunity] : [],
            guardaHD: Array.isArray(webBuckets?.guardaHD) ? [...webBuckets.guardaHD] : [],
            guardaSerie: Array.isArray(webBuckets?.guardaSerie) ? [...webBuckets.guardaSerie] : [],
            animeWorld: Array.isArray(webBuckets?.animeWorld) ? [...webBuckets.animeWorld] : [],
            guardaFlix: Array.isArray(webBuckets?.guardaFlix) ? [...webBuckets.guardaFlix] : []
        };

        if (aioFormatter && aioFormatter.isAIOStreamsEnabled(config)) {
            return {
                streamingCommunity: applyAioWebStyle(buckets.streamingCommunity, 'StreamingCommunity', meta),
                guardaHD: applyAioWebStyle(buckets.guardaHD, 'GuardaHD', meta),
                guardaSerie: applyAioWebStyle(buckets.guardaSerie, 'GuardaSerie', meta),
                animeWorld: applyAioWebStyle(buckets.animeWorld, 'AnimeWorld', meta),
                guardaFlix: applyAioWebStyle(buckets.guardaFlix, 'GuardaFlix', meta)
            };
        }

        return {
            streamingCommunity: buckets.streamingCommunity.length > 0 ? applyWebFormatter(buckets.streamingCommunity, 'StreamingCommunity', meta, config) : [],
            guardaHD: buckets.guardaHD.length > 0 ? applyWebFormatter(buckets.guardaHD, 'GuardaHD', meta, config) : [],
            guardaSerie: buckets.guardaSerie.length > 0 ? applyWebFormatter(buckets.guardaSerie, 'GuardaSerie', meta, config) : [],
            animeWorld: buckets.animeWorld.length > 0 ? applyWebFormatter(buckets.animeWorld, 'AnimeWorld', meta, config) : [],
            guardaFlix: buckets.guardaFlix.length > 0 ? applyWebFormatter(buckets.guardaFlix, 'GuardaFlix', meta, config) : []
        };
    }

    function mergeFinalStreams(debridStreams, formattedWebBuckets, filters = {}) {
        const webStreams = [
            ...(formattedWebBuckets?.guardaHD || []),
            ...(formattedWebBuckets?.guardaSerie || []),
            ...(formattedWebBuckets?.animeWorld || []),
            ...(formattedWebBuckets?.guardaFlix || []),
            ...(formattedWebBuckets?.streamingCommunity || [])
        ];

        return isStreamingCommunityLastEnabled(filters)
            ? [...(debridStreams || []), ...webStreams]
            : [...webStreams, ...(debridStreams || [])];
    }

    return {
        fetchWebProviderBuckets,
        formatWebProviderBuckets,
        mergeFinalStreams,
        isStreamingCommunityEnabled,
        isStreamingCommunityLastEnabled
    };
}

module.exports = { createWebStreamTools };
