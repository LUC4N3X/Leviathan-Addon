'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    IMPIT_BROWSER_VERSIONS,
    IMPIT_CEILING,
    evaluateUserAgents,
    ceilingFromImpitVersions
} = require('../core/security/fingerprint_manifest');
const { CANONICAL_BROWSER_PROFILES } = require('../core/security/browser_profiles');

test('impit ceiling is derived from the supported impit browser versions', () => {
    const derived = ceilingFromImpitVersions(IMPIT_BROWSER_VERSIONS);
    assert.equal(IMPIT_CEILING.chrome, derived.chrome);
    assert.equal(IMPIT_CEILING.firefox, derived.firefox);
    assert.equal(IMPIT_CEILING.edge, derived.edge);
    assert.equal(IMPIT_CEILING.edge, IMPIT_CEILING.chrome);
});

test('canonical browser profiles never exceed the impit tls ceiling', () => {
    const userAgents = CANONICAL_BROWSER_PROFILES.map((profile) => profile.userAgent);
    const result = evaluateUserAgents(userAgents);
    assert.deepEqual(result.violations, []);
    assert.ok(result.ok);
});

test('curl_cffi user agents stay aligned with the impit tls ceiling', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../providers/utils/cf_curl_cffi.py'), 'utf8');
    const chromeMajors = [...source.matchAll(/Chrome\/(\d+)\.0\.0\.0/g)].map((match) => Number(match[1]));
    const firefoxMajors = [...source.matchAll(/Firefox\/(\d+)\.0/g)].map((match) => Number(match[1]));

    assert.ok(chromeMajors.length > 0);
    for (const major of chromeMajors) assert.equal(major, IMPIT_CEILING.chrome);

    assert.ok(firefoxMajors.length > 0);
    for (const major of firefoxMajors) assert.equal(major, IMPIT_CEILING.firefox);
});
