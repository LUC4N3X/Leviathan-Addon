'use strict';

const { TORRENTIO_ADDON_KEYS, sortAddonKeys } = require('./addons');
const { infoLog, debugLog, dedupeNormalizedStreams, countRealResults, fetchConfiguredExternalAddon } = require('./shared');

const MIRROR_FIRST_ON_HIT = process.env.EXT_TORRENTIO_MIRROR_FIRST_ON_HIT !== 'false';

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

    infoLog(`[TORRENTIO] Fetch addons=${addonKeys.join(',')}`);

    const settled = await Promise.allSettled(
        addonKeys.map(async (addonKey) => ({ addonKey, results: await fetchTorrentioAddon(addonKey, type, id, options) }))
    );

    const resultsByAddon = {};
    for (const item of settled) {
        if (item.status === 'fulfilled') resultsByAddon[item.value.addonKey] = item.value.results;
        else infoLog(`[TORRENTIO] Promise rejected: ${item.reason?.message || item.reason}`);
    }

    const mirrorResults = Array.isArray(resultsByAddon.torrentio_mirror) ? resultsByAddon.torrentio_mirror : [];
    const mirrorReal = countRealResults(mirrorResults);
    if (MIRROR_FIRST_ON_HIT && mirrorReal > 0) {
        infoLog(`[TORRENTIO] Mirror ITA hit=${mirrorReal} -> using torrentio_mirror only`);
        return { torrentio_mirror: mirrorResults };
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
