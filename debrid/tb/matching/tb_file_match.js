const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|iso|m4v|ts|m2ts|mpg|mpeg)$/i;
const JUNK_PATTERN = /\b(sample|trailer|promo|preview|screens?|proof|nfo|cover|poster|thumb|trailerfix)\b/i;
const EXTRA_PATTERN = /\b(ova|oad|special|extras?|featurette|intervista|interview|behind\s*the\s*scenes|making\s*of|recap|riassunto|ncop|nced|creditless|ost|soundtrack)\b/i;

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function safeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeNum(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeName(value) {
  return lower(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\[\](){}]/g, ' ')
    .replace(/[_+.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getFileName(file) {
  return String(file?.name || file?.short_name || file?.filename || file?.path || '');
}

function getFileId(file) {
  const raw = file?.id ?? file?.file_id ?? file?.fileId ?? null;
  const parsed = safeInt(raw, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFileSize(file) {
  return Math.max(0, safeNum(file?.size ?? file?.bytes ?? file?.file_size, 0));
}

function getFileById(files, targetId) {
  const normalizedId = safeInt(targetId, NaN);
  if (!Number.isFinite(normalizedId) || normalizedId < 0) return null;
  return (Array.isArray(files) ? files : []).find((file) => getFileId(file) === normalizedId) || null;
}

function isVideoFile(file, options = {}) {
  const name = getFileName(file);
  const minVideoSize = Math.max(0, safeNum(options.minVideoSize, 0));
  return VIDEO_EXTENSIONS.test(name) && !JUNK_PATTERN.test(name) && getFileSize(file) >= minVideoSize;
}

function isExtraFile(file) {
  return EXTRA_PATTERN.test(getFileName(file));
}

function getVideoFiles(files, options = {}) {
  return (Array.isArray(files) ? files : []).filter((file) => isVideoFile(file, options) && !isExtraFile(file));
}

function isSeasonPackName(name, season) {
  if (!season) return false;
  return new RegExp(`\\bseason\\s*0*${season}\\b|\\bcomplete\\b|\\bpack\\b|\\b全集\\b|\\bcollection\\b|\\bintegrale\\b|\\bstagione\\s*0*${season}\\b`, 'i').test(name);
}

function parseEpisodeRange(name) {
  const patterns = [
    /\bE?(\d{1,3})\s*[-~]\s*E?(\d{1,3})\b/i,
    /\b(?:episodes?|eps?)\s*(\d{1,3})\s*[-~]\s*(\d{1,3})\b/i
  ];
  for (const pattern of patterns) {
    const match = name.match(pattern);
    if (!match) continue;
    const start = safeInt(match[1], 0);
    const end = safeInt(match[2], 0);
    if (start > 0 && end >= start) return { start, end };
  }
  return null;
}

function buildEpisodeRegexes(season, episode) {
  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const e2 = String(e).padStart(2, '0');
  return [
    { score: 1600, regex: new RegExp(`\\bS(?:eason)?\\s*0*${s}\\s*[-_. ]*E(?:pisode)?\\s*0*${e}\\b`, 'i') },
    { score: 1550, regex: new RegExp(`\\b0*${s}x0*${e}\\b`, 'i') },
    { score: 1500, regex: new RegExp(`\\bS0*${s}[^a-z0-9]{0,4}E0*${e}\\b`, 'i') },
    { score: 1380, regex: new RegExp(`(^|\\D)${s}${e2}(\\D|$)`, 'i') },
    { score: 1320, regex: new RegExp(`\\bepisode\\s*0*${e}\\b|\\bep\\s*0*${e}\\b`, 'i') },
    { score: 980, regex: new RegExp(`(?:^|[\\s._\\-\\[\\]()])0*${e}(?:$|[\\s._\\-\\]\\[()])`, 'i') }
  ];
}

function parseExplicitEpisodeHints(name) {
  const hints = new Set();
  const patterns = [
    /\bS(?:eason)?\s*0*(\d{1,2})\s*[-_. ]*E(?:pisode)?\s*0*(\d{1,3})\b/gi,
    /\b(\d{1,2})x(\d{1,3})\b/gi,
    /\b(?:episode|ep)\s*0*(\d{1,3})\b/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(name)) !== null) {
      const season = match.length >= 3 ? safeInt(match[1], 0) : 0;
      const episode = safeInt(match[match.length - 1], 0);
      if (episode > 0) hints.add(`${season}:${episode}`);
    }
  }
  return hints;
}

function hasConflictingExplicitEpisode(name, season, episode) {
  const hints = parseExplicitEpisodeHints(name);
  if (hints.size === 0) return false;
  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  if (hints.has(`${s}:${e}`) || hints.has(`0:${e}`)) return false;
  for (const hint of hints) {
    const [hintSeason, hintEpisode] = hint.split(':').map((v) => safeInt(v, 0));
    if (hintSeason === 0 && hintEpisode === e) return false;
    if (hintSeason === s && hintEpisode === e) return false;
  }
  return true;
}

function buildMovieScore(file) {
  const name = normalizeName(getFileName(file));
  const size = getFileSize(file);
  let score = 0;
  if (isVideoFile(file)) score += 400;
  score += Math.min(size / (1024 * 1024 * 40), 180);
  if (isExtraFile(file)) score -= 300;
  if (/\b(sample|trailer|extras?|featurette|making of)\b/i.test(name)) score -= 350;
  if (/\b(2160p|1080p|720p|bluray|bdrip|web[- ]?dl|webrip|remux)\b/i.test(name)) score += 25;
  return score;
}

function buildEpisodeScore(file, season, episode) {
  const rawName = getFileName(file);
  const name = normalizeName(rawName);
  const size = getFileSize(file);
  let score = 0;
  if (!isVideoFile(file)) return -Infinity;
  if (isExtraFile(file)) return -Infinity;
  if (hasConflictingExplicitEpisode(rawName, season, episode)) return -Infinity;
  score += 300;
  score += Math.min(size / (1024 * 1024 * 50), 150);
  let matched = false;
  for (const { score: bonus, regex } of buildEpisodeRegexes(season, episode)) {
    if (regex.test(rawName) || regex.test(name)) {
      score += bonus;
      matched = true;
      break;
    }
  }
  const range = parseEpisodeRange(rawName) || parseEpisodeRange(name);
  const targetEpisode = safeInt(episode, 0);
  if (range) score += targetEpisode >= range.start && targetEpisode <= range.end ? -260 : -800;
  if (!matched && isSeasonPackName(name, season)) score -= 260;
  if (/\b(batch|multi|全集|complete|collection|pack)\b/i.test(name)) score -= 180;
  if (/\b(2160p|1080p|720p|bluray|bdrip|web[- ]?dl|webrip|remux)\b/i.test(name)) score += 20;
  return score;
}

function resolveForcedFileId(files, forcedFileIdx, season = 0, episode = 0) {
  if (forcedFileIdx == null) return null;
  const raw = safeInt(forcedFileIdx, NaN);
  if (!Number.isFinite(raw) || raw < 0) return null;
  const list = Array.isArray(files) ? files : [];
  const byId = list.find((file) => getFileId(file) === raw);
  const selected = byId || (raw < list.length ? list[raw] : null);
  if (!selected) return null;
  if (season > 0 && episode > 0 && hasConflictingExplicitEpisode(getFileName(selected), season, episode)) return null;
  return getFileId(selected);
}

function rankCandidateFiles(files, season, episode, options = {}) {
  const list = Array.isArray(files) ? files.slice() : [];
  if (list.length === 0) return [];
  const videoFiles = getVideoFiles(list, options);
  const candidates = videoFiles.length > 0 ? videoFiles : list;
  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const isMovie = s <= 0 && e <= 0;
  return candidates
    .map((file) => ({ file, score: isMovie ? buildMovieScore(file) : buildEpisodeScore(file, s, e), size: getFileSize(file) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => (b.score - a.score) || (b.size - a.size));
}

function chooseBestFile(files, season, episode, options = {}) {
  return rankCandidateFiles(files, season, episode, options)[0]?.file || null;
}

function confidenceForRankedMatch(ranked, isSeries) {
  const best = ranked[0] || null;
  if (!best) return 0;
  if (!isSeries) return ranked.length === 1 ? 1 : 0.82;
  if (best.score >= 1500) return 1;
  if (best.score >= 1320) return 0.95;
  if (best.score >= 980) return ranked.length === 1 ? 0.88 : 0.72;
  return ranked.length === 1 ? 0.55 : 0.25;
}

function matchFileDetailed(files, season, episode, forcedFileIdx = null, options = {}) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return { fileId: null, file: null, confidence: 0, reason: 'no_files', score: -Infinity, proofLevel: 'none' };
  const s = safeInt(season, 0);
  const e = safeInt(episode, 0);
  const isSeries = s > 0 && e > 0;
  const forced = resolveForcedFileId(list, forcedFileIdx, s, e);
  if (forced != null) {
    const forcedFile = getFileById(list, forced);
    return { fileId: forced, file: forcedFile, confidence: 1, reason: 'forced_file_id', score: Infinity, proofLevel: isSeries ? 'episode_exact' : 'file_exact' };
  }
  const ranked = rankCandidateFiles(list, s, e, options);
  const selected = ranked[0]?.file || null;
  const confidence = confidenceForRankedMatch(ranked, isSeries);
  if (selected && (!isSeries || confidence >= 0.75)) {
    return { fileId: getFileId(selected), file: selected, confidence, reason: isSeries ? 'file_match_confident' : 'movie_file_match', score: ranked[0].score, proofLevel: isSeries ? 'episode_exact' : 'file_exact' };
  }
  if (isSeries) {
    const videos = getVideoFiles(list, options);
    if (videos.length === 1 && !hasConflictingExplicitEpisode(getFileName(videos[0]), s, e)) {
      return { fileId: getFileId(videos[0]), file: videos[0], confidence: 0.62, reason: 'single_video_uncertain', score: ranked[0]?.score ?? 0, proofLevel: 'file_list' };
    }
    return { fileId: null, file: null, confidence, reason: 'no_confident_episode_file', score: ranked[0]?.score ?? -Infinity, proofLevel: 'file_list' };
  }
  if (selected) return { fileId: getFileId(selected), file: selected, confidence, reason: 'movie_file_match', score: ranked[0].score, proofLevel: 'file_exact' };
  return { fileId: null, file: null, confidence: 0, reason: 'no_video_file', score: -Infinity, proofLevel: 'none' };
}

function matchFile(files, season, episode, forcedFileIdx = null, options = {}) {
  return matchFileDetailed(files, season, episode, forcedFileIdx, options).fileId;
}

function matchTorboxFile(files, meta = {}, options = {}) {
  const season = safeInt(meta?.season ?? meta?.s, 0);
  const episode = safeInt(meta?.episode ?? meta?.e, 0);
  const forcedFileIdx = meta?.forcedFileIdx ?? meta?.fileIdx ?? meta?.file_id ?? meta?.fileId ?? null;
  return matchFileDetailed(files, season, episode, forcedFileIdx, options);
}

module.exports = {
  VIDEO_EXTENSIONS,
  JUNK_PATTERN,
  EXTRA_PATTERN,
  getFileName,
  getFileId,
  getFileSize,
  getFileById,
  isVideoFile,
  isExtraFile,
  getVideoFiles,
  hasConflictingExplicitEpisode,
  rankCandidateFiles,
  chooseBestFile,
  matchFile,
  matchFileDetailed,
  matchTorboxFile
};
