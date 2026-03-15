const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const cloudscraper = require("cloudscraper");
const pLimit = require("p-limit");
const he = require("he"); 

const BROWSER_PROFILES = [
    {
        name: "Safari macOS",
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
    },
    {
        name: "Safari iOS (iPhone)",
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
    },
    {
        name: "Safari iPadOS",
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
    }
];

const CONFIG = {
    TIMEOUT: 12000,      
    TIMEOUT_API: 8000,   
    MAX_CONCURRENCY: 25, 
    KNABEN_API: "https://api.knaben.org/v1",
    TRACKERS: [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.demonoid.ch:6969/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://tracker.therarbg.to:6969/announce",
        "udp://tracker.doko.moe:6969/announce",
        "udp://opentracker.i2p.rocks:6969/announce",
        "udp://exodus.desync.com:6969/announce", 
        "udp://tracker.moeking.me:6969/announce"
    ],
    HTTPS_AGENT_OPTIONS: { rejectUnauthorized: false, keepAlive: true } 
};

const httpsAgent = new https.Agent(CONFIG.HTTPS_AGENT_OPTIONS);

const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout of ${ms}ms exceeded`)), ms))
]);

function clean(title) {
    if (!title) return "";
    let decoded = he.decode(title);
    return decoded
        .replace(/[:"'’]/g, "")
        .replace(/[^a-zA-Z0-9\s\-.\[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function parseSize(sizeStr) {
    if (!sizeStr) return 0;
    const match = sizeStr.toString().match(/([\d.,]+)\s*(TB|GB|MB|KB|GiB|MiB|KiB|B)/i);
    if (!match) return 0;
    let val = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    
    const mult = { 
        TB: 1099511627776, TiB: 1099511627776,
        GB: 1073741824, GiB: 1073741824,
        MB: 1048576, MiB: 1048576,
        KB: 1024, KiB: 1024, B: 1 
    };
    return Math.round(val * (mult[unit] || 1));
}

function bytesToSize(bytes) {
    if (!bytes || isNaN(bytes)) return "?? GB";
    return (bytes / 1073741824).toFixed(2) + " GB";
}

function isValidResult(name, allowEng = false) {
    if (!name) return false;
    const nameUpper = name.toUpperCase();
    
    const ITA_REGEX = /\b(ITA(LIANO)?|MULTI|DUAL|MD|SUB\.?ITA|SUB-?ITA|ITALUB|AC3\.?ITA|DTS\.?ITA|AUDIO\.?ITA|ITA\.?AC3|ITA\.?HD|BDMUX|DVDRIP\.?ITA|STAGIONE|EPISODIO|SERIE|COMPLETA|CiNEFiLE|iDN_CreW|CORSARO|SPEEDVIDEO|WMS|TRIDIM|LUX|MUX)\b/i;
    
    if (ITA_REGEX.test(nameUpper)) return true;
    if (!allowEng) return false;
    
    const FOREIGN_REGEX = /\b(FRENCH|GERMAN|SPANISH|LATINO|RUSSIAN|HINDI|TAMIL|TELUGU|KOREAN)\b/i;
    if (FOREIGN_REGEX.test(nameUpper) && !/MULTI/i.test(nameUpper)) return false;
    
    return true; 
}

function checkYear(name, year, type) {
    if (!year || type === 'tv' || type === 'series') return true;
    const y = parseInt(year);
    return name.includes(String(y)) || name.includes(String(y - 1)) || name.includes(String(y + 1));
}

function isCorrectFormat(name, reqSeason, reqEpisode) {
    if (!reqSeason && !reqEpisode) return true;
    const sMatch = name.match(/S(\d{1,2})/i);
    const eMatch = name.match(/E(\d{1,3})/i);
    
    if (reqSeason && sMatch && parseInt(sMatch[1]) !== reqSeason) return false;
    if (reqEpisode && eMatch && parseInt(eMatch[1]) !== reqEpisode) return false;
    return true;
}

function getStealthHeaders(url) {
    const profile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
    const urlObj = new URL(url);
    return {
        profileName: profile.name,
        headers: {
            'User-Agent': profile.userAgent,
            'Referer': urlObj.origin + '/',
            'Origin': urlObj.origin,
            ...profile.headers 
        }
    };
}

async function requestHtml(url, config = {}, retries = 1) {
    const { headers: stealthHeaders } = getStealthHeaders(url);
    const finalHeaders = { ...stealthHeaders, ...config.headers };
    
    for (let i = 0; i <= retries; i++) {
        try {
            const response = await axios({
                url,
                method: config.method || 'GET',
                headers: finalHeaders,
                data: config.data,
                httpsAgent,
                timeout: config.timeout || CONFIG.TIMEOUT,
                validateStatus: s => s < 500
            });
            
            if (typeof response.data === 'string' && (response.data.includes("Cloudflare") || response.data.includes("Verify you are human"))) {
                throw new Error("CF");
            }
            return response;
        } catch (err) {
            if (config.method !== 'POST') {
                try {
                    const html = await cloudscraper.get(url, { headers: finalHeaders });
                    return { data: html };
                } catch (e) { 
                    if (i === retries) return { data: "" };
                }
            } else if (i === retries) {
                return { data: "" };
            }
        }
    }
}

async function searchCorsaro(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[IlCorsaroNero] Avvio ricerca per: ${title}...`);
    try {
        const url = `https://ilcorsaronero.link/search?q=${encodeURIComponent(clean(title))}`;
        const { data } = await requestHtml(url);
        if (!data || data.includes("Cloudflare")) return [];
        
        const $ = cheerio.load(data);
        let candidates = [];

        $('table tr, tbody tr').each((i, row) => {
            const $row = $(row);
            const linkTag = $row.find('a[href*="/torrent/"]').first();
            if (!linkTag.length) return;
            
            const name = linkTag.text().trim();
            const href = linkTag.attr('href');
            
            const seedersText = $row.find('.green, font[color="#008000"], td.text-green-500').text().trim();
            const seeders = parseInt(seedersText.replace(/,/g, '')) || 0;
            
            let sizeStr = "";
            $row.find('td.tabular-nums').each((idx, td) => {
                const text = $(td).text().trim();
                if (/GiB|MiB|KiB|TiB|GB|MB|KB|TB/i.test(text)) {
                    sizeStr = text.replace('GiB', 'GB').replace('MiB', 'MB').replace('KiB', 'KB').replace('TiB', 'TB');
                }
            });
            if (!sizeStr) sizeStr = $row.find('td').eq(4).text().trim();

            if (isValidResult(name, options.allowEng) && checkYear(name, year, type) && isCorrectFormat(name, reqSeason, reqEpisode)) {
                candidates.push({ name, url: href.startsWith('http') ? href : `https://ilcorsaronero.link${href}`, sizeStr, seeders });
            }
        });

        const limit = pLimit(CONFIG.MAX_CONCURRENCY);
        const results = await Promise.all(candidates.map(c => limit(async () => {
            try {
                const html = (await requestHtml(c.url, { timeout: 4000 })).data;
                let magnet = cheerio.load(html)('a[href^="magnet:"]').attr('href') || html.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]{40}/i)?.[0];
                if (magnet) return { title: c.name, magnet, size: c.sizeStr, sizeBytes: parseSize(c.sizeStr), seeders: c.seeders, source: "Corsaro" };
            } catch {}
            return null;
        })));
        const final = results.filter(Boolean);
        console.log(`[IlCorsaroNero] Trovati ${final.length} risultati validi.`);
        return final;
    } catch { return []; }
}

