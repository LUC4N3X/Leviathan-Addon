const STREMIO_CACHE_MAX_AGE_DEFAULT = Math.max(60, parseInt(process.env.STREMIO_CACHE_MAX_AGE || '300', 10) || 300);
const STREMIO_STALE_REVALIDATE_DEFAULT = Math.max(STREMIO_CACHE_MAX_AGE_DEFAULT, parseInt(process.env.STREMIO_STALE_REVALIDATE || '600', 10) || 600);
const STREMIO_STALE_ERROR_DEFAULT = Math.max(STREMIO_STALE_REVALIDATE_DEFAULT, parseInt(process.env.STREMIO_STALE_ERROR || '1200', 10) || 1200);

function buildClientCacheMetadata(cachePolicy = {}, streamCount = 0) {
    const policyLocalTtl = Math.max(0, Number(cachePolicy?.localTtl || 0) || 0);
    const policyStaleGrace = Math.max(0, Number(cachePolicy?.staleGraceTtl || 0) || 0);
    const baseMaxAge = streamCount > 0
        ? Math.min(STREMIO_CACHE_MAX_AGE_DEFAULT, Math.max(120, policyLocalTtl || STREMIO_CACHE_MAX_AGE_DEFAULT))
        : Math.min(120, Math.max(30, Math.min(policyLocalTtl || 60, 120)));
    const staleRevalidate = Math.max(baseMaxAge, policyStaleGrace, streamCount > 0 ? STREMIO_STALE_REVALIDATE_DEFAULT : Math.max(60, Math.floor(STREMIO_STALE_REVALIDATE_DEFAULT / 2)));
    const staleError = Math.max(staleRevalidate, streamCount > 0 ? STREMIO_STALE_ERROR_DEFAULT : Math.max(120, Math.floor(STREMIO_STALE_ERROR_DEFAULT / 2)));

    return {
        cacheMaxAge: baseMaxAge,
        staleRevalidate,
        staleError
    };
}

module.exports = {
    buildClientCacheMetadata
};
