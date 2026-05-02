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

const MEDIAFUSION_POLICY = 'only_when_torrentio_zero_v3';

function shouldRunMediaFusion(realTorrentioCount) {
    return Number(realTorrentioCount || 0) <= 0;
}

async function fetchExternalAddon(addonKey, type, id, options = {}) {
    if (getAddonGroup(addonKey) === 'mediafusion') return fetchMediaFusionAddon(addonKey, type, id, options);
    return fetchTorrentioAddon(addonKey, type, id, options);
}

async function fetchAllExternalAddons(type, id, options = {}) {
    const { torrentio, mediafusion } = splitRequestedAddons(options.enabledAddons);
    const resultsByAddon = {};

    if (torrentio.length > 0) {
        const torrentioResults = await fetchTorrentioAddons(type, id, { ...options, enabledAddons: torrentio });
        Object.assign(resultsByAddon, torrentioResults);

        const torrentioFlat = dedupeNormalizedStreams(Object.values(torrentioResults).flat());
        const realTorrentioCount = countRealResults(torrentioFlat);

        if (!shouldRunMediaFusion(realTorrentioCount)) {
            infoLog(`[NEXUS-BRIDGE] policy=${MEDIAFUSION_POLICY} | Torrentio real=${realTorrentioCount} -> MediaFusion SKIP`);
            return resultsByAddon;
        }

        infoLog(`[NEXUS-BRIDGE] policy=${MEDIAFUSION_POLICY} | Torrentio real=0 -> MediaFusion RUN`);
    }

    if (mediafusion.length > 0) {
        const mediaFusionResults = await fetchMediaFusionAddons(type, id, { ...options, enabledAddons: mediafusion });
        Object.assign(resultsByAddon, mediaFusionResults);
    }

    return resultsByAddon;
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
    normalizeExternalStream,
    extractInfoHash,
    isItalianContent,
    analyzeItalianSignals
};
