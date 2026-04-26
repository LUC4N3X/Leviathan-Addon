'use strict';

const aioFormatter = require('../lib/pulse_formatter.cjs');
const { formatStreamSelector } = require('../lib/stream_formatter');
const {
    WEB_PROVIDER_ORDER,
    getWebProviderDefinitions,
    getWebProviderIcon,
    getWebProviderTimeout,
    isStreamingCommunityEnabled,
    isStreamingCommunityLastEnabled
} = require('../../providers/extractors/provider_registry');

function normalizeWebExtractorLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (/[|â€¢]/.test(raw)) return '';
    if (/^(unknown|unknow|n\/a|null|undefined)$/i.test(raw)) return '';
    if (/vix(?:cloud|src)?/i.test(raw)) return 'VixCloud';
    if (/cccdn/i.test(raw)) return 'CCCDN';
    if (/mixdrop|m1xdrop|mxcontent/i.test(raw)) return 'MixDrop';
    if (/loadm/i.test(raw)) return 'LoadM';
    if (/supervideo/i.test(raw)) return 'SuperVideo';
    if (/maxstream/i.test(raw)) return 'Maxstream';
    if (/voe/i.test(raw)) return 'VOE';
    if (/streamtape/i.test(raw)) return 'StreamTape';
    if (/dood/i.test(raw)) return 'DoodStream';
    if (/filemoon/i.test(raw)) return 'FileMoon';
    if (/^https?:\/\//i.test(raw)) return '';
    if (/^(?:hls|direct)\s+proxy$/i.test(raw)) return '';
    if (/^(?:mfp|cinemacity)$/i.test(raw)) return '';
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
    if (/cinemacity/i.test(source)) return 'CCCDN';
    return '';
}

function normalizeWebQualityLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^(?:4k|2160p|uhd)$/i.test(raw)) return '4K';
    if (/^(?:1440p|2k|qhd)$/i.test(raw)) return '1440p';
    if (/^(?:1080p|1080i|fhd|fullhd)$/i.test(raw)) return '1080p';
    if (/^(?:720p|hd)$/i.test(raw)) return '720p';
    if (/^(?:480p|sd)$/i.test(raw)) return 'SD';
    if (/^\d{3,4}p$/i.test(raw)) return raw.toLowerCase();
    return raw;
}

function inferWebQuality(stream, sourceName) {
    const directCandidates = [
        stream?.quality,
        stream?.behaviorHints?.vortexMeta?.quality,
        stream?.behaviorHints?.quality
    ];

    for (const candidate of directCandidates) {
        const normalized = normalizeWebQualityLabel(candidate);
        if (normalized) return normalized;
    }

    const textToCheck = `${stream?.title || ''} ${stream?.name || ''}`.toUpperCase().replace(/GUARDAHD|GUARDOSERIE|GUARDASERIE|STREAMINGCOMMUNITY|CINEMACITY|LEVIATHAN|VIX|GUARDAFLIX|ANIMEWORLD|ANIMEUNITY|ANIMESATURN/g, '');
    if (/\b(4K|2160P|UHD)\b/.test(textToCheck)) return '4K';
    if (/\b(1440P|2K|QHD)\b/.test(textToCheck)) return '1440p';
    if (/\b(1080P|FHD|FULLHD)\b/.test(textToCheck)) return '1080p';
    if (/\b(720P|HD)\b/.test(textToCheck)) return '720p';
    if (/\b(480P|SD)\b/.test(textToCheck)) return 'SD';

    if (/streamingcommunity|vix/i.test(String(sourceName || ''))) return '1080p';
    return '';
}

function getWebQualityIcon(quality) {
    const normalized = String(quality || '').toLowerCase();
    if (normalized === '4k' || normalized === '1440p' || normalized === '1080p') return 'ðŸ”¥';
    if (normalized === '720p') return 'âš¡';
    if (normalized === 'sd' || normalized === '480p') return 'ðŸ“¼';
    return 'ðŸ“º';
}

