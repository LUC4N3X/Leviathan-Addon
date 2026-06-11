'use strict';

const crypto = require('crypto');

const SUPPORTED_SERVICES = new Set(['rd', 'tb']);
const DEFAULT_TTL_SECONDS = 21600;
const MIN_TTL_SECONDS = 60;
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 1000;

function tokenFingerprint(value) {
  const raw = String(value || '');
  if (!raw) return 'empty';
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function stableKey(parts = []) {
  return crypto
    .createHash('sha1')
    .update(parts.map((part) => String(part ?? '')).join('|'))
    .digest('hex');
}

function normalizeService(value) {
  const service = String(value || '').trim().toLowerCase();
  return SUPPORTED_SERVICES.has(service) ? service : null;
}

function normalizeHash(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(text) ? text : null;
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function safeInteger(value, fallback = 0) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (_) {
    return null;
  }
}

function parseJsonValue(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(String(value));
  } catch (_) {
    return fallback;
  }
}

function clampLimit(value) {
  return Math.max(1, Math.min(MAX_LIMIT, safeInteger(value, DEFAULT_LIMIT)));
}

function normalizeTtlSeconds(value) {
  const seconds = safeInteger(value, DEFAULT_TTL_SECONDS);
  return Math.max(MIN_TTL_SECONDS, seconds > 0 ? seconds : DEFAULT_TTL_SECONDS);
}

function getDb() {
  try {
    return require('../../storage/db_repository');
  } catch (_) {
    return null;
  }
}

function getTorrentId(torrent = {}, info = {}) {
  return String(torrent.id || torrent.torrent_id || info.id || '').trim();
}

function getTitle(torrent = {}, info = {}) {
  return String(info.filename || info.name || torrent.filename || torrent.name || torrent.title || '').trim();
}

function getHash(torrent = {}, info = {}) {
  return normalizeHash(info.hash || info.info_hash || torrent.hash || torrent.info_hash || torrent.infoHash);
}

function getState(service, torrent = {}, info = {}) {
  if (service === 'rd') {
    return String(info.status || torrent.status || '').toLowerCase() || 'unknown';
  }

  return String(torrent.download_state || torrent.state || torrent.status || info.status || '').toLowerCase() || 'unknown';
}

function getProgress(service, torrent = {}, info = {}) {
  if (service === 'rd') {
    return getState(service, torrent, info) === 'downloaded'
      ? 100
      : safeNumber(info.progress ?? torrent.progress, 0);
  }

  return safeNumber(torrent.progress ?? info.progress, 0);
}

function getFiles(service, torrent = {}, info = {}) {
  if (service === 'rd') {
    return Array.isArray(info.files) ? info.files : [];
  }

  if (Array.isArray(torrent.files)) return torrent.files;
  if (Array.isArray(info.files)) return info.files;
  return [];
}

function getTotalSize(files = []) {
  return files.reduce((sum, file) => (
    sum + safeNumber(file.bytes ?? file.size ?? file.filesize, 0)
  ), 0);
}

