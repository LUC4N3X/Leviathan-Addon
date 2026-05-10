'use strict';

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DEFAULT_TTLS = Object.freeze({
    probing: 2 * MINUTE,
    transientUnknown: 30 * MINUTE,
    rdLikelyCached: 24 * HOUR,
    rdCachedWeak: 24 * HOUR,
    rdCachedExact: 7 * DAY,
    rdUncachedTerminal: 24 * HOUR,
    tbLikelyCached: 30 * MINUTE,
    tbLiveCached: 6 * HOUR,
    tbSavedCloud: 6 * HOUR,
    tbUncachedTerminal: 6 * HOUR
});

function normalizeService(service) {
    const value = String(service || 'rd').trim().toLowerCase();
    if (['torbox', 'tb'].includes(value)) return 'tb';
    return value || 'rd';
}

function normalizeState(state, cached) {
    const raw = String(state || '').trim().toLowerCase();
    if (raw) return raw;
    if (cached === true) return 'cached';
    if (cached === false) return 'uncached_terminal';
    return 'unknown';
}

function hasStrongProof(proofLevel) {
    return /^(?:episode_file|file|direct_resolve|saved_cloud|exact)$/i.test(String(proofLevel || '').trim());
}

function getAvailabilityCacheTtlSeconds(input = {}) {
    const service = normalizeService(input.service);
    const state = normalizeState(input.state, input.cached);
    const savedCloud = input.savedCloud === true || input.isSavedCloud === true;
    const liveChecked = input.liveChecked === true || input.live === true || input.source === 'live';
    const proofLevel = input.proofLevel || input.proof || input.reason;

    if (state === 'probing') return DEFAULT_TTLS.probing;

    if (service === 'tb') {
        if (savedCloud) return DEFAULT_TTLS.tbSavedCloud;
        if (state === 'cached') return liveChecked ? DEFAULT_TTLS.tbLiveCached : DEFAULT_TTLS.tbLikelyCached;
        if (state === 'likely_cached') return DEFAULT_TTLS.tbLikelyCached;
        if (state === 'uncached_terminal' || state === 'uncached' || state === 'likely_uncached') return DEFAULT_TTLS.tbUncachedTerminal;
        return DEFAULT_TTLS.transientUnknown;
    }

    if (state === 'cached') return hasStrongProof(proofLevel) ? DEFAULT_TTLS.rdCachedExact : DEFAULT_TTLS.rdCachedWeak;
    if (state === 'likely_cached') return DEFAULT_TTLS.rdLikelyCached;
    if (state === 'uncached_terminal' || state === 'uncached' || state === 'likely_uncached') return DEFAULT_TTLS.rdUncachedTerminal;
    return DEFAULT_TTLS.transientUnknown;
}

function getDebridRecheckHours(input = {}) {
    const ttl = getAvailabilityCacheTtlSeconds(input);
    return Math.max(1, Math.ceil(ttl / HOUR));
}

function describeAvailabilityInvalidation(input = {}) {
    const service = normalizeService(input.service);
    const state = normalizeState(input.state, input.cached);
    const ttlSeconds = getAvailabilityCacheTtlSeconds(input);
    const reason = service === 'tb'
        ? (state === 'cached' && !(input.liveChecked || input.savedCloud || input.isSavedCloud) ? 'torbox_cache_is_hint_until_live_check' : 'torbox_short_live_cache')
        : (state === 'cached' ? 'rd_file_level_cache_authority' : 'rd_negative_or_transient_recheck');
    return { service, state, ttlSeconds, recheckHours: getDebridRecheckHours(input), reason };
}

module.exports = {
    DEFAULT_TTLS,
    describeAvailabilityInvalidation,
    getAvailabilityCacheTtlSeconds,
    getDebridRecheckHours,
    normalizeService
};