async function searchKnaben(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[Knaben] Avvio ricerca per: ${title}...`);
    try {
        let query = clean(title);
        if (!options.allowEng && !query.toUpperCase().includes("ITA")) query += " ITA";

        const categories = [];
        if (type === 'movie') {
            categories.push(3000000); 
        } else if (type === 'series' || type === 'tv') {
            categories.push(2000000); // TV
        } else if (type === 'anime') {
            categories.push(6000000, 2000000); 
        }

        const payload = { 
            "query": query, 
            "search_type": "100%", 
            "search_field": "title", 
            "size": 300,           
            "from": 0,
            "hide_unsafe": false,  
            "hide_xxx": true 
        };

        if (categories.length > 0) {
            payload.categories = categories;
        }

        const { data } = await requestHtml(CONFIG.KNABEN_API, { method: 'POST', data: payload, timeout: CONFIG.TIMEOUT_API });

        if (!data?.hits) {
            console.log(`[Knaben] Nessun risultato.`);
            return [];
        }
        
        const KNABEN_BLACKLISTED_CATEGORIES = [6006000, 6007000, 6005000]; 

        const results = data.hits.map(hit => {
            if (!hit.title) return null;

            if (hit.categoryId && KNABEN_BLACKLISTED_CATEGORIES.some(cat => hit.categoryId.includes(cat))) {
                return null;
            }

            let hash = hit.hash?.toLowerCase() || (hit.magnetUrl ? hit.magnetUrl.match(/btih:([a-fA-F0-9]{40})/i)?.[1]?.toLowerCase() : null);
            let magnetLink = hit.magnetUrl;

            if (!magnetLink && hash) {
                magnetLink = `magnet:?xt=urn:btih:${hash}`;
            }

            if (!magnetLink) return null;

            if (isValidResult(hit.title, options.allowEng) && checkYear(hit.title, year, type) && isCorrectFormat(hit.title, reqSeason, reqEpisode)) {
                const sizeInBytes = hit.bytes || 0;
                return { 
                    title: hit.title, 
                    magnet: magnetLink, 
                    size: bytesToSize(sizeInBytes), 
                    sizeBytes: parseInt(sizeInBytes), 
                    seeders: parseInt(hit.seeders) || 0, 
                    source: "Knaben" 
                };
            }
            return null;
        }).filter(Boolean);
        
        console.log(`[Knaben] Trovati ${results.length} risultati validi.`);
        return results;
    } catch (e) { 
        console.log(`[Knaben] Errore durante la ricerca: ${e.message}`);
        return []; 
    }
}

async function searchTPB(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[TPB (ApiBay)] Avvio ricerca per: ${title}...`);
    try {
        let q = clean(title);
        if (!options.allowEng && !q.toUpperCase().includes("ITA")) q += " ITA";
        
        const { data } = await axios.get(`https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=${type==='tv'?0:200}`, { timeout: CONFIG.TIMEOUT_API });
        if (!Array.isArray(data) || data[0]?.id === '0') return [];

        const results = data.map(i => {
            if (isValidResult(i.name, options.allowEng) && checkYear(i.name, year, type) && isCorrectFormat(i.name, reqSeason, reqEpisode)) {
                return { title: i.name, magnet: `magnet:?xt=urn:btih:${i.info_hash}&dn=${encodeURIComponent(i.name)}`, size: bytesToSize(i.size), sizeBytes: parseInt(i.size), seeders: parseInt(i.seeders) || 0, source: "TPB" };
            }
            return null;
        }).filter(Boolean);
        console.log(`[TPB (ApiBay)] Trovati ${results.length} risultati validi.`);
        return results;
    } catch { return []; }
}

