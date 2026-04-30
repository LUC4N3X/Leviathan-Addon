'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const QUALITY_4K_REGEX = /\b(?:2160p|4k|uhd)\b/i;
const QUALITY_1080_REGEX = /\b(?:1080p|fhd|full[-.\s]?hd)\b/i;
const QUALITY_720_REGEX = /\b(?:720p|hd)\b/i;
const CAM_REGEX = /\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i;
const FRESHNESS_BUCKETS = ['ultra_fresh', 'fresh', 'settling', 'stable'];
const SHARED_STREAM_FRESH_SKIP_HOURS = Math.max(24, parseInt(process.env.SHARED_STREAM_FRESH_SKIP_HOURS || '96', 10) || 96);

function clamp(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.max(min, Math.min(max, num));
}

function parseDateCandidate(value) {
    if (!value) return null;
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return { date: new Date(value.getTime()), precision: 'day' };
    }

    const raw = String(value).trim();
    if (!raw) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const date = new Date(`${raw}T00:00:00.000Z`);
        return Number.isFinite(date.getTime()) ? { date, precision: 'day' } : null;
    }

    if (/^\d{4}-\d{2}$/.test(raw)) {
        const date = new Date(`${raw}-01T00:00:00.000Z`);
        return Number.isFinite(date.getTime()) ? { date, precision: 'month' } : null;
    }

    if (/^\d{4}$/.test(raw)) {
        const date = new Date(`${raw}-01-01T00:00:00.000Z`);
        return Number.isFinite(date.getTime()) ? { date, precision: 'year' } : null;
    }

    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return { date: parsed, precision: 'day' };
    return null;
}

function normalizeFreshnessBucket(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return FRESHNESS_BUCKETS.includes(normalized) ? normalized : 'stable';
}

function getQualityBucket(text) {
    const raw = String(text || '');
    if (QUALITY_4K_REGEX.test(raw)) return '4k';
    if (QUALITY_1080_REGEX.test(raw)) return '1080p';
    if (QUALITY_720_REGEX.test(raw)) return '720p';
    return 'sd';
}

function compareQuality(a, b) {
    const order = { sd: 0, '720p': 1, '1080p': 2, '4k': 3 };
    return (order[a] || 0) - (order[b] || 0);
}

function pickBestQuality(values = []) {
    let best = 'sd';
    for (const value of values) {
        const bucket = getQualityBucket(value);
        if (compareQuality(bucket, best) > 0) best = bucket;
    }
    return best;
}

function resolveContentTimeline(meta = {}, nowMs = Date.now()) {
    const candidates = [
        { value: meta?.episodeAirDate, source: 'episode_air_date' },
        { value: meta?.releaseDate, source: 'release_date' },
        { value: meta?.firstAirDate, source: 'first_air_date' },
        { value: meta?.releaseInfo, source: 'release_info' },
        { value: meta?.year, source: 'year' }
    ];

    let selected = null;
    for (const candidate of candidates) {
        const parsed = parseDateCandidate(candidate.value);
        if (parsed) {
            selected = {
                contentDate: parsed.date,
                contentDateIso: parsed.date.toISOString(),
                contentDateSource: candidate.source,
                contentDatePrecision: parsed.precision
            };
            break;
        }
    }

    if (!selected) {
        return {
            contentDate: null,
            contentDateIso: null,
            contentDateSource: 'unknown',
            contentDatePrecision: 'unknown',
            ageHours: null,
            ageDays: null,
            freshnessBucket: 'stable'
        };
    }

    const ageMs = nowMs - selected.contentDate.getTime();
    const ageHours = ageMs / HOUR_MS;
    const ageDays = ageMs / DAY_MS;

    let freshnessBucket = 'stable';
    if (ageHours < 48) freshnessBucket = 'ultra_fresh';
    else if (ageHours < (7 * 24)) freshnessBucket = 'fresh';
    else if (ageHours < (21 * 24)) freshnessBucket = 'settling';

    if (selected.contentDatePrecision === 'year') {
        const contentYear = selected.contentDate.getUTCFullYear();
        const nowYear = new Date(nowMs).getUTCFullYear();
        if (contentYear >= nowYear && freshnessBucket === 'stable') freshnessBucket = 'settling';
    } else if (selected.contentDatePrecision === 'month' && freshnessBucket === 'stable' && ageDays < 60) {
        freshnessBucket = 'settling';
    }

    return {
        ...selected,
        ageHours,
        ageDays,
        freshnessBucket
    };
}

