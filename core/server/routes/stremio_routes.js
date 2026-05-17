'use strict';

const path = require('path');
const crypto = require('crypto');

const TOKEN_PREFIX = 'cfg_';

function manifestSuffixFromConfig(config) {
    if (!config || typeof config !== 'object') return '';
    const safeConfig = {
        service: config.service || '',
        hasKey: !!(config.key || config.rd || config.torbox || config.alldebrid),
        language: config.filters?.language || (config.filters?.allowEng ? 'all' : 'ita'),
        options: config.options || ''
    };
    const raw = JSON.stringify(safeConfig);
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
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
            const tokenLike = String(req.params.conf || '').startsWith(TOKEN_PREFIX);
            const invalidConfig = tokenLike && (!config || Object.keys(config).length === 0);
            const manifestSuffix = manifestSuffixFromConfig(config);
            if (manifestSuffix) manifest.id += `.${manifestSuffix}`;

            if (invalidConfig) {
                manifest.name = `${appName}${flag} ⚠️ Reconfigure`;
                manifest.description += ' | Configurazione scaduta o non valida: reinstalla per evitare fallback P2P/Web';
                manifest.behaviorHints = { ...(manifest.behaviorHints || {}), configurable: true, configurationRequired: true };
            } else if ((config.service === 'rd' && config.key) || config.rd) {
                manifest.name = `${appName}${flag} 🔱 RD`;
            } else if ((config.service === 'tb' && config.key) || config.torbox) {
                manifest.name = `${appName}${flag} 🔱 TB`;
            } else if ((config.service === 'ad' && config.key) || config.alldebrid) {
                manifest.name = `${appName}${flag} 🔱 AD`;
            } else if (config.service === 'p2p' || filters.enableP2P === true) {
                manifest.name = `${appName}${flag} 🦈 P2P`;
                manifest.description += ' | P2P Mode (IP Visible)';
            } else {
                manifest.name = `${appName}${flag} ⛵ Web`;
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
            const config = getConfig(req.params.conf);
            const tokenLike = String(req.params.conf || '').startsWith(TOKEN_PREFIX);
            if (tokenLike && (!config || Object.keys(config).length === 0)) {
                return res.json({ streams: [] });
            }
            res.json(await generateStream(
                req.params.type,
                req.params.id.replace('.json', ''),
                config,
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
