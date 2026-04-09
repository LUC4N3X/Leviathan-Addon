const axios = require("axios");
const crypto = require("crypto");

const { fetchExternalAddonsFlat } = require("./nexus-bridge");
const PackResolver = require("./pack_intelligence");
const aioFormatter = require("./lib/pulse_formatter.cjs");
const WebStreamr = require("./handlers/webstreamr_handler");
const TbCache = require("../debrid/tb_cache.js");
const { formatStreamSelector, formatBytes } = require("./lib/stream_formatter");
const P2P = require("./handlers/p2p_handler");
const { generateSmartQueries, smartMatch } = require("./media_intelligence");
const { rankAndFilterResults } = require("./lib/result_ranker");
const { tmdbToImdb, imdbToTmdb, getTmdbAltTitles } = require("./media_identity_resolver");
const RD = require("../debrid/realdebrid");
const AD = require("../debrid/alldebrid");
const TB = require("../debrid/torbox");
const dbHelper = require("./storage/db_repository"); 
const { buildMagnet: buildTrackerMagnet } = require("./storage/tracker_registry");
const { createDebridAvailabilityTools } = require("./stream/debrid_availability");
const { createWebStreamTools } = require("./stream/web_streams");
const SCRAPER_MODULES = [ require("../providers/engines") ];

const {
  logger, Cache, LIMITERS, CONFIG, REGEX_QUALITY_FILTER, REGEX_SUB_ONLY, REGEX_AUDIO_CONFIRM, REGEX_YEAR, EMPTY_STREAM_TTL, METADATA_CACHE_TTL,
  getLanguageInfo, parseTitleDetails, formatLanguageLabel, isSeasonPack, isGoodShortQueryMatch, chooseBestPackTitle, shouldUpdatePackTitle,
  extractSeasonEpisodeFromFilename, estimateVisualSize, estimateSeeders, deduplicateResults, filterByQualityLimit, extractInfoHash,
  withTimeout, normalizeSearchText, extractSeeders, extractSize, streamInflight, metadataInflight, withSharedPromise,
  incrementMetric, recordDuration, recordProviderMetric
} = require("./utils");

const REGEX_FAST_QUALITY_SIGNAL = /\b(?:2160p|4k|uhd|1080p|fhd|720p|web[-.\s]?dl|blu[-.\s]?ray|remux|hevc|x265|x264)\b/i;
const REGEX_TITLE_EXPLICIT_ENG = /\b(?:ENG|ENGLISH)\b/i;
const REGEX_TITLE_EXPLICIT_ITA = /\b(?:ITA|ITALIANO|ITALIAN)\b/i;
const REGEX_TITLE_EXPLICIT_MULTI = /\b(?:MULTI|DUAL[\s.-]?AUDIO)\b/i;
const REGEX_TITLE_EXPLICIT_OTHER = /\b(?:FRENCH|GERMAN|SPANISH|ESP|LATINO|RUS|RUSSIAN|JPN|JAP|VOSTFR|POLISH|PORTUGUESE|PT-BR|HINDI|KOREAN|CHINESE|ARABIC|TURKISH)\b/i;
const REGEX_TITLE_NEUTRAL_SCENE = /\b(?:WEB[-.\s]?DL|WEBRIP|BLU[-.\s]?RAY|REMUX|BDRIP|2160P|1080P|720P|X265|X264|HEVC|DDP|DTS|TRUEHD|AAC)\b/i;
const PROVIDER_BREAKER_DEFAULT_STATE = Object.freeze({ consecutiveFailures: 0, openUntil: 0, status: 'closed', version: 0 });

function getServiceResolverLimiter(service) {
    const normalized = String(service || '').toLowerCase();
    if (normalized === 'ad') return LIMITERS.adResolve;
    if (normalized === 'tb') return LIMITERS.tbResolve;
    return LIMITERS.rdResolve;
}

function getLazyCacheKey(service, item, meta) {
    return `${service}:${item.hash}:${meta?.season || item.season || 0}:${meta?.episode || item.episode || 0}:${item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : -1}`;
}

function getLazyResolveInflightKey(service, apiKey, item, meta) {
    const tokenSig = crypto.createHash('sha1').update(String(apiKey || '')).digest('hex').slice(0, 12);
    return `${String(service || 'rd').toLowerCase()}:${tokenSig}:${item.hash}:${meta?.season || item.season || 0}:${meta?.episode || item.episode || 0}:${item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : -1}`;
}

function getProviderBreakerState(providerName) {
    const key = String(providerName || 'unknown');
    let state = PROVIDER_BREAKERS.get(key);
    if (!state) {
        state = { ...PROVIDER_BREAKER_DEFAULT_STATE };
        PROVIDER_BREAKERS.set(key, state);
    }
    return state;
}

function cloneProviderBreakerState(state) {
    return {
        consecutiveFailures: Number(state?.consecutiveFailures || 0) || 0,
        openUntil: Number(state?.openUntil || 0) || 0,
        status: String(state?.status || 'closed'),
        version: Number(state?.version || 0) || 0
    };
}

function updateProviderBreakerState(providerName, reducer, options = {}) {
    const key = String(providerName || 'unknown');
    const retryOnConflict = options.retryOnConflict === true;
    const expectedVersion = options.expectedVersion;
    const maxAttempts = retryOnConflict ? 4 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const current = cloneProviderBreakerState(getProviderBreakerState(key));
        if (expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
            if (!retryOnConflict) return { applied: false, state: current };
        }

        const latest = cloneProviderBreakerState(getProviderBreakerState(key));
        if (latest.version !== current.version) continue;

        const next = reducer(current) || current;
        const nextState = {
            ...latest,
            ...next,
            version: current.version + 1
        };
        PROVIDER_BREAKERS.set(key, nextState);
        return { applied: true, state: cloneProviderBreakerState(nextState) };
    }

    return { applied: false, state: cloneProviderBreakerState(getProviderBreakerState(key)) };
}

function getProviderCircuitState(providerName) {
    const state = cloneProviderBreakerState(getProviderBreakerState(providerName));
    const now = Date.now();
    if (state.openUntil > now) {
        return { status: 'open', retryInMs: state.openUntil - now, version: state.version };
    }
    if (state.status === 'open' && state.openUntil <= now) {
        const transition = updateProviderBreakerState(providerName, (current) => ({
            ...current,
            status: 'half-open',
            openUntil: 0
        }), { expectedVersion: state.version });
        return { status: transition.state.status || 'closed', retryInMs: 0, version: transition.state.version };
    }
    return { status: state.status || 'closed', retryInMs: 0, version: state.version };
}

function recordProviderSuccess(providerName, expectedVersion = null) {
    return updateProviderBreakerState(providerName, (state) => ({
        ...state,
        consecutiveFailures: 0,
        openUntil: 0,
        status: 'closed'
    }), { expectedVersion, retryOnConflict: false }).state;
}

function recordProviderFailure(providerName, expectedVersion = null) {
    return updateProviderBreakerState(providerName, (state) => {
        const consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
        const isOpen = consecutiveFailures >= BREAKER_FAILURE_THRESHOLD;
        return {
            ...state,
            consecutiveFailures,
            status: isOpen ? 'open' : 'closed',
            openUntil: isOpen ? Date.now() + BREAKER_OPEN_MS : 0
        };
    }, { expectedVersion, retryOnConflict: true }).state;
}

