'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractVoe, isVoeUrl, normalizeVoeEmbedUrl, pickBest } = require('../providers/extractors/hosters/voe');
const { resolveExtractorDefinition } = require('../providers/extractors/registry');

test('VOE domain matcher accepts canonical and rotating aliases', () => {
  assert.equal(isVoeUrl('https://voe.sx/e/demo'), true);
  assert.equal(isVoeUrl('https://crystaltreatmenteast.com/wnnov1m62xzy'), true);
  assert.equal(isVoeUrl('https://example.com/e/demo'), false);
});

test('VOE normalizer converts file page to embed page', () => {
  assert.equal(normalizeVoeEmbedUrl('https://voe.sx/abc123'), 'https://voe.sx/e/abc123');
  assert.equal(normalizeVoeEmbedUrl('https://voe.sx/e/abc123'), 'https://voe.sx/e/abc123');
});

test('VOE is registered in the extractor registry', () => {
  const definition = resolveExtractorDefinition('https://voe.sx/e/abc123');
  assert.equal(definition?.key, 'voe');
});

test('VOE picks hls over mp4 and skips thumbnails/assets', () => {
  assert.equal(
    pickBest([
      'https://cdn.example/poster.jpg',
      'https://cdn.example/video.mp4',
      'https://cdn.example/master.m3u8'
    ]),
    'https://cdn.example/master.m3u8'
  );
});

test('VOE extractor resolves direct media candidates from page html', async () => {
  const client = {
    async get(url) {
      if (String(url).includes('.m3u8')) {
        return { status: 200, data: '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nchunk.m3u8', headers: {} };
      }
      return {
        status: 200,
        data: `<html><script>const file = 'https://media.example/hls/master.m3u8';</script></html>`,
        headers: {}
      };
    }
  };

  const result = await extractVoe('https://voe.sx/e/abc123', { client, probeTimeout: 10 });
  assert.equal(result.url, 'https://media.example/hls/master.m3u8');
  assert.equal(result.extractor, 'VOE');
  assert.equal(result.quality, '1080p');
});
