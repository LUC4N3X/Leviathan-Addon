const { formatStreamSelector, formatBytes } = require("./formatter");
const ptt = require('parse-torrent-title');

const BEST_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker-udp.gbitt.info:80/announce",
    "udp://retracker.lanta.me:2710/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://t.overflow.biz:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://evan.im:6969/announce",
    "udp://tracker.alaskantf.com:6969/announce",
    "udp://tracker.theoks.net:6969/announce",
    "udp://tracker.srv00.com:6969/announce",
    "udp://tracker.fnix.net:6969/announce",
    "udp://ns575949.ip-51-222-82.net:6969/announce",
    "udp://tracker.filemail.com:6969/announce",
    "udp://bittorrent-tracker.e-n-c-r-y-p-t.net:1337/announce",
    "https://tracker.pmman.tech:443/announce",
    "https://tracker.zhuqiy.com:443/announce"
];

const TRACKER_STRING = BEST_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join("");

function getRealSize(item) {
    if (item._size > 100 * 1024 * 1024) return item._size;
    if (item.sizeBytes > 100 * 1024 * 1024) return item.sizeBytes;

    const t = (item.title || "").toLowerCase();
    let size = 0;

    const match = t.match(/(\d+(?:\.\d+)?)\s*(gb|mb)/i);
    if (match) {
        let val = parseFloat(match[1]);
        size = match[2].toLowerCase().startsWith('g') ? val * 1024**3 : val * 1024**2;
    }

    if (size < 200 * 1024 * 1024) {
        if (t.includes("2160p") || t.includes("4k") || t.includes("uhd")) size = 12500 * 1024 * 1024;
        else if (t.includes("1080p")) size = 2600 * 1024 * 1024;
        else if (t.includes("720p")) size = 1300 * 1024 * 1024;
        else size = 2200 * 1024 * 1024;
    }

    const maxAllowed = (t.includes("2160p") || t.includes("4k")) ? 35 * 1024**3 : 9 * 1024**3;
    if (size > maxAllowed) {
        size = (t.includes("2160p") || t.includes("4k")) ? 12500 * 1024 * 1024 : 2600 * 1024 * 1024;
        console.warn(`[P2P SIZE FIX] Dimensione assurda bloccata → fallback realistico`);
    }

    return Math.floor(size);
}

function constructRobustMagnet(item) {
    let hash = item.hash || item.infoHash || (item.magnet && item.magnet.match(/btih:([a-f0-9]{40})/i)?.[1]);
    if (!hash) return { magnet: null, hash: null };
    hash = hash.toLowerCase();

    const safeTitle = item.title || "Unknown_Video";
    const shortDn = encodeURIComponent(safeTitle.replace(/[^a-zA-Z0-9\.\-_ ]/g, '').trim().substring(0, 80));
    const size = getRealSize(item);

    const magnet = `magnet:?xt=urn:btih:${hash}&dn=${shortDn}&xl=${size}&so=0${TRACKER_STRING}`;

    console.log(`[P2P MAGNET MAX] ${hash} | xl=${formatBytes(size)} | 20 best trackers`);
    return { magnet, hash };
}

module.exports = {
    formatP2PStream: (item, config) => {
        console.log(`[P2P START] "${item.title?.substring(0,68)}..." | Seeders: ${item.seeders || 0}`);

        const displaySize = getRealSize(item);
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

        const streamObj = {
            name: name,
            title: title,
            url: magnet,
            infoHash: hash,
            sources: [magnet, `dht:${hash}`],
            behaviorHints: {
                bingieGroup: bingeGroup,
                notWebReady: true,
                filename: item.title.substring(0, 110)
            }
        };

        if (item.fileIdx != null && !isNaN(parseInt(item.fileIdx))) {
            streamObj.fileIdx = parseInt(item.fileIdx);
        }

        console.log(`[P2P SUCCESS] Hash: ${hash} | Size: ${formatBytes(displaySize)} | 20 elite trackers`);

        if ((item.seeders || 0) === 0) {
            console.warn(`[P2P WARN] 0 seeders rilevati in cache per questo torrent. Potrebbe non partire. Il DHT tenterà la connessione.`);
        }

        return streamObj;
    }
};
