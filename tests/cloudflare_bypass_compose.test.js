'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function serviceBlock(compose, serviceName) {
  const marker = `  ${serviceName}:`;
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, `${serviceName} service is missing`);
  const rest = compose.slice(start + marker.length);
  const nextService = rest.search(/\r?\n  [a-zA-Z0-9_-]+:\r?\n/);
  return nextService === -1 ? rest : rest.slice(0, nextService);
}

test('cloudflare-bypass compose service supports image pinning and persistent cache state', () => {
  const compose = read('docker-compose.yml');
  const envExample = read('.env.example');

  assert.match(
    compose,
    /image:\s*"\$\{CLOUDFLARE_BYPASS_IMAGE:-ghcr\.io\/sarperavci\/cloudflarebypassforscraping:latest\}"/
  );
  assert.match(compose, /working_dir:\s*\/data/);
  assert.match(compose, /command:\s*\["python3",\s*"\/app\/server\.py"\]/);
  assert.match(compose, /-\s*cloudflare-bypass-cache:\/data\b/);
  assert.match(compose, /^volumes:\s*\r?\n\s+cloudflare-bypass-cache:/m);

  assert.match(envExample, /CLOUDFLARE_BYPASS_IMAGE=ghcr\.io\/sarperavci\/cloudflarebypassforscraping:latest/);
  assert.match(envExample, /GUARDOSERIE_EXTRACTOR_CLOUDFLARE_BYPASS=false/);
  assert.match(envExample, /GUARDOSERIE_EXTRACTOR_CLOUDFLARE_BYPASS_MIRROR_FALLBACK=false/);
});

test('compose enables GuardoSerie extractor CloudflareBypass mirror fallback in app processes', () => {
  const compose = read('docker-compose.yml');
  for (const serviceName of ['stremio-addon', 'leviathan-worker']) {
    const block = serviceBlock(compose, serviceName);
    assert.match(block, /GUARDOSERIE_EXTRACTOR_CLOUDFLARE_BYPASS:\s*"true"/);
    assert.match(block, /GUARDOSERIE_EXTRACTOR_CLOUDFLARE_BYPASS_MIRROR_FALLBACK:\s*"true"/);
  }
});
