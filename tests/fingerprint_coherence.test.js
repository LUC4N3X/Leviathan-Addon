'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    IMPIT_BROWSER_VERSIONS,
    IMPIT_CEILING,
    evaluateUserAgents,
    ceilingFromImpitVersions
} = require('../core/security/fingerprint_manifest');
const { scanRepoUserAgents } = require('../core/security/fingerprint_scan');
const { CANONICAL_BROWSER_PROFILES } = require('../core/security/browser_profiles');

const REPO_ROOT = path.resolve(__dirname, '..');

test('impit ceiling is derived from the supported impit browser versions', () => {
    const derived = ceilingFromImpitVersions(IMPIT_BROWSER_VERSIONS);
    assert.equal(IMPIT_CEILING.chrome, derived.chrome);
    assert.equal(IMPIT_CEILING.firefox, derived.firefox);
    assert.equal(IMPIT_CEILING.edge, derived.edge);
    assert.equal(IMPIT_CEILING.edge, IMPIT_CEILING.chrome);
});

test('canonical browser profiles never exceed the impit tls ceiling', () => {
    const result = evaluateUserAgents(CANONICAL_BROWSER_PROFILES.map((profile) => profile.userAgent));
    assert.deepEqual(result.violations, []);
    assert.ok(result.ok);
});

test('every hardcoded user agent in core and providers matches the impit tls ceiling', () => {
    const violations = scanRepoUserAgents(REPO_ROOT);
    const report = violations.map((item) => `${item.file}: ${item.family} expected ${item.expected}, found ${item.found}`);
    assert.deepEqual(report, []);
});
