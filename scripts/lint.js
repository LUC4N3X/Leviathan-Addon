#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', 'dist', 'build', '.next', '.cache']);
const JS_EXT = new Set(['.js', '.cjs', '.mjs']);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
            continue;
        }
        if (entry.isFile() && JS_EXT.has(path.extname(entry.name))) out.push(path.join(dir, entry.name));
    }
    return out;
}

const files = walk(ROOT).sort();
const failures = [];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });

    if (result.status !== 0) {
        failures.push({ file: path.relative(ROOT, file), output: `${result.stdout || ''}${result.stderr || ''}`.trim() });
    }
}

if (failures.length) {
    console.error(`Lint failed: ${failures.length}/${files.length} JavaScript files have syntax errors.`);
    for (const failure of failures) {
        console.error(`\n--- ${failure.file} ---`);
        console.error(failure.output || 'node --check failed without output');
    }
    process.exit(1);
}

console.log(`Lint OK: checked ${files.length} JavaScript files with node --check.`);

