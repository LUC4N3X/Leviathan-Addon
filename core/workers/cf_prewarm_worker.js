'use strict';

const { logger } = require('../utils/runtime');
const { createCloudflareBypass } = require('../../providers/utils/cloudflare_bypass');
const { globalDaemonPool } = require('../../providers/utils/cf_fast_daemon_pool');

const PREWARM_TARGETS = [
    { id: 'streamingcommunity', url: 'https://streamingcommunity.com/' },
    { id: 'cb01', url: 'https://cb01.movie/' },
    { id: 'guardahd', url: 'https://guardahd.stream/' },
    { id: 'guardoserie', url: 'https://guardoserie.net/' },
    { id: 'vidxgo', url: 'https://vidxgo.com/' },
    { id: 'animeworld', url: 'https://www.animeworld.so/' },
    { id: 'eurostreaming', url: 'https://eurostreaming.stream/' }
];

const PREWARM_INTERVAL_MS = Math.max(15 * 60 * 1000, parseInt(process.env.CF_PREWARM_INTERVAL_MS || '2700000', 10)); // 45 minutes default

function startCfPrewarmJob(options = {}) {
    const { enabled = true } = options;
    if (!enabled) return null;

    logger.info(`[PREWARM] Cloudflare Prewarm Worker initialized. Targets: ${PREWARM_TARGETS.length}. Interval: ${PREWARM_INTERVAL_MS}ms`);

    const bypasser = createCloudflareBypass({
        label: 'cf_prewarm',
        useScrapling: true,
        useCurlCffiFallback: true
    });

    let timer = null;
    let isRunning = false;

    const runPrewarm = async () => {
        if (isRunning) return;
        isRunning = true;
        
        logger.info('[PREWARM] Iniziando ciclo di pre-warming dei cookie Cloudflare...');
        
        for (const target of PREWARM_TARGETS) {
            try {
                logger.info(`[PREWARM] Warming target: ${target.id} (${target.url})`);
                await globalDaemonPool.request({
                    url: target.url,
                    method: 'GET',
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                    },
                    timeout: 45000,
                    providerName: target.id
                });
                logger.info(`[PREWARM] Target ${target.id} riscaldato con successo.`);
            } catch (err) {
                logger.warn(`[PREWARM] Fallimento prewarm per ${target.id}: ${err.message}`);
            }
            
            await new Promise(r => setTimeout(r, 5000));
        }
        
        logger.info('[PREWARM] Ciclo di pre-warming completato.');
        isRunning = false;
    };

    const bootstrapTimer = setTimeout(() => {
        runPrewarm().catch(() => {});
    }, 15000);
    bootstrapTimer.unref();

    timer = setInterval(() => {
        runPrewarm().catch(() => {});
    }, PREWARM_INTERVAL_MS);
    timer.unref();

    return {
        stop() {
            clearTimeout(bootstrapTimer);
            clearInterval(timer);
            logger.info('[PREWARM] Cloudflare Prewarm Worker fermato.');
        }
    };
}

module.exports = {
    startCfPrewarmJob
};