function summarizeCacheOutcome(meta = {}, context = {}) {
    const cleanResults = Array.isArray(context.cleanResults) ? context.cleanResults : [];
    const rankedResults = Array.isArray(context.rankedResults) ? context.rankedResults : [];
    const finalStreams = Array.isArray(context.finalStreams) ? context.finalStreams : [];
    const debridStreams = Array.isArray(context.debridStreams) ? context.debridStreams : [];
    const webStreams = Array.isArray(context.webStreams) ? context.webStreams : [];
    const p2pStreams = Array.isArray(context.p2pStreams) ? context.p2pStreams : [];
    const sourceSet = new Set();
    const qualityTexts = [];

    let cachedCount = 0;
    let exactEpisodeCount = 0;
    let exactFileIdxCount = 0;
    let packValidatedCount = 0;
    let camCount = 0;

    for (const item of cleanResults) {
        const title = String(item?.title || '');
        const source = String(item?.source || item?.provider || '').trim();
        if (source) sourceSet.add(source);
        if (title) qualityTexts.push(title);
        if (item?.cached_rd === true || item?._dbCachedRd === true || item?._tbCached === true || item?.tb_cached === true) cachedCount += 1;
        if (meta?.isSeries && Number.isInteger(item?.fileIdx)) exactFileIdxCount += 1;
        if (item?._packValidated === true) packValidatedCount += 1;
        if (CAM_REGEX.test(title)) camCount += 1;

        if (meta?.isSeries && title) {
            const s = Number(meta?.season || 0) || 0;
            const e = Number(meta?.episode || 0) || 0;
            if (s > 0 && e > 0) {
                const exactRegexes = [
                    new RegExp(`\\bS0*${s}E0*${e}\\b`, 'i'),
                    new RegExp(`\\b${s}x0*${e}\\b`, 'i'),
                    new RegExp(`\\bseason\\s*0*${s}\\s*episode\\s*0*${e}\\b`, 'i'),
                    new RegExp(`\\bstagione\\s*0*${s}\\s*episodio\\s*0*${e}\\b`, 'i')
                ];
                if (exactRegexes.some((regex) => regex.test(title))) exactEpisodeCount += 1;
            }
        }
    }

    if (debridStreams.length > 0) sourceSet.add(String(context.debridService || 'debrid').toUpperCase());
    if (p2pStreams.length > 0) sourceSet.add('P2P');
    if (Array.isArray(context.webBucketNames)) {
        for (const providerName of context.webBucketNames) {
            if (providerName) sourceSet.add(providerName);
        }
    }

    for (const stream of finalStreams) {
        const text = `${stream?.name || ''} ${stream?.title || ''}`.trim();
        if (text) qualityTexts.push(text);
        if (CAM_REGEX.test(text)) camCount += 1;
    }

    const enabledWebProvidersCount = clamp(context.enabledWebProvidersCount || 0, 0, 8);
    const searchCoverageScore = clamp(
        (context.hasDebridKey ? 12 : 0)
        + (context.isP2PEnabled ? 4 : 0)
        + (context.dbOnlyMode ? 8 : 0)
        + (enabledWebProvidersCount * 4)
        + Math.min(cleanResults.length, 4) * 4,
        0,
        40
    );

    return {
        resultCount: cleanResults.length,
        rankedCount: rankedResults.length,
        streamCount: finalStreams.length,
        debridStreamCount: debridStreams.length,
        webStreamCount: webStreams.length,
        p2pStreamCount: p2pStreams.length,
        cachedCount,
        exactEpisodeCount,
        exactFileIdxCount,
        packValidatedCount,
        camCount,
        distinctSourceCount: sourceSet.size,
        sourceMix: [...sourceSet].slice(0, 8),
        bestQuality: pickBestQuality(qualityTexts),
        searchCoverageScore,
        isEmpty: finalStreams.length === 0,
        hasPositiveStreams: finalStreams.length > 0
    };
}

