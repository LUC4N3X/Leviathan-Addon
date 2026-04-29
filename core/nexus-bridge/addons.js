'use strict';

const EXTERNAL_ADDONS = {
    torrentio_main: {
        baseUrl: process.env.EXT_TORRENTIO_MAIN_URL || 'https://thorrentan.elninhostre.dpdns.org/e30',
        name: 'Torrentio Main',
        emoji: '🅣',
        group: 'torrentio',
        timeout: Number(process.env.EXT_TORRENTIO_MAIN_TIMEOUT || 2200),
        priority: 1,
        maxFailures: 3,
        cooldownMs: Number(process.env.EXT_ADDON_COOLDOWN_MS || 30000)
    },
    torrentio_mirror: {
        baseUrl: process.env.EXT_TORRENTIO_MIRROR_URL || 'https://torrentio.strem.fun',
        name: 'Torrentio Mirror',
        emoji: '🅣',
        group: 'torrentio',
        timeout: Number(process.env.EXT_TORRENTIO_MIRROR_TIMEOUT || 2200),
        priority: 2,
        maxFailures: 3,
        cooldownMs: Number(process.env.EXT_ADDON_COOLDOWN_MS || 30000),
        trustItalian: process.env.EXT_TORRENTIO_MIRROR_TRUST_ITA === 'true',
        trustDirectUrl: process.env.EXT_TORRENTIO_MIRROR_DIRECT !== 'false'
    },
    mediafusion: {
        baseUrl: process.env.EXT_MEDIAFUSION_URL || 'https://mediafusionfortheweebs.midnightignite.me/D-FCO8JXfrGOKFpP-Rim96nHZU9epOb5RPbSpgkgVbYoR1NRJNR1C-9X4VDrUSJJNEvp5pk7CGvSLN7cUHUrth3QG8e3mSPa8Ind2k4VzVGFEa-310EjXdsXT_uUXGri86EVnnQ6f_9b0yoVTuVu7Aqk4uY8IXZp47-0FmuxgXX6wleis_0Evllc0v2wcrWIj-D5m3IZhI18CKHr-pUL5h61ZWcaRuxGjgwYK88Xy3PIN2U3YzTi4J9pazQBpCNDH-NpZPwk2RVnjs0WF7dRU5XD_D0robmhH9q0edoqaR_71u1j2y-XnxkwPNjg-o5Yb_',
        name: 'MediaFusion',
        emoji: '🅜',
        group: 'mediafusion',
        timeout: Number(process.env.EXT_MEDIAFUSION_TIMEOUT || 3200),
        priority: 3,
        maxFailures: 4,
        cooldownMs: Number(process.env.EXT_ADDON_COOLDOWN_MS || 30000)
    }
};

const TORRENTIO_ADDON_KEYS = Object.keys(EXTERNAL_ADDONS).filter((key) => EXTERNAL_ADDONS[key].group === 'torrentio');
const MEDIAFUSION_ADDON_KEYS = Object.keys(EXTERNAL_ADDONS).filter((key) => EXTERNAL_ADDONS[key].group === 'mediafusion');

function getAddon(addonKey) {
    return EXTERNAL_ADDONS[addonKey] || null;
}

function sortAddonKeys(addonKeys) {
    return [...new Set(addonKeys || [])]
        .filter((addonKey) => EXTERNAL_ADDONS[addonKey])
        .sort((a, b) => EXTERNAL_ADDONS[a].priority - EXTERNAL_ADDONS[b].priority);
}

function splitRequestedAddons(enabledAddons = null) {
    const requested = Array.isArray(enabledAddons) && enabledAddons.length > 0
        ? enabledAddons.filter((addonKey) => EXTERNAL_ADDONS[addonKey])
        : Object.keys(EXTERNAL_ADDONS);

    const torrentio = sortAddonKeys(requested.filter((addonKey) => EXTERNAL_ADDONS[addonKey].group === 'torrentio'));
    const mediafusion = sortAddonKeys(requested.filter((addonKey) => EXTERNAL_ADDONS[addonKey].group === 'mediafusion'));

    return { requested: sortAddonKeys(requested), torrentio, mediafusion };
}

module.exports = {
    EXTERNAL_ADDONS,
    TORRENTIO_ADDON_KEYS,
    MEDIAFUSION_ADDON_KEYS,
    getAddon,
    sortAddonKeys,
    splitRequestedAddons
};
