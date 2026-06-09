'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateQualityIntelligence } = require('../core/ranking/quality_intelligence');
const { rankAndFilterResults } = require('../core/lib/result_ranker');

test('quality intelligence extracts release, codec, hdr, audio, channels and provider tags', () => {
    const quality = evaluateQualityIntelligence({
        title: 'Dune.Part.Two.2024.2160p.AMZN.WEB-DL.DV.HDR10Plus.ITA.ENG.DDP.Atmos.5.1.x265-GRP.mkv',
        size: '18.5 GB'
    }, { title: 'Dune Part Two', year: 2024 });

    assert.equal(quality.releaseSource, 'webdl');
    assert.equal(quality.codec, 'x265');
    assert.equal(quality.hdr, 'dolby_vision');
    assert.equal(quality.audio, 'ddp_atmos');
    assert.equal(quality.channels, '5.1');
    assert.deepEqual(quality.providerTags, ['amazon']);
    assert.ok(quality.score > 40);
    assert.ok(quality.badges.includes('WEBDL'));
});

test('quality intelligence heavily penalizes cam, sample and watermark bait', () => {
    const quality = evaluateQualityIntelligence({
        title: 'Movie.2024.1080p.HDCAM.1XBET.Sample.Bad.Audio.mkv',
        size: '300 MB'
    }, { title: 'Movie', year: 2024 });

    assert.equal(quality.releaseSource, 'cam');
    assert.ok(quality.riskFlags.includes('cam'));
    assert.ok(quality.riskFlags.includes('sample_or_extra'));
    assert.ok(quality.riskFlags.includes('spam_watermark'));
    assert.ok(quality.score < -250);
});

test('rich quality ranking prefers WEB-DL x265 DDP over same resolution weak release', () => {
    const ranked = rankAndFilterResults([
        { title: 'Movie 1080p WEBRip ITA x264 AAC 2.0', source: 'Torrentio', seeders: 20, size: '2.5 GB' },
        { title: 'Movie 1080p WEB-DL ITA x265 DDP 5.1 AMZN', source: 'Torrentio', seeders: 20, size: '3.2 GB' }
    ], { title: 'Movie', year: 2024 }, { filters: { language: 'ita' } });

    assert.equal(ranked[0].title, 'Movie 1080p WEB-DL ITA x265 DDP 5.1 AMZN');
    assert.ok(ranked[0]._rankMeta.qualityIntelligence.score > ranked[1]._rankMeta.qualityIntelligence.score);
    assert.ok(ranked[0]._reasons.some((reason) => reason.startsWith('QUALITY_INTEL:')));
});
