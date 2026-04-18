require('dotenv').config();

require("./utils_http");

const {
    logger,
    runtimeMetrics,
    incrementMetric,
    recordDuration,
    recordProviderMetric,
    getCacheSnapshot
} = require("./utils_runtime");
const { safeCompare, withSharedPromise } = require("./utils_common");
const { TRACKERS, buildTrackerMagnet } = require("./utils_torrent");
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
} = require("./utils_cache");
const {
    ADMIN_PASS,
    MAX_CONFIG_LENGTH,
    decodeConfigBase64,
    getConfig
} = require("./utils_config");
const {
    REGEX_YEAR,
    REGEX_QUALITY_FILTER,
    REGEX_STRONG_ITA,
    REGEX_CONTEXT_IT,
    REGEX_ISOLATED_IT,
    REGEX_MULTI_ITA,
    REGEX_TRUSTED_GROUPS,
    REGEX_FALSE_IT,
    REGEX_SUB_ONLY,
    REGEX_AUDIO_CONFIRM,
    languageMapping,
    normalizeLanguageName,
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
} = require("./utils_text");
const { LIMITERS, getLimiterStats } = require("./utils_limits");
const sourceHealth = require('./lib/source_health');
const { annotateResult, compareRankedItems } = require("./lib/result_ranker");

const CONFIG = {
  INDEXER_URL: process.env.INDEXER_URL || "",
  CINEMETA_URL: "https://v3-cinemeta.strem.io",
  KITSU_URL: "https://anime-kitsu.strem.fun",
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

function base32ToHex(base32) {
    const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "", hex = "";
    for (let i = 0; i < base32.length; i++) bits += base32chars.indexOf(base32.charAt(i).toUpperCase()).toString(2).padStart(5, '0');
    for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.substr(i, 4), 2).toString(16);
    return hex;
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    if (!match) return null;
    const hash = match[1];
    return hash.length === 32 ? base32ToHex(hash).toUpperCase() : hash.toUpperCase();
}

function estimateVisualSize(knownSize, title, isSeries, isPack, infoHash) {
    const safeTitle = (title || "video").toLowerCase();
    const is4K = /2160p|4k|uhd|ultra[-.\s]?hd/i.test(safeTitle);
    const is1080 = /1080p|1080i|fhd|full[-.\s]?hd|blu[-.\s]?ray/i.test(safeTitle);
    const is720 = /720p|720i|hd[-.\s]?rip|hd/i.test(safeTitle);

    if (knownSize && knownSize > 0) {
        let isSane = true;
        const sizeInGB = knownSize / (1024 * 1024 * 1024);
        if (!isPack) {
            if (isSeries) {
                if (is4K && sizeInGB > 15) isSane = false;
                else if (is1080 && sizeInGB > 6) isSane = false;
                else if (is720 && sizeInGB > 3) isSane = false;
                else if (!is4K && !is1080 && !is720 && sizeInGB > 1.5) isSane = false;
            } else {
                if (is4K && sizeInGB > 100) isSane = false;
                else if (is1080 && sizeInGB > 40) isSane = false;
                else if (is720 && sizeInGB > 12) isSane = false;
                else if (!is4K && !is1080 && !is720 && sizeInGB > 5) isSane = false;
            }
        }
        if (isSane) return knownSize;
    }

    let seedStr = infoHash || safeTitle;
    let hashVal = 0;
    for (let i = 0; i < seedStr.length; i++) hashVal = (Math.imul(31, hashVal) + seedStr.charCodeAt(i)) | 0;
    hashVal = Math.abs(hashVal);

    const seededRandom = () => {
        hashVal = (Math.imul(1664525, hashVal) + 1013904223) | 0;
        return (Math.abs(hashVal) % 100000) / 100000;
    };

    let baseSize = 0;
    if (isSeries) {
        if (is4K) baseSize = 1.8 * 1024**3 + (seededRandom() * 4.7 * 1024**3);
        else if (is1080) baseSize = 800 * 1024**2 + (seededRandom() * 2.4 * 1024**3);
        else if (is720) baseSize = 300 * 1024**2 + (seededRandom() * 900 * 1024**2);
        else baseSize = 150 * 1024**2 + (seededRandom() * 450 * 1024**2);
    } else {
        if (is4K) baseSize = 12 * 1024**3 + (seededRandom() * 53 * 1024**3);
        else if (is1080) baseSize = 1.8 * 1024**3 + (seededRandom() * 12.2 * 1024**3);
        else if (is720) baseSize = 800 * 1024**2 + (seededRandom() * 3.2 * 1024**3);
        else baseSize = 700 * 1024**2 + (seededRandom() * 1.1 * 1024**3);
    }
    return Math.floor(baseSize + Math.floor(seededRandom() * 1024 * 1024 * 5));
}

