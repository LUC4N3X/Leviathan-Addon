'use strict';

const crypto = require('crypto');

function readBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function getEdgeConfig() {
  return {
    enabled: readBoolean(process.env.LEVIATHAN_EDGE_ENABLED, false),
    allowDirect: readBoolean(process.env.LEVIATHAN_EDGE_ALLOW_DIRECT, true),
    requireSecret: readBoolean(process.env.LEVIATHAN_EDGE_REQUIRE_SECRET, false),
    secret: String(process.env.LEVIATHAN_EDGE_SECRET || '').trim(),
    headerName: String(process.env.LEVIATHAN_EDGE_SECRET_HEADER || 'x-leviathan-edge-secret').trim().toLowerCase(),
    markHeaderName: String(process.env.LEVIATHAN_EDGE_MARK_HEADER || 'x-leviathan-edge').trim().toLowerCase(),
    allowHealthWithoutSecret: readBoolean(process.env.LEVIATHAN_EDGE_ALLOW_HEALTH_WITHOUT_SECRET, true)
  };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch (_) {
    return false;
  }
}

function isHealthPath(pathname) {
  const path = String(pathname || '').split('?')[0];
  return path === '/health' || path === '/readyz' || path === '/livez' || path === '/favicon.ico';
}

function hasValidEdgeSecret(req, cfg = getEdgeConfig()) {
  if (!cfg.secret) return false;
  const headerValue = req.get(cfg.headerName) || req.get('x-edge-secret') || '';
  return safeEqual(headerValue, cfg.secret);
}

function isFromLeviathanEdge(req, cfg = getEdgeConfig()) {
  return String(req.get(cfg.markHeaderName) || '').toLowerCase() === '1' || hasValidEdgeSecret(req, cfg);
}

function edgeGatewayGuard(req, res, next) {
  const cfg = getEdgeConfig();
  if (!cfg.enabled) return next();

  const validSecret = hasValidEdgeSecret(req, cfg);
  if (validSecret) {
    req.leviathanEdge = { trusted: true, source: 'edge-secret' };
    res.setHeader('X-Leviathan-Origin-Edge', '1');
    return next();
  }

  if (cfg.allowHealthWithoutSecret && isHealthPath(req.path || req.originalUrl)) {
    return next();
  }

  if (cfg.allowDirect && !cfg.requireSecret) {
    req.leviathanEdge = { trusted: false, source: 'direct' };
    return next();
  }

  return res.status(403).json({
    ok: false,
    code: 'edge_secret_required',
    message: 'Richiesta non autorizzata: manca il secret header del Leviathan Edge Gateway.'
  });
}

function applyEdgeGatewayGuard(app) {
  app.use(edgeGatewayGuard);
}

module.exports = {
  applyEdgeGatewayGuard,
  edgeGatewayGuard,
  getEdgeConfig,
  hasValidEdgeSecret,
  isFromLeviathanEdge
};