async function searchTPBMirror(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[TPB Mirror] Avvio ricerca per: ${title}...`);
    try {
        let query = clean(title) + (options.allowEng ? "" : " ITA");
        const url = `https://thepibay.site/search/${encodeURIComponent(query)}/1/99/0`;
        const { data } = await requestHtml(url, { timeout: 6000 });
        if (!data) return [];

        const $ = cheerio.load(data);
        const results = [];

        $('table#searchResult tr').each((i, row) => {
            const titleEl = $(row).find('.detName a.detLink');
            if (!titleEl.length) return;
            const name = titleEl.text().trim();
            const magnet = $(row).find('a[href^="magnet:"]').attr('href');
            if (!magnet) return;

            let sizeBytes = 0;
            const sizeMatch = $(row).find('.detDesc').text().match(/Size\s+([\d.,]+\s*[A-Za-z]+)/i);
            if (sizeMatch) sizeBytes = parseSize(sizeMatch[1]);
            const tds = $(row).find('td[align="right"]');
            const seeders = tds.length > 0 ? (parseInt($(tds[0]).text().trim()) || 0) : 0;

            if (isValidResult(name, options.allowEng) && checkYear(name, year, type) && isCorrectFormat(name, reqSeason, reqEpisode)) {
                results.push({ title: name, magnet, size: bytesToSize(sizeBytes), sizeBytes, seeders, source: "TPB Mirror" });
            }
        });
        console.log(`[TPB Mirror] Trovati ${results.length} risultati validi.`);
        return results;
    } catch { return []; }
}

