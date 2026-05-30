'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PRODUCTION_DIRS = ['core', 'providers'];
const LEGACY_ENDPOINT_ENV_NAMES = [
  'FORWARDPROXY',
  'KRAKEN_FORWARD_PROXY',
  'MEDIAFLOW_FORWARD_PROXY',
  'MFP_FORWARD_PROXY',
  'CB01_FORWARD_PROXY',
  'UPROT_FORWARD_PROXY',
  'UPROT_FORWARDPROXY',
  'CINEMACITY_FORWARD_PROXY',
  'CINEMACITY_KRAKEN_FORWARD_URL'
];

function collectJavaScriptFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

test('production JavaScript contains no embedded Leviathan Kraken forward endpoint', () => {
  const matches = [];
  for (const relativeDir of PRODUCTION_DIRS) {
    for (const file of collectJavaScriptFiles(path.join(ROOT, relativeDir))) {
      const source = fs.readFileSync(file, 'utf8');
      if (/krakenproxy\.questoleviatanormio\.dpdns\.org/i.test(source)) {
        matches.push(path.relative(ROOT, file));
      }
    }
  }
  assert.deepEqual(matches, []);
});

test('production JavaScript does not read legacy forward endpoint env aliases', () => {
  const matches = [];
  for (const relativeDir of PRODUCTION_DIRS) {
    for (const file of collectJavaScriptFiles(path.join(ROOT, relativeDir))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const name of LEGACY_ENDPOINT_ENV_NAMES) {
        const pattern = new RegExp(`(?:process\\.env\\.|envString\\(['"])${name}(?!_)`);
        if (pattern.test(source)) matches.push(`${path.relative(ROOT, file)}:${name}`);
      }
    }
  }
  assert.deepEqual(matches, []);
});

test('deployment configuration exposes one forward proxy endpoint env', () => {
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

  assert.match(compose, /^\s+FORWARD_PROXY:\s+"\$\{FORWARD_PROXY:-\}"\s*$/m);
  for (const name of LEGACY_ENDPOINT_ENV_NAMES) {
    assert.doesNotMatch(compose, new RegExp(`^\\s+${name}:`, 'm'));
  }
  assert.match(
    envExample,
    /^FORWARD_PROXY=https:\/\/krakenproxy\.questoleviatanormio\.dpdns\.org\/forward\?url=$/m
  );
});
