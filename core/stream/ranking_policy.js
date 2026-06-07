const { logger: defaultLogger } = require('../utils/runtime');

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

function getConfiguredSortMode(config = {}) {
    const raw = String(
        config?.ranking?.sortMode ||
        config?.sortMode ||
        config?.sort ||
        config?.filters?.sortMode ||
        config?.filters?.sortBy ||
        config?.filters?.order ||
        config?.filters?.sort ||
        'balanced'
    ).trim().toLowerCase();
    if (['resolution', 'res', 'quality', 'qualita', 'qualità', 'risoluzione'].includes(raw)) return 'resolution';
    if (['size', 'bitrate', 'peso'].includes(raw)) return 'size';
    return 'balanced';
}

function applyPremiumRankingPolicy(results, meta, config) {
    const list = Array.isArray(results) ? results : [];

    const sortMode = getConfiguredSortMode(config);
    if (sortMode === 'resolution' || sortMode === 'size') return list;

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

function getFinalStreamSortText(stream = {}) {
    return String([
        stream?.name,
        stream?.title,
        stream?.description,
        stream?.behaviorHints?.filename,
        stream?.behaviorHints?.bingeGroup,
        stream?.behaviorHints?.vortexMeta?.quality
    ].filter(Boolean).join(' '));
}

function normalizeResolutionSortText(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[ᴋＫ]/g, 'k')
        .replace(/[ᴘＰ]/g, 'p')
        .toLowerCase();
}

function getFinalStreamResolutionTier(stream = {}) {
    const text = normalizeResolutionSortText(getFinalStreamSortText(stream));
    if (/\b(?:4320p|8k)\b/.test(text)) return 5;
    if (/\b(?:2160p|4k|uhd)\b/.test(text)) return 4;
    if (/\b(?:1440p|2k|qhd)\b/.test(text)) return 3.5;
    if (/\b(?:1080p|1080i|fhd|full[-.\s]?hd)\b/.test(text)) return 3;
    if (/\b(?:720p|hd)\b/.test(text)) return 2;
    if (/\b(?:576p|480p|sd)\b/.test(text)) return 1;
    return 0;
}

function parseFinalStreamSizeBytes(stream = {}) {
    const text = getFinalStreamSortText(stream);
    const match = text.match(/(\d+(?:[.,]\d+)?)\s*(tib|tb|gib|gb|mib|mb)\b/i);
    if (!match) return 0;
    const value = parseFloat(String(match[1]).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = match[2].toLowerCase();
    if (unit === 'tib' || unit === 'tb') return value * 1024 * 1024 * 1024 * 1024;
    if (unit === 'gib' || unit === 'gb') return value * 1024 * 1024 * 1024;
    return value * 1024 * 1024;
}

function getFinalStreamCacheState(stream = {}) {
    const raw = stream?.cacheState || stream?.rdCacheState || stream?.behaviorHints?.cacheState || stream?.behaviorHints?.rdCacheState || '';
    const normalized = String(raw || '').trim().toLowerCase();
    if (normalized) return normalized;
    const visibleText = `${stream?.name || ''}
${stream?.title || ''}`;
    if (/⚡/.test(visibleText) && /\b(RD|TB)\b/i.test(visibleText)) return 'cached';
    if (/☁️/.test(visibleText) && /\b(RD|TB)\b/i.test(visibleText)) return 'uncached_terminal';
    if (/⏳/.test(visibleText) && /\b(RD|TB)\b/i.test(visibleText)) return 'probing';
    return 'unknown';
}

function getFinalStreamCacheTier(stream = {}) {
    const state = getFinalStreamCacheState(stream);
    if (state === 'cached') return 0;
    if (state === 'likely_cached' || state === 'probing' || state === 'unknown') return 1;
    if (state === 'likely_uncached') return 2;
    if (state === 'uncached_terminal') return 3;
    return 1;
}


function normalizeSmartFingerprintText(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\b(?:www|com|org|net|io)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(?:ita|italian|multi|eng|english|sub|subs|dubbed|dub|audio|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|ddp|dts|atmos|truehd)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getSmartStreamInfoHash(stream = {}) {
    const values = [
        stream?.infoHash,
        stream?.hash,
        stream?.behaviorHints?.infoHash,
        stream?.streamData?.torrent?.infoHash,
        stream?.streamData?.torrent?.hash,
        stream?.behaviorHints?.magnet,
        stream?.url,
        stream?.externalUrl
    ];
    for (const value of values) {
        if (!value) continue;
        const text = String(value);
        const direct = text.match(/^[a-f0-9]{40}$/i);
        if (direct) return direct[0].toLowerCase();
        const btih = text.match(/btih:([a-f0-9]{40})/i);
        if (btih) return btih[1].toLowerCase();
    }
    return '';
}

function getSmartStreamFileIndex(stream = {}) {
    const values = [
        stream?.fileIdx,
        stream?.file_index,
        stream?.behaviorHints?.fileIdx,
        stream?.streamData?.torrent?.fileIdx,
        stream?.streamData?.torrent?.file_index
    ];
    for (const value of values) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) return String(n);
    }
    return '';
}

