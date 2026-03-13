const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// ====================== CONFIGURAZIONE NUCLEARE ======================
const CACHE_FILE = path.join(__dirname, '..', 'config', 'guardahd_cache.json');
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 ore
const TMDB_API_KEY = "5bae8d11f2a7bc7a95c6d040a31d2163";

const MAX_CONCURRENT_EMBEDS = 10;
const REQUEST_TIMEOUT = 12000;
const BASE_URL = 'https://mostraguarda.stream';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': BASE_URL
};

// ====================== REGEX DA SCRIPT PYTHON ======================
const RE_4K = /4k|2160p|uhd/i;
const RE_1080 = /1080p|fullhd|fhd/i;
const RE_720 = /720p|hd/i;
const RE_480 = /480p|sd/i;
const RE_SIZE = /([\d.,]+ ?[GM]B)/i;
const RE_NOT_FOUND = /can't find the (file|video)/i;
const RE_MIXDROP = /mixdr(op|p)|m1xdrop/i;

// ====================== UTILITIES ======================
class AsyncSemaphore {
    constructor(max) {
        this.max = max;
        this.active = 0;
        this.queue = [];
    }
    async acquire() {
        if (this.active < this.max) {
            this.active++;
            return;
        }
        return new Promise(resolve => this.queue.push(resolve));
    }
    release() {
        this.active--;
        if (this.queue.length > 0) {
            this.active++;
            const resolve = this.queue.shift();
            resolve();
        }
    }
}
const embedSemaphore = new AsyncSemaphore(MAX_CONCURRENT_EMBEDS);

function normalizeUrl(url) {
    if (!url) return '';
    return url.startsWith('//') ? 'https:' + url : url;
}

function parseQuality(text) {
    if (!text) return "Unknown";
    const t = text.toLowerCase();
    if (RE_4K.test(t)) return "4K";
    if (RE_1080.test(t)) return "1080p";
    if (RE_720.test(t)) return "720p";
    if (RE_480.test(t)) return "480p";
    return "Unknown";
}

function buildMediaflowUrl(config, targetUrl, type = 'hls') {
    if (!config?.mediaflow?.url) return normalizeUrl(targetUrl);
    const mfp = config.mediaflow.url.replace(/\/$/, '');
    const encoded = encodeURIComponent(normalizeUrl(targetUrl));
    const pass = config.mediaflow.pass ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';

    if (type === 'hls') return `${mfp}/hls?url=${encoded}${pass}&ext=.m3u8`;
    return `${mfp}/extractor/video?host=Mixdrop${pass}&d=${encoded}&redirect_stream=true`;
}

// INIEZIONE MAGICA: Aggiunge il nome dell'hoster (es. [SuperVideo]) nascosto nel titolo per farlo leggere al formatter
function generateRichDescription(title, quality = 'Unknown', size = 'N/A', hoster = '') {
    let secondLine = `📺 ${quality}`;
    if (size && size !== 'N/A') secondLine = `💾 ${size} • ` + secondLine;
    let hosterTag = hoster ? ` [${hoster}]` : '';
    return `🎬 ${title}${hosterTag}\n${secondLine} • 🇮🇹 ITA\n⚡ GuardaHD`;
}

// ====================== CACHE MANAGER ======================
class CacheManager {
    constructor() {
        this.file = CACHE_FILE;
        this.cache = {};
        this.loaded = false;
    }

    async init() {
        if (this.loaded) return;
        try {
            const data = await fs.readFile(this.file, 'utf8');
            const raw = JSON.parse(data);
            const now = Date.now();
            for (const key in raw) {
                if (now - raw[key].timestamp < CACHE_TTL) {
                    this.cache[key] = raw[key];
                }
            }
        } catch (e) {}
        this.loaded = true;
    }

    async save() {
        try {
            const dir = path.dirname(this.file);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(this.file, JSON.stringify(this.cache), 'utf8');
        } catch (e) {
            console.warn(`[GHD Cache] Errore salvataggio: ${e.message}`);
        }
    }

    async get(key) {
        await this.init();
        const entry = this.cache[key];
        if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry;
        if (entry) {
            delete this.cache[key];
            this.save();
        }
        return null;
    }

    async set(key, embeds, title) {
        await this.init();
        this.cache[key] = { timestamp: Date.now(), embeds, title };
        this.save();
    }
}
const cacheManager = new CacheManager();

// ====================== ESTRATTORI ======================
function detectAndUnpack(html) {
    const packRegex = /eval\(function\([^)]+\).*?split\('\|'\).*?\)\)/s;
    const packedMatch = html.match(packRegex);
    if (!packedMatch) return null;
    try {
        const script = packedMatch[0];
        const params = script.match(/}\('(.+?)',(\d+),(\d+),'(.+?)'\.split\('\|'\)/);
        if (!params) return null;
        let p = params[1], a = parseInt(params[2]), c = parseInt(params[3]), k = params[4].split('|');
        const decode = (c) => (c < a ? '' : decode(Math.floor(c / a))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
        while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + decode(c) + '\\b', 'g'), k[c]);
        return p;
    } catch { return null; }
}

