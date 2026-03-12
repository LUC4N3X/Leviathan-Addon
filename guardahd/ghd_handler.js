const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// ====================== CONFIGURAZIONE NUCLEARE ======================
const CACHE_FILE = path.join(__dirname, '..', 'config', 'guardahd_cache.json');
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
const TMDB_API_KEY = "5bae8d11f2a7bc7a95c6d040a31d2163";

const MAX_CONCURRENT_EMBEDS = 8;
const REQUEST_TIMEOUT = 12000;
const BASE_URL = 'https://mostraguarda.stream';

const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': BASE_URL
};

// ====================== UTILITIES & SEMAFORO ======================
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

function buildMediaflowUrl(config, targetUrl, type = 'hls') {
    if (!config?.mediaflow?.url) return normalizeUrl(targetUrl);
    const mfp = config.mediaflow.url.replace(/\/$/, '');
    const encoded = encodeURIComponent(normalizeUrl(targetUrl));
    const pass = config.mediaflow.pass ? `&api_password=${encodeURIComponent(config.mediaflow.pass)}` : '';

    if (type === 'hls') return `${mfp}/hls?url=${encoded}${pass}&ext=.m3u8`;
    // Usa redirect_stream=true come richiesto dalla tua nuova logica
    return `${mfp}/extractor/video?host=Mixdrop${pass}&d=${encoded}&redirect_stream=true`;
}

// Generatore titoli dinamico (supporta grandezza file se disponibile)
function generateRichDescription(title, quality = 'Unknown', size = '') {
    let secondLine = `📺 ${quality}`;
    if (size) secondLine = `💾 ${size} • ` + secondLine;
    return `🎬 ${title}\n${secondLine} • 🇮🇹 ITA\n⚡ GuardaHD (WebStream)`;
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
            console.log(`[GHD Cache] ${Object.keys(this.cache).length} entries caricate`);
        } catch (e) {
            // File non esiste o corrotto
        }
        this.loaded = true;
    }

    async save() {
        try {
            const dir = path.dirname(this.file);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
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
            await this.save();
        }
        return null;
    }

    async set(key, embeds, title) {
        await this.init();
        this.cache[key] = { timestamp: Date.now(), embeds, title };
        await this.save();
    }
}
const cacheManager = new CacheManager();

// ====================== HOSTER REGISTRY (Plugin System) ======================
const HosterRegistry = {
    registry: [],
    
    register(name, regex, extractFn) {
        this.registry.push({ name, regex, extractFn });
        console.log(`[GHD] Hoster registrato → ${name}`);
    },

    getExtractor(url) {
        for (const host of this.registry) {
            if (host.regex.test(url)) return host;
        }
        return null;
    }
};

function detectAndUnpack(html) {
    const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*?\)\)/s);
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

// 1. Registra Mixdrop (Logica aggiornata: varianti regex + metadati /f/ + MediaFlow redirect)
HosterRegistry.register('MixDrop', /mixdrop|m1xdrop|m[i1]xdr[o0]p/i, async (url, config) => {
    if (!config?.mediaflow?.url) {
        console.log(`[GHD-DEBUG] ⚠️ Ignoro MixDrop: Proxy Mediaflow non configurato.`);
        return [];
    }

    let embedUrl = normalizeUrl(url).replace('/f/', '/e/');
    if (!/\/e\//.test(embedUrl)) embedUrl = embedUrl.replace('/f/', '/e/');

    let sizePart = '';
    let resPart = '';

    // Tenta di estrarre metadati dalla pagina /f/
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
            console.log(`[GHD-DEBUG] Mixdrop: Pagina /f/ non trovata, procedo con proxy MFP`);
        }
    } catch (e) {
        console.log(`[GHD-DEBUG] Mixdrop: Errore scraping pagina /f/`);
    }

    const finalUrl = buildMediaflowUrl(config, embedUrl, 'mixdrop');
    
    return [{ 
        url: finalUrl, 
        quality: resPart || '720p', 
        size: sizePart,
        name: 'MixDrop' 
    }];
});

