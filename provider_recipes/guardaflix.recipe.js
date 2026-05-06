'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'guardaflix',
    key: 'guardaFlix',
    name: 'GuardaFlix',
    aliases: ['GuardaFlix', 'webGf'],
    tags: ['movie', 'web', 'lazy-extraction'],
    selectors: {
        resultItems: '[data-provider-result], .movie-card, .result-item, article',
        title: '[data-title], .title, .name, h2, h3',
        href: 'a@href',
        year: '.year, .date, [data-year]',
        quality: '.quality, [data-quality]',
        language: '.language, [data-language]'
    },
    parsing: {
        titleCleaner: 'standardMovieTitle',
        episodePolicy: 'movie-only',
        languagePolicy: 'ita-preferred',
        resolverPolicy: 'lazy-direct-first'
    },
    fallback: [
        { id: 'direct-slug', stopOnHit: true },
        { id: 'site-search', stopOnHit: true },
        { id: 'provider-cache', stopOnHit: false }
    ],
    timeouts: { searchMs: 7000, detailMs: 8000, resolveMs: 12000 }
});
