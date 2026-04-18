'use strict';

const aioFormatter = require('../lib/pulse_formatter.cjs');
const { formatStreamSelector } = require('../lib/stream_formatter');
const { searchVix: searchStreamingCommunity } = require('../../providers/streamingcommunity/vix_handler');
const { searchGuardaHD } = require('../../providers/guardahd/ghd_handler');
const { searchGuardaserie } = require('../../providers/guardaserie/gs_handler');
const { searchAnimeWorld } = require('../../providers/animeworld/aw_handler');
const { searchAnimeSaturn } = require('../../providers/animesaturn/as_handler');
const { searchGuardaFlix } = require('../../providers/guardaflix/gf_handler');

function isStreamingCommunityEnabled(filters = {}) {
    return filters?.enableStreamingCommunity === true || filters?.enableVix === true;
}

function isStreamingCommunityLastEnabled(filters = {}) {
    return filters?.streamingCommunityLast === true || filters?.vixLast === true;
}

function isAnimeWebEligible(meta = {}) {
    return Boolean(meta?.kitsu_id || meta?.isAnime || String(meta?.type || '').toLowerCase() === 'anime');
}

function getWebProviderTimeout(defaultTimeout, cacheName) {
    const baseTimeout = defaultTimeout || 4000;
    if (cacheName === 'GuardaHD' || cacheName === 'GuardoSerie' || cacheName === 'GuardaFlix') {
        return Math.max(baseTimeout, 7000);
    }
    return baseTimeout;
}


function normalizeWebExtractorLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (/^(unknown|unknow|n\/a|null|undefined)$/i.test(raw)) return '';
    if (/vix(?:cloud|src)?/i.test(raw)) return 'VixCloud';
    if (/mixdrop|m1xdrop|mxcontent/i.test(raw)) return 'MixDrop';
    if (/loadm/i.test(raw)) return 'LoadM';
    if (/supervideo/i.test(raw)) return 'SuperVideo';
    if (/maxstream/i.test(raw)) return 'Maxstream';
    if (/voe/i.test(raw)) return 'VOE';
    if (/streamtape/i.test(raw)) return 'StreamTape';
    if (/dood/i.test(raw)) return 'DoodStream';
    if (/filemoon/i.test(raw)) return 'FileMoon';
    if (/direct/i.test(raw)) return 'Direct';

    return raw
        .replace(/^host\s*[:=-]\s*/i, '')
        .replace(/^extractor\s*[:=-]\s*/i, '')
        .trim();
}

function inferWebExtractorLabel(stream, sourceName) {
    const directCandidates = [
        stream?.behaviorHints?.extractor,
        stream?.behaviorHints?.vortexMeta?.extractor,
        stream?.extractor,
        stream?.hoster,
        stream?.source,
        stream?.name,
        stream?.title,
        stream?.url
    ];

    for (const candidate of directCandidates) {
        const normalized = normalizeWebExtractorLabel(candidate);
        if (normalized) return normalized;
    }

    const source = String(sourceName || '');
    if (/streamingcommunity|vix/i.test(source)) return 'VixCloud';
    return '';
}

function buildWebSourceLabel(stream, sourceName) {
    const extractor = inferWebExtractorLabel(stream, sourceName);
    const provider = String(sourceName || '').trim();
    if (extractor && provider && extractor.toLowerCase() !== provider.toLowerCase()) {
        return `${extractor} • ${provider}`;
    }
    return extractor || provider || 'Web';
}



function getWebProviderIcon(sourceName) {
    const sLower = String(sourceName || '').toLowerCase();
    if (sLower.includes('animeworld')) return '⛩️';
    if (sLower.includes('animesaturn')) return '🪐';
    if (sLower.includes('streamingcommunity')) return '🌪️';
    if (sLower.includes('guardoserie') || sLower.includes('guardaserie')) return '🍿';
    if (sLower.includes('guardahd')) return '🦁';
    if (sLower.includes('guardaflix')) return '🎥';
    return '🌐';
}