function computeConfidenceScore(meta = {}, summary = {}) {
    let score = 0;

    if (summary.hasPositiveStreams) score += 18;
    score += Math.min(summary.streamCount || 0, 4) * 6;
    score += Math.min(summary.cachedCount || 0, 3) * 10;
    score += Math.min(summary.debridStreamCount || 0, 2) * 8;
    score += Math.min(summary.webStreamCount || 0, 2) * 4;
    score += Math.min(summary.p2pStreamCount || 0, 2) * 3;
    score += Math.min(summary.distinctSourceCount || 0, 4) * 5;
    score += Math.min(summary.packValidatedCount || 0, 2) * 7;
    score += Math.min(summary.exactFileIdxCount || 0, 3) * 6;
    score += Math.min(summary.exactEpisodeCount || 0, 2) * 9;

    if (summary.bestQuality === '4k') score += 10;
    else if (summary.bestQuality === '1080p') score += 8;
    else if (summary.bestQuality === '720p') score += 5;

    score -= Math.min(summary.camCount || 0, 3) * 18;

    if (!summary.hasPositiveStreams) {
        score = Math.max(score, Math.round((summary.searchCoverageScore || 0) * 0.9));
        if ((summary.searchCoverageScore || 0) < 16) score -= 10;
    }

    if (meta?.isSeries && !summary.hasPositiveStreams && (summary.exactEpisodeCount || 0) === 0 && (summary.exactFileIdxCount || 0) === 0) {
        score -= 12;
    }

    return clamp(score, 0, 100);
}

function buildEmptyPolicy(bucket, summary, confidenceScore) {
    const coverage = Number(summary?.searchCoverageScore || 0);
    let localTtl = 60;
    let sharedTtl = 0;
    let staleGraceTtl = 0;
    let allowSharedWrite = false;
    let allowSharedStale = false;

    if (bucket === 'ultra_fresh') {
        localTtl = coverage >= 20 ? 45 : 30;
    } else if (bucket === 'fresh') {
        localTtl = coverage >= 20 ? 75 : 45;
    } else if (bucket === 'settling') {
        localTtl = coverage >= 20 ? 120 : 90;
    } else {
        localTtl = coverage >= 24 ? 180 : 120;
        if (coverage >= 18 && confidenceScore >= 18) {
            allowSharedWrite = true;
            sharedTtl = coverage >= 28 ? 90 : 45;
            staleGraceTtl = 30;
        }
    }

    return {
        localTtl,
        sharedTtl,
        staleGraceTtl,
        allowSharedWrite,
        allowSharedStale
    };
}

function buildPositivePolicy(bucket, confidenceScore) {
    let localTtl = 300;
    let sharedTtl = 0;
    let staleGraceTtl = 0;
    let allowSharedWrite = false;
    let allowSharedStale = false;

    if (bucket === 'ultra_fresh') {
        localTtl = confidenceScore >= 85 ? 240 : confidenceScore >= 72 ? 150 : 90;
        if (confidenceScore >= 86) {
            allowSharedWrite = true;
            sharedTtl = 180;
            staleGraceTtl = 45;
        } else if (confidenceScore >= 76) {
            allowSharedWrite = true;
            sharedTtl = 75;
            staleGraceTtl = 30;
        }
    } else if (bucket === 'fresh') {
        localTtl = confidenceScore >= 85 ? 480 : confidenceScore >= 65 ? 300 : 180;
        if (confidenceScore >= 84) {
            allowSharedWrite = true;
            sharedTtl = 480;
            staleGraceTtl = 120;
            allowSharedStale = true;
        } else if (confidenceScore >= 68) {
            allowSharedWrite = true;
            sharedTtl = 180;
            staleGraceTtl = 90;
        }
    } else if (bucket === 'settling') {
        localTtl = confidenceScore >= 80 ? 900 : confidenceScore >= 60 ? 600 : 360;
        allowSharedWrite = true;
        if (confidenceScore >= 76) {
            sharedTtl = 900;
            staleGraceTtl = 240;
        } else if (confidenceScore >= 58) {
            sharedTtl = 480;
            staleGraceTtl = 180;
        } else {
            sharedTtl = 180;
            staleGraceTtl = 90;
        }
        allowSharedStale = confidenceScore >= 55;
    } else {
        localTtl = confidenceScore >= 80 ? 1800 : confidenceScore >= 60 ? 1200 : 900;
        allowSharedWrite = true;
        if (confidenceScore >= 80) {
            sharedTtl = 1800;
            staleGraceTtl = 300;
        } else if (confidenceScore >= 60) {
            sharedTtl = 1200;
            staleGraceTtl = 240;
        } else {
            sharedTtl = 600;
            staleGraceTtl = 180;
        }
        allowSharedStale = true;
    }

    return {
        localTtl,
        sharedTtl,
        staleGraceTtl,
        allowSharedWrite,
        allowSharedStale
    };
}

