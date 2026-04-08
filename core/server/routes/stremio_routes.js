'use strict';

const path = require('path');

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
            } else if ((config.service === 'ad' && config.key) || config.alldebrid) {
                manifest.name = `${appName}${flag} 🔱 AD`;
                manifest.id += '.ad';
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
            validateStreamRequest(req.params.type, req.params.id.replace('.json', ''));
            res.json(await generateStream(
                req.params.type,
                req.params.id.replace('.json', ''),
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
