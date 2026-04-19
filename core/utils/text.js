require('dotenv').config();
const ptt = require('parse-torrent-title');

const parsedTitleCache = new Map();
const normalizedTextCache = new Map();
const languageInfoCache = new Map();

const REGEX_YEAR = /(19|20)\d{2}/;
const REGEX_QUALITY_FILTER = {
    "4K": /\b(?:2160p|4k|uhd|ultra[-.\s]?hd|2160i)\b/i,
    "1080p": /\b(?:1080p|1080i|fhd|full[-.\s]?hd|blu[-.\s]?ray|bd[-.\s]?rip)\b/i,
    "720p": /\b(?:720p|720i|hd[-.\s]?rip|hd)\b/i,
    "SD": /\b(?:480p|576p|sd|dvd|dvd[-.\s]?rip|dvd[-.\s]?scr|cd)\b/i
};

const REGEX_STRONG_ITA = /\b(ITA|ITALIAN|ITALIANO)\b/i;
const REGEX_CONTEXT_IT = /\b(AUDIO|LINGUA|LANG|VO|AC-?3|AAC|MP3|DDP|DTS|TRUEHD)\W+(IT)\b/i;
const REGEX_ISOLATED_IT = /(?:^|[_\-.])(IT)(?:$|[_\-.])/;
const REGEX_MULTI_ITA = /\b(MULTI|DUAL|TRIPLE).*(ITA|ITALIAN)\b/i;
const REGEX_TRUSTED_GROUPS = /\b(iDN_CreW|CORSARO|MUX|WMS|TRIDIM|SPEEDVIDEO|EAGLE|TRL|MEA|LUX|DNA|LEST|GHIZZO|USAbit|Bric|Dtone|Gaiage|BlackBit|Pantry|Vics|Papeete|Lidri|MirCrew)\b/i;
const REGEX_FALSE_IT = /\b(10BIT|BIT|WIT|HIT|FIT|KIT|SIT|LIT|PIT)\b/i;
const REGEX_SUB_ONLY = /\b(SUB|SUBS|SUBBED|SOTTOTITOLI|VOST|VOSTIT)\s*[:.\-_]?\s*(ITA|IT|ITALIAN)\b/i;
const REGEX_AUDIO_CONFIRM = /\b(AUDIO|AC3|AAC|DTS|MD|LD|DDP|MP3|LINGUA)[\s.\-_]+(ITA|IT)\b/i;

const languageMapping = {
    'english': '🇬🇧 ENG',
    'japanese': '🇯🇵 JPN',
    'italian': '🇮🇹 ITA',
    'french': '🇫🇷 FRA',
    'german': '🇩🇪 GER',
    'spanish': '🇪🇸 ESP',
    'russian': '🇷🇺 RUS',
    'multi': '🌍 MULTI',
    'multi audio': '🌍 MULTI'
};

function normalizeLanguageName(lang) {
    const value = String(lang || '').trim().toLowerCase();
    if (!value) return null;
    const aliasMap = {
        'ita': 'Italian', 'it': 'Italian', 'italian': 'Italian', 'italiano': 'Italian',
        'eng': 'English', 'en': 'English', 'english': 'English',
        'jpn': 'Japanese', 'jp': 'Japanese', 'ja': 'Japanese', 'japanese': 'Japanese',
        'fra': 'French', 'fre': 'French', 'fr': 'French', 'french': 'French',
        'ger': 'German', 'deu': 'German', 'de': 'German', 'german': 'German',
        'esp': 'Spanish', 'spa': 'Spanish', 'es': 'Spanish', 'spanish': 'Spanish',
        'rus': 'Russian', 'ru': 'Russian', 'russian': 'Russian',
        'multi': 'Multi', 'multi audio': 'Multi', 'dual audio': 'Dual Audio', 'dual': 'Dual Audio'
    };
    return aliasMap[value] || (value.charAt(0).toUpperCase() + value.slice(1));
}

