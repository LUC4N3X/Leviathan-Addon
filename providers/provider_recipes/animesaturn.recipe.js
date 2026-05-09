'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'animesaturn',
    key: 'animeSaturn',
    name: 'AnimeSaturn',
    aliases: ['AnimeSaturn', 'webAs'],
    tags: ['anime', 'web', 'episode-aware'],
    selectors: {
        resultItems: '[data-provider-result], .anime-card, .episode, .server-item',
        title: '[data-title], .title, .name, h3',
        href: 'a@href',
        year: '.year, .date',
        quality: '.quality, [data-quality]',
        language: '.language, [data-language]'
    },
    parsing: {
        titleCleaner: 'animeTitle',
        episodePolicy: 'absolute-or-season-strict',
        languagePolicy: 'ita-jpn-aware',
        requireProviderProof: true
    },
    fallback: [
        { id: 'absolute-episode-search', stopOnHit: true },
        { id: 'title-alias-search', stopOnHit: true },
        { id: 'provider-cache', stopOnHit: false }
    ],
    reliability: { initial: 'good', decayOn: ['selector_miss', 'wrong_episode', 'empty_results'] }
});