function getSmartStreamFilename(stream = {}) {
    const values = [
        stream?.behaviorHints?.filename,
        stream?.filename,
        stream?.streamData?.filename,
        stream?.streamData?.torrent?.filename,
        stream?.streamData?.torrent?.file?.name,
        stream?.name,
        stream?.title
    ];
    for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text.split(/[\\/]/).pop();
    }
    return '';
}

function collectSmartStreamLanguageText(stream = {}) {
    return [
        stream?.language,
        stream?.lang,
        stream?.audio,
        stream?.audioLanguage,
        Array.isArray(stream?.audioLanguages) ? stream.audioLanguages.join(' ') : stream?.audioLanguages,
        stream?.behaviorHints?.language,
        stream?.behaviorHints?.audio,
        stream?.behaviorHints?.vortexMeta?.language,
        stream?.behaviorHints?.vortexMeta?.audio,
        Array.isArray(stream?.behaviorHints?.vortexMeta?.audioLanguages) ? stream.behaviorHints.vortexMeta.audioLanguages.join(' ') : stream?.behaviorHints?.vortexMeta?.audioLanguages,
        stream?.name,
        stream?.title
    ].filter(Boolean).join(' ');
}

function getSmartStreamLanguageVariant(stream = {}) {
    const text = collectSmartStreamLanguageText(stream);
    if (!text) return '';
    if (/🇮🇹|\b(?:ita|it|italian|italiano|dub\s*ita|doppiat[oa])\b/i.test(text) && !/sub\s*ita|vost(?:it)?/i.test(text)) return 'ita';
    if (/🇯🇵|\b(?:jpn|jp|jap|ja|japanese|giapponese)\b|sub\s*ita|vost(?:it)?|raw/i.test(text)) return 'jpn';
    if (/🇬🇧|🇺🇸|\b(?:eng|en|english|inglese)\b/i.test(text)) return 'eng';
    if (/\b(?:multi|dual\s*audio|multiaudio)\b/i.test(text)) return 'multi';
    return '';
}

function getSizeBucket(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '0';
    const gib = value / (1024 ** 3);
    if (gib >= 20) return String(Math.round(gib));
    if (gib >= 1) return String(Math.round(gib * 2) / 2);
    return `${Math.max(1, Math.round(value / (100 * 1024 * 1024)))}00mb`;
}

function getSmartStreamFingerprint(stream = {}) {
    const infoHash = getSmartStreamInfoHash(stream);
    const fileIndex = getSmartStreamFileIndex(stream);
    if (infoHash && fileIndex) return `hash-file:${infoHash}:${fileIndex}`;

    const filename = normalizeSmartFingerprintText(getSmartStreamFilename(stream));
    const size = getSizeBucket(parseFinalStreamSizeBytes(stream) || stream?.behaviorHints?.videoSize || stream?.size || stream?.streamData?.size);
    const languageVariant = getSmartStreamLanguageVariant(stream);
    const languageKey = languageVariant ? `:${languageVariant}` : '';
    if (infoHash && !/\b(?:pack|season|stagione|complete|collection)\b/i.test(getFinalStreamSortText(stream))) {
        return `hash:${infoHash}${languageKey}`;
    }
    if (filename && size !== '0') return `file:${filename}:${size}${languageKey}`;

    const title = normalizeSmartFingerprintText(getFinalStreamSortText(stream));
    const resolution = getFinalStreamResolutionTier(stream);
    const group = detectReleaseGroupKey({ title: getFinalStreamSortText(stream), source: stream?.streamData?.addon || stream?.source || stream?.provider });
    return title ? `smart:${title}:${resolution}:${group}:${size}${languageKey}` : '';
}

