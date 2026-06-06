'use strict';

const QUALITY_RANK = Object.freeze({
    Unknown: 0,
    '240p': 240,
    '360p': 360,
    '480p': 480,
    '576p': 576,
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '4K': 2160
});

const HEIGHT_TO_QUALITY = [
    [2160, '4K'],
    [1440, '1440p'],
    [1080, '1080p'],
    [720, '720p'],
    [576, '576p'],
    [480, '480p'],
    [360, '360p'],
    [240, '240p']
];

const LANGUAGE_ALIASES = Object.freeze({
    it: 'ita', ita: 'ita', italian: 'ita', italiano: 'ita', italiana: 'ita', italy: 'ita', 'italian audio': 'ita',
    en: 'eng', eng: 'eng', english: 'eng', inglese: 'eng', 'english audio': 'eng',
    ja: 'jpn', jp: 'jpn', jpn: 'jpn', japanese: 'jpn', jap: 'jpn', giapponese: 'jpn',
    fr: 'fra', fre: 'fra', fra: 'fra', french: 'fra', francese: 'fra',
    es: 'spa', spa: 'spa', spanish: 'spa', spagnolo: 'spa', castellano: 'spa',
    de: 'deu', ger: 'deu', deu: 'deu', german: 'deu', tedesco: 'deu',
    pt: 'por', por: 'por', portuguese: 'por', portoghese: 'por',
    ko: 'kor', kor: 'kor', korean: 'kor', coreano: 'kor',
    zh: 'zho', chi: 'zho', zho: 'zho', chinese: 'zho', cinese: 'zho',
    ru: 'rus', rus: 'rus', russian: 'rus', russo: 'rus',
    hi: 'hin', hin: 'hin', hindi: 'hin'
});

function safeText(value) {
    if (value === undefined || value === null) return '';
    return String(value);
}

function normalizeQuality(value) {
    const raw = safeText(value).trim().toLowerCase();
    if (!raw || ['unknown', 'auto', 'all', 'null', 'undefined', 'unknow'].includes(raw)) return 'Unknown';
    if (/(?:^|\b)(?:4k|2160p|2160|uhd)(?:\b|$)/i.test(raw)) return '4K';
    if (/(?:^|\b)(?:1440p|1440|2k|qhd)(?:\b|$)/i.test(raw)) return '1440p';
    if (/(?:^|\b)(?:1080p|1080|fullhd|fhd)(?:\b|$)/i.test(raw)) return '1080p';
    if (/(?:^|\b)(?:720p|720|hd)(?:\b|$)/i.test(raw)) return '720p';
    if (/(?:^|\b)(?:576p|576)(?:\b|$)/i.test(raw)) return '576p';
    if (/(?:^|\b)(?:480p|480|sd)(?:\b|$)/i.test(raw)) return '480p';
    if (/(?:^|\b)(?:360p|360)(?:\b|$)/i.test(raw)) return '360p';
    if (/(?:^|\b)(?:240p|240)(?:\b|$)/i.test(raw)) return '240p';
    return 'Unknown';
}

function qualityRank(value) {
    return QUALITY_RANK[normalizeQuality(value)] || 0;
}

function pickBetterQuality(first, second) {
    const a = normalizeQuality(first);
    const b = normalizeQuality(second);
    return qualityRank(a) >= qualityRank(b) ? a : b;
}

function qualityFromHeight(height) {
    const safe = Number(height || 0);
    if (!Number.isFinite(safe) || safe <= 0) return 'Unknown';
    for (const [min, quality] of HEIGHT_TO_QUALITY) {
        if (safe >= min) return quality;
    }
    return 'Unknown';
}

function parseAttributeList(line) {
    const attrs = {};
    const text = safeText(line);
    const payload = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
    const re = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
    let match;
    while ((match = re.exec(payload)) !== null) {
        const key = String(match[1] || '').toUpperCase();
        let value = String(match[2] || '').trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        attrs[key] = value;
    }
    return attrs;
}

