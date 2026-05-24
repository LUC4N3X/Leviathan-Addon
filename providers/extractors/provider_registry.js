'use strict';

const crypto = require('crypto');
const { searchVix: searchStreamingCommunity } = require('../streamingcommunity/vix_handler');
const { searchGuardaHD } = require('../guardahd/ghd_handler');
const { searchGuardoSerie } = require('../guardoserie/gs_handler');
const { searchGuardaserieTv } = require('../guardaserietv/gstv_handler');
const { searchEurostreaming } = require('../eurostreaming/es_handler');
const { searchCb01 } = require('../cb01/cb01_handler');
const { searchAnimeWorld } = require('../animeworld/aw_handler');
const { searchAnimeUnity } = require('../animeunity/au_handler');
const { searchAnimeSaturn } = require('../animesaturn/as_handler');
const { searchGuardaFlix } = require('../guardaflix/gf_handler');
const { searchAltadefinizione } = require('../altadefinizione/ads_handler');
const { searchCinemaCity } = require('../cinemacity/cc_handler');
const { getProviderRecipe } = require('../engine/provider_definition_engine');

const STREAMING_COMMUNITY_MIN_TIMEOUT = Math.max(12000, parseInt(process.env.SC_PROVIDER_TIMEOUT || '16000', 10) || 16000);
const ANIMEWORLD_MIN_TIMEOUT = Math.max(12000, parseInt(process.env.AW_PROVIDER_TIMEOUT || '16000', 10) || 16000);
const ALTADEFINIZIONE_MIN_TIMEOUT = Math.max(12000, parseInt(process.env.ALTADEFINIZIONE_PROVIDER_TIMEOUT || process.env.CC_PROVIDER_TIMEOUT || '18000', 10) || 18000);
const ALTADEFINIZIONE_EMPTY_TTL = Math.max(15, parseInt(process.env.ALTADEFINIZIONE_PROVIDER_EMPTY_TTL || process.env.CC_PROVIDER_EMPTY_TTL || '60', 10) || 60);
const ALTADEFINIZIONE_ERROR_TTL = Math.max(3, Math.min(ALTADEFINIZIONE_EMPTY_TTL, parseInt(process.env.ALTADEFINIZIONE_PROVIDER_ERROR_TTL || process.env.CC_PROVIDER_ERROR_TTL || '10', 10) || 10));
const CINEMACITY_MIN_TIMEOUT = Math.max(12000, parseInt(process.env.CC_PROVIDER_TIMEOUT || process.env.CINEMACITY_PROVIDER_TIMEOUT || '18000', 10) || 18000);
const CINEMACITY_EMPTY_TTL = Math.max(15, parseInt(process.env.CC_PROVIDER_EMPTY_TTL || process.env.CINEMACITY_PROVIDER_EMPTY_TTL || '60', 10) || 60);
const CINEMACITY_ERROR_TTL = Math.max(3, Math.min(CINEMACITY_EMPTY_TTL, parseInt(process.env.CC_PROVIDER_ERROR_TTL || process.env.CINEMACITY_PROVIDER_ERROR_TTL || '10', 10) || 10));
const GUARDO_SERIE_MIN_TIMEOUT = Math.max(30000, parseInt(process.env.GS_PROVIDER_TIMEOUT || '45000', 10) || 45000);
const GUARDASERIETV_MIN_TIMEOUT = Math.max(15000, parseInt(process.env.GSTV_PROVIDER_TIMEOUT || '22000', 10) || 22000);
const EUROSTREAMING_MIN_TIMEOUT = Math.max(15000, parseInt(process.env.ES_PROVIDER_TIMEOUT || '22000', 10) || 22000);
const CB01_MIN_TIMEOUT = Math.max(15000, parseInt(process.env.CB01_PROVIDER_TIMEOUT || '22000', 10) || 22000);
const GUARDO_SERIE_EMPTY_TTL = Math.max(15, parseInt(process.env.GS_PROVIDER_EMPTY_TTL || '45', 10) || 45);
const GUARDO_SERIE_ERROR_TTL = Math.max(3, Math.min(GUARDO_SERIE_EMPTY_TTL, parseInt(process.env.GS_PROVIDER_ERROR_TTL || '5', 10) || 5));
const GUARDASERIETV_EMPTY_TTL = Math.max(15, parseInt(process.env.GSTV_PROVIDER_EMPTY_TTL || '45', 10) || 45);
const GUARDASERIETV_ERROR_TTL = Math.max(3, Math.min(GUARDASERIETV_EMPTY_TTL, parseInt(process.env.GSTV_PROVIDER_ERROR_TTL || '8', 10) || 8));
const EUROSTREAMING_EMPTY_TTL = Math.max(15, parseInt(process.env.ES_PROVIDER_EMPTY_TTL || '45', 10) || 45);
const EUROSTREAMING_ERROR_TTL = Math.max(3, Math.min(EUROSTREAMING_EMPTY_TTL, parseInt(process.env.ES_PROVIDER_ERROR_TTL || '8', 10) || 8));
const CB01_EMPTY_TTL = Math.max(15, parseInt(process.env.CB01_PROVIDER_EMPTY_TTL || '45', 10) || 45);
const CB01_ERROR_TTL = Math.max(3, Math.min(CB01_EMPTY_TTL, parseInt(process.env.CB01_PROVIDER_ERROR_TTL || '8', 10) || 8));


