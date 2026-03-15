const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

const EXTERNAL_ADDONS = {
    torrentio_main: {
        baseUrl: 'https://thorrentan.elninhostre.dpdns.org/e30',
        name: 'Torrentio Main',
        emoji: '🅣',
        timeout: 2000,
        priority: 1
    },
    torrentio_mirror: {
        baseUrl: 'https://torrentio.strem.fun',
        name: 'Torrentio Mirror',
        emoji: '🅣',
        timeout: 2000,
        priority: 2
    },
    mediafusion: {
        baseUrl: 'https://mediafusionfortheweebs.midnightignite.me/D-FCO8JXfrGOKFpP-Rim96nHZU9epOb5RPbSpgkgVbYoR1NRJNR1C-9X4VDrUSJJNEvp5pk7CGvSLN7cUHUrth3QG8e3mSPa8Ind2k4VzVGFEa-310EjXdsXT_uUXGri86EVnnQ6f_9b0yoVTuVu7Aqk4uY8IXZp47-0FmuxgXX6wleis_0Evllc0v2wcrWIj-D5m3IZhI18CKHr-pUL5h61ZWcaRuxGjgwYK88Xy3PIN2U3YzTi4J9pazQBpCNDH-NpZPwk2RVnjs0WF7dRU5XD_D0robmhH9q0edoqaR_71u1j2y-XnxkwPNjg-o5Yb_',
        name: 'MediaFusion',
        emoji: '🅜',
        timeout: 1500,
        priority: 3
    }
};

const KNOWN_PROVIDERS = [
    'ThePirateBay', 'ilCorSaRoNeRo', '1337x', 'Cyber', 'Torrent9', 'Wolfmax4K', 
    'Comando', 'YTS', 'YIFY', 'BestTorrents', 'Knaben', 'BTM', 'Byndr', 'Wadu', 
    'Sp33dy94', 'MIRCrew', 'Cosmo Crew', 'Ph4nt0mx', 'Nueng', 'Rutor', 
    'TorrentGalaxy', 'TGx', 'RARBG', 'EZTV', 'Nyaa', 'Erai-raws', 'SubsPlease', 
    'Judas', 'QxR', 'Tigole', 'PSA', 'EAGLE', 'ICV', 'MegaPhone', 'iDN_CreW', 
    'MUX', 'DDN', 'DLMux', 'WebMux', 'TRIDIM', 'Lidri', 'Ghizzo', 'MeGaPeER', 
    'Papeete', 'Vics', 'Gaiage', 'Dtone', 'BlackBit', 'Pantry', 'Bric', 'USAbit',
	'Uindex'
];

const REGEX_AUDIO_ITA = /\b(?:ITA(?:LIAN)?(?:\s*(?:AUDIO|DDP|AAC|AC3|EAC3|ATMOS))?|MULTI\s*ITA|DUAL\s*AUDIO\s*ITA|TRUE\s*ITALIAN)\b/i;
const REGEX_SUB_ITA = /\b(?:SUB[-.\s_]*ITA|SOFTSUB[-.\s_]*ITA|VOST(?:ITA)?|ITALIAN\s*SUBS?)\b/i;
const REGEX_TRUSTED_ITA = /\b(?:CORSARO|ICV|MEGAPHONE|IDN[_\s-]*CREW|DDN|MUX\s*ITA)\b/i;
const REGEX_NEGATIVE_LANGUAGE = /\b(?:FRENCH|TRUEFRENCH|GERMAN|SPANISH|LATINO|RUSSIAN|MULTI(?!\s*ITA)|ENG(?:LISH)?\s*ONLY)\b/i;
const VIDEO_FILE_REGEX = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i;
const SIZE_REGEX = /(?:📦|💾|Size:?|Dimensione:?|💽)\s*([\d.,]+)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)/i;

function debugLog(...args) {
    if (DEBUG_MODE) console.log(...args);
}

