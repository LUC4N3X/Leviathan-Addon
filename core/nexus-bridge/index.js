'use strict';

const { EXTERNAL_ADDONS, getAddonGroup, splitRequestedAddons } = require('./addons');
const {
    infoLog,
    debugLog,
    dedupeNormalizedStreams,
    countRealResults,
    normalizeExternalStream,
    extractInfoHash,
    isItalianContent,
    analyzeItalianSignals
} = require('./shared');
const { fetchTorrentioAddon, fetchTorrentioAddons, fetchTorrentioFlat } = require('./torrentio');
const { fetchMediaFusionAddon, fetchMediaFusionAddons, fetchMediaFusionFlat } = require('./mediafusion');
const { fetchMeteorAddon, fetchMeteorAddons, fetchMeteorFlat } = require('./meteor');
const { fetchWithFallbackPolicy } = require('./wrapper_engine');

async function fetchExternalAddon(addonKey, type, id, options = {}) {
    if (getAddonGroup(addonKey) === 'mediafusion') return fetchMediaFusionAddon(addonKey, type, id, options);
    if (getAddonGroup(addonKey) === 'meteor') return fetchMeteorAddon(addonKey, type, id, options);
    return fetchTorrentioAddon(addonKey, type, id, options);
}

async function fetchAllExternalAddons(type, id, options = {}) {
    const groups = splitRequestedAddons(options.enabledAddons);
    return fetchWithFallbackPolicy({
        type,
        id,
        options,
        groups,
        fetchers: {
            fetchTorrentioAddons,
            fetchMediaFusionAddons,
            fetchMeteorAddons
        },
        helpers: {
            infoLog,
            countRealResults,
            dedupeNormalizedStreams
        }
    });
}

async function fetchExternalAddonsFlat(type, id, options = {}) {
    const resultsByAddon = await fetchAllExternalAddons(type, id, options);
    const flattened = Object.values(resultsByAddon).flat();
    return dedupeNormalizedStreams(flattened);
}

module.exports = {
    EXTERNAL_ADDONS,
    fetchExternalAddon,
    fetchAllExternalAddons,
    fetchExternalAddonsFlat,
    fetchTorrentioAddon,
    fetchTorrentioAddons,
    fetchTorrentioFlat,
    fetchMediaFusionAddon,
    fetchMediaFusionAddons,
    fetchMediaFusionFlat,
    fetchMeteorAddon,
    fetchMeteorAddons,
    fetchMeteorFlat,
    normalizeExternalStream,
    extractInfoHash,
    isItalianContent,
    analyzeItalianSignals
};
