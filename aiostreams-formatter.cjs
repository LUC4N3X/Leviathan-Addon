function cleanFileNameForDisplay(filename) {
    let name = filename;
    name = name.replace(/\[[^\]]+\]/g, '').trim();
    name = name.replace(/\s{2,}/g, ' ');

    name = name.replace(/\(([^)]*?(BluRay|WEB|HDR|HEVC|x265|10bit|AAC)[^)]*?)\)/gi, '($1)');
    if (!/\.\w{2,4}$/.test(name)) {
        name += '.mkv';
    }

    return name;
}

function formatStreamName({ 
    addonName, 
    service, 
    cached, 
    quality, 
    hasError = false 
}) {
    const serviceAbbr = {
        'realdebrid': '[RD',
        'torbox': '[TB',
        'alldebrid': '[AD',
        'p2p': '[P2P',
        'web': '[WEB' 
    };
    const srv = serviceAbbr[service?.toLowerCase()] || '[P2P';
    const bolt = cached ? '⚡]' : ']';
    
    return `${srv}${bolt} ${addonName} ${quality || ''}${hasError ? ' ⚠️' : ''}`;
}

function formatStreamTitle({ 
    title,       
    size,        
    language,    
    source,      
    seeders,     
    episodeTitle, 
    infoHash,
    techInfo     
}) {
    const displaySeeders = seeders !== undefined && seeders !== null ? seeders : '-';
    const displayLang = language || '🌍';

    const cleanTitle = cleanFileNameForDisplay(title);

    let displaySource = source || 'Unknown Indexer';
    if (/corsaro/i.test(displaySource)) {
        displaySource = 'ilCorSaRoNeRo';
    } else {
        displaySource = displaySource
            .replace(/TorrentGalaxy|tgx/i, 'TGx')
            .replace(/1337/i, '1337x');
    }

    const rowTech = techInfo ? `${techInfo}` : '';

    const rowInfo = `💾 ${size || 'Unknown'} • 👤 ${displaySeeders} • ${displayLang}`;

    const rowTitle = `📁 ${cleanTitle}`;

    const rowSource = `🔎 ${displaySource}`;

    return [rowTech, rowInfo, rowTitle, rowSource].filter(Boolean).join('\n');
}

function isAIOStreamsEnabled(config) {
    return config?.aiostreams_mode === true;
}

module.exports = {
    formatStreamName,
    formatStreamTitle,
    isAIOStreamsEnabled,
    cleanFileNameForDisplay
};