const RELEASE_SOURCE_PATTERNS = [
    { regex: /\b(?:blu[-.\s]?ray|bd[-.\s]?remux|br[-.\s]?remux|bdremux|remux)\b/i, value: 'BluRay' },
    { regex: /\bweb[-.\s]?dl\b/i, value: 'WEB-DL' },
    { regex: /\bweb[-.\s]?rip\b/i, value: 'WEBRip' },
    { regex: /\bbrrip\b/i, value: 'BRRip' },
    { regex: /\bbd[-.\s]?rip\b/i, value: 'BDRip' },
    { regex: /\bdvd[-.\s]?(?:rip|scr)?\b/i, value: 'DVDRip' },
    { regex: /\bhdtv\b/i, value: 'HDTV' },
    { regex: /\bsat[-.\s]?rip\b/i, value: 'SATRip' },
    { regex: /\btv[-.\s]?rip\b/i, value: 'TVRip' },
    { regex: /\b(?:cam|hdcam)\b/i, value: 'CAM' },
    { regex: /\b(?:telesync|ts)\b/i, value: 'TS' },
    { regex: /\btelecine\b/i, value: 'TC' },
    { regex: /\bscr(?:eener)?\b/i, value: 'SCR' }
];

const VIDEO_CODEC_PATTERNS = [
    { regex: /\b(?:x265|h265|hevc)\b/i, value: 'HEVC' },
    { regex: /\b(?:x264|h264|avc)\b/i, value: 'AVC' },
    { regex: /\b(?:xvid)\b/i, value: 'XviD' },
    { regex: /\b(?:divx)\b/i, value: 'DivX' }
];

const AUDIO_CODEC_PATTERNS = [
    { regex: /\btruehd\b/i, value: 'TRUEHD' },
    { regex: /\batmos\b/i, value: 'ATMOS' },
    { regex: /\bdts(?:[-.\s]?hd)?\b/i, value: 'DTS' },
    { regex: /\beac3\b/i, value: 'EAC3' },
    { regex: /\bddp\d*\.?\d*\b/i, value: 'DDP' },
    { regex: /\bac-?3\b/i, value: 'AC3' },
    { regex: /\baac(?:\d*\.?\d*)?\b/i, value: 'AAC' },
    { regex: /\bmp3\b/i, value: 'MP3' },
    { regex: /\bflac\b/i, value: 'FLAC' }
];

const CONTAINER_PATTERNS = [
    { regex: /\.mkv\b/i, value: 'MKV' },
    { regex: /\.mp4\b/i, value: 'MP4' },
    { regex: /\.avi\b/i, value: 'AVI' },
    { regex: /\.ts\b/i, value: 'TS' },
    { regex: /\.m2ts\b/i, value: 'M2TS' },
    { regex: /\.iso\b/i, value: 'ISO' }
];

const LANGUAGE_PATTERNS = [
    { regex: /\b(?:ita|italian|italiano)\b/i, value: 'Italian' },
    { regex: /\b(?:eng|english)\b/i, value: 'English' },
    { regex: /\b(?:jpn|jp|japanese)\b/i, value: 'Japanese' },
    { regex: /\b(?:fra|fre|french)\b/i, value: 'French' },
    { regex: /\b(?:ger|deu|german)\b/i, value: 'German' },
    { regex: /\b(?:esp|spa|spanish)\b/i, value: 'Spanish' },
    { regex: /\b(?:rus|russian)\b/i, value: 'Russian' },
    { regex: /\b(?:multi|multilang(?:uage)?|dual[\s.-]?audio)\b/i, value: 'Multi' }
];

function detectFirstPatternValue(text, patterns, fallback = '') {
    for (const entry of patterns) {
        if (entry.regex.test(text)) return entry.value;
    }
    return fallback;
}

