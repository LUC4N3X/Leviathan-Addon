'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    applyPerceptualDedupe,
    simhash,
    hamming,
    tokenize
} = require('../core/stream/perceptual_dedupe');

function fp(item) {
    return simhash(tokenize(item).weights);
}

test('simhash is stable and near-identical signatures stay within a small hamming distance', () => {
    const a = fp({ title: 'Dune Part Two 2024 1080p WEB-DL ITA ENG x264 NAHOM' });
    const b = fp({ title: 'Dune.Part.Two.2024.1080p.WEBDL.iTA.ENG.h264-NAHOM' });
    const c = fp({ title: 'The Batman 2022 1080p WEB-DL ITA ENG x264 OTHER' });

    assert.equal(typeof a, 'bigint');
    assert.ok(hamming(a, b) <= 3, `expected near-duplicate distance <= 3, got ${hamming(a, b)}`);
    assert.ok(hamming(a, c) > hamming(a, b), 'different titles must be further apart');
});

test('cosmetic filename variants of the same release are merged across providers', () => {
    const items = [
        {
            title: 'Dune Part Two 2024 1080p WEB-DL ITA ENG x264 NAHOM',
            sizeBytes: 4_200_000_000,
            seeders: 8,
            source: 'StreamingCommunity'
        },
        {
            title: 'Dune.Part.Two.2024.1080p.WEB-DL.iTA.ENG.x264-NAHOM',
            sizeBytes: 4_205_000_000,
            seeders: 20,
            source: 'CB01'
        }
    ];

    const { items: out, stats } = applyPerceptualDedupe(items, { mode: 'conservative' });
    assert.equal(out.length, 1);
    assert.equal(stats.merged, 1);
    assert.equal(stats.groups, 1);
    assert.ok(out[0]._perceptualDedupe);
    assert.deepEqual(
        [...out[0]._dedupeMergedSources].sort(),
        ['CB01', 'StreamingCommunity']
    );
});

test('different infohashes are never collapsed even when filenames match', () => {
    const items = [
        {
            title: 'Inception 2010 1080p BluRay x264 GROUP',
            infoHash: 'a'.repeat(40),
            sizeBytes: 8_000_000_000,
            source: 'Knaben'
        },
        {
            title: 'Inception 2010 1080p BluRay x264 GROUP',
            infoHash: 'b'.repeat(40),
            sizeBytes: 8_000_000_000,
            source: '1337x'
        }
    ];

    const { items: out, stats } = applyPerceptualDedupe(items, { mode: 'conservative' });
    assert.equal(out.length, 2);
    assert.equal(stats.merged, 0);
});

test('different resolutions stay separate via partitioning', () => {
    const items = [
        { title: 'Oppenheimer 2023 2160p WEB-DL ITA ENG x265 GRP', sizeBytes: 20_000_000_000, source: 'A' },
        { title: 'Oppenheimer 2023 1080p WEB-DL ITA ENG x265 GRP', sizeBytes: 6_000_000_000, source: 'B' }
    ];

    const { items: out } = applyPerceptualDedupe(items, { mode: 'conservative' });
    assert.equal(out.length, 2);
});

test('size guardrail blocks merging releases that differ wildly in size', () => {
    const items = [
        { title: 'Avatar 2009 1080p WEB-DL ITA x264 GRP', sizeBytes: 2_000_000_000, source: 'A' },
        { title: 'Avatar 2009 1080p WEB-DL ITA x264 GRP', sizeBytes: 18_000_000_000, source: 'B' }
    ];

    const { items: out } = applyPerceptualDedupe(items, { mode: 'conservative' });
    assert.equal(out.length, 2);
});

test('saved-cloud and forced-keep entries are never merged away', () => {
    const items = [
        { title: 'Tenet 2020 1080p WEB-DL ITA x264 GRP', sizeBytes: 5_000_000_000, source: 'A', isSavedCloud: true },
        { title: 'Tenet.2020.1080p.WEB-DL.iTA.x264-GRP', sizeBytes: 5_010_000_000, source: 'B' }
    ];

    const { items: out } = applyPerceptualDedupe(items, { mode: 'conservative' });
    assert.equal(out.length, 2);
});

