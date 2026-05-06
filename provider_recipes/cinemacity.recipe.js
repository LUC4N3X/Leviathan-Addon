'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'cinemacity',
    key: 'cinemaCity',
    name: 'CinemaCity',
    aliases: ['CinemaCity', 'CinemaCityV3', 'webCc'],
    tags: ['movie', 'series', 'web', 'direct-first', 'lazy-extraction'],
    selectors: {
        resultItems: '[data-provider-result], .movie-item, .result-item, article',
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
        gotAttempts: 2,
        headerMode: 'manual'
    },
    antiBot: {
        mode: 'direct-first',
        proxy: 'disabled-by-default',
        sessionReuse: true
    },
    fallback: [
        { id: 'direct-slug', stopOnHit: true },
        { id: 'site-search', stopOnHit: true },
        { id: 'episode-candidate-search', stopOnHit: true },
        { id: 'provider-cache', stopOnHit: false }
    ],
    timeouts: { searchMs: 7000, detailMs: 8000, resolveMs: 12000 },
    reliability: { initial: 'excellent', decayOn: ['selector_miss', 'wrong_episode', 'slow_resolve'] }
});
