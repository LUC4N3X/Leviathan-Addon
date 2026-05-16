'use strict';

function normalizeForMatch(value) {
    if (!value || typeof value !== 'string') return '';
    let text = value;
    try {
        text = text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    } catch (_) {
        text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    return text
        .replace(/[‐‑–—―〜～]/g, '-')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .toLowerCase();
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeSeriesTitleRegex(title) {
    const normalized = normalizeForMatch(title);
    if (!normalized) return null;

    const tokens = normalized.split(' ').filter(Boolean).map(escapeRegex);
    if (tokens.length === 0) return null;

    const tokenPattern = tokens.join('[\\s._\\-:/\\\\]+');
    const boundary = '(?=(?:[\\s._\\-:/\\\\]*(?:s\\d{1,2}e\\d{1,3}|\\d{1,2}x\\d{1,3}|ep\\.?\\s?\\d{1,3}|\\b\\d{4}\\b|\\b(?:480p|720p|1080p|2160p|4k|uhd)\\b|\\(|\\[|$)))';
    return new RegExp(`(?:^|[^a-z0-9])${tokenPattern}${boundary}`, 'i');
}

function getCandidateValues(candidate) {
    const values = [];
    if (typeof candidate === 'string') values.push(candidate);
    else if (candidate && typeof candidate === 'object') {
        ['name', 'title', 'searchableName', 'path', 'filename', 'file_title', 'packTitle', 'rawDescription'].forEach((key) => {
            if (candidate[key]) values.push(candidate[key]);
        });
        if (candidate.searchableName && candidate.name) {
            values.push(`${candidate.searchableName} ${candidate.name}`, `${candidate.name} ${candidate.searchableName}`);
        }
        if (Array.isArray(candidate.files)) {
            for (let i = 0; i < Math.min(8, candidate.files.length); i += 1) {
                if (candidate.files[i]?.path) values.push(candidate.files[i].path);
                if (candidate.files[i]?.name) values.push(candidate.files[i].name);
                if (candidate.files[i]?.file_title) values.push(candidate.files[i].file_title);
            }
        }
    }
    return values.filter(Boolean);
}

function matchesSeriesTitle(candidate, canonicalTitle) {
    if (!canonicalTitle) return true;
    const rx = makeSeriesTitleRegex(canonicalTitle);
    if (!rx) return true;

    const values = getCandidateValues(candidate);
    if (values.length === 0) return false;

    for (const raw of values) {
        const normalized = normalizeForMatch(raw);
        if (rx.test(normalized)) return true;
    }
    return false;
}

function hasEpisodeMarker(value, season, episode) {
    if (!value) return false;
    const sNum = Number(season);
    const eNum = Number(episode);
    if (!Number.isFinite(sNum) || !Number.isFinite(eNum) || eNum <= 0) return false;

    const text = String(value || '');
    const s = String(sNum).padStart(2, '0');
    const e = String(eNum).padStart(2, '0');
    const eLoose = String(eNum);

    const patterns = [
        new RegExp(`[sS][\\W_]*0*${sNum}[\\W_]*[eE][\\W_]*0*${eNum}(?!\\d)`),
        new RegExp(`\\b0*${sNum}[\\W_]*[xX][\\W_]*0*${eNum}\\b`),
        new RegExp(`season[\\W_]*0*${sNum}[\\W_]+ep(?:isode)?[\\W_]*0*${eNum}\\b`, 'i'),
        new RegExp(`stagione[\\W_]*0*${sNum}[\\W_]+episodio[\\W_]*0*${eNum}\\b`, 'i'),
        new RegExp(`\\b[eE]p?\\.?[\\W_]*${eLoose}\\b`, 'i'),
        new RegExp(`${s}[\\W_]*[eE][\\W_]*${e}`, 'i')
    ];
    return patterns.some((rx) => rx.test(text));
}

function hasSeasonOnlyMarker(value, season) {
    if (!value) return false;
    const sNum = Number(season);
    if (!Number.isFinite(sNum) || sNum <= 0) return false;
    const text = String(value || '');
    return new RegExp('(?:^|[^a-z0-9])s\\s*0*' + sNum + '(?!\\s*[eE]\\s*\\d)', 'i').test(text)
        || new RegExp('(?:^|[^a-z0-9])season\\s*0*' + sNum + '(?:\\b|\\D)', 'i').test(text)
        || new RegExp('(?:^|[^a-z0-9])stagione\\s*0*' + sNum + '(?:\\b|\\D)', 'i').test(text);
}

module.exports = {
    normalizeForMatch,
    makeSeriesTitleRegex,
    matchesSeriesTitle,
    hasEpisodeMarker,
    hasSeasonOnlyMarker,
    getCandidateValues
};
