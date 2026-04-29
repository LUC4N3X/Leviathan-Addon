"use strict";

const crypto = require("crypto");

const aioFormatter = require("../../lib/pulse_formatter.cjs");
const TbCache = require("../../../debrid/tb_cache.js");
const RD = require("../../../debrid/realdebrid");
const TB = require("../../../debrid/torbox");
const dbHelper = require("../../storage/db_repository");
const sourceHealth = require("../../lib/source_health");
const {
  logger, LIMITERS, CONFIG, REGEX_QUALITY_FILTER, REGEX_SUB_ONLY, REGEX_AUDIO_CONFIRM, REGEX_YEAR,
  getLanguageInfo, parseTitleDetails, formatLanguageLabel, isSeasonPack, isGoodShortQueryMatch, chooseBestPackTitle, shouldUpdatePackTitle,
  extractSeasonEpisodeFromFilename, deduplicateResults, withSharedPromise, normalizeSearchText,
  extractSeeders, extractSize, extractInfoHash, recordDuration, recordProviderMetric
} = require("../../utils");
const { formatStreamSelector, formatBytes } = require("../../lib/stream_formatter");
const { applyTorrentResultFilters } = require("../../lib/torrent_result_filters");
const { resolveLanguageMode, shouldIgnoreAnimeSeason, hasExplicitSeasonMarker } = require("../../canonical/title_language_rules");
const { smartMatch } = require("../../media_intelligence");

