'use strict';

const SOURCE_MODES = Object.freeze({
    BALANCED: 'balanced',
    DB_ONLY: 'dbOnly',
    GLOBAL_CACHE_ONLY: 'globalCacheOnly',
    LIVE_ONLY: 'liveOnly'
});

const SOURCE_MODE_ALIASES = new Map([
    ['balanced', SOURCE_MODES.BALANCED],
    ['default', SOURCE_MODES.BALANCED],
    ['hybrid', SOURCE_MODES.BALANCED],

    ['db', SOURCE_MODES.DB_ONLY],
    ['dbonly', SOURCE_MODES.DB_ONLY],
    ['database', SOURCE_MODES.DB_ONLY],
    ['databaseonly', SOURCE_MODES.DB_ONLY],

    ['globalcache', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['globalcacheonly', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['cacheonly', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['sharedcache', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['sharedcacheonly', SOURCE_MODES.GLOBAL_CACHE_ONLY],

    ['live', SOURCE_MODES.LIVE_ONLY],
    ['liveonly', SOURCE_MODES.LIVE_ONLY],
    ['fresh', SOURCE_MODES.LIVE_ONLY]
]);

const WEB_PROVIDER_FLAGS = Object.freeze([
    'enableStreamingCommunity',
    'enableVix',
    'enableGhd',
    'enableGs',
    'enableVidxgo',
    'enableEs',
    'enableCb01',
    'enableOnlineserietv',
    'enableAnimeWorld',
    'enableAnimeUnity',
    'enableAnimeSaturn',
    'enableGf',
    'enableAltadefinizione',
    'enableToonItalia',
    'enableMoflix',
]);

function normalizeSourceMode(value, fallback = SOURCE_MODES.BALANCED) {
    const key = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z]+/g, '');

    return SOURCE_MODE_ALIASES.get(key) || fallback;
}

function getSourceMode(filters = {}) {
    const explicitMode = normalizeSourceMode(
        filters?.sourceMode || filters?.mode || filters?.source_mode || ''
    );

    if (explicitMode !== SOURCE_MODES.BALANCED) {
        return explicitMode;
    }

    if (filters?.dbOnly === true) {
        return SOURCE_MODES.DB_ONLY;
    }

    return SOURCE_MODES.BALANCED;
}

function getSourceModeFlags(filters = {}) {
    const sourceMode = getSourceMode(filters);

    const flags = {
        sourceMode,
        balancedMode: sourceMode === SOURCE_MODES.BALANCED,
        dbOnlyMode: sourceMode === SOURCE_MODES.DB_ONLY,
        cacheOnlyMode: sourceMode === SOURCE_MODES.GLOBAL_CACHE_ONLY,
        liveOnlyMode: sourceMode === SOURCE_MODES.LIVE_ONLY,

        useLocalDb: true,
        useSharedCache: true,
        useLiveSources: true,
        useProviderCachedOnly: false,
        bypassProviderCache: false
    };

    if (flags.dbOnlyMode) {
        flags.useSharedCache = false;
        flags.useLiveSources = false;
        return flags;
    }

    if (flags.cacheOnlyMode) {
        flags.useLiveSources = false;
        flags.useProviderCachedOnly = true;
        return flags;
    }

    if (flags.liveOnlyMode) {
        flags.useLocalDb = false;
        flags.useSharedCache = false;
        flags.bypassProviderCache = true;
    }

    return flags;
}

function hasWebProvidersEnabled(filters = {}) {
    return WEB_PROVIDER_FLAGS.some((flag) => filters?.[flag] === true);
}

function shouldUseTorrentPipeline(options = {}) {
    const filters = options?.filters || {};
    const hasDebridKey = options?.hasDebridKey === true;
    const isP2PEnabled = options?.isP2PEnabled === true || filters?.enableP2P === true;
    const hasWebProviders = hasWebProvidersEnabled(filters);

    return hasDebridKey || isP2PEnabled || !hasWebProviders;
}

module.exports = {
    SOURCE_MODES,
    normalizeSourceMode,
    getSourceMode,
    getSourceModeFlags,
    hasWebProvidersEnabled,
    shouldUseTorrentPipeline
};