function rewriteWebTitleLayout(title, providerIcon, providerLabel, extractorLabel) {
    const lines = String(title || '').split('\n').map((line) => String(line || '').trim()).filter(Boolean);
    const cleaned = lines.filter((line) => {
        if (providerIcon && line.startsWith(providerIcon)) return false;
        return !/^(?:â›µ|ðŸ§²|ðŸ”Ž|ðŸ™ï¸|ðŸŒ|ðŸŒªï¸|ðŸ¿|ðŸ¦|ðŸŽ¥|ðŸŽŸï¸|â›©ï¸|ðŸŒ€|ðŸª|âš™ï¸|âœ¨|ðŸ›°ï¸|ðŸ”)\s+/.test(line);
    });
    cleaned.push(`${providerIcon} ${providerLabel}`);
    cleaned.push(`â›µ ${extractorLabel || 'Web'}`);
    return cleaned.join('\n');
}

function applyAioWebStyle(streamList, providerDefinition, meta) {
    if (!Array.isArray(streamList) || streamList.length === 0) return [];

    const sourceName = providerDefinition?.sourceName || 'Web';
    const providerIcon = providerDefinition?.icon || getWebProviderIcon(sourceName);
    const isAnimeProvider = sourceName.includes('AnimeWorld') || sourceName.includes('AnimeUnity') || sourceName.includes('AnimeSaturn');

    return streamList.map((stream) => {
        const quality = inferWebQuality(stream, sourceName) || 'WebStreams';
        const qIcon = getWebQualityIcon(quality);

        if (isAnimeProvider) {
            const extractorLabel = inferWebExtractorLabel(stream, sourceName) || 'Web';
            const providerLabel = String(sourceName || '').trim() || 'Web';
            stream.name = aioFormatter.formatStreamName({ service: 'web', cached: true, quality: 'HD' });
            stream.title = aioFormatter.formatStreamTitle({
                title: meta.title,
                size: 'Web',
                language: 'ðŸ‡¯ðŸ‡µ JPN/ITA',
                source: extractorLabel,
                providerLine: `${providerIcon} ${providerLabel}`,
                sourceIcon: 'â›µ',
                techInfo: sourceName.includes('AnimeSaturn') ? 'ðŸª Anime' : (sourceName.includes('AnimeUnity') ? 'ðŸŒ€ Anime' : 'â›©ï¸ Anime')
            });
            stream.behaviorHints = stream.behaviorHints || {};
            stream.behaviorHints.bingieGroup = `Leviathan|HD|Web|${sourceName.replace(/\W/g, '')}`;
            return stream;
        }

        const extractorLabel = inferWebExtractorLabel(stream, sourceName) || 'Web';
        const providerLabel = String(sourceName || '').trim() || 'Web';
        stream.name = aioFormatter.formatStreamName({ service: 'web', cached: true, quality });
        stream.title = aioFormatter.formatStreamTitle({
            title: meta.title,
            size: 'Web',
            language: 'ðŸ‡®ðŸ‡¹ ITA',
            source: extractorLabel,
            providerLine: `${providerIcon} ${providerLabel}`,
            sourceIcon: 'â›µ',
            seeders: null,
            techInfo: `ðŸŽžï¸ ${quality} ${qIcon}`
        });
        stream.behaviorHints = stream.behaviorHints || {};
        stream.behaviorHints.bingieGroup = `Leviathan|${quality}|Web|${sourceName.replace(/\W/g, '')}`;
        return stream;
    });
}

