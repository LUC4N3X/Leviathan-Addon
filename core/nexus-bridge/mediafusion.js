'use strict';

const RealDebridProbe = require('../debrid/probe/realdebrid_probe');
const { MEDIAFUSION_ADDON_KEYS, sortAddonKeys } = require('./addons');
const {
    infoLog,
    debugLog,
    dedupeNormalizedStreams,
    extractInfoHash,
    getRealDebridToken,
    fetchConfiguredExternalAddon
} = require('./shared');

const MEDIAFUSION_RD_BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.MEDIAFUSION_RD_BATCH_SIZE || 80) || 80));

function resolveMediaFusionKeys(enabledAddons = null) {
    const requested = Array.isArray(enabledAddons) && enabledAddons.length > 0
        ? enabledAddons.filter((addonKey) => MEDIAFUSION_ADDON_KEYS.includes(addonKey))
        : MEDIAFUSION_ADDON_KEYS;
    return sortAddonKeys(requested);
}

function normalizeHash(hash) {
    return String(hash || '').trim().toLowerCase();
}

function hasRdCachedPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;

    const rd = payload.rd || payload.RD || payload.realDebrid || payload.realdebrid;
    if (Array.isArray(rd)) return rd.some((entry) => entry && typeof entry === 'object' && Object.keys(entry).length > 0);
    if (rd && typeof rd === 'object') return Object.keys(rd).length > 0;

    return Object.values(payload).some((value) => {
        if (Array.isArray(value)) return value.some((entry) => entry && typeof entry === 'object' && Object.keys(entry).length > 0);
        if (value && typeof value === 'object') return hasRdCachedPayload(value);
        return false;
    });
}

function isHashCachedInAvailability(availability, hash) {
    const normalized = normalizeHash(hash);
    if (!normalized || !availability || typeof availability !== 'object') return false;
    const direct = availability[normalized] || availability[normalized.toUpperCase()] || availability[normalized.toLowerCase()];
    return hasRdCachedPayload(direct);
}