async function searchLime(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[LimeTorrents] Avvio ricerca per: ${title}...`);
    try {
        let query = clean(title) + (options.allowEng ? "" : " ITA");
        const baseUrl = "https://limetorrents.org";
        const { data } = await requestHtml(`${baseUrl}/search?q=${encodeURIComponent(query)}`, { timeout: 7000 });
        if (!data) return [];
        
        const $ = cheerio.load(data);
        const items = [];
        
        $('table.table2 tbody.torsearch tr').each((i, row) => {
            const tds = $(row).find('td');
            if (tds.length < 5) return;

            const titleEl = tds.eq(0).find('.tt-name a').last();
            const name = titleEl.text().trim();
            let detailUrl = titleEl.attr('href');
            
            if (!detailUrl) return;
            if (!detailUrl.startsWith('http')) detailUrl = baseUrl + detailUrl;

            const size = tds.eq(2).text().trim();
            const seeders = parseInt(tds.eq(3).text().trim()) || 0;
            
            if (name && detailUrl && isValidResult(name, options.allowEng) && checkYear(name, year, type) && isCorrectFormat(name, reqSeason, reqEpisode)) {
                items.push({ title: name, url: detailUrl, size: size, seeders: seeders });
            }
        });

        const limit = pLimit(CONFIG.MAX_CONCURRENCY);
        const results = (await Promise.all(items.map(item => limit(async () => {
            try {
                const { data: d } = await requestHtml(item.url, { timeout: 4000 });
                const magnet = cheerio.load(d)('a[href^="magnet:"]').first().attr('href');
                if (magnet) return { title: item.title, magnet, size: item.size, sizeBytes: parseSize(item.size), seeders: item.seeders, source: "LimeTorrents" };
            } catch {}
            return null;
        })))).filter(Boolean);
        console.log(`[LimeTorrents] Trovati ${results.length} risultati validi.`);
        return results;
    } catch (e) { 
        console.log(`[LimeTorrents] Errore: ${e.message}`);
        return []; 
    }
}

async function searchRARBG(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[RARBG] Avvio ricerca per: ${title}...`);
    const mirror = "https://www.rarbgproxy.to";
    let query = clean(title);
    if (!options.allowEng && !query.toUpperCase().includes("ITA")) query += " ITA";

    try {
        const { data } = await requestHtml(`${mirror}/search/?search=${encodeURIComponent(query)}`, { timeout: 7000 });
        if (!data) {
            console.log(`[RARBG] Nessun dato ricevuto dal proxy.`);
            return [];
        }

        const $ = cheerio.load(data);
        const candidates = [];

        $('tr.table2ta_rarbgproxy, table.lista2 tr').each((i, row) => {
            const tds = $(row).find('td');
            if (tds.length < 5) return;

            let linkTag, size, seeders;
            if ($(row).hasClass('table2ta_rarbgproxy')) {
                linkTag = tds.eq(1).find('a').first();
                size = tds.eq(4).text().trim();
                seeders = parseInt(tds.eq(5).text().trim()) || 0;
            } else {
                linkTag = tds.eq(1).find('a').first();
                size = tds.eq(3).text().trim();
                seeders = parseInt(tds.eq(4).text().trim()) || 0;
            }

            const name = linkTag.text().trim() || linkTag.attr('title');
            let detailHref = linkTag.attr('href');

            if (name && detailHref && isValidResult(name, options.allowEng) && checkYear(name, year, type) && isCorrectFormat(name, reqSeason, reqEpisode)) {
                candidates.push({
                    name,
                    detailUrl: detailHref.startsWith('http') ? detailHref : `${mirror}${detailHref.startsWith('/') ? '' : '/'}${detailHref}`,
                    size: size,
                    seeders: seeders
                });
            }
        });

        if (candidates.length === 0) {
            console.log(`[RARBG] Nessun risultato trovato.`);
            return [];
        }

        const limit = pLimit(CONFIG.MAX_CONCURRENCY);
        const results = await Promise.all(candidates.map(c => limit(async () => {
            try {
                const { data: detailHtml } = await requestHtml(c.detailUrl, { timeout: 4000 });
                let magnet = cheerio.load(detailHtml)('a[href^="magnet:"]').first().attr('href') || detailHtml?.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"'\s]*/)?.[0];
                if (magnet) return { title: c.name, magnet, size: c.size, sizeBytes: parseSize(c.size), seeders: c.seeders, source: "RARBG" };
            } catch {}
            return null;
        })));

        const finalResults = results.filter(Boolean);
        console.log(`[RARBG] Trovati ${finalResults.length} risultati validi.`);
        return finalResults;
    } catch (e) {
        console.log(`[RARBG] Errore di connessione al proxy: ${e.message}`);
        return [];
    }
}