function buildSharedStreamCachePolicy(meta = {}, context = {}) {
    const timeline = resolveContentTimeline(meta, context?.nowMs);
    const summary = summarizeCacheOutcome(meta, context);
    const confidenceScore = computeConfidenceScore(meta, summary);
    const ttlPolicy = summary.isEmpty
        ? buildEmptyPolicy(timeline.freshnessBucket, summary, confidenceScore)
        : buildPositivePolicy(timeline.freshnessBucket, confidenceScore);
    const sharedFreshSkip = Number.isFinite(timeline.ageHours) && timeline.ageHours >= 0 && timeline.ageHours < SHARED_STREAM_FRESH_SKIP_HOURS;

    return {
        version: 3,
        ...timeline,
        ...summary,
        confidenceScore,
        localTtl: ttlPolicy.localTtl,
        sharedTtl: sharedFreshSkip ? 0 : ttlPolicy.sharedTtl,
        staleGraceTtl: sharedFreshSkip ? 0 : ttlPolicy.staleGraceTtl,
        allowSharedWrite: sharedFreshSkip ? false : ttlPolicy.allowSharedWrite,
        allowSharedStale: sharedFreshSkip ? false : ttlPolicy.allowSharedStale,
        sharedFreshSkip
    };
}

function buildSharedReadContext(meta = {}, extra = {}) {
    const timeline = resolveContentTimeline(meta, extra?.nowMs);
    return {
        freshnessBucket: timeline.freshnessBucket,
        contentDateSource: timeline.contentDateSource,
        contentDatePrecision: timeline.contentDatePrecision,
        nowMs: extra?.nowMs || Date.now()
    };
}

function shouldUseSharedStreamEntry(row = {}, requestContext = {}, options = {}) {
    const requestBucket = normalizeFreshnessBucket(requestContext?.freshnessBucket);
    const entryBucket = normalizeFreshnessBucket(row?.freshness_bucket);
    const confidence = clamp(row?.confidence_score || 0, 0, 100);
    const resultCount = Number(row?.result_count || 0);
    const policyVersion = Number(row?.policy_version || 0);
    const allowStale = options?.allowStale === true;
    const contentTimeline = parseDateCandidate(row?.content_date);
    const rowAgeHours = contentTimeline?.date ? ((requestContext?.nowMs || Date.now()) - contentTimeline.date.getTime()) / HOUR_MS : null;

    if (requestBucket !== 'stable' && policyVersion < 2) return false;
    if (requestBucket !== 'stable' && Number.isFinite(rowAgeHours) && rowAgeHours >= 0 && rowAgeHours < SHARED_STREAM_FRESH_SKIP_HOURS) return false;

    if (resultCount <= 0) {
        if (allowStale) return false;
        return requestBucket === 'stable' && confidence >= 18;
    }

    if (requestBucket === 'ultra_fresh') {
        if (allowStale) return confidence >= 88;
        return confidence >= 75;
    }

    if (requestBucket === 'fresh') {
        if (allowStale) return confidence >= 70;
        return confidence >= 60;
    }

    if (requestBucket === 'settling') {
        if (allowStale) return confidence >= 55;
        return confidence >= 45;
    }

    if (allowStale) return confidence >= 35 || entryBucket === 'stable';
    return true;
}

module.exports = {
    resolveContentTimeline,
    summarizeCacheOutcome,
    computeConfidenceScore,
    buildSharedStreamCachePolicy,
    buildSharedReadContext,
    shouldUseSharedStreamEntry
};
