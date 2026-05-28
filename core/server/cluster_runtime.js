const cluster = require('cluster');
const os = require('os');
const { randomUUID } = require('crypto');

const runtimeState = require('../runtime_state');

const LOCAL_NODE_ID = String(process.env.LEVI_NODE_ID || randomUUID());
process.env.LEVI_NODE_ID = LOCAL_NODE_ID;

function clampInt(value, fallback, min, max) {
    const parsed = parseInt(value, 10);
    const safe = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, safe));
}

function getAutoWorkerCap(cpuCount) {
    const raw = String(process.env.CLUSTER_WORKERS_AUTO_MAX || '').trim().toLowerCase();
    const hardCap = raw && !['cpu', 'cpus', 'max', 'none', 'off', 'unlimited'].includes(raw)
        ? clampInt(raw, cpuCount, 1, 128)
        : 128;
    const totalMemoryMb = Math.max(256, Math.floor(os.totalmem() / 1024 / 1024));
    const memoryPerWorkerMb = clampInt(process.env.CLUSTER_MEMORY_PER_WORKER_MB || '384', 384, 128, 4096);
    const memoryCap = Math.max(1, Math.floor((totalMemoryMb * 0.70) / memoryPerWorkerMb));
    const ioMultiplier = Math.max(1, Math.min(4, Number(process.env.CLUSTER_WORKER_IO_MULTIPLIER || '1') || 1));
    const cpuCap = Math.max(1, Math.ceil((cpuCount || 1) * ioMultiplier));
    return Math.max(1, Math.min(cpuCap, memoryCap, hardCap));
}

function getClusterWorkerCount() {
    const raw = String(process.env.CLUSTER_WORKERS || '').trim().toLowerCase();
    const cpuCount = Math.max(1, os.cpus().length || 1);
    if (!raw) return 1;
    if (raw === 'auto') return getAutoWorkerCap(cpuCount);
    const parsed = parseInt(raw, 10);
    const maxManual = clampInt(process.env.CLUSTER_WORKERS_MANUAL_MAX || '128', 128, 1, 128);
    return Number.isFinite(parsed) && parsed > 1 ? Math.min(parsed, getAutoWorkerCap(cpuCount), maxManual) : 1;
}

function shouldUseCluster() {
    return getClusterWorkerCount() > 1;
}

function getClusterRestartPolicy() {
    return {
        windowMs: Math.max(15_000, parseInt(process.env.CLUSTER_RESTART_WINDOW_MS || String(2 * 60 * 1000), 10) || (2 * 60 * 1000)),
        maxRestarts: Math.max(2, parseInt(process.env.CLUSTER_MAX_RESTARTS_PER_WINDOW || '8', 10) || 8),
        baseBackoffMs: Math.max(500, parseInt(process.env.CLUSTER_RESTART_BASE_BACKOFF_MS || '1000', 10) || 1000),
        maxBackoffMs: Math.max(2_000, parseInt(process.env.CLUSTER_RESTART_MAX_BACKOFF_MS || String(30 * 1000), 10) || (30 * 1000))
    };
}