function normalizeReleaseTitle(value) {
    return String(value || '').replace(/[\[\]{}()]/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function detectReleaseLanguages(info, text) {
    const collected = new Set();
    const push = (value) => {
        const normalized = normalizeLanguageName(value);
        if (normalized) collected.add(normalized);
    };

    if (Array.isArray(info?.languages)) info.languages.forEach(push);
    for (const entry of LANGUAGE_PATTERNS) {
        if (entry.regex.test(text)) push(entry.value);
    }
    return [...collected];
}

function detectDynamicRange(text) {
    const values = [];
    const push = (value) => {
        if (value && !values.includes(value)) values.push(value);
    };
    if (/\bdolby[\s.-]?vision\b|\bdv\b/i.test(text)) push('DV');
    if (/\bhdr10\+\b/i.test(text)) push('HDR10+');
    if (/\bhdr10\b/i.test(text)) push('HDR10');
    if (/\bhdr\b/i.test(text)) push('HDR');
    return values;
}

function detectReleaseQuality(info, text) {
    const normalizedResolution = String(info?.resolution || '').toLowerCase();
    if (normalizedResolution.includes('2160') || /\b(?:2160p|4k|uhd)\b/i.test(text)) return '4K';
    if (normalizedResolution.includes('1080') || /\b(?:1080p|fhd|full[-.\s]?hd)\b/i.test(text)) return '1080p';
    if (normalizedResolution.includes('720') || /\b720p\b/i.test(text)) return '720p';
    if (normalizedResolution.includes('480') || /\b(?:480p|576p)\b/i.test(text)) return '480p';
    if (/\b(?:cam|hdcam|telesync|telecine|ts)\b/i.test(text)) return 'CAM';
    if (/\b(?:scr|screener|dvdscr|bdscr)\b/i.test(text)) return 'SCR';
    return 'Other';
}

function detectAudioChannels(text) {
    const match = String(text || '').match(/\b([257])\.(1|0)\b/);
    if (match) return `${match[1]}.${match[2]}`;
    if (/\bmono\b/i.test(text)) return '1.0';
    if (/\bstereo\b/i.test(text)) return '2.0';
    return '';
}

function detectReleaseGroup(text) {
    const value = String(text || '').trim();
    const matches = [
        value.match(/-([A-Za-z0-9][A-Za-z0-9._-]{1,18})$/),
        value.match(/\[([A-Za-z0-9][A-Za-z0-9._-]{1,18})\]$/),
        value.match(/(?:^|[\s._-])([A-Za-z0-9]{2,12})$/)
    ];

    for (const match of matches) {
        const candidate = String(match?.[1] || '').trim();
        if (!candidate) continue;
        if (/^(mkv|mp4|avi|1080p|720p|2160p|4k|aac|ac3|ddp|dts|x264|x265|hevc)$/i.test(candidate)) continue;
        return candidate.toUpperCase();
    }
    return '';
}

function detectReleaseFlags(text) {
    const value = String(text || '');
    return {
        remux: /\b(?:br|bd)?remux\b|\bremux\b/i.test(value),
        proper: /\bproper\b/i.test(value),
        repack: /\brepack\b/i.test(value),
        rerip: /\brerip\b/i.test(value),
        extended: /\bextended\b/i.test(value),
        unrated: /\bunrated\b/i.test(value),
        imax: /\bimax\b/i.test(value),
        threeD: /\b3d\b/i.test(value),
        cam: /\b(?:cam|hdcam|telesync|telecine|ts)\b/i.test(value),
        screener: /\b(?:scr|screener|dvdscr|bdscr)\b/i.test(value),
        pack: /\b(?:pack|complete|completa|collection|integrale|full[-.\s]?season)\b/i.test(value)
    };
}

function detectCleanReleaseTitle(info, text) {
    const parsedTitle = String(info?.title || '').trim();
    if (parsedTitle) return parsedTitle;
    return normalizeReleaseTitle(text)
        .replace(/\b(?:2160p|1080p|720p|480p|4k|uhd|x265|x264|h265|h264|hevc|hdr10\+?|hdr|dv|dolby[\s.-]?vision|web[-.\s]?dl|web[-.\s]?rip|blu[-.\s]?ray|brrip|bdrip|dvdrip|remux|proper|repack|rerip|ita|eng|multi|dual[\s.-]?audio|aac|ac3|ddp\d*\.?\d*|dts|truehd|atmos)\b/gi, ' ')
        .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseTitleDetails(filename) {
    if (!filename) {
        return {
            quality: 'SD',
            qualityLabel: 'SD',
            tags: '',
            languages: [],
            rawLanguages: [],
            cleanTitle: '',
            source: '',
            codec: '',
            videoCodec: '',
            audio: '',
            audioCodec: '',
            audioChannels: '',
            dynamicRange: [],
            container: '',
            releaseGroup: '',
            flags: {}
        };
    }
    const cacheKey = String(filename);
    const cached = parsedTitleCache.get(cacheKey);
    if (cached) return cached;

    let result;
    try {
        const info = ptt.parse(cacheKey);
        const normalizedText = normalizeReleaseTitle(cacheKey);
        const source = String(info?.source || '').trim() || detectFirstPatternValue(normalizedText, RELEASE_SOURCE_PATTERNS, '');
        const videoCodec = String(info?.codec || '').trim().toUpperCase() || detectFirstPatternValue(normalizedText, VIDEO_CODEC_PATTERNS, '');
        const audioCodec = String(info?.audio || '').trim().toUpperCase() || detectFirstPatternValue(normalizedText, AUDIO_CODEC_PATTERNS, '');
        const audioChannels = detectAudioChannels(normalizedText);
        const dynamicRange = detectDynamicRange(normalizedText);
        const rawLanguages = detectReleaseLanguages(info, normalizedText);
        const displayLanguages = rawLanguages.map((language) => languageMapping[language.toLowerCase()] || language.substring(0, 3).toUpperCase());
        const quality = detectReleaseQuality(info, normalizedText);
        const flags = detectReleaseFlags(normalizedText);
        const codec = videoCodec;
        const audio = [audioCodec, audioChannels].filter(Boolean).join(' ');
        const tags = [
            source,
            flags.remux ? 'REMUX' : '',
            codec,
            audio,
            ...dynamicRange,
            detectFirstPatternValue(normalizedText, CONTAINER_PATTERNS, ''),
            flags.proper ? 'PROPER' : '',
            flags.repack ? 'REPACK' : ''
        ].filter(Boolean).join(' ');

        result = {
            quality,
            qualityLabel: [quality, ...dynamicRange].filter(Boolean).join(' ').trim() || quality,
            tags,
            languages: displayLanguages,
            rawLanguages,
            cleanTitle: detectCleanReleaseTitle(info, normalizedText),
            source,
            codec,
            videoCodec,
            audio,
            audioCodec,
            audioChannels,
            dynamicRange,
            container: detectFirstPatternValue(normalizedText, CONTAINER_PATTERNS, ''),
            releaseGroup: detectReleaseGroup(cacheKey),
            flags
        };
    } catch (e) {
        result = {
            quality: 'SD',
            qualityLabel: 'SD',
            tags: '',
            languages: [],
            rawLanguages: [],
            cleanTitle: '',
            source: '',
            codec: '',
            videoCodec: '',
            audio: '',
            audioCodec: '',
            audioChannels: '',
            dynamicRange: [],
            container: '',
            releaseGroup: '',
            flags: {}
        };
    }

    parsedTitleCache.set(cacheKey, result);
    return result;
}

function stripVisualPrefixes(str) {
    if (!str) return '';
    return String(str).replace(/^[^a-zA-Z0-9]+/, '').replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
}

function normalizeSearchText(value) {
    const cacheKey = String(value || '');
    const cached = normalizedTextCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const normalized = cacheKey.toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, ' ').replace(/[\._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    normalizedTextCache.set(cacheKey, normalized);
    return normalized;
}

function isItalianByTitleMatch(title, italianMovieTitle = null) {
    if (!title || !italianMovieTitle) return false;
    const normalizedTorrentTitle = normalizeSearchText(title);
    const italianWords = normalizeSearchText(italianMovieTitle).split(' ')
        .filter((word) => word.length > 2)
        .filter((word) => !['del', 'al', 'dal', 'nel', 'sul', 'un', 'il', 'lo', 'la', 'gli', 'le', 'con', 'per', 'che', 'non'].includes(word));

    if (italianWords.length === 0) return false;
    const matchingWords = italianWords.filter((word) => normalizedTorrentTitle.includes(word));
    return (matchingWords.length / italianWords.length) > 0.6;
}

function isTrustedSource(source, provider = null) {
    const stripPrefix = (str) => stripVisualPrefixes(str || '').toLowerCase();
    const s = stripPrefix(source);
    const p = stripPrefix(provider);

    if (/\bcustom\b/i.test(s) || /\bcustom\b/i.test(p)) return true;
    if (/corsaro/i.test(s) || /corsaro/i.test(p)) return true;

    const mainSource = s.split('(')[0].trim();
    const mainProvider = p.split('(')[0].trim();

    if (/^torrentio$/i.test(mainSource) || /^torrentio$/i.test(mainProvider)) return true;
    return false;
}

function getLanguageInfo(title, italianMovieTitle = null, source = null, parsedInfo = null) {
    if (!title) return { icon: '', isItalian: false, isMaybeItalian: false, isMulti: false, isSubOnly: false, displayLabel: '', detectedLanguages: [], confidence: 0 };

    const cacheKey = `${String(title)}|${String(italianMovieTitle || '')}|${String(source || '')}`;
    const cached = languageInfoCache.get(cacheKey);
    if (cached) return cached;

    const detectedLanguages = [];
    const pushLanguage = (lang) => {
        const normalized = normalizeLanguageName(lang);
        if (normalized && !detectedLanguages.includes(normalized)) detectedLanguages.push(normalized);
    };

    if (parsedInfo?.rawLanguages?.length > 0) {
        parsedInfo.rawLanguages.forEach(pushLanguage);
    } else {
        if (/(ita|italian|italiano)/i.test(title)) pushLanguage('Italian');
        if (/(eng|english)/i.test(title) && !/(eng|english)[.\s\-_]?sub/i.test(title)) pushLanguage('English');
        if (/(multi)/i.test(title) && !/(multi)[.\s\-_]?sub/i.test(title)) pushLanguage('Multi');
        if (/(dual)/i.test(title) && !/(dual)[.\s\-_]?sub/i.test(title)) pushLanguage('Dual Audio');
        if (/(jpn|japanese)/i.test(title)) pushLanguage('Japanese');
        if (/(fra|french)/i.test(title)) pushLanguage('French');
        if (/(ger|german)/i.test(title)) pushLanguage('German');
        if (/(esp|spanish)/i.test(title)) pushLanguage('Spanish');
    }

    const subOnly = REGEX_SUB_ONLY.test(title);
    const explicitIta = /(ita|italian|italiano)/i.test(title);
    const audioConfirmedIta = REGEX_AUDIO_CONFIRM.test(title) || REGEX_CONTEXT_IT.test(title) || /(?:dub(?:bed)?|audio|lang|lingua|doppiat[oa])(?:[\s.\-_:/-]+)(?:it|ita|italian|italiano)/i.test(title);
    const multiIta = REGEX_MULTI_ITA.test(title);
    const isolatedIt = REGEX_ISOLATED_IT.test(title) && !REGEX_FALSE_IT.test(title);
    const trustedGroup = REGEX_TRUSTED_GROUPS.test(title);
    const titleMatched = italianMovieTitle ? isItalianByTitleMatch(title, italianMovieTitle) : false;
    const trustedSource = !!(source && isTrustedSource(source, null));

    let hasIta = detectedLanguages.includes('Italian');
    const hasEng = detectedLanguages.includes('English');
    const hasMulti = detectedLanguages.includes('Multi') || detectedLanguages.includes('Dual Audio');

    let confidence = 0;
    if (hasIta) confidence = Math.max(confidence, subOnly ? 4 : 9);
    if (explicitIta) confidence = Math.max(confidence, subOnly ? 4 : 8);
    if (audioConfirmedIta) confidence = Math.max(confidence, 9);
    if (multiIta) confidence = Math.max(confidence, 7);
    if (trustedGroup) confidence = Math.max(confidence, subOnly ? 4 : 6);
    if (isolatedIt) confidence = Math.max(confidence, 4);
    if (titleMatched) confidence = Math.max(confidence, 5);
    if (trustedSource) confidence = Math.max(confidence, 5);
    if (hasMulti && (explicitIta || audioConfirmedIta || trustedGroup || trustedSource || titleMatched)) confidence = Math.max(confidence, 7);

    if (subOnly && !audioConfirmedIta && !multiIta && !trustedGroup && !trustedSource && !titleMatched) confidence = Math.min(confidence, 2);

    hasIta = confidence >= 5;
    const isMaybeItalian = confidence >= 3;

    let result;
    if (hasIta && hasEng) result = { icon: '🇮🇹 🇬🇧', isItalian: true, isMaybeItalian, isMulti: true, isSubOnly: subOnly, displayLabel: '🇮🇹 🇬🇧', detectedLanguages, confidence };
    else if (hasIta) result = { icon: '🇮🇹', isItalian: true, isMaybeItalian, isMulti: hasMulti, isSubOnly: subOnly, displayLabel: '🇮🇹', detectedLanguages, confidence };
    else if (hasMulti && isMaybeItalian) result = { icon: '🇮🇹 🌈', isItalian: false, isMaybeItalian: true, isMulti: true, isSubOnly: subOnly, displayLabel: '🇮🇹 🌈', detectedLanguages, confidence };
    else if (hasMulti) result = { icon: '🌈', isItalian: false, isMaybeItalian, isMulti: true, isSubOnly: subOnly, displayLabel: '🌈 MULTI', detectedLanguages, confidence };
    else if (hasEng) result = { icon: '🇬🇧', isItalian: false, isMaybeItalian, isMulti: false, isSubOnly: subOnly, displayLabel: '🇬🇧', detectedLanguages, confidence };
    else if (detectedLanguages.length > 0) result = { icon: '🌐', isItalian: false, isMaybeItalian, isMulti: false, isSubOnly: subOnly, displayLabel: '🌐', detectedLanguages, confidence };
    else result = { icon: '', isItalian: false, isMaybeItalian, isMulti: false, isSubOnly: subOnly, displayLabel: '', detectedLanguages, confidence };

    languageInfoCache.set(cacheKey, result);
    return result;
}

function getPreferredLanguageMode(preferredLanguageMode = '') {
    const mode = String(preferredLanguageMode || '').toLowerCase();
    return (mode === 'ita' || mode === 'eng' || mode === 'all') ? mode : '';
}

function formatLanguageLabel(languageInfo, fallbackLanguages = [], preferredLanguageMode = '') {
    const mode = getPreferredLanguageMode(preferredLanguageMode);
    const detected = new Set(Array.isArray(languageInfo?.detectedLanguages) ? languageInfo.detectedLanguages.map((v) => String(v)) : []);
    if (mode === 'eng' && (detected.has('English') || languageInfo?.displayLabel === '🇬🇧')) return '🇬🇧 ENG';
    if (languageInfo?.isItalian && languageInfo?.isMulti) return '🇮🇹/🌍 MULTI';
    if (languageInfo?.isItalian) return '🇮🇹 ITA';
    if (languageInfo?.isMulti) return '🌍 MULTI';
    if (languageInfo?.displayLabel === '🇬🇧') return '🇬🇧 ENG';
    if (languageInfo?.displayLabel) return languageInfo.displayLabel;
    return (fallbackLanguages && fallbackLanguages.length > 0) ? fallbackLanguages.join('/') : '🇬🇧/Unknown';
}

function isSeasonPack(title) {
    if (!title) return false;
    const normalizedTitle = String(title)
        .normalize('NFKC')
        .replace(/第\s*([0-9]{1,2})\s*[期季]/gi, ' season $1 ')
        .replace(/[‐‑–—―〜～]/g, '-')
        .toLowerCase();
    if (/s\d{1,2}e\d{1,2}/i.test(normalizedTitle)) return false;
    if (/\b\d{1,2}x\d{1,3}\b/i.test(normalizedTitle)) return false;

    const packPatterns = [
        /stagion[ei]\s*\d+\s*[-–—]\s*\d+/i,
        /season\s*\d+\s*[-–—]\s*\d+/i,
        /s\d+\s*[-–—]\s*s?\d+/i,
        /\b(?:batch|complete|completa|integrale|collection|全集|合集|cour)\b/i,
        /\bpack\b/i,
        /\b(?:season|stagion[ei])\s*\d+\b/i,
        /\.s\d{1,2}\./i,
        /\.s\d{1,2}$/i,
        /\bs\d{1,2}(?!e)\b/i,
        /\bs\d{1,2}\./i,
        /\btutta\b/i,
        /\bepisodes?\s*\d{1,3}\s*(?:-|~|to|a)\s*\d{1,3}\b/i,
        /\b\d{1,3}\s*(?:-|~|to|a)\s*\d{1,3}\b/i
    ];
    return packPatterns.some((pattern) => pattern.test(normalizedTitle));
}

function isGoodShortQueryMatch(torrentTitle, searchQuery) {
    const cleanedSearchQuery = normalizeSearchText(searchQuery).replace(/\s\(\d{4}\)$/, '').trim();
    if (cleanedSearchQuery.length > 8 || cleanedSearchQuery.length < 2) return true;
    const normalizedTorrentTitle = normalizeSearchText(torrentTitle);
    const searchWords = new Set(cleanedSearchQuery.split(' ').filter(Boolean));
    for (const word of searchWords) {
        const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (!wordRegex.test(normalizedTorrentTitle)) return false;
    }
    return true;
}

function chooseBestPackTitle(item, resolvedPackName = null, siblingStreams = []) {
    const sameHashStreams = siblingStreams.filter((stream) => (stream.hash || stream.infoHash || '').toLowerCase() === (item.hash || item.infoHash || '').toLowerCase());
    const torrentioStream = sameHashStreams.find((stream) => (stream.source || stream.name || '').includes('Torrentio') && String(stream.title || '').includes('📁'));
    if (torrentioStream) {
        const clean = stripVisualPrefixes(String(torrentioStream.title || '').split('\n')[0] || '');
        if (clean && clean.length > 5) return { title: clean, source: 'Torrentio' };
    }
    const mediafusionStream = sameHashStreams.find((stream) => (stream.source || stream.name || '').includes('MediaFusion') && String(stream.title || '').includes('┈➤'));
    if (mediafusionStream) {
        const clean = stripVisualPrefixes(String(mediafusionStream.title || '').split('┈➤')[0].replace('📂', '').trim());
        if (clean && clean.length > 5) return { title: clean, source: 'MediaFusion' };
    }
    const scraperTitle = stripVisualPrefixes(item.title || '');
    if (scraperTitle && scraperTitle.length > 5 && !/^Season \d+$/i.test(scraperTitle) && !/^Stagione \d+$/i.test(scraperTitle)) return { title: scraperTitle, source: 'Scraper' };
    if (resolvedPackName && resolvedPackName.length > 5) return { title: stripVisualPrefixes(resolvedPackName), source: 'Debrid' };
    return { title: scraperTitle || stripVisualPrefixes(resolvedPackName) || item.title || 'Unknown Pack', source: 'Fallback' };
}

function shouldUpdatePackTitle(currentTitle, nextTitle) {
    const curr = stripVisualPrefixes(currentTitle || '').toLowerCase();
    const next = stripVisualPrefixes(nextTitle || '').toLowerCase();
    if (!next || curr === next) return !!currentTitle && currentTitle !== nextTitle;
    if (!/ita|multi/.test(next)) return false;
    if (!/ita|multi/.test(curr)) return true;
    const hasSeasonInfo = /s\d+|season|stagion|complete|episod/i.test(curr);
    const isGenericRd = /^[\w\s]+\s*\[\d{4}[-–]\d{4}\]$/.test(stripVisualPrefixes(currentTitle || ''));
    if (hasSeasonInfo && !isGenericRd) return false;
    return true;
}

module.exports = {
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
};