function normalizeText(value) {
    return String(value || '')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/[_|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getStreamText(stream) {
    return normalizeText([
        stream.title,
        stream.name,
        stream.description,
        stream.behaviorHints?.filename,
        stream.behaviorHints?.folderName
    ].filter(Boolean).join(' '));
}

function analyzeItalianSignals(stream) {
    const fullText = getStreamText(stream).toUpperCase();
    if (!fullText) {
        return { isItalian: false, hasAudioItalian: false, hasSubItalian: false, reason: 'empty' };
    }

    const hasAudioItalian = REGEX_AUDIO_ITA.test(fullText);
    const hasSubItalian = REGEX_SUB_ITA.test(fullText);
    const hasTrustedItalian = REGEX_TRUSTED_ITA.test(fullText);
    const hasNegativeLanguage = REGEX_NEGATIVE_LANGUAGE.test(fullText);

    if (hasAudioItalian) {
        return { isItalian: true, hasAudioItalian: true, hasSubItalian, reason: 'audio' };
    }

    if (hasTrustedItalian && !hasNegativeLanguage) {
        return { isItalian: true, hasAudioItalian: false, hasSubItalian, reason: 'trusted' };
    }

    if (hasSubItalian) {
        return { isItalian: true, hasAudioItalian: false, hasSubItalian: true, reason: 'subs' };
    }

    return { isItalian: false, hasAudioItalian: false, hasSubItalian: false, reason: 'none' };
}

function isItalianContent(stream) {
    return analyzeItalianSignals(stream).isItalian;
}

function extractInfoHash(stream) {
    if (stream.infoHash) {
        return String(stream.infoHash).toUpperCase();
    }

    const possibleSources = [stream.url, ...(Array.isArray(stream.sources) ? stream.sources : [])]
        .filter(Boolean)
        .map(String);

    for (const source of possibleSources) {
        const match = source.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
        if (match) return match[1].toUpperCase();
    }

    return null;
}

function extractQuality(text) {
    if (!text) return '';
    const normalized = normalizeText(text);
    const qualityPatterns = [
        /\b(2160p|4k|uhd)\b/i,
        /\b(1080p)\b/i,
        /\b(720p)\b/i,
        /\b(480p|sd)\b/i
    ];

    for (const pattern of qualityPatterns) {
        const match = normalized.match(pattern);
        if (match) return match[1].toLowerCase();
    }

    return '';
}

function extractSeeders(text) {
    if (!text) return 0;
    const normalized = normalizeText(text);
    const match = normalized.match(/(?:👤|👥)\s*(\d+)|[Ss](?:eeders?)?:\s*(\d+)|Peers?:\s*(\d+)/);
    if (!match) return 0;
    return parseInt(match[1] || match[2] || match[3], 10) || 0;
}

function extractSize(text) {
    if (!text) return { formatted: '', bytes: 0 };
    const normalized = normalizeText(text);
    const match = normalized.match(SIZE_REGEX);
    if (!match) return { formatted: '', bytes: 0 };

    const value = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    if (!Number.isFinite(value) || value <= 0) return { formatted: '', bytes: 0 };

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

    const bytes = Math.round(value * (multipliers[unit] || 1));
    return { formatted: `${value} ${unit.replace('IB', 'B')}`, bytes };
}

function extractRealProvider(text) {
    if (!text) return null;
    const cleanText = text.toUpperCase();
    const ignoreList = ['TORRENTIO', 'MEDIAFUSION'];
    
    for (const p of KNOWN_PROVIDERS) {
        if (cleanText.includes(p.toUpperCase())) {
            let found = p;
            ignoreList.forEach(ignore => {
                found = found.replace(new RegExp(ignore, 'ig'), '').trim();
            });
            return found || 'P2P';
        }
    }
    const lastTag = cleanText.match(/\b([A-Z0-9]{5,})\b$/);
    return lastTag ? lastTag[1] : 'P2P';
}

function normalizeMediaFusionProvider(provider) {
    if (!provider) return provider;
    if (/^Contribution Stream\b/i.test(provider)) return 'Contribution Stream';
    return provider;
}

function extractPackTitle(stream) {
    const text = normalizeText(stream.title || stream.description || '');
    const match = text.match(/📁\s*([^\n]+)/);
    if (match) return match[1].trim();

    const folderName = normalizeText(stream.behaviorHints?.folderName || '');
    if (folderName && !VIDEO_FILE_REGEX.test(folderName)) {
        return folderName;
    }

    return null;
}

function extractFilename(stream) {
    const hintedFilename = normalizeText(stream.behaviorHints?.filename || '');
    if (hintedFilename) return hintedFilename;

    const text = normalizeText(stream.title || stream.description || '');
    const match = text.match(/📄\s*([^\n]+)/);
    if (match) return match[1].trim();

    return normalizeText(stream.name || '');
}

function getTorrentioCredential(userConfig, service) {
    if (!userConfig || !service) return null;
    const configByService = {
        rd: userConfig.rd || userConfig.realdebrid || userConfig.key,
        ad: userConfig.ad || userConfig.alldebrid || userConfig.key,
        tb: userConfig.tb || userConfig.torbox || userConfig.key
    };
    return configByService[service] || null;
}

function buildTorrentioBaseUrl(baseUrl, userConfig) {
    const service = userConfig?.service;
    const apiKey = getTorrentioCredential(userConfig, service);
    if (!service || !apiKey) return baseUrl;

    const torrentioConf = {};
    if (service === 'rd') torrentioConf.realdebrid = apiKey;
    else if (service === 'ad') torrentioConf.alldebrid = apiKey;
    else if (service === 'tb') torrentioConf.torbox = apiKey;
    else return baseUrl;

    const base64Conf = Buffer.from(JSON.stringify(torrentioConf)).toString('base64');
    
    const nakedUrl = String(baseUrl).replace(/\/[a-zA-Z0-9=_-]+\/?$/, '');
    debugLog(`🔑 [Torrentio] Config injected for service=${service} token=${maskToken(apiKey)}`);
    return `${nakedUrl}/${base64Conf}`;
}

function maskToken(value) {
    const token = String(value || '');
    if (token.length <= 8) return '***';
    return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

function sanitizeFetchType(type, id) {
    const rawType = String(type || '').trim().toLowerCase();
    const rawId = String(id || '');
    if (rawType === 'anime' || rawId.startsWith('kitsu:')) return 'series';
    return rawType || 'movie';
}

function sanitizePathSegment(value) {
    return encodeURIComponent(String(value || '').trim());
}

function normalizeAddonUrl(baseUrl) {
    if (!baseUrl) return null;
    return String(baseUrl).replace(/\/+$/, '');
}

async function safeJson(response) {
    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

async function fetchExternalAddon(addonKey, type, id, options = {}) {
    const addon = EXTERNAL_ADDONS[addonKey];
    if (!addon) {
        console.error(`❌ [External] Unknown addon: ${addonKey}`);
        return [];
    }

    let baseUrl = normalizeAddonUrl(addon.baseUrl);
    if (addonKey.includes('torrentio')) {
        baseUrl = buildTorrentioBaseUrl(baseUrl, options.userConfig || null);
    }

    if (!baseUrl) {
        debugLog(`⏭️ [${addon.name}] Skipped - base URL not configured`);
        return [];
    }

    const fetchType = sanitizeFetchType(type, id);
    const safeId = sanitizePathSegment(id);
    const url = `${baseUrl}/stream/${fetchType}/${safeId}.json`;
    debugLog(`🌐 [${addon.name}] Fetching ${fetchType}/${id}`);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), addon.timeout);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Leviathan/1.0 (Stremio Addon)',
                Accept: 'application/json'
            }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await safeJson(response);
            const errorMessage = errorData?.message || errorData?.error || `HTTP ${response.status}`;
            console.error(`❌ [${addon.name}] ${errorMessage}`);
            return [];
        }

        const data = await safeJson(response);
        const streams = Array.isArray(data?.streams) ? data.streams : [];

        const countBefore = streams.length;
        const onlyItalian = options.onlyItalian !== false;
        const filteredStreams = onlyItalian ? streams.filter(isItalianContent) : streams;
        debugLog(`🇮🇹 [${addon.name}] Filter ${countBefore} -> ${filteredStreams.length}`);

        if (DEBUG_MODE && filteredStreams.length > 0) {
            const sampleSignals = analyzeItalianSignals(filteredStreams[0]);
            console.log(`🔍 [${addon.name}] First valid stream (${sampleSignals.reason}):`, JSON.stringify(filteredStreams[0], null, 2).substring(0, 300));
        }

        return filteredStreams
            .map(stream => normalizeExternalStream(stream, addonKey))
            .filter(Boolean);
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.error(`⏱️ [${addon.name}] Timeout after ${addon.timeout}ms`);
        } else {
            console.error(`❌ [${addon.name}] Error:`, error?.message || error);
        }
        return [];
    }
}

