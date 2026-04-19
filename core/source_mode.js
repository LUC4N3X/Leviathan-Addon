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
    ['databaseonly', SOURCE_MODES.DB_ONLY],
    ['database', SOURCE_MODES.DB_ONLY],
    ['globalcacheonly', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['cacheonly', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['globalcache', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['sharedcacheonly', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['sharedcache', SOURCE_MODES.GLOBAL_CACHE_ONLY],
    ['liveonly', SOURCE_MODES.LIVE_ONLY],
    ['live', SOURCE_MODES.LIVE_ONLY],
    ['fresh', SOURCE_MODES.LIVE_ONLY]
]);

function normalizeSourceMode(value, fallback = SOURCE_MODES.BALANCED) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z]+/g, '');
    return SOURCE_MODE_ALIASES.get(normalized) || fallback;
}

function getSourceMode(filters = {}) {
    const explicitMode = normalizeSourceMode(filters?.sourceMode || filters?.mode || filters?.source_mode || '');
    if (explicitMode !== SOURCE_MODES.BALANCED) return explicitMode;
    if (filters?.dbOnly === true) return SOURCE_MODES.DB_ONLY;
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
        flags.useProviderCachedOnly = false;
        flags.bypassProviderCache = false;
    } else if (flags.cacheOnlyMode) {
        flags.useLocalDb = true;
        flags.useSharedCache = true;
        flags.useLiveSources = false;
        flags.useProviderCachedOnly = true;
        flags.bypassProviderCache = false;
    } else if (flags.liveOnlyMode) {
        flags.useLocalDb = false;
        flags.useSharedCache = false;
        flags.useLiveSources = true;
        flags.useProviderCachedOnly = false;
        flags.bypassProviderCache = true;
    }

    return flags;
}

module.exports = {
    SOURCE_MODES,
    normalizeSourceMode,
    getSourceMode,
    getSourceModeFlags
};
