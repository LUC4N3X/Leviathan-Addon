require('dotenv').config();

const TRACKERS = Object.freeze([
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonoid.ch:6969/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.therarbg.to:6969/announce',
    'udp://tracker.doko.moe:6969/announce',
    'udp://opentracker.i2p.rocks:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.moeking.me:6969/announce'
]);

function buildTrackerMagnet(hash, displayName = null) {
    const cleanHash = String(hash || '').toUpperCase().trim();
    const params = [`xt=urn:btih:${cleanHash}`];
    const dn = String(displayName || '').trim();
    if (dn) params.push(`dn=${encodeURIComponent(dn)}`);
    for (const tracker of TRACKERS) params.push(`tr=${encodeURIComponent(tracker)}`);
    return `magnet:?${params.join('&')}`;
}

module.exports = {
    TRACKERS,
    buildTrackerMagnet
};
