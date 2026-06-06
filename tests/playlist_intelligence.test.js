'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    decorateStreamWithPlaylistIntelligence,
    extractPlaylistIntelligence
} = require('../providers/utils/playlist_intelligence');

test('playlist intelligence extracts alternate audio languages from HLS media tracks', () => {
    const playlist = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Italian",LANGUAGE="it",DEFAULT=YES,AUTOSELECT=YES,URI="ita.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="eng.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=6500000,RESOLUTION=1920x1080,AUDIO="audio"',
        '1080p.m3u8'
    ].join('\n');

    const intelligence = extractPlaylistIntelligence(playlist);

    assert.deepEqual(intelligence.audioLanguages, ['eng', 'ita']);
    assert.equal(intelligence.isMultiAudio, true);
});

test('playlist decorator keeps playlist languages on top-level stream metadata', () => {
    const stream = {
        title: 'Movie',
        quality: '1080p',
        audioLanguages: ['ita'],
        behaviorHints: {
            vortexMeta: {
                audioLanguages: ['ita']
            }
        }
    };

    const decorated = decorateStreamWithPlaylistIntelligence(stream, {
        quality: '1080p',
        height: 1080,
        audioLanguages: ['eng'],
        subtitleLanguages: [],
        variantCount: 1,
        confidence: 0.9
    });

    assert.deepEqual(decorated.audioLanguages, ['ita', 'eng']);
    assert.deepEqual(decorated.behaviorHints.vortexMeta.audioLanguages, ['ita', 'eng']);
    assert.equal(decorated.isMultiAudio, true);
    assert.equal(decorated.behaviorHints.vortexMeta.isMultiAudio, true);
});
