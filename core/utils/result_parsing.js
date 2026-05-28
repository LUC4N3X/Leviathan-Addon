function parseSize(sizeText) {
    if (!sizeText) return 0;
    if (typeof sizeText === 'number') return sizeText;
    const str = sizeText.toString();
    let scale = 1;
    if (str.match(/TB/i)) scale = 1024 * 1024 * 1024 * 1024;
    else if (str.match(/GB/i)) scale = 1024 * 1024 * 1024;
    else if (str.match(/MB/i)) scale = 1024 * 1024;
    else if (str.match(/KB/i) || str.match(/kB/i)) scale = 1024;
    else if (str.match(/B/i) && !str.match(/GB|MB|KB|TB/i)) scale = 1;
    const cleanStr = str.replace(/,/g, '.').replace(/[^\d.]/g, '');
    const num = parseFloat(cleanStr);
    return Number.isNaN(num) ? 0 : Math.floor(num * scale);
}

function extractSeeders(title) {
    const seedersMatch = String(title || '').match(/(?:👤|👥)\s*(\d+)/);
    return seedersMatch && parseInt(seedersMatch[1], 10) || 0;
}

function extractSize(title) {
    const sizeMatch = String(title || '').match(/(?:💾|🧲|📦)\s*([\d.,]+\s*\w+)/i);
    return sizeMatch && parseSize(sizeMatch[1]) || 0;
}

function extractProvider(title) {
    const match = String(title || '').match(/\[([A-Z]{2,3})\]/);
    return match?.[1] || 'P2P';
}

module.exports = {
    extractProvider,
    extractSeeders,
    extractSize,
    parseSize
};