function parsePositiveEnvInt(name, fallback, min = 0) {
    const parsed = parseInt(process.env[name] || '', 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

const STREMIO_CACHE_MAX_AGE_HAS_STREAMS = parsePositiveEnvInt(
    'STREMIO_CACHE_MAX_AGE_HAS_STREAMS',
    parsePositiveEnvInt('STREMIO_CACHE_MAX_AGE', 14400, 0),
    0
);
const STREMIO_CACHE_MAX_AGE_EMPTY = parsePositiveEnvInt('STREMIO_CACHE_MAX_AGE_EMPTY', 300, 0);
const STREMIO_STALE_REVALIDATE_HAS_STREAMS = Math.max(
    STREMIO_CACHE_MAX_AGE_HAS_STREAMS,
    parsePositiveEnvInt('STREMIO_STALE_REVALIDATE_HAS_STREAMS', parsePositiveEnvInt('STREMIO_STALE_REVALIDATE', 14400, 0), 0)
);
const STREMIO_STALE_REVALIDATE_EMPTY = Math.max(
    STREMIO_CACHE_MAX_AGE_EMPTY,
    parsePositiveEnvInt('STREMIO_STALE_REVALIDATE_EMPTY', 600, 0)
);
const STREMIO_STALE_ERROR_HAS_STREAMS = Math.max(
    STREMIO_STALE_REVALIDATE_HAS_STREAMS,
    parsePositiveEnvInt('STREMIO_STALE_ERROR_HAS_STREAMS', parsePositiveEnvInt('STREMIO_STALE_ERROR', 604800, 0), 0)
);
const STREMIO_STALE_ERROR_EMPTY = Math.max(
    STREMIO_STALE_REVALIDATE_EMPTY,
    parsePositiveEnvInt('STREMIO_STALE_ERROR_EMPTY', 1200, 0)
);

function buildClientCacheMetadata(cachePolicy = {}, streamCount = 0) {
    const policyLocalTtl = Math.max(0, Number(cachePolicy?.localTtl || 0) || 0);
    const policyStaleGrace = Math.max(0, Number(cachePolicy?.staleGraceTtl || 0) || 0);
    const hasStreams = Number(streamCount || 0) > 0;

    if (policyLocalTtl <= 0 && policyStaleGrace <= 0) {
        return {
            cacheMaxAge: 0,
            staleRevalidate: 0,
            staleError: 0,
            cacheProfile: 'live_only'
        };
    }

    if (!hasStreams) {
        const emptyMaxAge = Math.max(0, Math.min(STREMIO_CACHE_MAX_AGE_EMPTY, policyLocalTtl || STREMIO_CACHE_MAX_AGE_EMPTY));
        return {
            cacheMaxAge: emptyMaxAge,
            staleRevalidate: Math.max(emptyMaxAge, Math.min(STREMIO_STALE_REVALIDATE_EMPTY, policyStaleGrace || STREMIO_STALE_REVALIDATE_EMPTY)),
            staleError: Math.max(STREMIO_STALE_ERROR_EMPTY, emptyMaxAge),
            cacheProfile: 'empty_short'
        };
    }

    const positiveMaxAge = Math.max(120, STREMIO_CACHE_MAX_AGE_HAS_STREAMS);
    const positiveStaleRevalidate = Math.max(positiveMaxAge, policyStaleGrace, STREMIO_STALE_REVALIDATE_HAS_STREAMS);
    const positiveStaleError = Math.max(positiveStaleRevalidate, STREMIO_STALE_ERROR_HAS_STREAMS);

    return {
        cacheMaxAge: positiveMaxAge,
        staleRevalidate: positiveStaleRevalidate,
        staleError: positiveStaleError,
        cacheProfile: 'positive_long'
    };
}

function getServiceResolverLimiter(service) {
    const normalized = String(service || '').toLowerCase();
    if (normalized === 'tb') return LIMITERS.tbResolve;
    return LIMITERS.rdResolve;
}

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

function uniqueTextList(values = []) {
    const seen = new Set();
    const output = [];

    for (const value of values) {
        const text = String(value || '').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        output.push(text);
    }

    return output;
}

function isAnimeMetaContext(meta = {}, type = '') {
    return Boolean(meta?.kitsu_id || meta?.isAnime || String(type || '').toLowerCase() === 'anime');
}

function getEpisodeParseOptions(meta = {}, type = '') {
    return { anime: isAnimeMetaContext(meta, type) };
}

function getEffectiveSearchLanguageMode(filters = {}, meta = {}, type = '') {
    return resolveLanguageMode({ filters, meta, type, animeDefault: 'all', fallback: 'ita' });
}



function getSeriesEpisodeContext(meta = {}) {
    const season = Number.isInteger(meta?.season) ? meta.season : parseInt(meta?.season, 10);
    const episode = Number.isInteger(meta?.episode) ? meta.episode : parseInt(meta?.episode, 10);
    const isSeries = Boolean(meta?.isSeries || (Number.isFinite(season) && Number.isFinite(episode)));
    return {
        isSeries,
        season: Number.isFinite(season) && season > 0 ? season : 1,
        episode: Number.isFinite(episode) && episode > 0 ? episode : null
    };
}

function collectCandidatePackTexts(item = {}) {
    return uniqueTextList([
        item.title,
        item.filename,
        item.file_title,
        item.websiteTitle,
        item.rawDescription,
        item.packTitle,
        item.name
    ]);
}

function parseCandidateEpisodeText(text, meta = {}, type = '') {
    const ctx = getSeriesEpisodeContext(meta);
    return extractSeasonEpisodeFromFilename(String(text || ''), ctx.season || 1, getEpisodeParseOptions(meta, type));
}

function isExactRequestedEpisodeItem(item = {}, meta = {}, type = '') {
    const ctx = getSeriesEpisodeContext(meta);
    if (!ctx.isSeries || !ctx.episode) return false;

    for (const text of collectCandidatePackTexts(item)) {
        const parsed = parseCandidateEpisodeText(text, meta, type);
        if (!parsed || parsed.isRange || parsed.isBatch) continue;
        const seasonOk = parsed.season === ctx.season || shouldIgnoreAnimeSeason(meta, type, text);
        if (seasonOk && parsed.episode === ctx.episode) return true;
    }

    return false;
}

function hasStrictSeasonPackCue(item = {}, meta = {}, type = '') {
    const texts = collectCandidatePackTexts(item);
    if (texts.length === 0) return false;

    for (const text of texts) {
        const parsed = parseCandidateEpisodeText(text, meta, type);
        if (parsed?.isRange || parsed?.isBatch) return true;
    }

    const joined = texts.join(' ');
    if (/\bS\d{1,2}E\d{1,3}\s*(?:-|~|to|a)\s*(?:E)?\d{1,3}\b/i.test(joined)) return true;
    if (/\b\d{1,2}x\d{1,3}\s*(?:-|~|to|a)\s*(?:\d{1,2}x)?\d{1,3}\b/i.test(joined)) return true;
    if (/\b(?:episodes?|episodi?)\s*\d{1,3}\s*(?:-|~|to|a)\s*\d{1,3}\b/i.test(joined)) return true;
    if (/\b(?:batch|complete|completa|full|integrale|collection|raccolta|全集|合集)\b/i.test(joined)) return true;

    const hasSingleEpisodeCue = /\bS\d{1,2}E\d{1,3}\b/i.test(joined) || /\b\d{1,2}x\d{1,3}\b/i.test(joined);
    if (hasSingleEpisodeCue) return false;

    const ctx = getSeriesEpisodeContext(meta);
    const season = ctx.season || 1;
    if (new RegExp(`\\b(?:season|stagione)\\s*0?${season}(?!\\d)`, 'i').test(joined)) return true;
    if (new RegExp(`\\bS0?${season}(?!\\s*E|\\d)`, 'i').test(joined)) return true;

    return false;
}

function isConfidentSeasonPackItem(item = {}, meta = {}, type = '') {
    const ctx = getSeriesEpisodeContext(meta);
    if (!ctx.isSeries) return false;
    if (isExactRequestedEpisodeItem(item, meta, type)) return false;

    const hasFlag = Boolean(item?._isPack || item?.potentialPack || item?.packTitle || isSeasonPack(item?.title || ''));
    if (!hasFlag && !hasStrictSeasonPackCue(item, meta, type)) return false;
    return hasStrictSeasonPackCue(item, meta, type);
}

function mapKitsuEpisodePosition(parsedKitsu, fallbackKitsuMeta) {
    const requestedEpisode = Number(parsedKitsu?.episode || 0) || 0;
    const mappedSeason = Number(fallbackKitsuMeta?.season || parsedKitsu?.season || 1) || 1;
    const baseEpisode = Number(fallbackKitsuMeta?.episode || 1) || 1;

    if (!(requestedEpisode > 0)) {
        return {
            mappedSeason,
            mappedEpisode: 0,
            requestedEpisode: 0
        };
    }

    return {
        mappedSeason,
        mappedEpisode: baseEpisode + requestedEpisode - 1,
        requestedEpisode
    };
}

function buildExternalAddonRequestId(type, finalId, meta = {}) {
    const cleanType = String(type || '').toLowerCase() === 'anime' ? 'series' : String(type || '').toLowerCase();
    if (cleanType === 'series' && meta?.imdb_id && Number(meta?.season) > 0 && Number(meta?.episode) > 0) {
        return `${meta.imdb_id}:${Number(meta.season)}:${Number(meta.episode)}`;
    }
    if (cleanType === 'movie' && meta?.imdb_id) return meta.imdb_id;
    if (cleanType === 'series' && String(finalId || '').startsWith('tmdb:') && Number(meta?.season) > 0 && Number(meta?.episode) > 0) {
        return `${String(finalId)}:${Number(meta.season)}:${Number(meta.episode)}`;
    }
    return finalId;
}

function isAnimeTmdbMetadata(tmdbData = {}, type = '') {
    if (String(type || '').toLowerCase() !== 'series') return false;

    const originalLanguage = String(tmdbData?.original_language || '').toLowerCase();
    const genres = Array.isArray(tmdbData?.genres) ? tmdbData.genres : [];
    const genreNames = genres.map((genre) => String(genre?.name || '').toLowerCase());
    const genreIds = genres.map((genre) => Number(genre?.id)).filter(Number.isFinite);
    const originCountries = [
        ...(Array.isArray(tmdbData?.origin_country) ? tmdbData.origin_country : []),
        ...(Array.isArray(tmdbData?.production_countries) ? tmdbData.production_countries.map((country) => country?.iso_3166_1) : []),
        ...(Array.isArray(tmdbData?.networks) ? tmdbData.networks.map((network) => network?.origin_country) : [])
    ]
        .map((value) => String(value || '').toUpperCase())
        .filter(Boolean);

    const japaneseProduction = originalLanguage === 'ja' || originCountries.includes('JP');
    const animated = genreIds.includes(16) || genreNames.some((name) => name.includes('anim'));

    return japaneseProduction && animated;
}

function getLazyCacheKey(service, item, meta) {
    return `${service}:${item.hash}:${meta?.season || item.season || 0}:${meta?.episode || item.episode || 0}:${item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : -1}`;
}

function getLazyResolveInflightKey(service, apiKey, item, meta) {
    const tokenSig = crypto.createHash('sha1').update(String(apiKey || '')).digest('hex').slice(0, 12);
    return `${String(service || 'rd').toLowerCase()}:${tokenSig}:${item.hash}:${meta?.season || item.season || 0}:${meta?.episode || item.episode || 0}:${item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : -1}`;
}

function getProviderBreakerState(providerName) {
    return sourceHealth.getCircuitState(providerName);
}

function getProviderCircuitState(providerName) {
    return sourceHealth.getCircuitState(providerName);
}

function recordProviderSuccess(providerName, meta = {}) {
    return sourceHealth.recordSuccess(providerName, meta);
}

function recordProviderFailure(providerName, meta = {}) {
    return sourceHealth.recordFailure(providerName, meta);
}

async function resolveLazyStreamData(service, apiKey, item, meta) {
    if (!apiKey || !item?.hash) return null;
    const normalizedService = getNormalizedDebridService(service);
    if (!normalizedService) return null;
    const resolverLimiter = getServiceResolverLimiter(normalizedService);
    const inflightKey = getLazyResolveInflightKey(normalizedService, apiKey, item, meta);

    return withSharedPromise(lazyResolveInflight, `lazy:${inflightKey}`, async () => {
        if (normalizedService === 'tb') {
            return resolverLimiter.schedule(() =>
                TB.getStreamLink(
                    apiKey,
                    item.magnet,
                    String(meta?.season || item.season || 0),
                    String(meta?.episode || item.episode || 0),
                    item.hash,
                    item.fileIdx !== undefined && item.fileIdx !== null ? String(item.fileIdx) : undefined
                )
            );
        }
        return resolverLimiter.schedule(() =>
            RD.getStreamLink(
                apiKey,
                item.magnet,
                meta?.season || item.season || 0,
                meta?.episode || item.episode || 0,
                item.fileIdx
            )
        );
    });
}

function getExternalLanguageAudit(item = {}) {
    const info = item?._externalLanguageInfo && typeof item._externalLanguageInfo === 'object'
        ? item._externalLanguageInfo
        : (item?.languageInfo && typeof item.languageInfo === 'object' ? item.languageInfo : {});
    const confidence = Number(item?._externalLanguageConfidence ?? info.confidence ?? 0) || 0;
    const hasItalianAudio = Boolean(item?._externalHasItalianAudio || info.hasAudioItalian);
    const hasItalianSubs = Boolean(item?._externalHasItalianSubs || info.hasSubItalian);
    const hasNegativeLanguage = Boolean(info.hasNegativeLanguage);
    const isItalian = Boolean(item?._externalIsItalian || info.isItalian || hasItalianAudio);
    return { info, confidence, hasItalianAudio, hasItalianSubs, hasNegativeLanguage, isItalian };
}

function isExternalStrictItalianCandidate(item = {}) {
    const audit = getExternalLanguageAudit(item);
    if (audit.hasItalianAudio) return true;
    if (audit.isItalian && audit.confidence >= 20 && !audit.hasNegativeLanguage && !audit.hasItalianSubs) return true;
    return false;
}

function keepLanguageCandidateForMode(item, meta = {}, langMode = 'ita') {
    const title = String(item?.title || '');
    const source = item?.source;
    if (langMode === 'eng') return keepEnglishCandidate(title, source, meta?.title);
    if (langMode === 'all') return keepAllCandidate(title, source, meta?.title);
    if (item?.isExternal && isExternalStrictItalianCandidate(item)) return true;
    return keepItalianCandidate(title, source, meta?.title);
}

function assessFastResultQuality(items, meta, langMode, config) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
        return { shouldScrape: true, reason: 'no_fast_results', strongCount: 0, exactEpisodeCount: 0, seasonPackCount: 0, total: 0 };
    }

    const effectiveLangMode = langMode;
    let strongCount = 0;
    let exactEpisodeCount = 0;
    let seasonPackCount = 0;

    for (const item of list) {
        const title = String(item?.title || '');
        const source = String(item?.source || '');
        const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
        const seeders = parseInt(item?.seeders, 10) || 0;
        const isPack = isConfidentSeasonPackItem(item, meta, type);
        const langOk = keepLanguageCandidateForMode(item, meta, effectiveLangMode);
        const hasQualitySignal = /\b(?:2160p|4k|uhd|1080p|fhd|720p|web[-.\s]?dl|blu[-.\s]?ray|remux|hevc|x265|x264)\b/i.test(title);
        const hasWeight = hasQualitySignal || sizeBytes >= (meta?.isSeries ? 250 : 700) * 1024 * 1024 || seeders > 0;

        let exactEpisode = false;
        if (meta?.isSeries) {
            const parsed = extractSeasonEpisodeFromFilename(title, meta.season || 1, getEpisodeParseOptions(meta));
            exactEpisode = Boolean(parsed && !parsed?.isRange && !parsed?.isBatch && parsed.episode === meta.episode && (parsed.season === meta.season || meta?.kitsu_id));
            if (exactEpisode) exactEpisodeCount += 1;
            if (!exactEpisode && isPack && new RegExp(`(?:s|season|stagione)\\s*0?${meta.season}(?!\\d)`, 'i').test(title)) seasonPackCount += 1;
        }

        let strength = 0;
        if (langOk) strength += 1;
        if (hasWeight) strength += 1;
        if (!meta?.isSeries || exactEpisode || isPack) strength += 1;
        if (seeders > 0) strength += 1;

        if (strength >= (meta?.isSeries ? 3 : 2)) strongCount += 1;
    }

    const minimumStrong = meta?.isSeries ? 2 : 1;
    const shouldScrape = strongCount < minimumStrong || (meta?.isSeries && exactEpisodeCount === 0 && seasonPackCount === 0);
    const reason = shouldScrape
        ? (list.length === 0
            ? 'no_fast_results'
            : (meta?.isSeries && exactEpisodeCount === 0 && seasonPackCount === 0)
                ? 'no_exact_episode_or_pack'
                : `weak_fast_pool_${strongCount}_of_${minimumStrong}`)
        : 'fast_pool_ok';

    return { shouldScrape, reason, strongCount, exactEpisodeCount, seasonPackCount, total: list.length };
}

