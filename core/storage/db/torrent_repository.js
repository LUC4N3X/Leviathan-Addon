const crypto = require('crypto');
const { buildSmartDedupeKey, getFolderSizeBytes, getSizeBytes } = require('../../stream/infohash_deduper');
const { inferEpisodeHintFromPackFiles } = require('../../stream/episode_precision');

function createTorrentRepository({
  getPool,
  withClient,
  runInTransaction,
  awaitDatabaseOptimizations,
  trackerRegistry,
  normalizers
}) {
  const {
    clampInt,
    toNullableInt,
    toSafeNumber,
    sanitizeText,
    normalizeInfoHash,
    normalizeUniqueInfoHashes,
    normalizeImdbId,
    normalizeFileIndex,
    normalizeFileIndexNorm,
    normalizeRdCacheState,
    deriveStoredCacheState,
    deriveCachedBooleanFromState,
    extractOriginalProvider,
    normalizeUniqueTextList,
    toDateOrNull
  } = normalizers;

  const RD_CACHED_RECHECK_HOURS = 168;
  const RD_REVALIDATE_PERMANENT_ON_BOOT = true;


  function cleanTorrentioProviderLabel(value = '') {
    const raw = sanitizeText(value).replace(/\[EXT\]\s*/gi, '').replace(/LeviathanDB/gi, '').replace(/[()]/g, '').trim();
    if (!raw) return '';
    const cleaned = raw
      .replace(/^Torrentio\s*(?:·|:|-|\/)?\s*/i, '')
      .replace(/^Torrentio\s+/i, '')
      .trim();
    return cleaned || raw;
  }

  function normalizeProviderName(providerName, title) {
    const normalized = cleanTorrentioProviderLabel(providerName);
    if (normalized && !/^(?:external|unknown|n\/a|null|undefined|p2p|torrent|torrentio|mirror|main|fallback|addon)$/i.test(normalized)) return normalized;

    const extracted = extractOriginalProvider(title);
    if (extracted) return extracted;
    if (!normalized || normalized === 'Torrentio' || normalized === 'P2P') return 'External';
    return normalized;
  }

  function normalizeStoredType(value) {
    const normalized = sanitizeText(value).toLowerCase();
    if (!normalized) return null;
    if (['movie', 'series', 'anime', 'p2p', 'torrent', 'pack'].includes(normalized)) return normalized;
    return normalized.slice(0, 32);
  }

  function normalizeResolution(value, title = '') {
    const text = sanitizeText(value) || sanitizeText(title);
    if (!text) return null;
    const lower = text.toLowerCase();
    if (/\b(?:8k|4320p)\b/i.test(lower)) return '4320p';
    if (/\b(?:4k|2160p|uhd)\b/i.test(lower)) return '2160p';
    const match = lower.match(/\b(1080p|720p|576p|540p|480p|360p)\b/i);
    return match ? match[1].toLowerCase() : null;
  }

  function normalizeDelimitedText(value, limit = 4096) {
    if (value === null || value === undefined) return null;
    const values = Array.isArray(value)
      ? value
      : String(value).split(/[,|;]/g);
    const normalized = normalizeUniqueTextList(values, 80).join(',');
    return normalized ? normalized.slice(0, limit) : null;
  }

  function extractTrackersFromMagnet(value) {
    const text = String(value || '');
    if (!/^magnet:/i.test(text)) return [];
    const trackers = [];
    const regex = /[?&]tr=([^&]+)/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
      try {
        const decoded = decodeURIComponent(match[1]).trim();
        if (/^(udp|http|https|ws|wss):\/\//i.test(decoded)) trackers.push(decoded);
      } catch (_) {}
    }
    return trackers;
  }

  function normalizeTrackers(torrent = {}) {
    const candidates = [];
    candidates.push(torrent?.trackers);
    candidates.push(torrent?.trackerList);
    candidates.push(torrent?.announce);
    candidates.push(torrent?.sources);
    candidates.push(extractTrackersFromMagnet(torrent?.magnet || torrent?.magnetLink || torrent?.url));
    const flattened = candidates.flatMap((entry) => Array.isArray(entry) ? entry : (entry ? [entry] : []));
    const trackers = flattened
      .flatMap((entry) => String(entry || '').split(/[,|;]/g))
      .map((entry) => entry.replace(/^tracker:/i, '').trim())
      .filter((entry) => /^(udp|http|https|ws|wss):\/\//i.test(entry));
    return normalizeDelimitedText(trackers, 4096);
  }

  function normalizeLanguages(torrent = {}) {
    return normalizeDelimitedText(torrent?.languages || torrent?.language || torrent?.langs || torrent?._languages, 2048);
  }

  function normalizeQualityTag(torrent = {}) {
    const text = sanitizeText(torrent?.quality || torrent?.qualityTag || torrent?.quality_tag || torrent?.title);
    if (!text) return null;
    const sourceMatch = text.match(/\b(?:remux|bluray|blu[-.\s]?ray|web[-.\s]?dl|webrip|hdtv|bdrip|hdrip|dvdrip|cam|telesync|telecine)\b/i);
    return sourceMatch ? sourceMatch[0].replace(/\s+/g, '-').toLowerCase().slice(0, 32) : null;
  }

  function normalizeSmartToken(value) {
    return sanitizeText(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .toLowerCase();
  }

  function joinedTorrentSignalText(torrent = {}) {
    return [
      torrent?.filename,
      torrent?.fileName,
      torrent?.file_name,
      torrent?.file_title,
      torrent?.title,
      torrent?.name,
      torrent?.rawTitle,
      torrent?.description,
      torrent?.resolution,
      torrent?.quality,
      torrent?.quality_tag,
      torrent?.codec,
      torrent?.codec_tag,
      torrent?.videoCodec,
      torrent?.encode,
      torrent?.hdr,
      torrent?.hdr_tag,
      torrent?.audio,
      torrent?.audio_tag,
      torrent?.releaseGroup,
      torrent?.release_group,
      torrent?.group,
      torrent?.behaviorHints?.filename,
      torrent?.behaviorHints?.fileName,
      torrent?.episodeFileHint?.fileName,
      torrent?.episodeFileHint?.filePath,
      torrent?._episodeFileHint?.fileName,
      torrent?._episodeFileHint?.filePath
    ].filter(Boolean).join(' ');
  }

  function normalizeCodecTag(torrent = {}) {
    const text = normalizeSmartToken([torrent?.codec, torrent?.codec_tag, torrent?.videoCodec, torrent?.encode, joinedTorrentSignalText(torrent)].filter(Boolean).join(' '));
    const match = text.match(/\b(av1|x265|h265|hevc|x264|h264|vp9)\b/);
    if (!match) return null;
    const value = match[1];
    if (value === 'h265' || value === 'hevc') return 'x265';
    if (value === 'h264') return 'x264';
    return value.slice(0, 24);
  }

  function normalizeHdrTag(torrent = {}) {
    const text = normalizeSmartToken([torrent?.hdr, torrent?.hdr_tag, torrent?.visualTag, torrent?.visualTags, joinedTorrentSignalText(torrent)].filter(Boolean).join(' '));
    if (/\bdolby vision\b|\bdv\b/.test(text)) return 'dv';
    if (/\bhdr10\+/.test(text)) return 'hdr10+';
    if (/\bhdr10\b/.test(text)) return 'hdr10';
    if (/\bhdr\b/.test(text)) return 'hdr';
    return null;
  }

  function normalizeAudioTag(torrent = {}) {
    const text = normalizeSmartToken([torrent?.audio, torrent?.audio_tag, torrent?.audioTag, torrent?.audioTags, joinedTorrentSignalText(torrent)].filter(Boolean).join(' '));
    if (/\btruehd\b/.test(text)) return 'truehd';
    if (/\batmos\b/.test(text)) return 'atmos';
    if (/\bdts[- ]?hd\b/.test(text)) return 'dts-hd';
    if (/\bdts\b/.test(text)) return 'dts';
    if (/\beac3\b|\bddp\b|\bdd\+\b/.test(text)) return 'eac3';
    if (/\bac3\b/.test(text)) return 'ac3';
    if (/\baac\b/.test(text)) return 'aac';
    return null;
  }

  function normalizeReleaseGroupTag(torrent = {}) {
    const explicit = normalizeSmartToken(torrent?.releaseGroup || torrent?.release_group || torrent?.group || torrent?.uploader || torrent?.provider);
    if (explicit && explicit.length <= 32) return explicit.replace(/\s+/g, '').slice(0, 32);
    const raw = sanitizeText(joinedTorrentSignalText(torrent));
    const match = raw.match(/[-.\s]([A-Za-z0-9][A-Za-z0-9._-]{1,31})\s*(?:\.[A-Za-z0-9]{2,5})?$/);
    return match ? normalizeSmartToken(match[1]).replace(/\s+/g, '').slice(0, 32) : null;
  }

  function normalizeFolderSize(torrent = {}) {
    const folderSize = getFolderSizeBytes(torrent);
    const fileSize = getSizeBytes(torrent);
    const best = Math.max(Number(folderSize || 0), Number(fileSize || 0));
    return Number.isFinite(best) && best > 0 ? Math.round(best) : 0;
  }

  function normalizeSmartDedupeKeyForDb(torrent = {}) {
    try {
      const key = buildSmartDedupeKey(torrent, {
        isSeries: Boolean(torrent?.isSeries || torrent?.season || torrent?.episode || torrent?.imdb_season || torrent?.imdb_episode),
        season: torrent?.season ?? torrent?.imdb_season,
        episode: torrent?.episode ?? torrent?.imdb_episode
      });
      return key ? key.slice(0, 96) : null;
    } catch (_) {
      return null;
    }
  }

  function normalizeEpisodeIdentity(entry) {
    const imdbId = normalizeImdbId(entry?.imdb_id || entry?.imdbId);
    const imdbSeason = toNullableInt(entry?.imdb_season ?? entry?.season);
    const imdbEpisode = toNullableInt(entry?.imdb_episode ?? entry?.episode);
    const isEpisode = Boolean(imdbId && imdbSeason !== null && imdbSeason > 0 && imdbEpisode !== null && imdbEpisode > 0);
    return { imdbId, imdbSeason, imdbEpisode, isEpisode };
  }

  async function upsertEpisodeScopedOverrideRow(client, entry) {
    const hash = normalizeInfoHash(entry?.hash || entry?.info_hash || entry?.infoHash);
    const identity = normalizeEpisodeIdentity(entry);
    if (!hash || !identity.isEpisode) return false;

    const rdFileIndex = normalizeFileIndex(entry?.rd_file_index);
    const rdFileSize = entry?.rd_file_size === null || entry?.rd_file_size === undefined ? null : toSafeNumber(entry?.rd_file_size, 0);
    const tbFileId = normalizeFileIndex(entry?.tb_file_id ?? entry?.file_id);
    const tbFileSize = entry?.tb_file_size === null || entry?.tb_file_size === undefined ? null : toSafeNumber(entry?.tb_file_size, 0);

    await client.query(
      `
        INSERT INTO episode_file_overrides (
          info_hash,
          info_hash_norm,
          imdb_id,
          imdb_season,
          imdb_episode,
          rd_file_index,
          rd_file_size,
          tb_file_id,
          tb_file_size,
          created_at,
          updated_at
        )
        VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT (info_hash_norm, imdb_id, imdb_season, imdb_episode)
        DO UPDATE SET
          rd_file_index = CASE
            WHEN EXCLUDED.rd_file_index IS NULL OR EXCLUDED.rd_file_index < 0 THEN episode_file_overrides.rd_file_index
            ELSE EXCLUDED.rd_file_index
          END,
          rd_file_size = CASE
            WHEN EXCLUDED.rd_file_size IS NULL OR EXCLUDED.rd_file_size <= 0 THEN episode_file_overrides.rd_file_size
            ELSE EXCLUDED.rd_file_size
          END,
          tb_file_id = CASE
            WHEN EXCLUDED.tb_file_id IS NULL OR EXCLUDED.tb_file_id < 0 THEN episode_file_overrides.tb_file_id
            ELSE EXCLUDED.tb_file_id
          END,
          tb_file_size = CASE
            WHEN EXCLUDED.tb_file_size IS NULL OR EXCLUDED.tb_file_size <= 0 THEN episode_file_overrides.tb_file_size
            ELSE EXCLUDED.tb_file_size
          END,
          updated_at = NOW()
      `,
      [hash, identity.imdbId, identity.imdbSeason, identity.imdbEpisode, rdFileIndex, rdFileSize, tbFileId, tbFileSize]
    );

    return true;
  }

  function normalizeTorrentRow(row) {
    const infoHash = normalizeInfoHash(row?.info_hash);
    if (!infoHash) return null;
    return {
      title: sanitizeText(row.title, infoHash),
      info_hash: infoHash,
      size: toSafeNumber(row.size, 0),
      seeders: toSafeNumber(row.seeders, 0),
      provider: cleanTorrentioProviderLabel(row.provider) || 'Unknown',
      torrent_id: sanitizeText(row.torrent_id),
      type: normalizeStoredType(row.type),
      upload_date: row.upload_date || null,
      trackers: sanitizeText(row.trackers),
      languages: sanitizeText(row.languages),
      resolution: sanitizeText(row.resolution),
      quality_tag: sanitizeText(row.quality_tag),
      codec_tag: sanitizeText(row.codec_tag),
      hdr_tag: sanitizeText(row.hdr_tag),
      audio_tag: sanitizeText(row.audio_tag),
      release_group: sanitizeText(row.release_group),
      smart_dedupe_key: sanitizeText(row.smart_dedupe_key),
      folder_size: toSafeNumber(row.folder_size, 0),
      first_seen_at: row.first_seen_at || null,
      last_seen_at: row.last_seen_at || null,
      seen_count: toSafeNumber(row.seen_count, 0),
      max_seeders: toSafeNumber(row.max_seeders, 0),
      magnet: trackerRegistry.buildMagnet(infoHash, row.trackers ? String(row.trackers).split(',') : []),
      file_index: normalizeFileIndex(row.file_index),
      matched_file_index: normalizeFileIndex(row.matched_file_index),
      matched_file_title: sanitizeText(row.matched_file_title),
      cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
      rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
      rd_file_index: normalizeFileIndex(row.rd_file_index),
      rd_file_size: toSafeNumber(row.rd_file_size, 0),
      last_cached_check: row.last_cached_check || null,
      next_cached_check: row.next_cached_check || null,
      cache_check_failures: toSafeNumber(row.cache_check_failures, 0),
      tb_cached: row.tb_cached === null || row.tb_cached === undefined ? null : Boolean(row.tb_cached),
      tb_file_id: normalizeFileIndex(row.tb_file_id),
      tb_file_size: toSafeNumber(row.tb_file_size, 0),
      tb_last_cached_check: row.tb_last_cached_check || null
    };
  }

  async function getTorrents(imdbId, season, episode) {
    const pool = getPool();
    if (!pool) return [];
    await awaitDatabaseOptimizations();

    const normalizedImdb = normalizeImdbId(imdbId);
    if (!normalizedImdb) return [];

    const normalizedSeason = toNullableInt(season);
    const normalizedEpisode = toNullableInt(episode);
    const isSeriesEpisode = normalizedSeason !== null && normalizedSeason > 0 && normalizedEpisode !== null && normalizedEpisode > 0;

    const params = isSeriesEpisode
      ? [normalizedImdb, normalizedSeason, normalizedEpisode]
      : [normalizedImdb];

    const query = isSeriesEpisode
      ? `
        WITH episode_matches AS (
          SELECT
            info_hash_norm AS hash_norm,
            file_index AS matched_file_index,
            file_index_norm AS matched_file_index_norm,
            title AS matched_file_title,
            size AS matched_file_size,
            1 AS source_rank
          FROM files
          WHERE imdb_id = $1
            AND imdb_season = $2
            AND imdb_episode = $3

          UNION ALL

          SELECT
            pack_hash_norm AS hash_norm,
            file_index AS matched_file_index,
            file_index_norm AS matched_file_index_norm,
            COALESCE(NULLIF(file_title, ''), NULLIF(file_path, ''), pack_hash_norm) AS matched_file_title,
            file_size AS matched_file_size,
            2 AS source_rank
          FROM pack_files
          WHERE imdb_id = $1
            AND imdb_season = $2
            AND imdb_episode = $3
        ),
        dedup_matches AS (
          SELECT DISTINCT ON (hash_norm, matched_file_index_norm)
            hash_norm,
            matched_file_index,
            matched_file_index_norm,
            matched_file_title,
            matched_file_size,
            source_rank
          FROM episode_matches
          WHERE hash_norm IS NOT NULL
          ORDER BY
            hash_norm,
            matched_file_index_norm,
            source_rank ASC,
            COALESCE(matched_file_size, 0) DESC,
            LENGTH(COALESCE(matched_file_title, '')) DESC
        ),
        episode_overrides AS (
          SELECT
            info_hash_norm AS hash_norm,
            rd_file_index,
            rd_file_size,
            tb_file_id,
            tb_file_size
          FROM episode_file_overrides
          WHERE imdb_id = $1
            AND imdb_season = $2
            AND imdb_episode = $3
        )
        SELECT DISTINCT ON (t.info_hash_norm, COALESCE(m.matched_file_index_norm, t.file_index_norm))
          t.title,
          TRIM(t.info_hash) AS info_hash,
          t.size,
          t.seeders,
          t.provider,
          t.torrent_id,
          t.type,
          t.upload_date,
          t.trackers,
          t.languages,
          t.resolution,
          t.quality_tag,
          t.codec_tag,
          t.hdr_tag,
          t.audio_tag,
          t.release_group,
          t.smart_dedupe_key,
          t.folder_size,
          t.first_seen_at,
          t.last_seen_at,
          t.seen_count,
          t.max_seeders,
          COALESCE(m.matched_file_index, t.file_index) AS file_index,
          m.matched_file_index,
          m.matched_file_title,
          t.cached_rd,
          t.rd_cache_state,
          COALESCE(o.rd_file_index, t.rd_file_index) AS rd_file_index,
          COALESCE(o.rd_file_size, t.rd_file_size) AS rd_file_size,
          t.last_cached_check,
          t.next_cached_check,
          t.cache_check_failures,
          t.tb_cached,
          COALESCE(o.tb_file_id, t.tb_file_id) AS tb_file_id,
          COALESCE(o.tb_file_size, t.tb_file_size) AS tb_file_size,
          t.tb_last_cached_check
        FROM dedup_matches m
        JOIN torrents t
          ON t.info_hash_norm = m.hash_norm
        LEFT JOIN episode_overrides o
          ON o.hash_norm = t.info_hash_norm
        ORDER BY
          t.info_hash_norm,
          COALESCE(m.matched_file_index_norm, t.file_index_norm),
          CASE WHEN COALESCE(o.rd_file_index, t.rd_file_index) IS NOT NULL THEN 1 ELSE 0 END DESC,
          CASE WHEN t.cached_rd IS TRUE THEN 1 ELSE 0 END DESC,
          GREATEST(COALESCE(t.seeders, 0), COALESCE(t.max_seeders, 0)) DESC,
          COALESCE(t.seen_count, 0) DESC,
          COALESCE(t.last_seen_at, t.updated_at, t.created_at) DESC NULLS LAST,
          COALESCE(m.matched_file_size, t.folder_size, t.rd_file_size, t.size, 0) DESC
      `
      : `
        WITH matched_files AS (
          SELECT DISTINCT info_hash_norm, file_index_norm
          FROM files
          WHERE imdb_id = $1
            AND (imdb_season IS NULL OR imdb_season = 0)
        )
        SELECT DISTINCT ON (t.info_hash_norm, t.file_index_norm)
          t.title,
          TRIM(t.info_hash) AS info_hash,
          t.size,
          t.seeders,
          t.provider,
          t.torrent_id,
          t.type,
          t.upload_date,
          t.trackers,
          t.languages,
          t.resolution,
          t.quality_tag,
          t.codec_tag,
          t.hdr_tag,
          t.audio_tag,
          t.release_group,
          t.smart_dedupe_key,
          t.folder_size,
          t.first_seen_at,
          t.last_seen_at,
          t.seen_count,
          t.max_seeders,
          t.file_index,
          NULL::INTEGER AS matched_file_index,
          NULL::TEXT AS matched_file_title,
          t.cached_rd,
          t.rd_cache_state,
          t.rd_file_index,
          t.rd_file_size,
          t.last_cached_check,
          t.next_cached_check,
          t.cache_check_failures,
          t.tb_cached,
          t.tb_file_id,
          t.tb_file_size,
          t.tb_last_cached_check
        FROM matched_files f
        JOIN torrents t
          ON t.info_hash_norm = f.info_hash_norm
         AND (
           f.file_index_norm = -1
           OR t.file_index_norm = f.file_index_norm
         )
        ORDER BY
          t.info_hash_norm,
          t.file_index_norm,
          CASE WHEN t.cached_rd IS TRUE THEN 1 ELSE 0 END DESC,
          GREATEST(COALESCE(t.seeders, 0), COALESCE(t.max_seeders, 0)) DESC,
          COALESCE(t.seen_count, 0) DESC,
          COALESCE(t.last_seen_at, t.updated_at, t.created_at) DESC NULLS LAST,
          COALESCE(t.folder_size, t.size, 0) DESC
      `;

    try {
      return await withClient(async (client) => {
        const res = await client.query(query, params);
        return res.rows.map(normalizeTorrentRow).filter(Boolean);
      });
    } catch (error) {
      console.error(`❌ DB Read Error (${normalizedImdb}): ${error.message}`);
      return [];
    }
  }

  async function upsertTorrentRow(client, torrent) {
    const infoHash = normalizeInfoHash(torrent?.infoHash || torrent?.info_hash || torrent?.hash);
    if (!infoHash) return false;

    const fileIndex = normalizeFileIndex(torrent?.fileIndex ?? torrent?.file_index ?? torrent?.fileIdx);
    const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
    const providerName = normalizeProviderName(torrent?.provider || torrent?.providerName, torrent?.title);
    const title = sanitizeText(torrent?.title, infoHash);
    const size = Math.max(0, toSafeNumber(torrent?.size, 0));
    const seeders = Math.max(0, toSafeNumber(torrent?.seeders, 0));
    const torrentId = sanitizeText(torrent?.torrentId || torrent?.torrent_id || torrent?.id);
    const storedType = normalizeStoredType(torrent?.type || (torrent?.isAnime ? 'anime' : (torrent?.is_pack ? 'pack' : null)));
    const uploadDate = toDateOrNull(torrent?.uploadDate || torrent?.upload_date || torrent?.publishedAt || torrent?.published_at || torrent?.date);
    const trackers = normalizeTrackers(torrent);
    const languages = normalizeLanguages(torrent);
    const resolution = normalizeResolution(torrent?.resolution || torrent?.quality, title);
    const qualityTag = normalizeQualityTag(torrent);
    const codecTag = normalizeCodecTag(torrent);
    const hdrTag = normalizeHdrTag(torrent);
    const audioTag = normalizeAudioTag(torrent);
    const releaseGroup = normalizeReleaseGroupTag(torrent);
    const smartDedupeKey = normalizeSmartDedupeKeyForDb(torrent);
    const folderSize = normalizeFolderSize(torrent);

    const updateRes = await client.query(
      `
        UPDATE torrents
        SET provider = COALESCE(NULLIF($3, ''), provider),
            torrent_id = COALESCE(NULLIF($7, ''), torrent_id),
            type = COALESCE(NULLIF($8, ''), type),
            upload_date = COALESCE($9::timestamptz, upload_date),
            trackers = COALESCE(NULLIF($10, ''), trackers),
            languages = COALESCE(NULLIF($11, ''), languages),
            resolution = COALESCE(NULLIF($12, ''), resolution),
            quality_tag = COALESCE(NULLIF($13, ''), quality_tag),
            codec_tag = COALESCE(NULLIF($14, ''), codec_tag),
            hdr_tag = COALESCE(NULLIF($15, ''), hdr_tag),
            audio_tag = COALESCE(NULLIF($16, ''), audio_tag),
            release_group = COALESCE(NULLIF($17, ''), release_group),
            smart_dedupe_key = COALESCE(NULLIF($18, ''), smart_dedupe_key),
            folder_size = GREATEST(COALESCE(folder_size, 0), $19::bigint),
            max_seeders = GREATEST(COALESCE(max_seeders, 0), $6::integer),
            seen_count = GREATEST(COALESCE(seen_count, 0), 0) + 1,
            first_seen_at = COALESCE(first_seen_at, created_at, NOW()),
            last_seen_at = NOW(),
            title = CASE
              WHEN title IS NULL OR title = '' THEN $4
              WHEN LENGTH($4) > LENGTH(title) THEN $4
              ELSE title
            END,
            size = GREATEST(COALESCE(size, 0), $5::bigint),
            seeders = GREATEST(COALESCE(seeders, 0), $6::integer),
            file_index = CASE
              WHEN $2 = -1 THEN file_index
              ELSE $2
            END,
            file_index_norm = $2,
            info_hash = COALESCE(NULLIF(info_hash, ''), $1),
            info_hash_norm = $1,
            updated_at = NOW()
        WHERE info_hash_norm = $1
          AND file_index_norm = $2
        RETURNING 1
      `,
      [infoHash, fileIndexNorm, providerName, title, size, seeders, torrentId, storedType, uploadDate, trackers, languages, resolution, qualityTag, codecTag, hdrTag, audioTag, releaseGroup, smartDedupeKey, folderSize]
    );

    if (updateRes.rowCount > 0) return false;

    const insertRes = await client.query(
      `
        INSERT INTO torrents (
          info_hash,
          info_hash_norm,
          file_index,
          file_index_norm,
          provider,
          torrent_id,
          type,
          title,
          size,
          seeders,
          upload_date,
          trackers,
          languages,
          resolution,
          quality_tag,
          codec_tag,
          hdr_tag,
          audio_tag,
          release_group,
          smart_dedupe_key,
          folder_size,
          first_seen_at,
          last_seen_at,
          seen_count,
          max_seeders,
          created_at,
          updated_at
        )
        VALUES ($1, $1, $2, $3, $4, $8, $9, $5, $6, $7::integer, $10::timestamptz, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::bigint, NOW(), NOW(), 1, $7::integer, NOW(), NOW())
        ON CONFLICT DO NOTHING
        RETURNING 1
      `,
      [infoHash, fileIndex, fileIndexNorm, providerName, title, size, seeders, torrentId, storedType, uploadDate, trackers, languages, resolution, qualityTag, codecTag, hdrTag, audioTag, releaseGroup, smartDedupeKey, folderSize]
    );

    return insertRes.rowCount > 0;
  }

  async function upsertFileMappingRow(client, mapping) {
    const infoHash = normalizeInfoHash(mapping?.infoHash || mapping?.info_hash || mapping?.hash);
    const imdbId = normalizeImdbId(mapping?.imdb_id || mapping?.imdbId);
    if (!infoHash || !imdbId) return false;

    const fileIndex = normalizeFileIndex(mapping?.file_index ?? mapping?.fileIdx);
    const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
    const imdbSeason = toNullableInt(mapping?.imdb_season ?? mapping?.season);
    const imdbEpisode = toNullableInt(mapping?.imdb_episode ?? mapping?.episode);
    const title = sanitizeText(mapping?.title, '');
    const size = Math.max(0, toSafeNumber(mapping?.size, 0));

    const sameIdentityUpdateRes = await client.query(
      `
        UPDATE files
        SET imdb_id = $3,
            imdb_season = $4,
            imdb_episode = $5,
            title = CASE
              WHEN COALESCE(title, '') = '' THEN $6
              WHEN LENGTH($6) > LENGTH(title) THEN $6
              ELSE title
            END,
            size = GREATEST(COALESCE(size, 0), $7),
            file_index = CASE
              WHEN $2 = -1 THEN file_index
              ELSE $2
            END,
            file_index_norm = $2,
            info_hash = COALESCE(NULLIF(info_hash, ''), $1),
            info_hash_norm = $1,
            updated_at = NOW()
        WHERE info_hash_norm = $1
          AND file_index_norm = $2
          AND imdb_id = $3
          AND imdb_season IS NOT DISTINCT FROM $4
          AND imdb_episode IS NOT DISTINCT FROM $5
        RETURNING 1
      `,
      [infoHash, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, title, size]
    );

    if (sameIdentityUpdateRes.rowCount > 0) return false;

    const changedIdentityUpdateRes = await client.query(
      `
        UPDATE files
        SET imdb_id = $3,
            imdb_season = $4,
            imdb_episode = $5,
            title = CASE
              WHEN COALESCE(title, '') = '' THEN $6
              WHEN LENGTH($6) > LENGTH(title) THEN $6
              ELSE title
            END,
            size = GREATEST(COALESCE(size, 0), $7),
            file_index = CASE
              WHEN $2 = -1 THEN file_index
              ELSE $2
            END,
            file_index_norm = $2,
            info_hash = COALESCE(NULLIF(info_hash, ''), $1),
            info_hash_norm = $1,
            updated_at = NOW()
        WHERE info_hash_norm = $1
          AND file_index_norm = $2
        RETURNING 1
      `,
      [infoHash, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, title, size]
    );

    if (changedIdentityUpdateRes.rowCount > 0) return true;

    const insertRes = await client.query(
      `
        INSERT INTO files (
          info_hash,
          info_hash_norm,
          file_index,
          file_index_norm,
          imdb_id,
          imdb_season,
          imdb_episode,
          title,
          size,
          created_at,
          updated_at
        )
        VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        ON CONFLICT DO NOTHING
        RETURNING 1
      `,
      [infoHash, fileIndex, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, title, size]
    );

    return insertRes.rowCount > 0;
  }

  async function upsertPackFileRow(client, file) {
    const packHash = normalizeInfoHash(file?.pack_hash || file?.packHash || file?.info_hash || file?.infoHash || file?.hash);
    if (!packHash) return false;

    const fileIndex = normalizeFileIndex(file?.file_index ?? file?.fileIdx ?? file?.index);
    const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
    const imdbId = normalizeImdbId(file?.imdb_id || file?.imdbId);
    const imdbSeason = toNullableInt(file?.imdb_season ?? file?.season);
    const imdbEpisode = toNullableInt(file?.imdb_episode ?? file?.episode);
    const filePath = sanitizeText(file?.file_path || file?.path);
    const fileTitle = sanitizeText(file?.file_title || file?.title || (filePath ? filePath.split('/').pop() : ''), '');
    const fileSize = Math.max(0, toSafeNumber(file?.file_size ?? file?.size, 0));

    const updateRes = await client.query(
      `
        UPDATE pack_files
        SET imdb_id = COALESCE($3, imdb_id),
            imdb_season = COALESCE($4, imdb_season),
            imdb_episode = COALESCE($5, imdb_episode),
            file_path = CASE
              WHEN COALESCE(file_path, '') = '' THEN $6
              ELSE file_path
            END,
            file_title = CASE
              WHEN COALESCE(file_title, '') = '' THEN $7
              WHEN LENGTH($7) > LENGTH(file_title) THEN $7
              ELSE file_title
            END,
            file_size = GREATEST(COALESCE(file_size, 0), $8),
            file_index = CASE
              WHEN $2 = -1 THEN file_index
              ELSE $2
            END,
            file_index_norm = $2,
            pack_hash = COALESCE(NULLIF(pack_hash, ''), $1),
            pack_hash_norm = $1,
            updated_at = NOW()
        WHERE pack_hash_norm = $1
          AND file_index_norm = $2
        RETURNING 1
      `,
      [packHash, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, filePath, fileTitle, fileSize]
    );

    if (updateRes.rowCount > 0) return false;

    const insertRes = await client.query(
      `
        INSERT INTO pack_files (
          pack_hash,
          pack_hash_norm,
          file_index,
          file_index_norm,
          imdb_id,
          imdb_season,
          imdb_episode,
          file_path,
          file_title,
          file_size,
          created_at,
          updated_at
        )
        VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
        ON CONFLICT DO NOTHING
        RETURNING 1
      `,
      [packHash, fileIndex, fileIndexNorm, imdbId, imdbSeason, imdbEpisode, filePath, fileTitle, fileSize]
    );

    return insertRes.rowCount > 0;
  }

  function normalizeMeta(meta, torrent = {}) {
    const fallbackType = sanitizeText(meta?.type || torrent?.type, 'movie') || 'movie';
    const imdbId = normalizeImdbId(meta?.imdb_id || meta?.imdbId || torrent?.imdb_id || torrent?.imdbId);
    const season = fallbackType === 'movie' ? null : toNullableInt(meta?.season ?? torrent?.season ?? torrent?.imdb_season);
    const episode = fallbackType === 'movie' ? null : toNullableInt(meta?.episode ?? torrent?.episode ?? torrent?.imdb_episode);
    return { imdbId, season, episode, type: fallbackType };
  }



  function normalizeExternalSnapshotType(value, meta = {}) {
    const raw = sanitizeText(value || meta?.type || meta?.contentType || '').toLowerCase();
    if (['movie', 'series', 'anime'].includes(raw)) return raw;
    return meta?.isSeries || meta?.season || meta?.episode ? 'series' : 'movie';
  }

  function buildExternalSnapshotIdentity(meta = {}) {
    const imdbId = normalizeImdbId(meta?.imdb_id || meta?.imdbId);
    const season = toNullableInt(meta?.season ?? meta?.imdb_season);
    const episode = toNullableInt(meta?.episode ?? meta?.imdb_episode);
    if (!imdbId) return null;
    return {
      imdbId,
      season: season !== null && season > 0 ? season : null,
      episode: episode !== null && episode > 0 ? episode : null
    };
  }

  function normalizeSnapshotProvider(item = {}) {
    return sanitizeText(item.externalProvider || item.provider || item.source || item.sourceName || 'external').slice(0, 160) || 'external';
  }

  function normalizeSnapshotAddon(item = {}) {
    return sanitizeText(item.externalAddon || item._externalAddon || item.addon || 'external').toLowerCase().slice(0, 96) || 'external';
  }

  function normalizeSnapshotGroup(item = {}) {
    const raw = sanitizeText(item.externalGroup || item._externalGroup || item._sourceGroup || 'external').toLowerCase();
    if (raw.includes('torrentio')) return 'torrentio';
    if (raw.includes('mediafusion')) return 'mediafusion';
    if (raw.includes('meteor')) return 'meteor';
    return raw.slice(0, 64) || 'external';
  }

  function normalizeSnapshotLanguages(item = {}) {
    const values = [];
    if (Array.isArray(item.languages)) values.push(...item.languages);
    else if (item.languages) values.push(item.languages);
    for (const value of [item.language, item.lang, item.audio, item.languageInfo?.displayLabel]) {
      if (value) values.push(value);
    }
    if (item.isItalian || item.hasItalianAudio || item._externalIsItalian || item._externalHasItalianAudio || item.languageInfo?.isItalian || item.languageInfo?.hasAudioItalian) values.push('ita');
    return normalizeDelimitedText(values, 2048);
  }

  function normalizeSnapshotPayload(item = {}) {
    const payload = { ...item };
    delete payload._debug;
    delete payload.debug;
    delete payload.error;
    return payload;
  }

  function buildExternalSnapshotKey(identity, item = {}, type = 'movie') {
    const hash = normalizeInfoHash(item.hash || item.infoHash || item.info_hash);
    const fileIndex = normalizeFileIndex(item.fileIdx ?? item.fileIndex ?? item.file_index);
    const direct = sanitizeText(item.directUrl || item.externalDirectUrl || item._externalDirectUrl || item.url).slice(0, 512);
    const title = sanitizeText(item.title || item.name || item.filename || item.file_title).slice(0, 220);
    const source = [normalizeSnapshotGroup(item), normalizeSnapshotAddon(item), normalizeSnapshotProvider(item)].join(':');
    const media = [identity.imdbId, identity.season || 0, identity.episode || 0, type].join(':');
    const stable = hash
      ? [media, source, hash, fileIndex === null ? -1 : fileIndex].join(':')
      : [media, source, direct, title].join(':');
    return crypto.createHash('sha1').update(stable).digest('hex');
  }

  function normalizeExternalSnapshotEntry(meta = {}, item = {}, options = {}) {
    const identity = buildExternalSnapshotIdentity(meta);
    if (!identity || !item || typeof item !== 'object') return null;

    const infoHash = normalizeInfoHash(item.hash || item.infoHash || item.info_hash);
    const directUrl = sanitizeText(item.directUrl || item.externalDirectUrl || item._externalDirectUrl || item.url);
    if (!infoHash && !directUrl) return null;

    const type = normalizeExternalSnapshotType(options.type || item.type, meta);
    const fileIndex = normalizeFileIndex(item.fileIdx ?? item.fileIndex ?? item.file_index);
    const title = sanitizeText(item.title || item.name || item.filename || item.file_title || infoHash || directUrl).slice(0, 600);
    const payload = normalizeSnapshotPayload(item);
    const ttlSeconds = clampInt(options.ttlSeconds || process.env.EXTERNAL_SNAPSHOT_TTL || 7 * 24 * 60 * 60, 7 * 24 * 60 * 60, 60, 30 * 24 * 60 * 60);

    return {
      snapshotKey: buildExternalSnapshotKey(identity, item, type),
      imdbId: identity.imdbId,
      season: identity.season,
      episode: identity.episode,
      type,
      infoHash,
      fileIndex,
      fileIndexNorm: normalizeFileIndexNorm(fileIndex),
      addon: normalizeSnapshotAddon(item),
      addonGroup: normalizeSnapshotGroup(item),
      provider: normalizeSnapshotProvider(item),
      title,
      quality: sanitizeText(item.quality || item.resolution || item.quality_tag).slice(0, 80) || null,
      languages: normalizeSnapshotLanguages(item),
      seeders: Math.max(0, toSafeNumber(item.seeders, 0)),
      size: Math.max(0, toSafeNumber(item.sizeBytes || item._size || item.mainFileSize || item.size || item.fileSize || item.file_size, 0)),
      rdState: normalizeRdCacheState(item._rdCacheState || item.rdCacheState || item.cacheState),
      cached: item.cached_rd === true || item._dbCachedRd === true || item.isCached === true ? true : (item.cached_rd === false || item._dbCachedRd === false ? false : null),
      payload,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000)
    };
  }

  function normalizeExternalSnapshotRow(row = {}) {
    const payload = row?.payload_json && typeof row.payload_json === 'object' ? row.payload_json : {};
    return {
      ...payload,
      title: payload.title || sanitizeText(row.title),
      hash: normalizeInfoHash(payload.hash || payload.infoHash || row.info_hash),
      infoHash: normalizeInfoHash(payload.infoHash || payload.hash || row.info_hash),
      fileIdx: normalizeFileIndex(payload.fileIdx ?? payload.fileIndex ?? row.file_index),
      source: payload.source || sanitizeText(row.provider || row.addon || 'External Snapshot'),
      provider: payload.provider || sanitizeText(row.provider),
      externalProvider: payload.externalProvider || sanitizeText(row.provider),
      externalAddon: payload.externalAddon || sanitizeText(row.addon),
      externalGroup: payload.externalGroup || sanitizeText(row.addon_group),
      quality: payload.quality || sanitizeText(row.quality),
      resolution: payload.resolution || sanitizeText(row.quality),
      languages: payload.languages || sanitizeText(row.languages),
      seeders: Math.max(Number(payload.seeders || 0) || 0, Number(row.seeders || 0) || 0),
      sizeBytes: Math.max(Number(payload.sizeBytes || payload._size || 0) || 0, Number(row.size || 0) || 0),
      _size: Math.max(Number(payload._size || payload.sizeBytes || 0) || 0, Number(row.size || 0) || 0),
      rdCacheState: payload.rdCacheState || sanitizeText(row.rd_state),
      _rdCacheState: payload._rdCacheState || sanitizeText(row.rd_state),
      cached_rd: payload.cached_rd === true || row.cached === true ? true : (payload.cached_rd === false || row.cached === false ? false : null),
      _dbCachedRd: payload._dbCachedRd === true || row.cached === true ? true : (payload._dbCachedRd === false || row.cached === false ? false : null),
      _externalSnapshot: true,
      _fromExternalSnapshot: true,
      _externalSnapshotSeenCount: toSafeNumber(row.seen_count, 0),
      _externalSnapshotLastSeenAt: row.last_seen_at || null
    };
  }

  async function insertTorrent(meta, torrent) {
    if (!getPool()) return false;
    await awaitDatabaseOptimizations();

    const normalizedMeta = normalizeMeta(meta, torrent);
    const infoHash = normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash);
    if (!infoHash || !normalizedMeta.imdbId) return false;

    try {
      return await runInTransaction(async (client) => {
        const inserted = await upsertTorrentRow(client, torrent);
        await upsertFileMappingRow(client, {
          info_hash: infoHash,
          file_index: torrent?.file_index ?? torrent?.fileIdx,
          imdb_id: normalizedMeta.imdbId,
          imdb_season: normalizedMeta.season,
          imdb_episode: normalizedMeta.episode,
          title: torrent?.title,
          size: torrent?.size
        });
        return inserted;
      });
    } catch (error) {
      console.error(`❌ DB Save Error: ${error.message}`);
      return false;
    }
  }

  async function insertTorrentsBatch(meta, torrents) {
    if (!getPool() || !Array.isArray(torrents) || torrents.length === 0) return { inserted: 0, processed: 0 };
    await awaitDatabaseOptimizations();

    const normalizedMeta = normalizeMeta(meta, torrents[0] || {});
    if (!normalizedMeta.imdbId) return { inserted: 0, processed: 0 };

    const items = torrents
      .map((torrent) => ({
        infoHash: normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash),
        torrent
      }))
      .filter((entry) => entry.infoHash);

    if (items.length === 0) return { inserted: 0, processed: 0 };

    try {
      return await runInTransaction(async (client) => {
        let inserted = 0;
        let mapped = 0;

        for (const entry of items) {
          const wasInserted = await upsertTorrentRow(client, entry.torrent);
          if (wasInserted) inserted += 1;
          const wasMapped = await upsertFileMappingRow(client, {
            info_hash: entry.infoHash,
            file_index: entry.torrent?.file_index ?? entry.torrent?.fileIdx,
            imdb_id: normalizedMeta.imdbId,
            imdb_season: normalizedMeta.season,
            imdb_episode: normalizedMeta.episode,
            title: entry.torrent?.title,
            size: entry.torrent?.size
          });
          if (wasMapped) mapped += 1;
        }

        return { inserted, mapped, processed: items.length };
      });
    } catch (error) {
      console.error(`❌ DB Batch Save Error: ${error.message}`);
      return { inserted: 0, processed: 0, error: error.message };
    }
  }

  async function ensureTorrentRecord(torrent) {
    if (!getPool()) return false;
    await awaitDatabaseOptimizations();

    const cleanHash = normalizeInfoHash(torrent?.info_hash || torrent?.infoHash || torrent?.hash);
    if (!cleanHash) return false;

    try {
      return await runInTransaction((client) => upsertTorrentRow(client, {
        ...torrent,
        info_hash: cleanHash
      }));
    } catch (error) {
      console.error(`❌ DB ensureTorrentRecord Error: ${error.message}`);
      return false;
    }
  }

  async function updateTorrentTitle(infoHash, title) {
    const pool = getPool();
    if (!pool) return false;
    await awaitDatabaseOptimizations();

    const hash = normalizeInfoHash(infoHash);
    const safeTitle = sanitizeText(title);
    if (!hash || !safeTitle) return false;

    try {
      const result = await pool.query(
        `
          UPDATE torrents
          SET title = CASE
                WHEN title IS NULL OR title = '' THEN $2
                WHEN LENGTH($2) > LENGTH(title) THEN $2
                ELSE title
              END,
              updated_at = NOW()
          WHERE info_hash_norm = $1
        `,
        [hash, safeTitle]
      );
      return result.rowCount > 0;
    } catch (error) {
      console.error(`❌ DB updateTorrentTitle Error: ${error.message}`);
      return false;
    }
  }

  async function insertEpisodeFiles(entries) {
    if (!getPool() || !Array.isArray(entries) || entries.length === 0) return { inserted: 0, processed: 0 };
    await awaitDatabaseOptimizations();

    const normalized = entries
      .map((entry) => ({
        info_hash: normalizeInfoHash(entry?.info_hash || entry?.infoHash || entry?.hash),
        file_index: normalizeFileIndex(entry?.file_index ?? entry?.fileIdx),
        imdb_id: normalizeImdbId(entry?.imdb_id || entry?.imdbId),
        imdb_season: toNullableInt(entry?.imdb_season ?? entry?.season),
        imdb_episode: toNullableInt(entry?.imdb_episode ?? entry?.episode),
        title: sanitizeText(entry?.title),
        size: Math.max(0, toSafeNumber(entry?.size, 0))
      }))
      .filter((entry) => entry.info_hash && entry.imdb_id);

    if (normalized.length === 0) return { inserted: 0, processed: 0 };

    try {
      return await runInTransaction(async (client) => {
        let inserted = 0;

        for (const entry of normalized) {
          const wasInserted = await upsertFileMappingRow(client, entry);
          if (wasInserted) inserted += 1;
        }

        return { inserted, processed: normalized.length };
      });
    } catch (error) {
      console.error(`❌ DB Error insertEpisodeFiles: ${error.message}`);
      return { inserted: 0, processed: 0, error: error.message };
    }
  }

  async function insertPackFiles(entries) {
    if (!getPool() || !Array.isArray(entries) || entries.length === 0) return { inserted: 0, processed: 0 };
    await awaitDatabaseOptimizations();

    const normalized = entries
      .map((entry) => ({
        pack_hash: normalizeInfoHash(entry?.pack_hash || entry?.packHash || entry?.info_hash || entry?.infoHash || entry?.hash),
        file_index: normalizeFileIndex(entry?.file_index ?? entry?.fileIdx ?? entry?.index),
        imdb_id: normalizeImdbId(entry?.imdb_id || entry?.imdbId),
        imdb_season: toNullableInt(entry?.imdb_season ?? entry?.season),
        imdb_episode: toNullableInt(entry?.imdb_episode ?? entry?.episode),
        file_path: sanitizeText(entry?.file_path || entry?.path),
        file_title: sanitizeText(entry?.file_title || entry?.title),
        file_size: Math.max(0, toSafeNumber(entry?.file_size ?? entry?.size, 0))
      }))
      .filter((entry) => entry.pack_hash);

    if (normalized.length === 0) return { inserted: 0, processed: 0 };

    try {
      return await runInTransaction(async (client) => {
        let inserted = 0;

        for (const entry of normalized) {
          const wasInserted = await upsertPackFileRow(client, entry);
          if (wasInserted) inserted += 1;
        }

        return { inserted, processed: normalized.length };
      });
    } catch (error) {
      console.error(`❌ DB Error insertPackFiles: ${error.message}`);
      return { inserted: 0, processed: 0, error: error.message };
    }
  }

  async function getPackFiles(infoHash, limit = 50) {
    const pool = getPool();
    if (!pool) return [];
    await awaitDatabaseOptimizations();

    const hash = normalizeInfoHash(infoHash);
    if (!hash) return [];

    try {
      const res = await pool.query(
        `
          SELECT
            pack_hash AS info_hash,
            file_index,
            file_path,
            file_title,
            file_size,
            imdb_id,
            imdb_season,
            imdb_episode
          FROM pack_files
          WHERE pack_hash_norm = $1
          ORDER BY
            CASE WHEN imdb_episode IS NOT NULL THEN 0 ELSE 1 END,
            COALESCE(imdb_season, 0),
            COALESCE(imdb_episode, 0),
            COALESCE(file_size, 0) DESC,
            file_index_norm ASC
          LIMIT $2
        `,
        [hash, clampInt(limit, 50, 1, 500)]
      );
      return res.rows || [];
    } catch (error) {
      console.error(`❌ DB Error getPackFiles: ${error.message}`);
      return [];
    }
  }

  async function getSeriesPackFiles(infoHash) {
    const pool = getPool();
    if (!pool) return [];
    await awaitDatabaseOptimizations();

    const hash = normalizeInfoHash(infoHash);
    if (!hash) return [];

    try {
      const res = await pool.query(
        `
          SELECT
            pack_hash AS info_hash,
            file_index,
            file_path,
            file_title,
            file_size,
            imdb_id,
            imdb_season,
            imdb_episode
          FROM pack_files
          WHERE pack_hash_norm = $1
            AND imdb_episode IS NOT NULL
          ORDER BY
            COALESCE(imdb_season, 0),
            COALESCE(imdb_episode, 0),
            COALESCE(file_size, 0) DESC,
            file_index_norm ASC
        `,
        [hash]
      );
      return res.rows || [];
    } catch (error) {
      console.error(`❌ DB Error getSeriesPackFiles: ${error.message}`);
      return [];
    }
  }

  async function getEpisodePackFileHintsByHashes(hashes, meta = {}) {
    const pool = getPool();
    if (!pool) return [];
    await awaitDatabaseOptimizations();

    const normalizedHashes = normalizeUniqueInfoHashes(hashes);
    const imdbId = normalizeImdbId(meta?.imdb_id || meta?.imdbId);
    const season = toNullableInt(meta?.season ?? meta?.imdb_season);
    const episode = toNullableInt(meta?.episode ?? meta?.imdb_episode);

    if (normalizedHashes.length === 0 || !imdbId || season === null || season <= 0 || episode === null || episode <= 0) return [];

    try {
      const res = await pool.query(
        `
          WITH exact_matches AS (
            SELECT DISTINCT ON (pack_hash_norm)
              pack_hash_norm AS hash,
              file_index,
              file_index_norm,
              file_path,
              file_title,
              file_size,
              imdb_id,
              imdb_season,
              imdb_episode,
              'db_exact_identity'::text AS source
            FROM pack_files
            WHERE pack_hash_norm = ANY($1::text[])
              AND imdb_id = $2
              AND imdb_season = $3
              AND imdb_episode = $4
            ORDER BY
              pack_hash_norm,
              CASE WHEN file_index_norm >= 0 THEN 0 ELSE 1 END,
              COALESCE(file_size, 0) DESC,
              LENGTH(COALESCE(file_title, file_path, '')) DESC
          )
          SELECT *
          FROM exact_matches
        `,
        [normalizedHashes, imdbId, season, episode]
      );

      const exactRows = (res.rows || []).map((row) => ({
        hash: normalizeInfoHash(row.hash),
        file_index: normalizeFileIndex(row.file_index),
        file_path: sanitizeText(row.file_path),
        file_title: sanitizeText(row.file_title),
        file_size: toSafeNumber(row.file_size, 0),
        imdb_id: normalizeImdbId(row.imdb_id),
        imdb_season: toNullableInt(row.imdb_season),
        imdb_episode: toNullableInt(row.imdb_episode),
        source: sanitizeText(row.source, 'db_exact_identity'),
        confidence: 1,
        reason: 'db_imdb_season_episode_mapping'
      })).filter((row) => row.hash);

      const exactHashes = new Set(exactRows.map((row) => row.hash));
      const missingHashes = normalizedHashes.filter((hash) => !exactHashes.has(hash));
      if (missingHashes.length === 0) return exactRows;

      const fallbackRes = await pool.query(
        `
          SELECT
            pack_hash_norm AS hash,
            file_index,
            file_index_norm,
            file_path,
            file_title,
            file_size
          FROM pack_files
          WHERE pack_hash_norm = ANY($1::text[])
          ORDER BY
            pack_hash_norm,
            CASE WHEN file_index_norm >= 0 THEN 0 ELSE 1 END,
            file_index_norm ASC,
            COALESCE(file_size, 0) DESC
        `,
        [missingHashes]
      );

      const grouped = new Map();
      for (const row of fallbackRes.rows || []) {
        const hash = normalizeInfoHash(row.hash);
        if (!hash) continue;
        const list = grouped.get(hash) || [];
        list.push({
          id: normalizeFileIndex(row.file_index),
          file_index: normalizeFileIndex(row.file_index),
          path: sanitizeText(row.file_path || row.file_title),
          file_path: sanitizeText(row.file_path || row.file_title),
          file_title: sanitizeText(row.file_title || row.file_path),
          bytes: toSafeNumber(row.file_size, 0),
          file_size: toSafeNumber(row.file_size, 0)
        });
        grouped.set(hash, list);
      }

      const inferredRows = [];
      for (const hash of missingHashes) {
        const files = grouped.get(hash) || [];
        if (files.length === 0) continue;
        const hint = inferEpisodeHintFromPackFiles(files, meta, {
          imdb_id: imdbId,
          season,
          episode,
          title: meta?.title || meta?.name || '',
          seriesTitle: meta?.title || meta?.name || '',
          isAnime: Boolean(meta?.isAnime || meta?.kitsu_id),
          kitsu_id: meta?.kitsu_id
        });
        if (!hint) continue;
        inferredRows.push({
          hash,
          file_index: normalizeFileIndex(hint.fileIndex),
          file_path: sanitizeText(hint.filePath || hint.fileName),
          file_title: sanitizeText(hint.fileName || hint.filePath),
          file_size: toSafeNumber(hint.fileSize, 0),
          imdb_id: imdbId,
          imdb_season: season,
          imdb_episode: episode,
          source: 'db_pack_filename_inferred',
          confidence: Number(hint.confidence || 0.9),
          reason: hint.reason || 'filename_episode_marker'
        });
      }

      return [...exactRows, ...inferredRows];
    } catch (error) {
      console.error(`❌ DB Error getEpisodePackFileHintsByHashes: ${error.message}`);
      return [];
    }
  }

  async function getRdScanBatch(limit = 5) {
    const pool = getPool();
    if (!pool) return [];
    await awaitDatabaseOptimizations();

    const batchLimit = clampInt(limit, 5, 1, 50);

    try {
      const res = await pool.query(
        `
          WITH ranked AS (
            SELECT
              info_hash_norm AS hash,
              title,
              rd_cache_state,
              cached_rd,
              next_cached_check,
              last_cached_check,
              cache_check_failures,
              ROW_NUMBER() OVER (
                PARTITION BY info_hash_norm
                ORDER BY
                  COALESCE(next_cached_check, TIMESTAMPTZ '1970-01-01 00:00:00+00') ASC,
                  COALESCE(last_cached_check, TIMESTAMPTZ '1970-01-01 00:00:00+00') ASC,
                  COALESCE(cache_check_failures, 0) ASC
              ) AS rn
            FROM torrents
            WHERE info_hash_norm IS NOT NULL
              AND (
                next_cached_check IS NULL
                OR next_cached_check <= NOW()
              )
          )
          SELECT hash, title, rd_cache_state, cached_rd, next_cached_check, last_cached_check, cache_check_failures
          FROM ranked
          WHERE rn = 1
          LIMIT $1
        `,
        [batchLimit]
      );
      return (res.rows || []).map((row) => ({
        hash: normalizeInfoHash(row.hash),
        title: sanitizeText(row.title),
        rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
        cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
        next_cached_check: row.next_cached_check || null,
        last_cached_check: row.last_cached_check || null,
        cache_check_failures: toSafeNumber(row.cache_check_failures, 0)
      })).filter((row) => row.hash);
    } catch (error) {
      console.error(`❌ DB Error getRdScanBatch: ${error.message}`);
      return [];
    }
  }

  async function getRdCacheStatusByHashes(hashes) {
    if (!getPool()) return [];
    await awaitDatabaseOptimizations();

    const normalizedHashes = normalizeUniqueInfoHashes(hashes);
    if (normalizedHashes.length === 0) return [];

    try {
      return await withClient(async (client) => {
        const res = await client.query(
          `
            SELECT DISTINCT ON (info_hash_norm)
              info_hash_norm AS hash,
              cached_rd,
              rd_cache_state,
              rd_file_index,
              rd_file_size,
              size,
              last_cached_check,
              next_cached_check,
              cache_check_failures
            FROM torrents
            WHERE info_hash_norm = ANY($1::text[])
            ORDER BY
              info_hash_norm,
              CASE
                WHEN cached_rd IS TRUE THEN 4
                WHEN rd_cache_state = 'cached' THEN 3
                WHEN rd_cache_state IN ('likely_cached', 'probing') THEN 2
                WHEN rd_cache_state IN ('likely_uncached', 'uncached_terminal') THEN 1
                ELSE 0
              END DESC,
              COALESCE(rd_file_size, size, 0) DESC,
              COALESCE(last_cached_check, TIMESTAMPTZ '1970-01-01 00:00:00+00') DESC
          `,
          [normalizedHashes]
        );
        return (res.rows || []).map((row) => ({
          hash: normalizeInfoHash(row.hash),
          cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
          rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
          rd_file_index: normalizeFileIndex(row.rd_file_index),
          rd_file_size: toSafeNumber(row.rd_file_size, 0),
          size: toSafeNumber(row.size, 0),
          last_cached_check: row.last_cached_check || null,
          next_cached_check: row.next_cached_check || null,
          cache_check_failures: toSafeNumber(row.cache_check_failures, 0)
        })).filter((row) => row.hash);
      });
    } catch (error) {
      console.error(`❌ DB Error getRdCacheStatusByHashes: ${error.message}`);
      return [];
    }
  }

  async function getRdCachedAvailability(hashes) {
    const rows = await getRdCacheStatusByHashes(hashes);
    const mapped = {};

    for (const row of rows) {
      if (!row?.hash) continue;
      const nextCheckTs = row.next_cached_check ? Date.parse(String(row.next_cached_check)) : NaN;
      const duePositiveRecheck = (row.cached_rd === true || row.rd_cache_state === 'cached') && Number.isFinite(nextCheckTs) && nextCheckTs <= Date.now() + 15000;
      if (duePositiveRecheck) continue;
      if (row.cached_rd === true || row.cached_rd === false) {
        mapped[row.hash] = row.cached_rd;
      } else if (row.rd_cache_state === 'cached') {
        mapped[row.hash] = true;
      } else if (row.rd_cache_state === 'uncached_terminal') {
        mapped[row.hash] = false;
      }
    }

    return mapped;
  }

  async function updateRdCacheStatus(cacheResults) {
    if (!getPool() || !Array.isArray(cacheResults) || cacheResults.length === 0) return 0;
    await awaitDatabaseOptimizations();

    const normalizedRows = cacheResults
      .map((entry) => {
        const hasCached = typeof entry?.cached === 'boolean';
        const state = deriveStoredCacheState(entry);
        const permanent = hasCached && entry.cached === true && entry?.permanent === true && entry?.trustedPermanent === true;
        const defaultNextHours = state === 'cached'
          ? RD_CACHED_RECHECK_HOURS
          : (hasCached ? (entry.cached ? RD_CACHED_RECHECK_HOURS : 24 * 7) : 12);
        const nextHours = permanent
          ? null
          : Math.max(1, Math.min(24 * 365 * 10, toSafeNumber(entry?.next_hours, defaultNextHours)));
        const cached = deriveCachedBooleanFromState(state, hasCached ? entry.cached : null);
        const identity = normalizeEpisodeIdentity(entry);
        return {
          hash: normalizeInfoHash(entry?.hash),
          cached,
          rd_cache_state: state,
          rd_file_index: normalizeFileIndex(entry?.rd_file_index ?? entry?.file_id),
          rd_file_size: entry?.rd_file_size === null || entry?.rd_file_size === undefined ? toNullableInt(entry?.file_size) : toSafeNumber(entry?.rd_file_size, 0),
          failures: Math.max(0, toSafeNumber(entry?.failures, 0)),
          next_hours: nextHours,
          permanent,
          title: sanitizeText(entry?.torrent_title || entry?.title),
          size: Math.max(0, toSafeNumber(entry?.size, 0)),
          imdb_id: identity.imdbId,
          imdb_season: identity.imdbSeason,
          imdb_episode: identity.imdbEpisode,
          episode_scoped: identity.isEpisode
        };
      })
      .filter((entry) => entry.hash);

    if (normalizedRows.length === 0) return 0;

    try {
      return await runInTransaction(async (client) => {
        let updated = 0;

        for (const row of normalizedRows) {
          if (row.episode_scoped && Number.isInteger(row.rd_file_index) && row.rd_file_index >= 0) {
            await upsertEpisodeScopedOverrideRow(client, {
              hash: row.hash,
              imdb_id: row.imdb_id,
              imdb_season: row.imdb_season,
              imdb_episode: row.imdb_episode,
              rd_file_index: row.rd_file_index,
              rd_file_size: row.rd_file_size
            });
          }

          const globalRdFileIndex = row.episode_scoped ? null : row.rd_file_index;
          const globalRdFileSize = row.episode_scoped ? null : row.rd_file_size;

          const result = await client.query(
            `
              UPDATE torrents
              SET rd_cache_state = CASE
                    WHEN $3::text IS NULL OR $3::text = '' THEN rd_cache_state
                    ELSE $3::text
                  END,
                  cached_rd = CASE
                    WHEN $3::text = 'cached' THEN TRUE
                    WHEN $3::text = 'uncached_terminal' THEN FALSE
                    WHEN $3::text IN ('likely_cached', 'probing', 'likely_uncached', 'unknown') THEN NULL
                    WHEN $2::boolean IS NULL THEN cached_rd
                    ELSE $2::boolean
                  END,
                  rd_file_index = CASE
                    WHEN $4::integer IS NULL OR $4::integer < 0 THEN rd_file_index
                    ELSE $4::integer
                  END,
                  rd_file_size = CASE
                    WHEN $5::bigint IS NULL OR $5::bigint <= 0 THEN rd_file_size
                    ELSE $5::bigint
                  END,
                  title = CASE
                    WHEN $8::text = '' THEN title
                    WHEN title IS NULL OR title = '' THEN $8::text
                    WHEN LENGTH($8::text) > LENGTH(title) THEN $8::text
                    ELSE title
                  END,
                  size = CASE
                    WHEN $9::bigint <= 0 THEN size
                    ELSE GREATEST(COALESCE(size, 0), $9::bigint)
                  END,
                  cache_check_failures = GREATEST(0, COALESCE($6::integer, 0)),
                  last_cached_check = NOW(),
                  next_cached_check = CASE
                    WHEN COALESCE($7::boolean, FALSE) IS TRUE THEN TIMESTAMPTZ '9999-12-31 00:00:00+00'
                    ELSE NOW() + make_interval(hours => GREATEST(1, COALESCE($10::integer, 12)))
                  END,
                  updated_at = NOW()
              WHERE info_hash_norm = $1
            `,
            [row.hash, row.cached, row.rd_cache_state, globalRdFileIndex, globalRdFileSize, row.failures, row.permanent, row.title, row.size, row.next_hours]
          );
          updated += Number(result.rowCount || 0);
        }

        return updated;
      });
    } catch (error) {
      console.error(`❌ DB Error updateCache: ${error.message}`);
      return 0;
    }
  }

  async function updateTbCacheStatus(updates) {
    if (!getPool() || !Array.isArray(updates) || updates.length === 0) return 0;
    await awaitDatabaseOptimizations();

    const rows = updates
      .map((entry) => {
        const identity = normalizeEpisodeIdentity(entry);
        return {
          hash: normalizeInfoHash(entry?.hash),
          cached: typeof entry?.cached === 'boolean' ? entry.cached : null,
          fileId: normalizeFileIndex(entry?.tb_file_id ?? entry?.file_id),
          fileSize: entry?.tb_file_size === null || entry?.tb_file_size === undefined
            ? (entry?.file_size === null || entry?.file_size === undefined ? null : toSafeNumber(entry?.file_size, 0))
            : toSafeNumber(entry?.tb_file_size, 0),
          title: sanitizeText(entry?.torrent_title || entry?.title),
          size: Math.max(0, toSafeNumber(entry?.size, 0)),
          imdb_id: identity.imdbId,
          imdb_season: identity.imdbSeason,
          imdb_episode: identity.imdbEpisode,
          episode_scoped: identity.isEpisode
        };
      })
      .filter((entry) => entry.hash);

    if (rows.length === 0) return 0;

    try {
      return await runInTransaction(async (client) => {
        let updated = 0;

        for (const row of rows) {
          if (row.episode_scoped && Number.isInteger(row.fileId) && row.fileId >= 0) {
            await upsertEpisodeScopedOverrideRow(client, {
              hash: row.hash,
              imdb_id: row.imdb_id,
              imdb_season: row.imdb_season,
              imdb_episode: row.imdb_episode,
              tb_file_id: row.fileId,
              tb_file_size: row.fileSize
            });
          }

          const globalFileId = row.episode_scoped ? null : row.fileId;
          const globalFileSize = row.episode_scoped ? null : row.fileSize;

          const result = await client.query(
            `
              UPDATE torrents
              SET tb_cached = COALESCE($2::boolean, tb_cached),
                  tb_file_id = CASE
                    WHEN $3::integer IS NULL OR $3::integer < 0 THEN tb_file_id
                    ELSE $3::integer
                  END,
                  tb_file_size = CASE
                    WHEN $4::bigint IS NULL OR $4::bigint <= 0 THEN tb_file_size
                    ELSE $4::bigint
                  END,
                  title = CASE
                    WHEN $5::text = '' THEN title
                    WHEN title IS NULL OR title = '' THEN $5::text
                    WHEN LENGTH($5::text) > LENGTH(title) THEN $5::text
                    ELSE title
                  END,
                  size = CASE
                    WHEN $6::bigint <= 0 THEN size
                    ELSE GREATEST(COALESCE(size, 0), $6::bigint)
                  END,
                  tb_last_cached_check = NOW(),
                  updated_at = NOW()
              WHERE info_hash_norm = $1
            `,
            [row.hash, row.cached, globalFileId, globalFileSize, row.title, row.size]
          );
          updated += Number(result.rowCount || 0);
        }

        return updated;
      });
    } catch (error) {
      console.error(`❌ DB Error updateTbCacheStatus: ${error.message}`);
      return 0;
    }
  }

  async function getRdScanProgress() {
    const pool = getPool();
    if (!pool) return null;
    await awaitDatabaseOptimizations();

    try {
      const res = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE info_hash IS NOT NULL) AS total_with_hash,
          COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND last_cached_check IS NULL) AS pending_first_scan,
          COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND last_cached_check IS NOT NULL) AS already_scanned,
          COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND last_cached_check IS NOT NULL AND cached_rd IS TRUE) AS cached_true,
          COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND last_cached_check IS NOT NULL AND cached_rd IS FALSE) AS cached_false,
          COUNT(*) FILTER (WHERE info_hash IS NOT NULL AND next_cached_check IS NOT NULL AND next_cached_check <= NOW()) AS due_now
        FROM torrents
      `);
      return res.rows?.[0] || null;
    } catch (error) {
      console.error(`❌ DB Error getRdScanProgress: ${error.message}`);
      return null;
    }
  }

  async function prioritizeRdHashes(hashes, options = {}) {
    const pool = getPool();
    if (!pool) return { requested: 0, updated: 0 };
    await awaitDatabaseOptimizations();

    const normalizedHashes = normalizeUniqueInfoHashes(hashes)
      .slice(0, clampInt(options.limit, 30, 1, 100));

    if (normalizedHashes.length === 0) return { requested: 0, updated: 0 };

    const priorityMinutes = clampInt(options.priorityMinutes, 5, 0, 24 * 60);

    try {
      const result = await pool.query(
        `
          UPDATE torrents
          SET next_cached_check = NOW() - make_interval(mins => $2),
              cache_check_failures = CASE
                WHEN COALESCE(cached_rd, FALSE) IS TRUE THEN COALESCE(cache_check_failures, 0)
                ELSE LEAST(COALESCE(cache_check_failures, 0), 1)
              END,
              updated_at = NOW()
          WHERE info_hash_norm = ANY($1::text[])
            AND COALESCE(cached_rd, FALSE) IS NOT TRUE
        `,
        [normalizedHashes, priorityMinutes]
      );
      return { requested: normalizedHashes.length, updated: Number(result.rowCount || 0) };
    } catch (error) {
      console.error(`❌ DB Error prioritizeRdHashes: ${error.message}`);
      return { requested: normalizedHashes.length, updated: 0, error: error.message };
    }
  }

  async function normalizePendingRdCacheState(options = {}) {
    if (!getPool()) return { applied: false, updated: 0, reason: 'pool_missing' };
    const schemaReady = await awaitDatabaseOptimizations();
    if (!schemaReady) return { applied: false, updated: 0, reason: 'schema_not_ready' };

    const chunkSize = clampInt(options.chunkSize, 10000, 500, 50000);
    const lockKey = 884421337;
    let lockAcquired = false;

    try {
      return await withClient(async (client) => {
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
        lockAcquired = Boolean(lockRes.rows?.[0]?.locked);
        if (!lockAcquired) return { applied: false, updated: 0, reason: 'lock_not_acquired' };

        let totalUpdated = 0;

        while (true) {
          const updateRes = await client.query(
            `
              WITH target AS (
                SELECT ctid
                FROM torrents
                WHERE info_hash IS NOT NULL
                  AND last_cached_check IS NULL
                  AND (
                    cached_rd IS NOT NULL
                    OR rd_cache_state IS NOT NULL
                    OR rd_file_index IS NOT NULL
                    OR rd_file_size IS NOT NULL
                    OR COALESCE(cache_check_failures, 0) <> 0
                    OR next_cached_check IS NOT NULL
                  )
                LIMIT $1
              )
              UPDATE torrents AS t
              SET cached_rd = NULL,
                  rd_cache_state = NULL,
                  rd_file_index = NULL,
                  rd_file_size = NULL,
                  cache_check_failures = 0,
                  next_cached_check = NULL,
                  updated_at = NOW()
              FROM target
              WHERE t.ctid = target.ctid
            `,
            [chunkSize]
          );

          const changed = Number(updateRes.rowCount || 0);
          totalUpdated += changed;
          if (changed === 0) break;
        }

        let requeuedPermanent = 0;
        if (RD_REVALIDATE_PERMANENT_ON_BOOT) {
          while (true) {
            const requeueRes = await client.query(
              `
                WITH target AS (
                  SELECT ctid
                  FROM torrents
                  WHERE info_hash_norm IS NOT NULL
                    AND cached_rd IS TRUE
                    AND rd_cache_state = 'cached'
                    AND next_cached_check >= TIMESTAMPTZ '9999-01-01 00:00:00+00'
                  LIMIT $1
                )
                UPDATE torrents AS t
                SET next_cached_check = NOW() - make_interval(mins => 1),
                    updated_at = NOW()
                FROM target
                WHERE t.ctid = target.ctid
              `,
              [chunkSize]
            );
            const changed = Number(requeueRes.rowCount || 0);
            requeuedPermanent += changed;
            totalUpdated += changed;
            if (changed === 0) break;
          }
        }

        return { applied: true, updated: totalUpdated, requeuedPermanent, reason: 'normalized' };
      });
    } catch (error) {
      console.error(`❌ DB Error normalizePendingRdCacheState: ${error.message}`);
      return { applied: false, updated: 0, reason: error.message };
    } finally {
      const pool = getPool();
      if (lockAcquired && pool) {
        try {
          await pool.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        } catch (_) {}
      }
    }
  }


  function parseAvailabilityCacheKey(cacheKey) {
    const key = sanitizeText(cacheKey);
    const parts = key.split(':');
    if (parts.length < 2) return null;
    const service = String(parts[0] || '').trim().toLowerCase();
    const hash = normalizeInfoHash(parts[1]);
    const rawFile = parts[2] || 'auto';
    const parsedFile = rawFile === 'auto' ? null : normalizeFileIndex(rawFile);
    if (!service || !hash) return null;
    return {
      key,
      service,
      hash,
      fileIndex: parsedFile,
      fileIndexNorm: normalizeFileIndexNorm(parsedFile),
      mediaId: parts.length > 3 ? normalizeMarkerPart(parts.slice(3).join(':'), 220) : null
    };
  }


  function normalizeMarkerPart(value, maxLength = 180) {
    const normalized = sanitizeText(value).toLowerCase().replace(/[^a-z0-9:_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  function buildDebridCheckMarkerKey(marker = {}) {
    const service = normalizeMarkerPart(marker?.service || 'rd', 32) || 'rd';
    const userHash = normalizeMarkerPart(marker?.userHash || marker?.user_hash || 'global', 80) || 'global';
    const mediaId = normalizeMarkerPart(marker?.mediaId || marker?.media_id, 220);
    if (!mediaId) return null;
    return {
      key: `${service}:${userHash}:${mediaId}`,
      service,
      userHash,
      mediaId
    };
  }

  async function isDebridCacheCheckMarked(marker) {
    const pool = getPool();
    if (!pool) return false;
    await awaitDatabaseOptimizations();

    const built = buildDebridCheckMarkerKey(marker);
    if (!built) return false;

    try {
      const res = await pool.query(
        `
          SELECT 1
          FROM debrid_cache_check_markers
          WHERE marker_key = $1
            AND expires_at > NOW()
          LIMIT 1
        `,
        [built.key]
      );
      return Number(res.rowCount || 0) > 0;
    } catch (error) {
      console.error(`❌ DB Error isDebridCacheCheckMarked: ${error.message}`);
      return false;
    }
  }

  async function markDebridCacheCheckDone(marker) {
    const pool = getPool();
    if (!pool) return false;
    await awaitDatabaseOptimizations();

    const built = buildDebridCheckMarkerKey(marker);
    const ttlSeconds = clampInt(marker?.ttlSeconds || marker?.ttl || 1800, 1800, 60, 24 * 60 * 60);
    if (!built || ttlSeconds <= 0) return false;

    try {
      await pool.query(
        `
          INSERT INTO debrid_cache_check_markers (
            marker_key,
            service,
            user_hash,
            media_id,
            expires_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5), NOW(), NOW())
          ON CONFLICT (marker_key)
          DO UPDATE SET
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
        `,
        [built.key, built.service, built.userHash, built.mediaId, ttlSeconds]
      );
      return true;
    } catch (error) {
      console.error(`❌ DB Error markDebridCacheCheckDone: ${error.message}`);
      return false;
    }
  }


  async function upsertExternalStreamSnapshots(meta, items, options = {}) {
    const pool = getPool();
    if (!pool || !Array.isArray(items) || items.length === 0) return { processed: 0, upserted: 0 };
    await awaitDatabaseOptimizations();

    const rows = items
      .map((item) => normalizeExternalSnapshotEntry(meta, item, options))
      .filter(Boolean);
    if (rows.length === 0) return { processed: 0, upserted: 0 };

    try {
      return await runInTransaction(async (client) => {
        let upserted = 0;
        for (const row of rows) {
          const result = await client.query(
            `
              INSERT INTO external_stream_snapshots (
                snapshot_key,
                imdb_id,
                imdb_season,
                imdb_episode,
                type,
                info_hash,
                info_hash_norm,
                file_index,
                file_index_norm,
                addon,
                addon_group,
                provider,
                title,
                quality,
                languages,
                seeders,
                size,
                rd_state,
                cached,
                payload_json,
                first_seen_at,
                last_seen_at,
                seen_count,
                expires_at,
                created_at,
                updated_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, NOW(), NOW(), 1, $20, NOW(), NOW())
              ON CONFLICT (snapshot_key)
              DO UPDATE SET
                title = CASE
                  WHEN EXCLUDED.title IS NULL OR EXCLUDED.title = '' THEN external_stream_snapshots.title
                  WHEN LENGTH(EXCLUDED.title) > LENGTH(COALESCE(external_stream_snapshots.title, '')) THEN EXCLUDED.title
                  ELSE external_stream_snapshots.title
                END,
                quality = COALESCE(NULLIF(EXCLUDED.quality, ''), external_stream_snapshots.quality),
                languages = COALESCE(NULLIF(EXCLUDED.languages, ''), external_stream_snapshots.languages),
                seeders = GREATEST(COALESCE(external_stream_snapshots.seeders, 0), COALESCE(EXCLUDED.seeders, 0)),
                size = GREATEST(COALESCE(external_stream_snapshots.size, 0), COALESCE(EXCLUDED.size, 0)),
                rd_state = COALESCE(NULLIF(EXCLUDED.rd_state, ''), external_stream_snapshots.rd_state),
                cached = COALESCE(EXCLUDED.cached, external_stream_snapshots.cached),
                payload_json = EXCLUDED.payload_json,
                last_seen_at = NOW(),
                seen_count = GREATEST(COALESCE(external_stream_snapshots.seen_count, 0), 0) + 1,
                expires_at = GREATEST(EXCLUDED.expires_at, external_stream_snapshots.expires_at),
                updated_at = NOW()
            `,
            [
              row.snapshotKey,
              row.imdbId,
              row.season,
              row.episode,
              row.type,
              row.infoHash,
              row.fileIndex,
              row.fileIndexNorm,
              row.addon,
              row.addonGroup,
              row.provider,
              row.title,
              row.quality,
              row.languages,
              row.seeders,
              row.size,
              row.rdState,
              row.cached,
              JSON.stringify(row.payload),
              row.expiresAt
            ]
          );
          upserted += Number(result.rowCount || 0);
        }
        return { processed: rows.length, upserted };
      });
    } catch (error) {
      console.error(`❌ DB Error upsertExternalStreamSnapshots: ${error.message}`);
      return { processed: rows.length, upserted: 0, error: error.message };
    }
  }

  async function getExternalStreamSnapshots(meta = {}, options = {}) {
    const pool = getPool();
    if (!pool) return [];
    await awaitDatabaseOptimizations();

    const identity = buildExternalSnapshotIdentity(meta);
    if (!identity) return [];

    const limit = clampInt(options.limit || process.env.EXTERNAL_SNAPSHOT_READ_LIMIT || 80, 80, 1, 300);
    const type = normalizeExternalSnapshotType(options.type, meta);
    const params = [identity.imdbId, identity.season, identity.episode, type, limit];

    try {
      const res = await pool.query(
        `
          SELECT DISTINCT ON (COALESCE(info_hash_norm, snapshot_key), file_index_norm)
            snapshot_key,
            imdb_id,
            imdb_season,
            imdb_episode,
            type,
            info_hash,
            file_index,
            addon,
            addon_group,
            provider,
            title,
            quality,
            languages,
            seeders,
            size,
            rd_state,
            cached,
            payload_json,
            first_seen_at,
            last_seen_at,
            seen_count,
            expires_at
          FROM external_stream_snapshots
          WHERE imdb_id = $1
            AND COALESCE(imdb_season, 0) = COALESCE($2::integer, 0)
            AND COALESCE(imdb_episode, 0) = COALESCE($3::integer, 0)
            AND (type = $4 OR $4 IS NULL)
            AND expires_at > NOW()
          ORDER BY
            COALESCE(info_hash_norm, snapshot_key),
            file_index_norm,
            CASE WHEN cached IS TRUE THEN 2 WHEN rd_state = 'cached' THEN 1 ELSE 0 END DESC,
            GREATEST(COALESCE(seeders, 0), 0) DESC,
            COALESCE(size, 0) DESC,
            last_seen_at DESC NULLS LAST
          LIMIT $5
        `,
        params
      );
      return (res.rows || []).map(normalizeExternalSnapshotRow).filter(Boolean);
    } catch (error) {
      console.error(`❌ DB Error getExternalStreamSnapshots: ${error.message}`);
      return [];
    }
  }

  async function getExternalSnapshotStats() {
    const pool = getPool();
    if (!pool) return null;
    await awaitDatabaseOptimizations();

    try {
      const res = await pool.query(`
        SELECT
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE expires_at > NOW())::bigint AS active,
          COUNT(*) FILTER (WHERE expires_at <= NOW())::bigint AS expired,
          COUNT(*) FILTER (WHERE cached IS TRUE OR rd_state = 'cached')::bigint AS cached,
          COUNT(*) FILTER (WHERE addon_group = 'torrentio')::bigint AS torrentio,
          COUNT(*) FILTER (WHERE addon_group = 'mediafusion')::bigint AS mediafusion,
          COUNT(*) FILTER (WHERE addon_group = 'meteor')::bigint AS meteor,
          MAX(last_seen_at) AS last_seen_at
        FROM external_stream_snapshots
      `);
      return res.rows?.[0] || null;
    } catch (error) {
      console.error(`❌ DB Error getExternalSnapshotStats: ${error.message}`);
      return null;
    }
  }

  async function getAvailabilityCacheStats() {
    const pool = getPool();
    if (!pool) return null;
    await awaitDatabaseOptimizations();

    try {
      const res = await pool.query(`
        SELECT
          service,
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE expires_at > NOW())::bigint AS active,
          COUNT(*) FILTER (WHERE expires_at <= NOW())::bigint AS expired,
          COUNT(*) FILTER (WHERE cached IS TRUE OR state = 'cached')::bigint AS cached,
          COUNT(*) FILTER (WHERE state = 'likely_cached')::bigint AS likely_cached,
          COUNT(*) FILTER (WHERE state = 'probing')::bigint AS probing,
          COUNT(*) FILTER (WHERE cached IS FALSE OR state = 'uncached_terminal')::bigint AS uncached_terminal,
          MAX(updated_at) AS last_updated_at
        FROM debrid_availability_cache
        GROUP BY service
        ORDER BY service
      `);
      return res.rows || [];
    } catch (error) {
      console.error(`❌ DB Error getAvailabilityCacheStats: ${error.message}`);
      return [];
    }
  }

  async function getDebridAvailabilityCache(cacheKeys) {
    const pool = getPool();
    if (!pool) return {};
    await awaitDatabaseOptimizations();

    const keys = [...new Set((Array.isArray(cacheKeys) ? cacheKeys : [cacheKeys]).map((key) => sanitizeText(key)).filter(Boolean))];
    if (keys.length === 0) return {};

    try {
      const res = await pool.query(
        `
          SELECT cache_key, payload_json, expires_at
          FROM debrid_availability_cache
          WHERE cache_key = ANY($1::text[])
            AND expires_at > NOW()
        `,
        [keys]
      );
      const out = {};
      for (const row of res.rows || []) {
        if (!row?.cache_key || !row?.payload_json) continue;
        out[row.cache_key] = row.payload_json;
      }
      return out;
    } catch (error) {
      console.error(`❌ DB Error getDebridAvailabilityCache: ${error.message}`);
      return {};
    }
  }

  async function setDebridAvailabilityCache(entries) {
    const pool = getPool();
    if (!pool) return 0;
    await awaitDatabaseOptimizations();

    const rows = (Array.isArray(entries) ? entries : [entries])
      .map((entry) => {
        const parsed = parseAvailabilityCacheKey(entry?.cache_key || entry?.key);
        const payload = entry?.payload && typeof entry.payload === 'object' ? entry.payload : null;
        const ttlSeconds = clampInt(entry?.ttlSeconds || entry?.ttl || 0, 0, 0, 7 * 24 * 60 * 60);
        if (!parsed || !payload || ttlSeconds <= 0) return null;
        return {
          ...parsed,
          payload,
          mediaId: normalizeMarkerPart(entry?.media_id || entry?.mediaId || payload.mediaId || parsed.mediaId, 220),
          imdbId: normalizeImdbId(entry?.imdb_id || entry?.imdbId || payload.imdbId),
          imdbSeason: toNullableInt(entry?.imdb_season ?? entry?.season ?? payload.season),
          imdbEpisode: toNullableInt(entry?.imdb_episode ?? entry?.episode ?? payload.episode),
          proofLevel: sanitizeText(entry?.proof_level || entry?.proofLevel || payload.proofLevel).toLowerCase().slice(0, 48) || null,
          state: normalizeRdCacheState(payload.state),
          cached: payload.cached === true ? true : payload.cached === false ? false : null,
          expiresAt: new Date(Date.now() + ttlSeconds * 1000)
        };
      })
      .filter(Boolean);

    if (rows.length === 0) return 0;

    try {
      return await runInTransaction(async (client) => {
        let updated = 0;
        for (const row of rows) {
          const result = await client.query(
            `
              INSERT INTO debrid_availability_cache (
                cache_key,
                service,
                info_hash,
                info_hash_norm,
                file_index,
                file_index_norm,
                media_id,
                imdb_id,
                imdb_season,
                imdb_episode,
                proof_level,
                payload_json,
                state,
                cached,
                expires_at,
                created_at,
                updated_at
              )
              VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, NOW(), NOW())
              ON CONFLICT (cache_key)
              DO UPDATE SET
                media_id = EXCLUDED.media_id,
                imdb_id = EXCLUDED.imdb_id,
                imdb_season = EXCLUDED.imdb_season,
                imdb_episode = EXCLUDED.imdb_episode,
                proof_level = EXCLUDED.proof_level,
                payload_json = EXCLUDED.payload_json,
                state = EXCLUDED.state,
                cached = EXCLUDED.cached,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()
            `,
            [
              row.key,
              row.service,
              row.hash,
              row.fileIndex,
              row.fileIndexNorm,
              row.mediaId,
              row.imdbId,
              row.imdbSeason,
              row.imdbEpisode,
              row.proofLevel,
              JSON.stringify(row.payload),
              row.state,
              row.cached,
              row.expiresAt
            ]
          );
          updated += Number(result.rowCount || 0);
        }
        return updated;
      });
    } catch (error) {
      console.error(`❌ DB Error setDebridAvailabilityCache: ${error.message}`);
      return 0;
    }
  }

  return {
    getTorrents,
    getPackFiles,
    getSeriesPackFiles,
    getEpisodePackFileHintsByHashes,
    getRdScanBatch,
    insertTorrent,
    insertTorrentsBatch,
    insertEpisodeFiles,
    insertPackFiles,
    updateTorrentTitle,
    ensureTorrentRecord,
    getRdCacheStatusByHashes,
    getRdCachedAvailability,
    updateRdCacheStatus,
    updateTbCacheStatus,
    getRdScanProgress,
    prioritizeRdHashes,
    normalizePendingRdCacheState,
    upsertExternalStreamSnapshots,
    getExternalStreamSnapshots,
    getExternalSnapshotStats,
    getAvailabilityCacheStats,
    getDebridAvailabilityCache,
    setDebridAvailabilityCache,
    isDebridCacheCheckMarked,
    markDebridCacheCheckDone
  };
}

module.exports = {
  createTorrentRepository
};
