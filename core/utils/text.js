const { parseTitleDetails: parseReleaseTitleDetails } = require('../intelligence/release_parser');
const { TinyLruCache } = require('./tiny_lru_cache');
const normalizedTextCache = new TinyLruCache({
    max: Math.max(2000, parseInt(process.env.TEXT_NORMALIZED_CACHE_MAX || '12000', 10) || 12000),
    ttlMs: Math.max(60_000, parseInt(process.env.TEXT_NORMALIZED_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10) || (6 * 60 * 60 * 1000))
});
const languageInfoCache = new TinyLruCache({
    max: Math.max(2000, parseInt(process.env.TEXT_LANGUAGE_CACHE_MAX || '12000', 10) || 12000),
    ttlMs: Math.max(60_000, parseInt(process.env.TEXT_LANGUAGE_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10) || (6 * 60 * 60 * 1000))
});

const REGEX_YEAR = /(19|20)\d{2}/;
const REGEX_QUALITY_FILTER = {
    "4K": /\b(?:2160p|4k|uhd|ultra[-.\s]?hd|2160i)\b/i,
    "1080p": /\b(?:1080p|1080i|fhd|full[-.\s]?hd|blu[-.\s]?ray|bd[-.\s]?rip)\b/i,
    "720p": /\b(?:720p|720i|hd[-.\s]?rip|hd)\b/i,
    "SD": /\b(?:480p|576p|sd|dvd|dvd[-.\s]?rip|dvd[-.\s]?scr|cd)\b/i
};

