const {
  REGEX_YEAR,
  REGEX_QUALITY_FILTER,
  REGEX_STRONG_ITA,
  REGEX_MULTI_ITA,
  REGEX_TRUSTED_GROUPS,
  REGEX_SUB_ONLY,
  REGEX_AUDIO_CONFIRM,
  parseTitleDetails,
  normalizeSearchText,
  getLanguageInfo,
  isSeasonPack,
  isTrustedSource
} = require("../utils/text");
const { detectSourceConsensus, evaluateLeviathanScore } = require('../ranking/score_profile');
const { shouldKeepStrictItalianCandidate, hasStrictItalianEvidence } = require('../canonical/language_guard');

const REGEX_SCENE_RELEASE = /\b(?:web[-.\s]?dl|webrip|blu[-.\s]?ray|bd[-.\s]?rip|remux|uhd|hevc|x265|x264|ddp|truehd|dts|atmos|hdr|dv|dolby[\s.-]?vision)\b/i;
const REGEX_HEVC = /\b(?:x265|h265|hevc)\b/i;
const REGEX_HDR = /\b(?:hdr|hdr10\+?|dolby[\s.-]?vision|\bdv\b)\b/i;
const REGEX_CAM = /\b(?:cam|hdcam|ts|telesync|telecine|camrip|screener|scr|dvdscr|bdscr)\b/i;
const REGEX_PACK = /\b(?:pack|complete|completa|full ?season|season ?pack|stagione ?(?:completa|complete)?|serie completa|collection|integrale)\b/i;
const REGEX_SERIES_MARKER = /\b(?:S\d{2}|SEASON|STAGIONE|\d+x\d+)\b/i;
const REGEX_EXPLICIT_ENG = /\b(?:ENG|ENGLISH|TRUE\s*ENGLISH|AUDIO\s*ENG|ENG\s*(?:AC3|AAC|DDP|DTS|TRUEHD)|ENG(?:LISH)?\s*ONLY|DUBBED\s*ENG)\b/i;
const REGEX_EXPLICIT_OTHER = /\b(?:FRENCH|GERMAN|SPANISH|ESP|LATINO|RUS|RUSSIAN|JPN|JAP|VOSTFR|POLISH|PORTUGUESE|PT-BR|HINDI|KOREAN|CHINESE|ARABIC|TURKISH)\b/i;
const REGEX_EXPLICIT_MULTI = /\b(?:MULTI|MULTILANG(?:UAGE)?|DUAL[\s.-]?AUDIO)\b/i;
const REGEX_TITLE_PUNCTUATION = /[\[\]{}()]/g;
const REGEX_TITLE_SPACING = /[._:+\-]+/g;
const REGEX_TITLE_NOISE = /\b(?:2160p|1080p|720p|480p|x264|x265|h264|h265|hevc|hdr10\+?|hdr|dv|dolby\s*vision|web[- ]?dl|webrip|bluray|brrip|dvdrip|remux|proper|repack|nf|amzn|dsnp|atvp|ita|italian|italiano|multi|dual|audio|sub|subs|subbed|vostfr|subita)\b/g;
const SOURCE_CONSENSUS_BONUS = Object.freeze({
  strong_consensus: 9000,
  consensus: 5500,
  mirror: 2500,
  none: 0
});

