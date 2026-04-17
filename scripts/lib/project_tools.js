'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const IGNORE_DIRS = new Set(['.git', '.github', 'node_modules']);
const LINT_INCLUDE = new Set(['addon.js', 'manifest.js']);
const SOURCE_ROOTS = ['core', 'providers', 'scripts', 'tests'];
const TEXT_EXTENSIONS = new Set(['.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.html', '.css']);
const TEXT_FILENAMES = new Set(['.dockerignore', '.gitignore']);

function walk(dir, visitor) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, visitor);
      continue;
    }
    visitor(fullPath);
  }
}

function toProjectRelative(filePath) {
  return path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/');
}

function listLintFiles() {
  const files = [];
  for (const name of LINT_INCLUDE) {
    const fullPath = path.join(PROJECT_ROOT, name);
    if (fs.existsSync(fullPath)) files.push(fullPath);
  }
  for (const dirName of SOURCE_ROOTS) {
    const fullPath = path.join(PROJECT_ROOT, dirName);
    if (!fs.existsSync(fullPath)) continue;
    walk(fullPath, (filePath) => {
      if (/\.(?:js|cjs)$/.test(filePath)) files.push(filePath);
    });
  }
  return files.sort();
}

function listTextFiles() {
  const files = [];
  walk(PROJECT_ROOT, (filePath) => {
    const basename = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    if (TEXT_FILENAMES.has(basename) || TEXT_EXTENSIONS.has(extension)) files.push(filePath);
  });
  return files.sort();
}

function runNodeSyntaxCheck(filePath) {
  return cp.spawnSync(process.execPath, ['--check', filePath], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8'
  });
}

function resolveRequireCandidates(filePath, request) {
  const base = path.resolve(path.dirname(filePath), request);
  return [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.json`,
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
    path.join(base, 'index.json')
  ];
}

function findMissingLocalRequires(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const regex = /require\((['"])(\.[^'"]+)\1\)/g;
  const missing = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const request = match[2];
    const exists = resolveRequireCandidates(filePath, request).some((candidate) => fs.existsSync(candidate));
    if (!exists) missing.push(request);
  }
  return missing;
}

function normalizeTextFile(content) {
  let normalized = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.endsWith('\n')) normalized += '\n';
  return normalized;
}

module.exports = {
  PROJECT_ROOT,
  findMissingLocalRequires,
  listLintFiles,
  listTextFiles,
  normalizeTextFile,
  runNodeSyntaxCheck,
  toProjectRelative
};