async function search1337x(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[1337x] Avvio ricerca per: ${title}...`);
    try {
        let query = clean(title) + (options.allowEng ? "" : " ITA");
        const baseUrl = "https://1337x.bz";
        const pagePromises = [];

        for (let page = 1; page <= 3; page++) {
            const searchUrl = page === 1 ? `${baseUrl}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/` : `${baseUrl}/get-posts/keywords:${encodeURIComponent(query)}:format:json:ncategory:XXX/?page=${page}`;
            pagePromises.push(
                axios.get(searchUrl, {
                    timeout: CONFIG.TIMEOUT_API * 2,
                    headers: { 'User-Agent': BROWSER_PROFILES[0].userAgent, 'Accept': 'application/json, text/plain, */*', 'Referer': `${baseUrl}/home/` }
                }).then(res => res.data).catch(() => null)
            );
        }

        const allPageResults = await Promise.all(pagePromises);
        const results = [];
        const seen = new Set();

        for (const data of allPageResults) {
            if (!data || !data.results || !Array.isArray(data.results)) continue;
            for (const item of data.results) {
                let infoHash = (item.h || String(item.pk || '')).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
                if (!infoHash || infoHash.length < 40 || seen.has(infoHash)) continue;
                seen.add(infoHash);

                const name = item.n || 'Unknown Title';
                const sizeBytes = parseInt(item.s) || 0; 
                if (isValidResult(name, options.allowEng) && checkYear(name, year, type) && isCorrectFormat(name, reqSeason, reqEpisode)) {
                    results.push({ title: name, magnet: `magnet:?xt=urn:btih:${infoHash}`, size: bytesToSize(sizeBytes), sizeBytes: sizeBytes, seeders: parseInt(item.se) || 0, source: "1337x" });
                }
            }
        }
        console.log(`[1337x] Trovati ${results.length} risultati validi.`);
        return results;
    } catch { return []; }
}

async function searchBitSearch(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[BitSearch] Avvio ricerca per: ${title}...`);
    try {
        let query = clean(title) + (options.allowEng ? "" : " ITA");
        const { data } = await axios.get(`https://bitsearch.to/api/v1/search?q=${encodeURIComponent(query)}&limit=50`, { timeout: CONFIG.TIMEOUT_API });
        if (!data?.data) return [];

        const results = data.data.map(i => {
            if (isValidResult(i.name, options.allowEng) && checkYear(i.name, year, type) && isCorrectFormat(i.name, reqSeason, reqEpisode)) {
                return { title: i.name, magnet: `magnet:?xt=urn:btih:${i.infohash}&dn=${encodeURIComponent(i.name)}`, size: bytesToSize(i.size), sizeBytes: parseInt(i.size) || 0, seeders: parseInt(i.seeders) || 0, source: "BitSearch" };
            }
            return null;
        }).filter(Boolean);
        console.log(`[BitSearch] Trovati ${results.length} risultati validi.`);
        return results;
    } catch (e) { 
        console.log(`[BitSearch] Errore durante la ricerca: ${e.message}`);
        return []; 
    }
}

