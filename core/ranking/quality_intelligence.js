'use strict';

function firstText(...values) {
    for (const value of values) {
        if (Array.isArray(value)) {
            const nested = firstText(...value);
            if (nested) return nested;
            continue;
        }
        const text = String(value ?? '').trim();
        if (text) return text;
    }
    return '';
}

function normalizeText(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[._+]+/g, ' ')
        .replace(/[-:[\]{}()]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildQualityText(item = {}) {
    const behaviorHints = item.behaviorHints || {};
    return normalizeText([
        item.title,
        item.name,
        item.filename,
        item.fileName,
        item.fileTitle,
        item.quality,
        item.resolution,
        item.videoQuality,
        item.source,
        item.provider,
        item.providerId,
        item.sourceName,
        behaviorHints.filename,
        behaviorHints.quality,
        behaviorHints.videoQuality,
        behaviorHints.releaseSource,
        behaviorHints.bingeGroup,
        Array.isArray(item.tags) ? item.tags.join(' ') : item.tags,
        Array.isArray(item.languages) ? item.languages.join(' ') : item.languages
    ].filter(Boolean).join(' '));
}

function parseSizeToBytes(value) {
    if (!value) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const raw = String(value).trim();
    if (/^\d+$/.test(raw)) return Number(raw);
    const match = raw.match(/([\d.,]+)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB)/i);
    if (!match) return 0;
    const amount = Number(match[1].includes(',') && match[1].includes('.')
        ? match[1].replace(/,/g, '')
        : match[1].replace(',', '.'));
    if (!Number.isFinite(amount)) return 0;
    const unit = match[2].toUpperCase();
    const multipliers = {
        B: 1,
        KB: 1024,
        KIB: 1024,
        MB: 1024 ** 2,
        MIB: 1024 ** 2,
        GB: 1024 ** 3,
        GIB: 1024 ** 3,
        TB: 1024 ** 4,
        TIB: 1024 ** 4
    };
    return Math.round(amount * (multipliers[unit] || 1));
}

function detectResolution(text = '', item = {}) {
    const direct = firstText(item.resolution, item.quality, item.videoQuality, item.behaviorHints?.quality);
    const raw = `${direct} ${text}`;
    if (/\b(?:4320p|8k)\b/i.test(raw)) return '4320p';
    if (/\b(?:2160p|4k|uhd)\b/i.test(raw)) return '2160p';
    if (/\b(?:1440p|qhd|2k)\b/i.test(raw)) return '1440p';
    if (/\b(?:1080p|1080i|fhd|full\s*hd)\b/i.test(raw)) return '1080p';
    if (/\b720p\b/i.test(raw)) return '720p';
    if (/\b(?:hdtv|hd[-.\s]?rip)\b/i.test(raw)) return '720p';
    if (/\b(?:576p|480p|sd)\b/i.test(raw)) return '480p';
    return 'unknown';
}

function detectReleaseSource(text = '') {
    if (/\b(?:cam|hdcam|ts|telesync|telecine|camrip)\b/i.test(text)) return 'cam';
    if (/\b(?:dvdscr|bdscr|screener|scr)\b/i.test(text)) return 'screener';
    if (/\b(?:remux|bdremux)\b/i.test(text)) return 'remux';
    if (/\b(?:blu\s*ray|bluray|bdrip|brrip|bd\s*rip)\b/i.test(text)) return 'bluray';
    if (/\b(?:web\s*dl|web-dl|webdl|dlrip)\b/i.test(text)) return 'webdl';
    if (/\b(?:web\s*rip|web-rip|webrip)\b/i.test(text)) return 'webrip';
    if (/\b(?:hdtv|pdtv|dsr)\b/i.test(text)) return 'hdtv';
    if (/\b(?:dvd\s*rip|dvdrip|dvd)\b/i.test(text)) return 'dvd';
    return 'unknown';
}

function detectCodec(text = '') {
    if (/\b(?:vvc|h266|x266)\b/i.test(text)) return 'vvc';
    if (/\b(?:av1)\b/i.test(text)) return 'av1';
    if (/\b(?:x265|h265|hevc)\b/i.test(text)) return 'x265';
    if (/\b(?:x264|h264|avc)\b/i.test(text)) return 'x264';
    if (/\b(?:xvid|divx)\b/i.test(text)) return 'legacy';
    return 'unknown';
}

