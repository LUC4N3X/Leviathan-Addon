const test = require('node:test');
const assert = require('node:assert/strict');

const {
    applyConfiguredStreamFilters,
    detectQualityLabel,
    getQualityFilterSignals,
    getTorrentioTrustDedupeKey,
    mergeForcedTorrentioItItems,
    shouldForceKeepTorrentioIt
} = require('../core/stream/quality_filters');

test('quality label detection prefers explicit high resolution markers', () => {
    assert.equal(detectQualityLabel('Movie 2160p UHD'), '4K');
    assert.equal(detectQualityLabel('Movie 1080p WEB-DL'), '1080p');
    assert.equal(detectQualityLabel('unknown release', '720p'), '720p');
});

test('quality filter signals can treat generic HD as 720p only when requested', () => {
    assert.equal(getQualityFilterSignals('Movie HD', { treatGenericHdAs720: true }).has720, true);
    assert.equal(getQualityFilterSignals('Movie HD', { treatGenericHdAs720: false }).has720, true);
    assert.equal(getQualityFilterSignals('Movie FULLHD', { treatGenericHdAs720: true }).has720, false);
});

test('configured stream filters drop blocked quality signals from stream metadata', () => {
    const streams = [
        { title: 'Movie 2160p', behaviorHints: { filename: 'movie.2160p.mkv' } },
        { title: 'Movie 1080p', behaviorHints: { filename: 'movie.1080p.mkv' } }
    ];

    const kept = applyConfiguredStreamFilters(streams, { no4k: true });

    assert.deepEqual(kept.map((stream) => stream.title), ['Movie 1080p']);
});

test('forced Torrentio IT merge preserves protected entries without duplicating keys', () => {
    const kept = [{ hash: 'abc', fileIdx: 1, title: 'Existing 1080p' }];
    const forced = {
        hash: 'def',
        fileIdx: 2,
        title: 'Forced ITA 720p',
        source: 'Torrentio',
        _torrentioLooseItForceKeep: true
    };

    const merged = mergeForcedTorrentioItItems(kept, [kept[0], forced], { no4k: true });

    assert.equal(shouldForceKeepTorrentioIt(forced), true);
    assert.equal(getTorrentioTrustDedupeKey(forced).startsWith('torrentio-force:'), true);
    assert.deepEqual(merged.map((item) => item.title), ['Existing 1080p', 'Forced ITA 720p']);
});
