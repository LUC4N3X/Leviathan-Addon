'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    annotateEpisodeTruth,
    evaluateEpisodeTruth,
    formatEpisodeTruthLog
} = require('../core/matching/episode_truth_engine');

test('episode truth accepts exact episode with explainable decision', () => {
    const truth = evaluateEpisodeTruth(
        { title: 'FROM S01E07 1080p WEB-DL ITA' },
        { title: 'FROM', season: 1, episode: 7, isSeries: true }
    );

    assert.equal(truth.ok, true);
    assert.equal(truth.type, 'exact_episode');
    assert.ok(truth.confidence >= 0.9);
    assert.ok(truth.reasons.includes('explicit_episode_marker'));
});

test('episode truth rejects wrong explicit episode marker', () => {
    const truth = evaluateEpisodeTruth(
        { title: 'FROM S01E04 1080p WEB-DL ITA' },
        { title: 'FROM', season: 1, episode: 7, isSeries: true }
    );

    assert.equal(truth.ok, false);
    assert.equal(truth.type, 'episode_mismatch_risk');
    assert.ok(truth.penalties.includes('wrong_explicit_episode_marker_detected'));
});

test('episode truth accepts season pack when file list proves requested episode', () => {
    const item = {
        title: 'Jujutsu Kaisen S02 Pack 1080p',
        files: [
            { id: 1, path: '/Season 02/Jujutsu.Kaisen.S02E16.mkv', bytes: 700000000 },
            { id: 2, path: '/Season 02/Jujutsu.Kaisen.S02E17.mkv', bytes: 800000000 }
        ]
    };

    const annotated = annotateEpisodeTruth(item, { title: 'Jujutsu Kaisen', season: 2, episode: 17, isSeries: true });

    assert.equal(annotated._episodeTruthOk, true);
    assert.equal(annotated._episodeTruthType, 'season_pack_file_match');
    assert.equal(annotated._episodeTruth.fileHint.fileIndex, 2);
    assert.match(formatEpisodeTruthLog(annotated._episodeTruth), /\[EPISODE TRUTH\] accept/);
});
