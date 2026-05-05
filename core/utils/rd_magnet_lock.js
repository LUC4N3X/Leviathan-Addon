'use strict';

// Cross-worker file lock for RealDebrid addMagnet/select/delete operations.
// Inspired by Sootio's rd-magnet-lock; adapted to CommonJS and Leviathan data layout.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const LOCK_DIR = path.join(process.cwd(), 'data', 'rd-magnet-locks');
const LOCK_TIMEOUT_MS = Math.max(1000, parseInt(process.env.RD_MAGNET_LOCK_TIMEOUT_MS || '45000', 10) || 45000);
const LOCK_TTL_MS = Math.max(1000, parseInt(process.env.RD_MAGNET_LOCK_TTL_MS || '60000', 10) || 60000);
const LOCK_POLL_MS = Math.max(25, parseInt(process.env.RD_MAGNET_LOCK_POLL_MS || '120', 10) || 120);
let ensureDirPromise = null;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashPart(value, len = 24) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, len);
}

async function ensureLockDir() {
    if (!ensureDirPromise) {
        ensureDirPromise = fs.mkdir(LOCK_DIR, { recursive: true }).catch((err) => {
            ensureDirPromise = null;
            throw err;
        });
    }
    return ensureDirPromise;
}

async function acquireLock(lockPath, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || LOCK_TIMEOUT_MS));
    const ttlMs = Math.max(1000, Number(options.ttlMs || LOCK_TTL_MS));
    const pollMs = Math.max(25, Number(options.pollMs || LOCK_POLL_MS));
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < timeoutMs) {
        try {
            const handle = await fs.open(lockPath, 'wx');
            await handle.writeFile(String(Date.now()));
            return handle;
        } catch (err) {
            if (err?.code !== 'EEXIST') throw err;
            try {
                const stat = await fs.stat(lockPath);
                if ((Date.now() - stat.mtimeMs) > ttlMs) await fs.unlink(lockPath).catch(() => {});
            } catch (_) {}
            await sleep(pollMs);
        }
    }

    const error = new Error(`RD magnet lock timeout: ${path.basename(lockPath)}`);
    error.code = 'RD_MAGNET_LOCK_TIMEOUT';
    throw error;
}

async function releaseLock(lockPath, handle) {
    try { if (handle) await handle.close(); } catch (_) {}
    try { await fs.unlink(lockPath); } catch (_) {}
}

async function withRealDebridMagnetLock(apiKey, infoHash, fn, options = {}) {
    const normalizedHash = String(infoHash || '').trim().toLowerCase();
    if (!normalizedHash || typeof fn !== 'function') return fn();
    await ensureLockDir();
    const lockFile = `${hashPart(apiKey || 'no-key', 16)}-${hashPart(normalizedHash, 40)}.lock`;
    const lockPath = path.join(LOCK_DIR, lockFile);
    const handle = await acquireLock(lockPath, options);
    try {
        return await fn();
    } finally {
        await releaseLock(lockPath, handle);
    }
}

module.exports = {
    withRealDebridMagnetLock
};