function firstEnvValue(...names) {
    for (const name of names) {
        const value = process.env[name];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function normalizeCacheUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/g, '');
    if (!raw) return '';
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
        const url = new URL(withProtocol);
        return `${url.protocol}//${url.hostname.replace(/^www\./i, '').toLowerCase()}`;
    } catch (_) {
        return withProtocol.toLowerCase();
    }
}

function getCb01ProviderCacheVersion() {
    const primary = normalizeCacheUrl('https://cb01uno.bar');
    const hash = crypto.createHash('sha1').update(primary).digest('hex').slice(0, 12);
    return `hardcoded-domain:${hash}`;
}

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
        key: 'altadefinizione',
        recipeId: 'altadefinizione',
        sourceName: 'AltadefinizioneStreaming',
        cacheName: 'AltadefinizioneStreaming',
        cacheKeyVersion: 'vidxgo-impit-mixdrop-v1',
        icon: '🎞️',
        limiterKey: 'webAds',
        minTimeout: ALTADEFINIZIONE_MIN_TIMEOUT,
        emptyTtl: ALTADEFINIZIONE_EMPTY_TTL,
        errorTtl: ALTADEFINIZIONE_ERROR_TTL,
        isEnabled: ({ filters }) => filters?.enableAltadefinizione === true,
        run: ({ originalId, finalId, meta, config, reqHost }) => searchAltadefinizione(originalId, finalId, meta, config, reqHost)
    },
    {
        key: 'cinemacity',
        recipeId: 'cinemacity',
        sourceName: 'CinemaCity',
        cacheName: 'CinemaCity',
        cacheKeyVersion: 'cc-flaresolverr-v1',
        icon: '🎟️',
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
        key: 'guardaserieTv',
        recipeId: 'guardaserietv',
        sourceName: 'GuardaserieTV',
        cacheName: 'GuardaserieTV',
        icon: '📺',
        limiterKey: 'webGstv',
        minTimeout: GUARDASERIETV_MIN_TIMEOUT,
        emptyTtl: GUARDASERIETV_EMPTY_TTL,
        errorTtl: GUARDASERIETV_ERROR_TTL,
        isEnabled: ({ filters }) => filters?.enableGstv === true,
        run: ({ meta, config, reqHost }) => searchGuardaserieTv(meta, config, reqHost)
    },
    {
        key: 'eurostreaming',
        recipeId: 'eurostreaming',
        sourceName: 'Eurostreaming',
        cacheName: 'Eurostreaming',
        icon: '🌍',
        limiterKey: 'webEs',
        minTimeout: EUROSTREAMING_MIN_TIMEOUT,
        emptyTtl: EUROSTREAMING_EMPTY_TTL,
        errorTtl: EUROSTREAMING_ERROR_TTL,
        isEnabled: ({ filters }) => filters?.enableEs === true,
        run: ({ meta, config, reqHost }) => searchEurostreaming(meta, config, reqHost)
    },
    {
        key: 'cb01',
        recipeId: 'cb01',
        sourceName: 'CB01',
        cacheName: 'CB01V2',
        cacheKeyVersion: getCb01ProviderCacheVersion(),
        icon: '🎬',
        limiterKey: 'webCb01',
        minTimeout: CB01_MIN_TIMEOUT,
        emptyTtl: CB01_EMPTY_TTL,
        errorTtl: CB01_ERROR_TTL,
        isEnabled: ({ filters }) => filters?.enableCb01 === true,
        run: ({ meta, config, reqHost }) => searchCb01(meta, config, reqHost)
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
