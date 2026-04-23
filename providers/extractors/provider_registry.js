'use strict';

const { searchVix: searchStreamingCommunity } = require('../streamingcommunity/vix_handler');
const { searchGuardaHD } = require('../guardahd/ghd_handler');
const { searchGuardaserie } = require('../guardaserie/gs_handler');
const { searchAnimeWorld } = require('../animeworld/aw_handler');
const { searchAnimeSaturn } = require('../animesaturn/as_handler');
const { searchGuardaFlix } = require('../guardaflix/gf_handler');
const { searchCinemaCity } = require('../cinemacity/cc_handler');

function isStreamingCommunityEnabled(filters = {}) {
    return filters?.enableStreamingCommunity === true || filters?.enableVix === true;
}

function isStreamingCommunityLastEnabled(filters = {}) {
    return filters?.streamingCommunityLast === true || filters?.vixLast === true;
}

function isAnimeWebEligible(meta = {}) {
    return Boolean(meta?.kitsu_id || meta?.isAnime || String(meta?.type || '').toLowerCase() === 'anime');
}

const WEB_PROVIDER_DEFINITIONS = [
    {
        key: 'streamingCommunity',
        sourceName: 'StreamingCommunity',
        cacheName: 'StreamingCommunity',
        icon: '🌪️',
        limiterKey: 'webVix',
        minTimeout: 0,
        isEnabled: ({ filters }) => isStreamingCommunityEnabled(filters),
        run: ({ meta, config, reqHost }) => searchStreamingCommunity(meta, config, reqHost)
    },
    {
        key: 'guardaHD',
        sourceName: 'GuardaHD',
        cacheName: 'GuardaHD',
        icon: '🦁',
        limiterKey: 'webGhd',
        minTimeout: 7000,
        isEnabled: ({ filters }) => filters?.enableGhd === true,
        run: ({ meta, config }) => searchGuardaHD(meta, config)
    },
    {
        key: 'guardaSerie',
        sourceName: 'GuardoSerie',
        cacheName: 'GuardoSerie',
        icon: '🍿',
        limiterKey: 'webGs',
        minTimeout: 7000,
        isEnabled: ({ filters }) => filters?.enableGs === true,
        run: ({ meta, config }) => searchGuardaserie(meta, config)
    },
    {
        key: 'animeWorld',
        sourceName: 'AnimeWorld',
        cacheName: 'AnimeWorld',
        icon: '⛩️',
        limiterKey: 'webAw',
        minTimeout: 0,
        isEnabled: ({ filters, meta }) => filters?.enableAnimeWorld === true && isAnimeWebEligible(meta),
        run: ({ originalId, meta, config }) => searchAnimeWorld(originalId, meta, config)
    },
    {
        key: 'animeSaturn',
        sourceName: 'AnimeSaturn',
        cacheName: 'AnimeSaturn',
        icon: '🪐',
        limiterKey: 'webAs',
        minTimeout: 0,
        isEnabled: ({ filters, meta }) => filters?.enableAnimeSaturn === true && isAnimeWebEligible(meta),
        run: ({ originalId, meta, config }) => searchAnimeSaturn(originalId, meta, config)
    },
    {
        key: 'guardaFlix',
        sourceName: 'GuardaFlix',
        cacheName: 'GuardaFlix',
        icon: '🎥',
        limiterKey: 'webGf',
        minTimeout: 7000,
        isEnabled: ({ filters, meta }) => filters?.enableGf === true && !meta?.isSeries,
        run: ({ meta, config }) => searchGuardaFlix(meta, config)
    },
    {
        key: 'cinemaCity',
        sourceName: 'CinemaCity',
        cacheName: 'CinemaCityV3',
        icon: '🏙️',
        limiterKey: 'webCc',
        minTimeout: 7000,
        isEnabled: ({ filters }) => filters?.enableCc === true,
        run: ({ originalId, finalId, meta, config }) => searchCinemaCity(originalId, finalId, meta, config)
    }
];

const WEB_PROVIDER_ORDER = WEB_PROVIDER_DEFINITIONS.map((definition) => definition.key);

function getWebProviderDefinitions({ meta = {}, filters = {} } = {}) {
    return WEB_PROVIDER_DEFINITIONS.map((definition) => ({
        ...definition,
        enabled: Boolean(definition.isEnabled({ meta, filters }))
    }));
}

function getWebProviderDefinition(value) {
    const needle = String(value || '').trim().toLowerCase();
    if (!needle) return null;

    return WEB_PROVIDER_DEFINITIONS.find((definition) =>
        [definition.key, definition.sourceName, definition.cacheName]
            .filter(Boolean)
            .some((candidate) => String(candidate).toLowerCase() === needle)
    ) || null;
}

function getWebProviderIcon(value) {
    return getWebProviderDefinition(value)?.icon || '🌐';
}

function getWebProviderTimeout(defaultTimeout, value) {
    const baseTimeout = defaultTimeout || 4000;
    const definition = getWebProviderDefinition(value);
    return definition?.minTimeout ? Math.max(baseTimeout, definition.minTimeout) : baseTimeout;
}

module.exports = {
    WEB_PROVIDER_DEFINITIONS,
    WEB_PROVIDER_ORDER,
    getWebProviderDefinitions,
    getWebProviderDefinition,
    getWebProviderIcon,
    getWebProviderTimeout,
    isStreamingCommunityEnabled,
    isStreamingCommunityLastEnabled,
    isAnimeWebEligible
};