function estimateSeeders(knownSeeders, infoHash) {
    if (knownSeeders && knownSeeders > 0) return knownSeeders;
    let seedStr = infoHash || "seeders_fallback", hashVal = 0;
    for (let i = 0; i < seedStr.length; i++) hashVal = (Math.imul(31, hashVal) + seedStr.charCodeAt(i)) | 0;
    return (Math.abs(hashVal) % 60) + 8;
}

function getStatsSnapshot() {
    return {
        status: 'ok',
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
        limiters: getLimiterStats()
    };
}

function normalizeAnimeEpisodeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[【】「」『』［］（）]/g, ' ')
        .replace(/[‐‑–—―〜～]/g, '-')
        .replace(/[·・]/g, ' ')
        .replace(/第\s*([0-9]{1,2})\s*[期季]/gi, ' season $1 ')
        .replace(/第\s*([0-9]{1,4})\s*[話话]/gi, ' episode $1 ')
        .replace(/\b(?:cour|part|pt)\s*([0-9]{1,2})\b/gi, ' season $1 ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractAnimeEpisodeRange(filename, defaultSeason = 1) {
    const name = normalizeAnimeEpisodeText(filename);
    const patterns = [
        /\bseason\s*0?(\d{1,2})\s*(?:batch|pack|complete|collection)?\s*0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i,
        /\b(?:episodes?|eps?|episode|episodio)\s*0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i,
        /\b0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i
    ];

    for (const pattern of patterns) {
        const match = name.match(pattern);
        if (!match) continue;
        const hasExplicitSeason = pattern === patterns[0];
        const season = hasExplicitSeason ? parseInt(match[1], 10) : defaultSeason;
        const start = parseInt(match[hasExplicitSeason ? 2 : 1], 10);
        const end = parseInt(match[hasExplicitSeason ? 3 : 2], 10);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) continue;
        if (start >= 1900 && start <= 2100) continue;
        if (end >= 1900 && end <= 2100) continue;
        const hasBatchCue = /\b(?:batch|complete|collection|pack|season|stagione|episodes?|eps?|cour|全集|合集)\b/i.test(name) || /第\s*\d+\s*[話话]/i.test(String(filename || ''));
        if (!hasBatchCue && end - start > 4) continue;
        return { season, episode: start, rangeStart: start, rangeEnd: end, isRange: true, isBatch: true };
    }

    return null;
}

