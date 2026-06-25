'use strict';

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const { logger } = require('../utils/runtime');

class FastDaemonPool {
    constructor(size = 3) {
        this.size = size;
        this.daemons = [];
        this.currentIdx = 0;
        this.callbacks = new Map();
        
        for (let i = 0; i < size; i++) {
            this._spawnDaemon(i);
        }
    }

    _spawnDaemon(index) {
        const scriptPath = path.join(__dirname, 'cf_fast_daemon.py');
        const pythonExec = process.env.SCRAPLING_PYTHON || process.env.CURL_CFFI_PYTHON || 'python';
        
        const child = spawn(pythonExec, ['-u', scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        child.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.reqId && this.callbacks.has(parsed.reqId)) {
                        this.callbacks.get(parsed.reqId).resolve(parsed);
                        this.callbacks.delete(parsed.reqId);
                    }
                } catch (e) {
                    logger.warn(`[DAEMON] Error parsing JSON from daemon: ${e.message}`);
                }
            }
        });

        child.stderr.on('data', (data) => {
            logger.debug(`[DAEMON] stderr: ${data.toString()}`);
        });

        child.on('close', (code) => {
            logger.warn(`[DAEMON] Python daemon ${index} exited with code ${code}. Respawning...`);
            setTimeout(() => this._spawnDaemon(index), 1000);
        });

        this.daemons[index] = child;
        logger.info(`[DAEMON] Spawned persistent Python daemon ${index}`);
    }

    async request(options) {
        return new Promise((resolve, reject) => {
            if (this.daemons.length === 0) {
                return reject(new Error("No daemons available"));
            }

            const reqId = randomUUID();
            const payload = {
                reqId,
                url: options.url,
                method: options.method || 'GET',
                headers: options.headers || {},
                impersonate: options.impersonate || 'chrome120',
                timeout: options.timeout || 15000,
                cookies: options.cookies || []
            };

            this.callbacks.set(reqId, { resolve, reject });

            // Set timeout
            setTimeout(() => {
                if (this.callbacks.has(reqId)) {
                    this.callbacks.get(reqId).reject(new Error("Daemon request timed out"));
                    this.callbacks.delete(reqId);
                }
            }, (options.timeout || 15000) + 2000);

            // Round-robin
            const child = this.daemons[this.currentIdx];
            this.currentIdx = (this.currentIdx + 1) % this.daemons.length;

            try {
                // Pass the reqId back from python? Ah wait, my python script doesn't echo reqId.
                // We MUST update cf_fast_daemon.py to echo reqId!
                child.stdin.write(JSON.stringify(payload) + '\n');
            } catch (e) {
                reject(e);
                this.callbacks.delete(reqId);
            }
        });
    }
}

const globalDaemonPool = new FastDaemonPool(parseInt(process.env.FAST_DAEMON_POOL_SIZE || '3', 10));

module.exports = {
    globalDaemonPool
};
