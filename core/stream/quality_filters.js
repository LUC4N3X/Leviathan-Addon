const { applyTorrentResultFilters } = require('../lib/torrent_result_filters');
const { REGEX_QUALITY_FILTER } = require('../utils/text');

function detectQualityLabel(text, fallback = 'SD') {
    const upper = String(text || '').toUpperCase();
    if (/\b(?:4K|2160P|UHD)\b/.test(upper)) return '4K';
    if (/\b(?:1080P|FHD|FULLHD)\b/.test(upper)) return '1080p';
    if (/\b(?:720P|HD)\b/.test(upper)) return '720p';
    if (/\b(?:480P|SD)\b/.test(upper)) return 'SD';
    return fallback || 'SD';
}

const QUALITY_CAM_REGEX = /\b(?:cam|hdcam|ts|telesync|screener|scr)\b/i;
const QUALITY_FAKE_REGEX = /\b(?:sample|trailer|teaser|featurette|behind\s*the\s*scenes|xbet|betwinner|1xbet|watermarked|bad\s*audio|mic\s*audio)\b/i;
const QUALITY_HARDCODED_SUBS_REGEX = /\b(?:hc|hardcoded)[\s.]*(?:sub|subs|subtitles?)\b/i;

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
    const hasFake = QUALITY_FAKE_REGEX.test(raw);
    const hasHardcodedSubs = QUALITY_HARDCODED_SUBS_REGEX.test(raw);
    return { has4k, has1080, has720, hasSd, hasCam, hasFake, hasHardcodedSubs };
}

function shouldDropByConfiguredQuality(text, filters = {}, options = {}) {
    const quality = getQualityFilterSignals(text, options);
    if (filters.no4k && quality.has4k) return true;
    if (filters.no1080 && quality.has1080) return true;
    if (filters.no720 && quality.has720) return true;
    if (filters.noScr && (quality.hasSd || quality.hasCam)) return true;
    if (filters.noCam && quality.hasCam) return true;
    if (!filters.showFake && quality.hasFake) return true;
    if (filters.noHardcodedSubs && quality.hasHardcodedSubs) return true;
    return false;
}

function getConfiguredQualityFilterText(item = {}) {
    return [
        item?.title,
        item?.name,
        item?.filename,
        item?.fileName,
        item?.file_title,
        item?.rawDescription,
        item?.quality,
        item?.resolution,
        item?._releaseDetails?.quality,
        item?._releaseDetails?.qualityLabel,
        item?.behaviorHints?.filename,
        item?.behaviorHints?.videoResolution,
        item?.behaviorHints?.bingeGroup
    ].filter(Boolean).join(' ');
}

function isBlockedByUserQualityFilters(item = {}, filters = {}) {
    return shouldDropByConfiguredQuality(getConfiguredQualityFilterText(item), filters, { treatGenericHdAs720: true });
}

function getTorrentioTrustDedupeKey(item = {}) {
    const hash = String(item?.hash || item?.infoHash || '').trim().toLowerCase();
    const fileIdx = Number.isInteger(Number(item?.fileIdx)) ? Number(item.fileIdx) : -1;
    const direct = String(item?.directUrl || item?.url || item?._externalDirectUrl || '').trim().toLowerCase();
    const title = String(item?.title || item?.name || item?.filename || '').trim().toLowerCase();
    const source = String(item?.source || item?.provider || item?.externalProvider || item?.externalAddon || item?._externalRequestId || '').trim().toLowerCase();
    if (shouldForceKeepTorrentioIt(item)) {
        return ['torrentio-force', hash || 'nohash', fileIdx, direct || 'nodirect', title || 'notitle', source || 'nosource'].join(':');
    }
    if (hash) return `${hash}:${fileIdx}`;
    if (direct) return direct;
    return title;
}

function shouldForceKeepTorrentioIt(item = {}) {
    return Boolean(item?._torrentioLooseItForceKeep || item?._torrentioExactGuard);
}

function mergeForcedTorrentioItItems(filtered = [], original = [], filters = {}) {
    const output = Array.isArray(filtered) ? [...filtered] : [];
    const seen = new Set(output.map(getTorrentioTrustDedupeKey).filter(Boolean));
    for (const item of Array.isArray(original) ? original : []) {
        if (!shouldForceKeepTorrentioIt(item)) continue;
        if (isBlockedByUserQualityFilters(item, filters)) continue;
        const key = getTorrentioTrustDedupeKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(item);
    }
    return output;
}

function applyConfiguredTorrentFilters(items, filters = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    const filtered = applyTorrentResultFilters(list, filters);
    return mergeForcedTorrentioItItems(filtered, list, filters);
}

function applyConfiguredStreamFilters(streams, filters = {}) {
    const list = Array.isArray(streams) ? streams : [];
    if (!filters || Object.keys(filters).length === 0) return list;
    return list.filter(stream => !isBlockedByUserQualityFilters(stream, filters));
}

module.exports = {
    applyConfiguredStreamFilters,
    applyConfiguredTorrentFilters,
    detectQualityLabel,
    getQualityFilterSignals,
    getTorrentioTrustDedupeKey,
    mergeForcedTorrentioItItems,
    shouldForceKeepTorrentioIt
};