async function searchUindex(title, year, type, reqSeason, reqEpisode, options = {}) {
    console.log(`[UIndex] Avvio ricerca per: ${title}...`);
    try {
        let q = clean(title) + (options.allowEng ? "" : " ITA");
        const { data } = await requestHtml(`https://uindex.org/search.php?search=${encodeURIComponent(q)}&c=0`, { timeout: 4000 });
        if (!data) return [];
        
        const results = data.split(/<tr[^>]*>/gi).filter(row => row.includes('magnet:')).map(row => {
            const magnet = row.match(/href=["'](magnet:[^"']+)["']/i)?.[1].replace(/&amp;/g, '&');
            const name = row.match(/<td[^>]*><a[^>]*>([^<]+)/i)?.[1];
            if(magnet && name && isValidResult(name, options.allowEng) && checkYear(name, year, type) && isCorrectFormat(name, reqSeason, reqEpisode)) {
                return { title: name, magnet, size: "??", sizeBytes: 0, seeders: 0, source: "UIndex" };
            }
            return null;
        }).filter(Boolean);
        console.log(`[UIndex] Trovati ${results.length} risultati validi.`);
        return results;
    } catch { return []; }
}

const ACTIVE_ENGINES = [
    searchCorsaro,
    searchKnaben,
    searchTPB,        
    searchTPBMirror,  
    search1337x,      
    searchBitSearch,  
    searchLime,       
    searchRARBG,
    searchUindex
];

async function searchMagnet(title, year, type, imdbId, options = {}) {
    console.log(`\n======================================================`);
    console.log(`🚀 AVVIO RICERCA GLOBALE: "${title}" (Anno: ${year || 'N/D'})`);
    console.log(`======================================================\n`);
    
    const { season: reqSeason, episode: reqEpisode } = imdbId ? 
        (imdbId.split(':').length > 2 ? { season: parseInt(imdbId.split(':')[1]), episode: parseInt(imdbId.split(':')[2]) } : {}) : {};

    const searchOpts = { allowEng: false, imdbId, ...options };
    
    const promises = ACTIVE_ENGINES.map(engine => 
        withTimeout(engine(title, year, type, reqSeason, reqEpisode, searchOpts), CONFIG.TIMEOUT).catch(e => {
            console.log(`[TIMEOUT/CRITICAL] Motore interrotto per limite di tempo o crash: ${e.message}`);
            return [];
        })
    );

    const resultsRaw = await Promise.allSettled(promises);
    let allResults = resultsRaw.map(r => r.status === 'fulfilled' ? r.value : []).flat();

    const seenHashes = new Set();
    let uniqueResults = [];
    allResults.forEach(r => {
        const hashMatch = r.magnet.match(/btih:([a-f0-9]{40})/i);
        const hash = hashMatch ? hashMatch[1].toLowerCase() : null;
        if (hash && !seenHashes.has(hash)) {
            seenHashes.add(hash);
            uniqueResults.push(r);
        }
    });

    const finalResults = uniqueResults
        .sort((a, b) => b.seeders - a.seeders)
        .slice(0, 300)
        .map(r => {
            if (!r.magnet.includes("tr=")) {
                r.magnet += "&" + CONFIG.TRACKERS.map(t => `tr=${encodeURIComponent(t)}`).join('&');
            }
            return r;
        });
        
    console.log(`\n✅ RICERCA CONCLUSA. Trovati ${finalResults.length} risultati unici totali per "${title}".\n`);
    return finalResults;
}

async function updateTrackers() {
    try {
        const { data } = await axios.get("https://ngosang.github.io/trackerslist/trackers_best.txt", { timeout: 4000 });
        if(data) CONFIG.TRACKERS = data.split('\n').filter(l => l.trim());
        console.log(`[Trackers] Aggiornati correttamente. Totale tracker: ${CONFIG.TRACKERS.length}`);
    } catch {
        console.log(`[Trackers] Impossibile aggiornare i tracker dal master list.`);
    }
}

module.exports = { searchMagnet, updateTrackers, CONFIG, requestHtml };
