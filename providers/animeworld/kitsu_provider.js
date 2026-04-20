'use strict';

const {
    uniqueStrings,
    normalizeRequestedEpisode,
    fetchWithTimeout
} = require('../anime/shared');

const TIMEOUT = 10000;
const CACHE_TTL = 30 * 60 * 1000;

const infoCache = new Map();
const inflight = new Map();

function getCached(kitsuId) {
    const entry = infoCache.get(kitsuId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        infoCache.delete(kitsuId);
        return undefined;
    }
    return entry.value;
}

function setCached(kitsuId, value) {
    infoCache.set(kitsuId, {
        value,
        expiresAt: Date.now() + CACHE_TTL
    });
    return value;
}

function extractYear(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : null;
}

function collectMetaTitles(meta = {}) {
    return uniqueStrings([
        meta?.title,
        meta?.name,
        meta?.originalTitle,
        meta?.originalName,
        ...(Array.isArray(meta?.titles) ? meta.titles : []),
        ...(Array.isArray(meta?.aliases) ? meta.aliases : []),
        ...(Array.isArray(meta?.aka_titles) ? meta.aka_titles : [])
    ]);
}

class KitsuProvider {
    async getAnimeInfo(kitsuId) {
        const parsed = this.parseKitsuId(String(kitsuId || '').trim());
        const normalizedId = parsed?.kitsuId || String(kitsuId || '').trim();
        if (!normalizedId) return null;

        const cached = getCached(normalizedId);
        if (cached !== undefined) return cached;

        const running = inflight.get(normalizedId);
        if (running) return running;

        const task = (async () => {
            try {
                const response = await fetchWithTimeout(`https://kitsu.io/api/edge/anime/${normalizedId}`, {
                    method: 'GET',
                    headers: {
                        accept: 'application/vnd.api+json'
                    }
                }, TIMEOUT);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} ${response.statusText}`);
                }

                const payload = await response.json();
                const data = payload?.data;
                const attributes = data?.attributes || {};
                const titles = uniqueStrings([
                    attributes?.titles?.en,
                    attributes?.canonicalTitle,
                    attributes?.titles?.en_us,
                    attributes?.titles?.en_jp,
                    attributes?.titles?.ja_jp,
                    ...(Array.isArray(attributes?.abbreviatedTitles) ? attributes.abbreviatedTitles : [])
                ]);

                const result = {
                    title: titles[0] || null,
                    canonicalTitle: attributes?.canonicalTitle || null,
                    titles,
                    date: attributes?.startDate || null,
                    subtype: attributes?.subtype || null,
                    episodeCount: Number.isInteger(attributes?.episodeCount)
                        ? attributes.episodeCount
                        : Number.parseInt(String(attributes?.episodeCount || ''), 10) || null
                };

                return setCached(normalizedId, result);
            } catch (error) {
                console.error(`Error fetching Kitsu info for ID ${normalizedId}:`, error.message);
                return null;
            }
        })();

        inflight.set(normalizedId, task);
        try {
            return await task;
        } finally {
            inflight.delete(normalizedId);
        }
    }

    parseKitsuId(kitsuIdString) {
        const parts = String(kitsuIdString || '')
            .trim()
            .split(':')
            .map((part) => String(part || '').trim());

        if (parts.length < 2 || parts[0].toLowerCase() !== 'kitsu' || !/^\d+$/.test(parts[1])) {
            return null;
        }

        const kitsuId = parts[1];

        if (parts.length === 2) {
            return { kitsuId, seasonNumber: null, episodeNumber: null, isMovie: true };
        }

        if (parts.length === 3) {
            const episodeNumber = Number.parseInt(parts[2], 10);
            return {
                kitsuId,
                seasonNumber: null,
                episodeNumber: Number.isInteger(episodeNumber) && episodeNumber > 0 ? episodeNumber : null,
                isMovie: false
            };
        }

        if (parts.length >= 4) {
            const seasonNumber = Number.parseInt(parts[2], 10);
            const episodeNumber = Number.parseInt(parts[3], 10);
            return {
                kitsuId,
                seasonNumber: Number.isInteger(seasonNumber) ? seasonNumber : null,
                episodeNumber: Number.isInteger(episodeNumber) && episodeNumber > 0 ? episodeNumber : null,
                isMovie: false
            };
        }

        return null;
    }

    normalizeTitle(title) {
        const exactMap = {
            'Demon Slayer: Kimetsu no Yaiba - The Movie: Infinity Castle': 'Demon Slayer: Kimetsu no Yaiba Infinity Castle',
            'Attack on Titan: The Final Season - Final Chapters Part 2': "L'attacco dei Giganti: L'ultimo attacco",
            'Ore dake Level Up na Ken': 'Solo Leveling',
            'Lupin the Third: The Woman Called Fujiko Mine': 'Lupin III - La donna chiamata Fujiko Mine',
            'Slam Dunk: Roar!! Basket Man Spiriy': 'Slam Dunk: Hoero Basketman-damashii! Hanamichi to Rukawa no Atsuki Natsu',
            'Parasyte: The Maxim': 'Kiseijuu',
            'Attack on Titan OAD': "L'attacco dei Giganti: Il taccuino di Ilse",
            'Fullmetal Alchemist: Brotherhood': 'Fullmetal Alchemist Brotherhood',
            "JoJo's Bizarre Adventure (2012)": 'Le Bizzarre Avventure di JoJo',
            "JoJo's Bizarre Adventure: Stardust Crusaders": 'Le Bizzarre Avventure di JoJo: Stardust Crusaders',
            "Cat's Eye (2025)": 'Occhi di gatto (2025)',
            'Ranma ½ (2024) Season 2': 'Ranma 1/2 (2024) 2',
            'Link Click Season 2': 'Link Click 2',
            'Nichijou - My Ordinary Life': 'Nichijou',
            'Case Closed Movie 01: The Time Bombed Skyscraper': 'Detective Conan Movie 01: Fino alla fine del tempo',
            'My Hero Academia Final Season': 'Boku no Hero Academia: Final Season',
            'Jujutsu Kaisen: The Culling Game Part 1': 'Jujutsu Kaisen 3: The Culling Game Part 1',
            "Hell's Paradise Season 2": 'Jigokuraku 2',
            '[Oshi no Ko]': 'Oshi no Ko',
            'Record of Ragnarok II': 'Record of Ragnarok 2',
            'Magical Circle': 'Mahoujin Guru Guru'
        };

        if (exactMap[title]) return exactMap[title];

        const genericMap = {
            'Attack on Titan': "L'attacco dei Giganti",
            'Season': '',
            'Shippuuden': 'Shippuden'
        };

        let normalized = String(title || '').trim();
        for (const [source, target] of Object.entries(genericMap)) {
            if (source && normalized.includes(source)) {
                normalized = normalized.split(source).join(target);
            }
        }

        normalized = normalized
            .replace(/\s+-\s+-\s+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();

        if (normalized.includes('Naruto:')) {
            normalized = normalized.replace(':', '');
        }

        return normalized;
    }

    async buildSearchContext(requestId, meta = {}) {
        const candidates = [requestId, meta?.id, meta?.kitsu_id];
        let parsed = null;

        for (const candidate of candidates) {
            parsed = this.parseKitsuId(candidate);
            if (parsed?.kitsuId) break;
        }

        const info = parsed?.kitsuId ? await this.getAnimeInfo(parsed.kitsuId) : null;
        const rawTitles = uniqueStrings([
            ...(info?.titles || []),
            ...collectMetaTitles(meta)
        ]);
        const searchTitles = uniqueStrings(rawTitles.map((title) => this.normalizeTitle(title)));
        const requestedEpisode = Number.isInteger(parsed?.episodeNumber) && parsed.episodeNumber > 0
            ? parsed.episodeNumber
            : normalizeRequestedEpisode(meta?.episode);
        const metaSeriesFlag = typeof meta?.isSeries === 'boolean' ? meta.isSeries : null;
        const subtype = String(info?.subtype || '').toLowerCase();

        return {
            kitsuId: parsed?.kitsuId || null,
            info,
            rawTitles,
            searchTitles,
            title: searchTitles[0] || rawTitles[0] || null,
            date: info?.date || null,
            year: extractYear(info?.date || meta?.year || ''),
            seasonNumber: Number.isInteger(parsed?.seasonNumber) ? parsed.seasonNumber : null,
            requestedEpisode,
            isMovie: typeof metaSeriesFlag === 'boolean'
                ? !metaSeriesFlag
                : Boolean(parsed?.isMovie || subtype === 'movie')
        };
    }

    extractYear(value) {
        return extractYear(value);
    }
}

module.exports = new KitsuProvider();