function buildProbeMagnet(item, hash) {
    const existing = item?.magnetLink || item?.magnet || item?.behaviorHints?.magnet || null;
    if (existing && /^magnet:/i.test(String(existing))) return String(existing);
    const title = item?.title || item?.filename || item?.websiteTitle || hash;
    return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(String(title || hash))}`;
}

function parseEpisodeContextFromId(id) {
    const match = String(id || '').match(/^(?:[^:]+):(\d{1,3}):(\d{1,4})$/);
    if (!match) return null;
    const season = Number(match[1]);
    const episode = Number(match[2]);
    return Number.isFinite(season) && season > 0 && Number.isFinite(episode) && episode > 0
        ? { season, episode, _probeSeason: season, _probeEpisode: episode }
        : null;
}

async function fetchRdAvailabilityMap(token, streams, episodeContext = null) {
    const probeItems = [];
    const seen = new Set();

    for (const item of Array.isArray(streams) ? streams : []) {
        const hash = normalizeHash(extractInfoHash(item));
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        probeItems.push({
            hash,
            magnet: buildProbeMagnet(item, hash),
            title: item?.title || item?.filename || item?.websiteTitle || '',
            fileIdx: item?.fileIdx,
            ...(episodeContext || {})
        });
    }

    if (!token || probeItems.length === 0) return {};

    const merged = {};
    for (let i = 0; i < probeItems.length; i += MEDIAFUSION_RD_BATCH_SIZE) {
        const batch = probeItems.slice(i, i + MEDIAFUSION_RD_BATCH_SIZE);
        const { results = {}, deferred = [] } = await RealDebridProbe.probeAvailabilityFast(batch, token, batch.length);
        for (const item of batch) {
            const hash = normalizeHash(item.hash);
            const result = results[hash];
            merged[hash] = result || { cached: false };
        }
        for (const item of deferred || []) {
            const hash = normalizeHash(item?.hash);
            if (hash && merged[hash] === undefined) merged[hash] = { cached: false, state: 'probing' };
        }
    }
    return merged;
}

async function filterMediaFusionByRealDebridCache(streams, options = {}) {
    const items = dedupeNormalizedStreams(Array.isArray(streams) ? streams : []);
    if (items.length === 0) return [];

    const rdToken = getRealDebridToken(options.userConfig || {});
    if (!rdToken) {
        infoLog('[MEDIAFUSION] Skip: RD token assente, fallback non verificabile');
        return [];
    }

    const hashes = items.map((item) => extractInfoHash(item)).filter(Boolean);
    if (hashes.length === 0) return [];

    try {
        const episodeContext = parseEpisodeContextFromId(options.id || options.requestId || '');
        const availabilityByHash = await fetchRdAvailabilityMap(rdToken, items, episodeContext);
        const cachedOnly = items
            .filter((item) => availabilityByHash[normalizeHash(extractInfoHash(item))]?.cached === true)
            .map((item) => {
                const probe = availabilityByHash[normalizeHash(extractInfoHash(item))] || {};
                const resolvedFileIdx = Number.isInteger(Number(probe.file_index)) && Number(probe.file_index) >= 0
                    ? Number(probe.file_index)
                    : item.fileIdx;
                return {
                    ...item,
                    fileIdx: resolvedFileIdx,
                    folderSize: probe.size || probe.folderSize || item.folderSize || undefined,
                    episodeFileHint: probe.episodeFileHint || item.episodeFileHint || null,
                    _episodeFileHint: probe.episodeFileHint || item._episodeFileHint || null,
                    _packValidated: probe.episodeFileHint ? true : item._packValidated,
                    isCached: true,
                    cacheState: 'cached',
                    rdCacheState: 'cached',
                    _dbCachedRd: true,
                    cached_rd: true,
                    _mediafusionRdChecked: true,
                    _nexusBridgeRdChecked: true,
                    _externalRdChecked: true
                };
            });

        infoLog(`[MEDIAFUSION] RD cached filter ${items.length} -> ${cachedOnly.length}`);
        return dedupeNormalizedStreams(cachedOnly);
    } catch (error) {
        infoLog(`[MEDIAFUSION] RD check failed: ${error?.message || error}`);
        return [];
    }
}

async function fetchMediaFusionAddon(addonKey, type, id, options = {}) {
    const raw = await fetchConfiguredExternalAddon(addonKey, type, id, {
        ...options,
        requireRdCached: true
    });
    return filterMediaFusionByRealDebridCache(raw, { ...options, type, id, requestId: id });
}

async function fetchMediaFusionAddons(type, id, options = {}) {
    const addonKeys = resolveMediaFusionKeys(options.enabledAddons);
    if (addonKeys.length === 0) return {};

    infoLog(`[MEDIAFUSION] Fallback active addons=${addonKeys.join(',')}`);

    const settled = await Promise.allSettled(
        addonKeys.map(async (addonKey) => ({ addonKey, results: await fetchMediaFusionAddon(addonKey, type, id, options) }))
    );

    const resultsByAddon = {};
    for (const item of settled) {
        if (item.status === 'fulfilled') resultsByAddon[item.value.addonKey] = item.value.results;
        else infoLog(`[MEDIAFUSION] Promise rejected: ${item.reason?.message || item.reason}`);
    }

    return resultsByAddon;
}

async function fetchMediaFusionFlat(type, id, options = {}) {
    const resultsByAddon = await fetchMediaFusionAddons(type, id, options);
    return dedupeNormalizedStreams(Object.values(resultsByAddon).flat());
}

module.exports = {
    resolveMediaFusionKeys,
    hasRdCachedPayload,
    filterMediaFusionByRealDebridCache,
    fetchMediaFusionAddon,
    fetchMediaFusionAddons,
    fetchMediaFusionFlat
};
