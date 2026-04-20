'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kitsuProvider = require('../providers/animeworld/kitsu_provider');

test('kitsuProvider.normalizeTitle keeps Vortex-style aliases for known anime', () => {
    assert.equal(kitsuProvider.normalizeTitle('Ore dake Level Up na Ken'), 'Solo Leveling');
    assert.equal(
        kitsuProvider.normalizeTitle('Attack on Titan: The Final Season - Final Chapters Part 2'),
        "L'attacco dei Giganti: L'ultimo attacco"
    );
});

test('kitsuProvider.buildSearchContext prefers parsed Kitsu episode data', async () => {
    const originalGetAnimeInfo = kitsuProvider.getAnimeInfo;
    kitsuProvider.getAnimeInfo = async () => ({
        title: 'Ore dake Level Up na Ken',
        titles: ['Ore dake Level Up na Ken', 'Solo Leveling'],
        date: '2024-01-07',
        subtype: 'TV'
    });

    try {
        const context = await kitsuProvider.buildSearchContext('kitsu:123:2:9', {
            title: 'Solo Leveling',
            episode: 3,
            isSeries: true
        });

        assert.equal(context.kitsuId, '123');
        assert.equal(context.requestedEpisode, 9);
        assert.equal(context.isMovie, false);
        assert.equal(context.year, '2024');
        assert.equal(context.searchTitles[0], 'Solo Leveling');
        assert.deepEqual(context.rawTitles.slice(0, 2), ['Ore dake Level Up na Ken', 'Solo Leveling']);
    } finally {
        kitsuProvider.getAnimeInfo = originalGetAnimeInfo;
    }
});

test('anime handlers no longer depend on provider_utils bridge', () => {
    const awHandler = fs.readFileSync(path.join(__dirname, '..', 'providers', 'animeworld', 'aw_handler.js'), 'utf8');
    const asHandler = fs.readFileSync(path.join(__dirname, '..', 'providers', 'animesaturn', 'as_handler.js'), 'utf8');

    assert.equal(awHandler.includes("require('../anime/provider_utils')"), false);
    assert.equal(asHandler.includes("require('../anime/provider_utils')"), false);
});