// 2. Registra SuperVideo (Fix 403 Forbidden Anti-Bot)
HosterRegistry.register('SuperVideo', /supervideo/i, async (url, config) => {
    try {
        const urlObj = new URL(url);
        const id = url.split('/').pop().replace('.html', '');
        const embedUrl = `${urlObj.origin}/e/${id}`; 
        
        const customHeaders = {
            ...HEADERS,
            'Referer': urlObj.origin + '/',
            'Origin': urlObj.origin,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate'
        };

        const res = await axios.get(embedUrl, { headers: customHeaders, httpsAgent: insecureAgent, timeout: 8000 });
        const html = res.data;
        let m3u8 = '';

        const direct = html.match(/["'](https?:\/\/[^\s"']+\.m3u8[^"']*)["']/i) || html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
        if (direct?.[1]) m3u8 = direct[1];

        if (!m3u8) {
            const unpacked = detectAndUnpack(html);
            if (unpacked) {
                const m = unpacked.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/i);
                if (m) m3u8 = m[1];
            }
        }

        if (!m3u8 || !m3u8.includes('.m3u8')) {
            console.log(`[GHD-DEBUG] SuperVideo fallito: Nessun file .m3u8 trovato in ${embedUrl}`);
            return [];
        }
        
        m3u8 = m3u8.startsWith('http') ? m3u8 : 'https:' + m3u8;

        return [{ url: buildMediaflowUrl(config, m3u8, 'hls'), quality: '1080p', name: 'SuperVideo' }];
    } catch (e) {
        console.error(`[GHD-DEBUG] Errore SuperVideo estrazione: ${e.message}`);
        return [];
    }
});