function getSmartDedupPreferenceScore(stream = {}) {
    const cacheTier = getFinalStreamCacheTier(stream);
    const resolutionTier = getFinalStreamResolutionTier(stream);
    const sizeBytes = parseFinalStreamSizeBytes(stream) || Number(stream?.behaviorHints?.videoSize || stream?.size || 0) || 0;
    const hasPlayableUrl = stream?.url || stream?.externalUrl || stream?.infoHash ? 1 : 0;
    const hasFilename = getSmartStreamFilename(stream) ? 1 : 0;
    const titleText = getFinalStreamSortText(stream);
    const qualityBonus = /\b(?:remux|bluray|web[-. ]?dl|webrip)\b/i.test(titleText) ? 40 : 0;
    const italianBonus = /\b(?:ita|italian|italiano|multi)\b/i.test(titleText) ? 20 : 0;
    return (4 - Math.min(3, cacheTier)) * 10000
        + resolutionTier * 1000
        + Math.min(900, Math.log2(sizeBytes + 1) * 20)
        + qualityBonus
        + italianBonus
        + hasPlayableUrl * 50
        + hasFilename * 15;
}

function applySmartStreamDedupPolicy(streams = [], config = {}, options = {}) {
    const list = Array.isArray(streams) ? streams : [];
    const filters = config?.filters || {};
    if (filters.disableSmartStreamDedup === true || filters.disableSmartDedup === true || list.length <= 1) {
        return { results: list, removed: 0 };
    }

    const bestByKey = new Map();
    const noKey = [];
    for (const stream of list) {
        const key = getSmartStreamFingerprint(stream);
        if (!key) {
            noKey.push(stream);
            continue;
        }
        const current = bestByKey.get(key);
        if (!current || getSmartDedupPreferenceScore(stream) > current.score) {
            bestByKey.set(key, { stream, score: getSmartDedupPreferenceScore(stream) });
        }
    }

    const winners = new Set([...bestByKey.values()].map((entry) => entry.stream));
    const results = list.filter((stream) => winners.has(stream) || noKey.includes(stream));
    const removed = list.length - results.length;
    if (removed > 0) {
        const activeLogger = options.logger || defaultLogger;
        activeLogger.info(`[SMART DEDUP] removed=${removed} kept=${results.length}`);
    }
    return { results, removed };
}

function getConfiguredMaxPerResolution(config = {}) {
    const filters = config?.filters || {};
    const raw = filters.maxStreamsPerResolution
        || filters.maxPerResolution
        || config?.maxStreamsPerResolution
        || process.env.FINAL_MAX_STREAMS_PER_RESOLUTION
        || '12';
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.max(1, Math.min(50, parsed));
}

function applyMaxPerResolutionPolicy(streams = [], config = {}, options = {}) {
    const list = Array.isArray(streams) ? streams : [];
    const filters = config?.filters || {};
    if (filters.disableMaxPerResolution === true || list.length <= 1) return { results: list, removed: 0 };

    const maxPerResolution = getConfiguredMaxPerResolution(config);
    if (!maxPerResolution) return { results: list, removed: 0 };

    const counts = new Map();
    const selected = [];
    const overflow = [];
    for (const stream of list) {
        const tier = getFinalStreamResolutionTier(stream) || 0;
        const key = String(tier);
        const count = counts.get(key) || 0;
        const mustKeep = getFinalStreamCacheTier(stream) === 0
            || getSmartStreamInfoHash(stream) && getSmartStreamFileIndex(stream)
            || /\b(?:pack|season|stagione|complete|collection)\b/i.test(getFinalStreamSortText(stream));
        if (count < maxPerResolution || mustKeep) {
            selected.push(stream);
            counts.set(key, count + 1);
        } else {
            overflow.push(stream);
        }
    }

    const removed = overflow.length;
    if (removed > 0) {
        const activeLogger = options.logger || defaultLogger;
        activeLogger.info(`[MAX PER RES] max=${maxPerResolution} removed=${removed} kept=${selected.length}`);
    }
    return { results: selected, removed };
}

const PREFERRED_SYNONYMS = {
    '4k': ['4k', '2160p', 'uhd'], '2160p': ['2160p', '4k', 'uhd'], '8k': ['8k', '4320p'],
    '1440p': ['1440p', '2k', 'qhd'], '1080p': ['1080p', '1080i', 'fhd'], '720p': ['720p'],
    '480p': ['480p'], 'sd': ['sd', '480p', '360p'],
    'ita': ['ita', 'italian', 'italiano'], 'eng': ['eng', 'english'], 'jpn': ['jpn', 'jap', 'japanese'],
    'multi': ['multi', 'dual'],
    'remux': ['remux'], 'bluray': ['bluray', 'blu ray', 'bdrip', 'brrip'],
    'web-dl': ['web dl', 'webdl'], 'webdl': ['web dl', 'webdl'], 'webrip': ['webrip', 'web rip'],
    'web': ['web'], 'hdtv': ['hdtv'],
    'dv': ['dolby vision', 'dovi', ' dv '], 'hdr10+': ['hdr10+', 'hdr10plus'], 'hdr': ['hdr'], 'sdr': ['sdr']
};