function detectHdr(text = '') {
    if (/\b(?:dv|dovi|dolby\s*vision)\b/i.test(text)) return 'dolby_vision';
    if (/\b(?:hdr10\+|hdr10plus)\b/i.test(text)) return 'hdr10plus';
    if (/\b(?:hdr10|uhd\s*hdr|hdr)\b/i.test(text)) return 'hdr';
    return 'none';
}

function detectAudio(text = '') {
    if (/\b(?:truehd|thd)\b/i.test(text) && /\batmos\b/i.test(text)) return 'truehd_atmos';
    if (/\b(?:eac3|e\s*ac3|ddp|dd\+|ddplus|digital\s*plus)\b/i.test(text) && /\batmos\b/i.test(text)) return 'ddp_atmos';
    if (/\b(?:truehd|thd)\b/i.test(text)) return 'truehd';
    if (/\b(?:dts\s?x|dts:x)\b/i.test(text)) return 'dtsx';
    if (/\b(?:dts\s?hd\s?ma|dts\s?ma|dtshdma)\b/i.test(text)) return 'dts_hd_ma';
    if (/\b(?:dts\s?hd|dtshd)\b/i.test(text)) return 'dts_hd';
    if (/\bdts\b/i.test(text)) return 'dts';
    if (/\b(?:eac3|e\s*ac3|ddp|dd\+|ddplus|digital\s*plus)\b/i.test(text)) return 'eac3';
    if (/\b(?:ac3|ac\s*3|dolby\s*digital)\b/i.test(text)) return 'ac3';
    if (/\b(?:opus|flac|lpcm|pcm)\b/i.test(text)) return 'lossless_or_modern';
    if (/\baac\b/i.test(text)) return 'aac';
    if (/\bmp3\b/i.test(text)) return 'mp3';
    return 'unknown';
}

function detectChannels(text = '') {
    const match = text.match(/\b([1-7])\s*[. ]\s*([01])\b/i);
    if (!match) return 'unknown';
    return `${match[1]}.${match[2]}`;
}

function detectProviderTag(text = '') {
    const providers = [];
    const patterns = [
        [/\b(?:AMZN|AMAZON|PRME|PRIME)\b/i, 'amazon'],
        [/\b(?:NF|NETFLIX)\b/i, 'netflix'],
        [/\b(?:DSNP|DISNEY)\b/i, 'disney'],
        [/\b(?:ATVP|APTV|APPLE\s*TV)\b/i, 'apple'],
        [/\b(?:HMAX|HBO|MAX)\b/i, 'hbo'],
        [/\b(?:HULU)\b/i, 'hulu'],
        [/\b(?:PMTP|PARAMOUNT)\b/i, 'paramount'],
        [/\b(?:CR|CRTC|CRUNCHYROLL)\b/i, 'crunchyroll']
    ];
    for (const [regex, id] of patterns) {
        if (regex.test(text)) providers.push(id);
    }
    return providers;
}

