const test = require('node:test');
const assert = require('node:assert/strict');

const {
    evaluateExpression,
    selectStreamsByCollectionExpression,
    evaluateCollectionExpression
} = require('../core/policies/stream_expression');

function makeStreams() {
    return [
        { title: '1080p WEB-DL ITA', seeders: 100 },
        { title: '1080p BluRay ITA', seeders: 80 },
        { title: '1080p WEBRip ENG', seeders: 60 },
        { title: '1080p HDTV', seeders: 40 },
        { title: '1080p REMUX', seeders: 20 },
        { title: '1080p x265', seeders: 10 },
        { title: '720p WEB ITA', seeders: 5 },
        { title: '720p HDTV', seeders: 2 }
    ];
}

test('per-item expressions keep their original boolean behaviour', () => {
    assert.equal(evaluateExpression('resolution("1080p")', { title: 'Movie 1080p WEB-DL' }), true);
    assert.equal(evaluateExpression('resolution("4k")', { title: 'Movie 1080p WEB-DL' }), false);
    assert.equal(evaluateExpression('seeders >= 50', { title: 'x', seeders: 60 }), true);
});

test('count() over a filtered collection returns the subset size', () => {
    const streams = makeStreams();
    const result = evaluateCollectionExpression(streams, 'count(resolution(streams, "1080p"))');
    assert.equal(result, 6);
});

test('ternary prunes 720p only when more than five 1080p exist', () => {
    const streams = makeStreams();
    const expr = 'count(resolution(streams, "1080p")) > 5 ? resolution(streams, "720p") : false';
    const { results, removed } = selectStreamsByCollectionExpression(streams, expr);
    assert.equal(removed, 2);
    assert.equal(results.every((s) => !/720p/.test(s.title)), true);
});

test('ternary keeps 720p when the 1080p threshold is not met', () => {
    const streams = makeStreams().slice(0, 3).concat(makeStreams().slice(6)); // 3x 1080p + 2x 720p
    const expr = 'count(resolution(streams, "1080p")) > 5 ? resolution(streams, "720p") : false';
    const { results, removed } = selectStreamsByCollectionExpression(streams, expr);
    assert.equal(removed, 0);
    assert.equal(results.length, streams.length);
});

test('a non-array / boolean result is a safe no-op (never drops everything)', () => {
    const streams = makeStreams();
    const { results, removed } = selectStreamsByCollectionExpression(streams, 'count(streams) > 0');
    assert.equal(removed, 0);
    assert.equal(results.length, streams.length);
});

test('malformed expressions do not throw and prune nothing', () => {
    const streams = makeStreams();
    const { results, removed } = selectStreamsByCollectionExpression(streams, 'count(((', {}, { logger: { warn() {} } });
    assert.equal(removed, 0);
    assert.equal(results.length, streams.length);
});