function getEffectiveLangMode(config, meta = {}, type = '') {
    return getEffectiveSearchLanguageMode(config?.filters || {}, meta, type);
}

const TITLE_SIGNAL_CACHE = new Map();
const MAX_TITLE_SIGNAL_CACHE = 4000;
const lazyResolveInflight = new Map();
const backgroundDbSaveInflight = new Map();
const titleSearchInflight = new Map();
const titleSearchHotCache = new Map();
const validatedFileSetCache = new Map();
const recentBackgroundDbSaves = new Map();
const recentPackResolutionJobs = new Map();
const STREAM_STALE_LOAD_THRESHOLD = Math.max(1, Math.min(200, parseInt(process.env.STREAM_STALE_LOAD_THRESHOLD || '18', 10) || 18));
const BACKGROUND_DB_SAVE_DEDUP_MS = Math.max(1000, Math.min(120000, parseInt(process.env.BACKGROUND_DB_SAVE_DEDUP_MS || '15000', 10) || 15000));
const LAZY_WARMUP_LOAD_THRESHOLD = Math.max(1, Math.min(200, parseInt(process.env.LAZY_WARMUP_LOAD_THRESHOLD || '14', 10) || 14));
const TITLE_SEARCH_HOT_TTL_MS = Math.max(5000, Math.min(5 * 60 * 1000, parseInt(process.env.TITLE_SEARCH_HOT_TTL_MS || '45000', 10) || 45000));
const VALIDATED_FILE_SET_TTL_MS = Math.max(30 * 1000, Math.min(60 * 60 * 1000, parseInt(process.env.VALIDATED_FILE_SET_TTL_MS || String(20 * 60 * 1000), 10) || 20 * 60 * 1000));
const TIMED_CACHE_MAX_ENTRIES = Math.max(200, Math.min(10000, parseInt(process.env.TIMED_CACHE_MAX_ENTRIES || '3000', 10) || 3000));
const TIMED_CACHE_SWEEP_INTERVAL_MS = Math.max(1000, Math.min(60 * 1000, parseInt(process.env.TIMED_CACHE_SWEEP_INTERVAL_MS || '5000', 10) || 5000));
const BACKGROUND_DB_SAVE_QUEUE_MAX = Math.max(10, Math.min(1000, parseInt(process.env.BACKGROUND_DB_SAVE_QUEUE_MAX || '120', 10) || 120));
const PACK_RESOLUTION_QUEUE_MAX = Math.max(10, Math.min(1000, parseInt(process.env.PACK_RESOLUTION_QUEUE_MAX || '80', 10) || 80));
const timedCacheSweepState = new WeakMap();

function getTimedCacheState(map) {
    let state = timedCacheSweepState.get(map);
    if (!state) {
        state = { nextSweepAt: 0 };
        timedCacheSweepState.set(map, state);
    }
    return state;
}

function trimTimedCacheSize(map, maxEntries = TIMED_CACHE_MAX_ENTRIES) {
    while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function cleanupTimedCache(map, maxEntries = TIMED_CACHE_MAX_ENTRIES, options = {}) {
    if (!(map instanceof Map) || map.size === 0) return;
    const now = Date.now();
    const state = getTimedCacheState(map);
    const overCapacity = map.size > maxEntries;
    if (options.force !== true && !overCapacity && now < state.nextSweepAt) return;

    state.nextSweepAt = now + TIMED_CACHE_SWEEP_INTERVAL_MS;

    for (const [key, entry] of map) {
        if (!entry || Number(entry.expiresAt || 0) <= now) map.delete(key);
    }

    trimTimedCacheSize(map, maxEntries);
}

function getTimedCacheValue(map, key) {
    cleanupTimedCache(map);
    const entry = map.get(key);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= Date.now()) {
        map.delete(key);
        return null;
    }
    return entry.value;
}

function setTimedCacheValue(map, key, value, ttlMs, maxEntries = TIMED_CACHE_MAX_ENTRIES) {
    if (!key || ttlMs <= 0) return value;
    cleanupTimedCache(map, maxEntries);
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    trimTimedCacheSize(map, maxEntries);
    return value;
}

function isQueueOverflowError(error) {
    if (!error) return false;
    if (error.code === 'QUEUE_OVERFLOW') return true;
    const message = String(error.message || error);
    return /dropped by bottleneck|queue overflow|highwater/i.test(message);
}

