function estimateVisualSize(knownSize, title, isSeries, isPack, infoHash) {
    const safeTitle = (title || 'video').toLowerCase();
    const is4K = /2160p|4k|uhd|ultra[-.\s]?hd/i.test(safeTitle);
    const is1080 = /1080p|1080i|fhd|full[-.\s]?hd|blu[-.\s]?ray/i.test(safeTitle);
    const is720 = /720p|720i|hd[-.\s]?rip|hd/i.test(safeTitle);

    if (knownSize && knownSize > 0) {
        let isSane = true;
        const sizeInGB = knownSize / (1024 * 1024 * 1024);
        if (!isPack) {
            if (isSeries) {
                if (is4K && sizeInGB > 15) isSane = false;
                else if (is1080 && sizeInGB > 6) isSane = false;
                else if (is720 && sizeInGB > 3) isSane = false;
                else if (!is4K && !is1080 && !is720 && sizeInGB > 1.5) isSane = false;
            } else {
                if (is4K && sizeInGB > 100) isSane = false;
                else if (is1080 && sizeInGB > 40) isSane = false;
                else if (is720 && sizeInGB > 12) isSane = false;
                else if (!is4K && !is1080 && !is720 && sizeInGB > 5) isSane = false;
            }
        }
        if (isSane) return knownSize;
    }

    let seedStr = infoHash || safeTitle;
    let hashVal = 0;
    for (let i = 0; i < seedStr.length; i += 1) hashVal = (Math.imul(31, hashVal) + seedStr.charCodeAt(i)) | 0;
    hashVal = Math.abs(hashVal);

    const seededRandom = () => {
        hashVal = (Math.imul(1664525, hashVal) + 1013904223) | 0;
        return (Math.abs(hashVal) % 100000) / 100000;
    };

    let baseSize = 0;
    if (isSeries) {
        if (is4K) baseSize = 1.8 * 1024**3 + (seededRandom() * 4.7 * 1024**3);
        else if (is1080) baseSize = 800 * 1024**2 + (seededRandom() * 2.4 * 1024**3);
        else if (is720) baseSize = 300 * 1024**2 + (seededRandom() * 900 * 1024**2);
        else baseSize = 150 * 1024**2 + (seededRandom() * 450 * 1024**2);
    } else {
        if (is4K) baseSize = 12 * 1024**3 + (seededRandom() * 53 * 1024**3);
        else if (is1080) baseSize = 1.8 * 1024**3 + (seededRandom() * 12.2 * 1024**3);
        else if (is720) baseSize = 800 * 1024**2 + (seededRandom() * 3.2 * 1024**3);
        else baseSize = 700 * 1024**2 + (seededRandom() * 1.1 * 1024**3);
    }
    return Math.floor(baseSize + Math.floor(seededRandom() * 1024 * 1024 * 5));
}

function estimateSeeders(knownSeeders, infoHash) {
    if (knownSeeders && knownSeeders > 0) return knownSeeders;
    const seedStr = infoHash || 'seeders_fallback';
    let hashVal = 0;
    for (let i = 0; i < seedStr.length; i += 1) hashVal = (Math.imul(31, hashVal) + seedStr.charCodeAt(i)) | 0;
    return (Math.abs(hashVal) % 60) + 8;
}

module.exports = {
    estimateVisualSize,
    estimateSeeders
};
