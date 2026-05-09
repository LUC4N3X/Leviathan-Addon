'use strict';

/**
 * Nexus Bridge 2.0: one policy engine for external Stremio addons.
 * Important rule preserved for Leviathan: MediaFusion is a fallback, never a parallel primary.
 */
async function fetchAddonGroupSafely({ groupName, addonKeys, fetchGroup, type, id, options, infoLog, countRealResults, dedupeNormalizedStreams }) {
    if (!Array.isArray(addonKeys) || addonKeys.length === 0 || typeof fetchGroup !== 'function') return { resultsByAddon: {}, flat: [], real: 0 };

    const resultsByAddon = await fetchGroup(type, id, { ...options, enabledAddons: addonKeys });
    const flat = dedupeNormalizedStreams(Object.values(resultsByAddon || {}).flat());
    const real = countRealResults(flat);
    try { infoLog?.(`[NEXUS-BRIDGE:V2] group=${groupName} addons=${addonKeys.join(',')} real=${real} raw=${flat.length}`); } catch (_) {}
    return { resultsByAddon: resultsByAddon || {}, flat, real };
}

async function fetchWithFallbackPolicy({
    type,
    id,
    options = {},
    groups = {},
    fetchers = {},
    helpers = {}
}) {
    const {
        torrentio = [],
        mediafusion = [],
        meteor = []
    } = groups;
    const {
        fetchTorrentioAddons,
        fetchMediaFusionAddons,
        fetchMeteorAddons
    } = fetchers;
    const {
        infoLog = () => {},
        countRealResults = (items) => Array.isArray(items) ? items.length : 0,
        dedupeNormalizedStreams = (items) => Array.isArray(items) ? items : []
    } = helpers;

    const resultsByAddon = {};
    const policy = 'torrentio_first_mediafusion_only_when_zero_meteor_last_v2';

    const torrentioRun = await fetchAddonGroupSafely({
        groupName: 'torrentio',
        addonKeys: torrentio,
        fetchGroup: fetchTorrentioAddons,
        type,
        id,
        options,
        infoLog,
        countRealResults,
        dedupeNormalizedStreams
    });
    Object.assign(resultsByAddon, torrentioRun.resultsByAddon);

    if (torrentioRun.real > 0) {
        infoLog(`[NEXUS-BRIDGE:V2] policy=${policy} | Torrentio real=${torrentioRun.real} -> MediaFusion SKIP`);
        return resultsByAddon;
    }

    if (mediafusion.length > 0) {
        infoLog(`[NEXUS-BRIDGE:V2] policy=${policy} | Torrentio real=0 -> MediaFusion RUN`);
        const mediaFusionRun = await fetchAddonGroupSafely({
            groupName: 'mediafusion',
            addonKeys: mediafusion,
            fetchGroup: fetchMediaFusionAddons,
            type,
            id,
            options,
            infoLog,
            countRealResults,
            dedupeNormalizedStreams
        });
        Object.assign(resultsByAddon, mediaFusionRun.resultsByAddon);

        if (mediaFusionRun.real > 0) {
            infoLog(`[NEXUS-BRIDGE:V2] policy=${policy} | MediaFusion real=${mediaFusionRun.real} -> Meteor SKIP`);
            return resultsByAddon;
        }
    } else {
        infoLog(`[NEXUS-BRIDGE:V2] policy=${policy} | MediaFusion disabled/not requested`);
    }

    if (meteor.length > 0) {
        infoLog(`[NEXUS-BRIDGE:V2] policy=${policy} | no Torrentio/MediaFusion real results -> Meteor RUN`);
        const meteorRun = await fetchAddonGroupSafely({
            groupName: 'meteor',
            addonKeys: meteor,
            fetchGroup: fetchMeteorAddons,
            type,
            id,
            options,
            infoLog,
            countRealResults,
            dedupeNormalizedStreams
        });
        Object.assign(resultsByAddon, meteorRun.resultsByAddon);
    }

    return resultsByAddon;
}

module.exports = {
    fetchWithFallbackPolicy
};
