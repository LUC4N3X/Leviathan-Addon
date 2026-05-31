'use strict';

const aioFormatter = require('../lib/pulse_formatter.cjs');
const {
    WEB_PROVIDER_ORDER,
    getWebProviderDefinitions,
    getWebProviderIcon,
    getWebProviderTimeout,
    isStreamingCommunityEnabled,
    isStreamingCommunityLastEnabled
} = require('../../providers/extractors/provider_registry');


const INLINE_PROVIDER_LIMITER = Object.freeze({
    schedule(task) {
        return Promise.resolve().then(task);
    }
});
const warnedMissingProviderLimiters = new Set();

function envDebugFlag(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    return /^(?:1|true|yes|on)$/i.test(String(raw).trim());
}


function envNameList(name) {
    return String(process.env[name] || '')
        .split(/[\s,;|]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
}

function providerForceEnabled(definition = {}) {
    const names = [definition.key, definition.cacheName, definition.sourceName]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase());
    if (envDebugFlag('WEB_PROVIDERS_ALWAYS_RUN', false)) return true;
    if (envDebugFlag('CB01_ALWAYS_RUN', false) && names.some((name) => /^cb01/.test(name))) return true;
    const forced = envNameList('WEB_PROVIDERS_FORCE');
    return forced.length > 0 && names.some((name) => forced.includes(name));
}

function buildProviderRawId(rawId, definition = {}) {
    const parts = [rawId];
    if (definition.cacheKeyVersion) parts.push(`v=${definition.cacheKeyVersion}`);
    return parts.join('|');
}

function webProviderDebug(level, message, payload = null) {
    const normalizedLevel = String(level || 'info').toLowerCase();
    const alwaysShow = /^(warn|error)$/i.test(normalizedLevel);
    const enabled = envDebugFlag('WEB_PROVIDER_DEBUG', false) || envDebugFlag('CB01_DEBUG', false);
    if (!alwaysShow && !enabled) return;
    const logger = console[normalizedLevel] || console.info;
    if (payload && typeof payload === 'object') {
        try { logger(`[WEB PROVIDERS:debug] ${message} ${JSON.stringify(payload)}`); }
        catch (_) { logger(`[WEB PROVIDERS:debug] ${message}`); }
    } else {
        logger(`[WEB PROVIDERS:debug] ${message}`);
    }
}

function resolveWebProviderLimiter(limiters = {}, definition = {}) {
    const key = String(definition?.limiterKey || '').trim();
    const direct = key ? limiters?.[key] : null;
    if (direct && typeof direct.schedule === 'function') return direct;

    const fallbackEntries = [
        ['scraper', limiters?.scraper],
        ['externalAddons', limiters?.externalAddons],
        ['remoteIndexer', limiters?.remoteIndexer]
    ];
    const fallback = fallbackEntries.find(([, limiter]) => limiter && typeof limiter.schedule === 'function');
    const fallbackName = fallback?.[0] || 'inline';
    const providerName = definition?.cacheName || definition?.sourceName || definition?.key || 'WebProvider';
    const warnKey = `${providerName}:${key || 'missing'}:${fallbackName}`;

    if (!warnedMissingProviderLimiters.has(warnKey)) {
        warnedMissingProviderLimiters.add(warnKey);
        // Important: a missing provider-specific limiter must never disable a web provider.
        // This keeps older Docker layers/configs compatible when new providers introduce new limiter keys.
        console.warn(`[WEB PROVIDERS] limiter missing provider=${providerName} limiterKey=${key || 'n/a'} fallback=${fallbackName}`);
    }

    return fallback?.[1] || INLINE_PROVIDER_LIMITER;
}

const LANGUAGE_LABELS = Object.freeze({
    ita: { code: 'ITA', flag: '🇮🇹' },
    eng: { code: 'ENG', flag: '🇬🇧' },
    en: { code: 'ENG', flag: '🇬🇧' },
    jpn: { code: 'JPN', flag: '🇯🇵' },
    jp: { code: 'JPN', flag: '🇯🇵' },
    fra: { code: 'FRA', flag: '🇫🇷' },
    fre: { code: 'FRA', flag: '🇫🇷' },
    spa: { code: 'SPA', flag: '🇪🇸' },
    esp: { code: 'SPA', flag: '🇪🇸' },
    deu: { code: 'DEU', flag: '🇩🇪' },
    ger: { code: 'DEU', flag: '🇩🇪' }
});

