'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildForwardProxyUrl,
  getForwardProxyBase,
  requireForwardProxyBase
} = require('../core/proxy/forward_proxy_config');

function withEnvironment(values, fn) {
  const previous = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('reads the single FORWARD_PROXY environment variable', () => {
  withEnvironment({
    FORWARD_PROXY: 'https://proxy.example/forward?url=',
    FORWARDPROXY: 'https://legacy.example/forward?url='
  }, () => {
    assert.equal(getForwardProxyBase(), 'https://proxy.example/forward?url=');
  });
});

test('does not use legacy forward proxy aliases', () => {
  withEnvironment({
    FORWARD_PROXY: undefined,
    FORWARDPROXY: 'https://legacy.example/forward?url=',
    CB01_FORWARD_PROXY: 'https://cb01.example/forward?url='
  }, () => {
    assert.equal(getForwardProxyBase(), '');
  });
});

test('builds an encoded forward proxy URL and appends query parameters', () => {
  withEnvironment({
    FORWARD_PROXY: 'https://proxy.example/forward?url='
  }, () => {
    const result = buildForwardProxyUrl('https://target.example/watch?a=1&b=2', {
      context: 'test',
      params: {
        'h_user-agent': 'Leviathan Test',
        h_referer: 'https://target.example/'
      }
    });

    assert.equal(
      result,
      'https://proxy.example/forward?url=https%3A%2F%2Ftarget.example%2Fwatch%3Fa%3D1%26b%3D2&h_user-agent=Leviathan+Test&h_referer=https%3A%2F%2Ftarget.example%2F'
    );
  });
});

test('supports a url placeholder endpoint', () => {
  withEnvironment({
    FORWARD_PROXY: 'https://proxy.example/fetch/{url}'
  }, () => {
    assert.equal(
      buildForwardProxyUrl('https://target.example/path', { context: 'test' }),
      'https://proxy.example/fetch/https%3A%2F%2Ftarget.example%2Fpath'
    );
  });
});

test('throws a configuration error when FORWARD_PROXY is missing', () => {
  withEnvironment({ FORWARD_PROXY: undefined }, () => {
    assert.throws(
      () => requireForwardProxyBase('test'),
      (error) => error.code === 'FORWARD_PROXY_CONFIG_ERROR' && /FORWARD_PROXY/.test(error.message)
    );
  });
});

test('throws a configuration error for malformed proxy and target URLs', () => {
  withEnvironment({ FORWARD_PROXY: 'not-a-url' }, () => {
    assert.throws(
      () => getForwardProxyBase(),
      (error) => error.code === 'FORWARD_PROXY_CONFIG_ERROR'
    );
  });

  withEnvironment({ FORWARD_PROXY: 'https://proxy.example/forward?url=' }, () => {
    assert.throws(
      () => buildForwardProxyUrl('javascript:alert(1)', { context: 'test' }),
      (error) => error.code === 'FORWARD_PROXY_CONFIG_ERROR'
    );
  });
});
