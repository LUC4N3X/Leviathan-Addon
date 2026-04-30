"use strict";

function normalizeBaseText(value = '') {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2010-\u2015]/g, '-')
        .trim();
}

function normalizeLooseTitle(value = '', options = {}) {
    const dropTokens = options.dropTokens !== false;
    let normalized = normalizeBaseText(value)
        .toLowerCase()
        .replace(/[\[\]{}()]/g, ' ')
        .replace(/[^a-z0-9\s:._\-]/g, ' ')
        .replace(/[._:\-]+/g, ' ');

    if (dropTokens) {
        normalized = normalized.replace(/\b(?:the|a|an|un|una|il|lo|la|gli|le|di|de|del|della|season|stagione|episode|episodio|part|ep|2160p|1080p|720p|480p|4k|uhd|hdr|hdr10|dv|hevc|x265|x264|h265|h264|bluray|blu\s*ray|brrip|bdrip|web\s*dl|webrip|web|hdtv|remux|proper|repack|rerip|internal|extended|uncut|remastered|aac|ac3|eac3|ddp\d*\.?\d*|dts|truehd|atmos|ita|eng|multi|sub|subs|vostfr|dubbed|dual)\b/gi, ' ');
    }

    return normalized
        .replace(/\b(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3}|season\s*\d{1,2}|stagione\s*\d{1,2}|episode\s*\d{1,3}|episodio\s*\d{1,3})\b/gi, ' ')
        .replace(/\b(?:19\d{2}|20\d{2})\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenizeTitle(value = '', options = {}) {
    const normalized = normalizeLooseTitle(value, options);
    if (!normalized) return [];
    return normalized.split(' ').filter((token) => token.length >= 2);
}

function isAnimeMetaContext(meta = {}, type = '') {
    const normalizedType = String(type || '').toLowerCase();
    return Boolean(meta?.kitsu_id || meta?.isAnime || normalizedType === 'anime');
}

function hasExplicitSeasonMarker(text = '') {
    return /\b(?:S(?:EASON)?\s*0?\d{1,2}|\d{1,2}x\d{1,3}|STAGIONE\s*0?\d{1,2}|(?:1ST|2ND|3RD|4TH)\s+SEASON)\b/i.test(String(text || ''));
}

function shouldIgnoreAnimeSeason(meta = {}, type = '', title = '') {
    return isAnimeMetaContext(meta, type) && !hasExplicitSeasonMarker(title);
}

function resolveLanguageMode(options = {}) {
    const meta = options.meta && typeof options.meta === 'object' ? options.meta : {};
    const filters = options.filters && typeof options.filters === 'object' ? options.filters : {};
    const type = options.type || '';
    const animeDefault = options.animeDefault || 'all';
    const fallback = options.fallback || 'ita';
    const allowMeta = options.allowMeta !== false;
    const allowDedupeFallback = options.allowDedupeFallback === true;

    const explicit = String(
        options.language
        || options.langMode
        || filters.language
        || ''
    ).toLowerCase();

    const metaMode = allowMeta
        ? String(meta.langMode || meta.languageMode || meta.language || '').toLowerCase()
        : '';

    if (isAnimeMetaContext(meta, type)) {
        if (explicit == 'eng' || metaMode == 'eng') return 'eng';
        return animeDefault;
    }

    if (metaMode === 'ita' || metaMode === 'eng' || metaMode === 'all') return metaMode;
    if (explicit === 'ita' || explicit === 'eng' || explicit === 'all') return explicit;

    const allowEng = options.allowEng === true || filters.allowEng === true;
    if (allowEng) return 'all';
    if (allowDedupeFallback && !explicit && fallback === 'ita') return 'all';
    return fallback;
}

module.exports = {
    normalizeLooseTitle,
    tokenizeTitle,
    isAnimeMetaContext,
    hasExplicitSeasonMarker,
    shouldIgnoreAnimeSeason,
    resolveLanguageMode
};