function normalizePreferredList(value) {
    if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean);
    if (typeof value === 'string') return value.split(/[,|;]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    return [];
}

function getPreferredLists(config = {}) {
    const filters = config?.filters || {};
    return {
        resolutions: normalizePreferredList(filters.preferredResolutions),
        languages: normalizePreferredList(filters.preferredLanguages),
        visualTags: normalizePreferredList(filters.preferredQualities || filters.preferredVisualTags),
        hdr: normalizePreferredList(filters.preferredHdr)
    };
}

function preferredTokenMatches(paddedText, token) {
    const synonyms = PREFERRED_SYNONYMS[token] || [token];
    return synonyms.some((synonym) => {
        const normalized = String(synonym || '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
        return normalized && paddedText.includes(` ${normalized} `);
    });
}

// Returns the index of the first preferred token matched by the stream (lower is
// better). An empty list yields 0 for every stream, so unconfigured preferences
// are a pure no-op that leaves the existing ordering untouched.
function getPreferredRank(paddedText, list) {
    for (let i = 0; i < list.length; i += 1) {
        if (preferredTokenMatches(paddedText, list[i])) return i;
    }
    return list.length;
}

function applyFinalStreamUserSort(streams = [], config = {}, options = {}) {
    const list = Array.isArray(streams) ? streams : [];
    const sortMode = getConfiguredSortMode(config);
    const preferred = getPreferredLists(config);

    const comparePreferred = (a, b) => {
        if (a.resPref !== b.resPref) return a.resPref - b.resPref;
        if (a.langPref !== b.langPref) return a.langPref - b.langPref;
        if (a.tagPref !== b.tagPref) return a.tagPref - b.tagPref;
        if (a.hdrPref !== b.hdrPref) return a.hdrPref - b.hdrPref;
        return 0;
    };

    const sorted = list
        .map((stream, index) => {
            const paddedText = ` ${normalizeResolutionSortText(getFinalStreamSortText(stream)).replace(/[^a-z0-9+]+/g, ' ')} `;
            return {
                stream,
                index,
                cacheTier: getFinalStreamCacheTier(stream),
                resolutionTier: getFinalStreamResolutionTier(stream),
                sizeBytes: parseFinalStreamSizeBytes(stream),
                resPref: getPreferredRank(paddedText, preferred.resolutions),
                langPref: getPreferredRank(paddedText, preferred.languages),
                tagPref: getPreferredRank(paddedText, preferred.visualTags),
                hdrPref: getPreferredRank(paddedText, preferred.hdr)
            };
        })
        .sort((a, b) => {
            if (sortMode === 'resolution') {
                const resDelta = b.resolutionTier - a.resolutionTier;
                if (resDelta !== 0) return resDelta;
                if (a.cacheTier !== b.cacheTier) return a.cacheTier - b.cacheTier;
                const prefDelta = comparePreferred(a, b);
                if (prefDelta !== 0) return prefDelta;
                return a.index - b.index;
            }

            if (a.cacheTier !== b.cacheTier) return a.cacheTier - b.cacheTier;

            if (sortMode === 'size') {
                const sizeDelta = b.sizeBytes - a.sizeBytes;
                if (sizeDelta !== 0) return sizeDelta;
            }
            const prefDelta = comparePreferred(a, b);
            if (prefDelta !== 0) return prefDelta;
            return a.index - b.index;
        })
        .map((entry) => entry.stream);

    if (sortMode === 'resolution' || sortMode === 'size') {
        const top = sorted.slice(0, 5).map((stream) => `${getFinalStreamResolutionTier(stream)}:${String(stream?.title || stream?.name || '').replace(/\s+/g, ' ').slice(0, 45)}`);
        const activeLogger = options.logger || defaultLogger;
        activeLogger.info(`[FINAL SORT] mode=${sortMode} count=${sorted.length} top=${top.join(' | ')}`);
    }

    return sorted;
}

module.exports = {
    applyFinalStreamUserSort,
    applyMaxPerResolutionPolicy,
    applySmartStreamDedupPolicy,
    applyPremiumRankingPolicy,
    getConfiguredSortMode,
    getFinalStreamCacheState,
    getFinalStreamResolutionTier
};
