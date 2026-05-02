'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSeriesContext, matchesCandidateTitle } = require('../core/matching/episode_matcher');
const { findEpisodeFileHint } = require('../core/matching/season_pack_inspector');

test('series matcher accepts exact episode and rejects wrong franchise extra title', () => {
    const ctx = buildSeriesContext({ cinemetaTitle: 'Dexter', season: 1, episode: 1, search: 'Dexter S01E01' });
    assert.equal(matchesCandidateTitle('Dexter.S01E01.1080p.WEB-DL.mkv', ctx), true);
    assert.equal(matchesCandidateTitle('Dexter Resurrection S01E01 1080p WEB-DL.mkv', ctx), false);
});

test('series matcher accepts season pack for the requested season', () => {
    const ctx = buildSeriesContext({ cinemetaTitle: 'Jujutsu Kaisen', season: 2, episode: 17, search: 'Jujutsu Kaisen S02E17' });
    assert.equal(matchesCandidateTitle('Jujutsu.Kaisen.S02.1080p.WEB-DL.PACK', ctx), true);
    assert.equal(matchesCandidateTitle('Jujutsu.Kaisen.S01.1080p.WEB-DL.PACK', ctx), false);
});

test('season pack inspector returns episodeFileHint for requested episode', () => {
    const hint = findEpisodeFileHint([
        { id: 11, path: '/Jujutsu Kaisen/Season 02/Jujutsu.Kaisen.S02E16.mkv', bytes: 800000000 },
        { id: 12, path: '/Jujutsu Kaisen/Season 02/Jujutsu.Kaisen.S02E17.mkv', bytes: 900000000 }
    ], { title: 'Jujutsu Kaisen', season: 2, episode: 17 });

    assert.equal(hint.fileIndex, 12);
    assert.equal(hint.fileName, 'Jujutsu.Kaisen.S02E17.mkv');
    assert.equal(hint.reason, 'exact_sxxexx');
});