// 3. Registra Dropload
HosterRegistry.register('Dropload', /dropload/i, async (url, config) => {
    try {
        let embedUrl = url;
        if (url.includes('/d/')) embedUrl = url.replace('/d/', '/e/');
        
        const urlObj = new URL(embedUrl);
        const customHeaders = {
            ...HEADERS,
            'Referer': urlObj.origin + '/',
            'Origin': urlObj.origin
        };

        const res = await axios.get(embedUrl, { headers: customHeaders, httpsAgent: insecureAgent, timeout: 8000 });
        const html = res.data;
        let m3u8 = '';

        const unpacked = detectAndUnpack(html);
        const sourceRegex = /sources:\s*\[\s*\{\s*file\s*:\s*["'](.*?)["']/i;

        if (unpacked) {
            const match = unpacked.match(sourceRegex);
            if (match) m3u8 = match[1];
        }

        if (!m3u8) {
            const match = html.match(sourceRegex);
            if (match) m3u8 = match[1];
        }

        if (!m3u8 || !m3u8.includes('.m3u8')) {
            console.log(`[GHD-DEBUG] Dropload fallito: Nessun file .m3u8 trovato in ${embedUrl}`);
            return [];
        }

        m3u8 = m3u8.startsWith('http') ? m3u8 : 'https:' + (m3u8.startsWith('//') ? m3u8.substring(2) : m3u8);
        return [{ url: buildMediaflowUrl(config, m3u8, 'hls'), quality: '1080p', name: 'Dropload' }];
    } catch (e) {
        console.error(`[GHD-DEBUG] Errore Dropload estrazione: ${e.message}`);
        return [];
    }
});

// ====================== CORE FUNZIONI ======================
async function get_tmdb_title(imdb_id, fallbackTitle) {
    try {
        const findUrl = `https://api.themoviedb.org/3/find/${imdb_id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const res = await axios.get(findUrl, { timeout: 5000 });
        const movie = res.data.movie_results?.[0];
        if (movie && movie.title) {
            const year = movie.release_date ? movie.release_date.substring(0, 4) : '';
            return year ? `${movie.title} (${year})` : movie.title;
        }
    } catch (e) {
        console.warn(`[GHD] Errore TMDB per ${imdb_id}`);
    }
    return fallbackTitle || "Film HD";
}

async function scrape_embed_urls(imdb_id) {
    try {
        const url = `${BASE_URL}/set-movie-a/${imdb_id}`;
        const res = await axios.get(url, { headers: HEADERS, httpsAgent: insecureAgent, timeout: REQUEST_TIMEOUT });
        
        const $ = cheerio.load(res.data);
        const embeds = [];

        $('li').each((i, el) => {
            let dataLink = $(el).attr('data-link');
            if (dataLink) {
                dataLink = normalizeUrl(dataLink);
                if (dataLink.includes('http') && !embeds.includes(dataLink)) {
                    embeds.push(dataLink);
                }
            }
        });

        console.log(`[GHD] Trovati ${embeds.length} raw embed per ${imdb_id}`);
        return embeds;
    } catch (e) {
        console.error(`[GHD] Errore scrape URL ${imdb_id}: ${e.message}`);
        return [];
    }
}

class GuardaHDScraper {
    constructor(config) {
        this.config = config;
        this.metrics = { startTime: Date.now(), embedsFound: 0, streamsExtracted: 0 };
    }

    async processSingleEmbed(embed_url, title) {
        await embedSemaphore.acquire();
        try {
            console.log(`[GHD-DEBUG] Analizzo URL estratto: ${embed_url}`);
            
            const hoster = HosterRegistry.getExtractor(embed_url);
            if (!hoster) {
                console.log(`[GHD-DEBUG] ❌ Nessun estrattore compatibile per l'host: ${embed_url}`);
                return [];
            }

            const rawStreams = await hoster.extractFn(embed_url, this.config);
            
            if (!rawStreams || rawStreams.length === 0) {
                console.log(`[GHD-DEBUG] ⚠️ L'estrattore ${hoster.name} ha fallito o restituito 0 stream per: ${embed_url}`);
                return [];
            }

            return rawStreams.map(s => ({
                name: `🦁 GHD\n⚡ ${hoster.name}`,
                title: generateRichDescription(title, s.quality, s.size),
                url: s.url,
                // ASSOLUTAMENTE NESSUN notWebReady: true QUI!
                behaviorHints: { bingeWatching: true } 
            }));
        } catch (e) {
            console.error(`[GHD-DEBUG] ❌ Errore critico in processamento ${embed_url}: ${e.message}`);
            return [];
        } finally {
            embedSemaphore.release();
        }
    }

    async getStreams(meta) {
        const imdb_id = meta.imdb_id;
        if (!imdb_id || meta.isSeries) return [];

        let embedUrls = [];
        let officialTitle = meta.title;
        
        const cached = await cacheManager.get(imdb_id);
        
        if (cached) {
            console.log(`[GHD] CACHE HIT 🔥 ${imdb_id}`);
            embedUrls = cached.embeds;
            officialTitle = cached.title || officialTitle;
        } else {
            console.log(`[GHD] CACHE MISS → scraping ${imdb_id}`);
            embedUrls = await scrape_embed_urls(imdb_id);
            if (embedUrls.length > 0) {
                officialTitle = await get_tmdb_title(imdb_id, officialTitle);
                await cacheManager.set(imdb_id, embedUrls, officialTitle);
            }
        }

        if (embedUrls.length === 0) return [];
        this.metrics.embedsFound = embedUrls.length;

        const tasks = embedUrls.map(url => this.processSingleEmbed(url, officialTitle));
        const results = await Promise.allSettled(tasks);
        
        let finalStreams = [];
        for (const res of results) {
            if (res.status === 'fulfilled' && res.value.length > 0) {
                finalStreams.push(...res.value);
            }
        }

        finalStreams = Array.from(new Map(finalStreams.map(s => [s.url, s])).values());
        
        this.metrics.streamsExtracted = finalStreams.length;
        const timeTaken = ((Date.now() - this.metrics.startTime) / 1000).toFixed(2);
        const successRate = this.metrics.embedsFound > 0 ? ((finalStreams.length / this.metrics.embedsFound) * 100).toFixed(1) : 0;

        console.log(`[GHD] ${finalStreams.length} stream | Tempo: ${timeTaken}s | Success: ${successRate}% 🔥`);
        return finalStreams;
    }
}

// ====================== EXPORT PER L'ADDON ======================
async function searchGuardaHD(meta, config) {
    const scraper = new GuardaHDScraper(config);
    return await scraper.getStreams(meta);
}

module.exports = { searchGuardaHD };