function detectEditionTags(text = '') {
    const tags = [];
    const patterns = [
        [/\bimax\b/i, 'imax'],
        [/\b(?:proper|repack|rerip)\b/i, 'fixed_release'],
        [/\b(?:extended|director'?s?\s*cut|theatrical|unrated)\b/i, 'edition'],
        [/\b(?:internal)\b/i, 'internal']
    ];
    for (const [regex, id] of patterns) {
        if (regex.test(text)) tags.push(id);
    }
    return tags;
}

function detectRiskFlags(text = '') {
    const flags = [];
    const patterns = [
        [/\b(?:cam|hdcam|ts|telesync|telecine|camrip)\b/i, 'cam'],
        [/\b(?:dvdscr|bdscr|screener|scr)\b/i, 'screener'],
        [/\b(?:sample|trailer|teaser|featurette|behind\s*the\s*scenes)\b/i, 'sample_or_extra'],
        [/\b(?:xbet|betwinner|1xbet|ads?|watermarked)\b/i, 'spam_watermark'],
        [/\b(?:hc|hardcoded)\s*sub/i, 'hardcoded_subs'],
        [/\b(?:upscaled|ai\s*upscale)\b/i, 'upscaled'],
        [/\b(?:low\s*quality|bad\s*audio|mic\s*audio)\b/i, 'bad_audio']
    ];
    for (const [regex, id] of patterns) {
        if (regex.test(text)) flags.push(id);
    }
    return [...new Set(flags)];
}

function detectSizeSanity(item = {}, resolution = 'unknown', meta = {}) {
    const sizeBytes = parseSizeToBytes(firstText(item.sizeBytes, item.size, item._size, item.behaviorHints?.size));
    if (!sizeBytes) return { bucket: 'unknown', sizeBytes, delta: 0 };

    const gb = sizeBytes / (1024 ** 3);
    const isSeries = Boolean(meta?.isSeries || meta?.season || meta?.episode);
    let bucket = 'normal';
    let delta = 0;

    if (resolution === '2160p') {
        if (gb < (isSeries ? 1.1 : 4.0)) { bucket = 'too_small_for_4k'; delta = -18; }
        else if (gb > (isSeries ? 35 : 95)) { bucket = 'very_large_4k'; delta = -3; }
        else if (gb >= (isSeries ? 3 : 12)) { bucket = 'healthy_4k_size'; delta = 4; }
    } else if (resolution === '1080p') {
        if (gb < (isSeries ? 0.25 : 0.9)) { bucket = 'too_small_for_1080p'; delta = -14; }
        else if (gb > (isSeries ? 18 : 55)) { bucket = 'very_large_1080p'; delta = -2; }
        else if (gb >= (isSeries ? 0.7 : 2.0)) { bucket = 'healthy_1080p_size'; delta = 3; }
    } else if (resolution === '720p') {
        if (gb < (isSeries ? 0.12 : 0.45)) { bucket = 'too_small_for_720p'; delta = -10; }
        else if (gb >= (isSeries ? 0.35 : 1.0)) { bucket = 'healthy_720p_size'; delta = 2; }
    }

    return { bucket, sizeBytes, delta };
}

const WEIGHTS = Object.freeze({
    releaseSource: Object.freeze({
        remux: 24,
        bluray: 18,
        webdl: 16,
        webrip: 10,
        hdtv: 4,
        dvd: -3,
        screener: -45,
        cam: -90,
        unknown: 0
    }),
    codec: Object.freeze({
        vvc: 6,
        av1: 6,
        x265: 5,
        x264: 2,
        legacy: -6,
        unknown: 0
    }),
    hdr: Object.freeze({
        dolby_vision: 8,
        hdr10plus: 7,
        hdr: 5,
        none: 0
    }),
    audio: Object.freeze({
        truehd_atmos: 11,
        ddp_atmos: 9,
        truehd: 8,
        dtsx: 8,
        dts_hd_ma: 7,
        dts_hd: 6,
        dts: 4,
        eac3: 4,
        ac3: 2,
        lossless_or_modern: 2,
        aac: 0,
        mp3: -3,
        unknown: 0
    }),
    channels: Object.freeze({
        '7.1': 4,
        '5.1': 3,
        '2.0': 0,
        '1.0': -1,
        unknown: 0
    }),
    edition: Object.freeze({
        imax: 3,
        fixed_release: 2,
        edition: 1,
        internal: 1
    }),
    providerTag: 2,
    risk: Object.freeze({
        cam: -100,
        screener: -55,
        sample_or_extra: -120,
        spam_watermark: -45,
        hardcoded_subs: -12,
        upscaled: -12,
        bad_audio: -25
    })
});

function addWeighted(parts, group, key, label = key) {
    const groupWeights = WEIGHTS[group] || {};
    const score = Number(groupWeights[key] || 0) || 0;
    if (score === 0 && !key) return;
    parts.score += score;
    parts.components[group] = { key, score };
    if (score !== 0) parts.reasons.push(`${score > 0 ? '+' : ''}${score} ${group}=${label}`);
}

function evaluateQualityIntelligence(item = {}, meta = {}) {
    const text = buildQualityText(item);
    const resolution = detectResolution(text, item);
    const releaseSource = detectReleaseSource(text);
    const codec = detectCodec(text);
    const hdr = detectHdr(text);
    const audio = detectAudio(text);
    const channels = detectChannels(text);
    const providerTags = detectProviderTag(text);
    const editionTags = detectEditionTags(text);
    const riskFlags = detectRiskFlags(text);
    const sizeSanity = detectSizeSanity(item, resolution, meta);
    const parts = { score: 0, components: {}, reasons: [] };

    addWeighted(parts, 'releaseSource', releaseSource);
    addWeighted(parts, 'codec', codec);
    addWeighted(parts, 'hdr', hdr);
    addWeighted(parts, 'audio', audio);
    addWeighted(parts, 'channels', channels);

    let editionScore = 0;
    for (const tag of editionTags) editionScore += WEIGHTS.edition[tag] || 0;
    if (editionScore) {
        parts.score += editionScore;
        parts.components.edition = { key: editionTags.join(',') || 'none', score: editionScore };
        parts.reasons.push(`${editionScore > 0 ? '+' : ''}${editionScore} edition=${editionTags.join(',')}`);
    }

    if (providerTags.length) {
        const providerScore = Math.min(providerTags.length, 2) * WEIGHTS.providerTag;
        parts.score += providerScore;
        parts.components.providerTag = { key: providerTags.join(','), score: providerScore };
        parts.reasons.push(`+${providerScore} providerTag=${providerTags.join(',')}`);
    }

    let riskScore = 0;
    for (const flag of riskFlags) riskScore += WEIGHTS.risk[flag] || 0;
    if (riskScore) {
        parts.score += riskScore;
        parts.components.risk = { key: riskFlags.join(',') || 'none', score: riskScore };
        parts.reasons.push(`${riskScore > 0 ? '+' : ''}${riskScore} risk=${riskFlags.join(',')}`);
    }

    if (sizeSanity.delta) {
        parts.score += sizeSanity.delta;
        parts.components.sizeSanity = { key: sizeSanity.bucket, score: sizeSanity.delta, sizeBytes: sizeSanity.sizeBytes };
        parts.reasons.push(`${sizeSanity.delta > 0 ? '+' : ''}${sizeSanity.delta} size=${sizeSanity.bucket}`);
    }

    const result = {
        score: parts.score,
        text,
        resolution,
        releaseSource,
        codec,
        hdr,
        audio,
        channels,
        providerTags,
        editionTags,
        riskFlags,
        sizeSanity,
        components: parts.components,
        reasons: parts.reasons
    };

    result.badges = buildQualityBadges(result);
    return result;
}

function buildQualityBadges(quality = {}) {
    const badges = [];
    if (quality.releaseSource && quality.releaseSource !== 'unknown') badges.push(quality.releaseSource.toUpperCase());
    if (quality.codec && quality.codec !== 'unknown') badges.push(quality.codec.toUpperCase());
    if (quality.hdr === 'dolby_vision') badges.push('DV');
    else if (quality.hdr === 'hdr10plus') badges.push('HDR10+');
    else if (quality.hdr === 'hdr') badges.push('HDR');
    if (quality.audio && quality.audio !== 'unknown') badges.push(quality.audio.toUpperCase().replace(/_/g, ' '));
    if (quality.channels && quality.channels !== 'unknown') badges.push(quality.channels);
    if (Array.isArray(quality.providerTags)) badges.push(...quality.providerTags.map((tag) => tag.toUpperCase()));
    if (Array.isArray(quality.riskFlags) && quality.riskFlags.length) badges.push(`RISK:${quality.riskFlags.join(',')}`);
    return badges.slice(0, 8);
}

module.exports = {
    buildQualityBadges,
    buildQualityText,
    detectAudio,
    detectChannels,
    detectCodec,
    detectEditionTags,
    detectHdr,
    detectProviderTag,
    detectReleaseSource,
    detectResolution,
    detectRiskFlags,
    detectSizeSanity,
    evaluateQualityIntelligence,
    parseSizeToBytes
};
