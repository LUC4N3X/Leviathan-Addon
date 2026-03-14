const { formatStreamSelector, formatBytes } = require("./formatter");
const ptt = require('parse-torrent-title');

// === TRACKER NUCLEARE 2026 (testati oggi) ===
const BEST_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://tracker-udp.gbitt.info:80/announce",
    "udp://retracker.lanta.me:2710/announce",
    "udp://tracker1.bt.moack.co.kr:80/announce",
    "http://tracker.opentrackr.org:1337/announce"
];

const TRACKER_STRING = BEST_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join("");

const languageMapping = {
  'english': '🇬🇧 ENG', 'japanese': '🇯🇵 JPN', 'italian': '🇮🇹 ITA',
  'french': '🇫🇷 FRA', 'german': '🇩🇪 GER', 'spanish': '🇪🇸 ESP',
  'russian': '🇷🇺 RUS', 'multi audio': '🌍 MULTI'
};

// === STIMA SIZE AUTOMATICA (fix per i tuoi "0 B") ===
function estimateP2PSize(title) {
    const t = (title || "").toLowerCase();
    if (t.includes("2160p") || t.includes("4k") || t.includes("uhd")) return 8500 * 1024 * 1024;
    if (t.includes("1080p") || t.includes("fhd")) return 2200 * 1024 * 1024;
    if (t.includes("720p") || t.includes("hd")) return 1100 * 1024 * 1024;
    return 1800 * 1024 * 1024; // default ~1.8 GB
}

function constructRobustMagnet(item) {
    let hash = item.hash || item.infoHash;
    if (!hash && item.magnet) {
        const match = item.magnet.match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
        if (match) hash = match[1];
    }
    if (!hash) {
        console.error(`[P2P ERROR] Nessun hash trovato per: ${item.title}`);
        return { magnet: null, hash: null };
    }

    const cleanTitle = encodeURIComponent(item.title.replace(/[^a-zA-Z0-9\.\-_ ]/g, '').trim().substring(0, 80));
    const finalMagnet = `magnet:?xt=urn:btih:${hash}&dn=${cleanTitle}${TRACKER_STRING}`;
    
    console.log(`[P2P MAGNET] Costruito → Hash: ${hash.toLowerCase()} | Title: ${item.title.substring(0,55)}...`);
    return { magnet: finalMagnet, hash: hash.toLowerCase() };
}

module.exports = {
    formatP2PStream: (item, config) => {
        console.log(`[P2P START] "${item.title.substring(0,70)}..." | Raw Seeders: ${item.seeders || 0} | Raw Size: ${formatBytes(item._size || item.sizeBytes || 0)}`);

        // STIMA SIZE se troppo bassa o zero (come fai già nei debrid)
        let displaySize = item._size || item.sizeBytes || 0;
        if (displaySize < 100 * 1024 * 1024) {
            displaySize = estimateP2PSize(item.title);
            console.log(`[P2P SIZE STIMATO] ${formatBytes(displaySize)} (era troppo basso/zero)`);
        }

        const { magnet, hash } = constructRobustMagnet(item);
        if (!magnet) return null;

        const { name, title, bingeGroup } = formatStreamSelector(
            item.title,             
            item.source || "P2P",   
            displaySize, 
            item.seeders || 0,      
            "P2P",                  
            config,                 
            hash,                   
            false,                  
            item._isPack || false   
        );

        // === STREAM FINALE (PERFETTO PER STREMIO) ===
        const streamObj = {
            name: name,
            title: title,
            url: magnet,
            infoHash: hash,
            sources: [magnet, `dht:${hash}`],
            behaviorHints: {
                bingieGroup: bingeGroup,
                notWebReady: true,
                filename: item.title.substring(0, 120)   // ← AIUTA STREMIO NEI PACK
            }
        };

        if (item.fileIdx !== undefined && item.fileIdx !== null && !isNaN(parseInt(item.fileIdx))) {
            streamObj.fileIdx = parseInt(item.fileIdx);
            console.log(`[P2P] FileIdx impostato: ${streamObj.fileIdx}`);
        }

        console.log(`[P2P SUCCESS] Stream pronto → Hash: ${hash} | Size: ${formatBytes(displaySize)} | Seeders: ${item.seeders || 0} | notWebReady: true`);
        
        // AVVISO SE IL TORRENT È DEBOLE
        if ((item.seeders || 0) < 3) {
            console.warn(`[P2P ATTENZIONE] Solo ${item.seeders || 0} seeders → potrebbe rimanere in caricamento`);
        }

        return streamObj;
    }
};
