'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'animeworld',
    key: 'animeWorld',
    name: 'AnimeWorld',
    aliases: ['AnimeWorld', 'webAw'],
    tags: ['anime', 'web', 'episode-aware'],
    selectors: {
        resultItems: '[data-provider-result], .film-list .item, .server-item',
        title: '[data-title], .name, .title, h3',
        href: 'a@href',
        year: '.year, .date',
        quality: '.quality, [data-quality]',
        language: '.language, [data-language]'
    },
    parsing: {
        titleCleaner: 'animeTitle',
        episodePolicy: 'absolute-or-season-strict',
        languagePolicy: 'ita-jpn-aware',
        requireProviderProof: true,
        supportsKitsu: true
    },
    fallback: [
        { id: 'kitsu-id-search', stopOnHit: true },
        { id: 'absolute-episode-search', stopOnHit: true },
        { id: 'provider-cache', stopOnHit: false }
    ],
    reliability: { initial: 'excellent', decayOn: ['selector_miss', 'wrong_episode'] }
});