function normalizeLanguage(value) {
    const raw = safeText(value)
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-zà-ÿ0-9]+/gi, ' ')
        .trim();
    if (!raw) return null;

    const direct = LANGUAGE_ALIASES[raw];
    if (direct) return direct;

    const tokens = raw.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
        if (LANGUAGE_ALIASES[token]) return LANGUAGE_ALIASES[token];
    }

    if (/ital|ita\b|italiano|italiana/.test(raw)) return 'ita';
    if (/engl|ingl|\beng\b/.test(raw)) return 'eng';
    if (/jap|jpn|giap|japanese/.test(raw)) return 'jpn';
    if (/fran|french|\bfra\b/.test(raw)) return 'fra';
    if (/span|spagn|\bspa\b/.test(raw)) return 'spa';
    if (/german|tedesc|\bdeu\b|\bger\b/.test(raw)) return 'deu';
    return null;
}

function addLanguage(target, value, meta = {}) {
    const lang = normalizeLanguage(value);
    if (!lang) return;
    if (!target.has(lang)) target.set(lang, { lang, samples: [], ...meta });
    const entry = target.get(lang);
    if (value && entry.samples.length < 3) entry.samples.push(String(value));
}

function normalizeLanguageList(value) {
    const values = Array.isArray(value) ? value : [value];
    const out = [];
    for (const item of values) {
        const normalized = normalizeLanguage(item) || safeText(item).trim().toLowerCase();
        if (normalized && !out.includes(normalized)) out.push(normalized);
    }
    return out;
}

function mergeLanguageLists(...lists) {
    const out = [];
    for (const list of lists) {
        for (const lang of normalizeLanguageList(list)) {
            if (!out.includes(lang)) out.push(lang);
        }
    }
    return out;
}

function extractPlaylistIntelligence(playlistText) {
    const text = safeText(playlistText);
    const heights = [];
    const audio = new Map();
    const subtitles = new Map();
    const variants = [];

    if (!text) {
        return {
            quality: 'Unknown',
            height: 0,
            audioLanguages: [],
            subtitleLanguages: [],
            isMultiAudio: false,
            isSubtitled: false,
            variantCount: 0,
            trackCount: 0,
            confidence: 0
        };
    }

    for (const match of text.matchAll(/RESOLUTION\s*=\s*\d+x(\d{3,4})/ig)) {
        const h = Number(match[1]);
        if (Number.isFinite(h)) heights.push(h);
    }

    for (const match of text.matchAll(/(?:NAME|VIDEO|BANDWIDTH)\s*=\s*"?[^"]*?(\d{3,4})p/ig)) {
        const h = Number(match[1]);
        if (Number.isFinite(h)) heights.push(h);
    }

    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        if (!line.startsWith('#EXT')) continue;
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const attrs = parseAttributeList(line);
            if (attrs.RESOLUTION) {
                const h = Number(String(attrs.RESOLUTION).split('x').pop());
                if (Number.isFinite(h)) heights.push(h);
            }
            variants.push(attrs);
            continue;
        }
        if (line.startsWith('#EXT-X-MEDIA')) {
            const attrs = parseAttributeList(line);
            const type = String(attrs.TYPE || '').toUpperCase();
            const values = [attrs.LANGUAGE, attrs.NAME, attrs['ASSOC-LANGUAGE'], attrs.GROUP_ID].filter(Boolean);
            if (type === 'AUDIO') values.forEach((value) => addLanguage(audio, value, { type: 'audio' }));
            if (type === 'SUBTITLES' || type === 'CLOSED-CAPTIONS') values.forEach((value) => addLanguage(subtitles, value, { type: 'subtitles' }));
        }
    }

    const height = heights.length ? Math.max(...heights.filter(Number.isFinite)) : 0;
    const quality = pickBetterQuality(qualityFromHeight(height), normalizeQuality(text));
    const audioLanguages = Array.from(audio.keys()).sort();
    const subtitleLanguages = Array.from(subtitles.keys()).sort();
    const trackCount = audioLanguages.length + subtitleLanguages.length;

    return {
        quality,
        height,
        audioLanguages,
        subtitleLanguages,
        isMultiAudio: audioLanguages.length > 1,
        isSubtitled: subtitleLanguages.length > 0,
        variantCount: variants.length,
        trackCount,
        confidence: Math.min(1, (quality !== 'Unknown' ? 0.45 : 0) + (trackCount > 0 ? 0.45 : 0) + (variants.length > 0 ? 0.10 : 0)),
        tracks: {
            audio: Array.from(audio.values()),
            subtitles: Array.from(subtitles.values())
        }
    };
}

