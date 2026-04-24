"use strict";

const CURRENT_CONFIG_VERSION = 2;

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/[,|;]/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    return value;
}

function clonePlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...value };
}

function normalizeBoolean(value) {
    return !!value;
}

function normalizeInteger(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function migrateLegacyConfig(input = {}) {
    const config = clonePlainObject(input);
    const version = Math.max(1, parseInt(config.configVersion || '1', 10) || 1);

    config.filters = clonePlainObject(config.filters);

    const aliasPairs = [
        ['enableStreamingCommunity', 'enableVix'],
        ['streamingCommunityLast', 'vixLast']
    ];
    for (const [primaryKey, legacyKey] of aliasPairs) {
        const primaryValue = config.filters[primaryKey];
        const legacyValue = config.filters[legacyKey];
        if (primaryValue !== undefined && legacyValue === undefined) config.filters[legacyKey] = primaryValue;
        if (legacyValue !== undefined && primaryValue === undefined) config.filters[primaryKey] = legacyValue;
    }

    if (version < 2) {
        if (!config.service && config.rd) config.service = 'rd';
        if (!config.service && (config.tb || config.torbox)) config.service = 'tb';
        if (!config.service && config.filters.enableP2P === true) config.service = 'p2p';
        if (config.service === 'ad') delete config.service;
    }

    config.configVersion = CURRENT_CONFIG_VERSION;
    return config;
}

function normalizeConfigSchema(input = {}) {
    const config = migrateLegacyConfig(input);

    const normalizedService = String(config.service || '').toLowerCase();
    const allowedServices = new Set(['rd', 'tb', 'p2p', 'web']);
    if (normalizedService) {
        if (allowedServices.has(normalizedService)) config.service = normalizedService;
        else delete config.service;
    }
    delete config.ad;
    delete config.alldebrid;

    const numericFilterKeys = ['maxPerQuality', 'maxSizeGB', 'minSizeGB', 'maxSizeBytes', 'minSizeBytes', 'instantDebridTop', 'warmupTop', 'minSeeders', 'maxSeeders'];
    for (const key of numericFilterKeys) {
        const normalized = normalizeInteger(config.filters[key]);
        if (normalized === undefined) delete config.filters[key];
        else config.filters[key] = normalized;
    }

    const arrayFilterKeys = [
        'providers',
        'providerAllow',
        'providerInclude',
        'providerExclude',
        'providerDeny',
        'providerBlock',
        'qualityAllow',
        'qualityInclude',
        'qualityExclude',
        'qualityDeny',
        'qualityFilter',
        'requireTags',
        'excludeTags'
    ];
    for (const key of arrayFilterKeys) {
        if (config.filters[key] !== undefined) config.filters[key] = normalizeStringArray(config.filters[key]);
    }

    const booleanFilterKeys = ['enableVix', 'enableStreamingCommunity', 'enableGhd', 'enableGs', 'enableAnimeWorld', 'enableGf', 'enableP2P', 'showFake', 'dbOnly', 'allowEng', 'no4k', 'no1080', 'no720', 'noScr', 'noCam', 'enableTrailers', 'vixLast', 'streamingCommunityLast'];
    for (const key of booleanFilterKeys) {
        if (config.filters[key] !== undefined) config.filters[key] = normalizeBoolean(config.filters[key]);
    }

    if (config.filters.language) {
        const normalizedLanguage = String(config.filters.language).toLowerCase();
        config.filters.language = ['ita', 'eng', 'all'].includes(normalizedLanguage)
            ? normalizedLanguage
            : (config.filters.allowEng ? 'all' : 'ita');
    }

    return config;
}

module.exports = {
    CURRENT_CONFIG_VERSION,
    normalizeConfigSchema
};