function extractAnimeEpisodeFromFilename(filename, defaultSeason = 1) {
    const originalName = String(filename || '');
    const name = normalizeAnimeEpisodeText(originalName);
    let match = name.match(/\bS(?:EASON)?\s*0?(\d{1,2})\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = name.match(/\b(\d{1,2})(?:ST|ND|RD|TH)\s+SEASON\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = name.match(/\bSEASON\s*0?(\d{1,2}).{0,16}?EP(?:ISODE)?\s*0?(\d{1,4})(?:v\d+)?\b/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = name.match(/\b(?:EP(?:ISODE)?|EPISODIO)\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: defaultSeason, episode: parseInt(match[1], 10) };

    const range = extractAnimeEpisodeRange(originalName, defaultSeason);
    if (range) return range;

    match = name.match(/(?:^|\s)#?0*([1-9]\d{0,3})(?:v\d+)?(?=$|\s)/i);
    if (match) {
        const episode = parseInt(match[1], 10);
        if (!(episode >= 1900 && episode <= 2100) && ![2160, 1080, 720, 576, 480, 360, 264, 265].includes(episode)) {
            return { season: defaultSeason, episode };
        }
    }

    const genericPattern = /(?:^|[\s._\-\[\(])0*([1-9]\d{0,3})(?:v\d+)?(?=$|[\s._\-\]\)])/ig;
    for (const candidate of name.matchAll(genericPattern)) {
        const episode = parseInt(candidate[1], 10);
        if (!Number.isInteger(episode) || episode <= 0) continue;
        if (episode >= 1900 && episode <= 2100) continue;
        if ([2160, 1080, 720, 576, 480, 360, 264, 265].includes(episode)) continue;
        return { season: defaultSeason, episode };
    }

    return null;
}

function extractSeasonEpisodeFromFilename(filename, defaultSeason = 1, options = {}) {
    const name = normalizeAnimeEpisodeText(filename);
    const patterns = [
        /\bS(\d{1,2})E(\d{1,3})\b/i,
        /\b(\d{1,2})x(\d{1,3})\b/i,
        /\bSEASON\s*(\d{1,2}).{0,20}?EPISODE\s*(\d{1,3})\b/i,
        /\bSTAGIONE\s*(\d{1,2}).{0,20}?EPISODIO\s*(\d{1,3})\b/i
    ];

    for (const pattern of patterns) {
        const match = name.match(pattern);
        if (!match) continue;
        return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    }

    const episodeOnly = name.match(/\bE(?:P(?:ISODE)?)?\s*0?(\d{1,3})\b/i);
    if (episodeOnly) return { season: defaultSeason, episode: parseInt(episodeOnly[1], 10) };

    if (options?.anime) return extractAnimeEpisodeFromFilename(name, defaultSeason);
    return null;
}

function parseSize(sizeText) {
  if (!sizeText) return 0;
  if (typeof sizeText === 'number') return sizeText;
  const str = sizeText.toString();
  let scale = 1;
  if (str.match(/TB/i)) scale = 1024 * 1024 * 1024 * 1024;
  else if (str.match(/GB/i)) scale = 1024 * 1024 * 1024;
  else if (str.match(/MB/i)) scale = 1024 * 1024;
  else if (str.match(/KB/i) || str.match(/kB/i)) scale = 1024;
  else if (str.match(/B/i) && !str.match(/GB|MB|KB|TB/i)) scale = 1;
  const cleanStr = str.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const num = parseFloat(cleanStr);
  return isNaN(num) ? 0 : Math.floor(num * scale);
}

function extractSeeders(title) {
  const seedersMatch = title.match(/(?:👤|👥)\s*(\d+)/);
  return seedersMatch && parseInt(seedersMatch[1]) || 0;
}

function extractSize(title) {
  const sizeMatch = title.match(/(?:💾|🧲|📦)\s*([\d.,]+\s*\w+)/i);
  return sizeMatch && parseSize(sizeMatch[1]) || 0;
}

function extractProvider(title) {
  const match = title.match(/\[([A-Z]{2,3})\]/);
  return match?.[1] || "P2P";
}

function getKnownCacheBoolean(item) {
  if (item?._dbCachedRd === true || item?._dbCachedRd === false) return item._dbCachedRd;
  if (item?.cached_rd === true || item?.cached_rd === false) return Boolean(item.cached_rd);
  return undefined;
}

function getKnownCacheState(item) {
  const rawState = typeof item?._rdCacheState === 'string'
    ? item._rdCacheState
    : (typeof item?.rdCacheState === 'string' ? item.rdCacheState : '');
  const normalizedState = rawState.trim().toLowerCase();
  if (normalizedState === 'cached' || normalizedState === 'likely_cached' || normalizedState === 'unknown' || normalizedState === 'probing' || normalizedState === 'likely_uncached' || normalizedState === 'uncached_terminal') {
    return normalizedState;
  }

  const booleanState = getKnownCacheBoolean(item);
  if (booleanState === true) return 'cached';
  if (booleanState === false) return 'likely_uncached';
  return undefined;
}

function mergeDuplicateSignals(preferredItem, alternateItem) {
  const merged = { ...preferredItem };

  const mergedCacheState = getKnownCacheState(preferredItem) || getKnownCacheState(alternateItem);
  if (mergedCacheState) {
    merged._rdCacheState = mergedCacheState;
    merged.rdCacheState = mergedCacheState;
    if (mergedCacheState === 'cached' || mergedCacheState === 'uncached_terminal') {
      const cacheBool = mergedCacheState === 'cached';
      merged._dbCachedRd = cacheBool;
      merged.cached_rd = cacheBool;
    }
  }

  if (!merged._dbLastCachedCheck && alternateItem?._dbLastCachedCheck) merged._dbLastCachedCheck = alternateItem._dbLastCachedCheck;
  if (!merged._dbNextCachedCheck && alternateItem?._dbNextCachedCheck) merged._dbNextCachedCheck = alternateItem._dbNextCachedCheck;
  if ((merged._dbFailures === undefined || merged._dbFailures === null) && alternateItem?._dbFailures !== undefined && alternateItem?._dbFailures !== null) {
    merged._dbFailures = alternateItem._dbFailures;
  }

  if ((merged.fileIdx === undefined || merged.fileIdx === null) && alternateItem?.fileIdx !== undefined && alternateItem?.fileIdx !== null) {
    merged.fileIdx = alternateItem.fileIdx;
  }
  if ((!merged._size || merged._size <= 0) && (alternateItem?._size > 0 || alternateItem?.sizeBytes > 0)) {
    merged._size = alternateItem._size || alternateItem.sizeBytes;
  }
  if ((!merged.sizeBytes || merged.sizeBytes <= 0) && (alternateItem?.sizeBytes > 0 || alternateItem?._size > 0)) {
    merged.sizeBytes = alternateItem.sizeBytes || alternateItem._size;
  }
  if (!merged._tbCached && alternateItem?._tbCached) merged._tbCached = true;
  if (!merged._isPack && alternateItem?._isPack) merged._isPack = true;

  return merged;
}


function deduplicateResults(results, meta = {}, config = {}) {
  const grouped = new Map();

  const normalizeFileIdxValue = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  };

  const getEpisodeContext = (item) => {
    const directSeason = parseInt(item?.season, 10);
    const directEpisode = parseInt(item?.episode, 10);
    if (Number.isInteger(directSeason) && Number.isInteger(directEpisode) && directEpisode > 0) {
      return { season: directSeason, episode: directEpisode };
    }
    return extractSeasonEpisodeFromFilename(item?.title || '', 1, { anime: Boolean(meta?.kitsu_id || meta?.isAnime) });
  };

  const buildDedupeKey = (hash, item) => {
    const fileIdx = normalizeFileIdxValue(item?.fileIdx);
    if (fileIdx !== null) return `${hash}:${fileIdx}`;
    const ep = getEpisodeContext(item);
    if (ep && Number.isInteger(ep.season) && Number.isInteger(ep.episode)) return `${hash}:s${ep.season}e${ep.episode}`;
    if (item?._isPack || isSeasonPack(item?.title)) return `${hash}:pack`;
    return `${hash}:base`;
  };

  for (const item of results) {
    if (!item?.magnet) continue;
    const rawHash = item.infoHash || item.hash || extractInfoHash(item.magnet);
    const finalHash = rawHash ? rawHash.toUpperCase() : null;
    if (!finalHash || finalHash.length !== 40) continue;

    item.hash = finalHash;
    item.infoHash = finalHash;
    item.fileIdx = normalizeFileIdxValue(item.fileIdx);
    item._size = parseSize(item._size || item.sizeBytes || item.size);
    item.seeders = parseInt(item.seeders, 10) || 0;
    const rankedItem = annotateResult(item, meta, {
      ...config,
      profile: 'dedupe',
      keepByLanguage: false,
      sortMode: 'balanced'
    });
    item._score = rankedItem._score;
    item._reasons = rankedItem._reasons;
    item._rankMeta = rankedItem._rankMeta;
    item._rankProfile = rankedItem._rankProfile;
    item._dedupeScore = rankedItem._score;

    const dedupeKey = buildDedupeKey(finalHash, item);
    const existing = grouped.get(dedupeKey);
    if (!existing) {
      grouped.set(dedupeKey, item);
      continue;
    }

    const comparison = compareRankedItems(item, existing, meta, {
      ...config,
      profile: 'dedupe',
      keepByLanguage: false,
      sortMode: 'balanced'
    });
    const winner = comparison < 0 ? item : existing;
    const loser = winner === item ? existing : item;
    const mergedWinner = mergeDuplicateSignals(winner, loser);
    mergedWinner._score = winner._score;
    mergedWinner._reasons = winner._reasons;
    mergedWinner._rankMeta = winner._rankMeta;
    mergedWinner._rankProfile = winner._rankProfile;
    mergedWinner._dedupeScore = winner._dedupeScore || winner._score || 0;
    grouped.set(dedupeKey, mergedWinner);
  }
  const deduped = Array.from(grouped.values());
  incrementMetric('dedupe.input', Array.isArray(results) ? results.length : 0);
  incrementMetric('dedupe.output', deduped.length);
  incrementMetric('dedupe.removed', Math.max(0, (Array.isArray(results) ? results.length : 0) - deduped.length));
  return deduped;
}

function filterByQualityLimit(results, limit) {
    if (!limit || limit === 0 || limit === "0") return results;
    const limitNum = parseInt(limit);
    if (isNaN(limitNum)) return results;
    const counts = { "4K": 0, "1080p": 0, "720p": 0, "SD": 0 };
    const filtered = [];
    for (const item of results) {
        const t = (item.title || "").toLowerCase();
        let q = "SD";
        if (REGEX_QUALITY_FILTER["4K"].test(t)) q = "4K";
        else if (REGEX_QUALITY_FILTER["1080p"].test(t)) q = "1080p";
        else if (REGEX_QUALITY_FILTER["720p"].test(t)) q = "720p";
        if (counts[q] < limitNum) { filtered.push(item); counts[q]++; }
    }
    return filtered;
}

function isSafeForItalian(item) {
  if (!item || !item.title) return false;
  const parsedInfo = parseTitleDetails(item.title);
  const langInfo = getLanguageInfo(item.title, null, item.source || item.provider || null, parsedInfo);
  return !!(langInfo.isItalian || (langInfo.confidence || 0) >= 4 || langInfo.isMaybeItalian);
}

function validateStreamRequest(type, id) {
  const validTypes = ['movie', 'series', 'anime'];
  if (!validTypes.includes(type)) throw new Error(`Tipo non valido: ${type}`);
  const cleanIdToCheck = id.replace('ai-recs:', '');
  const idPattern = /^(tt\d+|\d+|tmdb:\d+|kitsu:\d+)(:\d+)?(:\d+)?$/;
  if (!idPattern.test(cleanIdToCheck) && !idPattern.test(id)) throw new Error(`Formato ID non valido: ${id}`);
  return true;
}

async function withTimeout(promise, ms, operation = 'Operation') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error(`TIMEOUT: ${operation} exceeded ${ms}ms`)); }, ms); });
  try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timer);
      return result;
  } catch (error) {
      clearTimeout(timer);
      throw error;
  }
}

