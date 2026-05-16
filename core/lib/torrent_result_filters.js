const { parseTitleDetails } = require('../utils/text');

function normalizeArrayInput(value) {
    if (Array.isArray(value)) {
        return value
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(/[,|;]/)
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    return [];
}

function normalizeProviderKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function parseSizeBytes(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;

    const text = String(value).trim();
    if (/^\d+$/.test(text)) return parseInt(text, 10);

    const match = text.match(/([\d.,]+)\s*(B|BYTE|BYTES|KB|KIB|MB|MIB|GB|GIB|TB|TIB)/i);
    if (!match) return 0;

    const amount = parseFloat(match[1].replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) return 0;

    const multipliers = {
        B: 1,
        BYTE: 1,
        BYTES: 1,
        KB: 1024,
        KIB: 1024,
        MB: 1024 ** 2,
        MIB: 1024 ** 2,
        GB: 1024 ** 3,
        GIB: 1024 ** 3,
        TB: 1024 ** 4,
        TIB: 1024 ** 4
    };

    return Math.round(amount * (multipliers[match[2].toUpperCase()] || 1));
}

function resolveSizeBounds(filters = {}) {
    let minBytes = 0;
    let maxBytes = 0;

    if (Number(filters.minSizeGB) > 0) minBytes = Math.max(minBytes, Number(filters.minSizeGB) * 1024 ** 3);
    if (Number(filters.maxSizeGB) > 0) maxBytes = Math.max(maxBytes, Number(filters.maxSizeGB) * 1024 ** 3);
    if (Number(filters.minSizeBytes) > 0) minBytes = Math.max(minBytes, Number(filters.minSizeBytes));
    if (Number(filters.maxSizeBytes) > 0) maxBytes = Math.max(maxBytes, Number(filters.maxSizeBytes));

    const sizeFilter = filters.sizeFilter;
    if (Array.isArray(sizeFilter) && sizeFilter.length > 0) {
        const parsed = sizeFilter.map(parseSizeBytes).filter((value) => value > 0);
        if (parsed.length === 1) maxBytes = Math.max(maxBytes, parsed[0]);
        if (parsed.length >= 2) {
            minBytes = Math.max(minBytes, Math.min(parsed[0], parsed[1]));
            maxBytes = Math.max(maxBytes, Math.max(parsed[0], parsed[1]));
        }
    } else if (typeof sizeFilter === 'string' || typeof sizeFilter === 'number') {
        const parsed = parseSizeBytes(sizeFilter);
        if (parsed > 0) maxBytes = Math.max(maxBytes, parsed);
    } else if (sizeFilter && typeof sizeFilter === 'object') {
        const minParsed = parseSizeBytes(sizeFilter.min || sizeFilter.from || sizeFilter.gte);
        const maxParsed = parseSizeBytes(sizeFilter.max || sizeFilter.to || sizeFilter.lte);
        if (minParsed > 0) minBytes = Math.max(minBytes, minParsed);
        if (maxParsed > 0) maxBytes = Math.max(maxBytes, maxParsed);
    }

    return { minBytes, maxBytes };
}

function normalizeQualityToken(value) {
    const token = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    const aliases = {
        '2160p': '4k',
        'uhd': '4k',
        '4k': '4k',
        '1080': '1080p',
        '1080p': '1080p',
        'fhd': '1080p',
        'fullhd': '1080p',
        '720': '720p',
        '720p': '720p',
        '480': '480p',
        '480p': '480p',
        'sd': 'other',
        'cam': 'cam',
        'ts': 'cam',
        'telesync': 'cam',
        'telecine': 'cam',
        'scr': 'scr',
        'screener': 'scr',
        'hdr': 'hdrall',
        'hdr10': 'hdrall',
        'hdr10+': 'hdrall',
        'dv': 'dolbyvision',
        'dolbyvision': 'dolbyvision',
        'dolbyvisionwithhdr': 'dolbyvisionwithhdr',
        'remux': 'brremux',
        'brremux': 'brremux',
        'blurayremux': 'brremux',
        '3d': 'threed',
        'threed': 'threed',
        'non3d': 'nonthreed',
        'nonthreed': 'nonthreed',
        'unknown': 'unknown',
        'other': 'other'
    };
    return aliases[token] || token;
}

function normalizeLanguageToken(value) {
    const token = String(value || '').trim().toLowerCase();
    if (token === 'italian' || token === 'ita' || token === 'it') return 'ita';
    if (token === 'english' || token === 'eng' || token === 'en') return 'eng';
    if (token === 'multi' || token === 'dual audio') return 'multi';
    return token;
}

function getQualityKey(details = {}, title = '') {
    const quality = String(details.quality || '').toLowerCase();
    if (quality.includes('4k') || quality.includes('2160')) return '4k';
    if (quality.includes('1080')) return '1080p';
    if (quality.includes('720')) return '720p';
    if (quality.includes('480')) return '480p';
    if (/\b(?:cam|hdcam|ts|telesync|telecine)\b/i.test(title) || details.flags?.cam) return 'cam';
    if (/\b(?:scr|screener|dvdscr|bdscr)\b/i.test(title) || details.flags?.screener) return 'scr';
    return quality ? 'other' : 'unknown';
}

function getTorrentAnalysis(item) {
    const title = String(item?.title || item?.name || '').trim();
    const source = String(item?.source || item?.provider || '').trim();
    const details = item?._releaseDetails && typeof item._releaseDetails === 'object'
        ? item._releaseDetails
        : parseTitleDetails(title);

    if (!item?._releaseDetails) item._releaseDetails = details;

    const providerKey = normalizeProviderKey(source);
    const numericSize = Number(item?._size || item?.sizeBytes || item?.size || 0) || 0;
    const sizeBytes = Math.max(0, numericSize > 0 ? numericSize : parseSizeBytes(item?.size));
    const seeders = Math.max(0, parseInt(item?.seeders, 10) || 0);
    const qualityKey = getQualityKey(details, title);
    const dynamicRange = Array.isArray(details.dynamicRange) ? details.dynamicRange.map((entry) => String(entry || '').toUpperCase()) : [];
    const tags = new Set();

    tags.add(qualityKey);
    if (details.flags?.remux) tags.add('brremux');
    if (details.flags?.threeD) tags.add('threed');
    else tags.add('nonthreed');
    if (dynamicRange.length > 0) tags.add('hdrall');
    dynamicRange.forEach((entry) => tags.add(String(entry || '').toLowerCase()));
    if (dynamicRange.includes('DV')) tags.add('dolbyvision');
    if (dynamicRange.includes('DV') && dynamicRange.some((entry) => entry !== 'DV')) tags.add('dolbyvisionwithhdr');
    if (details.videoCodec) tags.add(String(details.videoCodec).toLowerCase());
    if (details.audioCodec) tags.add(String(details.audioCodec).toLowerCase());

    const rawLanguages = Array.isArray(details.rawLanguages) ? details.rawLanguages.map(normalizeLanguageToken) : [];
    rawLanguages.forEach((language) => tags.add(language));

    return { title, source, providerKey, details, sizeBytes, seeders, qualityKey, tags };
}

function matchesTorrentioQualityFilter(filterKey, analysis) {
    const key = normalizeQualityToken(filterKey);
    if (!key) return false;

    if (key === '4k' || key === '1080p' || key === '720p' || key === '480p') {
        return analysis.qualityKey === key;
    }
    if (key === 'other') {
        return !['4k', '1080p', '720p', '480p', 'cam', 'scr', 'unknown'].includes(analysis.qualityKey);
    }
    if (key === 'cam') return analysis.qualityKey === 'cam';
    if (key === 'scr') return analysis.qualityKey === 'scr';
    if (key === 'unknown') return analysis.qualityKey === 'unknown';
    return analysis.tags.has(key);
}

function shouldDropByLegacyQuality(analysis, filters = {}) {
    if (filters.no4k && analysis.qualityKey === '4k') return true;
    if (filters.no1080 && analysis.qualityKey === '1080p') return true;
    if (filters.no720 && analysis.qualityKey === '720p') return true;
    if (filters.noScr && (
        analysis.qualityKey === 'scr' ||
        analysis.qualityKey === 'cam' ||
        analysis.qualityKey === '480p' ||
        /\b(?:sd|dvd(?:rip|scr)?|480p|576p)\b/i.test(analysis.title)
    )) return true;
    if (filters.noCam && analysis.qualityKey === 'cam') return true;
    return false;
}

function toNormalizedSet(value) {
    return new Set(normalizeArrayInput(value).map((entry) => entry.toLowerCase()));
}

function applyTorrentResultFilters(items, filters = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!filters || Object.keys(filters).length === 0) return list;

    const providerAllow = new Set([
        ...normalizeArrayInput(filters.providers),
        ...normalizeArrayInput(filters.providerAllow),
        ...normalizeArrayInput(filters.providerInclude)
    ].map(normalizeProviderKey).filter(Boolean));

    const providerBlock = new Set([
        ...normalizeArrayInput(filters.providerExclude),
        ...normalizeArrayInput(filters.providerDeny),
        ...normalizeArrayInput(filters.providerBlock)
    ].map(normalizeProviderKey).filter(Boolean));

    const qualityAllow = normalizeArrayInput(filters.qualityAllow || filters.qualityInclude).map(normalizeQualityToken).filter(Boolean);
    const qualityBlock = normalizeArrayInput(filters.qualityDeny || filters.qualityExclude || filters.qualityFilter).map(normalizeQualityToken).filter(Boolean);
    const requireTags = toNormalizedSet(filters.requireTags);
    const excludeTags = toNormalizedSet(filters.excludeTags);
    const minSeeders = Math.max(0, parseInt(filters.minSeeders, 10) || 0);
    const maxSeeders = Math.max(0, parseInt(filters.maxSeeders, 10) || 0);
    const { minBytes, maxBytes } = resolveSizeBounds(filters);

    return list.filter((item) => {
        const analysis = getTorrentAnalysis(item);

        if (providerAllow.size > 0 && !providerAllow.has(analysis.providerKey)) return false;
        if (providerBlock.size > 0 && providerBlock.has(analysis.providerKey)) return false;
        if (minSeeders > 0 && analysis.seeders < minSeeders) return false;
        if (maxSeeders > 0 && analysis.seeders > maxSeeders) return false;
        if (minBytes > 0 && analysis.sizeBytes > 0 && analysis.sizeBytes < minBytes) return false;
        if (maxBytes > 0 && analysis.sizeBytes > maxBytes) return false;
        if (shouldDropByLegacyQuality(analysis, filters)) return false;

        if (qualityAllow.length > 0 && !qualityAllow.some((token) => matchesTorrentioQualityFilter(token, analysis))) {
            return false;
        }
        if (qualityBlock.length > 0 && qualityBlock.some((token) => matchesTorrentioQualityFilter(token, analysis))) {
            return false;
        }

        if (requireTags.size > 0) {
            for (const tag of requireTags) {
                if (!analysis.tags.has(tag)) return false;
            }
        }

        if (excludeTags.size > 0) {
            for (const tag of excludeTags) {
                if (analysis.tags.has(tag)) return false;
            }
        }

        return true;
    });
}

module.exports = {
    applyTorrentResultFilters
};