test('audit mode reports groups without removing items', () => {
    const items = [
        { title: 'Heat 1995 1080p BluRay x264 GROUP ITA ENG', sizeBytes: 9_000_000_000, source: 'A' },
        { title: 'Heat.1995.1080p.BluRay.x264-GROUP.iTA.ENG', sizeBytes: 9_020_000_000, source: 'B' }
    ];

    const { items: out, stats } = applyPerceptualDedupe(items, { mode: 'audit' });
    assert.equal(out.length, 2);
    assert.equal(stats.groups, 1);
    assert.ok(out.every((item) => item._perceptualDedupeAudit));
});

test('audit mode preserves original order for non-contiguous clusters', () => {
    const items = [
        { title: 'Sicario 2015 1080p BluRay x264 GROUP ITA ENG', sizeBytes: 9_000_000_000, source: 'A' },
        { title: 'A Completely Different Film 2018 1080p BluRay x264 OTHER ITA ENG', sizeBytes: 7_000_000_000, source: 'X' },
        { title: 'Sicario.2015.1080p.BluRay.x264-GROUP.iTA.ENG', sizeBytes: 9_020_000_000, source: 'B' }
    ];

    const { items: out, stats } = applyPerceptualDedupe(items, { mode: 'audit' });
    assert.equal(out.length, 3);
    assert.equal(stats.groups, 1);
    assert.equal(out[0].source, 'A');
    assert.equal(out[1].source, 'X');
    assert.equal(out[2].source, 'B');
    assert.ok(out[0]._perceptualDedupeAudit);
    assert.ok(out[2]._perceptualDedupeAudit);
    assert.equal(out[1]._perceptualDedupeAudit, undefined);
    const kept = out.filter((item) => item._perceptualDedupeAudit?.wouldKeep);
    assert.equal(kept.length, 1);
});

test('off mode is a no-op passthrough', () => {
    const items = [
        { title: 'Same Movie 2020 1080p WEB-DL ITA x264 GRP', sizeBytes: 4_000_000_000, source: 'A' },
        { title: 'Same.Movie.2020.1080p.WEB-DL.iTA.x264-GRP', sizeBytes: 4_010_000_000, source: 'B' }
    ];

    const { items: out, stats } = applyPerceptualDedupe(items, { mode: 'off' });
    assert.equal(out.length, 2);
    assert.equal(stats.mode, 'off');
});

test('same-episode cosmetic duplicates merge while different fileIdx stays separate', () => {
    const meta = { isSeries: true, season: 1, episode: 1 };
    const cosmetic = [
        { title: 'Show S01E01 1080p WEB-DL ITA x264 GROUP', season: 1, episode: 1, sizeBytes: 1_500_000_000, source: 'A' },
        { title: 'Show.S01E01.1080p.WEB-DL.iTA.x264-GROUP', season: 1, episode: 1, sizeBytes: 1_510_000_000, source: 'B' }
    ];
    const cosmeticOut = applyPerceptualDedupe(cosmetic, { mode: 'conservative', meta });
    assert.equal(cosmeticOut.items.length, 1);

    const distinctFiles = [
        { title: 'Show Pack S01 1080p WEB-DL ITA x264 GROUP', season: 1, episode: 1, fileIdx: 3, infoHash: 'c'.repeat(40), sizeBytes: 1_500_000_000, source: 'A' },
        { title: 'Show Pack S01 1080p WEB-DL ITA x264 GROUP', season: 1, episode: 1, fileIdx: 7, infoHash: 'c'.repeat(40), sizeBytes: 1_500_000_000, source: 'B' }
    ];
    const distinctOut = applyPerceptualDedupe(distinctFiles, { mode: 'conservative', meta });
    assert.equal(distinctOut.items.length, 2);
});