function normalizeExternalStream(stream, addonKey) {
    const addon = EXTERNAL_ADDONS[addonKey];
    if (!addon || !stream || typeof stream !== 'object') return null;

    const text = getStreamText(stream);
    const infoHash = extractInfoHash(stream);
    const filename = extractFilename(stream);
    const packTitle = extractPackTitle(stream);
    const quality = extractQuality(filename || stream.name || text);
    const sizeInfo = extractSize(text);
    const seeders = extractSeeders(text);
    const languageInfo = analyzeItalianSignals(stream);

    let originalProvider = extractRealProvider(text);
    
    if (addonKey === 'mediafusion') {
        originalProvider = normalizeMediaFusionProvider(originalProvider || null);
    }

    let sizeBytes = sizeInfo.bytes;
    if (Number.isFinite(stream.behaviorHints?.videoSize) && stream.behaviorHints.videoSize > 0) {
        sizeBytes = stream.behaviorHints.videoSize;
    }
    if (Number.isFinite(stream.video_size) && stream.video_size > 0) {
        sizeBytes = stream.video_size;
    }

    const torrentTitle = packTitle || filename || normalizeText(stream.name || stream.title || '');
    const normalizedFileIdx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : -1;
    const magnetLink = buildMagnetLink(infoHash, stream.sources);

    return {
        infoHash,
        fileIdx: normalizedFileIdx,
        title: torrentTitle,
        filename,
        websiteTitle: torrentTitle,
        file_title: filename,
        quality: quality || String(stream.resolution || '').replace(/[^0-9kp]/gi, '').toLowerCase() || '',
        size: sizeInfo.formatted || formatBytes(sizeBytes),
        mainFileSize: sizeBytes,
        seeders: seeders || stream.peers || 0,
        leechers: 0,
        rawDescription: text,
        potentialPack: Boolean(packTitle) || (filename && text && !text.startsWith(filename) && text.length > filename.length + 20),
        packTitle,
        source: originalProvider ? `${addon.name} (${originalProvider})` : addon.name,
        externalAddon: addonKey,
        externalProvider: originalProvider,
        sourceEmoji: addon.emoji,
        magnetLink,
        url: stream.url || null,
        pubDate: new Date().toISOString(),
        isItalian: languageInfo.isItalian,
        hasItalianAudio: languageInfo.hasAudioItalian,
        hasItalianSubs: languageInfo.hasSubItalian
    };
}