module.exports = {
  logger, Cache, LIMITERS, CONFIG, ADMIN_PASS, MAX_CONFIG_LENGTH, EMPTY_STREAM_TTL, METADATA_CACHE_TTL,
  streamInflight, metadataInflight, cloudBuildInflight,
  REGEX_YEAR, REGEX_QUALITY_FILTER, REGEX_STRONG_ITA, REGEX_CONTEXT_IT, REGEX_ISOLATED_IT, REGEX_MULTI_ITA, REGEX_TRUSTED_GROUPS, REGEX_FALSE_IT, REGEX_SUB_ONLY, REGEX_AUDIO_CONFIRM,
  languageMapping, normalizeLanguageName, parseTitleDetails, stripVisualPrefixes, normalizeSearchText, isItalianByTitleMatch, isTrustedSource, getLanguageInfo, formatLanguageLabel, isSeasonPack, isGoodShortQueryMatch, chooseBestPackTitle, shouldUpdatePackTitle, base32ToHex, extractInfoHash, estimateVisualSize, estimateSeeders,
  extractSeasonEpisodeFromFilename, parseSize, extractSeeders, extractSize, extractProvider, deduplicateResults, filterByQualityLimit, isSafeForItalian, validateStreamRequest, withTimeout,
  safeCompare, withSharedPromise, decodeConfigBase64, getConfig, TRACKERS, buildTrackerMagnet,
  incrementMetric, recordDuration, recordProviderMetric, getStatsSnapshot
};
