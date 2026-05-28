require('./http');

const runtimeState = require('../runtime_state');
const {
    logger,
    runtimeMetrics,
    incrementMetric,
    recordDuration,
    recordProviderMetric,
    getCacheSnapshot
} = require('./runtime');
const { safeCompare, withSharedPromise } = require('./common');
const { TRACKERS, base32ToHex, buildTrackerMagnet, extractInfoHash } = require('./torrent');
const {
    Cache,
    myCache,
    rawCache,
    cloudBuildCache,
    cloudBuildInflight,
    sharedFetchInflight,
    streamInflight,
    metadataInflight,
    EMPTY_STREAM_TTL,
    METADATA_CACHE_TTL
} = require('./cache');
const {
    ADMIN_PASS,
    MAX_CONFIG_LENGTH,
    decodeConfigBase64,
    getConfig
} = require('./config');
const {
    REGEX_YEAR,
    REGEX_QUALITY_FILTER,
    REGEX_STRONG_ITA,
    REGEX_CONTEXT_IT,
    REGEX_ISOLATED_IT,
    REGEX_DOMAIN_IT,
    REGEX_MULTI_ITA,
    REGEX_TRUSTED_GROUPS,
    REGEX_FALSE_IT,
    REGEX_SUB_ONLY,
    REGEX_AUDIO_CONFIRM,
    languageMapping,
    normalizeLanguageName,
    stripFalseItalianDomainTokens,
    parseTitleDetails,
    stripVisualPrefixes,
    normalizeSearchText,
    isItalianByTitleMatch,
    isTrustedSource,
    getLanguageInfo,
    formatLanguageLabel,
    isSeasonPack,
    isGoodShortQueryMatch,
    chooseBestPackTitle,
    shouldUpdatePackTitle
} = require('./text');
const { LIMITERS, getLimiterStats } = require('./limits');
const { estimateVisualSize, estimateSeeders } = require('./media_estimates');
const { extractSeasonEpisodeFromFilename } = require('./episode_parser');
const { extractProvider, extractSeeders, extractSize, parseSize } = require('./result_parsing');
const { deduplicateResults, filterByQualityLimit, isSafeForItalian } = require('./result_dedupe');
const { validateStreamRequest, withTimeout } = require('./stream_request');
const sourceHealth = require('../lib/source_health');

const CONFIG = {
    INDEXER_URL: process.env.INDEXER_URL || '',
    CINEMETA_URL: 'https://v3-cinemeta.strem.io',
    KITSU_URL: 'https://anime-kitsu.strem.fun',
    REAL_SIZE_FILTER: 80 * 1024 * 1024,
    MAX_RESULTS: 70,
    TIMEOUTS: {
        TMDB: 2000,
        SCRAPER: 4000,
        REMOTE_INDEXER: 1500,
        LOCAL_DB: 1500,
        DB_QUERY: 2000,
        DEBRID: 8000,
        PACK_RESOLVER: 3000,
        EXTERNAL: 8000
    }
};

function getStatsSnapshot() {
    const runtime = runtimeState.getSnapshot();
    return {
        status: runtime?.lifecycle?.draining ? 'draining' : 'ok',
        startedAt: new Date(runtimeMetrics.startedAt).toISOString(),
        uptimeSec: Math.round((Date.now() - runtimeMetrics.startedAt) / 1000),
        inflight: {
            sharedFetch: sharedFetchInflight.size,
            streams: streamInflight.size,
            metadata: metadataInflight.size,
            cloudBuild: cloudBuildInflight.size
        },
        cache: {
            stream: getCacheSnapshot(runtimeMetrics.cache.stream),
            metadata: getCacheSnapshot(runtimeMetrics.cache.metadata),
            lazy: getCacheSnapshot(runtimeMetrics.cache.lazy),
            cloud: getCacheSnapshot(runtimeMetrics.cache.cloud),
            raw: getCacheSnapshot(runtimeMetrics.cache.raw),
            dbLookup: getCacheSnapshot(runtimeMetrics.cache.dbLookup),
            streamIndex: Cache.getStreamCacheIndexStats(),
            keys: {
                user: myCache.keys().length,
                raw: rawCache.keys().length,
                cloud: cloudBuildCache.keys().length
            }
        },
        counters: runtimeMetrics.counters,
        timers: runtimeMetrics.timers,
        providers: runtimeMetrics.providers,
        sourceHealth: sourceHealth.getSnapshot(),
        limiters: getLimiterStats(),
        runtime
    };
}

module.exports = {
    logger,
    Cache,
    LIMITERS,
    CONFIG,
    ADMIN_PASS,
    MAX_CONFIG_LENGTH,
    EMPTY_STREAM_TTL,
    METADATA_CACHE_TTL,
    streamInflight,
    metadataInflight,
    cloudBuildInflight,
    REGEX_YEAR,
    REGEX_QUALITY_FILTER,
    REGEX_STRONG_ITA,
    REGEX_CONTEXT_IT,
    REGEX_ISOLATED_IT,
    REGEX_DOMAIN_IT,
    REGEX_MULTI_ITA,
    REGEX_TRUSTED_GROUPS,
    REGEX_FALSE_IT,
    REGEX_SUB_ONLY,
    REGEX_AUDIO_CONFIRM,
    languageMapping,
    normalizeLanguageName,
    stripFalseItalianDomainTokens,
    parseTitleDetails,
    stripVisualPrefixes,
    normalizeSearchText,
    isItalianByTitleMatch,
    isTrustedSource,
    getLanguageInfo,
    formatLanguageLabel,
    isSeasonPack,
    isGoodShortQueryMatch,
    chooseBestPackTitle,
    shouldUpdatePackTitle,
    base32ToHex,
    extractInfoHash,
    estimateVisualSize,
    estimateSeeders,
    extractSeasonEpisodeFromFilename,
    parseSize,
    extractSeeders,
    extractSize,
    extractProvider,
    deduplicateResults,
    filterByQualityLimit,
    isSafeForItalian,
    validateStreamRequest,
    withTimeout,
    safeCompare,
    withSharedPromise,
    decodeConfigBase64,
    getConfig,
    TRACKERS,
    buildTrackerMagnet,
    incrementMetric,
    recordDuration,
    recordProviderMetric,
    getStatsSnapshot
};
