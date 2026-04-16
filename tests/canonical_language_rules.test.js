const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLangMode, resolveMetaOrOptionLangMode } = require('../core/canonical/language_rules');

test('anime respects explicit italian mode instead of forcing all', () => {
  const mode = resolveLangMode({
    meta: { kitsu_id: 12345, title: 'One Piece' },
    filters: { language: 'ita', allowEng: false },
    animeDefault: 'all',
    defaultMode: 'ita'
  });
  assert.equal(mode, 'ita');
});

test('anime can still broaden to all when no language was explicitly set', () => {
  const mode = resolveLangMode({
    meta: { kitsu_id: 12345, title: 'One Piece' },
    filters: {},
    animeDefault: 'all',
    defaultMode: 'ita'
  });
  assert.equal(mode, 'all');
});

test('string and boolean compatibility wrapper keeps legacy call sites stable', () => {
  assert.equal(resolveMetaOrOptionLangMode({ title: 'Movie' }, 'eng'), 'eng');
  assert.equal(resolveMetaOrOptionLangMode({ title: 'Movie' }, true), 'all');
  assert.equal(resolveMetaOrOptionLangMode({ title: 'Movie' }, false), 'ita');
});
