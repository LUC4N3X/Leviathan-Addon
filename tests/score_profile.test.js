'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    evaluateLeviathanScore,
    formatRankExplain,
    rankWithLeviathanScore
} = require('../core/ranking/score_profile');

test('leviathan score profile explains resolution language rd seed provider and episode truth', () => {
    const item = {
        title: 'FROM S01E07 2160p WEB-DL ITA',
        source: 'Torrentio',
        seeders: 42,
        _rdCacheState: 'cached',
        fileIdx: 4
    };

    const scored = evaluateLeviathanScore(item, { title: 'FROM', season: 1, episode: 7, isSeries: true });

    assert.ok(scored.finalScore > 100);
    assert.ok(scored.explain.some((entry) => entry.includes('resolution=2160p')));
    assert.ok(scored.explain.some((entry) => entry.includes('language=ita')));
    assert.ok(scored.explain.some((entry) => entry.includes('rdStatus=cached')));
    assert.equal(scored.episodeTruth.type, 'exact_episode');
});

test('leviathan score profile ranks stronger stream first', () => {
    const ranked = rankWithLeviathanScore([
        { title: 'FROM S01E07 720p ENG', source: 'DB', seeders: 0, _rdCacheState: 'unknown' },
        { title: 'FROM S01E07 1080p ITA', source: 'Altadefinizione', seeders: 12, _rdCacheState: 'likely_cached' }
    ], { title: 'FROM', season: 1, episode: 7, isSeries: true });

    assert.equal(ranked[0].source, 'Altadefinizione');
    assert.match(formatRankExplain(ranked[0]), /\[RANK EXPLAIN\]/);
});

test('leviathan score profile penalizes explicit episode mismatch', () => {
    const scored = evaluateLeviathanScore(
        { title: 'FROM S01E04 1080p ITA', source: 'Altadefinizione', seeders: 10, _rdCacheState: 'cached' },
        { title: 'FROM', season: 1, episode: 7, isSeries: true }
    );

    assert.equal(scored.episodeTruth.ok, false);
    assert.equal(scored.episodeTruth.type, 'episode_mismatch_risk');
    assert.ok(scored.explain.some((entry) => entry.includes('episodeTruth=episode_mismatch_risk')));
});

test('leviathan score profile rewards cross-provider consensus evidence', () => {
    const single = evaluateLeviathanScore(
        { title: 'FROM S01E07 1080p ITA', source: 'Torrentio', _rdCacheState: 'likely_cached' },
        { title: 'FROM', season: 1, episode: 7, isSeries: true }
    );
    const consensus = evaluateLeviathanScore(
        {
            title: 'FROM S01E07 1080p ITA',
            source: 'Torrentio',
            _rdCacheState: 'likely_cached',
            _dedupeMergedSources: ['Torrentio', 'MediaFusion', 'DB'],
            _dedupeMergedCount: 3
        },
        { title: 'FROM', season: 1, episode: 7, isSeries: true }
    );

    assert.ok(consensus.finalScore > single.finalScore);
    assert.ok(consensus.explain.some((entry) => entry.includes('sourceConsensus=strong_consensus')));
});

test('torrent intelligence rewards exact cached Italian WEB-DL episode and explains it', () => {
    const scored = evaluateLeviathanScore(
        {
            title: 'FROM.S01E07.1080p.WEB-DL.ITA.ENG.x265-GRP.mkv',
            source: 'Torrentio',
            seeders: 20,
            _rdCacheState: 'cached',
            cached_rd: true,
            fileIdx: 2
        },
        { title: 'FROM', season: 1, episode: 7, isSeries: true },
        { ranking: { useTorrentIntelligenceRanking: true, torrentIntelligenceWeight: 1 } }
    );

    assert.ok(scored.torrentIntelligence.score > 80);
    assert.equal(scored.torrentIntelligence.features.episodeMatch, 'exact');
    assert.ok(scored.explain.some((entry) => entry.includes('torrentIntelligence=')));
});
