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

function rewriteWebTitleLayout(title, providerIcon, providerLabel, extractorLabel) {
    const lines = String(title || '').split('\n').map((line) => String(line || '').trim()).filter(Boolean);
    const cleaned = lines.filter((line) => !/^(?:⛵|🦈|🌐|🌪️|🍿|🦁|🎥|⛩️|🪐)\s+/.test(line));
    cleaned.push(`${providerIcon} ${providerLabel}`);
    cleaned.push(`⛵ ${extractorLabel || 'Web'}`);
    return cleaned.join('\n');
}

function applyAioWebStyle(streamList, providerDefinition, meta) {
    if (!Array.isArray(streamList) || streamList.length === 0) return [];

    const sourceName = providerDefinition?.sourceName || 'Web';
    const providerIcon = providerDefinition?.icon || getWebProviderIcon(sourceName);
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
        stream.name = aioFormatter.formatStreamName({ service: 'web', cached: true, quality });
        stream.title = aioFormatter.formatStreamTitle({
            title: meta.title,
            size: 'Web',
            language: '🇮🇹 ITA',
            source: extractorLabel,
            providerLine: `${providerIcon} ${providerLabel}`,
            sourceIcon: '⛵',
            seeders: null,
            techInfo: `🎞️ ${quality} ${qIcon}`
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
        const sLower = sourceName.toLowerCase();
        if (sLower.includes('animeworld') || sLower.includes('animesaturn')) {
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

function createWebProviderTools({ Cache, LIMITERS, CONFIG, guardedProviderCall }) {
    async function fetchWebProviderBuckets({ type, originalId, finalId, meta, config, reqHost, allowItalianWebProviders, dbOnlyMode }) {
        const definitions = getWebProviderDefinitions({ meta, filters: config.filters || {} });
        const empty = Object.fromEntries(definitions.map((definition) => [definition.key, []]));

        if (dbOnlyMode || !allowItalianWebProviders) return empty;

        const rawId = `${type}:${finalId}:${meta.season || 0}:${meta.episode || 0}`;
        const settled = await Promise.allSettled(definitions.map((definition) => {
            if (!definition.enabled) return Promise.resolve([]);

            return Cache.fetchWithCache(definition.cacheName, rawId, 43200, () =>
                guardedProviderCall(
                    definition.cacheName,
                    LIMITERS[definition.limiterKey],
                    getWebProviderTimeout(CONFIG.TIMEOUTS.SCRAPER, definition.cacheName),
                    () => definition.run({ type, originalId, finalId, meta, config, reqHost })
                )
            );
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
