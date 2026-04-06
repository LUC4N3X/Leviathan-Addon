const SOURCE_ALIAS_ENTRIES = [
    [/\bcorsaro\b/i, 'ilCorSaRoNeRo'],
    [/\btorrentgalaxy\b|\btgx\b/i, 'TGx'],
    [/\b1337\b/i, '1337x'],
    [/\bthe pirate bay\b|\btpb\b/i, 'TPB'],
    [/\byts\b/i, 'YTS'],
    [/\brarbg\b/i, 'RARBG']
];

const EXTENSION_RE = /\.[a-z0-9]{2,4}(?:[?#].*)?$/i;
const TECH_HINT_RE = /(BluRay|WEB(?:-DL|Rip)?|HDR|DV|HEVC|x26[45]|10bit|AAC|Atmos|DDP?|TrueHD|DTS(?:-HD)?|Remux)/i;

function normalizeBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function compactSpaces(value) {
    return String(value || '').replace(/\s{2,}/g, ' ').trim();
}

function normalizeSourceName(source) {
    let displaySource = compactSpaces(source || 'Unknown Indexer');
    for (const [pattern, replacement] of SOURCE_ALIAS_ENTRIES) {
        if (pattern.test(displaySource)) {
            displaySource = replacement;
            break;
        }
    }
    return displaySource;
}

function cleanFileNameForDisplay(filename, options = {}) {
    const { forceExtension = false } = options;
    let name = compactSpaces(filename);
    if (!name) return forceExtension ? 'Unknown.mkv' : 'Unknown';

    name = name.replace(/\[[^\]]+\]/g, ' ');
    name = compactSpaces(name);
    name = name.replace(/\(([^)]*?(BluRay|WEB|HDR|HEVC|x265|x264|10bit|AAC|Atmos|DDP?|DV|Remux)[^)]*?)\)/gi, '($1)');
    name = compactSpaces(name);

    if (forceExtension && !EXTENSION_RE.test(name) && !/https?:\/\//i.test(name)) {
        name += '.mkv';
    }

    return name;
}

function getCacheBadge(cacheState, cached) {
    const normalized = compactSpaces(cacheState).toLowerCase();
    if (normalized === 'cached') return '⚡';
    if (normalized === 'uncached') return '☁️';
    if (normalized === 'probing') return '🔄';
    if (normalized === 'unknown') return '⏳';
    return cached ? '⚡' : '⏳';
}

function formatStreamName({
    addonName,
    service,
    cached,
    cacheState,
    quality,
    hasError = false
} = {}) {
    const serviceAbbr = {
        realdebrid: '[RD',
        torbox: '[TB',
        alldebrid: '[AD',
        p2p: '[P2P',
        web: '[WEB'
    };

    const serviceKey = String(service || 'p2p').toLowerCase();
    const srv = serviceAbbr[serviceKey] || '[P2P';
    const badge = getCacheBadge(cacheState, cached);
    const bolt = `${badge}]`;
    const safeAddonName = compactSpaces(addonName || 'Leviathan');
    const safeQuality = compactSpaces(quality || '');
    const safeError = hasError ? ' ⚠️' : '';

    return `${srv}${bolt} ${safeAddonName}${safeQuality ? ` ${safeQuality}` : ''}${safeError}`;
}

function formatStreamTitle({
    title,
    size,
    language,
    source,
    seeders,
    episodeTitle,
    infoHash,
    techInfo,
    forceExtension = false
} = {}) {
    const displaySeeders = seeders !== undefined && seeders !== null && seeders !== '' ? seeders : '-';
    const displayLang = compactSpaces(language || '🌍');
    const displaySource = normalizeSourceName(source);
    const displayTitle = cleanFileNameForDisplay(title || episodeTitle || infoHash || 'Unknown', {
        forceExtension: Boolean(forceExtension) && TECH_HINT_RE.test(String(techInfo || title || ''))
    });
    const rowTech = compactSpaces(techInfo || '');
    const rowInfo = `💾 ${compactSpaces(size || 'Unknown')} • 👤 ${displaySeeders} • ${displayLang}`;
    const rowTitle = `📁 ${displayTitle}`;
    const rowSource = `🔎 ${displaySource}`;

    return [rowTech, rowInfo, rowTitle, rowSource].filter(Boolean).join('\n');
}

function isAIOStreamsEnabled(config) {
    return normalizeBoolean(config?.aiostreams_mode);
}

module.exports = {
    formatStreamName,
    formatStreamTitle,
    isAIOStreamsEnabled,
    cleanFileNameForDisplay,
    normalizeSourceName
};
