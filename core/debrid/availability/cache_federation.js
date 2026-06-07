'use strict';

const { redisCache } = require('../../utils/redis_cache');

const NAMESPACE = 'debrid_cache';
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function intEnv(name, fallback, min, max) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

const CONFIG = {
  ENABLED: boolEnv('DEBRID_CACHE_FEDERATION_ENABLED', false),
  TTL_SECONDS: intEnv('DEBRID_CACHE_FEDERATION_TTL_SECONDS', DEFAULT_TTL_SECONDS, 300, 60 * 24 * 60 * 60)
};

function isEnabled() {
  return CONFIG.ENABLED && redisCache.isEnabled();
}

function normalizeService(service) {
  const value = String(service || '').trim().toLowerCase();
  if (value === 'realdebrid' || value === 'real-debrid') return 'rd';
  if (value === 'torbox') return 'tb';
  return value || 'rd';
}

function normalizeHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(hash) ? hash : null;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function getFederatedCachedHashes(service, hashes) {
  const out = new Set();
  if (!isEnabled()) return out;

  const wanted = [...new Set((Array.isArray(hashes) ? hashes : []).map(normalizeHash).filter(Boolean))];
  if (wanted.length === 0) return out;

  const serviceKey = normalizeService(service);
  const values = await redisCache.hmget(NAMESPACE, serviceKey, wanted);
  const now = nowSeconds();
  const expired = [];

  wanted.forEach((hash, index) => {
    const raw = values[index];
    if (raw === null || raw === undefined) return;
    const expiry = parseInt(raw, 10);
    if (Number.isFinite(expiry) && expiry > now) out.add(hash);
    else expired.push(hash);
  });

  if (expired.length > 0) redisCache.hdel(NAMESPACE, serviceKey, expired).catch(() => {});
  return out;
}

function storeFederatedCachedHashes(service, hashes, ttlSeconds = CONFIG.TTL_SECONDS) {
  if (!isEnabled()) return false;

  const valid = [...new Set((Array.isArray(hashes) ? hashes : [hashes]).map(normalizeHash).filter(Boolean))];
  if (valid.length === 0) return false;

  const serviceKey = normalizeService(service);
  const ttl = Math.max(300, Math.floor(Number(ttlSeconds) || CONFIG.TTL_SECONDS));
  const expiry = String(nowSeconds() + ttl);
  const pairs = valid.map((hash) => [hash, expiry]);

  redisCache.hsetMany(NAMESPACE, serviceKey, pairs)
    .then((ok) => (ok ? redisCache.expire(NAMESPACE, serviceKey, ttl) : false))
    .catch(() => {});
  return true;
}

module.exports = {
  isEnabled,
  normalizeService,
  getFederatedCachedHashes,
  storeFederatedCachedHashes
};
