'use strict';

const path = require('path');

const RECENT_STREAM_HINT_TTL_MS = 10 * 60 * 1000;
const RECENT_STREAM_HINT_LIMIT = 256;
const recentSeriesStreamHints = new Map();

function cleanupRecentStreamHints(now = Date.now()) {
    for (const [key, entry] of recentSeriesStreamHints.entries()) {
        if (!entry || Number(entry.expiresAt || 0) <= now) recentSeriesStreamHints.delete(key);
    }
    while (recentSeriesStreamHints.size > RECENT_STREAM_HINT_LIMIT) {
        const oldestKey = recentSeriesStreamHints.keys().next().value;
        if (oldestKey === undefined) break;
        recentSeriesStreamHints.delete(oldestKey);
    }
}

function getStreamHintKey(conf, req) {
    const forwardedFor = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const clientIp = forwardedFor || String(req?.ip || '').trim();
    return `${String(conf || '').trim()}:${clientIp}`;
}

function extractSeriesBaseId(rawId) {
    const cleanId = String(rawId || '').replace(/^ai-recs:/i, '').trim();
    const kitsuMatch = cleanId.match(/^(kitsu:\d+)(?::\d+){0,2}$/i);
    if (kitsuMatch) return kitsuMatch[1];
    const tmdbMatch = cleanId.match(/^(tmdb:\d+)(?::\d+){0,2}$/i);
    if (tmdbMatch) return tmdbMatch[1];
    const imdbMatch = cleanId.match(/^(tt\d+|\d+)(?::\d+){0,2}$/i);
    if (imdbMatch) return imdbMatch[1];
    return null;
}

function rememberSeriesHint(conf, req, type, rawId) {
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedType !== 'series' && normalizedType !== 'anime') return;

    const baseId = extractSeriesBaseId(rawId);
    if (!baseId) return;

    cleanupRecentStreamHints();
    recentSeriesStreamHints.set(getStreamHintKey(conf, req), {
        baseId,
        expiresAt: Date.now() + RECENT_STREAM_HINT_TTL_MS
    });
}

function recoverSeriesIdFromHint(conf, req, type, rawId) {
    const normalizedType = String(type || '').toLowerCase();
    if (normalizedType !== 'series' && normalizedType !== 'anime') return null;

    const placeholder = String(rawId || '').replace(/^ai-recs:/i, '').trim();
    const match = placeholder.match(/^(?:undefined|null|nan)(?::(\d+))?(?::(\d+))?$/i);
    if (!match) return null;

    cleanupRecentStreamHints();
    const hint = recentSeriesStreamHints.get(getStreamHintKey(conf, req));
    if (!hint?.baseId) return null;

    const first = parseInt(match[1], 10);
    const second = parseInt(match[2], 10);

    if (Number.isInteger(first) && first > 0 && Number.isInteger(second) && second > 0) {
        if (String(hint.baseId || '').toLowerCase().startsWith('kitsu:')) {
            return first === 1 ? `${hint.baseId}:${second}` : `${hint.baseId}:${first}:${second}`;
        }
        return `${hint.baseId}:${first}:${second}`;
    }
    if (Number.isInteger(first) && first > 0) {
        return `${hint.baseId}:${first}`;
    }
    return hint.baseId;
}

function registerStremioRoutes(app, {
    publicDir,
    getManifest,
    handleVixSynthetic,
    cloneManifest,
    getConfig,
    validateStreamRequest,
    generateStream,
    logger
}) {
    app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
    app.get('/:conf/configure', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
    app.get('/configure', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
    app.get('/rd-scanner', (req, res) => res.sendFile(path.join(publicDir, 'rd-scanner.html')));

    app.get('/manifest.json', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(getManifest());
    });

    app.get('/:conf/manifest.json', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const manifest = cloneManifest(getManifest());
        try {
            const config = getConfig(req.params.conf);
            const filters = config.filters || {};
            const langMode = filters.language || (filters.allowEng ? 'all' : 'ita');
            const flag = langMode === 'ita'
                ? ' 🇮🇹'
                : (langMode === 'eng' ? ' 🇬🇧' : ' 🇮🇹🇬🇧');
            const appName = 'LEVIATHAN';

            if ((config.service === 'rd' && config.key) || config.rd) {
                manifest.name = `${appName}${flag} 🔱 RD`;
                manifest.id += '.rd';
            } else if ((config.service === 'tb' && config.key) || config.torbox) {
                manifest.name = `${appName}${flag} 🔱 TB`;
                manifest.id += '.tb';
            } else if (filters.enableP2P === true) {
                manifest.name = `${appName}${flag} 🦈 P2P`;
                manifest.id += '.p2p';
                manifest.description += ' | P2P Mode (IP Visible)';
            } else {
                manifest.name = `${appName}${flag} ⛵ Web`;
                manifest.id += '.web';
            }
        } catch (e) {
            console.error('Errore personalizzazione manifest:', e);
        }
        res.json(manifest);
    });

    app.get('/:conf/catalog/:type/:id/:extra?.json', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json({ metas: [] });
    });

    app.get('/vixsynthetic.m3u8', handleVixSynthetic);

    app.get('/:conf/stream/:type/:id.json', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        try {
            let requestId = req.params.id.replace('.json', '');
            const recoveredId = recoverSeriesIdFromHint(req.params.conf, req, req.params.type, requestId);
            if (recoveredId && recoveredId !== requestId) {
                logger.warn(`[STREAM ID RECOVERY] ${requestId} -> ${recoveredId}`);
                requestId = recoveredId;
            }

            validateStreamRequest(req.params.type, requestId);
            rememberSeriesHint(req.params.conf, req, req.params.type, requestId);
            res.json(await generateStream(
                req.params.type,
                requestId,
                getConfig(req.params.conf),
                req.params.conf,
                `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`
            ));
        } catch (err) {
            logger.error('Validazione/Stream Fallito', { error: err.message, params: req.params });
            return res.status(400).json({ streams: [] });
        }
    });
}

module.exports = { registerStremioRoutes };
