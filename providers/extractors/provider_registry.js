'use strict';

const { searchVix: searchStreamingCommunity } = require('../streamingcommunity/vix_handler');
const { searchGuardaHD } = require('../guardahd/ghd_handler');
const { searchGuardoSerie } = require('../guardoserie/gs_handler');
const { searchAnimeWorld } = require('../animeworld/aw_handler');
const { searchAnimeUnity } = require('../animeunity/au_handler');
const { searchAnimeSaturn } = require('../animesaturn/as_handler');
const { searchGuardaFlix } = require('../guardaflix/gf_handler');
const { searchCinemaCity } = require('../cinemacity/cc_handler');
const { getProviderRecipe } = require('../engine/provider_definition_engine');

const STREAMING_COMMUNITY_MIN_TIMEOUT = Math.max(12000, parseInt(process.env.SC_PROVIDER_TIMEOUT || '16000', 10) || 16000);
const ANIMEWORLD_MIN_TIMEOUT = Math.max(12000, parseInt(process.env.AW_PROVIDER_TIMEOUT || '16000', 10) || 16000);
const CINEMACITY_MIN_TIMEOUT = Math.max(12000, parseInt(process.env.CC_PROVIDER_TIMEOUT || '18000', 10) || 18000);
const CINEMACITY_EMPTY_TTL = Math.max(15, parseInt(process.env.CC_PROVIDER_EMPTY_TTL || '60', 10) || 60);
const CINEMACITY_ERROR_TTL = Math.max(3, Math.min(CINEMACITY_EMPTY_TTL, parseInt(process.env.CC_PROVIDER_ERROR_TTL || '10', 10) || 10));
const GUARDO_SERIE_MIN_TIMEOUT = Math.max(30000, parseInt(process.env.GS_PROVIDER_TIMEOUT || '45000', 10) || 45000);
const GUARDO_SERIE_EMPTY_TTL = Math.max(15, parseInt(process.env.GS_PROVIDER_EMPTY_TTL || '45', 10) || 45);
const GUARDO_SERIE_ERROR_TTL = Math.max(3, Math.min(GUARDO_SERIE_EMPTY_TTL, parseInt(process.env.GS_PROVIDER_ERROR_TTL || '5', 10) || 5));

function isStreamingCommunityEnabled(filters = {}) {
    return filters?.enableStreamingCommunity === true || filters?.enableVix === true;
}

function isStreamingCommunityLastEnabled(filters = {}) {
    return filters?.streamingCommunityLast === true || filters?.vixLast === true;
}

function isAnimeWebEligible(meta = {}) {
    return Boolean(meta?.kitsu_id || meta?.isAnime || String(meta?.type || '').toLowerCase() === 'anime');
}

function hasExplicitKitsuMeta(meta = {}) {
    const candidates = [
        meta?.kitsu_id,
        meta?.kitsuId,
        meta?.id,
        meta?.imdb_id,
        meta?.stremioId,
        meta?.behaviorHints?.kitsuId
    ];

    return candidates.some((value) => {
        const raw = String(value || '').trim();
        return /^kitsu(?::|_)?\d+/i.test(raw) || (/^\d+$/.test(raw) && Boolean(meta?.kitsu_id || meta?.kitsuId));
    });
}

function isAnimeUnityEnabled(filters = {}, meta = {}) {
    if (filters?.enableAnimeUnity === true) return isAnimeWebEligible(meta);
    if (filters?.enableAnimeUnity === false) return false;

    // Backward compatibility: older installed URLs do not contain enableAnimeUnity.
    // On Kitsu anime requests, auto-enable AU without forcing it on normal film/series IDs.
    return hasExplicitKitsuMeta(meta) && isAnimeWebEligible(meta);
}

