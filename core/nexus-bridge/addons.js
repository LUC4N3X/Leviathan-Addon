'use strict';

const DEFAULT_MEDIAFUSION_URL = 'https://mediafusionfortheweebs.midnightignite.me/D-FCO8JXfrGOKFpP-Rim96nHZU9epOb5RPbSpgkgVbYoR1NRJNR1C-9X4VDrUSJJNEvp5pk7CGvSLN7cUHUrth3QG8e3mSPa8Ind2k4VzVGFEa-310EjXdsXT_uUXGri86EVnnQ6f_9b0yoVTuVu7Aqk4uY8IXZp47-0FmuxgXX6wleis_0Evllc0v2wcrWIj-D5m3IZhI18CKHr-pUL5h61ZWcaRuxGjgwYK88Xy3PIN2U3YzTi4J9pazQBpCNDH-NpZPwk2RVnjs0WF7dRU5XD_D0robmhH9q0edoqaR_71u1j2y-XnxkwPNjg-o5Yb_';

function envFirst(names, fallback = '') {
    for (const name of names) {
        const value = String(process.env[name] || '').trim();
        if (value) return value;
    }
    return fallback;
}

function envNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const EXTERNAL_ADDONS = {
    torrentio_main: {
        baseUrl: envFirst([
            'EXT_TORRENTIO_MAIN_URL',
            'TORRENTIO_MAIN_URL',
            'TORRENTIO_URL',
            'NEXUS_TORRENTIO_MAIN_URL'
        ]),
        name: 'Torrentio Main',
        timeout: envNumber('EXT_TORRENTIO_MAIN_TIMEOUT', 2200),
        priority: 1,
        maxFailures: 3,
        cooldownMs: envNumber('EXT_ADDON_COOLDOWN_MS', 30000)
    },
    torrentio_mirror: {
        baseUrl: envFirst(['EXT_TORRENTIO_MIRROR_URL', 'TORRENTIO_MIRROR_URL']),
        name: 'Torrentio Mirror',
        timeout: envNumber('EXT_TORRENTIO_MIRROR_TIMEOUT', 2200),
        priority: 2,
        maxFailures: 3,
        cooldownMs: envNumber('EXT_ADDON_COOLDOWN_MS', 30000),
        trustItalian: process.env.EXT_TORRENTIO_MIRROR_TRUST_ITA === 'true',
        trustDirectUrl: process.env.EXT_TORRENTIO_MIRROR_DIRECT !== 'false'
    },
    mediafusion: {
        baseUrl: envFirst(['EXT_MEDIAFUSION_URL', 'MEDIAFUSION_URL'], DEFAULT_MEDIAFUSION_URL),
        name: 'MediaFusion',
        timeout: envNumber('EXT_MEDIAFUSION_TIMEOUT', 3200),
        priority: 3,
        maxFailures: 4,
        cooldownMs: envNumber('EXT_ADDON_COOLDOWN_MS', 30000)
    }
};

const ADDON_GROUP_KEYS = Object.freeze({
    torrentio: Object.freeze(['torrentio_main', 'torrentio_mirror']),
    mediafusion: Object.freeze(['mediafusion'])
});

const ADDON_GROUP_BY_KEY = Object.freeze(
    Object.fromEntries(
        Object.entries(ADDON_GROUP_KEYS).flatMap(([group, keys]) => keys.map((key) => [key, group]))
    )
);

const ADDON_EMOJI_BY_GROUP = Object.freeze({
    torrentio: '🅣',
    mediafusion: '🅜'
});

const TORRENTIO_ADDON_KEYS = ADDON_GROUP_KEYS.torrentio.filter((key) => EXTERNAL_ADDONS[key]);
const MEDIAFUSION_ADDON_KEYS = ADDON_GROUP_KEYS.mediafusion.filter((key) => EXTERNAL_ADDONS[key]);

function getAddon(addonKey) {
    return EXTERNAL_ADDONS[addonKey] || null;
}

function getAddonGroup(addonKey) {
    return ADDON_GROUP_BY_KEY[addonKey] || 'external';
}

function isAddonInGroup(addonKey, group) {
    return getAddonGroup(addonKey) === group;
}

function getAddonEmoji(addonKey) {
    return ADDON_EMOJI_BY_GROUP[getAddonGroup(addonKey)] || '';
}

function isAddonConfigured(addonKey) {
    const addon = EXTERNAL_ADDONS[addonKey];
    return Boolean(addon && String(addon.baseUrl || '').trim());
}

function sortAddonKeys(addonKeys) {
    return [...new Set(addonKeys || [])]
        .filter((addonKey) => isAddonConfigured(addonKey))
        .sort((a, b) => EXTERNAL_ADDONS[a].priority - EXTERNAL_ADDONS[b].priority);
}

function splitRequestedAddons(enabledAddons = null) {
    const requested = Array.isArray(enabledAddons) && enabledAddons.length > 0
        ? enabledAddons.filter((addonKey) => EXTERNAL_ADDONS[addonKey])
        : Object.keys(EXTERNAL_ADDONS);

    const torrentio = sortAddonKeys(requested.filter((addonKey) => isAddonInGroup(addonKey, 'torrentio')));
    const mediafusion = sortAddonKeys(requested.filter((addonKey) => isAddonInGroup(addonKey, 'mediafusion')));

    return { requested: sortAddonKeys(requested), torrentio, mediafusion };
}

module.exports = {
    EXTERNAL_ADDONS,
    ADDON_GROUP_KEYS,
    TORRENTIO_ADDON_KEYS,
    MEDIAFUSION_ADDON_KEYS,
    getAddon,
    getAddonGroup,
    isAddonConfigured,
    isAddonInGroup,
    getAddonEmoji,
    sortAddonKeys,
    splitRequestedAddons
};
