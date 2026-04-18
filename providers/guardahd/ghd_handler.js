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
    Q_480: /480p|sd/i,
    SIZE: /([\d.,]+ ?[GM]B)/i,
    NOT_FOUND: /can't find the (file|video)|deleted|expired/i,
    MIXDROP: /mixdr(op|p)|m1xdrop/i,
    STREAMHG: /dhcplay|vibuxer/i,
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
const resolveAbsoluteUrl = (candidate, baseUrl) => {
    if (!candidate) return null;
    try {
        return new URL(candidate, baseUrl).toString();
    } catch {
        return null;
    }
};

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


const extractPackedScriptParams = (html) => {
    if (!html || typeof html !== 'string') return null;
    const match = html.match(/eval\(function\(p,a,c,k,e,?[rd]?\).*?\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('\|'\).*?\)\)/s);
    if (!match) return null;
    return {
        p: match[1],
        a: Number.parseInt(match[2], 10),
        c: Number.parseInt(match[3], 10),
        k: match[4].split('|')
    };
};

const unpackFromParams = (params) => {
    if (!params?.p || !Number.isInteger(params?.a) || !Number.isInteger(params?.c) || !Array.isArray(params?.k)) return null;
    try {
        let { p, a, c, k } = params;
        const decode = (n) => (n < a ? '' : decode(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
        while (c--) if (k[c]) p = p.replace(new RegExp(`\b${decode(c)}\b`, 'g'), k[c]);
        return p;
    } catch {
        return null;
    }
};

const getResponseFinalUrl = (response, fallbackUrl) => {
    return response?.request?.res?.responseUrl || response?.request?.responseURL || response?.config?.url || fallbackUrl;
};

const Extractors = {
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
    },

    streamhg: async (url) => {
        try {
            let normalized = normalizeUrl(url).replace(/&amp;/g, '&');
            if (!normalized) return [];

            const candidates = [normalized];
            try {
                const parsed = new URL(normalized);
                const idMatch = parsed.pathname.match(/\/e\/([^/?#]+)/i);
                if (idMatch && /(^|\.)dhcplay\.com$/i.test(parsed.hostname)) {
                    candidates.push(`https://vibuxer.com/e/${idMatch[1]}`);
                }
            } catch {}

            let unpacked = null;
            let finalUrl = normalized;
            for (const candidate of candidates) {
                const referer = (() => {
                    try {
                        return `${new URL(candidate).origin}/`;
                    } catch {
                        return 'https://dhcplay.com/';
                    }
                })();

                const res = await fetchSmart(candidate, { headers: { Referer: referer } });
                const html = typeof res?.data === 'string' ? res.data : '';
                if (!html) continue;

                const packed = extractPackedScriptParams(html);
                if (!packed) continue;

                const maybeUnpacked = unpackFromParams(packed);
                if (!maybeUnpacked) continue;

                unpacked = maybeUnpacked;
                finalUrl = getResponseFinalUrl(res, candidate);
                break;
            }

            if (!unpacked) return [];

            const hls2 = unpacked.match(/["']hls2["']\s*:\s*["']([^"']+)["']/i)?.[1];
            const hls4 = unpacked.match(/["']hls4["']\s*:\s*["']([^"']+)["']/i)?.[1];
            const file = unpacked.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i)?.[1];
            const streamUrl = resolveAbsoluteUrl(hls2 || hls4 || file, finalUrl);
            if (!streamUrl) return [];

            const origin = (() => {
                try {
                    return new URL(finalUrl).origin;
                } catch {
                    return 'https://dhcplay.com';
                }
            })();

            return [{
                url: streamUrl,
                quality: streamUrl.match(/(\d{3,4}p)/i)?.[1] || '1080p',
                size: 'N/A',
                name: 'StreamHG',
                headers: {
                    Referer: `${origin}/`,
                    Origin: origin,
                    'User-Agent': getRandomUserAgent()
                }
            }];
        } catch {
            return [];
        }
    }
};


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
                const lower = link.toLowerCase();
                const key = REGEX.MIXDROP.test(lower)
                    ? 'mixdrop'
                    : REGEX.STREAMHG.test(lower)
                        ? 'streamhg'
                        : link;
                if (!embedDict.has(key)) embedDict.set(key, link);
            };

            $('li[data-link]').each((_, el) => registerLink($(el).attr('data-link')));
            $('iframe[src]').each((_, el) => registerLink($(el).attr('src')));
            $('a[href], source[src]').each((_, el) => registerLink($(el).attr('href') || $(el).attr('src')));

            const directMatches = String(res.data || '').match(/https?:\/\/(?:www\.)?(?:mixdrop|m1xdrop|dhcplay|vibuxer)[^"'<\s]+/ig) || [];
            directMatches.forEach(registerLink);

            return Array.from(embedDict.values());
        } catch {
            return [];
        }
    }

    async #processSingleEmbed(url, title) {
        await embedSemaphore.acquire();
        try {
            const lowerUrl = url.toLowerCase();
            const extractor = REGEX.MIXDROP.test(lowerUrl)
                ? Extractors.mixdrop
                : REGEX.STREAMHG.test(lowerUrl)
                    ? Extractors.streamhg
                    : null;
            if (!extractor) return [];

            const streams = await extractor(url, this.#config);
            return streams.map((s) => {
                const q = parseQuality(s.quality || url);
                return {
                    name: `🦁 GHD
⚡ ${s.name}`,
                    title: generateRichDescription(title, q, s.size, s.name),
                    url: s.url,
                    qualityRank: q,
                    extractor: s.name,
                    behaviorHints: {
                        bingeWatching: true,
                        extractor: s.name,
                        ...(s.headers && { proxyHeaders: { request: s.headers } })
                    }
                };
            });
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