function buildTitleSearchPipelineKey(meta, type, langMode, dbOnlyMode = false, filters = {}) {
    const normalizeArray = (value) => Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean).sort()
        : [];
    const titles = [meta?.title, meta?.originalTitle, meta?.name]
        .filter(Boolean)
        .map((value) => normalizeSearchText(value))
        .filter(Boolean)
        .slice(0, 6)
        .sort();
    const payload = {
        type: String(type || '').toLowerCase(),
        langMode: String(langMode || '').toLowerCase(),
        dbOnly: dbOnlyMode === true,
        year: Number(meta?.year || 0) || 0,
        season: Number(meta?.season || 0) || 0,
        episode: Number(meta?.episode || 0) || 0,
        filters: {
            no4k: filters?.no4k === true,
            no1080: filters?.no1080 === true,
            no720: filters?.no720 === true,
            noScr: filters?.noScr === true,
            noCam: filters?.noCam === true,
            maxSizeGB: Number(filters?.maxSizeGB || 0) || 0,
            minSizeGB: Number(filters?.minSizeGB || 0) || 0,
            maxSizeBytes: Number(filters?.maxSizeBytes || 0) || 0,
            minSizeBytes: Number(filters?.minSizeBytes || 0) || 0,
            minSeeders: Number(filters?.minSeeders || 0) || 0,
            maxSeeders: Number(filters?.maxSeeders || 0) || 0,
            providers: normalizeArray(filters?.providers),
            providerAllow: normalizeArray(filters?.providerAllow),
            providerInclude: normalizeArray(filters?.providerInclude),
            providerExclude: normalizeArray(filters?.providerExclude),
            providerDeny: normalizeArray(filters?.providerDeny),
            providerBlock: normalizeArray(filters?.providerBlock),
            qualityAllow: normalizeArray(filters?.qualityAllow),
            qualityInclude: normalizeArray(filters?.qualityInclude),
            qualityExclude: normalizeArray(filters?.qualityExclude),
            qualityDeny: normalizeArray(filters?.qualityDeny),
            qualityFilter: normalizeArray(filters?.qualityFilter),
            requireTags: normalizeArray(filters?.requireTags),
            excludeTags: normalizeArray(filters?.excludeTags),
            sizeFilter: Array.isArray(filters?.sizeFilter)
                ? filters.sizeFilter.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
                : (filters?.sizeFilter && typeof filters.sizeFilter === 'object'
                    ? {
                        min: String(filters.sizeFilter.min || filters.sizeFilter.from || filters.sizeFilter.gte || '').trim().toLowerCase(),
                        max: String(filters.sizeFilter.max || filters.sizeFilter.to || filters.sizeFilter.lte || '').trim().toLowerCase()
                    }
                    : String(filters?.sizeFilter || '').trim().toLowerCase())
        },
        titles
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 20);
}

function buildValidatedFileSetKey(item, meta) {
    const hash = extractInfoHash(item?.hash || item?.infoHash || '');
    if (!hash) return null;
    const season = Number(meta?.season || item?.season || 0) || 0;
    const episode = Number(meta?.episode || item?.episode || 0) || 0;
    const mediaType = meta?.isSeries || season > 0 || episode > 0 ? 'series' : 'movie';
    return `${hash}:${mediaType}:${season}:${episode}`;
}

function getValidatedFileSet(item, meta) {
    const key = buildValidatedFileSetKey(item, meta);
    if (!key) return null;
    return getTimedCacheValue(validatedFileSetCache, key);
}

function rememberValidatedFileSet(item, meta, payload) {
    const key = buildValidatedFileSetKey(item, meta);
    if (!key || !payload || typeof payload !== 'object') return;
    setTimedCacheValue(validatedFileSetCache, key, payload, VALIDATED_FILE_SET_TTL_MS);
}



function detectCodecBucket(text) {
    const raw = String(text || '').toLowerCase();
    if (/\b(?:av1)\b/.test(raw)) return 'av1';
    if (/\b(?:x265|h265|hevc)\b/.test(raw)) return 'hevc';
    if (/\b(?:x264|h264|avc)\b/.test(raw)) return 'avc';
    return 'other';
}

function detectQualityBucket(text) {
    const raw = String(text || '').toLowerCase();
    if (/\b(?:2160p|4k|uhd)\b/.test(raw)) return '4k';
    if (/\b(?:1080p|fhd|full[-.\s]?hd)\b/.test(raw)) return '1080p';
    if (/\b(?:720p|hd)\b/.test(raw)) return '720p';
    return 'sd';
}

function detectReleaseGroupKey(item) {
    const title = String(item?.title || '');
    const source = String(item?.source || item?.provider || '');
    const fromSuffix = title.match(/-(\w{2,20})$/i);
    if (fromSuffix && fromSuffix[1]) return fromSuffix[1].toLowerCase();
    const fromBracket = title.match(/\[(\w{2,20})\]/i);
    if (fromBracket && fromBracket[1]) return fromBracket[1].toLowerCase();
    const trusted = `${title} ${source}`.match(/\b(?:mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo|rarbg|yts|yify|qxr|tgx|galaxyrg|framestor|epsilon|ntb|ctrlhd|flux|playweb)\b/i);
    return trusted && trusted[0] ? trusted[0].toLowerCase() : 'generic';
}

function buildDiversityPolicy(config = {}) {
    const filters = config?.filters || {};
    return {
        enabled: filters.disablePremiumDiversity !== true,
        maxPerCodec: Math.max(1, Math.min(6, parseInt(filters.maxPerCodec || process.env.PREMIUM_MAX_PER_CODEC || '3', 10) || 3)),
        maxPerReleaseGroup: Math.max(1, Math.min(5, parseInt(filters.maxPerReleaseGroup || process.env.PREMIUM_MAX_PER_RELEASE_GROUP || '2', 10) || 2)),
        maxPerQuality: Math.max(1, Math.min(8, parseInt(filters.maxPerQualityBucket || filters.maxPerQuality || process.env.PREMIUM_MAX_PER_QUALITY || '4', 10) || 4))
    };
}

function applyPackKnowledge(items, meta) {
    return (Array.isArray(items) ? items : []).map((item) => {
        if (!item) return item;
        const known = getValidatedFileSet(item, meta);
        if (!known) return item;

        const rawFileIndex = known?.raw?.fileIndex ?? known?.raw?.fileIdx;
        const resolvedFileIndex = rawFileIndex === null || rawFileIndex === undefined || rawFileIndex === ''
            ? null
            : (Number.isInteger(Number(rawFileIndex)) ? Number(rawFileIndex) : null);

        if ((item.fileIdx === undefined || item.fileIdx === null) && resolvedFileIndex !== null) item.fileIdx = resolvedFileIndex;
        if (known.title && shouldUpdatePackTitle(item.title, known.title)) item.title = known.title;
        item._packValidated = true;
        item._packTitleSource = known.titleSource || 'validated';
        return item;
    });
}

function applyPremiumRankingPolicy(results, meta, config) {
    const list = Array.isArray(results) ? results : [];
    const policy = buildDiversityPolicy(config);
    if (!policy.enabled || list.length <= 2) return list;

    const codecCounts = new Map();
    const groupCounts = new Map();
    const qualityCounts = new Map();
    const selected = [];
    const overflow = [];

    for (const item of list) {
        const title = String(item?.title || '');
        const codec = detectCodecBucket(title);
        const group = detectReleaseGroupKey(item);
        const quality = detectQualityBucket(title);
        const mustKeep = item?._packValidated === true
            || item?._tbCached === true
            || item?._dbCachedRd === true
            || item?.cached_rd === true
            || (meta?.isSeries && Number.isInteger(item?.fileIdx));

        const codecCount = codecCounts.get(codec) || 0;
        const groupCount = groupCounts.get(group) || 0;
        const qualityCount = qualityCounts.get(quality) || 0;
        const overPolicy = codecCount >= policy.maxPerCodec || groupCount >= policy.maxPerReleaseGroup || qualityCount >= policy.maxPerQuality;

        if (!overPolicy || mustKeep) {
            selected.push(item);
            codecCounts.set(codec, codecCount + 1);
            groupCounts.set(group, groupCount + 1);
            qualityCounts.set(quality, qualityCount + 1);
        } else {
            overflow.push(item);
        }
    }

    return [...selected, ...overflow];
}

