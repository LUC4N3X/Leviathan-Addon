'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'altadefinizione',
    key: 'altadefinizione',
    name: 'AltadefinizioneStreaming',
    aliases: ['AltadefinizioneStreaming', 'AltaDefinizione', 'webAds'],
    baseUrls: ['https://altadefinizionestreaming.com'],
    tags: ['movie', 'series', 'web', 'vidxgo', 'direct-first', 'lazy-extraction'],
    search: {
        method: 'GET',
        path: '/api/player-sources/{type}/{tmdbId}'
    },
    selectors: {
        resultItems: 'sources[]',
        title: 'provider',
        href: 'url',
        quality: 'quality',
        language: 'language'
    },
    parsing: {
        titleCleaner: 'standardMovieTitle',
        episodePolicy: 'tmdb-season-episode',
        languagePolicy: 'ita-preferred',
        resolverPolicy: 'vidxgo-first-local-then-lazy',
        resultLimit: 8,
        headerMode: 'manual'
    },
    antiBot: {
        mode: 'api-direct',
        proxy: 'disabled-by-default',
        sessionReuse: false
    },
    fallback: [
        { id: 'vidxgo-imdb-direct', stopOnHit: false },
        { id: 'player-sources-api', stopOnHit: true },
        { id: 'download-api-hoster', stopOnHit: false },
        { id: 'provider-cache', stopOnHit: false }
    ],
    timeouts: { searchMs: 6000, detailMs: 7000, resolveMs: 12000 },
    reliability: { initial: 'good', decayOn: ['api_empty', 'hoster_unresolved', 'timeout'] }
});
