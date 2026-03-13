const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

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
        BASE_URL: 'https://mostraguarda.stream',
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
    Q_480: /480p|sd/i,
    SIZE: /([\d.,]+ ?[GM]B)/i,
    NOT_FOUND: /can't find the (file|video)|deleted|expired/i,
    MIXDROP: /mixdr(op|p)|m1xdrop/i,
    PACKED_SCRIPT: /eval\(function\([^)]+\).*?split\('\|'\).*?\)\)/s,
    M3U8: /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i
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

const buildMediaflowUrl = (config, targetUrl, type = 'hls') => {
    if (!config?.mediaflow?.url) return normalizeUrl(targetUrl);
    const mfp = config.mediaflow.url.replace(/\/$/, '');
    const encoded = encodeURIComponent(normalizeUrl(targetUrl));
    const pass = config.mediaflow.pass ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';
    return type === 'hls' 
        ? `${mfp}/hls?url=${encoded}${pass}&ext=.m3u8`
        : `${mfp}/extractor/video?host=Mixdrop${pass}&d=${encoded}&redirect_stream=true`;
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

const unpackScript = (html) => {
    const packedMatch = html.match(REGEX.PACKED_SCRIPT);
    if (!packedMatch) return null;
    try {
        let [_, p, a, c, kRaw] = packedMatch[0].match(/}\('(.+?)',(\d+),(\d+),'(.+?)'\.split\('\|'\)/);
        a = parseInt(a); c = parseInt(c); const k = kRaw.split('|');
        const decode = (c) => (c < a ? '' : decode(Math.floor(c / a))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
        while (c--) if (k[c]) p = p.replace(new RegExp(`\\b${decode(c)}\\b`, 'g'), k[c]);
        return p;
    } catch { return null; }
};

const Extractors = {
    supervideo: async (url) => {
        try {
            const urlObj = new URL(url);
            const id = urlObj.pathname.split('/').pop().replace(/\.html|embed-|\/k\//gi, '');
            const targetUrl = `${urlObj.origin}/e/${id}`;
            const customHeaders = { 'Referer': `${urlObj.origin}/`, 'Origin': urlObj.origin };

            const fetchWorker = async (target) => {
                const workerUrl = `https://still-mode-fd28.quelladiprova96.workers.dev/?url=${encodeURIComponent(target)}`;
                const res = await fetchSmart(workerUrl, { headers: customHeaders });
                return res.data;
            };

            let html = await fetchWorker(targetUrl);
            if (!html || typeof html !== 'string') return [];

            if (html.includes('watched as embed only')) html = await fetchWorker(`${urlObj.origin}/e${urlObj.pathname}`);
            if (REGEX.NOT_FOUND.test(html)) return [];

            const size = html.match(/\d{3,}x\d{3,},\s*([\d.]+ ?[GM]B)/i)?.[1]?.replace(',', '') || 'N/A';
            const m3u8 = unpackScript(html)?.match(REGEX.M3U8)?.[1] || html.match(REGEX.M3U8)?.[1];

            if (!m3u8) return [];

            return [{ 
                url: normalizeUrl(m3u8), quality: '1080p', size, name: 'SuperVideo',
                headers: { "Referer": "https://supervideo.cc/", "Origin": "https://supervideo.cc/" }
            }];
        } catch { return []; }
    },

    mixdrop: async (url, config) => {
        if (!config?.mediaflow?.url) return [];
        const embedUrl = normalizeUrl(url).replace('/f/', '/e/');
        let sizePart = 'N/A', resPart = 'Unknown';

        try {
            const res = await fetchSmart(embedUrl.replace('/e/', '/f/'));
            if (res.data && !REGEX.NOT_FOUND.test(res.data)) {
                sizePart = res.data.match(REGEX.SIZE)?.[1] || 'N/A';
                resPart = res.data.match(/(\b[1-9]\d{2,3}p\b)/i)?.[1]?.toLowerCase() || 'Unknown';
            } else return [];
        } catch {}

        return [{ 
            url: buildMediaflowUrl(config, embedUrl, 'mixdrop'), 
            quality: resPart, size: sizePart, name: 'MixDrop' 
        }];
    }
};

class GuardaHDScraper {
    #config;
    
    constructor(config) { this.#config = config; }

    async #getTmdbTitle(imdb_id) {
        try {
            const res = await fetchSmart(`https://api.themoviedb.org/3/find/${imdb_id}?api_key=${CONFIG.TMDB_API_KEY}&external_source=imdb_id`);
            const movie = res.data.movie_results?.[0];
            return movie?.title ? (movie.release_date ? `${movie.title} (${movie.release_date.substring(0, 4)})` : movie.title) : "Film HD";
        } catch { return "Film HD"; }
    }

    async #scrapeEmbedUrls(imdb_id) {
        try {
            const res = await fetchSmart(`${CONFIG.SCRAPER.BASE_URL}/set-movie-a/${imdb_id}`);
            const $ = cheerio.load(res.data);
            const embedDict = new Map(); 

            $('li[data-link]').each((_, el) => {
                const link = normalizeUrl($(el).attr('data-link'));
                if (!link.startsWith('http')) return;
                const lower = link.toLowerCase();
                const key = lower.includes('supervideo') ? 'supervideo' : REGEX.MIXDROP.test(lower) ? 'mixdrop' : link;
                if (!embedDict.has(key)) embedDict.set(key, link);
            });
            return Array.from(embedDict.values());
        } catch { return []; }
    }

    async #processSingleEmbed(url, title) {
        await embedSemaphore.acquire();
        try {
            const lowerUrl = url.toLowerCase();
            const extractor = lowerUrl.includes('supervideo') ? Extractors.supervideo : REGEX.MIXDROP.test(lowerUrl) ? Extractors.mixdrop : null;
            if (!extractor) return [];

            const streams = await extractor(url, this.#config);
            return streams.map(s => {
                const q = parseQuality(s.quality || url);
                return {
                    name: `🦁 GHD\n⚡ ${s.name}`,
                    title: generateRichDescription(title, q, s.size, s.name),
                    url: s.url,
                    qualityRank: q,
                    behaviorHints: { bingeWatching: true, ...(s.headers && { proxyHeaders: { request: s.headers } }) }
                };
            });
        } catch { return []; } 
        finally { embedSemaphore.release(); }
    }

    async getStreams(meta) {
        if (!meta?.imdb_id || meta.isSeries) return [];

        const { imdb_id, title: metaTitle } = meta;
        let embedUrls = [], officialTitle = metaTitle;
        
        const { data: cached, isStale } = await cacheManager.get(imdb_id);
        
        if (cached) {
            embedUrls = cached.embeds;
            officialTitle = cached.title || officialTitle;
            
            if (isStale) {
                Promise.all([this.#scrapeEmbedUrls(imdb_id), this.#getTmdbTitle(imdb_id)])
                    .then(([urls, title]) => {
                        if (urls.length > 0) cacheManager.set(imdb_id, urls, title);
                    }).catch(() => {});
            }
        } else {
            [embedUrls, officialTitle] = await Promise.all([this.#scrapeEmbedUrls(imdb_id), this.#getTmdbTitle(imdb_id)]);
            if (embedUrls.length > 0) await cacheManager.set(imdb_id, embedUrls, officialTitle);
        }

        if (embedUrls.length === 0) return [];

        const rawStreams = (await Promise.allSettled(embedUrls.map(url => this.#processSingleEmbed(url, officialTitle))))
            .filter(res => res.status === 'fulfilled').flatMap(res => res.value);

        const rank = { "4K": 0, "1080p": 1, "720p": 2, "480p": 3, "Unknown": 4 };
        return Array.from(new Map(rawStreams.map(s => [s.url, s])).values())
            .sort((a, b) => (rank[a.qualityRank] ?? 4) - (rank[b.qualityRank] ?? 4))
            .map(({ qualityRank, ...s }) => s);
    }
}

async function searchGuardaHD(meta, config) {
    return new GuardaHDScraper(config).getStreams(meta);
}

module.exports = { searchGuardaHD };
