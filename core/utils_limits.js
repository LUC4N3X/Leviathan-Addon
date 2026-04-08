require('dotenv').config();
const Bottleneck = require('bottleneck');

const LIMITERS = {
    scraper: new Bottleneck({ maxConcurrent: 40, minTime: 10 }),
    remoteIndexer: new Bottleneck({ maxConcurrent: 8, minTime: 25 }),
    externalAddons: new Bottleneck({ maxConcurrent: 10, minTime: 20 }),
    metadata: new Bottleneck({ maxConcurrent: 6, minTime: 50 }),
    rdResolve: new Bottleneck({ maxConcurrent: 15, minTime: 180 }),
    adResolve: new Bottleneck({ maxConcurrent: 10, minTime: 220 }),
    tbResolve: new Bottleneck({ maxConcurrent: 8, minTime: 250 }),
    lazyPlay: new Bottleneck({ maxConcurrent: 20, minTime: 30 }),
    lazyWarmup: new Bottleneck({ maxConcurrent: 3, minTime: 350 }),
    cloudBuild: new Bottleneck({ maxConcurrent: 4, minTime: 250 }),
    webVix: new Bottleneck({ maxConcurrent: 6, minTime: 25 }),
    webGhd: new Bottleneck({ maxConcurrent: 4, minTime: 40 }),
    webGs: new Bottleneck({ maxConcurrent: 4, minTime: 40 }),
    webAw: new Bottleneck({ maxConcurrent: 4, minTime: 40 }),
    webGf: new Bottleneck({ maxConcurrent: 4, minTime: 40 }),
    packResolver: new Bottleneck({ maxConcurrent: 1, minTime: 2000 }),
    bgPackJobs: new Bottleneck({ maxConcurrent: 2, minTime: 25 })
};

LIMITERS.rd = LIMITERS.rdResolve;
LIMITERS.ad = LIMITERS.adResolve;
LIMITERS.tb = LIMITERS.tbResolve;

function getLimiterStats() {
    const stats = {};
    for (const [name, limiter] of Object.entries(LIMITERS || {})) {
        if (!limiter || typeof limiter.counts !== 'function') continue;
        try {
            stats[name] = limiter.counts();
        } catch (_) {}
    }
    return stats;
}

module.exports = {
    LIMITERS,
    getLimiterStats
};
