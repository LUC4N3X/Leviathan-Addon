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

function parseTitleDetails(filename) {
    if (!filename) return { quality: 'SD', tags: '', languages: [], rawLanguages: [], cleanTitle: '' };
    const cacheKey = String(filename);
    const cached = parsedTitleCache.get(cacheKey);
    if (cached) return cached;

    let result;
    try {
        const info = ptt.parse(cacheKey);
        const codec = info.codec ? info.codec.toUpperCase() : '';
        const audio = info.audio ? info.audio.toUpperCase() : '';
        const source = info.source ? info.source.toUpperCase() : '';

        const rawLanguages = Array.isArray(info.languages)
            ? Array.from(new Set(info.languages.map(normalizeLanguageName).filter(Boolean)))
            : [];

        const displayLanguages = rawLanguages.map((language) => languageMapping[language.toLowerCase()] || language.substring(0, 3).toUpperCase());

        result = {
            quality: info.resolution || 'SD',
            tags: [source, codec, audio].filter(Boolean).join(' '),
            languages: displayLanguages,
            rawLanguages,
            cleanTitle: info.title || ''
        };
    } catch (e) {
        result = { quality: 'SD', tags: '', languages: [], rawLanguages: [], cleanTitle: '' };
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

function formatLanguageLabel(languageInfo, fallbackLanguages = []) {
    if (languageInfo?.isItalian && languageInfo?.isMulti) return '🇮🇹/🌍 MULTI';
    if (languageInfo?.isItalian) return '🇮🇹 ITA';
    if (languageInfo?.isMulti) return '🌍 MULTI';
    if (languageInfo?.displayLabel === '🇬🇧') return '🇬🇧 ENG';
    if (languageInfo?.displayLabel) return languageInfo.displayLabel;
    return (fallbackLanguages && fallbackLanguages.length > 0) ? fallbackLanguages.join('/') : '🇬🇧/Unknown';
}

function isSeasonPack(title) {
    if (!title) return false;
    const lowerTitle = String(title).toLowerCase();
    if (/s\d{1,2}e\d{1,2}/i.test(lowerTitle)) return false;

    const packPatterns = [
        /stagion[ei]\s*\d+\s*[-–—]\s*\d+/i, /season\s*\d+\s*[-–—]\s*\d+/i, /s\d+\s*[-–—]\s*s?\d+/i,
        /completa/i, /complete/i, /integrale/i, /collection/i, /\bpack\b/i,
        /stagion[ei]\s*\d+/i, /season\s*\d+/i, /\.s\d{1,2}\./i, /\.s\d{1,2}$/i,
        /\bs\d{1,2}(?!e)\b/i, /\bs\d{1,2}\./i, /\btutta\b/i
    ];
    return packPatterns.some((pattern) => pattern.test(lowerTitle));
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
