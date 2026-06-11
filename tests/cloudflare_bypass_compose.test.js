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
  const marker = new RegExp(`^  ${serviceName}:\\r?$`, 'm');
  const match = marker.exec(compose);
  assert.ok(match, `${serviceName} service is missing`);
  const rest = compose.slice(match.index + match[0].length);
  const nextService = rest.search(/\r?\n  [a-zA-Z0-9_-]+:\r?\n/);
  return nextService === -1 ? rest : rest.slice(0, nextService);
}

test('cloudflare-bypass compose service supports image pinning and persistent cache state', () => {
  const compose = read('docker-compose.yml');
  const envExample = read('.env.example');
  const block = serviceBlock(compose, 'cloudflare-bypass');

  assert.match(
    compose,
    /image:\s*"\$\{CLOUDFLARE_BYPASS_IMAGE:-ghcr\.io\/sarperavci\/cloudflarebypassforscraping:latest\}"/
  );
  assert.match(block, /working_dir:\s*\/data/);
  assert.match(block, /user:\s*"0:0"/);
  assert.match(block, /chown -R ubuntu:ubuntu \/data/);
  assert.match(block, /exec su ubuntu -c "cd \/data && python3 \/app\/server\.py"/);
  assert.match(block, /-\s*cloudflare-bypass-cache:\/data\b/);
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
