'use strict';

const crypto = require('crypto');

function tokenFingerprint(value) {
  const raw = String(value || '');
  if (!raw) return 'empty';
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function stableKey(parts = []) {
  return crypto.createHash('sha1').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex');
}

function normalizeHash(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(text) ? text : null;
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function safeJson(value) {
  try { return JSON.stringify(value ?? null); } catch (_) { return null; }
}

function getDb() {
  try {
    return require('../../storage/db_repository');
  } catch (_) {
    return null;
  }
}

function getTorrentId(service, torrent = {}, info = {}) {
  return String(torrent.id || torrent.torrent_id || info.id || '').trim();
}

function getTitle(service, torrent = {}, info = {}) {
  return String(info.filename || info.name || torrent.filename || torrent.name || torrent.title || '').trim();
}

function getHash(service, torrent = {}, info = {}) {
  return normalizeHash(info.hash || info.info_hash || torrent.hash || torrent.info_hash || torrent.infoHash);
}

function getState(service, torrent = {}, info = {}) {
  if (service === 'rd') return String(info.status || torrent.status || '').toLowerCase() || 'unknown';
  return String(torrent.download_state || torrent.state || torrent.status || '').toLowerCase() || 'unknown';
}

function getProgress(service, torrent = {}, info = {}) {
  if (service === 'rd') return getState(service, torrent, info) === 'downloaded' ? 100 : safeNumber(info.progress ?? torrent.progress, 0);
  return safeNumber(torrent.progress ?? info.progress, 0);
}

function getFiles(service, torrent = {}, info = {}) {
  if (service === 'rd') return Array.isArray(info.files) ? info.files : [];
  return Array.isArray(torrent.files) ? torrent.files : (Array.isArray(info.files) ? info.files : []);
}

function getTotalSize(files = []) {
  return files.reduce((sum, file) => sum + safeNumber(file.bytes ?? file.size ?? file.filesize, 0), 0);
}

function buildSnapshotRow({ service, apiKey, torrent = {}, info = {}, ttlSeconds = 21600 }) {
  const normalizedService = String(service || '').toLowerCase();
  if (!['rd', 'tb'].includes(normalizedService)) return null;
  const tokenFp = tokenFingerprint(apiKey);
  const torrentId = getTorrentId(normalizedService, torrent, info);
  const hash = getHash(normalizedService, torrent, info);
  if (!torrentId && !hash) return null;

  const files = getFiles(normalizedService, torrent, info);
  const payload = {
    service: normalizedService,
    torrent,
    info,
    capturedAt: new Date().toISOString()
  };
  const snapshotKey = stableKey([normalizedService, tokenFp, torrentId || hash]);
  return {
    snapshotKey,
    service: normalizedService,
    tokenFp,
    torrentId: torrentId || null,
    hash,
    title: getTitle(normalizedService, torrent, info).slice(0, 600) || null,
    state: getState(normalizedService, torrent, info).slice(0, 80) || null,
    progress: getProgress(normalizedService, torrent, info),
    files,
    fileCount: files.length,
    totalSize: getTotalSize(files),
    payload,
    expiresAt: new Date(Date.now() + Math.max(60, Number(ttlSeconds || 21600)) * 1000)
  };
}

async function upsertSavedCloudSnapshots({ service, apiKey, torrents = [], ttlSeconds = 21600 } = {}) {
  const db = getDb();
  if (!db?.getPool?.() || typeof db.withClient !== 'function') return { processed: 0, upserted: 0, skipped: true };
  const rows = (Array.isArray(torrents) ? torrents : [])
    .map((entry) => buildSnapshotRow({
      service,
      apiKey,
      torrent: entry?.torrent || entry,
      info: entry?.info || entry?.torrentInfo || entry?.details || {},
      ttlSeconds
    }))
    .filter(Boolean);
  if (!rows.length) return { processed: 0, upserted: 0 };

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
            row.snapshotKey, row.service, row.tokenFp, row.torrentId, row.hash, row.title, row.state,
            row.progress, safeJson(row.files), row.fileCount, row.totalSize, safeJson(row.payload), row.expiresAt
          ]
        );
        upserted += Number(res.rowCount || 0);
      }
      return { processed: rows.length, upserted };
    });
  } catch (error) {
    return { processed: rows.length, upserted: 0, error: error.message };
  }
}

async function getFreshSavedCloudSnapshots({ service, apiKey, limit = 250 } = {}) {
  const db = getDb();
  if (!db?.getPool?.() || typeof db.withClient !== 'function') return [];
  const normalizedService = String(service || '').toLowerCase();
  if (!['rd', 'tb'].includes(normalizedService) || !apiKey) return [];
  const tokenFp = tokenFingerprint(apiKey);
  const safeLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 250));

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
      return (res.rows || []).map((row) => {
        const payload = row.payload_json && typeof row.payload_json === 'object' ? row.payload_json : {};
        const files = Array.isArray(row.files_json) ? row.files_json : (Array.isArray(payload.info?.files) ? payload.info.files : (Array.isArray(payload.torrent?.files) ? payload.torrent.files : []));
        return {
          service: row.service,
          torrent: payload.torrent || {},
          info: payload.info || {},
          files,
          title: row.title,
          hash: row.info_hash_norm,
          torrentId: row.torrent_id,
          state: row.state,
          progress: row.progress,
          seenCount: Number(row.seen_count || 0) || 0,
          lastSeenAt: row.last_seen_at
        };
      });
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
