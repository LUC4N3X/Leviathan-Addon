/**
 * External Addon Integration Module
 * Integra Torrentio e MediaFusion per aggregare risultati da addon esterni.
 * Gestisce chiamate parallele, normalizzazione e deduplicazione.
 * FILTRO ATTIVO: Solo risultati in Italiano (ITA).
 */

const axios = require("axios"); // Mantenuto per compatibilità con il tuo progetto

// ✅ VERBOSE LOGGING - configurabile via ENV
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// ============================================================================
// CONFIGURATION - URL completi degli addon esterni
// ============================================================================

const EXTERNAL_ADDONS = {
    torrentio: {
        // URL aggiornato (senza /manifest.json alla fine)
        baseUrl: 'https://thorrentan.elninhostre.dpdns.org/e30',
        name: 'Torrentio',
        emoji: '🅣',
        timeout: 2000
    },
    mediafusion: {
        baseUrl: 'https://mediafusionfortheweebs.midnightignite.me/D-FCO8JXfrGOKFpP-Rim96nHZU9epOb5RPbSpgkgVbYoR1NRJNR1C-9X4VDrUSJJNEvp5pk7CGvSLN7cUHUrth3QG8e3mSPa8Ind2k4VzVGFEa-310EjXdsXT_uUXGri86EVnnQ6f_9b0yoVTuVu7Aqk4uY8IXZp47-0FmuxgXX6wleis_0Evllc0v2wcrWIj-D5m3IZhI18CKHr-pUL5h61ZWcaRuxGjgwYK88Xy3PIN2U3YzTi4J9pazQBpCNDH-NpZPwk2RVnjs0WF7dRU5XD_D0robmhH9q0edoqaR_71u1j2y-XnxkwPNjg-o5Yb_',
        name: 'MediaFusion',
        emoji: '🅜',
        timeout: 1500
    }
};

// ============================================================================
// HELPER FUNCTIONS & ITA FILTER
// ============================================================================

// Regex per rilevare contenuto Italiano
const REGEX_STRICT_ITA = /\b(ITA|ITALIAN|ITALY|IT|SUB\s*ITA|VOST|VOSTIT)\b/i;

function isItalianContent(stream) {
    const fullText = (
        (stream.title || "") + " " + 
        (stream.name || "") + " " + 
        (stream.description || "") + " " +
        (stream.behaviorHints?.filename || "")
    ).toUpperCase();

    if (REGEX_STRICT_ITA.test(fullText)) return true;
    if (/CORSARO|ICV|MEGAPHONE|IDN_CREW|MUX|DDN|ITALIAN/.test(fullText)) return true;

    return false;
}

function extractInfoHash(stream) {
    if (stream.infoHash) {
        return stream.infoHash.toUpperCase();
    }
    if (stream.url && stream.url.includes('btih:')) {
        const match = stream.url.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
        if (match) return match[1].toUpperCase();
    }
    return null;
}

function extractQuality(text) {
    if (!text) return '';
    const qualityPatterns = [
        /\b(2160p|4k|uhd)\b/i,
        /\b(1080p)\b/i,
        /\b(720p)\b/i,
        /\b(480p|sd)\b/i
    ];
    for (const pattern of qualityPatterns) {
        const match = text.match(pattern);
        if (match) return match[1].toLowerCase();
    }
    return '';
}

function extractSeeders(text) {
    if (!text) return 0;
    const match = text.match(/👤\s*(\d+)|[Ss](?:eeders)?:\s*(\d+)/);
    if (match) return parseInt(match[1] || match[2]) || 0;
    return 0;
}

function extractSize(text) {
    if (!text) return { formatted: '', bytes: 0 };
    const match = text.match(/(?:📦|💾|Size:?)\s*([\d.,]+)\s*(B|KB|MB|GB|TB)/i);
    if (!match) return { formatted: '', bytes: 0 };

    const value = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();

    const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3, 'TB': 1024 ** 4 };
    const bytes = Math.round(value * (multipliers[unit] || 1));
    return { formatted: `${value} ${unit}`, bytes };
}

function extractOriginalProvider(text) {
    if (!text) return null;
    
    const torrentioMatch = text.match(/🔍\s*([^\n]+)/);
    if (torrentioMatch) return torrentioMatch[1].trim();

    const mfMatch = text.match(/🔗\s*([^\n]+)/);
    if (mfMatch) return mfMatch[1].trim();

    return null;
}

function normalizeMediaFusionProvider(provider) {
    if (!provider) return provider;
    if (/^Contribution Stream\b/i.test(provider)) return 'Contribution Stream';
    return provider;
}

function extractPackTitle(stream) {
    const text = stream.title || stream.description || '';
    
    const match = text.match(/📁\s*([^\n]+)/);
    if (match) return match[1].trim();
    
    const folderName = stream.behaviorHints?.folderName;
    if (folderName) {
        const isFilename = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts)$/i.test(folderName);
        if (!isFilename) {
            return folderName;
        }
    }
    
    return null;
}

function extractFilename(stream) {
    if (stream.behaviorHints?.filename) {
        return stream.behaviorHints.filename;
    }
    const text = stream.title || stream.description || '';
    const match = text.match(/📄\s*([^\n]+)/);
    if (match) return match[1].trim();
    return stream.name || '';
}

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

