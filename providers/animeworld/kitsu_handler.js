'use strict';

let provider = null;
let providerUtils = null;

try {
    provider = require('./kitsu_provider');
} catch (_) {
    try {
        provider = require('../animeworld/kitsu_provider');
    } catch (_) {
        provider = null;
    }
}

try {
    providerUtils = require('../anime/provider_utils');
} catch (_) {
    providerUtils = null;
}

class KitsuHandler {
    async getAnimeInfo(kitsuId) {
        if (provider?.getAnimeInfo) return provider.getAnimeInfo(kitsuId);
        if (providerUtils?.getKitsuAnimeInfo) return providerUtils.getKitsuAnimeInfo(kitsuId);
        return null;
    }

    async buildSearchContext(requestId, meta = {}) {
        if (provider?.buildSearchContext) return provider.buildSearchContext(requestId, meta);
        const parsed = this.parseKitsuId(requestId || meta?.id || meta?.kitsu_id || meta?.kitsuId);
        return {
            kitsuId: parsed?.kitsuId || null,
            info: parsed?.kitsuId ? await this.getAnimeInfo(parsed.kitsuId) : null,
            rawTitles: [],
            searchTitles: [],
            title: null,
            date: null,
            year: null,
            seasonNumber: parsed?.seasonNumber ?? null,
            requestedEpisode: parsed?.episodeNumber || 1,
            isMovie: Boolean(parsed?.isMovie)
        };
    }

    parseKitsuId(kitsuIdString) {
        if (provider?.parseKitsuId) return provider.parseKitsuId(kitsuIdString);
        if (providerUtils?.parseKitsuId) return providerUtils.parseKitsuId(kitsuIdString);

        const raw = String(kitsuIdString || '').trim();
        const match = raw.match(/(?:^|[^a-z])kitsu(?::|-|_)?(?:anime:?)?(\d+)(?::(\d+))?(?::(\d+))?/i) || raw.match(/^(\d+)$/);
        if (!match) return null;

        const kitsuId = match[1];
        const maybeSeason = match[3] ? Number.parseInt(match[2], 10) : null;
        const maybeEpisode = match[3] ? Number.parseInt(match[3], 10) : Number.parseInt(match[2] || '', 10);

        return {
            kitsuId,
            seasonNumber: Number.isInteger(maybeSeason) ? maybeSeason : null,
            episodeNumber: Number.isInteger(maybeEpisode) && maybeEpisode > 0 ? maybeEpisode : null,
            isMovie: !maybeEpisode
        };
    }

    normalizeTitle(title) {
        if (provider?.normalizeTitle) return provider.normalizeTitle(title);
        if (providerUtils?.normalizeTitle) return providerUtils.normalizeTitle(title);
        return String(title || '').replace(/\s+/g, ' ').trim();
    }

    buildTitleVariants(titles = []) {
        if (provider?.buildTitleVariants) return provider.buildTitleVariants(titles);
        const input = Array.isArray(titles) ? titles : [titles];
        return [...new Set(input.map((title) => this.normalizeTitle(title)).filter(Boolean))];
    }

    async searchAnimeByTitle(title, options = {}) {
        if (provider?.searchAnimeByTitle) return provider.searchAnimeByTitle(title, options);
        return [];
    }

    async resolveBestByTitle(titles = [], options = {}) {
        if (provider?.resolveBestByTitle) return provider.resolveBestByTitle(titles, options);
        return null;
    }

    extractYear(value) {
        if (provider?.extractYear) return provider.extractYear(value);
        const match = String(value || '').match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : null;
    }

    getCacheStats() {
        if (provider?.getCacheStats) return provider.getCacheStats();
        return {};
    }

    clearCaches() {
        if (provider?.clearCaches) provider.clearCaches();
    }
}

module.exports = new KitsuHandler();
