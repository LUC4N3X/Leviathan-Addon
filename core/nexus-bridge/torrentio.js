'use strict';

const { TORRENTIO_ADDON_KEYS, sortAddonKeys } = require('./addons');
const { infoLog, dedupeNormalizedStreams, countRealResults, fetchConfiguredExternalAddon } = require('./shared');

const TORRENTIO_MAIN_KEY = 'torrentio_main';
const TORRENTIO_MAIN_STOP_MIN = 3;
const TORRENTIO_TOTAL_STOP_MIN = 5;

function resolveTorrentioKeys(enabledAddons = null) {
    const requested = Array.isArray(enabledAddons) && enabledAddons.length > 0
        ? enabledAddons.filter((addonKey) => TORRENTIO_ADDON_KEYS.includes(addonKey))
        : TORRENTIO_ADDON_KEYS;
    return sortAddonKeys(requested);
}

async function fetchTorrentioAddon(addonKey, type, id, options = {}) {
    return fetchConfiguredExternalAddon(addonKey, type, id, {
        ...options,
        requireRdCached: false
    });
}

async function fetchTorrentioAddons(type, id, options = {}) {
    const addonKeys = resolveTorrentioKeys(options.enabledAddons);
    if (addonKeys.length === 0) return {};

    const primaryKeys = addonKeys.includes(TORRENTIO_MAIN_KEY) ? [TORRENTIO_MAIN_KEY] : [];
    const fallbackKeys = addonKeys.filter((addonKey) => addonKey !== TORRENTIO_MAIN_KEY);
    const orderedKeys = [...primaryKeys, ...fallbackKeys];

    infoLog(`[TORRENTIO] Main-first fetch addons=${orderedKeys.join(',')}`);

    const resultsByAddon = {};
    for (const addonKey of orderedKeys) {
        try {
            const results = await fetchTorrentioAddon(addonKey, type, id, options);
            resultsByAddon[addonKey] = Array.isArray(results) ? results : [];
            const real = countRealResults(resultsByAddon[addonKey]);

            if (addonKey === TORRENTIO_MAIN_KEY) {
                if (real >= TORRENTIO_MAIN_STOP_MIN) {
                    infoLog(`[TORRENTIO] Main hit=${real} >= ${TORRENTIO_MAIN_STOP_MIN} -> stop, mirror/mediafusion not needed`);
                    return { [addonKey]: resultsByAddon[addonKey] };
                }
                infoLog(`[TORRENTIO] Main hit=${real} < ${TORRENTIO_MAIN_STOP_MIN} -> mirror fallback allowed`);
                continue;
            }

            if (addonKey !== TORRENTIO_MAIN_KEY && real > 0) {
                const flatNow = dedupeNormalizedStreams(Object.values(resultsByAddon).flat());
                const totalReal = countRealResults(flatNow);
                const decision = totalReal >= TORRENTIO_TOTAL_STOP_MIN ? 'strong enough' : 'scarce but no more Torrentio fallback';
                infoLog(`[TORRENTIO] Fallback ${addonKey} hit=${real} total=${totalReal}/${TORRENTIO_TOTAL_STOP_MIN} -> ${decision}`);
                return resultsByAddon;
            }

            infoLog(`[TORRENTIO] ${addonKey} real=0 -> next fallback`);
        } catch (error) {
            infoLog(`[TORRENTIO] ${addonKey} rejected: ${error?.message || error}`);
            resultsByAddon[addonKey] = [];
        }
    }

    const flat = dedupeNormalizedStreams(Object.values(resultsByAddon).flat());
    infoLog(`[TORRENTIO] Real results=${countRealResults(flat)}`);
    return resultsByAddon;
}

async function fetchTorrentioFlat(type, id, options = {}) {
    const resultsByAddon = await fetchTorrentioAddons(type, id, options);
    return dedupeNormalizedStreams(Object.values(resultsByAddon).flat());
}

module.exports = {
    resolveTorrentioKeys,
    fetchTorrentioAddon,
    fetchTorrentioAddons,
    fetchTorrentioFlat
};
