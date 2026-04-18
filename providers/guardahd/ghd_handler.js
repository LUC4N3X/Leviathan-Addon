const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { buildMediaflowUrl, buildWebStream, extractSizeText } = require('../extractors/common');
const { extractFromUrl, resolveExtractorDefinition } = require('../extractors/registry');

const CONFIG = {
    CACHE: {
        FILE: path.join(__dirname, '..', 'config', 'guardahd_cache.json'),
        TTL: 43200000,
        STALE_TTL: 86400000
    },
    TMDB_API_KEY: "5bae8d11f2a7bc7a95c6d040a31d2163",
    SCRAPER: {
        MAX_CONCURRENT_EMBEDS: 15,
        TIMEOUT: 15000,
        BASE_URL: 'https://guardahd.stream',
        RETRIES: 2
    }
};

const getRandomUserAgent = () => {
    const uas = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    return uas[Math.floor(Math.random() * uas.length)];
};

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 30000
});

const httpClient = axios.create({
    timeout: CONFIG.SCRAPER.TIMEOUT,
    httpsAgent,
    validateStatus: (status) => status >= 200 && status < 400
});

httpClient.interceptors.response.use(undefined, async (err) => {
    const config = err.config;
    if (!config || !config.retry) return Promise.reject(err);

    config.retryCount = config.retryCount || 0;
    if (config.retryCount >= config.retry) return Promise.reject(err);

    config.retryCount += 1;
    await new Promise(r => setTimeout(r, Math.pow(2, config.retryCount) * 500));

    config.headers['User-Agent'] = getRandomUserAgent();
    return httpClient(config);
});

const fetchSmart = (url, options = {}) => httpClient({
    url,
    method: 'GET',
    retry: CONFIG.SCRAPER.RETRIES,
    headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Referer': CONFIG.SCRAPER.BASE_URL,
        ...options.headers
    },
    ...options
});

const REGEX = {
    Q_4K: /4k|2160p|uhd/i,
    Q_1080: /1080p|fullhd|fhd/i,
    Q_720: /720p|hd/i,
    Q_480: /480p|sd/i
};

