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
    normalizeTbCacheState,
    mapTbStateToRdState,
    deriveTbCachedBooleanFromState,
    deriveStoredCacheState,
    deriveCachedBooleanFromState,
    extractOriginalProvider,
    normalizeUniqueTextList,
    toDateOrNull
  } = normalizers;

  const RD_CACHED_RECHECK_HOURS = 168;
  const RD_REVALIDATE_PERMANENT_ON_BOOT = true;
  const TB_STATE_RECHECK_HOURS = Object.freeze({
    cached_verified: 24,
    likely_cached: 3,
    uncertain: 1,
    queued: 1,
    uncached: 6,
    error: 0.25
  });
  const TB_VERIFIED_HARD_MAX_AGE_DAYS = 14;
  const TB_VERIFIED_HARD_MAX_AGE_MS = TB_VERIFIED_HARD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const DB_AUTHORITY_DUAL_WRITE = String(process.env.DB_AUTHORITY_DUAL_WRITE || '1').trim() !== '0';
  const DB_AUTHORITY_READ = String(process.env.DB_AUTHORITY_READ || '1').trim() !== '0';


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


  function makeStableKey(parts) {
    return crypto.createHash('sha1').update(parts.map((part) => String(part ?? '')).join(':')).digest('hex');
  }

  function normalizeAuthorityService(value) {
    const service = sanitizeText(value).toLowerCase();
    if (service === 'rd' || service === 'realdebrid' || service === 'real_debrid') return 'rd';
    if (service === 'tb' || service === 'torbox') return 'tb';
    return null;
  }

  function normalizeAuthorityState(service, state, cached = null) {
    const normalizedService = normalizeAuthorityService(service);
    const raw = sanitizeText(state).toLowerCase();
    if (normalizedService === 'rd') {
      const rdState = normalizeRdCacheState(raw);
      if (rdState === 'cached') return 'cached_verified';
      if (rdState) return rdState;
      if (cached === true) return 'cached_verified';
      if (cached === false) return 'uncached_terminal';
      return 'uncertain';
    }
    if (normalizedService === 'tb') {
      const tbState = normalizeTbCacheState(raw);
      if (tbState) return tbState;
      if (cached === true) return 'cached_verified';
      if (cached === false) return 'uncached';
      return 'uncertain';
    }
    return raw || (cached === true ? 'cached_verified' : (cached === false ? 'uncached' : 'uncertain'));
  }

  function deriveAuthorityCached(state, cached = null) {
    if (state === 'cached_verified') return true;
    if (state === 'uncached' || state === 'uncached_terminal') return false;
    return typeof cached === 'boolean' ? cached : null;
  }

  function getAuthorityProofLevel(entry = {}, state = null) {
    const explicit = sanitizeText(entry?.proof_level || entry?.proofLevel).toLowerCase();
    if (explicit) return explicit.slice(0, 48);
    const fileId = normalizeFileIndex(entry?.service_file_id ?? entry?.rd_file_index ?? entry?.tb_file_id ?? entry?.file_id ?? entry?.fileIndex ?? entry?.file_index);
    const identity = normalizeEpisodeIdentity(entry);
    if (state === 'cached_verified' && identity.isEpisode && Number.isInteger(fileId) && fileId >= 0) return 'episode_exact';
    if (state === 'cached_verified' && Number.isInteger(fileId) && fileId >= 0) return 'file_exact';
    if (state === 'cached_verified') return 'hash_only';
    if (state === 'uncached' || state === 'uncached_terminal') return 'negative_terminal';
    return 'service_state';
  }

  function getAuthorityTtlHours(service, state, fallback = null) {
    const parsedFallback = Number(fallback);
    if (Number.isFinite(parsedFallback) && parsedFallback > 0) return Math.max(0.05, Math.min(24 * 365, parsedFallback));
    const normalizedService = normalizeAuthorityService(service);
    if (normalizedService === 'rd') {
      if (state === 'cached_verified') return RD_CACHED_RECHECK_HOURS;
      if (state === 'uncached_terminal') return 24 * 7;
      if (state === 'likely_uncached') return 6;
      if (state === 'probing' || state === 'uncertain') return 1;
      return 12;
    }
    if (normalizedService === 'tb') return getTbNextCheckHours(state);
    return 6;
  }

  function normalizeAuthorityEntry(entry = {}) {
    const service = normalizeAuthorityService(entry?.service || entry?.debrid_service || entry?.sourceService);
    const hash = normalizeInfoHash(entry?.hash || entry?.info_hash || entry?.infoHash);
    if (!service || !hash) return null;
    const rawFileIndex = entry?.file_index ?? entry?.fileIdx ?? entry?.service_file_id ?? (service === 'rd' ? entry?.rd_file_index : entry?.tb_file_id) ?? entry?.file_id;
    const fileIndex = normalizeFileIndex(rawFileIndex);
    const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
    const state = normalizeAuthorityState(service, entry?.state || entry?.cache_state || entry?.rd_cache_state || entry?.tb_cache_state, typeof entry?.cached === 'boolean' ? entry.cached : null);
    const cached = deriveAuthorityCached(state, typeof entry?.cached === 'boolean' ? entry.cached : null);
    const identity = normalizeEpisodeIdentity(entry);
    const mediaId = sanitizeText(entry?.media_id || entry?.mediaId || (identity.isEpisode ? `${identity.imdbId}:${identity.imdbSeason}:${identity.imdbEpisode}` : '')).slice(0, 220) || null;
    const proofLevel = getAuthorityProofLevel(entry, state);
    const serviceFileId = normalizeFileIndex(entry?.service_file_id ?? (service === 'rd' ? entry?.rd_file_index : entry?.tb_file_id) ?? entry?.file_id ?? fileIndex);
    const serviceFileSize = entry?.service_file_size ?? entry?.file_size ?? (service === 'rd' ? entry?.rd_file_size : entry?.tb_file_size);
    const confidence = Math.max(0, Math.min(1, toSafeNumber(entry?.confidence ?? entry?.tb_cache_confidence ?? (proofLevel === 'episode_exact' ? 0.99 : (proofLevel === 'file_exact' ? 0.95 : (cached === true ? 0.80 : 0.45))), 0)));
    const ttlHours = getAuthorityTtlHours(service, state, entry?.next_hours ?? entry?.ttl_hours);
    const checkedAt = toDateOrNull(entry?.checked_at || entry?.checkedAt || entry?.updated_at) || new Date();
    const expiresAt = toDateOrNull(entry?.expires_at || entry?.expiresAt) || new Date(Date.now() + ttlHours * 3600 * 1000);
    const nextCheckAt = toDateOrNull(entry?.next_check_at || entry?.nextCheckAt) || expiresAt;
    const authorityKey = makeStableKey([service, hash, fileIndexNorm, mediaId || '', identity.imdbId || '', identity.imdbSeason ?? -1, identity.imdbEpisode ?? -1]);
    return {
      authorityKey, service, hash, fileIndex, fileIndexNorm, mediaId,
      imdbId: identity.imdbId, season: identity.imdbSeason, episode: identity.imdbEpisode,
      state, cached, proofLevel, confidence, serviceFileId,
      serviceFileSize: serviceFileSize === null || serviceFileSize === undefined ? null : toSafeNumber(serviceFileSize, 0),
      serviceTorrentId: sanitizeText(entry?.service_torrent_id || entry?.torrent_id || entry?.torrentId).slice(0, 120) || null,
      checkedAt, expiresAt, nextCheckAt,
      failureCount: Math.max(0, toSafeNumber(entry?.failure_count ?? entry?.failures ?? entry?.cache_check_failures, 0)),
      lastError: sanitizeText(entry?.last_error || entry?.error).slice(0, 240) || null,
      matchReason: sanitizeText(entry?.match_reason || entry?.tb_cache_match_reason || entry?.reason || proofLevel).slice(0, 240) || null,
      payload: entry?.payload && typeof entry.payload === 'object' ? entry.payload : null
    };
  }

  async function upsertTorrentItemAuthorityRow(client, torrent = {}) {
    if (!DB_AUTHORITY_DUAL_WRITE) return false;
    const infoHash = normalizeInfoHash(torrent?.infoHash || torrent?.info_hash || torrent?.hash);
    if (!infoHash) return false;
    const title = sanitizeText(torrent?.title, infoHash);
    await client.query(
      `
        INSERT INTO torrent_items (
          info_hash, info_hash_norm, title_best, title_original, type, size, folder_size, seeders, max_seeders,
          resolution, quality_tag, codec_tag, hdr_tag, audio_tag, release_group, languages, trackers, smart_dedupe_key,
          first_seen_at, last_seen_at, seen_count, created_at, updated_at
        )
        VALUES ($1, $1, $2, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW(), 1, NOW(), NOW())
        ON CONFLICT (info_hash_norm)
        DO UPDATE SET
          title_best = CASE WHEN COALESCE(torrent_items.title_best, '') = '' THEN EXCLUDED.title_best WHEN LENGTH(COALESCE(EXCLUDED.title_best, '')) > LENGTH(COALESCE(torrent_items.title_best, '')) THEN EXCLUDED.title_best ELSE torrent_items.title_best END,
          size = GREATEST(COALESCE(torrent_items.size, 0), COALESCE(EXCLUDED.size, 0)),
          folder_size = GREATEST(COALESCE(torrent_items.folder_size, 0), COALESCE(EXCLUDED.folder_size, 0)),
          seeders = GREATEST(COALESCE(torrent_items.seeders, 0), COALESCE(EXCLUDED.seeders, 0)),
          max_seeders = GREATEST(COALESCE(torrent_items.max_seeders, 0), COALESCE(EXCLUDED.max_seeders, 0)),
          resolution = COALESCE(EXCLUDED.resolution, torrent_items.resolution),
          quality_tag = COALESCE(EXCLUDED.quality_tag, torrent_items.quality_tag),
          codec_tag = COALESCE(EXCLUDED.codec_tag, torrent_items.codec_tag),
          hdr_tag = COALESCE(EXCLUDED.hdr_tag, torrent_items.hdr_tag),
          audio_tag = COALESCE(EXCLUDED.audio_tag, torrent_items.audio_tag),
          release_group = COALESCE(EXCLUDED.release_group, torrent_items.release_group),
          languages = COALESCE(EXCLUDED.languages, torrent_items.languages),
          trackers = COALESCE(EXCLUDED.trackers, torrent_items.trackers),
          smart_dedupe_key = COALESCE(EXCLUDED.smart_dedupe_key, torrent_items.smart_dedupe_key),
          last_seen_at = NOW(),
          seen_count = GREATEST(COALESCE(torrent_items.seen_count, 0), 0) + 1,
          updated_at = NOW()
      `,
      [
        infoHash,
        title,
        normalizeStoredType(torrent?.type || (torrent?.isAnime ? 'anime' : (torrent?.is_pack ? 'pack' : null))),
        Math.max(0, toSafeNumber(torrent?.size, 0)),
        normalizeFolderSize(torrent),
        Math.max(0, toSafeNumber(torrent?.seeders, 0)),
        normalizeResolution(torrent?.resolution || torrent?.quality, title),
        normalizeQualityTag(torrent),
        normalizeCodecTag(torrent),
        normalizeHdrTag(torrent),
        normalizeAudioTag(torrent),
        normalizeReleaseGroupTag(torrent),
        normalizeLanguages(torrent),
        normalizeTrackers(torrent),
        normalizeSmartDedupeKeyForDb(torrent)
      ]
    );
    return true;
  }

  async function upsertProviderObservationAuthorityRow(client, torrent = {}, options = {}) {
    if (!DB_AUTHORITY_DUAL_WRITE) return false;
    const infoHash = normalizeInfoHash(torrent?.infoHash || torrent?.info_hash || torrent?.hash);
    if (!infoHash) return false;
    const fileIndex = normalizeFileIndex(torrent?.fileIndex ?? torrent?.file_index ?? torrent?.fileIdx);
    const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
    const providerGroup = sanitizeText(options.providerGroup || torrent?._sourceGroup || torrent?.providerGroup || 'local_db').toLowerCase().slice(0, 64) || 'local_db';
    const providerName = normalizeProviderName(torrent?.provider || torrent?.providerName || options.providerName, torrent?.title).slice(0, 160) || 'unknown';
    const addonName = sanitizeText(options.addonName || torrent?.externalAddon || torrent?._externalAddon || 'leviathan').toLowerCase().slice(0, 96) || 'leviathan';
    const observationKey = makeStableKey([infoHash, fileIndexNorm, providerGroup, providerName, addonName]);
    const payload = options.payload || null;
    await client.query(
      `
        INSERT INTO provider_observations (observation_key, info_hash, info_hash_norm, file_index, file_index_norm, provider_group, provider_name, addon_name, raw_title, raw_quality, raw_languages, seeders, size, magnet, stream_url, source_priority, first_seen_at, last_seen_at, seen_count, payload_json, created_at, updated_at)
        VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW(), 1, $16::jsonb, NOW(), NOW())
        ON CONFLICT (observation_key)
        DO UPDATE SET
          raw_title = CASE WHEN COALESCE(provider_observations.raw_title, '') = '' THEN EXCLUDED.raw_title WHEN LENGTH(COALESCE(EXCLUDED.raw_title, '')) > LENGTH(COALESCE(provider_observations.raw_title, '')) THEN EXCLUDED.raw_title ELSE provider_observations.raw_title END,
          raw_quality = COALESCE(EXCLUDED.raw_quality, provider_observations.raw_quality),
          raw_languages = COALESCE(EXCLUDED.raw_languages, provider_observations.raw_languages),
          seeders = GREATEST(COALESCE(provider_observations.seeders, 0), COALESCE(EXCLUDED.seeders, 0)),
          size = GREATEST(COALESCE(provider_observations.size, 0), COALESCE(EXCLUDED.size, 0)),
          magnet = COALESCE(EXCLUDED.magnet, provider_observations.magnet),
          stream_url = COALESCE(EXCLUDED.stream_url, provider_observations.stream_url),
          last_seen_at = NOW(),
          seen_count = GREATEST(COALESCE(provider_observations.seen_count, 0), 0) + 1,
          payload_json = COALESCE(EXCLUDED.payload_json, provider_observations.payload_json),
          updated_at = NOW()
      `,
      [
        observationKey, infoHash, fileIndex, fileIndexNorm, providerGroup, providerName, addonName,
        sanitizeText(torrent?.title, infoHash),
        sanitizeText(torrent?.quality || torrent?.qualityTag || torrent?.quality_tag || normalizeQualityTag(torrent)).slice(0, 120) || null,
        normalizeLanguages(torrent),
        Math.max(0, toSafeNumber(torrent?.seeders, 0)),
        Math.max(0, toSafeNumber(torrent?.size, 0)),
        sanitizeText(torrent?.magnet || torrent?.magnetLink || '').slice(0, 4096) || null,
        sanitizeText(torrent?.url || torrent?.streamUrl || torrent?.stream_url || '').slice(0, 4096) || null,
        clampInt(options.sourcePriority, 20, 0, 100),
        payload ? JSON.stringify(payload) : null
      ]
    );
    return true;
  }

  async function upsertTorrentFileAuthorityRow(client, file = {}) {
    if (!DB_AUTHORITY_DUAL_WRITE) return false;
    const infoHash = normalizeInfoHash(file?.pack_hash || file?.packHash || file?.info_hash || file?.infoHash || file?.hash);
    if (!infoHash) return false;
    const fileIndex = normalizeFileIndex(file?.file_index ?? file?.fileIdx ?? file?.index);
    const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
    const filePath = sanitizeText(file?.file_path || file?.path);
    const leafName = sanitizeText(file?.file_title || file?.title || (filePath ? filePath.split('/').pop() : ''), '');
    const fileSize = Math.max(0, toSafeNumber(file?.file_size ?? file?.size, 0));
    const extensionMatch = sanitizeText(filePath || leafName).match(/\.([a-z0-9]{2,6})$/i);
    const extension = extensionMatch ? extensionMatch[1].toLowerCase() : null;
    const isVideo = extension ? /^(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i.test(extension) : null;
    const fileKey = makeStableKey([infoHash, fileIndexNorm]);
    await client.query(
      `
        INSERT INTO torrent_files (file_key, info_hash, info_hash_norm, file_index, file_index_norm, rd_file_id, tb_file_id, path, leaf_name, size, extension, is_video, video_rank, parsed_season, parsed_episode, path_hash, source, confidence, created_at, updated_at)
        VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
        ON CONFLICT (info_hash_norm, file_index_norm)
        DO UPDATE SET
          rd_file_id = COALESCE(EXCLUDED.rd_file_id, torrent_files.rd_file_id),
          tb_file_id = COALESCE(EXCLUDED.tb_file_id, torrent_files.tb_file_id),
          path = COALESCE(NULLIF(EXCLUDED.path, ''), torrent_files.path),
          leaf_name = CASE WHEN COALESCE(torrent_files.leaf_name, '') = '' THEN EXCLUDED.leaf_name WHEN LENGTH(COALESCE(EXCLUDED.leaf_name, '')) > LENGTH(COALESCE(torrent_files.leaf_name, '')) THEN EXCLUDED.leaf_name ELSE torrent_files.leaf_name END,
          size = GREATEST(COALESCE(torrent_files.size, 0), COALESCE(EXCLUDED.size, 0)),
          extension = COALESCE(EXCLUDED.extension, torrent_files.extension),
          is_video = COALESCE(EXCLUDED.is_video, torrent_files.is_video),
          video_rank = GREATEST(COALESCE(torrent_files.video_rank, 0), COALESCE(EXCLUDED.video_rank, 0)),
          parsed_season = COALESCE(EXCLUDED.parsed_season, torrent_files.parsed_season),
          parsed_episode = COALESCE(EXCLUDED.parsed_episode, torrent_files.parsed_episode),
          path_hash = COALESCE(EXCLUDED.path_hash, torrent_files.path_hash),
          confidence = GREATEST(COALESCE(torrent_files.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
          updated_at = NOW()
      `,
      [
        fileKey, infoHash, fileIndex, fileIndexNorm,
        normalizeFileIndex(file?.rd_file_id ?? file?.rd_file_index),
        normalizeFileIndex(file?.tb_file_id ?? file?.file_id),
        filePath, leafName, fileSize, extension, isVideo,
        isVideo ? (fileSize >= 50 * 1024 * 1024 ? 100 : 50) : 0,
        toNullableInt(file?.imdb_season ?? file?.season),
        toNullableInt(file?.imdb_episode ?? file?.episode),
        filePath ? crypto.createHash('sha1').update(filePath).digest('hex') : null,
        sanitizeText(file?.source || 'legacy_write').slice(0, 80),
        Math.max(0, Math.min(1, toSafeNumber(file?.confidence ?? 0.90, 0.90)))
      ]
    );
    return true;
  }

  async function upsertMediaFileMapAuthorityRow(client, mapping = {}) {
    if (!DB_AUTHORITY_DUAL_WRITE) return false;
    const infoHash = normalizeInfoHash(mapping?.infoHash || mapping?.info_hash || mapping?.hash || mapping?.pack_hash || mapping?.packHash);
    const imdbId = normalizeImdbId(mapping?.imdb_id || mapping?.imdbId);
    if (!infoHash || !imdbId) return false;
    const fileIndex = normalizeFileIndex(mapping?.file_index ?? mapping?.fileIdx ?? mapping?.index);
    const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
    const season = toNullableInt(mapping?.imdb_season ?? mapping?.season);
    const episode = toNullableInt(mapping?.imdb_episode ?? mapping?.episode);
    const mediaType = sanitizeText(mapping?.media_type || mapping?.type || (season !== null && episode !== null ? 'series' : 'movie')).toLowerCase().slice(0, 32) || 'movie';
    const source = sanitizeText(mapping?.match_source || mapping?.source || 'legacy_write').slice(0, 80) || 'legacy_write';
    const mapKey = makeStableKey([infoHash, fileIndexNorm, imdbId, season ?? -1, episode ?? -1, source]);
    await client.query(
      `
        INSERT INTO media_file_map (map_key, info_hash, info_hash_norm, file_index, file_index_norm, imdb_id, tmdb_id, kitsu_id, season, episode, absolute_episode, media_type, match_source, match_confidence, match_reason, is_exact, created_at, updated_at)
        VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        ON CONFLICT (map_key)
        DO UPDATE SET
          tmdb_id = COALESCE(EXCLUDED.tmdb_id, media_file_map.tmdb_id),
          kitsu_id = COALESCE(EXCLUDED.kitsu_id, media_file_map.kitsu_id),
          absolute_episode = COALESCE(EXCLUDED.absolute_episode, media_file_map.absolute_episode),
          match_confidence = GREATEST(COALESCE(media_file_map.match_confidence, 0), COALESCE(EXCLUDED.match_confidence, 0)),
          match_reason = COALESCE(EXCLUDED.match_reason, media_file_map.match_reason),
          is_exact = media_file_map.is_exact OR EXCLUDED.is_exact,
          updated_at = NOW()
      `,
      [
        mapKey, infoHash, fileIndex, fileIndexNorm, imdbId,
        sanitizeText(mapping?.tmdb_id || mapping?.tmdbId).slice(0, 64) || null,
        sanitizeText(mapping?.kitsu_id || mapping?.kitsuId).slice(0, 64) || null,
        season, episode, toNullableInt(mapping?.absolute_episode ?? mapping?.absoluteEpisode),
        mediaType, source,
        Math.max(0, Math.min(1, toSafeNumber(mapping?.match_confidence ?? mapping?.confidence ?? 0.90, 0.90))),
        sanitizeText(mapping?.match_reason || mapping?.reason || source).slice(0, 240),
        mapping?.is_exact === false ? false : true
      ]
    );
    return true;
  }

  async function upsertDebridAuthorityRow(client, entry = {}) {
    if (!DB_AUTHORITY_DUAL_WRITE) return false;
    const row = normalizeAuthorityEntry(entry);
    if (!row) return false;
    await client.query(
      `
        INSERT INTO debrid_authority (authority_key, service, info_hash, info_hash_norm, file_index, file_index_norm, media_id, imdb_id, season, episode, state, cached, proof_level, confidence, service_file_id, service_file_size, service_torrent_id, checked_at, expires_at, next_check_at, failure_count, last_error, match_reason, payload_json, created_at, updated_at)
        VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, NOW(), NOW())
        ON CONFLICT (authority_key)
        DO UPDATE SET
          state = EXCLUDED.state,
          cached = EXCLUDED.cached,
          proof_level = CASE WHEN EXCLUDED.proof_level IN ('episode_exact', 'file_exact') THEN EXCLUDED.proof_level WHEN debrid_authority.proof_level IN ('episode_exact', 'file_exact') THEN debrid_authority.proof_level ELSE EXCLUDED.proof_level END,
          confidence = GREATEST(COALESCE(debrid_authority.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
          service_file_id = COALESCE(EXCLUDED.service_file_id, debrid_authority.service_file_id),
          service_file_size = GREATEST(COALESCE(debrid_authority.service_file_size, 0), COALESCE(EXCLUDED.service_file_size, 0)),
          service_torrent_id = COALESCE(EXCLUDED.service_torrent_id, debrid_authority.service_torrent_id),
          checked_at = GREATEST(COALESCE(debrid_authority.checked_at, EXCLUDED.checked_at), COALESCE(EXCLUDED.checked_at, debrid_authority.checked_at)),
          expires_at = GREATEST(COALESCE(debrid_authority.expires_at, EXCLUDED.expires_at), COALESCE(EXCLUDED.expires_at, debrid_authority.expires_at)),
          next_check_at = COALESCE(EXCLUDED.next_check_at, debrid_authority.next_check_at),
          failure_count = EXCLUDED.failure_count,
          last_error = COALESCE(EXCLUDED.last_error, debrid_authority.last_error),
          match_reason = COALESCE(EXCLUDED.match_reason, debrid_authority.match_reason),
          payload_json = COALESCE(EXCLUDED.payload_json, debrid_authority.payload_json),
          updated_at = NOW()
      `,
      [
        row.authorityKey, row.service, row.hash, row.fileIndex, row.fileIndexNorm, row.mediaId, row.imdbId,
        row.season, row.episode, row.state, row.cached, row.proofLevel, row.confidence, row.serviceFileId,
        row.serviceFileSize, row.serviceTorrentId, row.checkedAt, row.expiresAt, row.nextCheckAt,
        row.failureCount, row.lastError, row.matchReason, row.payload ? JSON.stringify(row.payload) : null
      ]
    );
    return true;
  }

  async function upsertDebridAuthorityRows(entries = []) {
    const pool = getPool();
    if (!pool || !DB_AUTHORITY_DUAL_WRITE) return 0;
    await awaitDatabaseOptimizations();
    const rows = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
    if (rows.length === 0) return 0;
    try {
      return await runInTransaction(async (client) => {
        let updated = 0;
        for (const entry of rows) if (await upsertDebridAuthorityRow(client, entry)) updated += 1;
        return updated;
      });
    } catch (error) {
      console.error(`❌ DB Error upsertDebridAuthorityRows: ${error.message}`);
      return 0;
    }
  }

  async function getDebridAuthorityByHashes(hashes, service = null) {
    const pool = getPool();
    if (!pool || !DB_AUTHORITY_READ) return [];
    await awaitDatabaseOptimizations();
    const normalizedHashes = normalizeUniqueInfoHashes(hashes);
    const normalizedService = normalizeAuthorityService(service);
    if (normalizedHashes.length === 0) return [];
    try {
      const res = await pool.query(
        `
          SELECT DISTINCT ON (service, info_hash_norm, file_index_norm, COALESCE(media_id, ''))
            service, info_hash_norm AS hash, file_index, file_index_norm, media_id, imdb_id, season, episode,
            state, cached, proof_level, confidence, service_file_id, service_file_size, checked_at, expires_at,
            next_check_at, failure_count, match_reason
          FROM debrid_authority
          WHERE info_hash_norm = ANY($1::text[])
            AND ($2::text IS NULL OR service = $2::text)
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY service, info_hash_norm, file_index_norm, COALESCE(media_id, ''),
            CASE WHEN proof_level = 'episode_exact' THEN 5 WHEN proof_level = 'file_exact' THEN 4 WHEN state = 'cached_verified' THEN 3 WHEN state IN ('likely_cached','queued','probing') THEN 2 WHEN state IN ('uncached','uncached_terminal') THEN 1 ELSE 0 END DESC,
            confidence DESC, checked_at DESC NULLS LAST
        `,
        [normalizedHashes, normalizedService]
      );
      return (res.rows || []).map((row) => ({
        service: normalizeAuthorityService(row.service),
        hash: normalizeInfoHash(row.hash),
        file_index: normalizeFileIndex(row.file_index),
        file_index_norm: normalizeFileIndexNorm(row.file_index),
        media_id: sanitizeText(row.media_id),
        imdb_id: normalizeImdbId(row.imdb_id),
        season: toNullableInt(row.season),
        episode: toNullableInt(row.episode),
        state: sanitizeText(row.state).toLowerCase(),
        cached: row.cached === null || row.cached === undefined ? null : Boolean(row.cached),
        proof_level: sanitizeText(row.proof_level).toLowerCase(),
        confidence: toSafeNumber(row.confidence, 0),
        service_file_id: normalizeFileIndex(row.service_file_id),
        service_file_size: toSafeNumber(row.service_file_size, 0),
        checked_at: row.checked_at || null,
        expires_at: row.expires_at || null,
        next_check_at: row.next_check_at || null,
        failure_count: toSafeNumber(row.failure_count, 0),
        match_reason: sanitizeText(row.match_reason)
      })).filter((row) => row.hash && row.service);
    } catch (error) {
      console.error(`❌ DB Error getDebridAuthorityByHashes: ${error.message}`);
      return [];
    }
  }

  async function enqueueDebridChecks(entries = []) {
    const pool = getPool();
    if (!pool || !Array.isArray(entries) || entries.length === 0) return 0;
    await awaitDatabaseOptimizations();
    try {
      return await runInTransaction(async (client) => {
        let updated = 0;
        for (const entry of entries) {
          const service = normalizeAuthorityService(entry?.service);
          const hash = normalizeInfoHash(entry?.hash || entry?.info_hash || entry?.infoHash);
          if (!service || !hash) continue;
          const fileIndex = normalizeFileIndex(entry?.file_index ?? entry?.fileIdx);
          const fileIndexNorm = normalizeFileIndexNorm(fileIndex);
          const mediaId = sanitizeText(entry?.media_id || entry?.mediaId).slice(0, 220) || null;
          const jobKey = makeStableKey([service, hash, fileIndexNorm, mediaId || '']);
          const result = await client.query(
            `
              INSERT INTO debrid_check_jobs (job_key, service, info_hash, info_hash_norm, file_index, file_index_norm, media_id, priority, status, run_after, created_at, updated_at)
              VALUES ($1, $2, $3, $3, $4, $5, $6, $7, 'pending', $8, NOW(), NOW())
              ON CONFLICT (job_key)
              DO UPDATE SET priority = LEAST(debrid_check_jobs.priority, EXCLUDED.priority), status = CASE WHEN debrid_check_jobs.status IN ('done','failed') THEN 'pending' ELSE debrid_check_jobs.status END, run_after = LEAST(COALESCE(debrid_check_jobs.run_after, EXCLUDED.run_after), EXCLUDED.run_after), updated_at = NOW()
              RETURNING 1
            `,
            [jobKey, service, hash, fileIndex, fileIndexNorm, mediaId, clampInt(entry?.priority, 50, 0, 100), toDateOrNull(entry?.run_after || entry?.runAfter) || new Date()]
          );
          updated += Number(result.rowCount || 0);
        }
        return updated;
      });
    } catch (error) {
      console.error(`❌ DB Error enqueueDebridChecks: ${error.message}`);
      return 0;
    }
  }



  async function getDueDebridJobs(service = null, limit = 25, workerId = null) {
    const pool = getPool();
    if (!pool) return [];
    await awaitDatabaseOptimizations();
    const normalizedService = normalizeAuthorityService(service);
    const jobLimit = clampInt(limit, 25, 1, 200);
    const owner = sanitizeText(workerId || `leviathan-${process.pid}`).slice(0, 80);
    try {
      const res = await pool.query(
        `
          WITH picked AS (
            SELECT job_key
            FROM debrid_check_jobs
            WHERE status = 'pending'
              AND run_after <= NOW()
              AND ($1::text IS NULL OR service = $1::text)
              AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '10 minutes')
            ORDER BY priority ASC, run_after ASC, created_at ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          UPDATE debrid_check_jobs j
          SET status = 'running', locked_at = NOW(), locked_by = $3, attempts = attempts + 1, updated_at = NOW()
          FROM picked
          WHERE j.job_key = picked.job_key
          RETURNING j.job_key, j.service, j.info_hash_norm AS hash, j.file_index, j.file_index_norm, j.media_id, j.priority, j.attempts, j.run_after
        `,
        [normalizedService, jobLimit, owner]
      );
      return (res.rows || []).map((row) => ({
        job_key: sanitizeText(row.job_key),
        service: normalizeAuthorityService(row.service),
        hash: normalizeInfoHash(row.hash),
        file_index: normalizeFileIndex(row.file_index),
        file_index_norm: normalizeFileIndexNorm(row.file_index),
        media_id: sanitizeText(row.media_id),
        priority: toSafeNumber(row.priority, 50),
        attempts: toSafeNumber(row.attempts, 0),
        run_after: row.run_after || null
      })).filter((row) => row.job_key && row.service && row.hash);
    } catch (error) {
      console.error(`❌ DB Error getDueDebridJobs: ${error.message}`);
      return [];
    }
  }

  async function markDebridJobDone(jobKey, options = {}) {
    const pool = getPool();
    if (!pool) return false;
    await awaitDatabaseOptimizations();
    const key = sanitizeText(jobKey);
    if (!key) return false;
    const status = options?.ok === false ? 'failed' : 'done';
    const errorText = sanitizeText(options?.error || options?.last_error).slice(0, 240) || null;
    const retryAfter = toDateOrNull(options?.retry_after || options?.retryAfter);
    try {
      await pool.query(
        `
          UPDATE debrid_check_jobs
          SET status = CASE WHEN $2::text = 'failed' AND $4::timestamptz IS NOT NULL THEN 'pending' ELSE $2::text END,
              locked_at = NULL,
              locked_by = NULL,
              last_error = $3,
              run_after = COALESCE($4::timestamptz, run_after),
              updated_at = NOW()
          WHERE job_key = $1
        `,
        [key, status, errorText, retryAfter]
      );
      return true;
    } catch (error) {
      console.error(`❌ DB Error markDebridJobDone: ${error.message}`);
      return false;
    }
  }


  function normalizeEpisodeIdentity(entry) {
    const imdbId = normalizeImdbId(entry?.imdb_id || entry?.imdbId);
    const imdbSeason = toNullableInt(entry?.imdb_season ?? entry?.season);
    const imdbEpisode = toNullableInt(entry?.imdb_episode ?? entry?.episode);
    const isEpisode = Boolean(imdbId && imdbSeason !== null && imdbSeason > 0 && imdbEpisode !== null && imdbEpisode > 0);
    return { imdbId, imdbSeason, imdbEpisode, isEpisode };
  }


  async function clearEpisodeScopedTbOverrideRow(client, entry) {
    const hash = normalizeInfoHash(entry?.hash || entry?.info_hash || entry?.infoHash);
    const identity = normalizeEpisodeIdentity(entry);
    if (!hash || !identity.isEpisode) return false;

    await client.query(
      `
        UPDATE episode_file_overrides
        SET tb_file_id = NULL,
            tb_file_size = NULL,
            updated_at = NOW()
        WHERE info_hash_norm = $1
          AND imdb_id = $2
          AND imdb_season = $3
          AND imdb_episode = $4
      `,
      [hash, identity.imdbId, identity.imdbSeason, identity.imdbEpisode]
    );
    return true;
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

    await upsertMediaFileMapAuthorityRow(client, {
      info_hash: hash,
      imdb_id: identity.imdbId,
      imdb_season: identity.imdbSeason,
      imdb_episode: identity.imdbEpisode,
      match_source: 'legacy_episode_override',
      match_confidence: 0.99,
      match_reason: 'episode override service-file proof',
      is_exact: true
    });

    if (Number.isInteger(rdFileIndex) && rdFileIndex >= 0) {
      await upsertDebridAuthorityRow(client, {
        service: 'rd',
        hash,
        file_index: rdFileIndex,
        imdb_id: identity.imdbId,
        imdb_season: identity.imdbSeason,
        imdb_episode: identity.imdbEpisode,
        state: 'cached',
        cached: true,
        rd_file_index: rdFileIndex,
        rd_file_size: rdFileSize,
        proof_level: 'episode_exact',
        confidence: 0.99,
        next_hours: 24 * 14,
        match_reason: 'legacy_episode_override_rd'
      });
    }

    if (Number.isInteger(tbFileId) && tbFileId >= 0) {
      await upsertDebridAuthorityRow(client, {
        service: 'tb',
        hash,
        file_index: tbFileId,
        imdb_id: identity.imdbId,
        imdb_season: identity.imdbSeason,
        imdb_episode: identity.imdbEpisode,
        state: 'cached_verified',
        cached: true,
        tb_file_id: tbFileId,
        tb_file_size: tbFileSize,
        proof_level: 'episode_exact',
        confidence: 0.99,
        next_hours: 72,
        match_reason: 'legacy_episode_override_tb'
      });
    }

    return true;
  }

  function isTbVerifiedFreshEnough(row = {}) {
    const state = normalizeTbCacheState(row?.tb_cache_state);
    const cached = row?.tb_cached === true;
    if (state !== 'cached_verified' && !cached) return false;
    const checkedAt = toDateOrNull(row?.tb_last_cached_check);
    if (!checkedAt) return false;
    return Date.now() - checkedAt.getTime() <= TB_VERIFIED_HARD_MAX_AGE_MS;
  }

  function normalizeTbDbState(row = {}) {
    const state = normalizeTbCacheState(row?.tb_cache_state);
    const cached = row?.tb_cached === null || row?.tb_cached === undefined ? null : Boolean(row.tb_cached);
    const verified = state === 'cached_verified' || cached === true;
    if (!verified) {
      return {
        state,
        cached,
        reason: sanitizeText(row?.tb_cache_match_reason)
      };
    }
    if (isTbVerifiedFreshEnough(row)) {
      return {
        state: 'cached_verified',
        cached: true,
        reason: sanitizeText(row?.tb_cache_match_reason)
      };
    }
    const previousReason = sanitizeText(row?.tb_cache_match_reason);
    return {
      state: 'uncertain',
      cached: null,
      reason: previousReason
        ? `stale_cached_verified_gt_${TB_VERIFIED_HARD_MAX_AGE_DAYS}d:${previousReason}`
        : `stale_cached_verified_gt_${TB_VERIFIED_HARD_MAX_AGE_DAYS}d`
    };
  }

  function normalizeTorrentRow(row) {
    const infoHash = normalizeInfoHash(row?.info_hash);
    if (!infoHash) return null;
    const tbDbState = normalizeTbDbState(row);
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
      matched_file_size: toSafeNumber(row.matched_file_size, 0),
      file_title: sanitizeText(row.matched_file_title || row.title),
      file_size: toSafeNumber(row.matched_file_size || row.size, 0),
      cached_rd: row.cached_rd === null || row.cached_rd === undefined ? null : Boolean(row.cached_rd),
      rd_cache_state: normalizeRdCacheState(row.rd_cache_state),
      rd_file_index: normalizeFileIndex(row.rd_file_index),
      rd_file_size: toSafeNumber(row.rd_file_size, 0),
      last_cached_check: row.last_cached_check || null,
      next_cached_check: row.next_cached_check || null,
      cache_check_failures: toSafeNumber(row.cache_check_failures, 0),
      tb_cached: tbDbState.cached,
      tb_cache_state: tbDbState.state,
      tb_cache_rd_state: mapTbStateToRdState(tbDbState.state),
      tb_cache_confidence: toSafeNumber(row.tb_cache_confidence, 0),
      tb_cache_match_reason: tbDbState.reason,
      tb_next_cached_check: row.tb_next_cached_check || null,
      tb_cache_check_failures: toSafeNumber(row.tb_cache_check_failures, 0),
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
      ? [normalizedImdb, normalizedSeason, normalizedEpisode, TB_VERIFIED_HARD_MAX_AGE_DAYS, DB_AUTHORITY_READ]
      : [normalizedImdb, TB_VERIFIED_HARD_MAX_AGE_DAYS, DB_AUTHORITY_READ];

    const query = isSeriesEpisode
      ? `
        WITH authority_matches AS (
          SELECT
            info_hash_norm AS hash_norm,
            CASE
              WHEN service_file_id IS NOT NULL AND service_file_id >= 0 THEN service_file_id
              WHEN file_index IS NOT NULL THEN file_index
              ELSE -1
            END AS matched_file_index,
            CASE
              WHEN service_file_id IS NOT NULL AND service_file_id >= 0 THEN service_file_id
              WHEN file_index IS NOT NULL THEN file_index
              ELSE -1
            END AS matched_file_index_norm,
            COALESCE(NULLIF(payload_json->>'file_title', ''), NULLIF(payload_json->>'name', ''), info_hash_norm) AS matched_file_title,
            service_file_size AS matched_file_size,
            0 AS source_rank
          FROM debrid_authority
          WHERE $5::boolean IS TRUE
            AND service = 'tb'
            AND imdb_id = $1
            AND season = $2
            AND episode = $3
            AND info_hash_norm IS NOT NULL
            AND state IN ('cached_verified','likely_cached','queued','probing','uncertain')
            AND (checked_at IS NULL OR checked_at >= NOW() - INTERVAL '90 days')
            AND (expires_at IS NULL OR expires_at >= NOW() - INTERVAL '6 hours')
        ),
        episode_matches AS (
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

          UNION ALL

          SELECT
            hash_norm,
            matched_file_index,
            matched_file_index_norm,
            matched_file_title,
            matched_file_size,
            source_rank
          FROM authority_matches
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
        ),
        best_tb_authority AS (
          SELECT DISTINCT ON (info_hash_norm)
            info_hash_norm,
            cached,
            state,
            confidence,
            match_reason,
            next_check_at,
            failure_count,
            service_file_id,
            service_file_size,
            checked_at
          FROM debrid_authority
          WHERE $5::boolean IS TRUE
            AND service = 'tb'
            AND imdb_id = $1
            AND season = $2
            AND episode = $3
            AND info_hash_norm IS NOT NULL
            AND state IN ('cached_verified','likely_cached','queued','probing','uncertain','uncached','uncached_terminal','error')
            AND (checked_at IS NULL OR checked_at >= NOW() - INTERVAL '90 days')
            AND (expires_at IS NULL OR expires_at >= NOW() - INTERVAL '6 hours')
          ORDER BY
            info_hash_norm,
            CASE WHEN state = 'cached_verified' THEN 7 WHEN state = 'likely_cached' THEN 6 WHEN state IN ('queued','probing') THEN 5 WHEN state = 'uncertain' THEN 4 WHEN state IN ('uncached','uncached_terminal') THEN 2 WHEN state = 'error' THEN 1 ELSE 0 END DESC,
            CASE WHEN proof_level = 'episode_exact' THEN 5 WHEN proof_level = 'file_exact' THEN 4 WHEN proof_level = 'file_list' THEN 3 ELSE 0 END DESC,
            confidence DESC,
            checked_at DESC NULLS LAST
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
          COALESCE(m.matched_file_index, a.service_file_id, t.file_index) AS file_index,
          COALESCE(m.matched_file_index, a.service_file_id) AS matched_file_index,
          m.matched_file_title,
          COALESCE(m.matched_file_size, a.service_file_size) AS matched_file_size,
          t.cached_rd,
          t.rd_cache_state,
          COALESCE(o.rd_file_index, t.rd_file_index) AS rd_file_index,
          COALESCE(o.rd_file_size, t.rd_file_size) AS rd_file_size,
          t.last_cached_check,
          t.next_cached_check,
          t.cache_check_failures,
          COALESCE(a.cached, t.tb_cached) AS tb_cached,
          COALESCE(a.state, t.tb_cache_state) AS tb_cache_state,
          GREATEST(COALESCE(a.confidence, 0), COALESCE(t.tb_cache_confidence, 0)) AS tb_cache_confidence,
          COALESCE(NULLIF(a.match_reason, ''), t.tb_cache_match_reason) AS tb_cache_match_reason,
          COALESCE(a.next_check_at, t.tb_next_cached_check) AS tb_next_cached_check,
          GREATEST(COALESCE(a.failure_count, 0), COALESCE(t.tb_cache_check_failures, 0)) AS tb_cache_check_failures,
          COALESCE(o.tb_file_id, a.service_file_id, t.tb_file_id) AS tb_file_id,
          COALESCE(o.tb_file_size, a.service_file_size, t.tb_file_size) AS tb_file_size,
          CASE
            WHEN a.checked_at IS NULL THEN t.tb_last_cached_check
            WHEN t.tb_last_cached_check IS NULL THEN a.checked_at
            ELSE GREATEST(a.checked_at, t.tb_last_cached_check)
          END AS tb_last_cached_check
        FROM dedup_matches m
        JOIN torrents t
          ON t.info_hash_norm = m.hash_norm
        LEFT JOIN episode_overrides o
          ON o.hash_norm = t.info_hash_norm
        LEFT JOIN best_tb_authority a
          ON a.info_hash_norm = t.info_hash_norm
        ORDER BY
          t.info_hash_norm,
          COALESCE(m.matched_file_index_norm, t.file_index_norm),
          CASE WHEN COALESCE(o.rd_file_index, t.rd_file_index) IS NOT NULL THEN 1 ELSE 0 END DESC,
          CASE WHEN t.cached_rd IS TRUE THEN 1 ELSE 0 END DESC,
          CASE WHEN (COALESCE(a.state, t.tb_cache_state) = 'cached_verified' OR COALESCE(a.cached, t.tb_cached) IS TRUE) AND COALESCE(a.checked_at, t.tb_last_cached_check) >= NOW() - ($4::integer * INTERVAL '1 day') THEN 1 ELSE 0 END DESC,
          CASE WHEN m.source_rank = 0 THEN 1 ELSE 0 END DESC,
          CASE
            WHEN COALESCE(t.resolution, t.title) ~* '(4320p|8k)' THEN 5
            WHEN COALESCE(t.resolution, t.title) ~* '(2160p|4k|uhd)' THEN 4
            WHEN COALESCE(t.resolution, t.title) ~* '(1440p|2k|qhd)' THEN 3
            WHEN COALESCE(t.resolution, t.title) ~* '(1080p|1080i|fhd|full[-. ]?hd)' THEN 2
            WHEN COALESCE(t.resolution, t.title) ~* '(720p|hd)' THEN 1
            ELSE 0
          END DESC,
          GREATEST(COALESCE(t.seeders, 0), COALESCE(t.max_seeders, 0)) DESC,
          COALESCE(t.seen_count, 0) DESC,
          COALESCE(t.last_seen_at, t.updated_at, t.created_at) DESC NULLS LAST,
          COALESCE(m.matched_file_size, a.service_file_size, t.folder_size, t.rd_file_size, t.size, 0) DESC
      `
      : `
        WITH authority_matches AS (
          SELECT
            info_hash_norm,
            CASE
              WHEN service_file_id IS NOT NULL AND service_file_id >= 0 THEN service_file_id
              WHEN file_index IS NOT NULL THEN file_index
              ELSE -1
            END AS file_index_norm,
            CASE
              WHEN service_file_id IS NOT NULL AND service_file_id >= 0 THEN service_file_id
              WHEN file_index IS NOT NULL THEN file_index
              ELSE -1
            END AS matched_file_index,
            COALESCE(NULLIF(payload_json->>'file_title', ''), NULLIF(payload_json->>'name', ''), info_hash_norm) AS matched_file_title,
            service_file_size AS matched_file_size,
            0 AS source_rank
          FROM debrid_authority
          WHERE $3::boolean IS TRUE
            AND service = 'tb'
            AND imdb_id = $1
            AND (season IS NULL OR season = 0)
            AND (episode IS NULL OR episode = 0)
            AND info_hash_norm IS NOT NULL
            AND state IN ('cached_verified','likely_cached','queued','probing','uncertain')
            AND (checked_at IS NULL OR checked_at >= NOW() - INTERVAL '90 days')
            AND (expires_at IS NULL OR expires_at >= NOW() - INTERVAL '6 hours')
        ),
        movie_matches AS (
          SELECT
            info_hash_norm,
            file_index_norm,
            file_index AS matched_file_index,
            title AS matched_file_title,
            size AS matched_file_size,
            1 AS source_rank
          FROM files
          WHERE imdb_id = $1
            AND (imdb_season IS NULL OR imdb_season = 0)

          UNION ALL

          SELECT
            info_hash_norm,
            file_index_norm,
            matched_file_index,
            matched_file_title,
            matched_file_size,
            source_rank
          FROM authority_matches
        ),
        matched_files AS (
          SELECT DISTINCT ON (info_hash_norm, file_index_norm)
            info_hash_norm,
            file_index_norm,
            matched_file_index,
            matched_file_title,
            matched_file_size,
            source_rank
          FROM movie_matches
          WHERE info_hash_norm IS NOT NULL
          ORDER BY info_hash_norm, file_index_norm, source_rank ASC, COALESCE(matched_file_size, 0) DESC, LENGTH(COALESCE(matched_file_title, '')) DESC
        ),
        best_tb_authority AS (
          SELECT DISTINCT ON (info_hash_norm)
            info_hash_norm,
            cached,
            state,
            confidence,
            match_reason,
            next_check_at,
            failure_count,
            service_file_id,
            service_file_size,
            checked_at
          FROM debrid_authority
          WHERE $3::boolean IS TRUE
            AND service = 'tb'
            AND imdb_id = $1
            AND (season IS NULL OR season = 0)
            AND (episode IS NULL OR episode = 0)
            AND info_hash_norm IS NOT NULL
            AND state IN ('cached_verified','likely_cached','queued','probing','uncertain','uncached','uncached_terminal','error')
            AND (checked_at IS NULL OR checked_at >= NOW() - INTERVAL '90 days')
            AND (expires_at IS NULL OR expires_at >= NOW() - INTERVAL '6 hours')
          ORDER BY
            info_hash_norm,
            CASE WHEN state = 'cached_verified' THEN 7 WHEN state = 'likely_cached' THEN 6 WHEN state IN ('queued','probing') THEN 5 WHEN state = 'uncertain' THEN 4 WHEN state IN ('uncached','uncached_terminal') THEN 2 WHEN state = 'error' THEN 1 ELSE 0 END DESC,
            CASE WHEN proof_level = 'episode_exact' THEN 5 WHEN proof_level = 'file_exact' THEN 4 WHEN proof_level = 'file_list' THEN 3 ELSE 0 END DESC,
            confidence DESC,
            checked_at DESC NULLS LAST
        )
        SELECT DISTINCT ON (t.info_hash_norm, COALESCE(f.file_index_norm, t.file_index_norm))
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
          COALESCE(f.matched_file_index, a.service_file_id, t.file_index) AS file_index,
          COALESCE(f.matched_file_index, a.service_file_id) AS matched_file_index,
          f.matched_file_title,
          COALESCE(f.matched_file_size, a.service_file_size) AS matched_file_size,
          t.cached_rd,
          t.rd_cache_state,
          t.rd_file_index,
          t.rd_file_size,
          t.last_cached_check,
          t.next_cached_check,
          t.cache_check_failures,
          COALESCE(a.cached, t.tb_cached) AS tb_cached,
          COALESCE(a.state, t.tb_cache_state) AS tb_cache_state,
          GREATEST(COALESCE(a.confidence, 0), COALESCE(t.tb_cache_confidence, 0)) AS tb_cache_confidence,
          COALESCE(NULLIF(a.match_reason, ''), t.tb_cache_match_reason) AS tb_cache_match_reason,
          COALESCE(a.next_check_at, t.tb_next_cached_check) AS tb_next_cached_check,
          GREATEST(COALESCE(a.failure_count, 0), COALESCE(t.tb_cache_check_failures, 0)) AS tb_cache_check_failures,
          COALESCE(a.service_file_id, t.tb_file_id) AS tb_file_id,
          COALESCE(a.service_file_size, t.tb_file_size) AS tb_file_size,
          CASE
            WHEN a.checked_at IS NULL THEN t.tb_last_cached_check
            WHEN t.tb_last_cached_check IS NULL THEN a.checked_at
            ELSE GREATEST(a.checked_at, t.tb_last_cached_check)
          END AS tb_last_cached_check
        FROM matched_files f
        JOIN torrents t
          ON t.info_hash_norm = f.info_hash_norm
        LEFT JOIN best_tb_authority a
          ON a.info_hash_norm = t.info_hash_norm
        ORDER BY
          t.info_hash_norm,
          COALESCE(f.file_index_norm, t.file_index_norm),
          CASE WHEN t.cached_rd IS TRUE THEN 1 ELSE 0 END DESC,
          CASE WHEN (COALESCE(a.state, t.tb_cache_state) = 'cached_verified' OR COALESCE(a.cached, t.tb_cached) IS TRUE) AND COALESCE(a.checked_at, t.tb_last_cached_check) >= NOW() - ($2::integer * INTERVAL '1 day') THEN 1 ELSE 0 END DESC,
          CASE WHEN f.source_rank = 0 THEN 1 ELSE 0 END DESC,
          CASE
            WHEN COALESCE(t.resolution, t.title) ~* '(4320p|8k)' THEN 5
            WHEN COALESCE(t.resolution, t.title) ~* '(2160p|4k|uhd)' THEN 4
            WHEN COALESCE(t.resolution, t.title) ~* '(1440p|2k|qhd)' THEN 3
            WHEN COALESCE(t.resolution, t.title) ~* '(1080p|1080i|fhd|full[-. ]?hd)' THEN 2
            WHEN COALESCE(t.resolution, t.title) ~* '(720p|hd)' THEN 1
            ELSE 0
          END DESC,
          GREATEST(COALESCE(t.seeders, 0), COALESCE(t.max_seeders, 0)) DESC,
          COALESCE(t.seen_count, 0) DESC,
          COALESCE(t.last_seen_at, t.updated_at, t.created_at) DESC NULLS LAST,
          COALESCE(f.matched_file_size, a.service_file_size, t.folder_size, t.size, 0) DESC
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

    if (updateRes.rowCount > 0) {
      await upsertTorrentItemAuthorityRow(client, torrent);
      await upsertProviderObservationAuthorityRow(client, torrent);
      return false;
    }

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

    await upsertTorrentItemAuthorityRow(client, torrent);
    await upsertProviderObservationAuthorityRow(client, torrent);
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

    if (sameIdentityUpdateRes.rowCount > 0) {
      await upsertMediaFileMapAuthorityRow(client, { ...mapping, match_source: 'legacy_files', is_exact: true });
      return false;
    }

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

    if (changedIdentityUpdateRes.rowCount > 0) {
      await upsertMediaFileMapAuthorityRow(client, { ...mapping, match_source: 'legacy_files', is_exact: true });
      return true;
    }

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

    await upsertMediaFileMapAuthorityRow(client, { ...mapping, match_source: 'legacy_files', is_exact: true });
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

    if (updateRes.rowCount > 0) {
      await upsertTorrentFileAuthorityRow(client, { ...file, source: 'legacy_pack_files' });
      await upsertMediaFileMapAuthorityRow(client, { ...file, info_hash: packHash, match_source: 'legacy_pack_files', is_exact: true });
      return false;
    }

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

    await upsertTorrentFileAuthorityRow(client, { ...file, source: 'legacy_pack_files' });
    await upsertMediaFileMapAuthorityRow(client, { ...file, info_hash: packHash, match_source: 'legacy_pack_files', is_exact: true });
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
    const direct = sanitizeText(item.externalPlayableUrl || item._torrentioPlayableUrl || item.directUrl || item.externalDirectUrl || item._externalDirectUrl || item.url).slice(0, 2048);
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
    const directUrl = sanitizeText(item.externalPlayableUrl || item._torrentioPlayableUrl || item.directUrl || item.externalDirectUrl || item._externalDirectUrl || item.url);
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
      const legacyRows = await withClient(async (client) => {
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
          cache_check_failures: toSafeNumber(row.cache_check_failures, 0),
          source: 'legacy_torrents'
        })).filter((row) => row.hash);
      });

      if (!DB_AUTHORITY_READ) return legacyRows;

      const authorityRows = await getDebridAuthorityByHashes(normalizedHashes, 'rd');
      if (authorityRows.length === 0) return legacyRows;

      const byHash = new Map(legacyRows.map((row) => [row.hash, row]));
      for (const authority of authorityRows) {
        if (!authority?.hash) continue;
        const legacyState = authority.state === 'cached_verified' ? 'cached' : (normalizeRdCacheState(authority.state) || 'unknown');
        const cached = authority.cached === true ? true : (authority.cached === false ? false : null);
        const current = byHash.get(authority.hash);
        const currentRank = current?.cached_rd === true || current?.rd_cache_state === 'cached' ? 4 : (current?.rd_cache_state === 'likely_cached' || current?.rd_cache_state === 'probing' ? 2 : 0);
        const authorityRank = authority.proof_level === 'episode_exact' ? 6 : authority.proof_level === 'file_exact' ? 5 : authority.state === 'cached_verified' ? 4 : authority.state === 'likely_cached' ? 2 : authority.state === 'uncached_terminal' ? 1 : 0;
        if (current && currentRank > authorityRank) continue;
        byHash.set(authority.hash, {
          hash: authority.hash,
          cached_rd: cached,
          rd_cache_state: legacyState,
          rd_file_index: authority.service_file_id,
          rd_file_size: authority.service_file_size,
          size: current?.size || authority.service_file_size || 0,
          last_cached_check: authority.checked_at || current?.last_cached_check || null,
          next_cached_check: authority.next_check_at || authority.expires_at || current?.next_cached_check || null,
          cache_check_failures: authority.failure_count || 0,
          proof_level: authority.proof_level,
          source: 'debrid_authority'
        });
      }

      return [...byHash.values()];
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
          fileTitle: sanitizeText(entry?.file_title || entry?.tb_file_title),
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

          await upsertDebridAuthorityRow(client, {
            service: 'rd',
            hash: row.hash,
            state: row.rd_cache_state,
            cached: row.cached,
            rd_file_index: row.rd_file_index,
            rd_file_size: row.rd_file_size,
            imdb_id: row.imdb_id,
            imdb_season: row.imdb_season,
            imdb_episode: row.imdb_episode,
            failures: row.failures,
            next_hours: row.next_hours || (row.permanent ? 24 * 365 : null),
            title: row.title,
            size: row.size,
            confidence: row.rd_cache_state === 'cached' ? 0.95 : 0.55,
            match_reason: 'rd_cache_status_update'
          });

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

  function getTbNextCheckHours(state, fallback = null) {
    const normalized = normalizeTbCacheState(state) || 'uncertain';
    const raw = fallback === null || fallback === undefined ? TB_STATE_RECHECK_HOURS[normalized] : Number(fallback);
    const hours = Number.isFinite(raw) ? raw : TB_STATE_RECHECK_HOURS.uncertain;
    return Math.max(0.05, Math.min(24 * 30, hours));
  }

  async function updateTbCacheStatus(updates) {
    if (!getPool() || !Array.isArray(updates) || updates.length === 0) return 0;
    await awaitDatabaseOptimizations();

    const rows = updates
      .map((entry) => {
        const identity = normalizeEpisodeIdentity(entry);
        const state = normalizeTbCacheState(entry?.tb_cache_state || entry?.cache_state || entry?.state || (entry?.cached === true ? 'cached_verified' : (entry?.cached === false ? 'uncached' : null)));
        const cached = deriveTbCachedBooleanFromState(state, typeof entry?.cached === 'boolean' ? entry.cached : null);
        const failures = state === 'error' ? Math.max(1, toSafeNumber(entry?.failures ?? entry?.cache_check_failures, 1)) : 0;
        return {
          hash: normalizeInfoHash(entry?.hash),
          cached,
          tb_cache_state: state,
          tb_cache_rd_state: mapTbStateToRdState(state),
          tb_cache_confidence: Math.max(0, Math.min(1, toSafeNumber(entry?.confidence ?? entry?.tb_cache_confidence, 0))),
          tb_cache_match_reason: sanitizeText(entry?.match_reason || entry?.tb_cache_match_reason).slice(0, 160),
          fileId: normalizeFileIndex(entry?.tb_file_id ?? entry?.file_id),
          fileSize: entry?.tb_file_size === null || entry?.tb_file_size === undefined
            ? (entry?.file_size === null || entry?.file_size === undefined ? null : toSafeNumber(entry?.file_size, 0))
            : toSafeNumber(entry?.tb_file_size, 0),
          title: sanitizeText(entry?.torrent_title || entry?.title),
          size: Math.max(0, toSafeNumber(entry?.size, 0)),
          imdb_id: identity.imdbId,
          imdb_season: identity.imdbSeason,
          imdb_episode: identity.imdbEpisode,
          episode_scoped: identity.isEpisode,
          failures,
          next_hours: getTbNextCheckHours(state, entry?.next_hours)
        };
      })
      .filter((entry) => entry.hash);

    if (rows.length === 0) return 0;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await runInTransaction(async (client) => {

        let updated = 0;

        for (const row of rows) {
          if (row.episode_scoped && Number.isInteger(row.fileId) && row.fileId >= 0 && row.tb_cache_state === 'cached_verified') {
            await upsertEpisodeScopedOverrideRow(client, {
              hash: row.hash,
              imdb_id: row.imdb_id,
              imdb_season: row.imdb_season,
              imdb_episode: row.imdb_episode,
              tb_file_id: row.fileId,
              tb_file_size: row.fileSize
            });
          } else if (row.episode_scoped && row.tb_cache_state === 'uncached') {
            await clearEpisodeScopedTbOverrideRow(client, {
              hash: row.hash,
              imdb_id: row.imdb_id,
              imdb_season: row.imdb_season,
              imdb_episode: row.imdb_episode
            });
          }

          const globalFileId = row.episode_scoped ? null : row.fileId;
          const globalFileSize = row.episode_scoped ? null : row.fileSize;

          await upsertDebridAuthorityRow(client, {
            service: 'tb',
            hash: row.hash,
            state: row.tb_cache_state,
            cached: row.cached,
            tb_file_id: row.fileId,
            tb_file_size: row.fileSize,
            imdb_id: row.imdb_id,
            imdb_season: row.imdb_season,
            imdb_episode: row.imdb_episode,
            failures: row.failures,
            next_hours: row.next_hours,
            title: row.title,
            size: row.size,
            confidence: row.tb_cache_confidence,
            match_reason: row.tb_cache_match_reason || 'tb_cache_status_update',
            payload: {
              file_title: row.fileTitle || null,
              file_size: row.fileSize || null,
              torrent_title: row.title || null
            }
          });

          const result = await client.query(
            `
              UPDATE torrents
              SET tb_cache_state = CASE
                    WHEN $3::text IS NULL OR $3::text = '' THEN tb_cache_state
                    ELSE $3::text
                  END,
                  tb_cached = CASE
                    WHEN $3::text = 'cached_verified' THEN TRUE
                    WHEN $3::text = 'uncached' THEN FALSE
                    WHEN $3::text IN ('likely_cached', 'uncertain', 'queued', 'error') THEN NULL
                    WHEN $2::boolean IS NULL THEN tb_cached
                    ELSE $2::boolean
                  END,
                  tb_cache_confidence = CASE
                    WHEN $4::numeric IS NULL THEN tb_cache_confidence
                    ELSE $4::numeric
                  END,
                  tb_cache_match_reason = CASE
                    WHEN $5::text = '' THEN tb_cache_match_reason
                    ELSE $5::text
                  END,
                  tb_cache_check_failures = GREATEST(0, COALESCE($10::integer, 0)),
                  tb_next_cached_check = NOW() + make_interval(secs => GREATEST(60, CEIL(COALESCE($11::numeric, 1) * 3600)::integer)),
                  tb_file_id = CASE
                    WHEN $3::text = 'uncached' THEN NULL
                    WHEN $6::integer IS NULL OR $6::integer < 0 THEN tb_file_id
                    ELSE $6::integer
                  END,
                  tb_file_size = CASE
                    WHEN $3::text = 'uncached' THEN NULL
                    WHEN $7::bigint IS NULL OR $7::bigint <= 0 THEN tb_file_size
                    ELSE $7::bigint
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
                  tb_last_cached_check = NOW(),
                  updated_at = NOW()
              WHERE info_hash_norm = $1
            `,
            [
              row.hash,
              row.cached,
              row.tb_cache_state,
              row.tb_cache_confidence,
              row.tb_cache_match_reason,
              globalFileId,
              globalFileSize,
              row.title,
              row.size,
              row.failures,
              row.next_hours
            ]
          );
          updated += Number(result.rowCount || 0);
        }

        return updated;
      });
      } catch (error) {
        const isDeadlock = error?.code === '40P01' || /deadlock detected/i.test(String(error?.message || ''));
        if (isDeadlock && attempt < maxAttempts) {
          const delayMs = 75 * attempt;
          console.warn(`⚠️ DB Deadlock updateTbCacheStatus: retry ${attempt}/${maxAttempts} tra ${delayMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        console.error(`❌ DB Error updateTbCacheStatus: ${error.message}`);
        return 0;
      }
    }
    return 0;
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
          if (row.infoHash) {
            await upsertProviderObservationAuthorityRow(client, {
              info_hash: row.infoHash,
              file_index: row.fileIndex,
              provider: row.provider,
              title: row.title,
              quality: row.quality,
              languages: row.languages,
              seeders: row.seeders,
              size: row.size
            }, {
              providerGroup: row.addonGroup,
              addonName: row.addon,
              sourcePriority: 30,
              payload: row.payload
            });
            await upsertMediaFileMapAuthorityRow(client, {
              info_hash: row.infoHash,
              file_index: row.fileIndex,
              imdb_id: row.imdbId,
              imdb_season: row.season,
              imdb_episode: row.episode,
              media_type: row.type,
              match_source: `external_snapshot:${row.addonGroup || row.addon || 'external'}`,
              match_confidence: 0.70,
              match_reason: 'external stream snapshot',
              is_exact: Boolean(row.season && row.episode && row.fileIndexNorm >= 0)
            });
          }
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
          COUNT(*) FILTER (WHERE cached IS TRUE OR state IN ('cached', 'cached_verified'))::bigint AS cached,
          COUNT(*) FILTER (WHERE state = 'likely_cached')::bigint AS likely_cached,
          COUNT(*) FILTER (WHERE state IN ('probing', 'uncertain', 'queued'))::bigint AS probing,
          COUNT(*) FILTER (WHERE cached IS FALSE OR state IN ('uncached_terminal', 'uncached'))::bigint AS uncached_terminal,
          COUNT(*) FILTER (WHERE state = 'error')::bigint AS error,
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
          state: normalizeRdCacheState(payload.state) || normalizeTbCacheState(payload.state),
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
          await upsertDebridAuthorityRow(client, {
            service: row.service,
            hash: row.hash,
            file_index: row.fileIndex,
            media_id: row.mediaId,
            imdb_id: row.imdbId,
            imdb_season: row.imdbSeason,
            imdb_episode: row.imdbEpisode,
            state: row.state,
            cached: row.cached,
            proof_level: row.proofLevel || 'availability_cache',
            confidence: row.proofLevel === 'episode_exact' || row.proofLevel === 'file_exact' ? 0.95 : (row.cached === true ? 0.75 : 0.50),
            expires_at: row.expiresAt,
            next_check_at: row.expiresAt,
            payload: row.payload,
            match_reason: 'availability_cache'
          });
          updated += Number(result.rowCount || 0);
        }
        return updated;
      });
    } catch (error) {
      console.error(`❌ DB Error setDebridAvailabilityCache: ${error.message}`);
      return 0;
    }
  }


  function normalizeResolvedLinkPayload(entry = {}) {
    const cacheKey = sanitizeText(entry.cache_key || entry.cacheKey || entry.key).slice(0, 512);
    const service = sanitizeText(entry.service || '').toLowerCase().slice(0, 16);
    const url = sanitizeText(entry.url || entry.rawUrl || entry.raw_url || '').trim();
    const ttlSeconds = clampInt(entry.ttlSeconds || entry.ttl || 0, 0, 0, 24 * 60 * 60);
    if (!cacheKey || !service || !url || ttlSeconds <= 0) return null;
    return {
      cacheKey,
      service,
      tokenFp: sanitizeText(entry.token_fp || entry.tokenFp || '').slice(0, 80) || null,
      torrentId: sanitizeText(entry.torrent_id || entry.torrentId || '').slice(0, 96) || null,
      fileId: toNullableInt(entry.file_id ?? entry.fileId),
      hash: normalizeInfoHash(entry.info_hash || entry.infoHash || entry.hash || entry.info_hash_norm || entry.infoHashNorm),
      mediaId: sanitizeText(entry.media_id || entry.mediaId || '').slice(0, 220) || null,
      url,
      filename: sanitizeText(entry.filename || entry.fileName || '').slice(0, 512) || null,
      fileSize: toNullableInt(entry.file_size ?? entry.fileSize ?? entry.size),
      payload: entry.payload && typeof entry.payload === 'object' ? entry.payload : { ...entry, url },
      expiresAt: new Date(Date.now() + ttlSeconds * 1000)
    };
  }

  async function getDebridResolvedLinkCache(cacheKey) {
    const pool = getPool();
    if (!pool) return null;
    await awaitDatabaseOptimizations();
    const key = sanitizeText(cacheKey).slice(0, 512);
    if (!key) return null;
    try {
      const result = await pool.query(
        `
          UPDATE debrid_resolved_link_cache
          SET hit_count = COALESCE(hit_count, 0) + 1, updated_at = NOW()
          WHERE cache_key = $1
            AND expires_at > NOW()
          RETURNING cache_key, service, token_fp, torrent_id, file_id, info_hash_norm, media_id, url, filename, file_size, payload_json, expires_at
        `,
        [key]
      );
      const row = result.rows?.[0];
      if (!row) return null;
      return {
        ...(row.payload_json && typeof row.payload_json === 'object' ? row.payload_json : {}),
        cache_key: row.cache_key,
        service: row.service,
        token_fp: row.token_fp,
        torrent_id: row.torrent_id,
        file_id: row.file_id,
        tb_file_id: row.service === 'tb' ? row.file_id : undefined,
        info_hash_norm: row.info_hash_norm,
        media_id: row.media_id,
        url: row.url,
        rawUrl: row.url,
        filename: row.filename,
        file_size: row.file_size,
        expires_at: row.expires_at
      };
    } catch (error) {
      console.error(`❌ DB Error getDebridResolvedLinkCache: ${error.message}`);
      return null;
    }
  }

  async function setDebridResolvedLinkCache(entry) {
    const pool = getPool();
    if (!pool) return 0;
    await awaitDatabaseOptimizations();
    const row = normalizeResolvedLinkPayload(entry);
    if (!row) return 0;
    try {
      const result = await pool.query(
        `
          INSERT INTO debrid_resolved_link_cache (
            cache_key, service, token_fp, torrent_id, file_id, info_hash_norm, media_id, url, filename, file_size, payload_json, expires_at, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, NOW(), NOW())
          ON CONFLICT (cache_key) DO UPDATE SET
            service = EXCLUDED.service,
            token_fp = EXCLUDED.token_fp,
            torrent_id = EXCLUDED.torrent_id,
            file_id = EXCLUDED.file_id,
            info_hash_norm = EXCLUDED.info_hash_norm,
            media_id = EXCLUDED.media_id,
            url = EXCLUDED.url,
            filename = EXCLUDED.filename,
            file_size = EXCLUDED.file_size,
            payload_json = EXCLUDED.payload_json,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
        `,
        [
          row.cacheKey,
          row.service,
          row.tokenFp,
          row.torrentId,
          row.fileId,
          row.hash,
          row.mediaId,
          row.url,
          row.filename,
          row.fileSize,
          JSON.stringify(row.payload),
          row.expiresAt
        ]
      );
      return Number(result.rowCount || 0);
    } catch (error) {
      console.error(`❌ DB Error setDebridResolvedLinkCache: ${error.message}`);
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
    getDebridResolvedLinkCache,
    setDebridResolvedLinkCache,
    isDebridCacheCheckMarked,
    markDebridCacheCheckDone,
    upsertDebridAuthorityRows,
    getDebridAuthorityByHashes,
    enqueueDebridChecks,
    getDueDebridJobs,
    markDebridJobDone
  };
}

module.exports = {
  createTorrentRepository
};