function getMetaDbLookupKey(meta) {
    const imdbId = String(meta?.imdb_id || '').trim().toLowerCase();
    if (!/^tt\d+$/.test(imdbId)) return null;
    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    return `${imdbId}:${season}:${episode}`;
}

function buildResultsSignature(results) {
    const tokens = [...new Set((Array.isArray(results) ? results : [])
        .map((item) => {
            const hash = extractInfoHash(item?.hash || item?.infoHash || item?.magnet || '');
            if (!hash) return null;
            const fileIdx = Number.isInteger(item?.fileIdx) ? item.fileIdx : -1;
            return `${hash}:${fileIdx}`;
        })
        .filter(Boolean))]
        .sort()
        .slice(0, 80);

    if (tokens.length === 0) return null;
    return crypto.createHash('sha1').update(tokens.join('|')).digest('hex').slice(0, 20);
}

function setTitleSignalCache(cacheKey, value) {
    if (TITLE_SIGNAL_CACHE.size >= MAX_TITLE_SIGNAL_CACHE) {
        const firstKey = TITLE_SIGNAL_CACHE.keys().next().value;
        if (firstKey !== undefined) TITLE_SIGNAL_CACHE.delete(firstKey);
    }
    TITLE_SIGNAL_CACHE.set(cacheKey, value);
    return value;
}

function getTitleSignalCacheKey(title, metaTitle, sourceName) {
    return crypto.createHash('sha1')
        .update(JSON.stringify([String(title || ''), String(metaTitle || ''), String(sourceName || '')]))
        .digest('hex');
}

function getTitleDiagnostics(title, metaTitle, sourceName) {
    const safeTitle = String(title || '');
    const safeMetaTitle = String(metaTitle || '');
    const safeSource = String(sourceName || '');
    const cacheKey = getTitleSignalCacheKey(safeTitle, safeMetaTitle, safeSource);
    const cached = TITLE_SIGNAL_CACHE.get(cacheKey);
    if (cached) return cached;

    const parsed = parseTitleDetails(safeTitle);
    const langInfo = getLanguageInfo(safeTitle, safeMetaTitle, safeSource, parsed);
    const detected = new Set(Array.isArray(langInfo?.detectedLanguages) ? langInfo.detectedLanguages.map(v => String(v)) : []);
    const upper = safeTitle.toUpperCase();

    return setTitleSignalCache(cacheKey, {
        parsed,
        langInfo,
        normalizedTitle: normalizeSearchText(safeTitle),
        normalizedMeta: normalizeSearchText(safeMetaTitle),
        explicitEng: detected.has('English') || /\b(?:ENG|ENGLISH)\b/i.test(upper),
        explicitIta: detected.has('Italian') || langInfo?.isItalian || (langInfo?.confidence || 0) >= 5 || /\b(?:ITA|ITALIANO|ITALIAN)\b/i.test(upper),
        explicitMulti: !!langInfo?.isMulti || /\b(?:MULTI|DUAL[\s.-]?AUDIO)\b/i.test(upper),
        explicitOther: /\b(?:FRENCH|GERMAN|SPANISH|ESP|LATINO|RUS|RUSSIAN|JPN|JAP|VOSTFR|POLISH|PORTUGUESE|PT-BR|HINDI|KOREAN|CHINESE|ARABIC|TURKISH)\b/i.test(upper),
        neutralScene: /\b(?:WEB[-.\s]?DL|WEBRIP|BLU[-.\s]?RAY|REMUX|BDRIP|2160P|1080P|720P|X265|X264|HEVC|DDP|DTS|TRUEHD|AAC)\b/i.test(upper)
    });
}

function createRuntimeItem(item, meta) {
    return {
        ...item,
        season: meta?.season ?? item?.season ?? 0,
        episode: meta?.episode ?? item?.episode ?? 0
    };
}

