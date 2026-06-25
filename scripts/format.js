#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEXT_EXT = new Set(['.js', '.cjs', '.mjs', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.toml', '.txt']);
const TEXT_FILES = new Set(['Dockerfile', '.dockerignore', '.gitignore', '.env.example']);

function git(args) {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
}

function isTextFile(file) {
    const normalized = file.split(path.sep).join('/');
    const base = path.basename(file);
    if (normalized.includes('/public/vendor/') || /\.min\.(?:js|css)$/i.test(base)) return false;
    return TEXT_FILES.has(base) || TEXT_EXT.has(path.extname(base));
}

function getChangedFiles() {
    const files = new Set();

    for (const file of git(['diff', '--name-only', '--cached', '--diff-filter=ACMR'])) files.add(file);
    for (const file of git(['diff', '--name-only', '--diff-filter=ACMR'])) files.add(file);
    for (const file of git(['ls-files', '--others', '--exclude-standard'])) files.add(file);

    if (files.size === 0) {
        for (const file of git(['diff', '--name-only', '--diff-filter=ACMR', 'origin/main...HEAD'])) files.add(file);
    }

    if (files.size === 0) {
        for (const file of git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD~1...HEAD'])) files.add(file);
    }

    return [...files]
        .map((file) => path.resolve(ROOT, file))
        .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile() && isTextFile(file));
}

function normalize(content) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    return content
        .split(/\r?\n/)
        .map((line) => line.replace(/[\t ]+$/g, ''))
        .join(eol);
}

let changed = 0;

for (const file of getChangedFiles()) {
    const before = fs.readFileSync(file, 'utf8');
    const after = normalize(before);

    if (after !== before) {
        fs.writeFileSync(file, after, 'utf8');
        changed += 1;
    }
}

console.log(changed ? `Formatted ${changed} changed file(s).` : 'Format OK: no changed files needed formatting.');
