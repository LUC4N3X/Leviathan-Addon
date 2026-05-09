'use strict';

const { webProviderRecipe } = require('./_shared');

module.exports = webProviderRecipe({
    id: 'animeunity',
    key: 'animeUnity',
    name: 'AnimeUnity',
    aliases: ['AnimeUnity', 'webAu'],
    tags: ['anime', 'web', 'no-proxy-preferred'],
    selectors: {
        resultItems: '[data-provider-result], .anime-card, .episode-card, .server-item',
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
        requireProviderProof: true,
        supportsKitsu: true
    },
    antiBot: {
        mode: 'direct-first',
        proxy: 'disabled-by-default',
        sessionReuse: true
    },
    fallback: [
        { id: 'kitsu-id-search', stopOnHit: true },
        { id: 'title-alias-search', stopOnHit: true },
        { id: 'provider-cache', stopOnHit: false }
    ]
});
