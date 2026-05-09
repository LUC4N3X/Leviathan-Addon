'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'guardahd',
    key: 'guardaHD',
    name: 'GuardaHD',
    aliases: ['GuardaHD', 'webGhd'],
    tags: ['movie', 'series', 'web', 'lazy-extraction'],
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
        episodePolicy: 'strict-season-episode-or-pack',
        languagePolicy: 'ita-preferred',
        resolverPolicy: 'lazy-direct-first',
        hosterPolicy: {
            mixdrop: 'direct-first-no-proxy-when-possible',
            default: 'proxy-only-on-block'
        }
    },
    antiBot: {
        mode: 'direct-first',
        proxy: 'only-on-block',
        sessionReuse: true
    },
    fallback: [
        { id: 'direct-slug', stopOnHit: true },
        { id: 'site-search', stopOnHit: true },
        { id: 'episode-candidate-search', stopOnHit: true },
        { id: 'provider-cache', stopOnHit: false }
    ],
    timeouts: { searchMs: 7000, detailMs: 9000, resolveMs: 12000 }
});
