#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { IMPIT_CEILING } = require('../core/security/fingerprint_manifest');
const { scanRepoUserAgents } = require('../core/security/fingerprint_scan');

const REPO_ROOT = path.resolve(__dirname, '..');
const CI_MODE = process.argv.includes('--ci');
const DRIFT_LIMIT = Number.parseInt(process.env.FINGERPRINT_DRIFT_LIMIT || '2', 10);
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FINGERPRINT_FETCH_TIMEOUT_MS || '8000', 10);
const STRICT = /^(1|true|yes|on)$/i.test(String(process.env.FINGERPRINT_FRESHNESS_STRICT || ''));

const ENDOFLIFE = {
    chrome: 'https://endoflife.date/api/chrome.json',
    firefox: 'https://endoflife.date/api/firefox.json'
};

function log(line) {
    process.stdout.write(`${line}\n`);
}

function warn(line) {
    process.stderr.write(`${line}\n`);
}

async function fetchLatestMajor(url) {
    if (typeof fetch !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) return null;
        const data = await response.json();
        const entries = Array.isArray(data) ? data : [];
        let best = null;
        for (const entry of entries) {
            const raw = entry && (entry.latest != null ? entry.latest : entry.cycle);
            const candidate = String(raw || '').split('.')[0];
            const major = Number.parseInt(candidate, 10);
            if (Number.isFinite(major) && (best == null || major > best)) best = major;
        }
        return best;
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    const violations = scanRepoUserAgents(REPO_ROOT);
    const blocking = violations.length > 0;

    if (blocking) {
        warn('Fingerprint coherence violations:');
        for (const item of violations) {
            warn(` - ${item.file}: ${item.family} expected ${item.expected}, found ${item.found}`);
        }
    } else {
        log('Coherence OK: every hardcoded user agent in core and providers matches the impit tls ceiling.');
    }

    const latest = {
        chrome: await fetchLatestMajor(ENDOFLIFE.chrome),
        firefox: await fetchLatestMajor(ENDOFLIFE.firefox)
    };

    const advisories = [];
    for (const key of ['chrome', 'firefox']) {
        const upstream = latest[key];
        const current = IMPIT_CEILING[key];
        if (upstream == null) {
            log(`Latest stable ${key}: unavailable (offline or rate-limited).`);
            continue;
        }
        const drift = upstream - current;
        log(`Latest stable ${key}: ${upstream} | pinned ceiling: ${current} | drift: ${drift}`);
        if (drift > DRIFT_LIMIT) {
            advisories.push(`${key} drift ${drift} exceeds limit ${DRIFT_LIMIT}: bump the impit dependency and refresh the fingerprints.`);
        }
    }

    for (const item of advisories) warn(`ADVISORY: ${item}`);

    if (CI_MODE && blocking) {
        process.exitCode = 1;
        return;
    }
    if (CI_MODE && STRICT && advisories.length) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    warn(`Fingerprint freshness check failed: ${error && error.message}`);
    process.exitCode = CI_MODE ? 1 : 0;
});
