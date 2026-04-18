const axios = require('axios');
const he = require('he');
const https = require('https');

const DEFAULT_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonoid.ch:6969/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.therarbg.to:6969/announce',
    'udp://tracker.doko.moe:6969/announce',
    'udp://opentracker.i2p.rocks:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.moeking.me:6969/announce'
];

const MIRRORS = (() => {
    const preferred = [
        'https://nyaa.si',
        String(process.env.NYAA_DOMAIN || '').trim().replace(/\/+$/, ''),
        'https://nyaa.land',
        'https://nyaa.ink',
        'https://nyaa.eu',
        'https://nyaa.iss.one'
    ].filter(Boolean);
    return Array.from(new Set(preferred));
})();

const CONFIG = {
    REQUEST_TIMEOUT: Number(process.env.NYAA_ANIME_TIMEOUT || 4500),
    SEARCH_TIMEOUT: Number(process.env.NYAA_ANIME_SEARCH_TIMEOUT || 14000),
    SEARCH_CACHE_TTL: Number(process.env.NYAA_ANIME_CACHE_TTL || 1000 * 60 * 20),
    NEGATIVE_CACHE_TTL: Number(process.env.NYAA_ANIME_NEGATIVE_CACHE_TTL || 3500),
    ERROR_CACHE_TTL: Number(process.env.NYAA_ANIME_ERROR_CACHE_TTL || 1500),
    MIRROR_COOLDOWN_MS: Number(process.env.NYAA_ANIME_MIRROR_COOLDOWN_MS || 30000),
    MAX_QUERY_VARIANTS: Number(process.env.NYAA_ANIME_MAX_QUERY_VARIANTS || 6), 
    MAX_RESULTS: Number(process.env.NYAA_ANIME_MAX_RESULTS || 160),
    EARLY_STOP_RESULTS: Number(process.env.NYAA_ANIME_EARLY_STOP_RESULTS || 3) // Si ferma a 3 risultati validi
};

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 24,
    maxFreeSockets: 8
});

const searchCache = new Map();
const inflight = new Map();
const mirrorHealth = new Map();

const QUALITY_SCORES = [
    { regex: /\b(?:2160p|4k|uhd)\b/i, value: 40 },
    { regex: /\b1080p\b/i, value: 28 },
    { regex: /\b720p\b/i, value: 18 },
    { regex: /\b(?:480p|sd)\b/i, value: 10 }
];

const NEGATIVE_LANGUAGE_REGEX = /\b(?:TRUEFRENCH|FRENCH|GERMAN|SPANISH|LATINO|RUSSIAN|POLISH|TAMIL|TELUGU|HINDI|KOREAN|JAPANESE|ESPANOL|MULTi-?SUB)\b/i;
const ITALIAN_AUDIO_REGEX = /\b(?:ITA(?:LIAN(?:O)?)?(?:\s*(?:AUDIO|DDP|AAC|AC3|EAC3|ATMOS|TRUEHD|DTS(?:-?HD)?))?|MULTI\s*ITA|DUAL\s*AUDIO\s*ITA|TRUE\s*ITALIAN|AUDIO\s*ITA|ITA\s*AC3|ITA\s*AAC|ITA\s*DDP|ITA\s*DTS|ITA\s*TRUEHD)\b/i;
const ITALIAN_SUB_REGEX = /\b(?:SUB[-.\s_]*ITA|SOFTSUB[-.\s_]*ITA|VOST(?:ITA)?|ITALIAN\s*SUBS?)\b/i;
const ENGLISH_AUDIO_REGEX = /\b(?:ENG(?:LISH)?(?:\s*(?:AUDIO|DDP|AAC|AC3|EAC3|ATMOS|TRUEHD|DTS(?:-?HD)?))?|TRUE\s*ENGLISH|AUDIO\s*ENG|ENG\s*AC3|ENG\s*AAC|ENG\s*DDP|ENG\s*DTS|ENG\s*TRUEHD|ENG(?:LISH)?\s*ONLY)\b/i;
const MULTI_LANGUAGE_REGEX = /\b(?:MULTI(?:LANG|AUDIO)?|DUAL\s*AUDIO)\b/i;
const NOISY_TITLE_REGEX = /\b(?:sample|soundtrack|trailer|ebook|audiobook|xxx|porn)\b/i;
const PACK_REGEX = /\b(?:BATCH|COMPLETE|PACK|COLLECTION|全集|END|FINALE)\b/i;
const ANIME_RELEASE_GROUP_REGEX = /\b(?:ERAI[-.\s]?RAWS?|ERAISE|SUBSPLEASE|HORRIBLESUBS|EMBER|JUDAS|ASW|RAZE|MUSE|YAMEII|DKB|SCYRO|SSA|KAWAIIKITTY|KITSUNE|EMBER)\b/i;
const ROMAN_PATTERN = /\b(?:x|ix|iv|v?i{0,3})\b/i;

