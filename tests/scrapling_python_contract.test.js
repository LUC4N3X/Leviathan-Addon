'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.resolve(__dirname, '..', 'providers', 'utils', 'cloudflare_bypass.js');

function extractScraplingScript() {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const marker = 'const SCRAPLING_PYTHON = String.raw`';
    const start = src.indexOf(marker);
    assert.notEqual(start, -1, 'SCRAPLING_PYTHON block not found');
    const bodyStart = start + marker.length;
    const end = src.indexOf('`', bodyStart);
    assert.notEqual(end, -1, 'SCRAPLING_PYTHON block is not terminated');
    return src.slice(bodyStart, end);
}

const script = extractScraplingScript();

test('embedded scrapling script keeps the StealthyFetcher entrypoint', () => {
    assert.match(script, /from scrapling\.fetchers import StealthyFetcher/);
    assert.match(script, /StealthyFetcher\.fetch\(/);
    assert.match(script, /solve_cloudflare/);
});

test('embedded scrapling script declares every argument the runner passes', () => {
    const declared = new Set();
    const re = /add_argument\('(--[a-z-]+|[a-z]+)'/g;
    let match;
    while ((match = re.exec(script))) declared.add(match[1]);

    for (const expected of ['url', '--method', '--data', '--headers', '--timeout', '--wait-until']) {
        assert.ok(declared.has(expected), `runner passes ${expected} but the python script does not declare it`);
    }
});

test('embedded scrapling script always emits a structured json status', () => {
    assert.match(script, /def emit\(payload, code=0\):/);
    assert.match(script, /print\(json\.dumps\(/);
    assert.match(script, /'status': 'ok'/);
    assert.match(script, /'status': 'error'/);
    for (const field of ['code', 'url', 'html', 'headers', 'cookies', 'userAgent', 'requestHeaders']) {
        assert.ok(script.includes(`'${field}'`), `success payload is missing the ${field} field`);
    }
});

test('embedded scrapling script fails closed when scrapling is not installed', () => {
    assert.match(script, /scrapling_not_available/);
});