const DEFAULT_PROFILES = {
  stream: {
    minimalSizeBytes: 150 * 1024 * 1024,
    weights: {
      quality4K: 50000,
      quality1080p: 25000,
      quality720p: 15000,
      qualitySD: 5000,
      languageIta: 42000,
      languageMaybeIta: 14000,
      languageEng: 36000,
      languageMulti: 26000,
      languageNeutral: 12000,
      languageOtherPenalty: -35000,
      languageItaPenaltyInEng: -50000,
      languageMultiPenaltyInEng: -18000,
      audioConfirm: 9000,
      strongIta: 5000,
      multiIta: 3000,
      trustedGroup: 2500,
      trustedSource: 2000,
      sceneRelease: 3000,
      hevcBonus: 1800,
      hdrBonus: 1800,
      exactEpisodeBoost: 12000,
      seasonPackBonus: 5000,
      packBonus: 1200,
      wrongEpisodePenalty: -10000,
      wrongSeasonPenalty: -12000,
      subtitleOnlyPenalty: -9000,
      titleMismatchPenalty: -6000,
      yearMismatchPenalty: -4000,
      exactYearBonus: 1500,
      camPenalty: -30000,
      fileIdxBonus: 3500,
      seedersFactor: 18,
      sizeBucketBytes: 700 * 1024 * 1024,
      sizeFactorCap: 1200,
      titleLengthCap: 300,
      titleSimilarityFactor: 12000,
      tbCachedBonus: 9000,
      seriesOnMoviePenalty: -9000
    }
  },
  dedupe: {
    minimalSizeBytes: 0,
    weights: {
      quality4K: 9000,
      quality1080p: 7000,
      quality720p: 5000,
      qualitySD: 1000,
      languageIta: 16000,
      languageMaybeIta: 6000,
      languageEng: 12000,
      languageMulti: 8000,
      languageNeutral: 3000,
      languageOtherPenalty: -12000,
      languageItaPenaltyInEng: -18000,
      languageMultiPenaltyInEng: -7000,
      audioConfirm: 5000,
      strongIta: 3000,
      multiIta: 2000,
      trustedGroup: 2000,
      trustedSource: 1500,
      sceneRelease: 2200,
      hevcBonus: 0,
      hdrBonus: 0,
      exactEpisodeBoost: 2800,
      seasonPackBonus: 3500,
      packBonus: 1800,
      wrongEpisodePenalty: -7000,
      wrongSeasonPenalty: -7000,
      subtitleOnlyPenalty: -6000,
      titleMismatchPenalty: 0,
      yearMismatchPenalty: 0,
      exactYearBonus: 500,
      camPenalty: -12000,
      fileIdxBonus: 4500,
      seedersFactor: 12,
      sizeBucketBytes: 512 * 1024 * 1024,
      sizeFactorCap: 800,
      titleLengthCap: 400,
      titleSimilarityFactor: 4000,
      tbCachedBonus: 6000,
      seriesOnMoviePenalty: -18000
    }
  }
};

const DEFAULT_CONFIG = {
  profile: "stream",
  sortMode: "balanced",
  keepByLanguage: true,
  profiles: DEFAULT_PROFILES
};

function normalizeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const cleaned = value
      .replace(/[^\d.,-]/g, "")
      .replace(/(\d)[,](\d{3})(?!\d)/g, "$1$2")
      .replace(",", ".");
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseSizeToBytes(value) {
  if (!value) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);

  const normalized = raw.replace(/\s+/g, " ");
  const match = normalized.match(/([\d.,]+)\s*(B|BYTE|BYTES|KB|KIB|MB|MIB|GB|GIB|TB|TIB)/i);
  if (!match) return 0;

  const amountText = match[1].includes(",") && match[1].includes(".")
    ? match[1].replace(/,/g, "")
    : match[1].replace(",", ".");
  const amount = parseFloat(amountText);
  if (!Number.isFinite(amount)) return 0;

  const multipliers = {
    B: 1,
    BYTE: 1,
    BYTES: 1,
    KB: 1024,
    KIB: 1024,
    MB: 1024 ** 2,
    MIB: 1024 ** 2,
    GB: 1024 ** 3,
    GIB: 1024 ** 3,
    TB: 1024 ** 4,
    TIB: 1024 ** 4
  };

  return Math.round(amount * (multipliers[match[2].toUpperCase()] || 1));
}

function normalizeText(value) {
  return String(value || "").trim();
}

function lowerText(value) {
  return normalizeText(value).toLowerCase();
}

