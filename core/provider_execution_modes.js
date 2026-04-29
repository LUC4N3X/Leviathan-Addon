'use strict';

const EXECUTION_MODES = Object.freeze({
    LIVE: 'live',
    BACKGROUND: 'background',
    BOTH: 'both',
    OFF: 'off'
});

const MODE_ALIASES = new Map([
    ['live', EXECUTION_MODES.LIVE],
    ['realtime', EXECUTION_MODES.LIVE],
    ['foreground', EXECUTION_MODES.LIVE],
    ['blocking', EXECUTION_MODES.LIVE],
    ['background', EXECUTION_MODES.BACKGROUND],
    ['bg', EXECUTION_MODES.BACKGROUND],
    ['async', EXECUTION_MODES.BACKGROUND],
    ['both', EXECUTION_MODES.BOTH],
    ['hybrid', EXECUTION_MODES.BOTH],
    ['all', EXECUTION_MODES.BOTH],
    ['true', EXECUTION_MODES.BOTH],
    ['on', EXECUTION_MODES.BOTH],
    ['yes', EXECUTION_MODES.BOTH],
    ['off', EXECUTION_MODES.OFF],
    ['false', EXECUTION_MODES.OFF],
    ['no', EXECUTION_MODES.OFF],
    ['disabled', EXECUTION_MODES.OFF],
    ['none', EXECUTION_MODES.OFF]
]);

function normalizeExecutionMode(value, fallback = EXECUTION_MODES.BOTH) {
    const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!normalized) return fallback;
    return MODE_ALIASES.get(normalized) || fallback;
}

function providerAllowsLive(mode) {
    const normalized = normalizeExecutionMode(mode);
    return normalized === EXECUTION_MODES.LIVE || normalized === EXECUTION_MODES.BOTH;
}

function providerAllowsBackground(mode) {
    const normalized = normalizeExecutionMode(mode);
    return normalized === EXECUTION_MODES.BACKGROUND || normalized === EXECUTION_MODES.BOTH;
}

function providerIsBackgroundOnly(mode) {
    return normalizeExecutionMode(mode) === EXECUTION_MODES.BACKGROUND;
}

function canonicalProviderName(providerName = '') {
    const raw = String(providerName || '').trim();
    if (!raw) return 'provider';
    if (/remote\s*indexer/i.test(raw)) return 'remoteIndexer';
    if (/external\s*addons?/i.test(raw)) return 'externalAddons';
    if (/scraper\s*modules?/i.test(raw)) return 'scraper';
    return raw
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase() || 'provider';
}

function envKeyForProvider(providerName = '') {
    return `PROVIDER_MODE_${canonicalProviderName(providerName).replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
}

function getNestedProviderMode(filters = {}, canonicalName = '') {
    const containers = [
        filters.providerModes,
        filters.providerExecutionModes,
        filters.provider_mode,
        filters.providersMode
    ].filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));

    const candidates = [
        canonicalName,
        canonicalName.replace(/_/g, ''),
        canonicalName.replace(/_/g, '-'),
        canonicalName.replace(/_/g, ' ')
    ].map((entry) => String(entry || '').toLowerCase());

    for (const container of containers) {
        for (const [key, value] of Object.entries(container)) {
            const normalizedKey = String(key || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
            const compactKey = normalizedKey.replace(/_/g, '');
            if (candidates.includes(normalizedKey) || candidates.includes(compactKey)) return value;
        }
    }
    return undefined;
}

function getProviderExecutionMode(providerName, config = {}, fallback = EXECUTION_MODES.BOTH) {
    const filters = config?.filters || {};
    const canonicalName = canonicalProviderName(providerName);
    const camelName = canonicalName.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
    const pascalName = camelName.charAt(0).toUpperCase() + camelName.slice(1);

    const explicit = getNestedProviderMode(filters, canonicalName)
        ?? filters[`providerMode${pascalName}`]
        ?? filters[`${camelName}Mode`]
        ?? filters[`${canonicalName}Mode`]
        ?? filters[`mode${pascalName}`]
        ?? process.env[envKeyForProvider(providerName)]
        ?? process.env[`PROVIDER_${canonicalName.toUpperCase()}_MODE`]
        ?? process.env.PROVIDER_MODE_DEFAULT;

    return normalizeExecutionMode(explicit, fallback);
}

function getProviderExecutionPlan(providerName, config = {}, fallback = EXECUTION_MODES.BOTH) {
    const mode = getProviderExecutionMode(providerName, config, fallback);
    return {
        provider: providerName,
        canonical: canonicalProviderName(providerName),
        mode,
        live: providerAllowsLive(mode),
        background: providerAllowsBackground(mode),
        backgroundOnly: providerIsBackgroundOnly(mode)
    };
}

function shouldRunProviderInContext(providerName, config = {}, context = 'live', fallback = EXECUTION_MODES.BOTH) {
    const plan = getProviderExecutionPlan(providerName, config, fallback);
    const normalizedContext = String(context || 'live').toLowerCase();
    if (normalizedContext === 'background' || normalizedContext === 'bg') return plan.background;
    return plan.live;
}

function buildProviderModeSignature(config = {}, providerNames = []) {
    const names = Array.isArray(providerNames) && providerNames.length > 0
        ? providerNames
        : ['RemoteIndexer', 'ExternalAddons', 'ScraperModule'];
    return names
        .map((name) => `${canonicalProviderName(name)}:${getProviderExecutionMode(name, config)}`)
        .join('|');
}

function hasBackgroundCapableProvider(config = {}, providerNames = []) {
    const names = Array.isArray(providerNames) && providerNames.length > 0
        ? providerNames
        : ['RemoteIndexer', 'ExternalAddons', 'ScraperModule'];
    return names.some((name) => providerAllowsBackground(getProviderExecutionMode(name, config)));
}

function hasBackgroundOnlyProvider(config = {}, providerNames = []) {
    const names = Array.isArray(providerNames) && providerNames.length > 0
        ? providerNames
        : ['RemoteIndexer', 'ExternalAddons', 'ScraperModule'];
    return names.some((name) => providerIsBackgroundOnly(getProviderExecutionMode(name, config)));
}

module.exports = {
    EXECUTION_MODES,
    normalizeExecutionMode,
    providerAllowsLive,
    providerAllowsBackground,
    providerIsBackgroundOnly,
    canonicalProviderName,
    envKeyForProvider,
    getProviderExecutionMode,
    getProviderExecutionPlan,
    shouldRunProviderInContext,
    buildProviderModeSignature,
    hasBackgroundCapableProvider,
    hasBackgroundOnlyProvider
};
