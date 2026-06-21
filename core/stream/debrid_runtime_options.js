const { isTruthyConfigValue } = require('../config/config_flags');

const RD_DIRECT_RESOLVE_MAX_RESULTS = 32;
const RD_PLAYABLE_DEEP_DB_SCAN_MAX_RESULTS = 48;

function getNormalizedDebridService(configOrService) {
    const raw = typeof configOrService === 'object' && configOrService !== null
        ? configOrService.service
        : configOrService;
    const normalized = String(raw || '').toLowerCase();
    return normalized === 'rd' || normalized === 'tb' ? normalized : null;
}

function getConfiguredDebridKey(config, service = getNormalizedDebridService(config)) {
    if (service === 'tb') return config?.key || config?.tb || config?.torbox || config?.rd || null;
    if (service === 'rd') return config?.key || config?.rd || config?.realdebrid || null;
    return null;
}

function parseBoundedInt(value, fallback, min, max) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function shouldAllowRdLazyStreams(filters = {}) {
    return isTruthyConfigValue(filters.enableRdLazyStreams ?? process.env.RD_LAZY_STREAMS ?? 'false');
}

function shouldEnforceRdPlayableOnly(filters = {}) {
    const explicit = filters.rdPlayableOnly
        ?? filters.rdStrictPlayableOnly
        ?? process.env.RD_PLAYABLE_ONLY
        ?? process.env.RD_STRICT_PLAYABLE_ONLY;
    if (explicit === undefined || explicit === null || String(explicit).trim() === '') return true;
    return isTruthyConfigValue(explicit);
}

// When enabled (default) Real-Debrid trusts Torrentio's RD-cached assertion: candidates
// Torrentio flags as cached are shown directly (as lazy streams, resolved on click)
// without the per-hash RD recheck that can time out and collapse the list to a single
// result. Set RD_TRUST_TORRENTIO_CACHED=0 to restore the strict per-hash verification.
function shouldTrustTorrentioRdCached(filters = {}) {
    const explicit = filters.rdTrustTorrentioCached ?? process.env.RD_TRUST_TORRENTIO_CACHED;
    if (explicit === undefined || explicit === null || String(explicit).trim() === '') return true;
    return isTruthyConfigValue(explicit);
}

function getRdDirectResolveLimit(filters = {}, rankedCount = 0, maxResults = 12) {
    const hardMax = Math.max(1, Math.min(maxResults || 12, RD_DIRECT_RESOLVE_MAX_RESULTS));
    const configured = filters.rdDirectMaxResults ?? process.env.RD_DIRECT_MAX_RESULTS ?? RD_DIRECT_RESOLVE_MAX_RESULTS;
    return Math.min(Math.max(0, rankedCount), parseBoundedInt(configured, hardMax, 1, hardMax));
}

function getRdPlayableDeepDbScanLimit(filters = {}, rankedCount = 0, maxResults = 70) {
    const hardMax = Math.max(1, Math.min(maxResults || 70, RD_PLAYABLE_DEEP_DB_SCAN_MAX_RESULTS));
    const configured = filters.rdPlayableDeepDbScanMaxResults
        ?? filters.rdDeepDbScanMaxResults
        ?? process.env.RD_PLAYABLE_DEEP_DB_SCAN_MAX_RESULTS
        ?? process.env.RD_DEEP_DB_SCAN_MAX_RESULTS
        ?? RD_PLAYABLE_DEEP_DB_SCAN_MAX_RESULTS;
    return Math.min(Math.max(0, rankedCount), parseBoundedInt(configured, hardMax, 1, hardMax));
}

function shouldShowRdDownloadToDebrid(filters = {}) {
    const explicit = filters.allowRdDownloadToDebridRows ?? process.env.RD_ALLOW_DOWNLOAD_TO_DEBRID_ROWS;
    if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return isTruthyConfigValue(explicit);
    return false;
}

function shouldShowRdUnknownRows(filters = {}) {
    const explicit = filters.allowRdUnknownRows ?? process.env.RD_ALLOW_UNKNOWN_ROWS;
    if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return isTruthyConfigValue(explicit);
    return false;
}

function getRdVerifiedDbFallbackLimit(filters = {}, fallback = 12) {
    const hardMax = Math.max(1, Math.min(fallback || 12, 20));
    const configured = filters.rdVerifiedDbFallbackMaxResults ?? process.env.RD_VERIFIED_DB_FALLBACK_MAX_RESULTS ?? String(fallback || hardMax);
    return parseBoundedInt(configured, hardMax, 1, hardMax);
}

function getRdDownloadFallbackTarget(filters = {}, fallback = 12) {
    const hardMax = Math.max(1, Math.min(fallback || 12, 20));
    const configured = filters.rdDownloadFallbackMaxResults ?? process.env.RD_DOWNLOAD_FALLBACK_MAX_RESULTS ?? String(fallback || hardMax);
    return parseBoundedInt(configured, hardMax, 1, hardMax);
}

module.exports = {
    getConfiguredDebridKey,
    getNormalizedDebridService,
    getRdDirectResolveLimit,
    getRdDownloadFallbackTarget,
    getRdPlayableDeepDbScanLimit,
    getRdVerifiedDbFallbackLimit,
    parseBoundedInt,
    shouldAllowRdLazyStreams,
    shouldEnforceRdPlayableOnly,
    shouldTrustTorrentioRdCached,
    shouldShowRdDownloadToDebrid,
    shouldShowRdUnknownRows
};