const REGEX_STRONG_ITA = /\b(ITA|ITALIAN|ITALIANO)\b/i;
const REGEX_CONTEXT_IT = /\b(AUDIO|LINGUA|LANG|VO|AC-?3|AAC|MP3|DDP|DTS|TRUEHD)\W+(IT)\b/i;
const REGEX_ISOLATED_IT = /(?:^|[\s_\-\[\(])(IT)(?:$|[\s_\-\]\)])/i;
const REGEX_DOMAIN_IT = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.it(?:[\/:?#]|$|[\s_\-\]\)])/gi;
const REGEX_TRACKER_DOMAIN = /\b(?:tracker|announce|torrent|download|ddl|stream|www)\.[a-z0-9.-]+\.it\b/gi;
const REGEX_MULTI_ITA = /\b(MULTI|DUAL|TRIPLE).*(ITA|ITALIAN)\b/i;
const REGEX_TRUSTED_GROUPS = /\b(iDN_CreW|CORSARO|MUX|WMS|TRIDIM|SPEEDVIDEO|EAGLE|TRL|MEA|LUX|DNA|LEST|GHIZZO|USAbit|Bric|Dtone|Gaiage|BlackBit|Pantry|Vics|Papeete|Lidri|MirCrew)\b/i;
const REGEX_FALSE_IT = /\b(10BIT|BIT|WIT|HIT|FIT|KIT|SIT|LIT|PIT)\b/i;
const REGEX_SUB_ONLY = /\b(SUB|SUBS|SUBBED|SOTTOTITOLI|VOST|VOSTIT)\s*[:.\-_]?\s*(ITA|IT|ITALIAN)\b/i;
const REGEX_AUDIO_CONFIRM = /(?:🇮🇹|\b(?:AUDIO|AC3|AAC|DTS|MD|LD|DDP|MP3|LINGUA)[\s.\-_]+(?:\d[\s.,]?\d[\s.\-_]+)?(?:ITA|IT)\b|\b(?:ITA|ITALIAN|ITALIANO)[\s.\-_]+(?:\d[\s.,]?\d[\s.\-_]+)?(?:AUDIO|DUB|DUBBED|AC3|AAC|DTS|DDP|EAC3|TRUEHD|ATMOS)\b)/i;

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

const REGEX_STRICT_GLOBAL_LANGUAGE_SOURCE = /(?:^|[\s._\-()\[\]|:])(?:the\s*pirate\s*bay|thepiratebay|piratebay|tpb|best\s*torrents?|besttorrents?)(?:$|[\s._\-()\[\]|:])/i;

function stripFalseItalianDomainTokens(value) {
    return String(value || '')
        .replace(REGEX_TRACKER_DOMAIN, ' ')
        .replace(REGEX_DOMAIN_IT, ' ')
        .replace(/\b[a-z0-9-]+\.it\b/gi, ' ');
}

function isStrictGlobalLanguageSource(source = '') {
    return REGEX_STRICT_GLOBAL_LANGUAGE_SOURCE.test(` ${String(source || '')} `);
}

function parseTitleDetails(filename) {
    return parseReleaseTitleDetails(filename);
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

const TITLE_MATCH_STOPWORDS = new Set(['del', 'al', 'dal', 'nel', 'sul', 'un', 'il', 'lo', 'la', 'gli', 'le', 'con', 'per', 'che', 'non']);

function significantTitleWords(value) {
    return normalizeSearchText(value).split(' ')
        .filter((word) => word.length > 2)
        .filter((word) => !TITLE_MATCH_STOPWORDS.has(word));
}

function isItalianByTitleMatch(title, italianMovieTitle = null, originalTitle = null) {
    if (!title || !italianMovieTitle) return false;
    const normalizedTorrentTitle = normalizeSearchText(title);
    const originalWords = new Set(originalTitle ? significantTitleWords(originalTitle) : []);
    const italianWords = significantTitleWords(italianMovieTitle).filter((word) => !originalWords.has(word));

    if (italianWords.length === 0) return false;
    if (originalWords.size === 0 && italianWords.length < 2) return false;
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

    return false;
}

const NEUTRAL_LANGUAGE_TOKENS = new Set(['Italian', 'English', 'Multi', 'Dual Audio', 'Multi subs', 'Multi audio']);

function getLanguageInfo(title, italianMovieTitle = null, source = null, parsedInfo = null, originalTitle = null) {
    if (!title) return { icon: '', isItalian: false, isMaybeItalian: false, isMulti: false, isSubOnly: false, displayLabel: '', detectedLanguages: [], confidence: 0 };

    const cacheKey = `${String(title)}|${String(italianMovieTitle || '')}|${String(source || '')}|${String(originalTitle || '')}`;
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
        const languageScanTitle = stripFalseItalianDomainTokens(title);
        if (/(🇮🇹|\bita\b|italian|italiano)/i.test(languageScanTitle)) pushLanguage('Italian');
        if (/(🇬🇧|🇺🇸|\beng\b|english)/i.test(languageScanTitle) && !/(eng|english)[.\s\-_]?sub/i.test(languageScanTitle)) pushLanguage('English');
        if (/(multi)/i.test(languageScanTitle) && !/(multi)[.\s\-_]?sub/i.test(languageScanTitle)) pushLanguage('Multi');
        if (/(dual)/i.test(languageScanTitle) && !/(dual)[.\s\-_]?sub/i.test(languageScanTitle)) pushLanguage('Dual Audio');
        if (/(jpn|japanese)/i.test(languageScanTitle)) pushLanguage('Japanese');
        if (/(fra|french)/i.test(languageScanTitle)) pushLanguage('French');
        if (/(ger|german)/i.test(languageScanTitle)) pushLanguage('German');
        if (/(esp|spanish)/i.test(languageScanTitle)) pushLanguage('Spanish');
    }

    const subOnly = REGEX_SUB_ONLY.test(title);
    const scanTitle = stripFalseItalianDomainTokens(title);
    const explicitIta = /(🇮🇹|\bita\b|italian|italiano)/i.test(scanTitle);
    const audioConfirmedIta = REGEX_AUDIO_CONFIRM.test(scanTitle) || REGEX_CONTEXT_IT.test(scanTitle) || /(?:dub(?:bed)?|audio|lang|lingua|doppiat[oa])(?:[\s.\-_:/-]+)(?:it|ita|italian|italiano)/i.test(scanTitle);
    const multiIta = REGEX_MULTI_ITA.test(scanTitle);
    const isolatedIt = REGEX_ISOLATED_IT.test(scanTitle) && !REGEX_FALSE_IT.test(scanTitle);
    const trustedGroup = REGEX_TRUSTED_GROUPS.test(title);
    const titleMatched = italianMovieTitle ? isItalianByTitleMatch(title, italianMovieTitle, originalTitle) : false;
    const trustedSource = !!(source && isTrustedSource(source, null));
    const strictGlobalSource = isStrictGlobalLanguageSource(source);
    const foreignDeclared = detectedLanguages.some((lang) => !NEUTRAL_LANGUAGE_TOKENS.has(lang)) && !detectedLanguages.includes('Italian');

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

    if (foreignDeclared && !explicitIta && !audioConfirmedIta && !multiIta && !trustedGroup) confidence = Math.min(confidence, 2);
    if (subOnly && !audioConfirmedIta && !multiIta && !trustedGroup && !trustedSource && !titleMatched) confidence = Math.min(confidence, 2);
    if (strictGlobalSource && !explicitIta && !audioConfirmedIta && !multiIta && !trustedGroup) confidence = Math.min(confidence, 2);

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
    if (languageInfo?.isItalian && detected.has('English')) return '🇮🇹/🇬🇧 ITA/ENG';
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

    const explicitRangePackPatterns = [
        /\bs\d{1,2}e\d{1,3}\s*(?:-|~|to|a)\s*(?:e)?\d{1,3}\b/i,
        /\bs\d{1,2}\s*(?:-|~|to|a)\s*(?:s)?\d{1,2}\b/i,
        /\b(?:season|stagion[ei])\s*\d{1,2}\s*(?:-|~|to|a)\s*\d{1,2}\b/i,
        /\bepisodes?\s*\d{1,3}\s*(?:-|~|to|a)\s*\d{1,3}\b/i,
        /\bepisodi?\s*\d{1,3}\s*(?:-|~|to|a)\s*\d{1,3}\b/i
    ];
    if (explicitRangePackPatterns.some((pattern) => pattern.test(normalizedTitle))) return true;

    if (/s\d{1,2}e\d{1,3}/i.test(normalizedTitle)) return false;
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
    REGEX_DOMAIN_IT,
    REGEX_MULTI_ITA,
    REGEX_TRUSTED_GROUPS,
    REGEX_FALSE_IT,
    REGEX_SUB_ONLY,
    REGEX_AUDIO_CONFIRM,
    languageMapping,
    normalizeLanguageName,
    stripFalseItalianDomainTokens,
    isStrictGlobalLanguageSource,
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
