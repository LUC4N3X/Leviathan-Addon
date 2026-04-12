const axios = require('axios');

const URLS = {
    FRIBB: "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json",
    THEBEAST: "https://raw.githubusercontent.com/TheBeastLT/stremio-kitsu-anime/master/static/data/imdb_mapping.json",
    KITSU_API: "https://kitsu.io/api/edge/anime"
};

const CACHE_DURATION = 1000 * 60 * 60 * 24; 

let mappingCache = {
    map: new Map(),
    lastFetch: 0,
    isLoaded: false,
    isLoading: false 
};

function parsePositiveInt(value, fallback = null) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueStrings(values = []) {
    const seen = new Set();
    const output = [];

    for (const value of values) {
        const text = String(value || '').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        output.push(text);
    }

    return output;
}

function parseKitsuIdentifier(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return null;

    if (/^\d+$/.test(value)) {
        return {
            raw: `kitsu:${value}`,
            kitsuId: value,
            season: 1,
            episode: null,
            isEpisode: false
        };
    }

    const parts = value.split(':').map((part) => String(part || '').trim());
    if (parts.length < 2 || parts[0].toLowerCase() !== 'kitsu' || !/^\d+$/.test(parts[1])) {
        return null;
    }

    let season = 1;
    let episode = null;

    if (parts.length === 3) {
        episode = parsePositiveInt(parts[2], null);
    } else if (parts.length >= 4) {
        season = parsePositiveInt(parts[2], 1);
        episode = parsePositiveInt(parts[3], null);
    }

    return {
        raw: value,
        kitsuId: parts[1],
        season,
        episode,
        isEpisode: Number.isInteger(episode) && episode > 0
    };
}

function normalizeType(kitsuType) {
    if (!kitsuType) return 'series';
    const t = kitsuType.toLowerCase();
    return (t === 'tv' || t === 'ova' || t === 'ona' || t === 'current') ? 'series' : 'movie';
}

function buildTitleVariants(attributes = {}) {
    return uniqueStrings([
        attributes?.canonicalTitle,
        attributes?.titles?.en,
        attributes?.titles?.en_us,
        attributes?.titles?.en_jp,
        attributes?.titles?.ja_jp,
        ...(Array.isArray(attributes?.abbreviatedTitles) ? attributes.abbreviatedTitles : [])
    ]);
}

async function updateCache() {
    const now = Date.now();
    
    if ((mappingCache.isLoaded && (now - mappingCache.lastFetch < CACHE_DURATION)) || mappingCache.isLoading) {
        return;
    }

    mappingCache.isLoading = true;
    console.log("🐉 [KITSU] Avvio download database mapping in background...");

    try {
        const [fribbRes, beastRes] = await Promise.allSettled([
            axios.get(URLS.FRIBB, { timeout: 20000 }), 
            axios.get(URLS.THEBEAST, { timeout: 20000 })
        ]);

        const tempMap = new Map();

        if (fribbRes.status === 'fulfilled' && Array.isArray(fribbRes.value.data)) {
            fribbRes.value.data.forEach(item => {
                if (item.kitsu_id && item.imdb_id) {
                    tempMap.set(String(item.kitsu_id), {
                        imdb_id: item.imdb_id,
                        type: normalizeType(item.type),
                        season: 1,
                        episode: 1,
                        source: 'fribb'
                    });
                }
            });
        }

        if (beastRes.status === 'fulfilled' && beastRes.value.data) {
            const data = beastRes.value.data;
            Object.keys(data).forEach(kID => {
                const entry = data[kID];
                if (entry.imdb_id) {
                    tempMap.set(String(kID), {
                        imdb_id: entry.imdb_id,
                        type: 'series',
                        season: entry.fromSeason || 1,
                        episode: entry.fromEpisode || 1,
                        source: 'thebeastlt'
                    });
                }
            });
        }

        if (tempMap.size > 0) {
            mappingCache.map = tempMap;
            mappingCache.lastFetch = now;
            mappingCache.isLoaded = true;
            console.log(`🐉 [KITSU] Cache Rigenerata. Totale Anime: ${tempMap.size}`);
        }

    } catch (e) {
        console.error("❌ Errore update Kitsu cache:", e.message);
    } finally {
        mappingCache.isLoading = false;
    }
}

async function fetchKitsuLive(kitsuID) {
    try {
        const parsedIdentifier = parseKitsuIdentifier(kitsuID);
        const normalizedId = parsedIdentifier?.kitsuId || String(kitsuID || '').trim();
        if (!normalizedId) return null;

        const url = `${URLS.KITSU_API}/${normalizedId}?include=mappings`;
        const res = await axios.get(url, { timeout: 2500 }); 
        
        const data = res.data?.data;
        const included = res.data?.included;

        if (!data || !included) return null;

        const imdbMapping = included.find(m => 
            m.type === 'mappings' && 
            m.attributes?.externalSite === 'imdb'
        );

        if (imdbMapping && imdbMapping.attributes?.externalId) {
            const kType = data.attributes?.subtype || 'TV';
            const titles = buildTitleVariants(data.attributes || {});
            const startDate = String(data.attributes?.startDate || '');
            const result = {
                imdb_id: imdbMapping.attributes.externalId,
                type: normalizeType(kType),
                season: 1,
                episode: 1,
                titles,
                aliases: titles,
                year: /^\d{4}/.test(startDate) ? startDate.slice(0, 4) : '',
                subtype: String(data.attributes?.subtype || ''),
                episode_count: parsePositiveInt(data.attributes?.episodeCount, null),
                source: 'kitsu-live'
            };
            return result;
        }
    } catch (e) {

    }
    return null;
}

async function kitsuHandler(kitsuID) {
    const parsedIdentifier = parseKitsuIdentifier(kitsuID);
    if (!parsedIdentifier?.kitsuId) return null;
    const strID = parsedIdentifier.kitsuId;

    if (!mappingCache.isLoaded) {
        updateCache().catch(e => console.error(e));
        
        return await fetchKitsuLive(strID);
    }
    
    let entry = mappingCache.map.get(strID);

    if (!entry) {
        entry = await fetchKitsuLive(strID);
        if (entry) mappingCache.map.set(strID, entry);
    }

    if (!entry) return null;

    return {
        imdbID: entry.imdb_id,
        season: entry.season,
        episode: entry.episode,
        type: entry.type,
        titles: uniqueStrings(entry.titles || entry.aliases || []),
        aliases: uniqueStrings(entry.aliases || entry.titles || []),
        year: entry.year || '',
        subtype: entry.subtype || '',
        episodeCount: parsePositiveInt(entry.episode_count, null)
    };
}

updateCache();

module.exports = kitsuHandler;
module.exports.kitsuHandler = kitsuHandler;
module.exports.parseKitsuIdentifier = parseKitsuIdentifier;