async function fetchExternalAddon(addonKey, type, id) {
    const addon = EXTERNAL_ADDONS[addonKey];
    if (!addon) {
        console.error(`❌ [External] Unknown addon: ${addonKey}`);
        return [];
    }

    if (!addon.baseUrl) {
        if (DEBUG_MODE) console.log(`⏭️ [${addon.name}] Skipped - base URL not configured`);
        return [];
    }

    let fetchType = type;
    if (type === 'anime' || id.toString().startsWith('kitsu:')) {
        if (fetchType === 'anime') fetchType = 'series';
    }

    const url = `${addon.baseUrl}/stream/${fetchType}/${id}.json`;
    if (DEBUG_MODE) console.log(`🌐 [${addon.name}] Fetching: ${fetchType}/${id}`);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), addon.timeout);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'IlCorsaroViola/1.0 (Stremio Addon)',
                'Accept': 'application/json'
            }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`❌ [${addon.name}] HTTP ${response.status}`);
            return [];
        }

        const data = await response.json();
        let streams = data.streams || [];

        // --- FILTRO RIGIDO SOLO ITA ---
        const countBefore = streams.length;
        streams = streams.filter(isItalianContent);
        if (DEBUG_MODE) console.log(`🇮🇹 [${addon.name}] Strict ITA Filter: ${countBefore} -> ${streams.length}`);

        if (DEBUG_MODE && streams.length > 0) {
            console.log(`🔍 [${addon.name}] First valid ITA stream:`, JSON.stringify(streams[0], null, 2).substring(0, 300));
        }

        return streams.map(stream => normalizeExternalStream(stream, addonKey));

    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`⏱️ [${addon.name}] Timeout after ${addon.timeout}ms`);
        } else {
            console.error(`❌ [${addon.name}] Error:`, error.message);
        }
        return [];
    }
}

function normalizeExternalStream(stream, addonKey) {
    const addon = EXTERNAL_ADDONS[addonKey];
    const text = stream.title || stream.description || stream.name || '';

    const infoHash = extractInfoHash(stream);
    if (DEBUG_MODE) console.log(`🔍 [Normalize] infoHash=${infoHash ? infoHash.substring(0, 8) + '...' : 'NULL'}`);

    const filename = extractFilename(stream);
    const packTitle = extractPackTitle(stream);
    const quality = extractQuality(stream.name || filename || text);
    const sizeInfo = extractSize(text);
    const seeders = extractSeeders(text);
    let originalProvider = extractOriginalProvider(text);
    
    if (addonKey === 'mediafusion') {
        originalProvider = normalizeMediaFusionProvider(originalProvider || null);
    }

    let sizeBytes = sizeInfo.bytes;
    if (stream.behaviorHints?.videoSize) sizeBytes = stream.behaviorHints.videoSize;
    if (stream.video_size) sizeBytes = stream.video_size;

    const torrentTitle = packTitle || filename;

    return {
        infoHash: infoHash,
        fileIdx: stream.fileIdx ?? 0,
        title: torrentTitle,           
        filename: filename,            
        websiteTitle: torrentTitle,    
        file_title: filename,          
        quality: quality || stream.resolution?.replace(/[^0-9kp]/gi, '') || '',
        size: sizeInfo.formatted || formatBytes(sizeBytes),
        mainFileSize: sizeBytes,
        seeders: seeders || stream.peers || 0,
        leechers: 0,
        rawDescription: text,  
        potentialPack: !!packTitle || (filename && text && !text.startsWith(filename) && text.length > filename.length + 20),
        packTitle: packTitle,  
        source: originalProvider ? `${addon.name} (${originalProvider})` : addon.name,
        externalAddon: addonKey,
        externalProvider: originalProvider,
        sourceEmoji: addon.emoji,
        magnetLink: buildMagnetLink(infoHash, stream.sources),
        pubDate: new Date().toISOString()
    };
}

function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function buildMagnetLink(infoHash, sources) {
    if (!infoHash) return null;
    let magnet = `magnet:?xt=urn:btih:${infoHash}`;
    if (sources && Array.isArray(sources)) {
        const trackers = sources
            .filter(s => s.startsWith('tracker:') || s.startsWith('udp://') || s.startsWith('http'))
            .map(s => s.replace(/^tracker:/, ''))
            .slice(0, 10);
        for (const tracker of trackers) {
            magnet += `&tr=${encodeURIComponent(tracker)}`;
        }
    }
    return magnet;
}

async function fetchAllExternalAddons(type, id, options = {}) {
    const enabledAddons = options.enabledAddons || Object.keys(EXTERNAL_ADDONS);

    if (DEBUG_MODE) console.log(`\n🔗 [External Addons] Fetching from: ${enabledAddons.join(', ')}`);
    const startTime = Date.now();

    const promises = enabledAddons.map(async (addonKey) => {
        const results = await fetchExternalAddon(addonKey, type, id);
        return { addonKey, results };
    });

    const settledResults = await Promise.allSettled(promises);
    const resultsByAddon = {};
    let totalResults = 0;

    for (const result of settledResults) {
        if (result.status === 'fulfilled') {
            const { addonKey, results } = result.value;
            resultsByAddon[addonKey] = results;
            totalResults += results.length;
        } else {
            console.error(`❌ [External] Promise rejected:`, result.reason);
        }
    }

    const elapsed = Date.now() - startTime;
    if (DEBUG_MODE) console.log(`✅ [External Addons] Total ITA streams: ${totalResults} in ${elapsed}ms`);

    return resultsByAddon;
}

async function fetchExternalAddonsFlat(type, id, options = {}) {
    const resultsByAddon = await fetchAllExternalAddons(type, id, options);
    const allResults = [];
    for (const addonKey of Object.keys(resultsByAddon)) {
        allResults.push(...resultsByAddon[addonKey]);
    }
    return allResults;
}

module.exports = {
    EXTERNAL_ADDONS,
    fetchExternalAddon,
    fetchAllExternalAddons,
    fetchExternalAddonsFlat,
    normalizeExternalStream,
    extractInfoHash
};
