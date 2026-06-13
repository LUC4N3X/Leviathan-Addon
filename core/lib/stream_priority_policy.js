'use strict';

const { parseTitleDetails } = require('../utils/text');

const QUALITY_SCORE = {
    remux: 6500,
    bluray: 5200,
    webdl: 4500,
    webrip: 3200,
    hdtv: 2100,
    other: 800,
    cam: -50000
};

const RESOLUTION_SCORE = {
    '4K': 4200,
    '2160P': 4200,
    '1080P': 3000,
    '720P': 1500,
    '480P': 400,
    'SD': 0,
    'OTHER': 0
};

const JUNK_RELEASE_RE = /\b(?:yify|yts\.?mx|rarbg|ettv|eztv|tigole\s*low|camrip|hdcam|telesync|telecine|dvdscr|bdscr)\b/i;
const AAC_OPUS_RE = /(?:^|[\s._-])(?:aac|opus)(?:[\s._-]|$)/i;

const HEVC_RE = /\b(?:x265|h265|hevc)\b/i;
const AVC_RE = /\b(?:x264|h264|avc)\b/i;
const HDR_RE = /\b(?:hdr10\+?|hdr|dolby[\s.-]?vision|\bdv\b)\b/i;

const REMUX_RE = /\b(?:remux|bdremux|brremux)\b/i;
const BLURAY_RE = /\b(?:blu[\s.-]?ray|bdrip|bdmux)\b/i;
const WEB_DL_RE = /\b(?:web[\s.-]?dl|webdl)\b/i;
const WEBRIP_RE = /\b(?:web[\s.-]?rip|brrip)\b/i;
const HDTV_RE = /\bhdtv\b/i;
const CAM_RE = /\b(?:cam|hdcam|ts|telesync|telecine|scr(?:eener)?|dvdscr|bdscr)\b/i;

function titleOf(item = {}) {
    return String(
        item.title ||
        item.name ||
        item.torrent_title ||
        item.filename ||
        ''
    ).trim();
}

function sizeOf(item = {}) {
    return Number(
        item._size ||
        item.sizeBytes ||
        item.size ||
        item.folderSize ||
        0
    ) || 0;
}

function seedersOf(item = {}) {
    return Math.max(0, Number.parseInt(item.seeders, 10) || 0);
}

function detectReleaseFamily(title, details = {}) {
    const source = String(details.source || '').toLowerCase();

    if (CAM_RE.test(title) || source.includes('cam') || source.includes('scr')) return 'cam';
    if (REMUX_RE.test(title) || source.includes('remux')) return 'remux';
    if (BLURAY_RE.test(title) || source.includes('bluray') || source.includes('blu-ray')) return 'bluray';
    if (WEB_DL_RE.test(title) || source.includes('web-dl') || source === 'webdl') return 'webdl';
    if (WEBRIP_RE.test(title) || source.includes('webrip') || source.includes('brrip')) return 'webrip';
    if (HDTV_RE.test(title) || source.includes('hdtv')) return 'hdtv';

    return 'other';
}

function detectCodecFamily(title, details = {}) {
    const codec = String(details.videoCodec || details.codec || '').toLowerCase();

    if (codec.includes('265') || codec.includes('hevc') || HEVC_RE.test(title)) return 'h265';
    if (codec.includes('264') || codec.includes('avc') || AVC_RE.test(title)) return 'h264';

    return 'unknown';
}

function detectResolutionLabel(title, details = {}) {
    const raw = String(details.quality || details.qualityLabel || '').toUpperCase();

    if (raw.includes('4K') || raw.includes('2160') || /\b(?:2160p|4k|uhd)\b/i.test(title)) return '4K';
    if (raw.includes('1080') || /\b1080p\b/i.test(title)) return '1080P';
    if (raw.includes('720') || /\b720p\b/i.test(title)) return '720P';
    if (raw.includes('480') || /\b(?:480p|576p)\b/i.test(title)) return '480P';

    return raw || 'OTHER';
}

function detectDynamicRange(title, details = {}) {
    if (Array.isArray(details.dynamicRange) && details.dynamicRange.length > 0) {
        return details.dynamicRange.join('+');
    }

    return HDR_RE.test(title) ? 'HDR' : 'SDR';
}

function getCachedBonus(item = {}) {
    if (item._dbCachedRd === true || item.cached_rd === true || item._tbCached === true) {
        return 2500;
    }

    const state = String(item._rdCacheState || item.rdCacheState || '').toLowerCase();
    return state === 'likely_cached' ? 1200 : 0;
}

function analyzeSootioPriority(item = {}) {
    const title = titleOf(item);
    const details = item._releaseDetails && typeof item._releaseDetails === 'object'
        ? item._releaseDetails
        : parseTitleDetails(title);

    if (!item._releaseDetails) {
        item._releaseDetails = details;
    }

    const family = detectReleaseFamily(title, details);
    const codec = detectCodecFamily(title, details);
    const resolution = detectResolutionLabel(title, details);
    const dynamicRange = detectDynamicRange(title, details);
    const seeders = seedersOf(item);
    const size = sizeOf(item);

    let score = QUALITY_SCORE[family] ?? QUALITY_SCORE.other;

    score += RESOLUTION_SCORE[resolution] ?? 0;
    score += Math.min(1800, seeders * 16);
    score += Math.min(900, Math.floor(size / (1024 ** 3)) * 25);

    if (codec === 'h265') {
        score += 500;
    } else if (codec === 'h264') {
        score += 350;
    }

    if (dynamicRange !== 'SDR') {
        score += 450;
    }

    if (details.flags?.proper) {
        score += 200;
    }

    if (details.flags?.repack || details.flags?.rerip) {
        score -= 250;
    }

    if (AAC_OPUS_RE.test(title)) {
        score -= 950;
    }

    if (JUNK_RELEASE_RE.test(title)) {
        score -= 3500;
    }

    score += getCachedBonus(item);

    return {
        family,
        codec,
        resolution,
        dynamicRange,
        seeders,
        size,
        score
    };
}

function applySootioPriorityPolicy(items = [], meta = {}, config = {}) {
    const list = Array.isArray(items) ? items : [];

    if (list.length <= 1) {
        return list;
    }

    const annotated = list.map((item, index) => {
        const priority = analyzeSootioPriority(item);

        item._sootioPriority = priority;
        item._sootioPriorityScore = priority.score;

        return {
            item,
            index,
            priority
        };
    });

    annotated.sort((a, b) => {
        const baseA = Number(a.item._compositeScore ?? a.item._score ?? 0) || 0;
        const baseB = Number(b.item._compositeScore ?? b.item._score ?? 0) || 0;

        const finalA = baseA + a.priority.score;
        const finalB = baseB + b.priority.score;

        if (finalB !== finalA) return finalB - finalA;
        if (b.priority.score !== a.priority.score) return b.priority.score - a.priority.score;

        return a.index - b.index;
    });

    return annotated.map(({ item }) => item);
}

module.exports = {
    analyzeSootioPriority,
    applySootioPriorityPolicy,
    applyStreamPriorityPolicy: applySootioPriorityPolicy
};
