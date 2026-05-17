'use strict';

function registerAdminRoutes(app, { Cache, ADMIN_PASS, safeCompare }) {
    const authMiddleware = (req, res, next) => {
        if (!ADMIN_PASS) return res.status(503).json({ error: 'Admin disabilitato: configura ADMIN_PASS nell\'ambiente' });
        const rawAuthHeader = String(req.headers.authorization || '').trim();
        if (safeCompare(rawAuthHeader.toLowerCase().startsWith('bearer ') ? rawAuthHeader.slice(7).trim() : rawAuthHeader, ADMIN_PASS)) {
            return next();
        }
        return res.status(403).json({ error: 'Password errata' });
    };

    app.get('/admin/keys', authMiddleware, async (req, res) => res.json(await Cache.listKeys()));
    app.delete('/admin/key', authMiddleware, async (req, res) => {
        if (!req.query.key) return res.json({ error: 'Key mancante' });
        await Cache.deleteKey(req.query.key);
        return res.json({ success: true });
    });
    app.post('/admin/flush', authMiddleware, async (req, res) => {
        await Cache.flushAll();
        res.json({ success: true });
    });
}

module.exports = { registerAdminRoutes };