function normalizeBingePart(value, fallback = 'x') {
    const normalized = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[|]+/g, ' ')
        .replace(/[^a-z0-9+._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return normalized || fallback;
}

function buildWebBingeGroup({ providerLabel, extractorLabel, quality, languages, audio }) {
    return [
        'Leviathan',
        'WEB',
        normalizeBingePart(quality, 'q'),
        'SDR',
        normalizeBingePart(extractorLabel, 'extractor'),
        normalizeBingePart(audio, 'audio'),
        normalizeBingePart(languages?.text || languages?.flags || '', 'lang'),
        normalizeBingePart(providerLabel, 'provider')
    ].join('|');
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const clean = String(value ?? '').trim();
        if (clean) return clean;
    }
    return '';
}

function normalizeWebExtractorLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (/^(unknown|unknow|n\/a|null|undefined)$/i.test(raw)) return '';
    if (/vix(?:cloud|src)?/i.test(raw)) return 'VixCloud';
    if (/vidx\s*go|vidxgo/i.test(raw)) return 'VidxGo';
    if (/sweet\s*pixel|sweetpixel/i.test(raw)) return 'SweetPixel';
    if (/cccdn/i.test(raw)) return 'CCCDN';
    if (/^(?:city|cinemacity\s*city|kraken\s*city)$/i.test(raw)) return 'CCCDN';
    if (/mixdrop|m1xdrop|mxcontent/i.test(raw)) return 'MixDrop';
    if (/loadm/i.test(raw)) return 'LoadM';
    if (/supervideo/i.test(raw)) return 'SuperVideo';
    if (/maxstream/i.test(raw)) return 'MaxStream';
    if (/uprot/i.test(raw)) return 'Uprot';
    if (/voe/i.test(raw)) return 'VOE';
    if (/streamtape/i.test(raw)) return 'StreamTape';
    if (/dood/i.test(raw)) return 'DoodStream';
    if (/filemoon/i.test(raw)) return 'FileMoon';
    if (/srv\s*12|srv12/i.test(raw)) return 'Srv12';
    if (/direct/i.test(raw)) return 'Direct';
    if (/^(?:hls|direct)\s+proxy$/i.test(raw)) return '';
    if (/^(?:mfp|cinemacity)$/i.test(raw)) return '';
    if (/^https?:\/\//i.test(raw)) {
        try {
            const host = new URL(raw).hostname.replace(/^www\./i, '').split('.')[0];
            return normalizeWebExtractorLabel(host);
        } catch (_) {
            return '';
        }
    }
    if (/[|•\n]/.test(raw)) return '';

    const cleaned = raw
        .replace(/^host\s*[:=-]\s*/i, '')
        .replace(/^extractor\s*[:=-]\s*/i, '')
        .trim();

    // Only trust free-form labels when they look like a hoster/extractor, not a media title.
    return /^(?:web|hls|city|loadm|deltabit|delta\s*bit|turbovid|vixcloud|vidxgo|sweetpixel|srv12|cccdn|mixdrop|supervideo|maxstream|voe|streamtape|doodstream|filemoon|uprot|direct)$/i.test(cleaned)
        ? cleaned
        : '';
}