function formatBytes(bytes, decimals = 2) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function buildMagnetLink(infoHash, sources) {
    if (!infoHash) return null;

    let magnet = `magnet:?xt=urn:btih:${infoHash}`;
    if (Array.isArray(sources)) {
        const trackers = sources
            .filter(source => typeof source === 'string')
            .filter(source => source.startsWith('tracker:') || source.startsWith('udp://') || source.startsWith('http://') || source.startsWith('https://'))
            .map(source => source.replace(/^tracker:/, ''))
            .slice(0, 10);

        for (const tracker of trackers) {
            magnet += `&tr=${encodeURIComponent(tracker)}`;
        }
    }

    return magnet;
}

async function fetchAllExternalAddons(type, id, options = {}) {
    const requestedAddons = Array.isArray(options.enabledAddons) && options.enabledAddons.length > 0
        ? options.enabledAddons
        : Object.keys(EXTERNAL_ADDONS);

    const enabledAddons = requestedAddons
        .filter(addonKey => EXTERNAL_ADDONS[addonKey])
        .sort((a, b) => EXTERNAL_ADDONS[a].priority - EXTERNAL_ADDONS[b].priority);

    if (enabledAddons.length === 0) return {};

    debugLog(`🔗 [External Addons] Fetching from: ${enabledAddons.join(', ')}`);
    const startTime = Date.now();

    const promises = enabledAddons.map(async addonKey => ({
        addonKey,
        results: await fetchExternalAddon(addonKey, type, id, options)
    }));

    const settledResults = await Promise.allSettled(promises);
    const resultsByAddon = {};
    let totalResults = 0;

    for (const result of settledResults) {
        if (result.status === 'fulfilled') {
            const { addonKey, results } = result.value;
            resultsByAddon[addonKey] = results;
            totalResults += results.length;
        } else {
            console.error('❌ [External] Promise rejected:', result.reason);
        }
    }

    debugLog(`✅ [External Addons] Total streams: ${totalResults} in ${Date.now() - startTime}ms`);
    return resultsByAddon;
}

async function fetchExternalAddonsFlat(type, id, options = {}) {
    const resultsByAddon = await fetchAllExternalAddons(type, id, options);
    return Object.values(resultsByAddon).flat();
}

module.exports = {
    EXTERNAL_ADDONS,
    fetchExternalAddon,
    fetchAllExternalAddons,
    fetchExternalAddonsFlat,
    normalizeExternalStream,
    extractInfoHash,
    isItalianContent,
    analyzeItalianSignals
};
