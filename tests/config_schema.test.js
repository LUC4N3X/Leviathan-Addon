const test = require('node:test');
const assert = require('node:assert/strict');

const { CURRENT_CONFIG_VERSION, validateAndNormalizeConfig } = require('../core/config/schema');

test('legacy config is migrated to the current schema version', () => {
  const config = validateAndNormalizeConfig({
    filters: {
      enableVix: true,
      allowEng: true,
      maxPerQuality: '5',
      providers: 'torrentio,knaben'
    }
  });

  assert.equal(config.configVersion, CURRENT_CONFIG_VERSION);
  assert.equal(config.filters.enableStreamingCommunity, true);
  assert.equal(config.filters.vixLast, false);
  assert.equal(config.filters.language, 'all');
  assert.deepEqual(config.filters.providers, ['torrentio', 'knaben']);
  assert.equal(config.filters.maxPerQuality, 5);
});

test('invalid service and malformed numeric filters are discarded safely', () => {
  const config = validateAndNormalizeConfig({
    service: 'invalid-service',
    filters: {
      language: 'zzz',
      maxSeeders: 'abc'
    }
  });

  assert.equal(config.service, undefined);
  assert.equal(config.filters.language, 'ita');
  assert.equal(config.filters.maxSeeders, undefined);
});