function maybeRunPrimaryCluster() {
    if (!cluster.isPrimary || !shouldUseCluster()) return false;

    const workerCount = getClusterWorkerCount();
    process.env.UV_THREADPOOL_SIZE = String(clampInt(process.env.UV_THREADPOOL_SIZE || String(Math.max(32, Math.min((os.cpus().length || 1) * 8, 128))), 32, 4, 128));
    const restartPolicy = getClusterRestartPolicy();
    const slotState = new Map();
    const maxClusterRestartHistory = Math.max(4, parseInt(process.env.CLUSTER_RESTART_HISTORY_CAP || '16', 10) || 16);
    let shuttingDown = false;
    let primaryForceTimer = null;

    runtimeState.setClusterRole('primary', { enabled: true, leader: true, slot: -1 });
    console.log(`[CLUSTER] Primary ${process.pid} avvia ${workerCount} worker HTTP | UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE}`);

    function getSlotStats(slot) {
        const key = Number(slot);
        if (!slotState.has(key)) {
            slotState.set(key, { restarts: [], spawnCount: 0, currentWorkerId: null });
        }
        return slotState.get(key);
    }

    function computeBackoffMs(slot) {
        const stats = getSlotStats(slot);
        const now = Date.now();
        stats.restarts = stats.restarts.filter((ts) => (now - ts) <= restartPolicy.windowMs).slice(-maxClusterRestartHistory);
        if (stats.restarts.length >= restartPolicy.maxRestarts) return restartPolicy.maxBackoffMs;
        const exponent = Math.max(0, stats.restarts.length - 1);
        return Math.min(restartPolicy.maxBackoffMs, restartPolicy.baseBackoffMs * (2 ** exponent));
    }

    function spawnWorker(slot, leader, delayMs = 0) {
        const boot = () => {
            if (shuttingDown) return;
            const stats = getSlotStats(slot);
            stats.spawnCount += 1;
            const worker = cluster.fork({
                LEVI_CLUSTER_HTTP: '1',
                LEVI_CLUSTER_LEADER: leader ? 'true' : 'false',
                LEVI_CLUSTER_SLOT: String(slot),
                LEVI_NODE_ID: LOCAL_NODE_ID
            });
            stats.currentWorkerId = worker.id;
            worker.__leviSlot = slot;
            worker.__leviLeader = leader;
            console.log(`[CLUSTER] Spawn worker slot=${slot} pid=${worker.process.pid} leader=${leader}`);
        };

        if (delayMs > 0) {
            console.warn(`[CLUSTER] Respawn worker slot=${slot} in ${delayMs}ms`);
            const timer = setTimeout(boot, delayMs);
            timer.unref();
            return;
        }
        boot();
    }

    for (let i = 0; i < workerCount; i += 1) {
        spawnWorker(i, i === 0, 0);
    }

    cluster.on('exit', (worker, code, signal) => {
        const slot = Number.isInteger(worker.__leviSlot) ? worker.__leviSlot : 0;
        const stats = getSlotStats(slot);
        stats.restarts.push(Date.now());
        if (stats.restarts.length > maxClusterRestartHistory) stats.restarts = stats.restarts.slice(-maxClusterRestartHistory);
        stats.currentWorkerId = null;
        console.warn(`[CLUSTER] Worker ${worker.process.pid} terminato (slot=${slot} code=${code} signal=${signal || 'n/a'})`);

        if (shuttingDown) {
            if (Object.keys(cluster.workers || {}).length === 0) {
                if (primaryForceTimer) clearTimeout(primaryForceTimer);
                slotState.clear();
                process.exit(0);
            }
            return;
        }

        const delayMs = computeBackoffMs(slot);
        const shouldLead = worker.__leviLeader === true || slot === 0;
        spawnWorker(slot, shouldLead, delayMs);
    });

    function gracefulPrimaryShutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        runtimeState.markDraining(`primary_${signal}`, { rejectNewRequests: true });
        console.log(`[CLUSTER] Primary riceve ${signal}, arresto coordinato dei worker...`);

        primaryForceTimer = setTimeout(() => {
            console.error('[CLUSTER] Timeout shutdown primary, kill forzato dei worker.');
            for (const worker of Object.values(cluster.workers || {})) {
                try { worker.process.kill('SIGKILL'); } catch (_) {}
            }
            slotState.clear();
            process.exit(1);
        }, Math.max(5000, parseInt(process.env.SHUTDOWN_FORCE_MS || '15000', 10) || 15000));
        primaryForceTimer.unref();

        const workers = Object.values(cluster.workers || {});
        if (workers.length === 0) {
            clearTimeout(primaryForceTimer);
            slotState.clear();
            process.exit(0);
        }
        for (const worker of workers) {
            try { worker.process.kill(signal); } catch (_) {}
        }
    }

    process.on('SIGTERM', () => gracefulPrimaryShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulPrimaryShutdown('SIGINT'));
    return true;
}

function getLocalNodeId() {
    return LOCAL_NODE_ID;
}

module.exports = {
    getClusterWorkerCount,
    getLocalNodeId,
    maybeRunPrimaryCluster,
    shouldUseCluster
};