function getExternalDirectUrl(item = {}) {
    const candidates = [
        item?._externalDirectUrl,
        item?.externalDirectUrl,
        item?.directUrl,
        item?.url,
        item?.isExternal ? item?.magnet : null
    ];

    for (const value of candidates) {
        const text = String(value || '').trim();
        if (/^https?:\/\//i.test(text)) return text;
    }

    return null;
}

function getObservedSizeBytes(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
}

function getObservedSeederCount(...values) {
    for (const value of values) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function pad2(value) {
    const num = parseInt(value, 10) || 0;
    return num < 10 ? `0${num}` : `${num}`;
}

function getEpisodeDisplayTitle(meta, fallbackTitle) {
    if (!meta?.title || !(meta?.season > 0 || meta?.episode > 0)) return fallbackTitle;
    return `${meta.title} S${pad2(meta.season)}E${pad2(meta.episode)}`;
}

function detectQualityLabel(text, fallback = 'SD') {
    const upper = String(text || '').toUpperCase();
    if (/\b(?:4K|2160P|UHD)\b/.test(upper)) return '4K';
    if (/\b(?:1080P|FHD|FULLHD)\b/.test(upper)) return '1080p';
    if (/\b(?:720P|HD)\b/.test(upper)) return '720p';
    if (/\b(?:480P|SD)\b/.test(upper)) return 'SD';
    return fallback || 'SD';
}

const QUALITY_CAM_REGEX = /\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i;

function getQualityFilterSignals(text, options = {}) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();
    const upper = raw.toUpperCase();
    const has4k = REGEX_QUALITY_FILTER["4K"].test(lower);
    const has1080 = REGEX_QUALITY_FILTER["1080p"].test(lower);
    const has720 = REGEX_QUALITY_FILTER["720p"].test(lower)
        || Boolean(options.treatGenericHdAs720 && /\bHD\b/.test(upper) && !/\b(?:1080P|2160P|4K|FHD|UHD|FULLHD)\b/.test(upper));
    const hasSd = REGEX_QUALITY_FILTER["SD"].test(lower);
    const hasCam = QUALITY_CAM_REGEX.test(raw);
    return { has4k, has1080, has720, hasSd, hasCam };
}

function shouldDropByConfiguredQuality(text, filters = {}, options = {}) {
    const quality = getQualityFilterSignals(text, options);
    if (filters.no4k && quality.has4k) return true;
    if (filters.no1080 && quality.has1080) return true;
    if (filters.no720 && quality.has720) return true;
    if (filters.noScr && (quality.hasSd || quality.hasCam)) return true;
    if (filters.noCam && quality.hasCam) return true;
    return false;
}

function applyConfiguredTorrentFilters(items, filters = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    return applyTorrentResultFilters(list, filters);
}

function applyConfiguredStreamFilters(streams, filters = {}) {
    const list = Array.isArray(streams) ? streams : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    return list.filter(stream => !shouldDropByConfiguredQuality(`${stream?.title || ''} ${stream?.name || ''}`, filters, { treatGenericHdAs720: true }));
}

async function normalizeCandidateResults(items, availabilityTools = {}) {
    const propagateRdKnownStatesByHash = typeof availabilityTools.propagateRdKnownStatesByHash === 'function'
        ? availabilityTools.propagateRdKnownStatesByHash
        : (value) => value;
    const hydrateRdDbStatesByHash = typeof availabilityTools.hydrateRdDbStatesByHash === 'function'
        ? availabilityTools.hydrateRdDbStatesByHash
        : async (value) => value;

    let normalized = deduplicateResults(Array.isArray(items) ? items : []);
    normalized = propagateRdKnownStatesByHash(normalized);
    normalized = await hydrateRdDbStatesByHash(normalized);
    return normalized;
}

function escapeRegExpLocal(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeSeriesTitle(value) {
    return normalizeSearchText(value)
        .replace(/\b(?:2160p|1080p|720p|480p|4k|uhd|hdr|hdr10|dv|dolby\s*vision|hevc|x265|x264|h265|h264|bluray|blu\s*ray|brrip|bdrip|web\s*dl|webrip|web|hdtv|remux|proper|repack|rerip|internal|extended|uncut|remastered|aac|ac3|eac3|ddp\d*\.?\d*|dts|truehd|atmos|ita|eng|multi|sub|subs|vostfr|dubbed|dual|audio)\b/gi, ' ')
        .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
        .split(/\s+/)
        .filter(token => token && token.length >= 2);
}

function extractPrimarySeriesTitle(value) {
    const raw = normalizeSearchText(value)
        .replace(/[\[\]\(\){}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return '';

    const cutPatterns = [
        /\bs\d{1,2}\s*e\d{1,3}\b/i,
        /\b\d{1,2}x\d{1,3}\b/i,
        /\bseason\s*\d{1,2}\b/i,
        /\bstagione\s*\d{1,2}\b/i,
        /\bepisode\s*\d{1,3}\b/i,
        /\bepisodio\s*\d{1,3}\b/i,
        /\bep\.?\s*\d{1,3}\b/i,
        /\bcomplete\b/i,
        /\bcompleta\b/i,
        /\bpack\b/i
    ];

    let cutIndex = raw.length;
    for (const pattern of cutPatterns) {
        const match = raw.match(pattern);
        if (match && typeof match.index === 'number' && match.index < cutIndex) cutIndex = match.index;
    }

    return raw
        .slice(0, cutIndex)
        .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
        .replace(/\b(?:proper|repack|rerip|internal|extended|uncut|remastered)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasStrongSeriesTitleMatch(title, meta) {
    const candidatePrimary = extractPrimarySeriesTitle(title);
    const candidateTokens = tokenizeSeriesTitle(candidatePrimary);
    if (candidateTokens.length === 0) return false;

    const allowedExtraTokens = new Set(['us', 'uk', 'it']);
    const variants = [meta?.title, meta?.originalTitle, meta?.name]
        .filter(Boolean)
        .map(value => normalizeSearchText(value))
        .filter(Boolean);

    for (const variant of variants) {
        const variantPrimary = extractPrimarySeriesTitle(variant) || normalizeSearchText(variant).trim();
        const targetTokens = tokenizeSeriesTitle(variantPrimary);
        if (targetTokens.length === 0) continue;

        const candidateSet = new Set(candidateTokens);
        if (targetTokens.some(token => !candidateSet.has(token))) continue;

        const extras = candidateTokens.filter(token => !targetTokens.includes(token) && !allowedExtraTokens.has(token));
        const exactPhrase = new RegExp(`(?:^|\\b)${escapeRegExpLocal(variantPrimary)}(?:\\b|$)`, 'i').test(candidatePrimary);

        if (targetTokens.length === 1) {
            if (candidateTokens.length === 1 && extras.length === 0) return true;
            if (exactPhrase && extras.length === 0) return true;
            continue;
        }

        if (exactPhrase && extras.length <= 1) return true;
        if (extras.length === 0) return true;
    }

    return false;
}

function createAggressiveResultFilter(meta, type, langMode) {
    const effectiveLangMode = langMode;
    return (item) => {
        if (!item?.magnet && !getExternalDirectUrl(item)) return false;

        const source = String(item.source || '').toLowerCase();
        const title = String(item.title || '');
        const lowerTitle = title.toLowerCase();
        const isPack = isConfidentSeasonPackItem(item, meta, type);

        if (source.includes('comet') || source.includes('stremthru')) return false;

        if (!keepLanguageCandidateForMode(item, meta, effectiveLangMode)) return false;

        const metaYear = parseInt(meta.year, 10);
        if (!Number.isNaN(metaYear)) {
            const fileYearMatch = title.match(REGEX_YEAR);
            if (fileYearMatch && Math.abs(parseInt(fileYearMatch[0], 10) - metaYear) > 1) return false;
        }

        if (!meta.isSeries) {
            const shortQueries = [meta.title, meta.originalTitle]
                .filter(Boolean)
                .map(normalizeSearchText)
                .filter(q => q.length >= 2 && q.length <= 8);
            if (shortQueries.length > 0 && !shortQueries.some(q => isGoodShortQueryMatch(title, q))) return false;
        }

        if (meta.isSeries) {
            if (!hasStrongSeriesTitleMatch(title, meta)) return false;

            const season = meta.season;
            const episode = meta.episode;
            const parsedEpisode = extractSeasonEpisodeFromFilename(title, season || 1, getEpisodeParseOptions(meta, type));

            if (isAnimeMetaContext(meta, type) && parsedEpisode && parsedEpisode.episode === episode && (parsedEpisode.season === season || shouldIgnoreAnimeSeason(meta, type, title))) {
                return true;
            }
            if (isAnimeMetaContext(meta, type) && isPack) {
                item._isPack = true;
                return true;
            }

            const wrongSeasonRegex = /(?:s|stagione|season)\s*0?(\d+)(?!\d)/gi;
            let match;
            const ignoreAnimeSeasonCheck = shouldIgnoreAnimeSeason(meta, type, title);
            while ((match = wrongSeasonRegex.exec(lowerTitle)) !== null) {
                if (parseInt(match[1], 10) !== season && !ignoreAnimeSeasonCheck) return false;
            }

            const xMatch = lowerTitle.match(/(\d+)x(\d+)/i);
            if (xMatch) return (parseInt(xMatch[1], 10) === season || ignoreAnimeSeasonCheck) && parseInt(xMatch[2], 10) === episode;

            const hasRightSeason = new RegExp(`(?:s|stagione|season|^)\\s*0?${season}(?!\\d)`, 'i').test(lowerTitle);
            const hasRightEpisode = new RegExp(`(?:e|x|ep|episode|^)\\s*0?${episode}(?!\\d)`, 'i').test(lowerTitle);

            if (hasRightSeason && hasRightEpisode) return true;
            if (hasRightSeason && (isSeasonPack(lowerTitle) || !/(?:e|x|ep|episode)\s*0?\d+/i.test(lowerTitle))) {
                item._isPack = true;
                return true;
            }
            return false;
        }

        if (/\b(?:S\d{2}|SEASON|STAGIONE)\b/i.test(title) || /\b\d{1,2}x\d{1,2}\b/.test(title)) return false;

        const cleanFile = lowerTitle.replace(/[\.\_\-\(\)\[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim();
        const checkMatch = (strToCheck) => {
            if (!strToCheck) return false;
            const searchKeyword = strToCheck.replace(/^(the|a|an|il|lo|la|i|gli|le)\s+/i, '').trim();
            if (searchKeyword === 'rip') return /^(the\s+|il\s+)?rip\b/i.test(cleanFile);
            if (!isGoodShortQueryMatch(cleanFile, searchKeyword)) return false;
            return searchKeyword.length <= 3
                ? new RegExp(`\\b${searchKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(cleanFile)
                : cleanFile.includes(searchKeyword);
        };

        if (checkMatch(String(meta.title || '').toLowerCase().replace(/[\.\_\-\(\)\[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim())) return true;
        if (checkMatch(String(meta.title || '').split(/ - |: /)[0].toLowerCase().trim())) return true;
        if (checkMatch(String(meta.originalTitle || '').toLowerCase().trim())) return true;
        if (smartMatch(meta.title, title, meta.isSeries, meta.season, meta.episode)) return true;

        return false;
    };
}

async function resolveTorboxRankedList(rankedList, apiKey) {
    const sourceRanked = Array.isArray(rankedList) ? [...rankedList] : [];
    const progressiveWindows = [30, 60, 90];
    let verifiedList = [];
    let usedWindow = 0;

    for (const checkLimit of progressiveWindows) {
        const candidates = sourceRanked.slice(0, checkLimit);
        if (candidates.length === 0) break;

        logger.info(`ðŸ“¦ [TB CHECK] Scansiono ${candidates.length} torrent alla ricerca di file video reali...`);
        const cacheResults = await LIMITERS.tbResolve.schedule(() => TbCache.checkCacheSync(candidates, apiKey, dbHelper, checkLimit));
        verifiedList = [];

        for (const item of candidates) {
            const hash = String(item?.hash || '').toLowerCase();
            const result = cacheResults?.[hash];
            if (result && result.cached === true) {
                item._tbCached = true;
                if (result.file_size) {
                    item._size = result.file_size;
                    item.sizeBytes = result.file_size;
                }
                if (result.file_id !== undefined && result.file_id !== null) item.fileIdx = result.file_id;
                verifiedList.push(item);
            }
        }

        usedWindow = candidates.length;
        if (verifiedList.length >= Math.min(12, CONFIG.MAX_RESULTS) || checkLimit === progressiveWindows[progressiveWindows.length - 1]) break;
    }

    logger.info(`ðŸ“¦ [TB CLEANUP] Finestra usata: ${usedWindow} -> Rimasti: ${verifiedList.length}`);

    const remainingItems = sourceRanked.slice(usedWindow);
    if (remainingItems.length > 0) TbCache.enrichCacheBackground(remainingItems, apiKey, dbHelper);

    return verifiedList;
}

function getServiceDisplayName(service) {
    const normalized = String(service || '').toLowerCase();
    if (normalized === 'rd') return 'realdebrid';
    if (normalized === 'tb') return 'torbox';
    if (normalized === 'web') return 'web';
    return 'p2p';
}

function buildPlayableStream({ service, item, streamUrl, displayTitle, parseTitle, sizeBytes, seeders, config, meta, isLazy = false, isPack = false, availabilityResolver = null }) {
    const normalizedService = String(service || '').toLowerCase();
    const isAIOActive = aioFormatter.isAIOStreamsEnabled(config);
    const baseParseTitle = parseTitle || item?.title || displayTitle || '';
    const details = parseTitleDetails(baseParseTitle);
    const languageInfo = getLanguageInfo(baseParseTitle, meta?.title, item?.source, details);
    const quality = details.qualityLabel && details.qualityLabel !== 'Other'
        ? details.qualityLabel
        : detectQualityLabel(baseParseTitle, details.quality || 'SD');
    const serviceLabel = normalizedService === 'tb' ? 'TB' : normalizedService.toUpperCase();
    const availabilityState = typeof availabilityResolver === 'function' ? availabilityResolver(normalizedService, item) : 'unknown';
    const isSavedCloudStream = Boolean(item?.isSavedCloud || item?._savedCloud || item?.savedCloud);
    const formatterSource = item?.source;

    if (isAIOActive) {
        return {
            name: aioFormatter.formatStreamName({ addonName: "Leviathan", service: getServiceDisplayName(normalizedService), cached: availabilityState === 'cached', cacheState: availabilityState, quality, savedCloud: isSavedCloudStream }),
            title: aioFormatter.formatStreamTitle({
                title: displayTitle,
                size: Number(sizeBytes) > 0 ? formatBytes(sizeBytes) : 'Unknown',
                language: formatLanguageLabel(languageInfo, details.languages, getEffectiveLangMode(config, meta)),
                source: formatterSource,
                seeders,
                infoHash: item?.hash,
                techInfo: `ðŸŽžï¸ ${quality} ${details.tags}`.trim(),
                providerLine: undefined,
                sourceIcon: '🔎'
            }),
            url: streamUrl,
            infoHash: item?.hash,
            behaviorHints: { notWebReady: false, bingieGroup: `Leviathan|${quality}|${serviceLabel}|${item?.hash}` }
        };
    }

    const hasSeriesContext = Boolean(meta?.isSeries || Number(meta?.season || 0) > 0 || Number(meta?.episode || 0) > 0);
    const selectorConfig = {
        ...config,
        season: hasSeriesContext ? Number(meta?.season || 0) : 0,
        episode: hasSeriesContext ? Number(meta?.episode || 0) : 0,
        mediaType: hasSeriesContext ? 'series' : 'movie',
        type: hasSeriesContext ? 'series' : 'movie',
        isSeries: hasSeriesContext,
        forceMovie: !hasSeriesContext,
        savedCloud: isSavedCloudStream,
        isSavedCloud: isSavedCloudStream,
        savedCloudService: serviceLabel
    };
    const safeIsPack = Boolean(hasSeriesContext && isPack);
    const { name, title, bingeGroup } = formatStreamSelector(parseTitle || item?.title || displayTitle, formatterSource, sizeBytes, seeders, serviceLabel, selectorConfig, item?.hash, isLazy, safeIsPack, availabilityState);
    return {
        name,
        title,
        url: streamUrl,
        infoHash: item?.hash,
        behaviorHints: { notWebReady: false, bingieGroup: bingeGroup }
    };
}

function getLanguageSignals(title, metaTitle, sourceName) {
    return getTitleDiagnostics(title, metaTitle, sourceName);
}

function keepItalianCandidate(title, sourceName, metaTitle) {
    const signals = getLanguageSignals(title, metaTitle, sourceName);
    if ((signals.explicitEng || signals.explicitOther) && !signals.explicitIta) return false;
    if (signals.explicitMulti && !signals.explicitIta) return false;
    if (signals.langInfo.isItalian || (signals.langInfo.confidence || 0) >= 4 || signals.langInfo.isMaybeItalian) return true;
    if (REGEX_SUB_ONLY.test(title) && !REGEX_AUDIO_CONFIRM.test(title)) {
        const strippedTitle = String(title || '').replace(REGEX_SUB_ONLY, ' ');
        const strippedSignals = getLanguageSignals(strippedTitle, metaTitle, sourceName);
        return strippedSignals.langInfo.isItalian || (strippedSignals.langInfo.confidence || 0) >= 4 || strippedSignals.langInfo.isMaybeItalian;
    }
    return false;
}

function keepEnglishCandidate(title, sourceName, metaTitle) {
    const signals = getLanguageSignals(title, metaTitle, sourceName);
    const rawTitle = String(title || '');
    const normalizedTitle = normalizeSearchText(rawTitle);
    const normalizedMeta = normalizeSearchText(metaTitle || '');
    const titleYearMatch = rawTitle.match(REGEX_YEAR);
    const metaYearMatch = String(metaTitle || '').match(REGEX_YEAR);
    const yearMatches = !metaYearMatch || !titleYearMatch || titleYearMatch[0] === metaYearMatch[0];

    if (signals.explicitEng) return true;
    if (signals.explicitOther && !signals.explicitEng) return false;
    if (REGEX_SUB_ONLY.test(rawTitle) && !signals.explicitEng) return false;
    if (signals.explicitIta && !signals.explicitEng) return false;
    if (signals.explicitMulti && !signals.explicitEng) return false;

    if (signals.neutralScene && yearMatches) return true;
    if (normalizedMeta && normalizedTitle.includes(normalizedMeta) && yearMatches) return true;

    return !signals.explicitOther && !signals.explicitIta && !signals.explicitMulti && yearMatches;
}

function keepAllCandidate(title, sourceName, metaTitle) {
    const signals = getLanguageSignals(title, metaTitle, sourceName);
    const rawTitle = String(title || '');
    if (keepItalianCandidate(rawTitle, sourceName, metaTitle)) return true;
    if (signals.explicitMulti) return true;
    if (keepEnglishCandidate(rawTitle, sourceName, metaTitle)) return true;
    if (signals.explicitOther && !signals.explicitEng) return false;
    return !REGEX_SUB_ONLY.test(rawTitle);
}

function getCompositeRankScore(item, meta, config) {
    const title = String(item?.title || '');
    const source = item?.source || item?.provider || null;
    const diagnostics = getTitleDiagnostics(title, meta?.title, source);
    const langInfo = diagnostics.langInfo;
    const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
    const seeders = parseInt(item?.seeders, 10) || 0;
    const explicitFileIdx = item?.fileIdx !== undefined && item?.fileIdx !== null;
    const isPack = isConfidentSeasonPackItem(item, meta, '');
    const epData = meta?.isSeries ? extractSeasonEpisodeFromFilename(title, meta?.season || 1, getEpisodeParseOptions(meta)) : null;

    const langMode = getEffectiveLangMode(config, meta);
    let score = 0;

    if (langMode === 'eng') {
        if (diagnostics.explicitEng) score += 190000;
        else if (keepEnglishCandidate(title, source, meta?.title)) score += 90000;
        if (diagnostics.explicitIta && !diagnostics.explicitEng) score -= 220000;
        else if (diagnostics.explicitIta && diagnostics.explicitEng) score -= 12000;
        if (diagnostics.explicitMulti && !diagnostics.explicitEng) score -= 70000;
        else if (diagnostics.explicitMulti && diagnostics.explicitEng) score += 16000;
        if (diagnostics.explicitOther && !diagnostics.explicitEng) score -= 120000;
    } else if (langMode === 'all') {
        if (diagnostics.explicitIta || langInfo.isItalian) score += 180000;
        else if (diagnostics.explicitEng) score += 150000;
        else if (diagnostics.explicitMulti) score += 120000;
        else if (keepAllCandidate(title, source, meta?.title)) score += 70000;
        if (diagnostics.explicitOther && !diagnostics.explicitEng && !diagnostics.explicitIta && !diagnostics.explicitMulti) score -= 90000;
    } else {
        if (langInfo.isItalian) score += 200000;
        else if (langInfo.isMaybeItalian) score += 70000;
        if (langInfo.isMulti) score += 12000;
    }

    if (REGEX_AUDIO_CONFIRM.test(title)) score += 22000;
    if (/\b(web[-.\s]?dl|blu[-.\s]?ray|remux|uhd|hevc|x265|x264|ddp|truehd|dts)\b/i.test(title)) score += 14000;
    if (/\b(4k|2160p|uhd)\b/i.test(title)) score += 9000;
    else if (/\b(1080p|fhd|full[-.\s]?hd)\b/i.test(title)) score += 7000;
    else if (/\b(720p|hd[-.\s]?rip|hdtv|hd)\b/i.test(title)) score += 4000;
    if (/\b(cam|hdcam|ts|telesync|screener|scr)\b/i.test(title)) score -= 30000;
    if (langInfo.isSubOnly) score -= 25000;
    if (explicitFileIdx) score += 7000;
    if (source && /mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo/i.test(String(source))) score += 6000;
    if (title && /mircrew|corsaro|lux|wms|dn[a4]?|idn_crew|speedvideo/i.test(title)) score += 5000;
    if (meta?.isSeries) {
        if (epData && epData.episode === meta.episode && (epData.season === meta.season || meta?.kitsu_id)) score += 24000;
        else if (isPack && new RegExp(`(?:s|season|stagione)\\s*0?${meta.season}(?!\\d)`, 'i').test(title)) score += 9000;
        else if (epData && epData.episode !== meta.episode) score -= 18000;
    }
    if (!meta?.isSeries && /\b(?:S\d{2}|SEASON|STAGIONE|\d+x\d+)\b/i.test(title)) score -= 18000;
    if (item?._packValidated) score += 15000;
    score += Math.min(seeders, 500) * 18;
    score += Math.min(Math.floor(sizeBytes / (700 * 1024 * 1024)), 1200);
    score += Math.min(title.length, 300);
    if (String(config?.service || '').toLowerCase() === 'tb' && item?._tbCached) score += 15000;
    return score;
}

function rerankCompositeResults(results, meta, config, sortMode) {
    const ranked = Array.isArray(results) ? [...results] : [];
    ranked.forEach(item => { item._compositeScore = getCompositeRankScore(item, meta, config); });
    ranked.sort((a, b) => {
        const scoreDelta = (b._compositeScore || 0) - (a._compositeScore || 0);
        const sizeA = a._size || a.sizeBytes || 0;
        const sizeB = b._size || b.sizeBytes || 0;
        if (sortMode === 'size' && sizeB !== sizeA) return sizeB - sizeA || scoreDelta;
        if (sortMode === 'resolution') {
            const getResScore = (t) => /2160p|4k|uhd/i.test(t) ? 40 : /1080p|fhd/i.test(t) ? 30 : /720p|hd/i.test(t) ? 20 : 10;
            const resDelta = getResScore(b.title || '') - getResScore(a.title || '');
            if (resDelta !== 0) return resDelta || scoreDelta;
        }
        if (scoreDelta !== 0) return scoreDelta;
        const seedDelta = (parseInt(b.seeders, 10) || 0) - (parseInt(a.seeders, 10) || 0);
        if (seedDelta !== 0) return seedDelta;
        return sizeB - sizeA;
    });
    return ranked;
}


module.exports = {
  TITLE_SIGNAL_CACHE,
  lazyResolveInflight,
  backgroundDbSaveInflight,
  titleSearchInflight,
  titleSearchHotCache,
  validatedFileSetCache,
  recentBackgroundDbSaves,
  recentPackResolutionJobs,
  STREAM_STALE_LOAD_THRESHOLD,
  BACKGROUND_DB_SAVE_DEDUP_MS,
  LAZY_WARMUP_LOAD_THRESHOLD,
  TITLE_SEARCH_HOT_TTL_MS,
  VALIDATED_FILE_SET_TTL_MS,
  TIMED_CACHE_MAX_ENTRIES,
  TIMED_CACHE_SWEEP_INTERVAL_MS,
  BACKGROUND_DB_SAVE_QUEUE_MAX,
  PACK_RESOLUTION_QUEUE_MAX,
  buildClientCacheMetadata,
  getServiceResolverLimiter,
  getNormalizedDebridService,
  getConfiguredDebridKey,
  uniqueTextList,
  isAnimeMetaContext,
  getEpisodeParseOptions,
  getEffectiveSearchLanguageMode,
  shouldIgnoreAnimeSeason,
  mapKitsuEpisodePosition,
  buildExternalAddonRequestId,
  isAnimeTmdbMetadata,
  getLazyCacheKey,
  getLazyResolveInflightKey,
  getProviderBreakerState,
  getProviderCircuitState,
  recordProviderSuccess,
  recordProviderFailure,
  resolveLazyStreamData,
  assessFastResultQuality,
  getEffectiveLangMode,
  getTimedCacheState,
  trimTimedCacheSize,
  cleanupTimedCache,
  getTimedCacheValue,
  setTimedCacheValue,
  isQueueOverflowError,
  buildTitleSearchPipelineKey,
  buildValidatedFileSetKey,
  getValidatedFileSet,
  rememberValidatedFileSet,
  detectCodecBucket,
  detectQualityBucket,
  detectReleaseGroupKey,
  buildDiversityPolicy,
  applyPackKnowledge,
  applyPremiumRankingPolicy,
  getMetaDbLookupKey,
  buildResultsSignature,
  setTitleSignalCache,
  getTitleSignalCacheKey,
  getTitleDiagnostics,
  createRuntimeItem,
  getExternalDirectUrl,
  getObservedSizeBytes,
  getObservedSeederCount,
  pad2,
  getEpisodeDisplayTitle,
  detectQualityLabel,
  getQualityFilterSignals,
  shouldDropByConfiguredQuality,
  applyConfiguredTorrentFilters,
  applyConfiguredStreamFilters,
  normalizeCandidateResults,
  escapeRegExpLocal,
  tokenizeSeriesTitle,
  extractPrimarySeriesTitle,
  hasStrongSeriesTitleMatch,
  createAggressiveResultFilter,
  isConfidentSeasonPackItem,
  resolveTorboxRankedList,
  getServiceDisplayName,
  buildPlayableStream,
  getLanguageSignals,
  keepItalianCandidate,
  keepEnglishCandidate,
  keepAllCandidate,
  getCompositeRankScore,
  rerankCompositeResults
};
