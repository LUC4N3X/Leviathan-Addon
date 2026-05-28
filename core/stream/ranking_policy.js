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

function applyFinalStreamUserSort(streams = [], config = {}, options = {}) {
    const list = Array.isArray(streams) ? streams : [];
    const sortMode = getConfiguredSortMode(config);

    const sorted = list
        .map((stream, index) => ({
            stream,
            index,
            cacheTier: getFinalStreamCacheTier(stream),
            resolutionTier: getFinalStreamResolutionTier(stream),
            sizeBytes: parseFinalStreamSizeBytes(stream)
        }))
        .sort((a, b) => {
            if (sortMode === 'resolution') {
                const resDelta = b.resolutionTier - a.resolutionTier;
                if (resDelta !== 0) return resDelta;
                if (a.cacheTier !== b.cacheTier) return a.cacheTier - b.cacheTier;
                return a.index - b.index;
            }

            if (a.cacheTier !== b.cacheTier) return a.cacheTier - b.cacheTier;

            if (sortMode === 'size') {
                const sizeDelta = b.sizeBytes - a.sizeBytes;
                if (sizeDelta !== 0) return sizeDelta;
            }
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
    applyPremiumRankingPolicy,
    getConfiguredSortMode,
    getFinalStreamCacheState,
    getFinalStreamResolutionTier
};
