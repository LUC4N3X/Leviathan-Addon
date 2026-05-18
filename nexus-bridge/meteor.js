'use strict';

const { METEOR_ADDON_KEYS, sortAddonKeys } = require('./addons');
const {
    infoLog,
    dedupeNormalizedStreams,
    extractInfoHash,
    fetchConfiguredExternalAddon
} = require('./shared');

const METEOR_SUPPLEMENT_LIMIT = Math.max(1, Math.min(2, Number(process.env.METEOR_SUPPLEMENT_LIMIT || 2) || 2));

function resolveMeteorKeys(enabledAddons = null) {
    const requested = Array.isArray(enabledAddons) && enabledAddons.length > 0
        ? enabledAddons.filter((addonKey) => METEOR_ADDON_KEYS.includes(addonKey))
        : METEOR_ADDON_KEYS;
    return sortAddonKeys(requested);
}

function markMeteorCachedFromTrustedSource(stream) {
    const hash = extractInfoHash(stream);
    if (!hash) return null;

    return {
        ...stream,
        infoHash: stream.infoHash || hash,
        isCached: true,
        cacheState: 'cached',
        rdCacheState: 'cached',
        cached_rd: true,
        _dbCachedRd: true,
        _meteorCachedOnlyTrust: true,
        _meteorTrustedCacheMode: true,
        _externalRdChecked: true,
        _nexusBridgeRdChecked: true
    };
}

function scoreMeteorSupplement(stream) {
    let score = Number(stream?._score || 0);
    const quality = String(stream?.quality || stream?.title || '').toLowerCase();
    const title = String(stream?.title || stream?.filename || stream?.websiteTitle || '').toLowerCase();

    if (/2160p|4k|uhd/.test(quality) || /2160p|4k|uhd/.test(title)) score += 40;
    else if (/1080p/.test(quality) || /1080p/.test(title)) score += 30;
    else if (/720p/.test(quality) || /720p/.test(title)) score += 20;

    if (stream?.potentialPack || stream?.packTitle) score += 8;
    if (stream?.isItalian || stream?.hasItalianAudio) score += 10;
    if (Number(stream?.seeders || 0) > 0) score += Math.min(12, Number(stream.seeders || 0));
    if (Number(stream?.mainFileSize || 0) > 0) score += 2;
    return score;
}

function limitMeteorSupplement(streams, limit = METEOR_SUPPLEMENT_LIMIT) {
    const items = dedupeNormalizedStreams(Array.isArray(streams) ? streams : [])
        .map(markMeteorCachedFromTrustedSource)
        .filter(Boolean)
        .sort((a, b) => scoreMeteorSupplement(b) - scoreMeteorSupplement(a));

    return items.slice(0, Math.max(1, Math.min(2, Number(limit || METEOR_SUPPLEMENT_LIMIT) || METEOR_SUPPLEMENT_LIMIT)));
}

async function fetchMeteorAddon(addonKey, type, id, options = {}) {
    // Meteor-only trusted cache mode:
    // the Meteor URL itself is configured with cachedOnly=true, so we trust that upstream filter
    // and mark returned infoHash streams as RD-cached without doing Leviathan's live RD probe.
    const raw = await fetchConfiguredExternalAddon(addonKey, type, id, {
        ...options,
        requireRdCached: true
    });

    const limited = limitMeteorSupplement(raw, options.meteorLimit || METEOR_SUPPLEMENT_LIMIT);
    infoLog(`[METEOR] cachedOnly trust ${Array.isArray(raw) ? raw.length : 0} -> ${limited.length}`);
    return limited;
}

async function fetchMeteorAddons(type, id, options = {}) {
    const addonKeys = resolveMeteorKeys(options.enabledAddons);
    if (addonKeys.length === 0) return {};

    infoLog(`[METEOR] Supplement active addons=${addonKeys.join(',')} limit=${Math.max(1, Math.min(2, Number(options.meteorLimit || METEOR_SUPPLEMENT_LIMIT) || METEOR_SUPPLEMENT_LIMIT))}`);

    const settled = await Promise.allSettled(
        addonKeys.map(async (addonKey) => ({ addonKey, results: await fetchMeteorAddon(addonKey, type, id, options) }))
    );

    const resultsByAddon = {};
    for (const item of settled) {
        if (item.status === 'fulfilled') resultsByAddon[item.value.addonKey] = item.value.results;
        else infoLog(`[METEOR] Promise rejected: ${item.reason?.message || item.reason}`);
    }

    return resultsByAddon;
}

async function fetchMeteorFlat(type, id, options = {}) {
    const resultsByAddon = await fetchMeteorAddons(type, id, options);
    return limitMeteorSupplement(Object.values(resultsByAddon).flat(), options.meteorLimit || METEOR_SUPPLEMENT_LIMIT);
}

module.exports = {
    resolveMeteorKeys,
    markMeteorCachedFromTrustedSource,
    limitMeteorSupplement,
    fetchMeteorAddon,
    fetchMeteorAddons,
    fetchMeteorFlat
};