function inferWebExtractorLabel(stream, sourceName) {
    const source = String(sourceName || '');
    const cinemaCitySignals = [
        source,
        stream?.provider,
        stream?.source,
        stream?.site,
        stream?.name,
        stream?.behaviorHints?.vortexSource,
        stream?.behaviorHints?.vortexMeta?.provider,
        stream?.behaviorHints?.vortexMeta?.source,
        stream?.behaviorHints?.vortexMeta?.site
    ];
    const isCinemaCity = cinemaCitySignals.some((value) => /cinemacity/i.test(String(value || '')));
    const directCandidates = [
        stream?.behaviorHints?.extractor,
        stream?.behaviorHints?.vortexExtractor,
        stream?.behaviorHints?.vortexMeta?.extractor,
        stream?.extractor,
        stream?.hoster,
        stream?.host
    ];

    for (const candidate of directCandidates) {
        const normalized = normalizeWebExtractorLabel(candidate);
        if (!normalized) continue;
        if (isCinemaCity && /^(?:direct|web|hls|proxy|mfp|cinemacity)$/i.test(normalized)) return 'CCCDN';
        return normalized;
    }

    const textCandidates = [stream?.title, stream?.name, stream?.url].filter(Boolean);
    for (const candidate of textCandidates) {
        const normalized = normalizeWebExtractorLabel(candidate);
        if (!normalized) continue;
        if (isCinemaCity && /^(?:direct|web|hls|proxy|mfp|cinemacity)$/i.test(normalized)) return 'CCCDN';
        return normalized;
    }

    if (/streamingcommunity|vix/i.test(source)) return 'VixCloud';
    if (isCinemaCity || /cinemacity/i.test(source)) return 'CCCDN';
    return 'Web';
}

function normalizeWebQualityLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^(?:4k|2160p|uhd)$/i.test(raw)) return '4K';
    if (/^(?:1440p|2k|qhd)$/i.test(raw)) return '1440p';
    if (/^(?:1080p|1080i|fhd|fullhd)$/i.test(raw)) return '1080p';
    if (/^(?:720p|hd)$/i.test(raw)) return '720p';
    if (/^(?:576p)$/i.test(raw)) return '576p';
    if (/^(?:480p|sd)$/i.test(raw)) return '480p';
    if (/^\d{3,4}p$/i.test(raw)) return raw.toLowerCase();
    return '';
}

function inferWebQuality(stream, sourceName) {
    const directCandidates = [
        stream?.quality,
        stream?.behaviorHints?.vortexMeta?.quality,
        stream?.behaviorHints?.quality
    ];

    for (const candidate of directCandidates) {
        const normalized = normalizeWebQualityLabel(candidate);
        if (normalized) return normalized;
    }

    const textToCheck = `${stream?.title || ''} ${stream?.name || ''} ${stream?.filename || ''}`.toUpperCase().replace(/GUARDAHD|GUARDOSERIE|GUARDASERIE|GUARDASERIETV|STREAMINGCOMMUNITY|CINEMACITY|LEVIATHAN|VIX|GUARDAFLIX|CB01|ANIMEWORLD|ANIMEUNITY|ANIMESATURN/g, '');
    if (/\b(4K|2160P|UHD)\b/.test(textToCheck)) return '4K';
    if (/\b(1440P|2K|QHD)\b/.test(textToCheck)) return '1440p';
    if (/\b(1080P|FHD|FULLHD)\b/.test(textToCheck)) return '1080p';
    if (/\b(720P|HD)\b/.test(textToCheck)) return '720p';
    if (/\b(576P)\b/.test(textToCheck)) return '576p';
    if (/\b(480P|SD)\b/.test(textToCheck)) return '480p';

    if (/streamingcommunity|vix/i.test(String(sourceName || ''))) return '1080p';
    return 'HD';
}

function getWebQualityIcon(quality) {
    const normalized = String(quality || '').toLowerCase();
    if (normalized === '4k' || normalized === '2160p' || normalized === '1440p' || normalized === '1080p') return '🔥';
    if (normalized === '720p') return '⚡';
    if (normalized === 'sd' || normalized === '480p') return '📼';
    return '📺';
}

function displayProviderIcon(providerIcon, sourceName) {
    return providerIcon || getWebProviderIcon(sourceName) || '🌐';
}

