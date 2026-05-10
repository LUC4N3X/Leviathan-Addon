'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tmdbHelper = require('../core/utils/tmdb_helper');
const { _test } = require('../core/server/routes/admin_routes');

test('manual import preserves explicit TMDB id and resolves it to IMDb', async (t) => {
  const originalGetImdbFromTmdb = tmdbHelper.getImdbFromTmdb;
  t.after(() => {
    tmdbHelper.getImdbFromTmdb = originalGetImdbFromTmdb;
  });

  tmdbHelper.getImdbFromTmdb = async (tmdbId, mediaType) => {
    assert.equal(tmdbId, '799882');
    assert.equal(mediaType, 'movie');
    return 'tt14181714';
  };

  const payload = _test.normalizeManualImportPayload({
    magnet: 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=The.Bluff.2026.1080p',
    title: 'The Bluff 2026 1080p',
    type: 'movie',
    tmdbId: '799882'
  });

  assert.equal(payload.tmdbId, '799882');
  assert.equal(payload.imdbId, null);

  const result = await _test.resolveManualImportIdentity(payload, { warn() {} });
  assert.equal(result.matched, true);
  assert.equal(result.source, 'explicit_tmdb');
  assert.equal(payload.imdbId, 'tt14181714');
  assert.equal(payload.type, 'movie');
});