const Extractors = {
    supervideo: async (url, config) => {
        try {
            const urlObj = new URL(url);
            let id = urlObj.pathname.split('/').pop().replace('.html', '').replace('embed-', '').replace('/k/', '/');
            const targetEmbedUrl = `${urlObj.origin}/e/${id}`;
            
            const workerUrl = `https://still-mode-fd28.quelladiprova96.workers.dev/?url=${encodeURIComponent(targetEmbedUrl)}`;
            const customHeaders = {
                ...HEADERS,
                'Referer': urlObj.origin + '/',
                'Origin': urlObj.origin,
                'Sec-Fetch-Dest': 'iframe',
                'Sec-Fetch-Mode': 'navigate'
            };

            let res = await axios.get(workerUrl, { headers: customHeaders, httpsAgent: insecureAgent, timeout: REQUEST_TIMEOUT, validateStatus: () => true });
            let html = res.data;

            if (!html || typeof html !== 'string') return [];

            if (html.includes('This video can be watched as embed only')) {
                const altUrl = `${urlObj.origin}/e${urlObj.pathname}`;
                const altWorkerUrl = `https://still-mode-fd28.quelladiprova96.workers.dev/?url=${encodeURIComponent(altUrl)}`;
                res = await axios.get(altWorkerUrl, { headers: customHeaders, httpsAgent: insecureAgent, timeout: REQUEST_TIMEOUT, validateStatus: () => true });
                html = res.data;
            }

            if (/'The file was deleted|The file expired|Video is processing/i.test(html)) return [];

            let m3u8 = '';
            let size = 'N/A';

            const sizeMatch = html.match(/\d{3,}x\d{3,},\s*([\d.]+ ?[GM]B)/i);
            if (sizeMatch) size = sizeMatch[1].replace(',', '');

            const unpacked = detectAndUnpack(html);
            const sourceRegex = /sources:\s*\[\s*\{\s*file\s*:\s*["'](.*?)["']/i;
            const altRegex = /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i;

            if (unpacked) {
                const match = unpacked.match(sourceRegex) || unpacked.match(altRegex);
                if (match) m3u8 = match[1];
            }

            if (!m3u8) {
                const match = html.match(sourceRegex) || html.match(altRegex);
                if (match) m3u8 = match[1];
            }

            if (!m3u8 && html.includes('.m3u8')) {
                const bruteForce = html.match(/(https?:\/\/[a-zA-Z0-9_.\-\/]+\.m3u8[^\s"']*)/i);
                if (bruteForce) m3u8 = bruteForce[1];
            }

            if (!m3u8 || !m3u8.includes('.m3u8')) return [];
            
            m3u8 = m3u8.startsWith('http') ? m3u8 : 'https:' + m3u8;

            return [{ 
                url: m3u8, 
                quality: '1080p', 
                size: size,
                name: 'SuperVideo',
                headers: {
                    "Referer": "https://supervideo.cc/",
                    "Origin": "https://supervideo.cc/"
                }
            }];
        } catch (e) {
            return [];
        }
    },

    mixdrop: async (url, config) => {
        if (!config?.mediaflow?.url) return [];

        let embedUrl = normalizeUrl(url).replace('/f/', '/e/');
        if (!/\/e\//.test(embedUrl)) embedUrl = embedUrl.replace('/f/', '/e/');

        let sizePart = 'N/A';
        let resPart = '';

        try {
            const fileUrl = embedUrl.replace('/e/', '/f/');
            const res = await axios.get(fileUrl, { headers: HEADERS, httpsAgent: insecureAgent, timeout: 5000, validateStatus: () => true });
            const html = res.data;

            if (html && !/can't find the (file|video)/i.test(html)) {
                const sizeMatch = html.match(/([\d.,]+ ?[GM]B)/i);
                if (sizeMatch) sizePart = sizeMatch[1];
                const resMatch = html.match(/(\b[1-9]\d{2,3}p\b)/i);
                if (resMatch) resPart = resMatch[1].toLowerCase();
            } else {
                return []; 
            }
        } catch (e) {}

        const finalUrl = buildMediaflowUrl(config, embedUrl, 'mixdrop');
        return [{ url: finalUrl, quality: resPart || 'Unknown', size: sizePart, name: 'MixDrop' }];
    }
};

// ====================== CORE FUNZIONI ======================
async function getTmdbTitle(imdb_id) {
    const defaultTitle = "Film HD";
    let retries = 3;
    while (retries > 0) {
        try {
            const findUrl = `https://api.themoviedb.org/3/find/${imdb_id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const res = await axios.get(findUrl, { timeout: 5000 });
            const movie = res.data.movie_results?.[0];
            if (movie && movie.title) {
                const year = movie.release_date ? movie.release_date.substring(0, 4) : '';
                return year ? `${movie.title} (${year})` : movie.title;
            }
            return defaultTitle;
        } catch (e) {
            retries--;
            if (retries === 0) return defaultTitle;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return defaultTitle;
}

async function scrapeEmbedUrls(imdb_id) {
    try {
        const url = `${BASE_URL}/set-movie-a/${imdb_id}`;
        const res = await axios.get(url, { headers: HEADERS, httpsAgent: insecureAgent, timeout: REQUEST_TIMEOUT });
        const $ = cheerio.load(res.data);
        const embedDict = {};

        $('li').each((i, el) => {
            let dataLink = $(el).attr('data-link');
            if (!dataLink) return;
            dataLink = normalizeUrl(dataLink);
            if (dataLink.includes('http')) {
                const dlLower = dataLink.toLowerCase();
                const hostKey = dlLower.includes('supervideo') ? 'supervideo' : 
                                RE_MIXDROP.test(dlLower) ? 'mixdrop' : dataLink;
                if (!embedDict[hostKey]) {
                    embedDict[hostKey] = dataLink;
                }
            }
        });
        return Object.values(embedDict);
    } catch (e) { return []; }
}

class GuardaHDScraper {
    constructor(config) {
        this.config = config;
        this.metrics = { startTime: Date.now(), embedsFound: 0, streamsExtracted: 0 };
    }

    async processSingleEmbed(embed_url, title) {
        await embedSemaphore.acquire();
        try {
            const lowerUrl = embed_url.toLowerCase();
            let extractor = null;
            
            if (lowerUrl.includes('supervideo')) extractor = Extractors.supervideo;
            else if (RE_MIXDROP.test(lowerUrl)) extractor = Extractors.mixdrop;

            if (!extractor) return [];

            const rawStreams = await extractor(embed_url, this.config);
            if (!rawStreams || rawStreams.length === 0) return [];

            return rawStreams.map(s => {
                const parsedQuality = parseQuality(s.quality || embed_url);
                const hints = { bingeWatching: true };
                if (s.headers && Object.keys(s.headers).length > 0) {
                    hints.proxyHeaders = { request: s.headers };
                }
                return {
                    name: `🦁 GHD\n⚡ ${s.name}`,
                    // PASSIAMO s.name a generateRichDescription PER IL CONTRABBANDO
                    title: generateRichDescription(title, parsedQuality, s.size, s.name),
                    url: s.url,
                    qualityRank: parsedQuality, 
                    behaviorHints: hints
                };
            });
        } catch (e) {
            return [];
        } finally {
            embedSemaphore.release();
        }
    }

    dedupAndSort(streams) {
        const rank = { "4K": 0, "1080p": 1, "720p": 2, "480p": 3, "Unknown": 4 };
        const uniqueStreamsMap = new Map();
        for (const s of streams) {
            if (!uniqueStreamsMap.has(s.url)) uniqueStreamsMap.set(s.url, s);
        }
        const uniqueStreams = Array.from(uniqueStreamsMap.values());
        uniqueStreams.sort((a, b) => (rank[a.qualityRank] || 4) - (rank[b.qualityRank] || 4));
        return uniqueStreams.map(s => {
            const { qualityRank, ...cleanStream } = s;
            return cleanStream;
        });
    }

    async getStreams(meta) {
        const imdb_id = meta.imdb_id;
        if (!imdb_id || meta.isSeries) return [];

        let embedUrls = [];
        let officialTitle = meta.title;
        
        const cached = await cacheManager.get(imdb_id);
        if (cached) {
            embedUrls = cached.embeds;
            officialTitle = cached.title || officialTitle;
        } else {
            const [urls, title] = await Promise.all([scrapeEmbedUrls(imdb_id), getTmdbTitle(imdb_id)]);
            embedUrls = urls;
            officialTitle = title;
            if (embedUrls.length > 0) await cacheManager.set(imdb_id, embedUrls, officialTitle);
        }

        if (embedUrls.length === 0) return [];
        this.metrics.embedsFound = embedUrls.length;

        const tasks = embedUrls.map(url => this.processSingleEmbed(url, officialTitle));
        const results = await Promise.allSettled(tasks);
        
        let rawStreams = [];
        for (const res of results) {
            if (res.status === 'fulfilled' && res.value.length > 0) rawStreams.push(...res.value);
        }

        const finalStreams = this.dedupAndSort(rawStreams);
        return finalStreams;
    }
}

async function searchGuardaHD(meta, config) {
    const scraper = new GuardaHDScraper(config);
    return await scraper.getStreams(meta);
}

module.exports = { searchGuardaHD };