function shouldProbePlaylist(targetUrl) {
    return /\.m3u8(?:$|[?#])/i.test(safeText(targetUrl));
}

async function probePlaylistIntelligence(client, targetUrl, { headers = {}, timeout = 5000, signal = undefined } = {}) {
    if (!client || typeof client.get !== 'function') return null;
    if (!shouldProbePlaylist(targetUrl)) return null;

    const response = await client.get(targetUrl, {
        headers,
        timeout,
        signal,
        responseType: 'text'
    });
    const body = typeof response?.data === 'string'
        ? response.data
        : Buffer.isBuffer(response?.data)
            ? response.data.toString('utf8')
            : String(response?.data || '');
    return extractPlaylistIntelligence(body);
}

function decorateStreamWithPlaylistIntelligence(stream, intelligence = null) {
    if (!stream || !intelligence) return stream;
    const audioLanguages = Array.isArray(intelligence.audioLanguages) ? intelligence.audioLanguages.filter(Boolean) : [];
    const subtitleLanguages = Array.isArray(intelligence.subtitleLanguages) ? intelligence.subtitleLanguages.filter(Boolean) : [];
    const playlistQuality = normalizeQuality(intelligence.quality || 'Unknown');
    const currentQuality = normalizeQuality(stream.quality || stream.behaviorHints?.quality || 'Unknown');
    const quality = pickBetterQuality(playlistQuality, currentQuality);
    const behaviorHints = {
        ...(stream.behaviorHints || {}),
        vortexMeta: {
            ...(stream.behaviorHints?.vortexMeta || {}),
            playlistQuality,
            playlistHeight: intelligence.height || 0,
            playlistVariantCount: intelligence.variantCount || 0,
            playlistLanguageConfidence: intelligence.confidence || 0
        }
    };
    const existingAudioLanguages = mergeLanguageLists(stream.audioLanguages, behaviorHints.vortexMeta.audioLanguages);
    const mergedAudioLanguages = mergeLanguageLists(existingAudioLanguages, audioLanguages);
    const existingSubtitleLanguages = mergeLanguageLists(stream.subtitleLanguages, behaviorHints.vortexMeta.subtitleLanguages);
    const mergedSubtitleLanguages = mergeLanguageLists(existingSubtitleLanguages, subtitleLanguages);

    if (mergedAudioLanguages.length) {
        behaviorHints.vortexMeta.audioLanguages = mergedAudioLanguages;
        behaviorHints.vortexMeta.isMultiAudio = mergedAudioLanguages.length > 1;
        behaviorHints.vortexMeta.hasItalianAudio = mergedAudioLanguages.includes('ita') || behaviorHints.vortexMeta.hasItalianAudio === true;
    }

    if (mergedSubtitleLanguages.length) {
        behaviorHints.vortexMeta.subtitleLanguages = mergedSubtitleLanguages;
    }

    return {
        ...stream,
        quality,
        audioLanguages: mergedAudioLanguages.length ? mergedAudioLanguages : stream.audioLanguages,
        subtitleLanguages: mergedSubtitleLanguages.length ? mergedSubtitleLanguages : stream.subtitleLanguages,
        isMultiAudio: mergedAudioLanguages.length > 1 || stream.isMultiAudio === true,
        hasItalianAudio: mergedAudioLanguages.includes('ita') || stream.hasItalianAudio === true,
        behaviorHints
    };
}

module.exports = {
    decorateStreamWithPlaylistIntelligence,
    extractPlaylistIntelligence,
    normalizeLanguage,
    normalizeQuality,
    pickBetterQuality,
    probePlaylistIntelligence,
    qualityRank,
    shouldProbePlaylist
};