function rewriteWebTitleLayout(title, providerIcon, providerLabel, extractorLabel) {
    const lines = String(title || '').split('\n').map((line) => String(line || '').trim()).filter(Boolean);
    const cleaned = lines.filter((line) => !/^(?:⛵|🦈|🌐|🌪️|🍿|🦁|🎥|⛩️|🪐)\s+/.test(line));
    cleaned.push(`${providerIcon} ${providerLabel}`);
    cleaned.push(`⛵ ${extractorLabel || 'Web'}`);
    return cleaned.join('\n');
}

function applyAioWebStyle(streamList, sourceName, meta) {
    if (!Array.isArray(streamList) || streamList.length === 0) return [];

    const isAnimeProvider = sourceName.includes('AnimeWorld') || sourceName.includes('AnimeSaturn');
    return streamList.map((stream) => {
        const textToCheck = `${stream?.title || ''} ${stream?.name || ''}`.toUpperCase().replace(/GUARDAHD|GUARDOSERIE|GUARDASERIE|STREAMINGCOMMUNITY|LEVIATHAN|VIX|GUARDAFLIX|ANIMEWORLD|ANIMESATURN/g, '');
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

        if (isAnimeProvider) {
            const extractorLabel = inferWebExtractorLabel(stream, sourceName) || 'Web';
            const providerLabel = String(sourceName || '').trim() || 'Web';
            const providerIcon = getWebProviderIcon(sourceName);
            stream.name = aioFormatter.formatStreamName({ service: 'web', cached: true, quality: 'HD' });
            stream.title = aioFormatter.formatStreamTitle({
                title: meta.title,
                size: 'Web',
                language: '🇯🇵 JPN/ITA',
                source: extractorLabel,
                providerLine: `${providerIcon} ${providerLabel}`,
                sourceIcon: '⛵',
                techInfo: sourceName.includes('AnimeSaturn') ? '🪐 Anime' : '⛩️ Anime'
            });
            stream.behaviorHints = stream.behaviorHints || {};
            stream.behaviorHints.bingieGroup = `Leviathan|HD|Web|${sourceName.replace(/\W/g, '')}`;
            return stream;
        }

        const extractorLabel = inferWebExtractorLabel(stream, sourceName) || 'Web';
        const providerLabel = String(sourceName || '').trim() || 'Web';
        const providerIcon = getWebProviderIcon(sourceName);
        stream.name = aioFormatter.formatStreamName({ service: 'web', cached: true, quality });
        stream.title = aioFormatter.formatStreamTitle({ title: meta.title, size: 'Web', language: '🇮🇹 ITA', source: extractorLabel, providerLine: `${providerIcon} ${providerLabel}`, sourceIcon: '⛵', seeders: null, techInfo: `🎞️ ${quality} ${qIcon}` });
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
        const providerIcon = getWebProviderIcon(sourceName);
        const sLower = sourceName.toLowerCase();
        if (sLower.includes('animeworld')) {
            langTag = (rawTitleToCheck.includes('JPN') || rawTitleToCheck.includes('SUB') || rawTitleToCheck.includes('VOST')) ? 'JPN' : 'ITA';
        } else if (sLower.includes('animesaturn')) {
            langTag = (rawTitleToCheck.includes('JPN') || rawTitleToCheck.includes('SUB') || rawTitleToCheck.includes('VOST')) ? 'JPN' : 'ITA';
        }

        const extractorLabel = inferWebExtractorLabel(stream, sourceName) || 'Web';
        const providerLabel = String(sourceName || '').trim() || 'Web';
        const formatted = formatStreamSelector(`${fileTitle} ${quality} ${langTag} WEB-DL AAC`, providerLabel, 0, null, 'WEB', config, null, false, false);
        const cleanTitle = formatted.title.replace(/🧲/g, '⛵').replace(/🦈/g, providerIcon).replace(/🧲\s*\d+(\.\d+)?\s*(GB|MB)/gi, '☁️ Web Stream');
        const titled = rewriteWebTitleLayout(cleanTitle, providerIcon, providerLabel, extractorLabel);
        return {
            name: formatted.name.replace(/🧲/g, '⛵').replace(/🦈/g, providerIcon),
            title: titled,
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
            animeSaturn: [],
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
                cacheName: 'GuardoSerie',
                enabled: config.filters?.enableGs,
                limiter: LIMITERS.webGs,
                runner: () => searchGuardaserie(meta, config)
            },
            {
                key: 'animeWorld',
                cacheName: 'AnimeWorld',
                enabled: config.filters?.enableAnimeWorld && isAnimeWebEligible(meta),
                limiter: LIMITERS.webAw,
                runner: () => searchAnimeWorld(originalId, meta, config)
            },
            {
                key: 'animeSaturn',
                cacheName: 'AnimeSaturn',
                enabled: config.filters?.enableAnimeSaturn && isAnimeWebEligible(meta),
                limiter: LIMITERS.webAs,
                runner: () => searchAnimeSaturn(originalId, meta, config)
            },
            {
                key: 'guardaFlix',
                cacheName: 'GuardaFlix',
                enabled: config.filters?.enableGf && !meta?.isSeries,
                limiter: LIMITERS.webGf,
                runner: () => searchGuardaFlix(meta, config)
            }
        ];

        const settled = await Promise.allSettled(providerSpecs.map((spec) => {
            if (!spec.enabled) return Promise.resolve([]);
            return Cache.fetchWithCache(spec.cacheName, rawId, 43200, () =>
                guardedProviderCall(spec.cacheName, spec.limiter, getWebProviderTimeout(CONFIG.TIMEOUTS.SCRAPER, spec.cacheName), spec.runner)
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
            animeSaturn: Array.isArray(webBuckets?.animeSaturn) ? [...webBuckets.animeSaturn] : [],
            guardaFlix: Array.isArray(webBuckets?.guardaFlix) ? [...webBuckets.guardaFlix] : []
        };

        if (aioFormatter && aioFormatter.isAIOStreamsEnabled(config)) {
            return {
                streamingCommunity: applyAioWebStyle(buckets.streamingCommunity, 'StreamingCommunity', meta),
                guardaHD: applyAioWebStyle(buckets.guardaHD, 'GuardaHD', meta),
                guardaSerie: applyAioWebStyle(buckets.guardaSerie, 'GuardoSerie', meta),
                animeWorld: applyAioWebStyle(buckets.animeWorld, 'AnimeWorld', meta),
                animeSaturn: applyAioWebStyle(buckets.animeSaturn, 'AnimeSaturn', meta),
                guardaFlix: applyAioWebStyle(buckets.guardaFlix, 'GuardaFlix', meta)
            };
        }

        return {
            streamingCommunity: buckets.streamingCommunity.length > 0 ? applyWebFormatter(buckets.streamingCommunity, 'StreamingCommunity', meta, config) : [],
            guardaHD: buckets.guardaHD.length > 0 ? applyWebFormatter(buckets.guardaHD, 'GuardaHD', meta, config) : [],
            guardaSerie: buckets.guardaSerie.length > 0 ? applyWebFormatter(buckets.guardaSerie, 'GuardoSerie', meta, config) : [],
            animeWorld: buckets.animeWorld.length > 0 ? applyWebFormatter(buckets.animeWorld, 'AnimeWorld', meta, config) : [],
            animeSaturn: buckets.animeSaturn.length > 0 ? applyWebFormatter(buckets.animeSaturn, 'AnimeSaturn', meta, config) : [],
            guardaFlix: buckets.guardaFlix.length > 0 ? applyWebFormatter(buckets.guardaFlix, 'GuardaFlix', meta, config) : []
        };
    }

    function mergeFinalStreams(debridStreams, formattedWebBuckets, filters = {}) {
        const webStreams = [
            ...(formattedWebBuckets?.guardaHD || []),
            ...(formattedWebBuckets?.guardaSerie || []),
            ...(formattedWebBuckets?.animeWorld || []),
            ...(formattedWebBuckets?.animeSaturn || []),
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
