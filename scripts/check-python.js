#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const EMBEDDED_SOURCES = [
    path.join('providers', 'utils', 'cloudflare_bypass.js')
];

const STANDALONE_SOURCES = [
    path.join('providers', 'utils', 'cf_curl_cffi.py')
];

function extractEmbedded(relFile) {
    const abs = path.join(ROOT, relFile);
    if (!fs.existsSync(abs)) return [];
    const src = fs.readFileSync(abs, 'utf8');
    const re = /const\s+([A-Z0-9_]+_PYTHON)\s*=\s*String\.raw`/g;
    const blocks = [];
    let match;
    while ((match = re.exec(src))) {
        const start = re.lastIndex;
        const end = src.indexOf('`', start);
        if (end === -1) continue;
        blocks.push({ name: match[1], origin: relFile, body: src.slice(start, end) });
    }
    return blocks;
}

function resolvePython() {
    for (const candidate of [process.env.PYTHON, 'python3', 'python']) {
        if (!candidate) continue;
        const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
        if (!probe.error && probe.status === 0) return candidate;
    }
    return null;
}

function hasRuff() {
    const probe = spawnSync('ruff', ['--version'], { encoding: 'utf8' });
    return !probe.error && probe.status === 0;
}

function compile(python, file, cacheDir) {
    return spawnSync(python, ['-m', 'py_compile', file], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PYTHONPYCACHEPREFIX: cacheDir }
    });
}

function lint(file) {
    return spawnSync('ruff', ['check', '--quiet', file], { cwd: ROOT, encoding: 'utf8' });
}

const python = resolvePython();
if (!python) {
    console.error('check-python: no Python interpreter found (set PYTHON or install python3).');
    process.exit(1);
}

const ruffAvailable = hasRuff();
if (!ruffAvailable) {
    console.warn('check-python: ruff not found, running syntax compilation only.');
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leviathan-py-'));
const targets = [];

for (const relFile of EMBEDDED_SOURCES) {
    for (const block of extractEmbedded(relFile)) {
        const hash = crypto.createHash('sha1').update(block.body).digest('hex').slice(0, 8);
        const file = path.join(tmpDir, `${block.name.toLowerCase()}_${hash}.py`);
        fs.writeFileSync(file, block.body.endsWith('\n') ? block.body : `${block.body}\n`);
        targets.push({ label: `${block.origin} :: ${block.name}`, file });
    }
}

for (const relFile of STANDALONE_SOURCES) {
    const abs = path.join(ROOT, relFile);
    if (!fs.existsSync(abs)) {
        console.error(`check-python: expected Python source missing: ${relFile}`);
        process.exit(1);
    }
    targets.push({ label: relFile, file: abs });
}

if (targets.length === 0) {
    console.error('check-python: no Python targets discovered.');
    process.exit(1);
}

const failures = [];

for (const target of targets) {
    const compiled = compile(python, target.file, path.join(tmpDir, 'pycache'));
    if (compiled.status !== 0) {
        failures.push({ label: target.label, stage: 'compile', output: `${compiled.stdout || ''}${compiled.stderr || ''}`.trim() });
        continue;
    }
    if (ruffAvailable) {
        const linted = lint(target.file);
        if (linted.status !== 0) {
            failures.push({ label: target.label, stage: 'ruff', output: `${linted.stdout || ''}${linted.stderr || ''}`.trim() });
        }
    }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length) {
    console.error(`check-python: ${failures.length}/${targets.length} Python sources failed.`);
    for (const failure of failures) {
        console.error(`\n--- ${failure.label} [${failure.stage}] ---`);
        console.error(failure.output || 'failed without output');
    }
    process.exit(1);
}

const mode = ruffAvailable ? 'compiled and linted' : 'compiled';
console.log(`check-python OK: ${mode} ${targets.length} Python sources with ${python}.`);