function stripAccents(value) {
  return normalizeText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeLooseTitle(value) {
  return stripAccents(value)
    .toLowerCase()
    .replace(REGEX_TITLE_PUNCTUATION, " ")
    .replace(REGEX_TITLE_SPACING, " ")
    .replace(REGEX_TITLE_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeTitle(value) {
  const normalized = normalizeLooseTitle(value);
  if (!normalized) return [];
  return normalized.split(" ").filter((token) => token.length >= 2);
}

function mergeProfile(baseProfile, overrideProfile = {}) {
  return {
    ...baseProfile,
    ...overrideProfile,
    weights: {
      ...(baseProfile.weights || {}),
      ...(overrideProfile.weights || {})
    }
  };
}

function buildPreparedConfig(input = {}) {
  if (input && input.__rankingPrepared) return input;

  const ranking = input && typeof input.ranking === "object" ? input.ranking : {};
  const rawSortMode = String(ranking.sortMode || input.sortMode || input.sort || input.filters?.sortMode || input.filters?.sortBy || input.filters?.sort || DEFAULT_CONFIG.sortMode).trim().toLowerCase();
  const sortMode = ['resolution', 'res', 'quality', 'qualita', 'qualità', 'risoluzione'].includes(rawSortMode)
    ? 'resolution'
    : (['size', 'bitrate', 'peso'].includes(rawSortMode) ? 'size' : 'balanced');
  const config = {
    __rankingPrepared: true,
    profile: ranking.profile || input.profile || DEFAULT_CONFIG.profile,
    sortMode,
    keepByLanguage: ranking.keepByLanguage ?? input.keepByLanguage ?? DEFAULT_CONFIG.keepByLanguage,
    profiles: {
      stream: mergeProfile(DEFAULT_PROFILES.stream, ranking.profiles?.stream || input.profiles?.stream),
      dedupe: mergeProfile(DEFAULT_PROFILES.dedupe, ranking.profiles?.dedupe || input.profiles?.dedupe)
    }
  };

  const directProfileOverride = ranking.profileConfig || input.profileConfig;
  if (directProfileOverride && typeof directProfileOverride === "object") {
    const targetProfile = config.profile === "dedupe" ? "dedupe" : "stream";
    config.profiles[targetProfile] = mergeProfile(config.profiles[targetProfile], directProfileOverride);
  }

  return config;
}

function resolveProfileName(configInput = {}) {
  const config = buildPreparedConfig(configInput);
  return config.profile === "dedupe" ? "dedupe" : "stream";
}

function getProfileConfig(configInput = {}) {
  const config = buildPreparedConfig(configInput);
  const profileName = resolveProfileName(config);
  return {
    config,
    profileName,
    profile: config.profiles[profileName] || DEFAULT_PROFILES.stream
  };
}

function isAnimeMeta(meta = {}) {
  return Boolean(meta?.kitsu_id || meta?.isAnime);
}


function hasExplicitSeasonMarker(text = '') {
  return /\b(?:S(?:EASON)?\s*0?\d{1,2}|\d{1,2}x\d{1,3}|STAGIONE\s*0?\d{1,2}|(?:1ST|2ND|3RD|4TH)\s+SEASON)\b/i.test(String(text || ""));
}

function shouldIgnoreAnimeSeason(meta = {}, title = '') {
  return isAnimeMeta(meta) && !hasExplicitSeasonMarker(title);
}

function extractEpisodeContext(title, defaultSeason = 1, options = {}) {
  const safeTitle = normalizeText(title);
  let match = safeTitle.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

  match = safeTitle.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

  match = safeTitle.match(/\bE(?:P(?:ISODE)?)?\s*0?(\d{1,3})\b/i);
  if (match) return { season: defaultSeason, episode: parseInt(match[1], 10) };

  if (options?.anime) {
    match = safeTitle.match(/\bS(?:EASON)?\s*0?(\d{1,2})\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = safeTitle.match(/\b(\d{1,2})(?:ST|ND|RD|TH)\s+SEASON\s*[-._ ]+\s*0?(\d{1,4})(?:v\d+)?\b/i);
    if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };

    match = safeTitle.match(/\b(?:EP(?:ISODE)?|EPISODIO)\s*0?(\d{1,4})(?:v\d+)?\b/i);
    if (match) return { season: defaultSeason, episode: parseInt(match[1], 10) };

    const genericPattern = /(?:^|[\s._\-\[\(])0*([1-9]\d{0,3})(?:v\d+)?(?=$|[\s._\-\]\)])/ig;
    for (const candidate of safeTitle.matchAll(genericPattern)) {
      const episode = parseInt(candidate[1], 10);
      if (!Number.isInteger(episode) || episode <= 0) continue;
      if (episode >= 1900 && episode <= 2100) continue;
      return { season: defaultSeason, episode };
    }
  }

  return null;
}

function detectQuality(value) {
    const text = typeof value === "object" && value !== null
        ? [value.title, value.name, value.description, value.quality, value.resolution].map(normalizeText).filter(Boolean).join(" ")
        : normalizeText(value);

    const parsed = typeof value === "object" && value !== null && value._releaseDetails
        ? value._releaseDetails
        : parseTitleDetails(text);
    const parsedQuality = normalizeText(parsed?.quality || parsed?.qualityLabel);
    if (/^(?:4k|2160p|uhd)$/i.test(parsedQuality) || /\b4K\b/i.test(parsedQuality)) return "4K";
    if (/1080/i.test(parsedQuality)) return "1080p";
    if (/720/i.test(parsedQuality)) return "720p";
    if (/480/i.test(parsedQuality)) return "SD";

    const lowerTextValue = text.toLowerCase();
    if (REGEX_QUALITY_FILTER["4K"].test(lowerTextValue)) return "4K";
    if (REGEX_QUALITY_FILTER["1080p"].test(lowerTextValue)) return "1080p";
  if (REGEX_QUALITY_FILTER["720p"].test(lowerTextValue)) return "720p";
  return "SD";
}

function getQualityPriority(item) {
  const quality = item?._rankMeta?.quality || detectQuality(item);
  if (quality === "4K") return 4;
  if (quality === "1080p") return 3;
  if (quality === "720p") return 2;
  return 1;
}

function resolveLangMode(meta = {}, configInput = {}) {
  const config = buildPreparedConfig(configInput);
  const directMeta = lowerText(meta.langMode || meta.languageMode || meta.language);
  const explicit = lowerText(configInput.filters?.language || configInput.langMode || configInput.language);

  if (directMeta === "ita" || directMeta === "eng" || directMeta === "all") return directMeta;
  if (explicit === "ita" || explicit === "eng" || explicit === "all") return explicit;

  if (configInput.filters?.allowEng === true || configInput.allowEng === true) return "all";
  if (config.profile === "dedupe" && explicit === "") return "all";
  return "ita";
}

function getExpectedTitles(meta = {}) {
  const titles = new Set();
  const pushValue = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(pushValue);
      return;
    }
    const text = normalizeText(value);
    if (text) titles.add(text);
  };

  pushValue(meta.title);
  pushValue(meta.name);
  pushValue(meta.originalTitle);
  pushValue(meta.originalName);
  pushValue(meta.alternativeTitles);
  pushValue(meta.altTitles);
  pushValue(meta.aka_titles);
  pushValue(meta.aliases);
  pushValue(meta.titles);
  pushValue(meta.aka);
  return [...titles];
}

function computeTitleSimilarity(candidateTitle, expectedTitles = []) {
  const candidateTokens = new Set(tokenizeTitle(candidateTitle));
  if (!candidateTokens.size || expectedTitles.length === 0) return { score: 0, matchedTitle: "" };

  let bestScore = 0;
  let matchedTitle = "";

  for (const expected of expectedTitles) {
    const expectedTokens = new Set(tokenizeTitle(expected));
    if (!expectedTokens.size) continue;

    let intersection = 0;
    for (const token of candidateTokens) {
      if (expectedTokens.has(token)) intersection += 1;
    }

    const union = new Set([...candidateTokens, ...expectedTokens]).size || 1;
    const score = Math.max(intersection / union, intersection / expectedTokens.size);
    if (score > bestScore) {
      bestScore = score;
      matchedTitle = expected;
    }
  }

  return { score: bestScore, matchedTitle };
}

function matchesExpectedYear(title, meta = {}) {
  const expectedYear = parseInt(meta.year || meta.releaseYear || meta.firstAirYear, 10);
  if (!Number.isFinite(expectedYear)) return true;
  const yearMatch = normalizeText(title).match(REGEX_YEAR);
  if (!yearMatch) return true;
  return Math.abs(parseInt(yearMatch[0], 10) - expectedYear) <= 1;
}

function getLanguageSignals(item, meta = {}) {
  const title = normalizeText(item?.title || item?.name);
  const source = normalizeText(item?.source || item?.provider);
  const parsed = parseTitleDetails(title);
  const langInfo = getLanguageInfo(title, meta?.title || meta?.originalTitle || null, source, parsed);
  const upperTitle = title.toUpperCase();
  const explicitEng = REGEX_EXPLICIT_ENG.test(upperTitle);
  const explicitIta = hasStrictItalianEvidence(title, source, parsed);
  const explicitMulti = langInfo.isMulti || REGEX_MULTI_ITA.test(title) || REGEX_EXPLICIT_MULTI.test(upperTitle);
  const explicitOther = REGEX_EXPLICIT_OTHER.test(upperTitle);
  const subOnly = REGEX_SUB_ONLY.test(title);
  const neutralScene = REGEX_SCENE_RELEASE.test(title) && !explicitEng && !explicitIta && !explicitMulti && !explicitOther;

  return {
    title,
    source,
    parsed,
    langInfo,
    explicitEng,
    explicitIta,
    explicitMulti,
    explicitOther,
    neutralScene,
    subOnly
  };
}

function shouldKeepItalianCandidate(title, source, meta = {}) {
  return shouldKeepStrictItalianCandidate(title, source);
}

function hasTrustedExternalItalianEvidence(item = {}) {
  const languageInfo = item?._externalLanguageInfo || item?.languageInfo || {};
  const isTrustedExternal = Boolean(item?.isExternal || item?.externalAddon || item?.externalGroup || item?._externalIdMatched || item?._sourceGroup === 'external');
  if (!isTrustedExternal && !item?._torrentioLooseItForceKeep && !item?._torrentioExactGuard) return false;
  return Boolean(
    item?._torrentioLooseItForceKeep ||
    item?._torrentioExactGuard ||
    item?._externalIsItalian ||
    item?._externalHasItalianAudio ||
    item?.isItalian ||
    item?.hasItalianAudio ||
    languageInfo?.isItalian ||
    languageInfo?.hasAudioItalian
  );
}

function shouldKeepByLanguageMode(item, meta = {}, configInput = {}) {
  const title = normalizeText(item?.title || item?.name);
  const source = normalizeText(item?.source || item?.provider);
  const signals = getLanguageSignals({ title, source }, meta);
  const langMode = resolveLangMode(meta, configInput);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedMeta = normalizeSearchText(meta?.title || meta?.originalTitle || "");
  const yearMatches = matchesExpectedYear(title, meta);

  if (langMode === "ita" && hasTrustedExternalItalianEvidence(item)) return true;

  if (langMode === "eng") {
    if (signals.explicitEng) return true;
    if (signals.explicitOther && !signals.explicitEng) return false;
    if (signals.subOnly && !signals.explicitEng) return false;
    if (signals.explicitIta && !signals.explicitEng) return false;
    if (signals.explicitMulti && !signals.explicitEng) return false;

    if (signals.neutralScene && yearMatches) return true;
    if (normalizedMeta && normalizedTitle.includes(normalizedMeta) && yearMatches) return true;
    return !signals.explicitOther && !signals.explicitIta && !signals.explicitMulti && yearMatches;
  }

  if (langMode === "all") {
    if (shouldKeepItalianCandidate(title, source, meta)) return true;
    if (signals.explicitMulti) return true;
    if (signals.explicitOther && !signals.explicitEng) return false;
    return !signals.subOnly || signals.explicitEng;
  }

  return shouldKeepItalianCandidate(title, source, meta);
}

function detectItalianAudio(item, meta = {}) {
  return getLanguageSignals(item, meta).explicitIta;
}

function detectEnglishAudio(item, meta = {}) {
  return getLanguageSignals(item, meta).explicitEng;
}

function detectOtherLanguage(item, meta = {}) {
  return getLanguageSignals(item, meta).explicitOther;
}

function detectMultiAudio(item, meta = {}) {
  return getLanguageSignals(item, meta).explicitMulti;
}

function evaluateEpisodeFit(title, meta = {}, weights) {
  const season = Number.isInteger(meta.season) ? meta.season : parseInt(meta.season, 10);
  const episode = Number.isInteger(meta.episode) ? meta.episode : parseInt(meta.episode, 10);
  const isSeries = meta?.isSeries || (Number.isFinite(season) && Number.isFinite(episode));
  const isPack = isSeasonPack(title) || REGEX_PACK.test(title);
  const context = Number.isFinite(season) && Number.isFinite(episode) ? { season, episode } : null;
  const episodeContext = context ? extractEpisodeContext(title, context.season || 1, { anime: isAnimeMeta(meta) }) : null;
  const ignoreAnimeSeason = shouldIgnoreAnimeSeason(meta, title);
  let delta = 0;
  const reasons = [];

  if (!isSeries) {
    if (REGEX_SERIES_MARKER.test(title)) {
      delta += weights.seriesOnMoviePenalty;
      reasons.push("SERIES_ON_MOVIE");
    }
    return { delta, reasons, isPack, exactEpisode: false };
  }

  if (episodeContext && episodeContext.episode === context?.episode && (episodeContext.season === context?.season || ignoreAnimeSeason)) {
    delta += weights.exactEpisodeBoost;
    reasons.push("EXACT_EPISODE");
    return { delta, reasons, isPack, exactEpisode: true };
  }

  if (isPack && context?.season && new RegExp(`(?:s|season|stagione)\\s*0?${context.season}(?!\\d)`, "i").test(title)) {
    delta += weights.seasonPackBonus;
    reasons.push("SEASON_PACK");
  }

  if (isPack) {
    delta += weights.packBonus;
    reasons.push("PACK");
  }

  if (episodeContext && context?.season && episodeContext.season !== context.season && !ignoreAnimeSeason) {
    delta += weights.wrongSeasonPenalty;
    reasons.push("WRONG_SEASON");
  } else if (episodeContext && context?.episode && episodeContext.episode !== context.episode) {
    delta += weights.wrongEpisodePenalty;
    reasons.push("WRONG_EPISODE");
  }

  return { delta, reasons, isPack, exactEpisode: false };
}

function computeScore(item, meta = {}, configInput = {}) {
  const { config, profileName, profile } = getProfileConfig(configInput);
  const weights = profile.weights;
  const title = normalizeText(item?.title || item?.name);
  const source = lowerText(item?.source || item?.provider);
  const quality = detectQuality(title);
  const signals = getLanguageSignals(item, meta);
  const langMode = resolveLangMode(meta, configInput);
  const sizeBytes = parseSizeToBytes(item?._size || item?.sizeBytes || item?.size);
  const seeders = Math.max(0, normalizeNumber(item?.seeders));
  const hasFileIdx = item?.fileIdx !== undefined && item?.fileIdx !== null && item?.fileIdx !== "";
  const yearMatches = matchesExpectedYear(title, meta);
  const expectedTitles = getExpectedTitles(meta);
  const titleSimilarity = computeTitleSimilarity(title, expectedTitles);
  const episodeFit = evaluateEpisodeFit(title, meta, weights);
  const invalid = profile.minimalSizeBytes > 0 && sizeBytes > 0 && sizeBytes < profile.minimalSizeBytes;

  let score = 0;
  const reasons = [];

  if (quality === "4K") {
    score += weights.quality4K;
    reasons.push("4K");
  } else if (quality === "1080p") {
    score += weights.quality1080p;
    reasons.push("1080p");
  } else if (quality === "720p") {
    score += weights.quality720p;
    reasons.push("720p");
  } else {
    score += weights.qualitySD;
    reasons.push("SD");
  }

  if (langMode === "eng") {
    if (signals.explicitEng) {
      score += weights.languageEng;
      reasons.push("ENG");
      if (signals.explicitMulti) {
        score += Math.max(0, Math.floor(Math.abs(weights.languageMultiPenaltyInEng || 0) * 0.35));
        reasons.push("ENG_MULTI_OK");
      }
    } else if (signals.neutralScene) {
      score += weights.languageNeutral;
      reasons.push("NEUTRAL");
    }
    if (signals.explicitIta && !signals.explicitEng) {
      score += weights.languageItaPenaltyInEng;
      reasons.push("ITA_PENALTY");
    }
    if (signals.explicitMulti && !signals.explicitEng) {
      score += weights.languageMultiPenaltyInEng;
      reasons.push("MULTI_PENALTY");
    }
    if (signals.explicitOther && !signals.explicitEng) {
      score += weights.languageOtherPenalty;
      reasons.push("OTHER_LANG");
    }
  } else if (langMode === "all") {
    if (signals.explicitIta || signals.langInfo.isItalian) {
      score += weights.languageIta;
      reasons.push("ITA");
    } else if (signals.explicitEng) {
      score += weights.languageEng;
      reasons.push("ENG");
    } else if (signals.explicitMulti) {
      score += weights.languageMulti;
      reasons.push("MULTI");
    } else {
      score += weights.languageNeutral;
      reasons.push("NEUTRAL");
    }
    if (signals.explicitOther && !signals.explicitEng && !signals.explicitIta && !signals.explicitMulti) {
      score += weights.languageOtherPenalty;
      reasons.push("OTHER_LANG");
    }
  } else {
    if (signals.langInfo.isItalian) {
      score += weights.languageIta;
      reasons.push("ITA");
    } else if (signals.langInfo.isMaybeItalian) {
      score += weights.languageMaybeIta;
      reasons.push("MAYBE_ITA");
    }
    if (signals.explicitMulti) {
      score += Math.round(weights.languageMulti * 0.35);
      reasons.push("MULTI");
    }
    if (signals.explicitEng || (signals.explicitOther && !signals.explicitIta)) {
      score += Math.round(weights.languageOtherPenalty * 0.65);
      reasons.push("NON_ITA");
    }
  }

  if (REGEX_AUDIO_CONFIRM.test(title)) {
    score += weights.audioConfirm;
    reasons.push("AUDIO");
  }
  if (REGEX_STRONG_ITA.test(title)) {
    score += weights.strongIta;
    reasons.push("ITA_MARKER");
  }
  if (REGEX_MULTI_ITA.test(title)) {
    score += weights.multiIta;
    reasons.push("MULTI_ITA");
  }
  if (REGEX_TRUSTED_GROUPS.test(title)) {
    score += weights.trustedGroup;
    reasons.push("GROUP");
  }
  if (source && isTrustedSource(source, null)) {
    score += weights.trustedSource;
    reasons.push("SOURCE");
  }
  const sourceConsensus = detectSourceConsensus(item);
  const consensusBonus = SOURCE_CONSENSUS_BONUS[sourceConsensus] || 0;
  if (consensusBonus > 0) {
    score += consensusBonus;
    reasons.push(`SOURCE_CONSENSUS:${sourceConsensus}`);
  }
  if (hasFileIdx) {
    score += weights.fileIdxBonus;
    reasons.push("FILE_IDX");
  }
  if (REGEX_SCENE_RELEASE.test(title)) {
    score += weights.sceneRelease;
    reasons.push("SCENE");
  }
  if (REGEX_HEVC.test(title)) {
    score += weights.hevcBonus;
    reasons.push("HEVC");
  }
  if (REGEX_HDR.test(title)) {
    score += weights.hdrBonus;
    reasons.push("HDR");
  }
  if (signals.subOnly) {
    score += weights.subtitleOnlyPenalty;
    reasons.push("SUB_ONLY");
  }
  if (REGEX_CAM.test(title)) {
    score += weights.camPenalty;
    reasons.push("CAM");
  }

  score += episodeFit.delta;
  reasons.push(...episodeFit.reasons);

  if (expectedTitles.length > 0) {
    if (titleSimilarity.score > 0) {
      score += Math.round(titleSimilarity.score * weights.titleSimilarityFactor);
      reasons.push(`TITLE:${titleSimilarity.matchedTitle || "best"}`);
    } else if (!episodeFit.isPack) {
      score += weights.titleMismatchPenalty;
      reasons.push("TITLE_MISMATCH");
    }
  }

  if (meta?.year && title.match(REGEX_YEAR)) {
    if (yearMatches) {
      score += weights.exactYearBonus;
      reasons.push("YEAR");
    } else {
      score += weights.yearMismatchPenalty;
      reasons.push("YEAR_MISMATCH");
    }
  }

  score += Math.min(seeders, 500) * weights.seedersFactor;
  if (Number.isFinite(Number(item?._seedHealthDelta)) && Number(item._seedHealthDelta) !== 0) {
    score += Number(item._seedHealthDelta);
    reasons.push(`SEED_HEALTH:${item._seedHealth || 'unknown'}`);
  }
  score += Math.min(Math.floor(sizeBytes / Math.max(1, weights.sizeBucketBytes)), weights.sizeFactorCap);
  score += Math.min(title.length, weights.titleLengthCap);

  if (String(configInput?.service || "").toLowerCase() === "tb" && item?._tbCached) {
    score += weights.tbCachedBonus;
    reasons.push("TB_CACHED");
  }

  const scoreProfile = evaluateLeviathanScore(item, meta, configInput);
  const useScoreProfile = configInput?.useLeviathanScoreProfile === true
    || configInput?.ranking?.useLeviathanScoreProfile === true
    || configInput?.ranking?.useScoreProfile === true;
  if (useScoreProfile) {
    score += scoreProfile.finalScore;
    reasons.push("LEV_SCORE_PROFILE");
  }

  if (invalid) {
    score = Math.min(score, -999999999);
    reasons.push("SIZE_TOO_SMALL");
  }

  return {
    score,
    reasons,
    details: {
      profile: profileName,
      quality,
      langMode,
      source,
      sizeBytes,
      seeders,
      invalid,
      exactEpisode: episodeFit.exactEpisode,
      isPack: episodeFit.isPack,
      titleSimilarity: titleSimilarity.score,
      yearMatches,
      explicitIta: signals.explicitIta,
      explicitEng: signals.explicitEng,
      explicitMulti: signals.explicitMulti,
      explicitOther: signals.explicitOther,
      isItalian: signals.langInfo.isItalian,
      isMaybeItalian: signals.langInfo.isMaybeItalian,
      isMulti: signals.langInfo.isMulti,
      subOnly: signals.subOnly,
      sourceConsensus,
      scoreProfile
    }
  };
}

function annotateResult(item, meta = {}, configInput = {}) {
  const { score, reasons, details } = computeScore(item, meta, configInput);
  return {
    ...item,
    _score: score,
    _reasons: reasons,
    _rankMeta: details,
    _rankProfile: details.profile
  };
}

function ensureAnnotated(item, meta = {}, configInput = {}) {
  const profileName = resolveProfileName(configInput);
  if (item?._rankProfile === profileName && typeof item?._score === "number" && item?._rankMeta) return item;
  return annotateResult(item, meta, configInput);
}

function compareRankedItems(left, right, meta = {}, configInput = {}) {
  const { config, profileName } = getProfileConfig(configInput);
  const sortMode = config.sortMode || "balanced";
  const a = ensureAnnotated(left, meta, { ...config, profile: profileName });
  const b = ensureAnnotated(right, meta, { ...config, profile: profileName });

  const invalidA = Boolean(a._rankMeta?.invalid);
  const invalidB = Boolean(b._rankMeta?.invalid);
  if (invalidA !== invalidB) return invalidA ? 1 : -1;

  const sizeA = normalizeNumber(a._rankMeta?.sizeBytes || a._size || a.sizeBytes || a.size);
  const sizeB = normalizeNumber(b._rankMeta?.sizeBytes || b._size || b.sizeBytes || b.size);
  if (sortMode === "size" && sizeB !== sizeA) return sizeB - sizeA;

  if (sortMode === "resolution") {
    const qualityDelta = getQualityPriority(b) - getQualityPriority(a);
    if (qualityDelta !== 0) return qualityDelta;
  }

  if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);

  const seedA = normalizeNumber(a.seeders);
  const seedB = normalizeNumber(b.seeders);
  if (seedB !== seedA) return seedB - seedA;

  if (sizeB !== sizeA) return sizeB - sizeA;

  if (profileName === "dedupe") {
    const titleLengthDelta = normalizeText(b.title || b.name).length - normalizeText(a.title || a.name).length;
    if (titleLengthDelta !== 0) return titleLengthDelta;
  }

  return normalizeText(a.title || a.name).localeCompare(normalizeText(b.title || b.name));
}

function rankAndFilterResults(results = [], meta = {}, configInput = {}) {
  const config = buildPreparedConfig({ ...configInput, profile: "stream" });
  if (!Array.isArray(results)) return [];

  const ranked = results
    .map((item) => annotateResult(item, meta, config))
    .filter((item) => !config.keepByLanguage || shouldKeepByLanguageMode(item, meta, configInput));

  ranked.sort((a, b) => compareRankedItems(a, b, meta, config));
  return ranked;
}

module.exports = {
  DEFAULT_CONFIG,
  annotateResult,
  compareRankedItems,
  rankAndFilterResults,
  parseSizeToBytes,
  computeScore,
  detectQuality,
  getQualityPriority,
  detectItalianAudio,
  detectEnglishAudio,
  detectOtherLanguage,
  detectMultiAudio,
  resolveLangMode,
  shouldKeepByLanguageMode,
  getLanguageSignals,
  extractEpisodeContext
};