async function resolveLazyStreamData(service, apiKey, item, meta) {
    if (!apiKey || !item?.hash) return null;
    const normalizedService = String(service || 'rd').toLowerCase();
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
        if (normalizedService === 'ad') {
            return resolverLimiter.schedule(() =>
                AD.getStreamLink(
                    apiKey,
                    item.magnet,
                    meta?.season || item.season || 0,
                    meta?.episode || item.episode || 0,
                    item.fileIdx !== undefined && item.fileIdx !== null ? item.fileIdx : 0
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

function assessFastResultQuality(items, meta, langMode, config) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
        return { shouldScrape: true, reason: 'no_fast_results', strongCount: 0, exactEpisodeCount: 0, seasonPackCount: 0, total: 0 };
    }

    let strongCount = 0;
    let exactEpisodeCount = 0;
    let seasonPackCount = 0;

    for (const item of list) {
        const title = String(item?.title || '');
        const source = String(item?.source || '');
        const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
        const seeders = parseInt(item?.seeders, 10) || 0;
        const isPack = Boolean(item?._isPack || isSeasonPack(title));
        const langOk = langMode === 'eng'
            ? keepEnglishCandidate(title, source, meta?.title)
            : langMode === 'all'
                ? keepAllCandidate(title, source, meta?.title)
                : keepItalianCandidate(title, source, meta?.title);
        const hasQualitySignal = REGEX_FAST_QUALITY_SIGNAL.test(title);
        const hasWeight = hasQualitySignal || sizeBytes >= (meta?.isSeries ? 250 : 700) * 1024 * 1024 || seeders > 0;

        let exactEpisode = false;
        if (meta?.isSeries) {
            const parsed = extractSeasonEpisodeFromFilename(title, meta.season || 1);
            exactEpisode = Boolean(parsed && parsed.season === meta.season && parsed.episode === meta.episode);
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

function getEffectiveLangMode(config) {
    const mode = String(config?.filters?.language || '').toLowerCase();
    if (mode === 'ita' || mode === 'eng' || mode === 'all') return mode;
    return config?.filters?.allowEng ? 'all' : 'ita';
}

const TITLE_SIGNAL_CACHE = new Map();
const MAX_TITLE_SIGNAL_CACHE = 4000;
const lazyResolveInflight = new Map();
const backgroundDbSaveInflight = new Map();
const recentBackgroundDbSaves = new Map();
const PROVIDER_BREAKERS = new Map();
const BREAKER_FAILURE_THRESHOLD = Math.max(2, parseInt(process.env.PROVIDER_BREAKER_THRESHOLD || '3', 10) || 3);
const BREAKER_OPEN_MS = Math.max(5000, parseInt(process.env.PROVIDER_BREAKER_OPEN_MS || '30000', 10) || 30000);
const STREAM_STALE_LOAD_THRESHOLD = Math.max(1, Math.min(200, parseInt(process.env.STREAM_STALE_LOAD_THRESHOLD || '18', 10) || 18));
const BACKGROUND_DB_SAVE_DEDUP_MS = Math.max(1000, Math.min(120000, parseInt(process.env.BACKGROUND_DB_SAVE_DEDUP_MS || '15000', 10) || 15000));
const LAZY_WARMUP_LOAD_THRESHOLD = Math.max(1, Math.min(200, parseInt(process.env.LAZY_WARMUP_LOAD_THRESHOLD || '14', 10) || 14));

function cleanupRecentMap(map, ttlMs, maxEntries = 2000) {
    if (!(map instanceof Map) || map.size === 0) return;
    const now = Date.now();
    for (const [key, ts] of map) {
        if ((now - Number(ts || 0)) > ttlMs) map.delete(key);
    }
    while (map.size > maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function shouldSkipRecentWork(map, key, ttlMs) {
    if (!key) return false;
    cleanupRecentMap(map, ttlMs);
    const now = Date.now();
    const previous = Number(map.get(key) || 0);
    if (previous > 0 && (now - previous) < ttlMs) return true;
    map.set(key, now);
    return false;
}

function getMetaDbLookupKey(meta) {
    const imdbId = String(meta?.imdb_id || '').trim().toLowerCase();
    if (!/^tt\d+$/.test(imdbId)) return null;
    const season = Number(meta?.season || 0) || 0;
    const episode = Number(meta?.episode || 0) || 0;
    return `${imdbId}:${season}:${episode}`;
}

const {
    fetchLocalDbResults,
    propagateRdKnownStatesByHash,
    hydrateRdDbStatesByHash,
    reprioritizeRdRankedList,
    getRdAvailabilityState,
    isGuaranteedCachedExternal,
    persistResolvedDebridAvailability
} = createDebridAvailabilityTools({
    Cache,
    logger,
    LIMITERS,
    CONFIG,
    incrementMetric,
    isSeasonPack,
    getMetaDbLookupKey
});

const {
    fetchWebProviderBuckets,
    formatWebProviderBuckets,
    mergeFinalStreams,
    isStreamingCommunityEnabled,
    isStreamingCommunityLastEnabled
} = createWebStreamTools({
    Cache,
    LIMITERS,
    CONFIG,
    guardedProviderCall
});

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
        explicitEng: detected.has('English') || REGEX_TITLE_EXPLICIT_ENG.test(upper),
        explicitIta: detected.has('Italian') || langInfo?.isItalian || (langInfo?.confidence || 0) >= 5 || REGEX_TITLE_EXPLICIT_ITA.test(upper),
        explicitMulti: !!langInfo?.isMulti || REGEX_TITLE_EXPLICIT_MULTI.test(upper),
        explicitOther: REGEX_TITLE_EXPLICIT_OTHER.test(upper),
        neutralScene: REGEX_TITLE_NEUTRAL_SCENE.test(upper)
    });
}

function createRuntimeItem(item, meta) {
    return {
        ...item,
        season: meta?.season ?? item?.season ?? 0,
        episode: meta?.episode ?? item?.episode ?? 0
    };
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

    return list.filter(item => {
        const sizeBytes = Number(item?._size || item?.sizeBytes || 0);
        if (filters.maxSizeGB && filters.maxSizeGB > 0 && sizeBytes > filters.maxSizeGB * 1024 * 1024 * 1024) return false;
        return !shouldDropByConfiguredQuality(item?.title || '', filters);
    });
}

function applyConfiguredStreamFilters(streams, filters = {}) {
    const list = Array.isArray(streams) ? streams : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    return list.filter(stream => !shouldDropByConfiguredQuality(`${stream?.title || ''} ${stream?.name || ''}`, filters, { treatGenericHdAs720: true }));
}

async function normalizeCandidateResults(items, meta, config) {
    let normalized = deduplicateResults(Array.isArray(items) ? items : [], meta, config);
    normalized = propagateRdKnownStatesByHash(normalized);
    normalized = await hydrateRdDbStatesByHash(normalized);
    return normalized;
}

function createAggressiveResultFilter(meta, type, langMode) {
    return (item) => {
        if (!item?.magnet) return false;

        const source = String(item.source || '').toLowerCase();
        const title = String(item.title || '');
        const lowerTitle = title.toLowerCase();

        if (source.includes('comet') || source.includes('stremthru')) return false;

        if (langMode === 'ita') {
            if (!keepItalianCandidate(title, item.source, meta.title)) return false;
        } else if (langMode === 'eng') {
            if (!keepEnglishCandidate(title, item.source, meta.title)) return false;
        } else {
            if (!keepAllCandidate(title, item.source, meta.title)) return false;
        }

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
            const season = meta.season;
            const episode = meta.episode;

            if ((meta.kitsu_id || type === 'anime') && new RegExp(`(?:^|\\s|[.\\-_\\[\\(])(?:e|ep|episode)?\\s*0*${episode}(?:$|\\s|[.\\-_\\]\\)]|v\\d)`, 'i').test(lowerTitle)) {
                return true;
            }

            const wrongSeasonRegex = /(?:s|stagione|season)\s*0?(\d+)(?!\d)/gi;
            let match;
            while ((match = wrongSeasonRegex.exec(lowerTitle)) !== null) {
                if (parseInt(match[1], 10) !== season && !meta.kitsu_id) return false;
            }

            const xMatch = lowerTitle.match(/(\d+)x(\d+)/i);
            if (xMatch) return (parseInt(xMatch[1], 10) === season || meta.kitsu_id) && parseInt(xMatch[2], 10) === episode;

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
                if (result.file_size) item._size = result.file_size;
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
    if (normalized === 'ad') return 'alldebrid';
    if (normalized === 'tb') return 'torbox';
    if (normalized === 'web') return 'web';
    return 'p2p';
}

function buildPlayableStream({ service, item, streamUrl, displayTitle, parseTitle, sizeBytes, seeders, config, meta, isLazy = false, isPack = false }) {
    const normalizedService = String(service || '').toLowerCase();
    const isAIOActive = aioFormatter.isAIOStreamsEnabled(config);
    const baseParseTitle = parseTitle || item?.title || displayTitle || '';
    const details = parseTitleDetails(baseParseTitle);
    const languageInfo = getLanguageInfo(baseParseTitle, meta?.title, item?.source, details);
    const quality = detectQualityLabel(baseParseTitle, details.quality || 'SD');
    const serviceLabel = normalizedService === 'tb' ? 'TB' : normalizedService.toUpperCase();
    const availabilityState = getRdAvailabilityState(normalizedService, item);

    if (isAIOActive) {
        return {
            name: aioFormatter.formatStreamName({ addonName: "Leviathan", service: getServiceDisplayName(normalizedService), cached: availabilityState === 'cached', cacheState: availabilityState, quality }),
            title: aioFormatter.formatStreamTitle({
                title: displayTitle,
                size: formatBytes(sizeBytes),
                language: formatLanguageLabel(languageInfo, details.languages),
                source: item?.source,
                seeders,
                infoHash: item?.hash,
                techInfo: `ðŸŽžï¸ ${quality} ${details.tags}`.trim()
            }),
            url: streamUrl,
            infoHash: item?.hash,
            behaviorHints: { notWebReady: false, bingieGroup: `Leviathan|${quality}|${serviceLabel}|${item?.hash}` }
        };
    }

    const { name, title, bingeGroup } = formatStreamSelector(parseTitle || item?.title || displayTitle, item?.source, sizeBytes, seeders, serviceLabel, config, item?.hash, isLazy, isPack, availabilityState);
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

    if (signals.explicitIta || signals.explicitMulti) return false;
    if (signals.explicitOther && !signals.explicitEng) return false;
    if (REGEX_SUB_ONLY.test(rawTitle) && !signals.explicitEng) return false;

    if (signals.explicitEng) return true;
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

function filterWebFallbackStreams(streams, langMode, meta) {
    if (!Array.isArray(streams) || streams.length === 0) return [];
    return streams.filter(stream => {
        const text = `${stream?.title || ''} ${stream?.name || ''}`.trim();
        const source = stream?.name || stream?.title || '';
        if (langMode === 'ita') return keepItalianCandidate(text, source, meta?.title);
        if (langMode === 'eng') {
            const signals = getLanguageSignals(text, meta?.title, source);
            if (signals.explicitIta || signals.explicitMulti) return false;
            if (signals.explicitEng) return true;
            if (signals.explicitOther) return false;
            return true;
        }
        return keepAllCandidate(text, source, meta?.title);
    });
}

async function guardedProviderCall(providerName, limiter, timeoutMs, factory) {
    const startedAt = Date.now();
    const circuit = getProviderCircuitState(providerName);
    if (circuit.status === 'open') {
        recordDuration(`provider.${providerName}`, 0);
        recordProviderMetric(providerName, false, 0, { breaker: 'open', retryInMs: circuit.retryInMs });
        logger.warn(`âš¡ [${providerName}] skipped by circuit breaker for ${circuit.retryInMs}ms`);
        return [];
    }

    try {
        const result = await limiter.schedule(() => withTimeout(Promise.resolve().then(factory), timeoutMs, providerName));
        const duration = Date.now() - startedAt;
        const state = recordProviderSuccess(providerName, circuit.version);
        recordDuration(`provider.${providerName}`, duration);
        recordProviderMetric(providerName, true, duration, {
            breaker: state.status,
            consecutiveFailures: state.consecutiveFailures
        });
        return Array.isArray(result) ? result : (result ? [result] : []);
    } catch (err) {
        const duration = Date.now() - startedAt;
        const isTimeout = /timeout/i.test(String(err?.message || ''));
        const state = recordProviderFailure(providerName, circuit.version);
        recordDuration(`provider.${providerName}`, duration);
        recordProviderMetric(providerName, false, duration, {
            timeout: isTimeout,
            error: err?.message || err,
            breaker: state.status,
            consecutiveFailures: state.consecutiveFailures
        });
        logger.warn(`âš ï¸ [${providerName}] failed: ${err.message}${state.status === 'open' ? ` | breaker open ${BREAKER_OPEN_MS}ms` : ''}`);
        return [];
    }
}

function warmupLazyStreamsInBackground(config, items, meta) {
    const service = String(config?.service || 'rd').toLowerCase();
    const apiKey = config?.key || config?.rd;
    if (!apiKey || !Array.isArray(items) || items.length === 0) return;
    const maxWarmups = Math.max(0, Math.min(4, parseInt(config?.filters?.warmupTop ?? process.env.LAZY_WARMUP_TOP ?? '2', 10) || 0));
    if (maxWarmups <= 0) return;
    if (streamInflight.size >= LAZY_WARMUP_LOAD_THRESHOLD) {
        incrementMetric('lazyWarmup.skippedLoad', Math.min(items.length, maxWarmups));
        logger.info(`[LAZY WARMUP] Skip sotto carico | inflight=${streamInflight.size} | threshold=${LAZY_WARMUP_LOAD_THRESHOLD}`);
        return;
    }

    items.slice(0, maxWarmups).forEach(item => {
        LIMITERS.lazyWarmup.schedule(async () => {
            const lazyCacheKey = getLazyCacheKey(service, item, meta);
            const cached = await Cache.getLazyLink(lazyCacheKey);
            if (cached?.url) return;
            const startedAt = Date.now();
            try {
                const streamData = await resolveLazyStreamData(service, apiKey, item, meta);
                if (streamData?.url) {
                    await Cache.cacheLazyLink(lazyCacheKey, streamData, 180);
                    incrementMetric('lazyWarmup.success');
                }
                recordProviderMetric(`warmup.${service}`, true, Date.now() - startedAt);
            } catch (err) {
                incrementMetric('lazyWarmup.fail');
                recordProviderMetric(`warmup.${service}`, false, Date.now() - startedAt, { timeout: /timeout/i.test(String(err?.message || '')), error: err?.message || err });
            }
        }).catch(err => logger.warn(`âš ï¸ [WARMUP] Queue error: ${err.message}`));
    });
}

async function resolvePackWithBestEffort(item, config, meta, siblingStreams = []) {
    if (!item || !item.hash) return null;
    const resolverCalls = [];
    const resolverContext = { item, config, meta, siblingStreams, dbHelper, logger, RD, TB };

    if (PackResolver && typeof PackResolver.resolvePackData === 'function') resolverCalls.push(() => PackResolver.resolvePackData(resolverContext));
    if (PackResolver && typeof PackResolver.resolvePack === 'function') resolverCalls.push(() => PackResolver.resolvePack(resolverContext));
    if (PackResolver && typeof PackResolver.resolve === 'function') {
        resolverCalls.push(() => PackResolver.resolve(resolverContext));
        resolverCalls.push(() => PackResolver.resolve(item, config, meta));
    }
    if (PackResolver && typeof PackResolver.getPackData === 'function') resolverCalls.push(() => PackResolver.getPackData(item.hash, config, meta));

    for (const call of resolverCalls) {
        try {
            const resolved = await LIMITERS.packResolver.schedule(() => Promise.resolve(call()));
            if (!resolved) continue;
            const packName = resolved.filename || resolved.packName || resolved.pack_name || resolved.title || resolved.name || null;
            const files = Array.isArray(resolved.files) ? resolved.files : (Array.isArray(resolved.videoFiles) ? resolved.videoFiles : []);
            const bestTitleData = chooseBestPackTitle(item, packName, siblingStreams);
            return { title: bestTitleData.title, titleSource: bestTitleData.source, packName, files, raw: resolved };
        } catch (err) {
            const status = Number(err?.response?.status || err?.status || 0) || null;
            if (status === 404) logger.info(`[PACK] Resolver miss for ${item.hash}: ${err.message}`);
            else logger.warn(`[PACK] Resolver error for ${item.hash}: ${err.message}`);
        }
    }
    return null;
}

async function persistPackResolution(meta, item, resolved) {
    if (!resolved || !dbHelper) return;
    const infoHash = item.hash || item.infoHash;
    if (!infoHash) return;
    try {
        if (resolved.title && resolved.title !== item.title && shouldUpdatePackTitle(item.title, resolved.title)) {
            if (typeof dbHelper.updateTorrentTitle === 'function') await dbHelper.updateTorrentTitle(infoHash, resolved.title);
        }
    } catch (err) { logger.warn(`[PACK] updateTorrentTitle failed for ${infoHash}: ${err.message}`); }

    const files = Array.isArray(resolved.files) ? resolved.files : [];
    if (files.length === 0) return;
    const seasonFallback = Number(meta?.season) > 0 ? Number(meta.season) : 1;
    const episodeFiles = [];
    const packFiles = [];

    for (const file of files) {
        const filePath = file.path || file.filename || file.name || '';
        const fileSize = Number(file.bytes || file.size || file.file_size || 0);
        if (!filePath || fileSize < 50 * 1024 * 1024) continue;
        const fileIndexRaw = file.id ?? file.file_index ?? file.index ?? file.fileIdx;
        const fileIndex = fileIndexRaw !== undefined && fileIndexRaw !== null ? parseInt(fileIndexRaw, 10) : undefined;
        const filename = filePath.split('/').pop();
        const parsedEpisode = extractSeasonEpisodeFromFilename(filename, seasonFallback);

        if (parsedEpisode && Number.isInteger(fileIndex)) {
            episodeFiles.push({ info_hash: infoHash, file_index: fileIndex, title: filename, size: fileSize, imdb_id: meta?.imdb_id || null, imdb_season: parsedEpisode.season, imdb_episode: parsedEpisode.episode });
        } else if (Number.isInteger(fileIndex)) {
            packFiles.push({ info_hash: infoHash, file_index: fileIndex, file_title: filename, size: fileSize, imdb_id: meta?.imdb_id || null, title: resolved.title || item.title });
        }
    }

    try { if (episodeFiles.length > 0 && typeof dbHelper.insertEpisodeFiles === 'function') await dbHelper.insertEpisodeFiles(episodeFiles); }
    catch (err) { logger.warn(`[PACK] insertEpisodeFiles failed for ${infoHash}: ${err.message}`); }
    try { if (packFiles.length > 0 && typeof dbHelper.insertPackFiles === 'function') await dbHelper.insertPackFiles(packFiles); }
    catch (err) { logger.warn(`[PACK] insertPackFiles failed for ${infoHash}: ${err.message}`); }
}

function resolvePackNamesInBackground(meta, results, config) {
    if (!meta || !config || !Array.isArray(results) || results.length === 0) return;
    const hasResolvableService = !!((config.service === 'rd' && (config.key || config.rd)) || (config.service === 'tb' && (config.key || config.rd || config.torbox || config.tb)));
    if (!hasResolvableService) return;
    const packCandidates = results.filter(item => item && (item._isPack || isSeasonPack(item.title)));
    if (packCandidates.length === 0) return;

    LIMITERS.bgPackJobs.schedule(async () => {
        for (const item of packCandidates) {
            try {
                const resolved = await resolvePackWithBestEffort(item, config, meta, results);
                if (resolved) await persistPackResolution(meta, item, resolved);
            } catch (err) { logger.warn(`[PACK] Background processing failed for ${item.hash || item.infoHash}: ${err.message}`); }
        }
    }).catch(err => { logger.warn(`[PACK] Background queue failed: ${err.message}`); });
}

async function fetchTmdbMeta(tmdbId, type, userApiKey) {
    if (!tmdbId) return null;
    const apiKey = (userApiKey && userApiKey.length > 1) ? userApiKey : (process.env.TMDB_API_KEY || "4b9dfb8b1c9f1720b5cd1d7efea1d845");
    const url = `https://api.themoviedb.org/3/${type === 'series' || type === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${apiKey}&language=it-IT`;
    try { const { data } = await axios.get(url, { timeout: CONFIG.TIMEOUTS.TMDB }); return data; }
    catch (e) { logger.warn(`TMDB Meta Fetch Error for ${tmdbId}: ${e.message}`); return null; }
}

async function getMetadata(id, type, config = {}) {
  const userTmdbKey = String(config?.tmdb || '');
  const metadataCacheKey = `${type}:${id}:${userTmdbKey}`;
  const cachedMeta = await Cache.getMetadata(metadataCacheKey);
  if (cachedMeta) { logger.info(`[META CACHE HIT] ${metadataCacheKey}`); return cachedMeta; }

  return withSharedPromise(metadataInflight, metadataCacheKey, async () => {
    const secondCacheHit = await Cache.getMetadata(metadataCacheKey);
    if (secondCacheHit) return secondCacheHit;
    let finalMeta = null;

    try {
      if (type === 'anime' || id.toString().startsWith('kitsu:')) {
          let kitsuId = id.toString(), episode = 0;
          if (kitsuId.includes(':')) {
              const parts = kitsuId.split(':'); kitsuId = parts[1];
              if (parts.length > 2) episode = parseInt(parts[2]);
          }
          const kitsuUrl = `${CONFIG.KITSU_URL}/meta/anime/kitsu:${kitsuId}.json`;
          logger.info(`â›©ï¸ [META] Fetching Kitsu (Direct): ${kitsuUrl}`);
          try {
              const { data } = await axios.get(kitsuUrl, { timeout: CONFIG.TIMEOUTS.TMDB });
              if (data && data.meta) {
                  const kMeta = data.meta;
                  finalMeta = { title: kMeta.name, originalTitle: kMeta.name, year: kMeta.year ? kMeta.year.split("â€“")[0] : (kMeta.releaseInfo ? kMeta.releaseInfo.substring(0, 4) : ""), imdb_id: kMeta.imdb_id || null, kitsu_id: kitsuId, isSeries: true, season: 1, episode: episode };
              }
          } catch (e) { logger.warn(`[META] Errore Kitsu: ${e.message} - fallback tentato`); }
      }

      if (!finalMeta) {
        const cleanType = (type === 'anime') ? 'series' : type;
        if (!["movie", "series"].includes(cleanType)) return null;
        let imdbId = id, season = 0, episode = 0;
        if (cleanType === "series" && id.includes(":")) {
            const parts = id.split(":"); imdbId = parts[0]; season = parseInt(parts[1]); episode = parseInt(parts[2]);
        }
        const cleanId = imdbId.match(/^(tt\d+|\d+)$/i)?.[0] || imdbId;
        if (!cleanId) return null;

        try {
            const { tmdbId } = await imdbToTmdb(cleanId, userTmdbKey);
            if (tmdbId) {
                const tmdbData = await fetchTmdbMeta(tmdbId, cleanType, userTmdbKey);
                if (tmdbData) {
                    finalMeta = { title: tmdbData.title || tmdbData.name, originalTitle: tmdbData.original_title || tmdbData.original_name, year: (tmdbData.release_date || tmdbData.first_air_date) ? (tmdbData.release_date || tmdbData.first_air_date).split("-")[0] : "", imdb_id: cleanId, tmdb_id: tmdbId, isSeries: cleanType === "series", season: season, episode: episode };
                    logger.info(`[META] Usato TMDB (UserKey: ${!!userTmdbKey}): ${finalMeta.title} (${finalMeta.year}) [ID: ${tmdbId}] Orig: ${finalMeta.originalTitle}`);
                }
            }
        } catch (err) { logger.warn(`[META] Errore TMDB, fallback a Cinemeta: ${err.message}`); }

        if (!finalMeta) {
          logger.info(`[META] Fallback a Cinemeta per ${cleanId}`);
          const { data: cData } = await axios.get(`${CONFIG.CINEMETA_URL}/meta/${cleanType}/${cleanId}.json`, { timeout: CONFIG.TIMEOUTS.TMDB }).catch(() => ({ data: {} }));
          finalMeta = cData?.meta ? { title: cData.meta.name, originalTitle: cData.meta.name, year: cData.meta.year?.split("â€“")[0], imdb_id: cleanId, isSeries: cleanType === "series", season: season, episode: episode } : null;
        }
      }
    } catch (err) { logger.error(`Errore getMetadata Critical: ${err.message}`); finalMeta = null; }

    if (finalMeta) await Cache.cacheMetadata(metadataCacheKey, finalMeta, METADATA_CACHE_TTL);
    return finalMeta;
  });
}

function saveResultsToDbBackground(meta, results, config = null) {
    if (!results || results.length === 0) return;
    const metaCacheKey = getMetaDbLookupKey(meta);
    const resultsSignature = buildResultsSignature(results);
    const saveKey = `${metaCacheKey || meta?.imdb_id || 'n/a'}:${resultsSignature || 'empty'}`;
    if (shouldSkipRecentWork(recentBackgroundDbSaves, saveKey, BACKGROUND_DB_SAVE_DEDUP_MS)) {
        incrementMetric('dbSave.skippedRecent');
        return;
    }

    withSharedPromise(backgroundDbSaveInflight, `db_save:${saveKey}`, async () => {
        let savedCount = 0;
        const prioritizedHashes = [];
        const guaranteedCachedUpdates = [];
        for (const item of results) {
            const torrentObj = { info_hash: item.hash || item.infoHash, title: item.title, size: item._size || item.sizeBytes || 0, seeders: item.seeders || 0, provider: item.source || 'External', file_index: item.fileIdx !== undefined ? item.fileIdx : undefined, is_pack: item._isPack || isSeasonPack(item.title) };
            if (!torrentObj.info_hash) continue;
            const success = await dbHelper.insertTorrent(meta, torrentObj);
            if (success) savedCount++;
            if (isGuaranteedCachedExternal(item)) {
                guaranteedCachedUpdates.push({
                    hash: torrentObj.info_hash,
                    cached: true,
                    rd_file_size: Number(item?._size || item?.sizeBytes || 0) > 0 ? Number(item._size || item.sizeBytes) : null,
                    failures: 0,
                    next_hours: 24 * 30
                });
                continue;
            }
            if (String(config?.service || 'rd').toLowerCase() === 'rd' && prioritizedHashes.length < 18 && getRdAvailabilityState('rd', item) === 'unknown') {
                prioritizedHashes.push(torrentObj.info_hash);
            }
        }
        if (savedCount > 0) console.log(`[AUTO-LEARN] Salvati ${savedCount} nuovi torrent nel DB per ${meta.imdb_id}`);
        if (guaranteedCachedUpdates.length > 0 && typeof dbHelper.updateRdCacheStatus === 'function') {
            await dbHelper.updateRdCacheStatus(guaranteedCachedUpdates);
            await Cache.invalidateStreamsByHashes(guaranteedCachedUpdates.map((entry) => entry.hash), 'external_cached_seed');
            logger.info(`[RD AVAILABILITY] Marked guaranteed external results as cached | imdb=${meta.imdb_id || 'n/a'} | hashes=${guaranteedCachedUpdates.length}`);
        }
        if (prioritizedHashes.length > 0 && typeof dbHelper.prioritizeRdHashes === 'function') {
            const outcome = await dbHelper.prioritizeRdHashes(prioritizedHashes, { limit: 18, priorityMinutes: Math.max(0, Math.min(120, parseInt(process.env.RD_PRIORITY_WINDOW_MIN || '5', 10) || 5)) });
            logger.info(`[RD PRIORITY] reason=db_save | imdb=${meta.imdb_id || 'n/a'} | hashes=${prioritizedHashes.length} | updated=${outcome?.updated || 0}`);
        }
        if (metaCacheKey) await Cache.invalidateDbTorrents(metaCacheKey, 'db_save');
        resolvePackNamesInBackground(meta, results, config);
    }).catch(err => console.error("[AUTO-LEARN] Errore background save:", err.message));
}

async function resolveDebridLink(config, item, showFake, reqHost, meta) {
    try {
        const service = config.service || 'rd';
        const apiKey = config.key || config.rd;
        if (!apiKey) return null;

        const isPack = item._isPack || isSeasonPack(item.title);
        const isSeries = (meta?.season > 0 || meta?.episode > 0);
        const displayTitle = (aioFormatter.isAIOStreamsEnabled(config) && isPack && isSeries && meta) ? getEpisodeDisplayTitle(meta, item.title) : item.title;
        const runtimeItem = createRuntimeItem(item, meta);
        const rawConf = config?.rawConf || '';

        if (service === 'tb') {
            if (!item._tbCached) return null;
            const realSize = estimateVisualSize(item._size || item.sizeBytes || 0, item.title, isSeries, isPack, item.hash);
            const finalSeeders = estimateSeeders(item.seeders, item.hash);
            const proxyUrl = `${reqHost}/${rawConf}/play_tb/${item.hash}?s=${runtimeItem.season || 0}&e=${runtimeItem.episode || 0}&f=${(item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1}`;
            return buildPlayableStream({
                service: 'tb',
                item: runtimeItem,
                streamUrl: proxyUrl,
                displayTitle,
                parseTitle: item.title,
                sizeBytes: realSize,
                seeders: finalSeeders,
                config,
                meta,
                isPack
            });
        }

        let streamData = null;
        if (service === 'rd') streamData = await RD.getStreamLink(apiKey, item.magnet, runtimeItem.season, runtimeItem.episode, item.fileIdx);
        else if (service === 'ad') streamData = await AD.getStreamLink(apiKey, item.magnet, runtimeItem.season, runtimeItem.episode, item.fileIdx);

        if (!streamData || (streamData.type === "ready" && streamData.size < CONFIG.REAL_SIZE_FILTER)) return null;

        const parseTitle = streamData.filename || item.title;
        const finalSize = estimateVisualSize(streamData.size || item._size || item.sizeBytes || 0, parseTitle, isSeries, isPack, item.hash);
        const finalSeeders = estimateSeeders(item.seeders, item.hash);
        runtimeItem._rdCacheState = 'cached';
        runtimeItem.rdCacheState = 'cached';
        runtimeItem._dbCachedRd = true;
        runtimeItem.cached_rd = true;
        if (Number.isFinite(Number(streamData.size)) && Number(streamData.size) > 0) {
            runtimeItem._size = Number(streamData.size);
            runtimeItem.sizeBytes = Number(streamData.size);
        }
        await persistResolvedDebridAvailability(meta, runtimeItem, streamData, service, 'direct_resolve');

        return buildPlayableStream({
            service,
            item: runtimeItem,
            streamUrl: streamData.url,
            displayTitle,
            parseTitle,
            sizeBytes: finalSize,
            seeders: finalSeeders,
            config,
            meta,
            isPack
        });
    } catch (e) {
        if (showFake) {
            return {
                name: `[P2P WARNING]`,
                title: `${item.title}\nâš ï¸ Cache Assente`,
                url: item.magnet,
                behaviorHints: { notWebReady: true }
            };
        }
        return null;
    }
}

function generateLazyStream(item, config, meta, reqHost, userConfStr, isLazy = false) {
    const service = config.service || 'rd';
    const isPack = item._isPack || isSeasonPack(item.title);
    const isSeries = (meta.season > 0 || meta.episode > 0);
    const runtimeItem = createRuntimeItem(item, meta);

    let displayTitle = item.title;
    let realSize = item._size || item.sizeBytes || 0;

    if (aioFormatter.isAIOStreamsEnabled(config) && isPack && isSeries) {
        realSize = 0;
        displayTitle = getEpisodeDisplayTitle(meta, item.title);
    }

    realSize = estimateVisualSize(realSize, displayTitle, isSeries, isPack, item.hash);
    const finalSeeders = estimateSeeders(item.seeders, item.hash);
    const imdbParam = meta?.imdb_id ? `&imdb=${encodeURIComponent(meta.imdb_id)}` : '';
    const lazyUrl = `${reqHost}/${userConfStr}/play_lazy/${service}/${item.hash}/${(item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1}?s=${meta.season || 0}&e=${meta.episode || 0}${imdbParam}`;
    const lazyCacheKey = `${service}:${item.hash}:${meta.season || 0}:${meta.episode || 0}:${(item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1}`;
    Cache.cacheLazyMeta(lazyCacheKey, {
        imdb_id: meta?.imdb_id || null,
        season: meta?.season || 0,
        episode: meta?.episode || 0,
        type: isSeries ? 'series' : 'movie',
        title: item?.title || displayTitle || null,
        source: item?.source || null,
        seeders: Number(item?.seeders || 0) || 0,
        size: Number(realSize || item?._size || item?.sizeBytes || 0) || 0,
        fileIdx: (item.fileIdx !== undefined && !isNaN(item.fileIdx)) ? item.fileIdx : -1
    }, 43200).catch(() => {});

    return buildPlayableStream({
        service,
        item: runtimeItem,
        streamUrl: lazyUrl,
        displayTitle,
        parseTitle: item.title,
        sizeBytes: realSize,
        seeders: finalSeeders,
        config,
        meta,
        isLazy,
        isPack
    });
}

async function queryRemoteIndexer(tmdbId, type, season = null, episode = null, config, italianMovieTitle = null) { 
    if (!CONFIG.INDEXER_URL) return [];
    try {
        logger.info(`[REMOTE] Query VPS: ${CONFIG.INDEXER_URL} | ID: ${tmdbId} S:${season} E:${episode}`);
        let url = `${CONFIG.INDEXER_URL}/api/get/${tmdbId}`;
        if (season) url += `?season=${season}`;
        if (episode) url += `&episode=${episode}`;
        const { data } = await axios.get(url, { timeout: CONFIG.TIMEOUTS.REMOTE_INDEXER });
        if (!data || !data.torrents || !Array.isArray(data.torrents)) return [];
        
        const mapped = data.torrents.map(t => {
            let magnet = t.magnet || buildTrackerMagnet(t.info_hash, t.title);
            if (!String(magnet).includes("tr=")) magnet = buildTrackerMagnet(t.info_hash, t.title);
            let providerName = (t.provider || 'P2P').replace(/LeviathanDB/i, '').replace(/[()]/g, '').trim() || 'P2P';
            const finalHash = t.info_hash ? t.info_hash.toUpperCase() : extractInfoHash(magnet);
            return { title: t.title, magnet: magnet, hash: finalHash, infoHash: finalHash, size: "DB Cache", sizeBytes: parseInt(t.size), seeders: parseInt(t.seeders, 10) || 0, source: providerName, fileIdx: t.file_index !== undefined ? parseInt(t.file_index) : undefined, _isPack: isSeasonPack(t.title) };
        });

        const langMode = getEffectiveLangMode(config);
        return mapped.filter(item => {
             const title = item.title || '';
             if (langMode === 'ita') return keepItalianCandidate(title, item.source, italianMovieTitle);
             if (langMode === 'eng') return keepEnglishCandidate(title, item.source, italianMovieTitle);
             return keepAllCandidate(title, item.source, italianMovieTitle);
        });
    } catch (e) { logger.error("Err Remote Indexer:", { error: e.message }); return []; }
}

async function fetchExternalResults(type, finalId, config) {
    logger.info(`[EXTERNAL] Start Parallel Fetch...`);
    try {
        const externalResults = await withTimeout(
            fetchExternalAddonsFlat(type, finalId, { userConfig: config }).then(items => items.map(i => {
                const title = i.title || i.filename;
                let finalSeeders = parseInt(i.seeders, 10) || (title ? extractSeeders(title) : 0);
                let finalSize = i.mainFileSize || (title ? extractSize(title) : 0);
                return {
                    title: title,
                    magnet: i.magnetLink,
                    size: i.size || (finalSize > 0 ? formatBytes(finalSize) : null),
                    sizeBytes: finalSize,
                    seeders: finalSeeders,
                    source: i.externalProvider || i.source.replace(/\[EXT\]\s*/, ''),
                    hash: i.infoHash || extractInfoHash(i.magnetLink),
                    infoHash: i.infoHash || extractInfoHash(i.magnetLink),
                    fileIdx: i.fileIdx,
                    isExternal: true,
                    _isPack: isSeasonPack(title),
                    _rdCacheState: 'cached',
                    rdCacheState: 'cached',
                    _dbCachedRd: true,
                    cached_rd: true
                };
            })),
            CONFIG.TIMEOUTS.EXTERNAL, 'External Addons'
        );
        if (externalResults && externalResults.length > 0) {
            logger.info(`[EXTERNAL] Trovati ${externalResults.length} risultati`);
            return externalResults;
        } else {
            logger.info(`[EXTERNAL] Nessun risultato trovato.`);
            return [];
        }
    } catch (err) { logger.warn('External Addons fallito/timeout', { error: err.message }); return []; }
}

async function generateStream(type, id, config, userConfStr, reqHost) {
  const hasDebridKey = (config.key && config.key.length > 0) || (config.rd && config.rd.length > 0);
  const isWebEnabled = config.filters && (isStreamingCommunityEnabled(config.filters) || config.filters.enableGhd || config.filters.enableGs || config.filters.enableAnimeWorld || config.filters.enableGf);
  const isP2PEnabled = config.filters && config.filters.enableP2P === true;

  if (!hasDebridKey && !isWebEnabled && !isP2PEnabled) return { streams: [{ name: "CONFIG", title: "Inserisci API Key, attiva P2P o attiva WebStream" }] };

  const configHash = crypto.createHash('md5').update(userConfStr || 'no-conf').digest('hex');
  const cacheKey = `${type}:${id}:${configHash}`;
  const inflightKey = `stream:${cacheKey}`;

  const cachedResult = await Cache.getCachedStream(cacheKey);
  if (cachedResult) return cachedResult;

  if (streamInflight.has(inflightKey)) {
      const staleResult = await Cache.getStaleStream(cacheKey);
      if (staleResult) {
          incrementMetric('stream.generate.staleWhileRefresh');
          if (streamInflight.size >= STREAM_STALE_LOAD_THRESHOLD) incrementMetric('stream.generate.staleLoadShield');
          return staleResult;
      }
  }

  return withSharedPromise(streamInflight, inflightKey, async () => {
      const cachedAgain = await Cache.getCachedStream(cacheKey);
      if (cachedAgain) return cachedAgain;

      const generationStartedAt = Date.now();
      incrementMetric('stream.generate.calls');

      const userTmdbKey = config.tmdb;
      let finalId = id.replace('ai-recs:', '');

      if (finalId.startsWith('tmdb:')) {
          try {
              const parts = finalId.split(':');
              const imdbId = await tmdbToImdb(parts[1], type, userTmdbKey);
              if (imdbId) finalId = (type === 'series' && parts.length >= 4) ? `${imdbId}:${parts[2]}:${parts[3]}` : imdbId;
          } catch (err) {}
      }

      const meta = await LIMITERS.metadata.schedule(() => getMetadata(finalId, type, config));
      if (!meta) return { streams: [] };

      logger.info(`[SPEED] Start search for: ${meta.title}`);

      const localDbResults = await fetchLocalDbResults(meta);
      if (localDbResults.length > 0) logger.info(`[DB READ] Trovati ${localDbResults.length} torrent dal DB locale.`);

      const tmdbIdLookup = meta.tmdb_id || (meta.kitsu_id ? null : (await imdbToTmdb(meta.imdb_id, userTmdbKey))?.tmdbId);
      const dbOnlyMode = config.filters?.dbOnly === true;
      const langMode = config.filters?.language || (config.filters?.allowEng ? 'all' : 'ita');
      const allowItalianWebProviders = langMode !== 'eng';
      const aggressiveFilter = createAggressiveResultFilter(meta, type, langMode);

      const remotePromise = Cache.fetchWithCache('RemoteIndexer', `${type}:${tmdbIdLookup || finalId}:${meta.season}:${meta.episode}`, 43200, () =>
          guardedProviderCall('RemoteIndexer', LIMITERS.remoteIndexer, CONFIG.TIMEOUTS.REMOTE_INDEXER, () => queryRemoteIndexer(tmdbIdLookup, type, meta.season, meta.episode, config, meta.title))
      );

      let externalPromise = Promise.resolve([]);
      if (!dbOnlyMode) {
          externalPromise = Cache.fetchWithCache('ExternalAddons', `${type}:${finalId}`, 43200, () =>
              guardedProviderCall('ExternalAddons', LIMITERS.externalAddons, CONFIG.TIMEOUTS.EXTERNAL, () => fetchExternalResults(type, finalId, config))
          );
      }

      const [remoteSettled, externalSettled] = await Promise.allSettled([remotePromise, externalPromise]);
      const remoteResults = remoteSettled.status === 'fulfilled' ? remoteSettled.value : [];
      const externalResults = externalSettled.status === 'fulfilled' ? externalSettled.value : [];
      logger.info(`[STATS] Remote: ${remoteResults.length} | External: ${externalResults.length}`);

      const fastResults = [...localDbResults, ...remoteResults, ...externalResults].filter(aggressiveFilter);
      let cleanResults = await normalizeCandidateResults(fastResults, meta, config);
      let validFastCount = cleanResults.length;
      logger.info(`[FAST CHECK] Trovati ${validFastCount} risultati validi da fonti veloci (Remote+External).`);

      const fastPoolAssessment = assessFastResultQuality(cleanResults, meta, langMode, config);
      if (fastPoolAssessment.shouldScrape && !dbOnlyMode) {
          logger.info(`âš ï¸ [FALLBACK] Fast pool debole (${fastPoolAssessment.reason}) | total=${fastPoolAssessment.total} strong=${fastPoolAssessment.strongCount} exact=${fastPoolAssessment.exactEpisodeCount} pack=${fastPoolAssessment.seasonPackCount}. Avvio Scrapers...`);

          let dynamicTitles = [];
          try {
              if (tmdbIdLookup) dynamicTitles = await getTmdbAltTitles(tmdbIdLookup, type, userTmdbKey);
          } catch (e) {}

          const allowEngScraper = (langMode === 'all' || langMode === 'eng');
          const rawQueries = generateSmartQueries({ ...meta, langMode }, dynamicTitles, langMode);
          const queries = (() => {
              const deduped = [];
              const seen = new Set();

              for (const q of rawQueries) {
                  const key = normalizeSearchText(q);
                  if (!key || seen.has(key)) continue;
                  seen.add(key);
                  deduped.push(q);
              }

              if (langMode === 'eng') {
                  const noIta = deduped.filter(q => !/\b(?:ita|multi)\b/i.test(q));
                  const yearQueries = noIta.filter(q => meta.year && new RegExp(`\\b${meta.year}\\b`).test(q));
                  const plainQueries = noIta.filter(q => !/\b(?:19|20)\d{2}\b/.test(q));
                  const selected = [];

                  for (const q of [...yearQueries, ...plainQueries, ...noIta]) {
                      if (selected.includes(q)) continue;
                      selected.push(q);
                      if (selected.length >= 4) break;
                  }

                  return selected;
              }

              if (langMode === 'all') return deduped.slice(0, 8);
              return deduped;
          })();

          const scraperTimeout = langMode === 'eng'
              ? Math.max(CONFIG.TIMEOUTS.SCRAPER || 4000, 12000)
              : langMode === 'all'
                  ? Math.max(CONFIG.TIMEOUTS.SCRAPER || 4000, 10000)
                  : (CONFIG.TIMEOUTS.SCRAPER || 4000);

          if (queries.length > 0) {
              logger.info(`[SCRAPER PLAN] lang=${langMode} queries=${queries.length} timeout=${scraperTimeout}ms`);
              const allScraperTasks = [];

              queries.forEach(q => SCRAPER_MODULES.forEach(scraper => {
                  if (scraper.searchMagnet) {
                      allScraperTasks.push(LIMITERS.scraper.schedule(() =>
                          withTimeout(scraper.searchMagnet(q, meta.year, type, finalId, { langMode, allowEng: allowEngScraper }), scraperTimeout, `Scraper ${scraper.name || 'Module'}`)
                              .catch(err => {
                                  logger.warn(`Scraper Timeout/Error: ${err.message}`);
                                  return [];
                              })
                      ));
                  }
              }));

              const scrapedResultsRaw = (await Promise.allSettled(allScraperTasks)).flatMap(result => result.status === 'fulfilled' ? result.value : []);
              cleanResults = await normalizeCandidateResults([...cleanResults, ...scrapedResultsRaw.filter(aggressiveFilter)], meta, config);
              validFastCount = cleanResults.length;
              logger.info(`[STATS SCRAPER] Trovati e filtrati ${validFastCount} risultati aggiuntivi dagli Scraper.`);
          }
      }

      if (!dbOnlyMode) saveResultsToDbBackground(meta, cleanResults, config);

      cleanResults = applyConfiguredTorrentFilters(cleanResults, config.filters || {});

      let rankedList = rankAndFilterResults(cleanResults, meta, config);

      if (config.filters && config.filters.maxPerQuality) rankedList = filterByQualityLimit(rankedList, config.filters.maxPerQuality);

      rankedList = await reprioritizeRdRankedList(rankedList, meta, config, hasDebridKey);

      if (config.service === 'tb' && hasDebridKey) {
          const apiKey = config.key || config.rd;
          rankedList = await resolveTorboxRankedList(rankedList, apiKey);
      }

      const finalRanked = rankedList.slice(0, CONFIG.MAX_RESULTS);
      let debridStreams = [];

      if (finalRanked.length > 0 && hasDebridKey) {
          const TOP_LIMIT = Math.max(0, Math.min(10, parseInt(config.filters?.instantDebridTop ?? process.env.INSTANT_DEBRID_TOP ?? '0', 10) || 0));
          const serviceLimiter = getServiceResolverLimiter(config.service);
          const resolverConfig = { ...config, rawConf: userConfStr };
          const immediatePromises = finalRanked.slice(0, TOP_LIMIT).map(item => {
              const runtimeItem = createRuntimeItem(item, meta);
              return serviceLimiter.schedule(() => resolveDebridLink(resolverConfig, runtimeItem, config.filters?.showFake, reqHost, meta));
          });
          const lazyCandidates = finalRanked.slice(TOP_LIMIT).map(item => createRuntimeItem(item, meta));
          const lazyStreams = lazyCandidates.map(item => generateLazyStream(item, config, meta, reqHost, userConfStr, true));
          const resolvedInstant = (await Promise.allSettled(immediatePromises)).flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
          debridStreams = [...resolvedInstant, ...lazyStreams];
          warmupLazyStreamsInBackground(config, lazyCandidates, meta);
      } else if (finalRanked.length > 0 && isP2PEnabled) {
          logger.info(`[P2P MODE] Generating direct streams for ${meta.title}`);
          debridStreams = finalRanked.map(item => P2P.formatP2PStream(item, config));
      }

      const rawWebBuckets = await fetchWebProviderBuckets({
          type,
          originalId: id,
          finalId,
          meta,
          config,
          reqHost,
          allowItalianWebProviders,
          dbOnlyMode
      });

      const formattedWebBuckets = formatWebProviderBuckets(rawWebBuckets, meta, config);
      let finalStreams = mergeFinalStreams(debridStreams, formattedWebBuckets, config.filters || {});
      finalStreams = applyConfiguredStreamFilters(finalStreams, config.filters || {});

      if (finalStreams.length === 0) {
          logger.info(`[FALLBACK] Nessun risultato trovato (P2P/Web Locali). Attivo WebStreamr...`);
          const webStreamrResults = filterWebFallbackStreams(await searchWebStreamr(type, finalId), langMode, meta);
          if (webStreamrResults.length > 0) {
              finalStreams.push(...webStreamrResults);
              logger.info(`[WEBSTREAMR] Aggiunti ${webStreamrResults.length} stream di fallback.`);
          } else {
              logger.info(`[WEBSTREAMR] Nessun risultato trovato.`);
          }
      }

      const resultObj = { streams: finalStreams, cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 };
      const streamTtl = finalStreams.length > 0 ? 1800 : EMPTY_STREAM_TTL;

      await Cache.cacheStream(cacheKey, resultObj, streamTtl, {
          imdbId: meta?.imdb_id || null,
          hashes: cleanResults.map((item) => item?.hash || item?.infoHash).filter(Boolean)
      });

      recordDuration('stream.generate.total', Date.now() - generationStartedAt);
      incrementMetric(finalStreams.length > 0 ? 'stream.generate.nonEmpty' : 'stream.generate.empty');
      logger.info(`[CACHE] SAVED: ${cacheKey} (ttl=${streamTtl}s, streams=${finalStreams.length})`);

      return resultObj;
  });
}

module.exports = { generateStream, getMetadata, resolveDebridLink, resolveLazyStreamData, RD, AD, TB };