function buildSnapshotRow({ service, apiKey, torrent = {}, info = {}, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  const normalizedService = normalizeService(service);
  if (!normalizedService) return null;

  const tokenFp = tokenFingerprint(apiKey);
  const torrentId = getTorrentId(torrent, info);
  const hash = getHash(torrent, info);

  if (!torrentId && !hash) return null;

  const files = getFiles(normalizedService, torrent, info);
  const title = getTitle(torrent, info);
  const snapshotKey = stableKey([normalizedService, tokenFp, torrentId || hash]);

  const payload = {
    service: normalizedService,
    torrent,
    info,
    capturedAt: new Date().toISOString()
  };

  return {
    snapshotKey,
    service: normalizedService,
    tokenFp,
    torrentId: torrentId || null,
    hash,
    title: title.slice(0, 600) || null,
    state: getState(normalizedService, torrent, info).slice(0, 80) || null,
    progress: getProgress(normalizedService, torrent, info),
    files,
    fileCount: files.length,
    totalSize: getTotalSize(files),
    payload,
    expiresAt: new Date(Date.now() + normalizeTtlSeconds(ttlSeconds) * 1000)
  };
}

function normalizeSnapshotInput(entry, service, apiKey, ttlSeconds) {
  return buildSnapshotRow({
    service,
    apiKey,
    torrent: entry?.torrent || entry || {},
    info: entry?.info || entry?.torrentInfo || entry?.details || {},
    ttlSeconds
  });
}

async function upsertSavedCloudSnapshots({ service, apiKey, torrents = [], ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const db = getDb();

  if (!db?.getPool?.() || typeof db.withClient !== 'function') {
    return { processed: 0, upserted: 0, skipped: true };
  }

  const rows = (Array.isArray(torrents) ? torrents : [])
    .map((entry) => normalizeSnapshotInput(entry, service, apiKey, ttlSeconds))
    .filter(Boolean);

  if (!rows.length) {
    return { processed: 0, upserted: 0 };
  }

  try {
    return await db.withClient(async (client) => {
      let upserted = 0;

      for (const row of rows) {
        const res = await client.query(
          `INSERT INTO debrid_account_snapshots (
             snapshot_key, service, token_fp, torrent_id, info_hash, info_hash_norm, title, state, progress,
             files_json, file_count, total_size, payload_json, first_seen_at, last_seen_at, seen_count, expires_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,NOW(),NOW(),1,$13,NOW(),NOW())
           ON CONFLICT (snapshot_key) DO UPDATE SET
             info_hash = COALESCE(EXCLUDED.info_hash, debrid_account_snapshots.info_hash),
             info_hash_norm = COALESCE(EXCLUDED.info_hash_norm, debrid_account_snapshots.info_hash_norm),
             title = COALESCE(EXCLUDED.title, debrid_account_snapshots.title),
             state = COALESCE(EXCLUDED.state, debrid_account_snapshots.state),
             progress = GREATEST(COALESCE(EXCLUDED.progress, 0), COALESCE(debrid_account_snapshots.progress, 0)),
             files_json = CASE WHEN EXCLUDED.file_count > 0 THEN EXCLUDED.files_json ELSE debrid_account_snapshots.files_json END,
             file_count = GREATEST(COALESCE(EXCLUDED.file_count, 0), COALESCE(debrid_account_snapshots.file_count, 0)),
             total_size = GREATEST(COALESCE(EXCLUDED.total_size, 0), COALESCE(debrid_account_snapshots.total_size, 0)),
             payload_json = COALESCE(EXCLUDED.payload_json, debrid_account_snapshots.payload_json),
             last_seen_at = NOW(),
             seen_count = GREATEST(COALESCE(debrid_account_snapshots.seen_count, 0), 0) + 1,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
          [
            row.snapshotKey,
            row.service,
            row.tokenFp,
            row.torrentId,
            row.hash,
            row.title,
            row.state,
            row.progress,
            safeJson(row.files),
            row.fileCount,
            row.totalSize,
            safeJson(row.payload),
            row.expiresAt
          ]
        );

        upserted += Number(res.rowCount || 0);
      }

      return { processed: rows.length, upserted };
    });
  } catch (error) {
    return {
      processed: rows.length,
      upserted: 0,
      error: error?.message || String(error)
    };
  }
}

function mapSnapshotRow(row = {}) {
  const payload = parseJsonValue(row.payload_json, {}) || {};
  const filesJson = parseJsonValue(row.files_json, []);

  const files = Array.isArray(filesJson)
    ? filesJson
    : Array.isArray(payload.info?.files)
      ? payload.info.files
      : Array.isArray(payload.torrent?.files)
        ? payload.torrent.files
        : [];

  return {
    service: row.service,
    torrent: payload.torrent || {},
    info: payload.info || {},
    files,
    title: row.title,
    hash: row.info_hash_norm,
    torrentId: row.torrent_id,
    state: row.state,
    progress: safeNumber(row.progress, 0),
    seenCount: safeNumber(row.seen_count, 0),
    lastSeenAt: row.last_seen_at
  };
}

async function getFreshSavedCloudSnapshots({ service, apiKey, limit = DEFAULT_LIMIT } = {}) {
  const db = getDb();
  const normalizedService = normalizeService(service);

  if (!db?.getPool?.() || typeof db.withClient !== 'function') return [];
  if (!normalizedService || !apiKey) return [];

  const tokenFp = tokenFingerprint(apiKey);
  const safeLimit = clampLimit(limit);

  try {
    return await db.withClient(async (client) => {
      const res = await client.query(
        `SELECT *
         FROM debrid_account_snapshots
         WHERE service = $1 AND token_fp = $2 AND expires_at > NOW()
         ORDER BY last_seen_at DESC
         LIMIT $3`,
        [normalizedService, tokenFp, safeLimit]
      );

      return (res.rows || []).map(mapSnapshotRow);
    });
  } catch (_) {
    return [];
  }
}

module.exports = {
  buildSnapshotRow,
  getFreshSavedCloudSnapshots,
  tokenFingerprint,
  upsertSavedCloudSnapshots
};