class AsyncSemaphore {
    #max; #active; #queue;
    constructor(max) { this.#max = max; this.#active = 0; this.#queue = []; }
    async acquire() {
        if (this.#active < this.#max) { this.#active++; return; }
        return new Promise(resolve => this.#queue.push(resolve));
    }
    release() {
        this.#active--;
        if (this.#queue.length > 0) { this.#active++; this.#queue.shift()(); }
    }
}
const embedSemaphore = new AsyncSemaphore(CONFIG.SCRAPER.MAX_CONCURRENT_EMBEDS);

const normalizeUrl = (url) => url?.startsWith('//') ? `https:${url}` : (url || '');
const parseQuality = (text) => {
    if (!text) return "Unknown";
    if (REGEX.Q_4K.test(text)) return "4K";
    if (REGEX.Q_1080.test(text)) return "1080p";
    if (REGEX.Q_720.test(text)) return "720p";
    if (REGEX.Q_480.test(text)) return "480p";
    return "Unknown";
};

const generateRichDescription = (title, quality = 'Unknown', size = 'N/A', hoster = '') => {
    const sizeTag = size !== 'N/A' ? `💾 ${size} • ` : '';
    const hosterTag = hoster ? ` [${hoster}]` : '';
    return `🎬 ${title}${hosterTag}\n${sizeTag}📺 ${quality} • 🇮🇹 ITA\n⚡ GuardaHD`;
};

class CacheManager {
    #file; #cache; #loaded; #isWriting;

    constructor() {
        this.#file = CONFIG.CACHE.FILE;
        this.#cache = new Map();
        this.#loaded = false;
        this.#isWriting = false;
    }

    async init() {
        if (this.#loaded) return;
        try {
            const data = await fs.readFile(this.#file, 'utf8');
            const raw = JSON.parse(data);
            for (const [key, value] of Object.entries(raw)) this.#cache.set(key, value);
        } catch {}
        this.#loaded = true;
    }

    async #save() {
        if (this.#isWriting) return;
        this.#isWriting = true;
        try {
            await fs.mkdir(path.dirname(this.#file), { recursive: true });
            const now = Date.now();
            for (const [key, val] of this.#cache.entries()) {
                if (now - val.timestamp > CONFIG.CACHE.STALE_TTL) this.#cache.delete(key);
            }
            await fs.writeFile(this.#file, JSON.stringify(Object.fromEntries(this.#cache)), 'utf8');
        } catch {}
        finally { this.#isWriting = false; }
    }

    async get(key) {
        await this.init();
        const entry = this.#cache.get(key);
        if (!entry) return { data: null, isStale: false };

        const age = Date.now() - entry.timestamp;
        if (age < CONFIG.CACHE.TTL) return { data: entry, isStale: false };
        if (age < CONFIG.CACHE.STALE_TTL) return { data: entry, isStale: true };

        this.#cache.delete(key);
        this.#save();
        return { data: null, isStale: false };
    }

    async set(key, embeds, title) {
        await this.init();
        this.#cache.set(key, { timestamp: Date.now(), embeds, title });
        this.#save();
    }
}
const cacheManager = new CacheManager();


async function fetchTmdbMovieByImdb(imdbId) {
    if (!/^tt\d+$/i.test(String(imdbId || '').trim())) return null;
    try {
        const res = await fetchSmart(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${CONFIG.TMDB_API_KEY}&external_source=imdb_id&language=it-IT`);
        return res.data?.movie_results?.[0] || null;
    } catch {
        return null;
    }
}

async function fetchTmdbMovieById(tmdbId) {
    if (!/^\d+$/.test(String(tmdbId || '').trim())) return null;
    try {
        const res = await fetchSmart(`https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}?api_key=${CONFIG.TMDB_API_KEY}&language=it-IT`);
        return res.data || null;
    } catch {
        return null;
    }
}

async function fetchMovieImdbIdFromTmdb(tmdbId) {
    if (!/^\d+$/.test(String(tmdbId || '').trim())) return null;
    try {
        const res = await fetchSmart(`https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}/external_ids?api_key=${CONFIG.TMDB_API_KEY}`);
        return /^tt\d+$/i.test(String(res.data?.imdb_id || '').trim()) ? String(res.data.imdb_id).trim() : null;
    } catch {
        return null;
    }
}

function resolveTmdbMovieId(meta) {
    const direct = String(meta?.tmdb_id || meta?.tmdbId || '').trim();
    if (/^\d+$/.test(direct)) return direct;
    const metaId = String(meta?.id || '').trim();
    const match = metaId.match(/^tmdb:(\d+)/i);
    return match ? match[1] : null;
}

async function resolveMovieIdentity(meta) {
    if (!meta || meta.isSeries) return null;

    const explicitImdb = /^tt\d+$/i.test(String(meta?.imdb_id || '').trim()) ? String(meta.imdb_id).trim() : null;
    const explicitTmdb = resolveTmdbMovieId(meta);

    if (explicitImdb) {
        const tmdbMovie = await fetchTmdbMovieByImdb(explicitImdb);
        return {
            imdbId: explicitImdb,
            tmdbId: tmdbMovie?.id ? String(tmdbMovie.id) : explicitTmdb,
            title: tmdbMovie?.title ? (tmdbMovie.release_date ? `${tmdbMovie.title} (${String(tmdbMovie.release_date).slice(0, 4)})` : tmdbMovie.title) : (meta?.title || 'Film HD'),
            cacheKey: `imdb:${explicitImdb}`
        };
    }

    if (explicitTmdb) {
        const [tmdbMovie, imdbId] = await Promise.all([
            fetchTmdbMovieById(explicitTmdb),
            fetchMovieImdbIdFromTmdb(explicitTmdb)
        ]);
        if (!imdbId) return null;
        return {
            imdbId,
            tmdbId: explicitTmdb,
            title: tmdbMovie?.title ? (tmdbMovie.release_date ? `${tmdbMovie.title} (${String(tmdbMovie.release_date).slice(0, 4)})` : tmdbMovie.title) : (meta?.title || 'Film HD'),
            cacheKey: `tmdb:${explicitTmdb}`
        };
    }

    return null;
}

class GuardaHDScraper {
    #config;

    constructor(config) { this.#config = config; }

    async #getTmdbTitle(identity) {
        return identity?.title || 'Film HD';
    }

    async #scrapeEmbedUrls(imdbId) {
        if (!/^tt\d+$/i.test(String(imdbId || '').trim())) return [];
        try {
            const res = await fetchSmart(`${CONFIG.SCRAPER.BASE_URL}/set-movie-a/${imdbId}`);
            const $ = cheerio.load(res.data);
            const embedDict = new Map();

            const registerLink = (rawLink) => {
                const link = normalizeUrl(String(rawLink || '').replace(/&amp;/g, '&'));
                if (!/^https?:/i.test(link)) return;
                const definition = resolveExtractorDefinition(link);
                if (!definition) return;
                if (!embedDict.has(definition.key)) embedDict.set(definition.key, link);
            };

            $('li[data-link]').each((_, el) => registerLink($(el).attr('data-link')));
            $('iframe[src]').each((_, el) => registerLink($(el).attr('src')));
            $('a[href], source[src]').each((_, el) => registerLink($(el).attr('href') || $(el).attr('src')));

            const directMatches = String(res.data || '').match(/https?:\/\/(?:www\.)?(?:mixdrop|m1xdrop|mxcontent|loadm)[^"'<\s]+/ig) || [];
            directMatches.forEach(registerLink);

            return Array.from(embedDict.values());
        } catch {
            return [];
        }
    }

    async #processSingleEmbed(url, title) {
        await embedSemaphore.acquire();
        try {
            const normalizedUrl = normalizeUrl(String(url || '').replace(/&amp;/g, '&'));
            const definition = resolveExtractorDefinition(normalizedUrl);

            if (definition?.key === 'mixdrop' && this.#config?.mediaflow?.url) {
                const embedUrl = normalizedUrl.replace('/f/', '/e/');
                let quality = 'Unknown';
                let size = 'N/A';

                try {
                    const response = await fetchSmart(embedUrl.replace('/e/', '/f/'), {
                        headers: {
                            Referer: `${new URL(embedUrl).origin}/`
                        }
                    });
                    const fileHtml = typeof response?.data === 'string' ? response.data : '';
                    if (fileHtml) {
                        quality = parseQuality(fileHtml);
                        size = extractSizeText(fileHtml);
                    }
                } catch {}

                const mediaflowUrl = buildMediaflowUrl(this.#config, embedUrl, 'extractor', 'Mixdrop');
                if (!mediaflowUrl) return [];

                return [
                    buildWebStream({
                        name: '🦁 GHD\n⚡ MixDrop',
                        title: generateRichDescription(title, quality, size, 'MixDrop'),
                        url: mediaflowUrl,
                        extractor: 'MixDrop',
                        provider: 'GuardaHD',
                        providerCode: 'GHD',
                        quality,
                        headers: null,
                        extraBehaviorHints: {
                            bingeWatching: true
                        },
                        extra: {
                            qualityRank: quality
                        }
                    })
                ];
            }

            const extracted = await extractFromUrl(url, {
                client: httpClient,
                userAgent: getRandomUserAgent(),
                requestReferer: CONFIG.SCRAPER.BASE_URL,
                referer: CONFIG.SCRAPER.BASE_URL
            });
            if (!extracted?.url) return [];

            const quality = parseQuality(extracted.quality || url);
            return [
                buildWebStream({
                    name: `🦁 GHD\n⚡ ${extracted.name}`,
                    title: generateRichDescription(title, quality, extracted.size || 'N/A', extracted.name),
                    url: extracted.url,
                    extractor: extracted.name,
                    provider: 'GuardaHD',
                    providerCode: 'GHD',
                    quality,
                    headers: extracted.headers,
                    extraBehaviorHints: {
                        bingeWatching: true
                    },
                    extra: {
                        qualityRank: quality
                    }
                })
            ];
        } catch {
            return [];
        } finally {
            embedSemaphore.release();
        }
    }

    async getStreams(meta) {
        if (!meta || meta.isSeries) return [];

        const identity = await resolveMovieIdentity(meta);
        if (!identity?.imdbId) return [];

        let embedUrls = [];
        let officialTitle = meta?.title || identity.title || 'Film HD';
        const cacheKey = identity.cacheKey || `imdb:${identity.imdbId}`;

        const { data: cached, isStale } = await cacheManager.get(cacheKey);

        if (cached) {
            embedUrls = Array.isArray(cached.embeds) ? cached.embeds : [];
            officialTitle = cached.title || officialTitle;

            if (isStale) {
                Promise.all([this.#scrapeEmbedUrls(identity.imdbId), this.#getTmdbTitle(identity)])
                    .then(([urls, title]) => {
                        if (urls.length > 0) cacheManager.set(cacheKey, urls, title);
                    })
                    .catch(() => {});
            }
        } else {
            [embedUrls, officialTitle] = await Promise.all([
                this.#scrapeEmbedUrls(identity.imdbId),
                this.#getTmdbTitle(identity)
            ]);
            if (embedUrls.length > 0) await cacheManager.set(cacheKey, embedUrls, officialTitle);
        }

        if (embedUrls.length === 0) return [];

        const rawStreams = (await Promise.allSettled(embedUrls.map((url) => this.#processSingleEmbed(url, officialTitle))))
            .filter((res) => res.status === 'fulfilled')
            .flatMap((res) => res.value);

        const rank = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, 'Unknown': 4 };
        return Array.from(new Map(rawStreams.map((stream) => [stream.url, stream])).values())
            .sort((a, b) => (rank[a.qualityRank] ?? 4) - (rank[b.qualityRank] ?? 4))
            .map(({ qualityRank, ...stream }) => stream);
    }
}

async function searchGuardaHD(meta, config) {
    return new GuardaHDScraper(config).getStreams(meta);
}

module.exports = { searchGuardaHD };
