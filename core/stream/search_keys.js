const crypto = require('crypto');

const { normalizeSearchText } = require('../utils/text');
const { extractInfoHash } = require('../utils/torrent');

function buildTitleSearchPipelineKey(meta, type, langMode, dbOnlyMode = false, filters = {}) {
    const normalizeArray = (value) => Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean).sort()
        : [];
    const titles = [meta?.title, meta?.originalTitle, meta?.name]
        .filter(Boolean)
        .map((value) => normalizeSearchText(value))
        .filter(Boolean)
        .slice(0, 6)
        .sort();
    const payload = {
        type: String(type || '').toLowerCase(),
        langMode: String(langMode || '').toLowerCase(),
        dbOnly: dbOnlyMode === true,
        year: Number(meta?.year || 0) || 0,
        season: Number(meta?.season || 0) || 0,
        episode: Number(meta?.episode || 0) || 0,
        filters: {
            sourceMode: String(filters?.sourceMode || (dbOnlyMode ? 'dbOnly' : 'balanced')).toLowerCase(),
            no4k: filters?.no4k === true,
            no1080: filters?.no1080 === true,
            no720: filters?.no720 === true,
            noScr: filters?.noScr === true,
            noCam: filters?.noCam === true,
            maxSizeGB: Number(filters?.maxSizeGB || 0) || 0,
            minSizeGB: Number(filters?.minSizeGB || 0) || 0,
            maxSizeBytes: Number(filters?.maxSizeBytes || 0) || 0,
            minSizeBytes: Number(filters?.minSizeBytes || 0) || 0,
            minSeeders: Number(filters?.minSeeders || 0) || 0,
            maxSeeders: Number(filters?.maxSeeders || 0) || 0,
            providers: normalizeArray(filters?.providers),
            providerAllow: normalizeArray(filters?.providerAllow),
            providerInclude: normalizeArray(filters?.providerInclude),
            providerExclude: normalizeArray(filters?.providerExclude),
            providerDeny: normalizeArray(filters?.providerDeny),
            providerBlock: normalizeArray(filters?.providerBlock),
            qualityAllow: normalizeArray(filters?.qualityAllow),
            qualityInclude: normalizeArray(filters?.qualityInclude),
            qualityExclude: normalizeArray(filters?.qualityExclude),
            qualityDeny: normalizeArray(filters?.qualityDeny),
            qualityFilter: normalizeArray(filters?.qualityFilter),
            requireTags: normalizeArray(filters?.requireTags),
            excludeTags: normalizeArray(filters?.excludeTags),
            sizeFilter: Array.isArray(filters?.sizeFilter)
                ? filters.sizeFilter.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
                : (filters?.sizeFilter && typeof filters.sizeFilter === 'object'
                    ? {
                        min: String(filters.sizeFilter.min || filters.sizeFilter.from || filters.sizeFilter.gte || '').trim().toLowerCase(),
                        max: String(filters.sizeFilter.max || filters.sizeFilter.to || filters.sizeFilter.lte || '').trim().toLowerCase()
                    }
                    : String(filters?.sizeFilter || '').trim().toLowerCase())
        },
        titles
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 20);
}

function buildValidatedFileSetKey(item, meta) {
    const hash = extractInfoHash(item?.hash || item?.infoHash || '');
    if (!hash) return null;
    const season = Number(meta?.season || item?.season || 0) || 0;
    const episode = Number(meta?.episode || item?.episode || 0) || 0;
    const mediaType = meta?.isSeries || season > 0 || episode > 0 ? 'series' : 'movie';
    return `${hash}:${mediaType}:${season}:${episode}`;
}

module.exports = {
    buildTitleSearchPipelineKey,
    buildValidatedFileSetKey
};
