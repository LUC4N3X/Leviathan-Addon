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

function base32ToHex(base32) {
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    let hex = '';
    for (let i = 0; i < base32.length; i += 1) {
        bits += base32chars.indexOf(base32.charAt(i).toUpperCase()).toString(2).padStart(5, '0');
    }
    for (let i = 0; i + 4 <= bits.length; i += 4) {
        hex += parseInt(bits.substr(i, 4), 2).toString(16);
    }
    return hex;
}

function extractInfoHash(magnet) {
    if (!magnet) return null;
    const match = String(magnet).match(/btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/i);
    if (!match) return null;
    const hash = match[1];
    return hash.length === 32 ? base32ToHex(hash).toUpperCase() : hash.toUpperCase();
}

module.exports = {
    base32ToHex,
    extractInfoHash,
    TRACKERS,
    buildTrackerMagnet
};