function parsePositiveInt(...values) {
    for (const value of values) {
        const parsed = Number.parseInt(String(value ?? '').trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function resolveEpisodeTag(meta = {}, config = {}) {
    const season = parsePositiveInt(
        meta?.season,
        meta?.s,
        meta?.seasonNumber,
        meta?.season_number,
        meta?.tmdbSeason,
        config?.season,
        config?.s
    );
    const episode = parsePositiveInt(
        meta?.episode,
        meta?.e,
        meta?.episodeNumber,
        meta?.episode_number,
        meta?.tmdbEpisode,
        meta?.anime_episode,
        meta?.requested_kitsu_episode,
        config?.episode,
        config?.e
    );

    if (season && episode) return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    if (episode) return `E${String(episode).padStart(2, '0')}`;
    return '';
}

function cleanWebDisplayTitle(rawTitle, metaTitle, epTag = '') {
    const rawFirstLine = String(rawTitle || '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && !/^(?:[📺▶️🔱🗣️📦⛵🌐📼🔥⚡☁️🛡]|WEB\b|LEVIATHAN\b)/i.test(line));
    const fallback = String(metaTitle || '').split('\n')[0].trim();
    let clean = firstNonEmpty(rawFirstLine, fallback, 'Stream');

    clean = clean
        .replace(/[🎬⚡🌪️⛩️🦁🎥🌐🍿🌀🪐📺▶️🔱🗣️📦⛵☁️🛡]/gu, ' ')
        .replace(/\bS\d{1,2}\s*E\d{1,4}\b/gi, ' ')
        .replace(/\b\d{1,2}x\d{1,4}\b/gi, ' ')
        .replace(/\b(?:season|stagione)\s*\d{1,2}\b/gi, ' ')
        .replace(/\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi, ' ')
        .replace(/\bS\d{1,2}\b/gi, ' ')
        .replace(/\bE\d{1,4}\b/gi, ' ')
        .replace(/\b(?:episodio|episode|ep)\s*\d{1,4}\b/gi, ' ')
        .replace(/\b(?:2160p|1440p|1080p|720p|576p|480p|4k|uhd|hd|web(?:-dl)?|webrip|hls|aac|ddp|ac3|ita|eng|jpn|sub\s*ita|vost(?:fr|it)?)\b/gi, ' ')
        .replace(/\s*[|•]+\s*/g, ' ')
        .replace(/\s*[-–—:]+\s*$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (!clean && fallback) clean = fallback.replace(new RegExp(`\\s*${epTag}\\s*`, 'i'), '').trim();
    return clean || 'Stream';
}

function normalizeLanguageCode(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (!clean) return '';
    if (/^(?:it|ita|italian|italiano)$/.test(clean)) return 'ita';
    if (/^(?:en|eng|english|inglese)$/.test(clean)) return 'eng';
    if (/^(?:ja|jp|jpn|jap|japanese|giapponese)$/.test(clean)) return 'jpn';
    if (/^(?:fr|fra|fre|french|francese)$/.test(clean)) return 'fra';
    if (/^(?:es|esp|spa|spanish|spagnolo)$/.test(clean)) return 'spa';
    if (/^(?:de|deu|ger|german|tedesco)$/.test(clean)) return 'deu';
    return clean.slice(0, 12);
}

function collectLanguages(stream = {}, sourceName = '') {
    const hints = stream.behaviorHints || {};
    const vMeta = hints.vortexMeta || {};
    const explicitAudioValues = [];
    const addAudio = (value) => {
        if (Array.isArray(value)) explicitAudioValues.push(...value);
        else if (value) explicitAudioValues.push(value);
    };

    // This badge represents AUDIO tracks only. Do not merge subtitles here:
    // a file with ITA/FRA audio + ENG/DEU/JPN subs must not look like it has
    // ENG/DEU/JPN audio tracks in Stremio.
    addAudio(stream.audioLanguages);
    addAudio(stream.audio);
    addAudio(stream.language);
    addAudio(vMeta.audioLanguages);
    addAudio(vMeta.audio);
    addAudio(vMeta.language);

    const out = [];
    const push = (lang) => {
        const normalized = normalizeLanguageCode(lang);
        if (normalized && !out.includes(normalized)) out.push(normalized);
    };

    const scan = (values) => {
        for (const value of values) {
            const str = String(value || '');
            if (/🇮🇹|\b(?:ita|it|italiano|italian)\b/i.test(str)) push('ita');
            if (/🇬🇧|\b(?:eng|en|inglese|english)\b/i.test(str)) push('eng');
            if (/🇯🇵|\b(?:jpn|jp|jap|ja|giapponese|japanese)\b/i.test(str)) push('jpn');
            if (/🇫🇷|\b(?:fra|fre|fr|francese|french)\b/i.test(str)) push('fra');
            if (/🇪🇸|\b(?:spa|esp|es|spagnolo|spanish)\b/i.test(str)) push('spa');
            if (/🇩🇪|\b(?:deu|ger|de|tedesco|german)\b/i.test(str)) push('deu');
        }
    };

    scan(explicitAudioValues);
    if (out.length) return out;

    // Fallback only when there is no structured audio metadata. Strip subtitle
    // labels before scanning old title/name strings.
    const text = [
        stream.title,
        stream.name,
        stream.filename,
        vMeta.filename,
        vMeta.title,
        sourceName
    ].filter(Boolean).join(' ')
        .replace(/(?:💬|subs?|subtitles?|sottotitoli)\s*[:：\-]?\s*[^\n|•]+/gi, ' ');

    scan([text]);
    return out;
}

function prioritizeItalianLanguageCodes(languages = []) {
    const unique = [...new Set(languages.map(normalizeLanguageCode).filter(Boolean))];
    if (!unique.includes('ita')) return unique;
    return ['ita', ...unique.filter((lang) => lang !== 'ita')];
}

function formatLanguageSummary(languages = []) {
    const unique = prioritizeItalianLanguageCodes(languages);
    if (!unique.length) return { text: 'ITA', flags: '🇮🇹' };

    const labels = unique.map((lang) => LANGUAGE_LABELS[lang]?.code || String(lang).slice(0, 3).toUpperCase());
    const flags = unique.map((lang) => LANGUAGE_LABELS[lang]?.flag).filter(Boolean);
    const text = labels.length > 1 ? `MULTI ${labels.join('/')}` : labels[0];
    return { text, flags: flags.length ? flags.join('/') : '🌐' };
}

function inferWebAudio(stream = {}) {
    const hints = stream.behaviorHints || {};
    const vMeta = hints.vortexMeta || {};
    const text = [
        stream.audioCodec,
        stream.audio,
        stream.codec,
        vMeta.audioCodec,
        vMeta.audio,
        vMeta.codec,
        stream.title,
        stream.name,
        stream.filename,
        vMeta.filename
    ].filter(Boolean).join(' ').toUpperCase();

    if (/ATMOS/.test(text)) return /DDP|EAC3|E-AC3/.test(text) ? 'Atmos DDP' : 'Dolby Atmos';
    if (/TRUEHD/.test(text)) return 'TrueHD';
    if (/DTS[-\s:]?HD/.test(text)) return 'DTS-HD';
    if (/\bDTS\b/.test(text)) return 'DTS';
    if (/\b(?:DDP|EAC3|E-AC3|DD\+)\b/.test(text)) return 'Dolby DDP';
    if (/\b(?:AC3|AC-3)\b/.test(text)) return 'AC3';
    if (/\bOPUS\b/.test(text)) return 'OPUS';
    if (/\bMP3\b/.test(text)) return 'MP3';
    if (/\bAAC\b/.test(text)) return 'AAC';
    return 'AAC';
}

function extractSizeLabel(...values) {
    const text = values.map((value) => String(value || '')).join(' ');
    const match = text.match(/(?:^|\s)(\d+(?:[.,]\d+)?\s?(?:KB|MB|GB|TB))(?:\s|$)/i);
    return match?.[1]?.replace(/\s+/g, ' ').replace(',', '.').toUpperCase() || '';
}

function formatSize(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let n = value;
        let idx = 0;
        while (n >= 1024 && idx < units.length - 1) {
            n /= 1024;
            idx += 1;
        }
        const digits = idx >= 3 ? 2 : (idx === 2 ? 1 : 0);
        return `${n.toFixed(digits).replace(/\.0+$/, '')} ${units[idx]}`;
    }
    return extractSizeLabel(value) || String(value || '').trim();
}

function inferWebSize(stream = {}) {
    const hints = stream.behaviorHints || {};
    const vMeta = hints.vortexMeta || {};
    return firstNonEmpty(
        formatSize(stream.size),
        formatSize(stream.filesize),
        formatSize(stream.fileSize),
        formatSize(vMeta.size),
        formatSize(vMeta.filesize),
        extractSizeLabel(stream.title, stream.name, stream.filename, vMeta.filename)
    );
}

function isKitsuAnimeMeta(meta = {}) {
    const ids = [meta?.id, meta?.requestedId, meta?.originalId, meta?.kitsu_id, meta?.kitsuId];
    return Boolean(
        meta?.isAnime === true
        || String(meta?.type || '').toLowerCase() === 'anime'
        || ids.some((value) => /^kitsu(?::|_)?\d+/i.test(String(value || '').trim()))
    );
}

function getAnimeLanguagePriority(stream = {}) {
    const explicit = String(stream?.language || stream?.behaviorHints?.vortexMeta?.language || '').toLowerCase();
    if (/^(?:ita|it|italian)$/.test(explicit)) return 0;
    if (/^(?:jpn|jp|japanese)$/.test(explicit) || /sub\s*ita|vost/.test(explicit)) return 2;

    const text = [
        stream?.title,
        stream?.name,
        stream?.provider,
        stream?.source,
        stream?.site,
        stream?.behaviorHints?.vortexMeta?.provider,
        stream?.behaviorHints?.vortexMeta?.source
    ].filter(Boolean).join(' ').toLowerCase();

    if (/🇯🇵|\bjpn\b|\bjp\b|japanese|sub\s*ita|vost/.test(text)) return 2;
    if (/🇮🇹|\bita\b|italian|dub|doppiat/.test(text)) return 0;
    return 1;
}

function sortAnimeWebStreamsByLanguage(streams = []) {
    return [...(streams || [])]
        .map((stream, index) => ({ stream, index, lang: getAnimeLanguagePriority(stream) }))
        .sort((a, b) => (a.lang - b.lang) || (a.index - b.index))
        .map((entry) => entry.stream);
}

function buildWebStreamDisplay(stream, providerDefinition, meta = {}, config = {}) {
    const sourceName = providerDefinition?.sourceName || 'Web';
    const providerIcon = providerDefinition?.icon || getWebProviderIcon(sourceName);
    const providerLabel = String(sourceName || '').trim() || 'Web';
    const extractorLabel = inferWebExtractorLabel(stream, sourceName) || 'Web';
    const quality = inferWebQuality(stream, sourceName) || 'HD';
    const qIcon = getWebQualityIcon(quality);
    const epTag = resolveEpisodeTag(meta, config);
    const baseTitle = cleanWebDisplayTitle(stream?.title, meta?.title || meta?.name, epTag);
    const displayTitle = epTag ? `${baseTitle} — ${epTag}` : baseTitle;
    const languages = formatLanguageSummary(collectLanguages(stream, sourceName));
    const audio = inferWebAudio(stream);
    const size = inferWebSize(stream);
    const sourceType = 'WEB';
    const bingeGroup = stream.behaviorHints?.bingeGroup || stream.behaviorHints?.bingieGroup || buildWebBingeGroup({ providerLabel, extractorLabel, quality, languages, audio });

    const titleLines = [
        `▶️ ${displayTitle}`,
        `🔱 ${quality} • ${sourceType}`,
        `🗣️ ${languages.flags} | 🫧 ${audio}`,
        size ? `📦 ${size}` : '',
        `${providerIcon} ${providerLabel}`,
        `⛵ ${extractorLabel}`
    ].filter(Boolean);

    const behaviorHints = {
        ...(stream.behaviorHints || {}),
        notWebReady: stream.behaviorHints?.notWebReady ?? stream.notWebReady ?? false,
        extractor: extractorLabel,
        vortexExtractor: extractorLabel,
        vortexSource: stream.behaviorHints?.vortexSource || providerLabel,
        vortexProviderCode: stream.behaviorHints?.vortexProviderCode || providerDefinition?.key || providerLabel,
        bingeGroup,
        bingieGroup: bingeGroup,
        vortexMeta: {
            ...(stream.behaviorHints?.vortexMeta || {}),
            provider: providerLabel,
            source: providerLabel,
            site: providerLabel,
            extractor: extractorLabel,
            quality,
            language: languages.text,
            audioCodec: audio,
            size: size || stream.behaviorHints?.vortexMeta?.size
        }
    };

    return {
        ...stream,
        name: `🌊 𝗪𝗘𝗕 🦑 ʟᴇᴠɪᴀᴛʜᴀɴ`,
        title: titleLines.join('\n'),
        quality,
        language: stream.language,
        extractor: extractorLabel,
        host: stream.host || extractorLabel,
        provider: stream.provider || providerLabel,
        source: stream.source || providerLabel,
        site: stream.site || providerLabel,
        behaviorHints
    };
}

function applyAioWebStyle(streamList, providerDefinition, meta, config) {
    // AIO mode still uses the lightweight WEB-only formatter, so WEB never touches torrent parsing.
    return applyWebFormatter(streamList, providerDefinition, meta, config);
}

function applyWebFormatter(streamList, providerDefinition, meta, config) {
    if (!streamList || !Array.isArray(streamList)) return [];
    return streamList.map((stream) => buildWebStreamDisplay(stream, providerDefinition, meta, config));
}

function createWebProviderTools({ Cache, LIMITERS, CONFIG, guardedProviderCall }) {
    async function fetchWebProviderBuckets({ type, originalId, finalId, meta, config, reqHost, allowItalianWebProviders, dbOnlyMode, sourceModeFlags = null }) {
        const definitions = getWebProviderDefinitions({ meta, filters: config.filters || {} });
        const empty = Object.fromEntries(definitions.map((definition) => [definition.key, []]));
        const flags = sourceModeFlags || {
            dbOnlyMode: dbOnlyMode === true,
            useLiveSources: dbOnlyMode !== true,
            useProviderCachedOnly: false,
            bypassProviderCache: false
        };

        if (flags.dbOnlyMode || !allowItalianWebProviders) {
            webProviderDebug('info', 'skipped all providers', {
                dbOnlyMode: flags.dbOnlyMode,
                allowItalianWebProviders,
                title: meta?.title || meta?.name || '',
                type,
                finalId
            });
            return empty;
        }

        webProviderDebug('info', 'bucket fetch start', {
            title: meta?.title || meta?.name || '',
            type,
            finalId,
            season: meta?.season || 0,
            episode: meta?.episode || 0,
            cacheOnly: flags.useProviderCachedOnly === true,
            bypassCache: flags.bypassProviderCache === true,
            enabled: definitions.filter((definition) => definition.enabled).map((definition) => definition.cacheName || definition.sourceName || definition.key),
            disabled: definitions.filter((definition) => !definition.enabled).map((definition) => definition.cacheName || definition.sourceName || definition.key),
            forced: definitions.filter((definition) => providerForceEnabled(definition)).map((definition) => definition.cacheName || definition.sourceName || definition.key)
        });

        const rawId = `${type}:${finalId}:${meta.season || 0}:${meta.episode || 0}`;
        const settled = await Promise.allSettled(definitions.map((definition) => {
            const providerName = definition.cacheName || definition.sourceName || definition.key;
            const forced = providerForceEnabled(definition);
            const providerRawId = buildProviderRawId(rawId, definition);
            const providerCacheOnly = forced ? false : flags.useProviderCachedOnly === true;
            const providerBypassCache = forced ? true : flags.bypassProviderCache === true;

            if (!definition.enabled && !forced) {
                webProviderDebug('info', 'provider disabled', { provider: providerName });
                return Promise.resolve([]);
            }
            if (!flags.useLiveSources && !flags.useProviderCachedOnly && !forced) {
                webProviderDebug('warn', 'provider skipped by source mode', { provider: providerName, useLiveSources: flags.useLiveSources, cacheOnly: flags.useProviderCachedOnly });
                return Promise.resolve([]);
            }

            webProviderDebug('info', 'provider call scheduled', {
                provider: providerName,
                rawId,
                providerRawId,
                cacheKeyVersion: definition.cacheKeyVersion || '',
                forced,
                cacheOnly: providerCacheOnly,
                bypassCache: providerBypassCache,
                timeoutMs: getWebProviderTimeout(CONFIG.TIMEOUTS.SCRAPER, definition.cacheName),
                emptyTtl: Math.max(1, Number(definition.emptyTtl || 3600) || 3600),
                errorTtl: Math.max(1, Number(definition.errorTtl || Math.min(Number(definition.emptyTtl || 3600) || 3600, 300)) || 300),
                limiterKey: definition.limiterKey || ''
            });
            return Cache.fetchWithCache(definition.cacheName, providerRawId, 43200, () =>
                guardedProviderCall(
                    definition.cacheName,
                    resolveWebProviderLimiter(LIMITERS, definition),
                    getWebProviderTimeout(CONFIG.TIMEOUTS.SCRAPER, definition.cacheName),
                    () => definition.run({ type, originalId, finalId, meta, config, reqHost })
                )
            , {
                cacheOnly: providerCacheOnly,
                bypassCache: providerBypassCache,
                emptyTtl: Math.max(1, Number(definition.emptyTtl || 3600) || 3600),
                errorTtl: Math.max(1, Number(definition.errorTtl || Math.min(Number(definition.emptyTtl || 3600) || 3600, 300)) || 300)
            });
        }));

        return definitions.reduce((acc, definition, index) => {
            const item = settled[index];
            const providerName = definition.cacheName || definition.sourceName || definition.key;
            if (item?.status === 'fulfilled') {
                const value = Array.isArray(item.value) ? item.value : [];
                acc[definition.key] = value;
                if (definition.enabled || value.length > 0) {
                    webProviderDebug(value.length > 0 ? 'info' : 'warn', 'provider bucket result', {
                        provider: providerName,
                        key: definition.key,
                        streams: value.length,
                        firstNames: value.slice(0, 5).map((stream) => stream?.name || stream?.title || '')
                    });
                }
            } else {
                acc[definition.key] = [];
                webProviderDebug('warn', 'provider bucket rejected', {
                    provider: providerName,
                    key: definition.key,
                    error: item?.reason?.message || String(item?.reason || 'unknown')
                });
            }
            return acc;
        }, empty);
    }

    function formatWebProviderBuckets(webBuckets, meta, config) {
        const definitions = getWebProviderDefinitions({ meta, filters: config.filters || {} });
        const formatted = {};

        for (const definition of definitions) {
            const bucket = Array.isArray(webBuckets?.[definition.key]) ? [...webBuckets[definition.key]] : [];
            if (aioFormatter && aioFormatter.isAIOStreamsEnabled(config)) {
                formatted[definition.key] = bucket.length > 0 ? applyAioWebStyle(bucket, definition, meta, config) : [];
            } else {
                formatted[definition.key] = bucket.length > 0 ? applyWebFormatter(bucket, definition, meta, config) : [];
            }
            if (definition.enabled || bucket.length > 0) {
                webProviderDebug(bucket.length > 0 ? 'info' : 'warn', 'provider format result', {
                    provider: definition.cacheName || definition.sourceName || definition.key,
                    raw: bucket.length,
                    formatted: formatted[definition.key].length,
                    aio: Boolean(aioFormatter && aioFormatter.isAIOStreamsEnabled(config))
                });
            }
        }

        return formatted;
    }

    function mergeFinalStreams(debridStreams, formattedWebBuckets, filters = {}, meta = {}) {
        const webStreams = WEB_PROVIDER_ORDER.flatMap((key) => Array.isArray(formattedWebBuckets?.[key]) ? formattedWebBuckets[key] : []);
        const orderedWebStreams = isKitsuAnimeMeta(meta) ? sortAnimeWebStreamsByLanguage(webStreams) : webStreams;

        return isStreamingCommunityLastEnabled(filters)
            ? [...(debridStreams || []), ...orderedWebStreams]
            : [...orderedWebStreams, ...(debridStreams || [])];
    }

    return {
        fetchWebProviderBuckets,
        formatWebProviderBuckets,
        mergeFinalStreams,
        isStreamingCommunityEnabled,
        isStreamingCommunityLastEnabled
    };
}

module.exports = { createWebProviderTools };
