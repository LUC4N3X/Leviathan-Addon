'use strict';

const { queueTorrentioPrefetchJob } = require('../../workers/torrentio_prefetch_queue');
const { getEdgeConfig, hasValidEdgeSecret } = require('../edge_gateway');

function readBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function normalizeType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'series' || type === 'tv') return 'series';
  if (type === 'movie') return 'movie';
  if (type === 'anime') return 'series';
  return '';
}

function parseStremioId(type, id) {
  const mediaType = normalizeType(type);
  const clean = String(id || '').trim().replace(/\.json$/i, '');
  if (!mediaType || !clean) return null;

  if (mediaType === 'movie') {
    const match = clean.match(/^(tt\d+)$/i);
    if (!match) return null;
    return { mediaType, finalId: match[1].toLowerCase(), meta: { imdb_id: match[1].toLowerCase() } };
  }

  const seriesMatch = clean.match(/^(tt\d+):(\d+):(\d+)$/i);
  if (!seriesMatch) return null;
  return {
    mediaType: 'series',
    finalId: `${seriesMatch[1].toLowerCase()}:${Number(seriesMatch[2])}:${Number(seriesMatch[3])}`,
    meta: {
      imdb_id: seriesMatch[1].toLowerCase(),
      season: Number(seriesMatch[2]),
      episode: Number(seriesMatch[3]),
      isSeries: true
    }
  };
}

function requireEdgeInternal(req, res, next) {
  const cfg = getEdgeConfig();
  if (!readBoolean(process.env.LEVIATHAN_EDGE_INTERNAL_ENABLED, true)) {
    return res.status(404).json({ ok: false, code: 'edge_internal_disabled' });
  }
  if (!cfg.secret) {
    return res.status(503).json({ ok: false, code: 'edge_secret_not_configured' });
  }
  if (!hasValidEdgeSecret(req, cfg)) {
    return res.status(403).json({ ok: false, code: 'edge_secret_required' });
  }
  return next();
}

function registerEdgeRoutes(app, { logger } = {}) {
  app.get('/api/edge/status', (req, res) => {
    const cfg = getEdgeConfig();
    res.json({
      ok: true,
      enabled: cfg.enabled,
      allowDirect: cfg.allowDirect,
      requireSecret: cfg.requireSecret,
      hasSecret: Boolean(cfg.secret),
      internalEnabled: readBoolean(process.env.LEVIATHAN_EDGE_INTERNAL_ENABLED, true),
      cacheHints: {
        manifestSeconds: Number(process.env.LEVIATHAN_EDGE_CACHE_MANIFEST_SECONDS || 3600) || 3600,
        configureSeconds: Number(process.env.LEVIATHAN_EDGE_CACHE_CONFIGURE_SECONDS || 600) || 600,
        assetsSeconds: Number(process.env.LEVIATHAN_EDGE_CACHE_ASSETS_SECONDS || 86400) || 86400
      }
    });
  });

  app.post('/internal/edge/prewarm', requireEdgeInternal, async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const parsed = parseStremioId(body.type, body.id || body.finalId || body.mediaId);
    if (!parsed) {
      return res.status(400).json({
        ok: false,
        queued: false,
        code: 'unsupported_or_invalid_id',
        message: 'Sono accettati movie tt... oppure series tt...:season:episode.'
      });
    }

    const result = await queueTorrentioPrefetchJob({
      type: parsed.mediaType,
      finalId: parsed.finalId,
      meta: parsed.meta,
      priority: Math.max(0, Math.min(100, Number(body.priority || 65) || 65)),
      reason: String(body.reason || 'edge-stream-hint').slice(0, 80),
      logger
    });

    const accepted = result?.queued === true || result?.reason === 'recent';
    return res.status(accepted ? 202 : 200).json({
      ok: accepted,
      queued: result?.queued === true,
      reason: result?.reason || null,
      jobKey: result?.jobKey || null
    });
  });
}

module.exports = { registerEdgeRoutes, parseStremioId };