function applyWebFormatter(streamList, providerDefinition, meta, config) {
    if (!streamList || !Array.isArray(streamList)) return [];

    const sourceName = providerDefinition?.sourceName || 'Web';
    const providerIcon = providerDefinition?.icon || getWebProviderIcon(sourceName);

    return streamList.map((stream) => {
        const quality = inferWebQuality(stream, sourceName) || 'HD';

        let fileTitle = meta.title;
        const rawTitleToCheck = (stream.title || '').toUpperCase();
        if (stream.title) {
            const cleanRaw = stream.title.split('\n')[0].replace(/[ðŸŽ¬âš¡ðŸŒªï¸â›©ï¸ðŸ¿ðŸ¦ðŸŽ¥ðŸŒ]/g, '').trim();
            if (cleanRaw.length > 2) fileTitle = cleanRaw;
        }

        let langTag = 'ITA';
        const sLower = sourceName.toLowerCase();
        if (sLower.includes('animeworld') || sLower.includes('animeunity') || sLower.includes('animesaturn')) {
            langTag = (rawTitleToCheck.includes('JPN') || rawTitleToCheck.includes('SUB') || rawTitleToCheck.includes('VOST')) ? 'JPN' : 'ITA';
        }

        const extractorLabel = inferWebExtractorLabel(stream, sourceName) || 'Web';
        const providerLabel = String(sourceName || '').trim() || 'Web';
        const formatted = formatStreamSelector(`${fileTitle} ${quality} ${langTag} WEB-DL AAC`, extractorLabel, 0, null, 'WEB', config, null, false, false);
        const cleanTitle = formatted.title.replace(/ðŸ§²/g, 'â›µ').replace(/ðŸ¦ˆ/g, providerIcon).replace(/ðŸ§²\s*\d+(\.\d+)?\s*(GB|MB)/gi, 'â˜ï¸ Web Stream');
        const titled = rewriteWebTitleLayout(cleanTitle, providerIcon, providerLabel, extractorLabel);
        return {
            name: formatted.name.replace(/ðŸ§²/g, 'â›µ').replace(/ðŸ¦ˆ/g, providerIcon),
            title: titled,
            url: stream.url,
            behaviorHints: stream.behaviorHints || { notWebReady: false, bingieGroup: `Leviathan|${quality}|Web|${sourceName}` }
        };
    });
}

function createWebProviderTools({ Cache, LIMITERS, CONFIG, guardedProviderCall }) {
    async function fetchWebProviderBuckets({ type, originalId, finalId, meta, config, reqHost, allowItalianWebProviders, dbOnlyMode, sourceModeFlags = null }) {
        const definitions = getWebProviderDefinitions({ meta, filters: config.filters || {} });
        const empty = Object.fromEntries(definitions.map((definition) => [definition.key, []]));
        const flags = sourceModeFlags || {
            dbOnlyMode: dbOnlyMode === true,
            useLiveSources: dbOnlyMode !== true,
            useProviderCachedOnly: false,
            bypassProviderCache: false
        };

        if (flags.dbOnlyMode || !allowItalianWebProviders) return empty;

        const rawId = `${type}:${finalId}:${meta.season || 0}:${meta.episode || 0}`;
        const settled = await Promise.allSettled(definitions.map((definition) => {
            if (!definition.enabled) return Promise.resolve([]);
            if (!flags.useLiveSources && !flags.useProviderCachedOnly) return Promise.resolve([]);

            return Cache.fetchWithCache(definition.cacheName, rawId, 43200, () =>
                guardedProviderCall(
                    definition.cacheName,
                    LIMITERS[definition.limiterKey],
                    getWebProviderTimeout(CONFIG.TIMEOUTS.SCRAPER, definition.cacheName),
                    () => definition.run({ type, originalId, finalId, meta, config, reqHost })
                )
            , {
                cacheOnly: flags.useProviderCachedOnly === true,
                bypassCache: flags.bypassProviderCache === true,
                emptyTtl: Math.max(1, Number(definition.emptyTtl || 3600) || 3600),
                errorTtl: Math.max(1, Number(definition.errorTtl || Math.min(Number(definition.emptyTtl || 3600) || 3600, 300)) || 300)
            });
        }));

        return definitions.reduce((acc, definition, index) => {
            acc[definition.key] = settled[index]?.status === 'fulfilled' ? settled[index].value : [];
            return acc;
        }, empty);
    }

    function formatWebProviderBuckets(webBuckets, meta, config) {
        const definitions = getWebProviderDefinitions({ meta, filters: config.filters || {} });
        const formatted = {};

        for (const definition of definitions) {
            const bucket = Array.isArray(webBuckets?.[definition.key]) ? [...webBuckets[definition.key]] : [];
            if (aioFormatter && aioFormatter.isAIOStreamsEnabled(config)) {
                formatted[definition.key] = bucket.length > 0 ? applyAioWebStyle(bucket, definition, meta) : [];
            } else {
                formatted[definition.key] = bucket.length > 0 ? applyWebFormatter(bucket, definition, meta, config) : [];
            }
        }

        return formatted;
    }

    function mergeFinalStreams(debridStreams, formattedWebBuckets, filters = {}) {
        const webStreams = WEB_PROVIDER_ORDER.flatMap((key) => Array.isArray(formattedWebBuckets?.[key]) ? formattedWebBuckets[key] : []);

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

module.exports = { createWebProviderTools };