function now() { return Date.now(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function withTimeout(promise, ms) {
    let timer = null;
    return new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout of ${ms}ms exceeded`)), ms);
        Promise.resolve(promise)
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(timer));
    });
}

function getCache(key) {
    const cached = searchCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= now()) {
        searchCache.delete(key);
        return null;
    }
    return cached.value;
}

function setCache(key, value, ttl) {
    searchCache.set(key, { value, expiresAt: now() + ttl });
    if (searchCache.size > 500) {
        const ts = now();
        for (const [cacheKey, entry] of searchCache.entries()) {
            if (!entry || entry.expiresAt <= ts) searchCache.delete(cacheKey);
        }
        while (searchCache.size > 350) {
            const firstKey = searchCache.keys().next().value;
            if (!firstKey) break;
            searchCache.delete(firstKey);
        }
    }
    return value;
}

function romanToArabic(input) {
    const map = { i: 1, v: 5, x: 10, l: 50, c: 100 };
    let total = 0, prev = 0;
    for (const char of String(input || '').toLowerCase().split('').reverse()) {
        const value = map[char] || 0;
        total += value < prev ? -value : value;
        prev = value;
    }
    return total;
}

function cleanText(value) {
    return he.decode(String(value || ''))
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/[“”„‟«»]/g, ' ')
        .replace(/[‘’`´]/g, "'")
        .replace(/[^\w\s\-.:()[\]~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeSpaces(value) {
    return String(value || '').replace(/[\u2010-\u2015]/g, '-').replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeSearchKey(value) {
    return cleanText(value)
        .toLowerCase()
        .replace(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, (match) => String(romanToArabic(match)))
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeTitle(value) {
    return cleanText(value).toLowerCase()
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b(?:the|a|an|un|una|il|lo|la|gli|le|di|de|del|della|season|stagione|episode|episodio|part|cour)\b/g, ' ')
        .replace(/\b(?:2160p|1080p|720p|480p|x264|x265|h264|h265|hevc|hdr|dv|ddp|aac|ac3|eac3|flac|remux|webdl|webrip|bluray|brrip|dvdrip|bdrip|batch|complete|pack)\b/g, ' ')
        .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
        .replace(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, (match) => String(romanToArabic(match)))
        .split(/\s+/).filter((token) => token && token.length > 1 && !/^\d+$/.test(token));
}

function titleMatchScore(candidate, expectedTitle) {
    const candSet = new Set(tokenizeTitle(candidate));
    const expectedSet = new Set(tokenizeTitle(expectedTitle));
    if (!candSet.size || !expectedSet.size) return 0;
    let hits = 0;
    for (const token of expectedSet) { if (candSet.has(token)) hits += 1; }
    return hits / Math.max(expectedSet.size, 1);
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = String(sizeStr).replace(',', '.').match(/([\d.]+)\s*(PB|TB|GB|MB|KB|B|PIB|TIB|GIB|MIB|KIB)/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = match[2].toUpperCase();
    const multipliers = { B: 1, KB: 1024, KIB: 1024, MB: 1024**2, MIB: 1024**2, GB: 1024**3, GIB: 1024**3, TB: 1024**4, TIB: 1024**4, PB: 1024**5, PIB: 1024**5 };
    return Math.round(value * (multipliers[unit] || 1));
}

function bytesToSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '?? GB';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), sizes.length - 1);
    return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${sizes[index]}`;
}

function extractEpisodeContext(imdbId) {
    if (!imdbId || typeof imdbId !== 'string') return {};
    const parts = imdbId.split(':');
    if (parts.length < 3) return {};
    let season, episode;
    if (parts[0].toLowerCase() === 'kitsu' && /^\d+$/.test(parts[1])) {
        if (parts.length >= 4) season = parseInt(parts[2], 10);
        episode = parseInt(parts[parts.length >= 4 ? 3 : 2], 10);
    } else {
        season = parseInt(parts[1], 10);
        episode = parseInt(parts[2], 10);
    }
    return {
        season: Number.isInteger(season) && season > 0 ? season : undefined,
        episode: Number.isInteger(episode) && episode > 0 ? episode : undefined
    };
}

function parseSeasonFromText(value) {
    const text = normalizeSearchKey(value);
    if (!text) return undefined;
    let match = text.match(/\b(?:season|stagione)\s*(\d{1,2})\b/i) || text.match(/\bs\s*(\d{1,2})\b/i) || text.match(/\bs(\d{1,2})\b/i) || text.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i);
    if (match) return parseInt(match[1], 10) > 0 ? parseInt(match[1], 10) : undefined;
    match = String(value || '').match(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b\s+season/i);
    if (match) return romanToArabic(match[1]) > 0 ? romanToArabic(match[1]) : undefined;
    return undefined;
}

function stripEpisodeWords(value) {
    return normalizeSpaces(String(value || '')).replace(/\b(?:episode|episodio|ep|e)\s*\d{1,4}\b/gi, ' ').replace(/\b\d{1,2}x\d{1,4}\b/gi, ' ').replace(/\bs\d{1,2}e\d{1,4}\b/gi, ' ').replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripSeasonWords(value) {
    return normalizeSpaces(String(value || '')).replace(/\b(?:season|stagione)\s*(?:\d{1,2}|i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, ' ').replace(/\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi, ' ').replace(/\bs\d{1,2}\b/gi, ' ').replace(/\b(?:part|cour)\s*\d{1,2}\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

function hasExplicitSeasonMarker(text = '') { return /\b(?:S(?:EASON)?\s*0?\d{1,2}|\d{1,2}x\d{1,3}|STAGIONE\s*0?\d{1,2}|(?:1ST|2ND|3RD|4TH|5TH|6TH)\s+SEASON)\b/i.test(String(text || '')); }

function dedupeStrings(values = []) {
    const seen = new Set(), output = [];
    for (const value of values) {
        const normalized = normalizeSearchKey(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(normalizeSpaces(value));
    }
    return output;
}

function collectMetaStrings(meta = {}) {
    return dedupeStrings([ meta.title, meta.originalTitle, meta.originalName, ...(meta.aka_titles || []), ...(meta.aliases || []), ...(meta.titles || []), ...(meta.alternativeTitles || []), ...(meta.altTitles || []) ]);
}

function buildContext(title, year, type, imdbId, options = {}) {
    const meta = options.meta || {};
    const episodeContext = extractEpisodeContext(imdbId);
    const explicitLang = String(options.langMode || options.languageMode || options.language || '').toLowerCase();
    const langMode = explicitLang === 'eng' || explicitLang === 'all' || explicitLang === 'ita' ? explicitLang : (options.allowEng ? 'all' : 'ita');
    const isAnime = String(type || '').toLowerCase() === 'anime' || String(imdbId || '').toLowerCase().startsWith('kitsu:') || options.isAnime === true;
    
    const detectedSeason = Number(meta.season) || parseSeasonFromText(title) || collectMetaStrings(meta).map(parseSeasonFromText).find(Boolean);
    const requestedEpisode = Number(meta.episode) || Number(meta.anime_episode) || episodeContext.episode;
    const absoluteEpisode = Number(meta.anime_absolute_episode) || Number(meta.requested_kitsu_episode) || requestedEpisode;

    return {
        title: normalizeSpaces(title), year: Number.parseInt(year, 10) || null, type, imdbId,
        reqSeason: Number.isInteger(detectedSeason) && detectedSeason > 0 ? detectedSeason : episodeContext.season,
        reqEpisode: Number.isInteger(requestedEpisode) && requestedEpisode > 0 ? requestedEpisode : undefined,
        absoluteEpisode: Number.isInteger(absoluteEpisode) && absoluteEpisode > 0 ? absoluteEpisode : undefined,
        langMode, isAnime, meta, plannerQueries: Array.isArray(options.plannerQueries) ? options.plannerQueries : []
    };
}

function collectTitleCandidates(context) {
    const raw = dedupeStrings([context.title, ...collectMetaStrings(context.meta), ...(context.plannerQueries || [])]);
    const expanded = new Set();
    const add = (val) => { const n = normalizeSpaces(val); if(n && n.length>1) expanded.add(n); };
    for (const entry of raw) {
        add(entry); add(stripEpisodeWords(entry)); add(stripSeasonWords(stripEpisodeWords(entry)));
        const base = stripSeasonWords(stripEpisodeWords(entry));
        const season = parseSeasonFromText(stripEpisodeWords(entry)) || context.reqSeason;
        if (base && season > 1) { add(`${base} Season ${season}`); add(`${base} S${season}`); }
    }
    return dedupeStrings([...expanded]);
}

function getEpisodeNumbers(context) {
    const numbers = [];
    [context.reqEpisode, context.absoluteEpisode].forEach(v => { if(Number.isInteger(Number(v)) && Number(v)>0 && !numbers.includes(Number(v))) numbers.push(Number(v)); });
    return numbers;
}

// LOGICA QUERIES RIORGANIZZATA: Ordine letale per evitare timeout
function buildQueries(context) {
    const titles = collectTitleCandidates(context);
    const episodes = getEpisodeNumbers(context);
    const queries = [];
    const seen = new Set();
    
    const isIta = context.langMode === 'ita' || context.langMode === 'all';

    const push = (value) => {
        const normalized = normalizeSearchKey(value);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        queries.push(normalizeSpaces(value));
    };

    const buildEpisodeVariants = (episode) => {
        const plain = String(Number(episode));
        return [plain.padStart(2, '0'), plain]; // Solo i due formati più diffusi: "01" e "1"
    };

    if (episodes.length > 0) {
        for (const title of titles) {
            const base = stripSeasonWords(stripEpisodeWords(title)) || title;
            for (const episode of episodes) {
                const epVariants = buildEpisodeVariants(episode);
                
                // 1. Cerca il singolo episodio ITA
                if (isIta) push(`${base} ${epVariants[0]} ita`);
                
                // 2. SALVAVITA: Cerca subito il pacchetto batch completo
                if (isIta) push(`${base} batch ita`);
                push(`${base} batch`);

                // 3. Fallback per l'episodio singolo generico (no ITA)
                push(`${base} ${epVariants[0]}`);
                push(`${base} ${epVariants[1]}`);

                // 4. Ricerca larga (salverà se l'uploader ha formattato in modo strano)
                if (isIta) push(`${base} ita`);
                push(base);
            }
        }
    } else {
        for (const title of titles) {
            const base = stripSeasonWords(stripEpisodeWords(title)) || title;
            if (isIta) push(`${base} batch ita`);
            push(`${base} batch`);
            if (isIta) push(`${base} ita`);
            push(base);
        }
    }

    return queries.slice(0, CONFIG.MAX_QUERY_VARIANTS);
}

function getLanguageScore(name, langMode = 'ita', context = {}) {
    const normalized = normalizeSpaces(name).toUpperCase();
    const animeMode = Boolean(context?.isAnime);
    const hasItalianAudio = ITALIAN_AUDIO_REGEX.test(normalized);
    const hasItalianSubs = ITALIAN_SUB_REGEX.test(normalized);
    const hasEnglishAudio = ENGLISH_AUDIO_REGEX.test(normalized);
    const hasMultiLanguage = MULTI_LANGUAGE_REGEX.test(normalized);
    const hasOtherLanguage = NEGATIVE_LANGUAGE_REGEX.test(normalized);
    const trustedAnime = ANIME_RELEASE_GROUP_REGEX.test(normalized);

    if (langMode === 'eng') {
        if (hasEnglishAudio) return hasMultiLanguage ? 34 : 36;
        if (hasItalianAudio || hasItalianSubs) return -30;
        if (hasOtherLanguage) return -35;
        return (animeMode && trustedAnime) ? 18 : 10;
    }
    if (langMode === 'all') {
        if (hasOtherLanguage && !hasItalianAudio && !hasEnglishAudio && !hasMultiLanguage && !trustedAnime) return -16;
        if (hasItalianAudio) return 34;
        if (hasEnglishAudio) return 26;
        if (hasMultiLanguage) return 22;
        if (hasItalianSubs) return 16;
        return (animeMode && trustedAnime) ? 22 : 8;
    }
    if (hasItalianAudio) return 32;
    if (hasItalianSubs) return 20;
    if (hasMultiLanguage) return animeMode ? 18 : 10;
    if (animeMode && trustedAnime) return 18;
    if (hasEnglishAudio && !hasOtherLanguage) return animeMode ? 6 : -24;
    if (hasOtherLanguage) return -30;
    return animeMode ? 6 : -10;
}

function checkYear(name, year, type) {
    if (!year || String(type || '').toLowerCase() !== 'movie') return true;
    const matches = [...String(name).matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => parseInt(m[1], 10));
    if (!matches.length) return true;
    return matches.some((candidate) => Math.abs(candidate - year) <= 1);
}

function isPackTitle(title) {
    const normalized = normalizeSpaces(title).toUpperCase();
    return PACK_REGEX.test(normalized) || /\b\d{1,4}\s*[~\-]\s*\d{1,4}\b/.test(normalized);
}

function getEpisodeMatches(normalizedTitle, reqEpisode) {
    const hits = new Set();
    if (!(reqEpisode > 0)) return hits;
    const patterns = [ /(?:^|\D)(\d{1,4})\s*[~\-]\s*(\d{1,4})(?=\D|$)/g, /\bEP(?:ISODE)?\s*(\d{1,4})\b/gi, /\bE\s*(\d{1,4})\b/gi, /(?:^|\D)-(\d{1,4})(?=\D|$)/g, /(?:^|\D)\s(\d{2,4})(?=\D|$)/g ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(normalizedTitle)) !== null) {
            if (match.length >= 3 && match[2] !== undefined) {
                const start = parseInt(match[1], 10), end = parseInt(match[2], 10);
                if (Number.isInteger(start) && Number.isInteger(end) && reqEpisode >= Math.min(start, end) && reqEpisode <= Math.max(start, end)) hits.add(reqEpisode);
                continue;
            }
            if (parseInt(match[1], 10) === reqEpisode) hits.add(reqEpisode);
        }
    }
    return hits;
}

function isCorrectAnimeFormat(title, context) {
    const reqEpisode = Number(context?.reqEpisode || context?.absoluteEpisode || 0);
    if (!reqEpisode) return true;
    const normalized = normalizeSpaces(title).toUpperCase();
    const reqSeason = Number(context?.reqSeason || 0);
    const ignoreSeason = Boolean(context?.meta?.anime_absolute_episode) || (String(context?.imdbId || '').toLowerCase().startsWith('kitsu:') && (!reqSeason || !hasExplicitSeasonMarker(context?.title || '')));

    const seasonEpisodePatterns = [ /S(\d{1,2})E(\d{1,3})/i, /\b(\d{1,2})x(\d{1,3})\b/i, /SEASON[ ._-]?(\d{1,2}|I|II|III|IV|V|VI|VII|VIII|IX|X)[ ._-]?EP(?:ISODE)?[ ._-]?(\d{1,3})/i, /STAGIONE[ ._-]?(\d{1,2}|I|II|III|IV|V|VI|VII|VIII|IX|X)[ ._-]?EP(?:ISODIO)?[ ._-]?(\d{1,3})/i ];
    for (const pattern of seasonEpisodePatterns) {
        const match = normalized.match(pattern);
        if (!match) continue;
        const rawSeason = match[1], season = /^\d+$/.test(rawSeason) ? parseInt(rawSeason, 10) : romanToArabic(rawSeason);
        if (reqSeason && Number.isInteger(season) && season !== reqSeason && !ignoreSeason) return false;
        return parseInt(match[2], 10) === reqEpisode;
    }
    const seasonOnly = normalized.match(/\b(?:SEASON|STAGIONE)\s*(\d{1,2}|I|II|III|IV|V|VI|VII|VIII|IX|X)\b/i) || normalized.match(/\b(\d{1,2})(?:ST|ND|RD|TH)\s+SEASON\b/i) || normalized.match(/\bS(\d{1,2})\b/i);
    if (seasonOnly && reqSeason && !ignoreSeason) {
        const season = /^\d+$/.test(seasonOnly[1]) ? parseInt(seasonOnly[1], 10) : romanToArabic(seasonOnly[1]);
        if (Number.isInteger(season) && season !== reqSeason && !isPackTitle(normalized)) return false;
    }
    if (isPackTitle(normalized)) return true;
    if (getEpisodeMatches(` ${normalized} `, reqEpisode).has(reqEpisode)) return true;
    const directMatch = normalized.replace(/^\[[^\]]+\]\s*/, '').match(/(?:^|\D)(\d{2,4})(?=\D|$)/g) || [];
    return directMatch.some((chunk) => parseInt(chunk.replace(/\D/g, ''), 10) === reqEpisode);
}

function buildMagnetFromHash(hash, name = '') {
    if (!hash) return null;
    return `magnet:?xt=urn:btih:${hash}${name ? `&dn=${encodeURIComponent(name)}` : ''}`;
}

function appendTrackers(magnet) {
    if (!magnet) return null;
    if (magnet.includes('&tr=') || magnet.includes('?tr=')) return magnet;
    const trackers = [...new Set(DEFAULT_TRACKERS)].slice(0, 15);
    return trackers.length ? `${magnet}${magnet.includes('?') ? '&' : '?'}${trackers.map((tracker) => `tr=${encodeURIComponent(tracker)}`).join('&')}` : magnet;
}

function getResolutionScore(text) {
    for (const item of QUALITY_SCORES) { if (item.regex.test(normalizeSpaces(text))) return item.value; }
    return 0;
}

function computeScore(result, context) {
    const seeders = Math.max(0, Number(result.seeders) || 0), sizeBytes = Math.max(0, Number(result.sizeBytes) || 0);
    const overlapScore = Math.round(titleMatchScore(result.title, stripSeasonWords(stripEpisodeWords(context.title)) || context.title) * 50);
    const languageScore = getLanguageScore(result.title, context.langMode, context) * 2;
    const resolutionScore = getResolutionScore(result.title);
    const packScore = isPackTitle(result.title) ? 16 : 0;
    const episodeScore = isCorrectAnimeFormat(result.title, context) ? 34 : -90;
    const releaseGroupScore = ANIME_RELEASE_GROUP_REGEX.test(result.title) ? 24 : 0;
    const sizeScore = sizeBytes > 0 ? Math.min(16, Math.round(Math.log10(sizeBytes + 1))) : 0;
    return languageScore + resolutionScore + overlapScore + packScore + episodeScore + releaseGroupScore + sizeScore + Math.min(32, Math.round(Math.log2(seeders + 1) * 4));
}

function normalizeResult(raw, context) {
    const title = normalizeSpaces(raw?.title || raw?.name || ''), hash = String(raw?.hash || '').trim().toLowerCase();
    if (!title || !hash || NOISY_TITLE_REGEX.test(title) || titleMatchScore(title, stripSeasonWords(stripEpisodeWords(context.title)) || context.title) < 0.12) return null;
    if (!checkYear(title, context.year, context.type) || !isCorrectAnimeFormat(title, context) || getLanguageScore(title, context.langMode, context) < 0) return null;

    const sizeBytes = Number(raw?.sizeBytes) || parseSize(raw?.size || '');
    const result = {
        title, magnet: appendTrackers(buildMagnetFromHash(hash, title)), hash, sizeBytes,
        size: raw?.size || (sizeBytes > 0 ? bytesToSize(sizeBytes) : ''), seeders: Math.max(0, parseInt(raw?.seeders, 10) || 0), source: 'NyaaSi'
    };
    result._score = computeScore(result, context);
    return result;
}

function dedupeResults(results) {
    const bestByHash = new Map();
    for (const result of results) {
        if (!result || !result.hash) continue;
        const existing = bestByHash.get(result.hash);
        if (!existing || (result._score || 0) > (existing._score || 0) || ((result._score || 0) === (existing._score || 0) && (result.seeders || 0) > (existing.seeders || 0))) {
            bestByHash.set(result.hash, result);
        }
    }
    return [...bestByHash.values()];
}

function getOrderedMirrors() {
    const ts = now();
    return [...MIRRORS].sort((a, b) => {
        const aPenalty = (mirrorHealth.get(a)?.cooldownUntil || 0) > ts ? 1 : 0;
        const bPenalty = (mirrorHealth.get(b)?.cooldownUntil || 0) > ts ? 1 : 0;
        return aPenalty !== bPenalty ? aPenalty - bPenalty : (mirrorHealth.get(a)?.failures || 0) - (mirrorHealth.get(b)?.failures || 0);
    });
}

function markMirrorFailure(mirror) {
    const current = mirrorHealth.get(mirror) || { failures: 0, cooldownUntil: 0 };
    current.failures += 1;
    current.cooldownUntil = now() + CONFIG.MIRROR_COOLDOWN_MS;
    mirrorHealth.set(mirror, current);
}

function markMirrorSuccess(mirror) { mirrorHealth.set(mirror, { failures: 0, cooldownUntil: 0, okAt: now() }); }
function isCloudflareResponse(data) { return typeof data === 'string' && /cloudflare|verify you are human|attention required|cf-browser-verification/i.test(data); }
function looksLikeHtml(data) { return /<!DOCTYPE html|<html\b|<head\b|<body\b/i.test(String(data || '').slice(0, 2000)); }
function decodeXmlEntities(value = '') { return he.decode(String(value || '')).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim(); }

async function requestHtmlFromMirror(mirror, query) {
    const url = `${mirror.replace(/\/+$/, '')}/?f=2&c=1_0&s=seeders&o=desc&q=${encodeURIComponent(query)}`;
    const response = await axios.get(url, {
        timeout: CONFIG.REQUEST_TIMEOUT, httpsAgent, responseType: 'text',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        validateStatus: (status) => status >= 200 && status < 500
    });
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
    if (isCloudflareResponse(response.data)) throw new Error('Cloudflare HTML block');
    if (!looksLikeHtml(response.data)) throw new Error('Non-HTML response');
    return response.data;
}

function parseHtmlItems(html) {
    const rows = [], tableBodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
    const rowBlocks = (tableBodyMatch ? tableBodyMatch[1] : html).split(/<tr[^>]*>/i).slice(1);

    for (const block of rowBlocks) {
        const titleMatch = block.match(/<a[^>]*href="\/view\/\d+"[^>]*title="([^"]+)"/i);
        const magnetMatch = block.match(/href="magnet:\?xt=urn:btih:([^&"]+)/i);
        if (!titleMatch || !magnetMatch) continue;

        const sizeMatch = block.match(/<td class="text-center">([^<]+(?:MiB|GiB|KiB|TiB|B|MB|GB|KB))<\/td>/i);
        const tdMatches = [...block.matchAll(/<td class="text-center">(\d+)<\/td>/gi)];
        
        rows.push({
            title: decodeXmlEntities(titleMatch[1]),
            hash: magnetMatch[1].toLowerCase(),
            size: sizeMatch ? normalizeSpaces(decodeXmlEntities(sizeMatch[1])) : '',
            sizeBytes: parseSize(sizeMatch ? sizeMatch[1] : ''),
            seeders: tdMatches.length >= 1 ? parseInt(tdMatches[0][1], 10) : 0
        });
    }
    return rows;
}

async function searchQueryOnMirrors(query) {
    const mirrors = getOrderedMirrors(), merged = [], seenHashes = new Set();
    let lastError = null, sawValidEmpty = false;

    for (const mirror of mirrors) {
        try {
            const html = await requestHtmlFromMirror(mirror, query);
            const items = parseHtmlItems(html);
            if (!items.length) { sawValidEmpty = true; markMirrorSuccess(mirror); continue; }
            markMirrorSuccess(mirror);
            for (const item of items) {
                if (!item.hash || seenHashes.has(item.hash)) continue;
                seenHashes.add(item.hash);
                merged.push(item);
            }
            if (merged.length >= CONFIG.EARLY_STOP_RESULTS) break;
        } catch (error) { lastError = error; markMirrorFailure(mirror); }
    }
    if (merged.length) return merged;
    if (sawValidEmpty) return [];
    if (lastError) throw lastError;
    return [];
}

async function executeSearch(context) {
    const queries = buildQueries(context), allResults = [];
    const startTime = now(), TIME_LIMIT = 8500; 

    for (let i = 0; i < queries.length; i += 1) {
        if (now() - startTime > TIME_LIMIT) break;

        const items = await searchQueryOnMirrors(queries[i]);
        allResults.push(...items.map(item => normalizeResult(item, context)).filter(Boolean));

        if (allResults.length >= CONFIG.EARLY_STOP_RESULTS) break;
        if (i < queries.length - 1) await sleep(100);
    }

    return dedupeResults(allResults)
        .sort((a, b) => (b._score || 0) !== (a._score || 0) ? (b._score || 0) - (a._score || 0) : (b.seeders || 0) - (a.seeders || 0))
        .slice(0, CONFIG.MAX_RESULTS)
        .map((item) => ({ title: item.title, magnet: item.magnet, size: item.size || bytesToSize(item.sizeBytes), sizeBytes: item.sizeBytes || 0, seeders: item.seeders || 0, source: item.source }));
}

async function searchMagnet(title, year, type, imdbId, options = {}) {
    const context = buildContext(title, year, type, imdbId, options);
    if (!context.isAnime) return [];

    const cacheKey = JSON.stringify({ imdbId: String(imdbId || '').toLowerCase(), reqSeason: context.reqSeason || 0, reqEpisode: context.reqEpisode || 0, absoluteEpisode: context.absoluteEpisode || 0, langMode: context.langMode });
    const cached = getCache(cacheKey);
    if (cached) return cached;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);

    const task = withTimeout((async () => {
        const results = await executeSearch(context);
        setCache(cacheKey, results, results.length > 0 ? CONFIG.SEARCH_CACHE_TTL : CONFIG.NEGATIVE_CACHE_TTL);
        return results;
    })(), CONFIG.SEARCH_TIMEOUT).catch(() => { setCache(cacheKey, [], CONFIG.ERROR_CACHE_TTL); return []; });

    inflight.set(cacheKey, task);
    try { return await task; } finally { inflight.delete(cacheKey); }
}

module.exports = { name: 'NyaaAnime', searchMagnet, updateTrackers: async () => DEFAULT_TRACKERS, CONFIG };
