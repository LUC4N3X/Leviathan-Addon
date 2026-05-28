function normalizeAnimeEpisodeText(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[【】「」『』［］（）]/g, ' ')
        .replace(/[‐‑–—―〜～]/g, '-')
        .replace(/[·・]/g, ' ')
        .replace(/第\s*([0-9]{1,2})\s*[期季]/gi, ' season $1 ')
        .replace(/第\s*([0-9]{1,4})\s*[話话]/gi, ' episode $1 ')
        .replace(/\b(?:cour|part|pt)\s*([0-9]{1,2})\b/gi, ' season $1 ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractAnimeEpisodeRange(filename, defaultSeason = 1) {
    const name = normalizeAnimeEpisodeText(filename);
    const patterns = [
        /\bseason\s*0?(\d{1,2})\s*(?:batch|pack|complete|collection)?\s*0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i,
        /\b(?:episodes?|eps?|episode|episodio)\s*0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i,
        /\b0?(\d{1,3})\s*(?:-|~|to|a)\s*0?(\d{1,3})\b/i
    ];

    for (const pattern of patterns) {
        const match = name.match(pattern);
        if (!match) continue;
        const hasExplicitSeason = pattern === patterns[0];
        const season = hasExplicitSeason ? parseInt(match[1], 10) : defaultSeason;
        const start = parseInt(match[hasExplicitSeason ? 2 : 1], 10);
        const end = parseInt(match[hasExplicitSeason ? 3 : 2], 10);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) continue;
        if (start >= 1900 && start <= 2100) continue;
        if (end >= 1900 && end <= 2100) continue;
        const hasBatchCue = /\b(?:batch|complete|collection|pack|season|stagione|episodes?|eps?|cour|全集|合集)\b/i.test(name) || /第\s*\d+\s*[話话]/i.test(String(filename || ''));
        if (!hasBatchCue && end - start > 4) continue;
        return { season, episode: start, rangeStart: start, rangeEnd: end, isRange: true, isBatch: true };
    }

    return null;
}

function extractAnimeEpisodeFromFilename(filename, defaultSeason = 1) {
    const originalName = String(filename || '');
    const name = normalizeAnimeEpisodeText(originalName);
    let match = name.match(/\bS(?:EASON)?\s*0?(\d{1,2})\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = name.match(/\b(\d{1,2})(?:ST|ND|RD|TH)\s+SEASON\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = name.match(/\bSEASON\s*0?(\d{1,2}).{0,16}?EP(?:ISODE)?\s*0?(\d{1,4})(?:v\d+)?\b/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = name.match(/\b(?:EP(?:ISODE)?|EPISODIO)\s*0?(\d{1,4})(?:v\d+)?\b(?!\s*(?:-|~|to|a)\s*0?\d{1,3}\b)/i);
    if (match) return { season: defaultSeason, episode: parseInt(match[1], 10) };

    const range = extractAnimeEpisodeRange(originalName, defaultSeason);
    if (range) return range;

    match = name.match(/(?:^|\s)#?0*([1-9]\d{0,3})(?:v\d+)?(?=$|\s)/i);
    if (match) {
        const episode = parseInt(match[1], 10);
        if (!(episode >= 1900 && episode <= 2100) && ![2160, 1080, 720, 576, 480, 360, 264, 265].includes(episode)) {
            return { season: defaultSeason, episode };
        }
    }

    const genericPattern = /(?:^|[\s._\-\[\(])0*([1-9]\d{0,3})(?:v\d+)?(?=$|[\s._\-\]\)])/ig;
    for (const candidate of name.matchAll(genericPattern)) {
        const episode = parseInt(candidate[1], 10);
        if (!Number.isInteger(episode) || episode <= 0) continue;
        if (episode >= 1900 && episode <= 2100) continue;
        if ([2160, 1080, 720, 576, 480, 360, 264, 265].includes(episode)) continue;
        return { season: defaultSeason, episode };
    }

    return null;
}

function extractSeasonEpisodeFromFilename(filename, defaultSeason = 1, options = {}) {
    const name = normalizeAnimeEpisodeText(filename);
    const patterns = [
        /\bS(\d{1,2})E(\d{1,3})\b/i,
        /\b(\d{1,2})x(\d{1,3})\b/i,
        /\bSEASON\s*(\d{1,2}).{0,20}?EPISODE\s*(\d{1,3})\b/i,
        /\bSTAGIONE\s*(\d{1,2}).{0,20}?EPISODIO\s*(\d{1,3})\b/i
    ];

    for (const pattern of patterns) {
        const match = name.match(pattern);
        if (!match) continue;
        return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    }

    const episodeOnly = name.match(/\bE(?:P(?:ISODE)?)?\s*0?(\d{1,3})\b/i);
    if (episodeOnly) return { season: defaultSeason, episode: parseInt(episodeOnly[1], 10) };

    if (options?.anime) return extractAnimeEpisodeFromFilename(name, defaultSeason);
    return null;
}

module.exports = {
    extractAnimeEpisodeFromFilename,
    extractAnimeEpisodeRange,
    extractSeasonEpisodeFromFilename,
    normalizeAnimeEpisodeText
};