const WEB_PROVIDER_DEFINITIONS = [
    {
        key: 'streamingCommunity',
        recipeId: 'streamingcommunity',
        sourceName: 'StreamingCommunity',
        cacheName: 'StreamingCommunity',
        icon: '🌪️',
        limiterKey: 'webVix',
        minTimeout: STREAMING_COMMUNITY_MIN_TIMEOUT,
        isEnabled: ({ filters }) => isStreamingCommunityEnabled(filters),
        run: ({ meta, config, reqHost }) => searchStreamingCommunity(meta, config, reqHost)
    },
    {
        key: 'cinemaCity',
        recipeId: 'cinemacity',
        sourceName: 'CinemaCity',
        cacheName: 'CinemaCityV3',
        icon: '🏙️',
        limiterKey: 'webCc',
        minTimeout: CINEMACITY_MIN_TIMEOUT,
        emptyTtl: CINEMACITY_EMPTY_TTL,
        errorTtl: CINEMACITY_ERROR_TTL,
        isEnabled: ({ filters }) => filters?.enableCc === true,
        run: ({ originalId, finalId, meta, config, reqHost }) => searchCinemaCity(originalId, finalId, meta, config, reqHost)
    },
    {
        key: 'guardaHD',
        recipeId: 'guardahd',
        sourceName: 'GuardaHD',
        cacheName: 'GuardaHD',
        icon: '🦁',
        limiterKey: 'webGhd',
        minTimeout: 7000,
        isEnabled: ({ filters }) => filters?.enableGhd === true,
        run: ({ meta, config, reqHost }) => searchGuardaHD(meta, config, reqHost)
    },
    {
        key: 'guardaSerie',
        recipeId: 'guardoserie',
        sourceName: 'GuardoSerie',
        cacheName: 'GuardoSerie',
        icon: '🍿',
        limiterKey: 'webGs',
        minTimeout: GUARDO_SERIE_MIN_TIMEOUT,
        emptyTtl: GUARDO_SERIE_EMPTY_TTL,
        errorTtl: GUARDO_SERIE_ERROR_TTL,
        isEnabled: ({ filters }) => filters?.enableGs === true,
        run: ({ meta, config, reqHost }) => searchGuardoSerie(meta, config, reqHost)
    },
    {
        key: 'animeWorld',
        recipeId: 'animeworld',
        sourceName: 'AnimeWorld',
        cacheName: 'AnimeWorld',
        icon: '⛩️',
        limiterKey: 'webAw',
        minTimeout: ANIMEWORLD_MIN_TIMEOUT,
        isEnabled: ({ filters, meta }) => filters?.enableAnimeWorld === true && isAnimeWebEligible(meta),
        run: ({ originalId, meta, config }) => searchAnimeWorld(originalId, meta, config)
    },
    {
        key: 'animeUnity',
        recipeId: 'animeunity',
        sourceName: 'AnimeUnity',
        cacheName: 'AnimeUnity',
        icon: '🌀',
        limiterKey: 'webAu',
        minTimeout: 16000,
        emptyTtl: 30,
        errorTtl: 20,
        isEnabled: ({ filters, meta }) => isAnimeUnityEnabled(filters, meta),
        run: ({ originalId, meta, config, reqHost }) => searchAnimeUnity(originalId, meta, config, reqHost)
    },
    {
        key: 'animeSaturn',
        recipeId: 'animesaturn',
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
        recipeId: 'guardaflix',
        sourceName: 'GuardaFlix',
        cacheName: 'GuardaFlix',
        icon: '🎥',
        limiterKey: 'webGf',
        minTimeout: 7000,
        isEnabled: ({ filters, meta }) => filters?.enableGf === true && !meta?.isSeries,
        run: ({ meta, config, reqHost }) => searchGuardaFlix(meta, config, reqHost)
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


function getWebProviderRecipe(value) {
    const definition = getWebProviderDefinition(value);
    return definition?.recipeId ? getProviderRecipe(definition.recipeId) : null;
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
    getWebProviderRecipe,
    getWebProviderIcon,
    getWebProviderTimeout,
    isStreamingCommunityEnabled,
    isStreamingCommunityLastEnabled,
    isAnimeWebEligible,
    hasExplicitKitsuMeta,
    isAnimeUnityEnabled
};
