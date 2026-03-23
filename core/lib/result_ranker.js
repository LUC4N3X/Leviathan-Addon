const DEFAULT_CONFIG = {
  weights: {
    quality4K: 50000000,
    quality1080p: 20000000,
    quality720p: 10000000,
    qualitySD: 0,
    languageITA: 500000,
    languageENG: 500000,
    languageMULTI: 250000,
    languageNeutral: 120000,
    languageOtherPenalty: -300000,
    languageItaPenaltyInEng: -700000,
    languageMultiPenaltyInEng: -350000,
    hevcBonus: 5000,
    hdrBonus: 5000,
    exactEpisodeBoost: 20000,
    seasonPackBonus: 10000,
    completeSeriesBonus: 25000,
    wrongEpisodePenalty: -30000,
    wrongSeasonPenalty: -25000,
    subtitleOnlyPenalty: -12000,
    titleMismatchPenalty: -15000,
    yearMismatchPenalty: -8000,
    screenerPenalty: -25000000,
    camPenalty: -100000000,
    sizeMismatchPenalty: -5000,
    sourceCorsaroBonus: 5000,
    preferredSourceBonus: 3000,
    seedersFactor: 1,
    seedersTrustBoost: 100,
    ageDecayPerDay: -1,
    hashKnownBonus: 2000,
    groupReputationFactor: 5000,
    reportPositiveBonus: 4000,
    reportNegativePenalty: -8000,
    titleSimilarityFactor: 20000,
    exactYearBonus: 1000,
  },
  heuristics: {
    camRegex: /\b(cam|ts|telecine|telesync|camrip|cam\.|hdcam|hdtc)\b/i,
    screenerRegex: /\b(scr|screener|dvdscr|bdscr|workprint)\b/i,
    packRegex: /\b(pack|complete|tutta|tutte|full ?season|season ?pack|stagione ?(?:completa|complete)?|serie completa)\b/i,
    completeSeriesRegex: /\b(complete series|serie completa|tutte le stagioni|all seasons|collection|saga completa)\b/i,
    itaPatterns: [
      /\b(?:ITALIAN|ITALIANO)\b/i,
      /\b(?:AUDIO|LINGUA)\s*[:\-]?\s*(?:ITA|IT|ITALIANO)\b/i,
      /\b(?:AC-?3|AAC|DDP?|DTS(?:-HD)?|PCM|TRUEHD|ATMOS|MP3|WMA|FLAC)[^\n]{0,24}\b(?:ITA|IT|ITALIANO)\b/i,
      /\b(?:MULTI|DUAL|TRIPLE)[^\n]{0,24}\b(?:ITA|IT|ITALIANO)\b/i,
      /\b(?:ITA|ITA-ENG|ITA\.ENG|ITA_ENG|Ita)\b/i,
    ],
    engPatterns: [
      /\b(?:ENG|ENGLISH)\b/i,
      /\b(?:AUDIO|LANG(?:UAGE)?)\s*[:\-]?\s*(?:ENG|ENGLISH)\b/i,
      /\b(?:AC-?3|AAC|DDP?|DTS(?:-HD)?|PCM|TRUEHD|ATMOS|MP3|WMA|FLAC)[^\n]{0,24}\b(?:ENG|ENGLISH)\b/i,
      /\b(?:ENG[._ -]?SUB|SUB[._ -]?ENG|ENGLISH[._ -]?SUB)\b/i,
    ],
    multiPatterns: [/\b(MULTI|MULTILANG|MULTILANGUAGE|ITA[._ -]?ENG|ITA-ENG|ENG[._ -]?ITA|DUAL|DUAL[ -]?AUDIO|TRIPLE)\b/i],
    otherLanguagePatterns: [
      /\b(?:JAP|JPN|JAPANESE|FRE|FRENCH|FRA|GER|GERMAN|DEU|SPA|SPANISH|ESP|RUS|RUSSIAN|KOR|KOREAN|PT-?BR|PORTUGUESE|HINDI|VOSTFR|VOSTA)\b/i,
    ],
    subtitleOnlyPatterns: [/\b(?:SUB|SUBS|SOTTOTITOLI|SUB[._ -]?ITA|SUB-?ITA|VOSTFR|VOSTA|SUBBED)\b/i],
    audioNegativePatterns: [/\b(?:ENG(?:LISH)?\s+ONLY|SUB[._ -]?ITA\s+ONLY)\b/i],
    hevcRegex: /\b(x265|h265|hevc)\b/i,
    hdrRegex: /\b(hdr|hdr10\+?|dolby\s*vision|\bDV\b)\b/i,
    minimalSizeBytes: 150 * 1024 * 1024,
    sourceLanguageHints: {
      corsaro: 'ita',
      knaben: 'mixed',
      rarbg: 'eng',
      '1337x': 'eng',
      tpb: 'eng',
      'tpb mirror': 'eng',
      bitsearch: 'eng',
      limetorrents: 'eng',
      uindex: 'eng',
    },
    releaseGroupRegexes: [
      /-(?<group>[A-Z0-9][A-Z0-9._-]{1,15})$/,
      /\[(?<group>[A-Z0-9][A-Z0-9._-]{1,15})\]$/,
      /\b(?<group>[A-Z0-9]{2,12})\b$/,
    ],
    qualityOrder: {
      '4K': 4,
      '1080p': 3,
      '720p': 2,
      SD: 1,
    },
  },
  trust: {
    sourceTrust: { Corsaro: 1.0, Knaben: 1.0 },
    groupReputation: { FAKEGRP: -1.0 },
    preferredSources: [],
  },
  userReportsDB: {},
  misc: { nowTimestamp: () => Date.now() },
};

function normalizeNumber(n) {
  if (typeof n === 'number') return Number.isFinite(n) ? n : 0;
  if (typeof n === 'string') {
    const cleaned = n.replace(/[^\d.,-]/g, '').replace(/(\d)[,](\d{3})(?!\d)/g, '$1$2').replace(',', '.');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseSizeToBytes(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);

  const normalized = raw.replace(/\s+/g, ' ');
  const match = normalized.match(/([\d.,]+)\s*(B|BYTE|BYTES|KB|KIB|MB|MIB|GB|GIB|TB|TIB)/i);
  if (!match) return 0;

  const amountText = match[1].includes(',') && match[1].includes('.')
    ? match[1].replace(/,/g, '')
    : match[1].replace(',', '.');
  const amount = parseFloat(amountText);
  if (!Number.isFinite(amount)) return 0;

  const unit = match[2].toUpperCase();
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
    TIB: 1024 ** 4,
  };

  return Math.round(amount * (multipliers[unit] || 1));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function lowerText(value) {
  return normalizeText(value).toLowerCase();
}

function stripAccents(value) {
  return normalizeText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeLooseTitle(value) {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[\[\]{}()]/g, ' ')
    .replace(/[._:+\-]+/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|x264|x265|h264|h265|hevc|hdr10\+?|hdr|dv|dolby\s*vision|web[- ]?dl|webrip|bluray|brrip|dvdrip|remux|proper|repack|nf|amzn|dsnp|atvp)\b/g, ' ')
    .replace(/\b(ita|italian|italiano|multi|dual|audio|sub|subs|subbed|vostfr|subita)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitle(value) {
  const normalized = normalizeLooseTitle(value);
  if (!normalized) return [];
  return normalized.split(' ').filter((token) => token.length >= 2);
}

function deepMergeConfig(optConfig = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...optConfig,
    weights: { ...DEFAULT_CONFIG.weights, ...(optConfig.weights || {}) },
    heuristics: {
      ...DEFAULT_CONFIG.heuristics,
      ...(optConfig.heuristics || {}),
      sourceLanguageHints: {
        ...DEFAULT_CONFIG.heuristics.sourceLanguageHints,
        ...((optConfig.heuristics && optConfig.heuristics.sourceLanguageHints) || {}),
      },
      releaseGroupRegexes: Array.isArray(optConfig.heuristics?.releaseGroupRegexes)
        ? optConfig.heuristics.releaseGroupRegexes.slice()
        : DEFAULT_CONFIG.heuristics.releaseGroupRegexes.slice(),
      qualityOrder: {
        ...DEFAULT_CONFIG.heuristics.qualityOrder,
        ...((optConfig.heuristics && optConfig.heuristics.qualityOrder) || {}),
      },
    },
    trust: {
      ...DEFAULT_CONFIG.trust,
      ...(optConfig.trust || {}),
      sourceTrust: {
        ...DEFAULT_CONFIG.trust.sourceTrust,
        ...((optConfig.trust && optConfig.trust.sourceTrust) || {}),
      },
      groupReputation: {
        ...DEFAULT_CONFIG.trust.groupReputation,
        ...((optConfig.trust && optConfig.trust.groupReputation) || {}),
      },
      preferredSources: Array.isArray(optConfig.trust?.preferredSources)
        ? optConfig.trust.preferredSources.slice()
        : DEFAULT_CONFIG.trust.preferredSources.slice(),
    },
    misc: { ...DEFAULT_CONFIG.misc, ...(optConfig.misc || {}) },
    userReportsDB: { ...DEFAULT_CONFIG.userReportsDB, ...(optConfig.userReportsDB || {}) },
  };
}

function detectQuality(title) {
  if (/(2160p|\b4k\b|uhd)/i.test(title)) return '4K';
  if (/(1080p|\bfhd\b)/i.test(title)) return '1080p';
  if (/(720p|\bhd\b)/i.test(title)) return '720p';
  return 'SD';
}


function getItemText(item) {
  return [item?.title, item?.name, item?.description].map(normalizeText).filter(Boolean).join(' ');
}

function resolveLangMode(meta = {}, config = {}) {
  const directMeta = lowerText(meta.langMode || meta.languageMode || meta.language);
  if (directMeta === 'ita' || directMeta === 'eng' || directMeta === 'all') return directMeta;

  const filterMode = lowerText(config.filters?.language || config.langMode || config.language);
  if (filterMode === 'ita' || filterMode === 'eng' || filterMode === 'all') return filterMode;

  if (config.filters?.allowEng === true || config.allowEng === true) return 'all';
  return 'ita';
}

function detectItalianAudio(item, config) {
  const source = lowerText(item.source || item.provider);
  const text = getItemText(item);

  const hasSubtitleOnlyMarker = config.heuristics.subtitleOnlyPatterns.some((pattern) => pattern.test(text));
  const hasStrongItaMarker = config.heuristics.itaPatterns.some((pattern) => pattern.test(text));
  const hasNegativeMarker = config.heuristics.audioNegativePatterns.some((pattern) => pattern.test(text));
  const hintedLanguage = config.heuristics.sourceLanguageHints[source] || null;

  if (hasStrongItaMarker) return true;
  if (hasNegativeMarker) return false;
  if (hasSubtitleOnlyMarker) return false;
  if (hintedLanguage === 'ita') return true;

  return /\b(?:ita|italian|italiano)\b/i.test(text);
}

function detectMultiAudio(item, config) {
  const text = getItemText(item);
  return config.heuristics.multiPatterns.some((pattern) => pattern.test(text));
}

function detectEnglishAudio(item, config) {
  const source = lowerText(item.source || item.provider);
  const text = getItemText(item);

  if (detectItalianAudio(item, config)) return false;
  if (detectMultiAudio(item, config)) return false;
  if (config.heuristics.subtitleOnlyPatterns.some((pattern) => pattern.test(text))) return false;
  if (config.heuristics.otherLanguagePatterns.some((pattern) => pattern.test(text))) return false;

  const hintedLanguage = config.heuristics.sourceLanguageHints[source] || null;
  if (hintedLanguage === 'eng') return true;

  if (config.heuristics.engPatterns.some((pattern) => pattern.test(text))) return true;
  return /\b(?:eng|english)\b/i.test(text);
}

function detectOtherLanguage(item, config) {
  const source = lowerText(item.source || item.provider);
  const text = getItemText(item);

  if (detectItalianAudio(item, config)) return false;
  if (detectMultiAudio(item, config)) return false;
  if (detectEnglishAudio(item, config)) return false;

  const hintedLanguage = config.heuristics.sourceLanguageHints[source] || null;
  if (hintedLanguage && !['ita', 'eng', 'mixed'].includes(hintedLanguage)) return true;

  return config.heuristics.otherLanguagePatterns.some((pattern) => pattern.test(text));
}

function getLanguageFlags(item, meta = {}, config = DEFAULT_CONFIG) {
  const mode = resolveLangMode(meta, config);
  const text = getItemText(item);
  const subtitleOnly = config.heuristics.subtitleOnlyPatterns.some((pattern) => pattern.test(text));
  const isIta = detectItalianAudio(item, config);
  const isMulti = detectMultiAudio(item, config);
  const isEng = detectEnglishAudio(item, config);
  const isOther = detectOtherLanguage(item, config);
  const isNeutralScene = !subtitleOnly && !isIta && !isMulti && !isEng && !isOther;

  return {
    mode,
    text,
    subtitleOnly,
    isIta,
    isMulti,
    isEng,
    isOther,
    isNeutralScene,
  };
}

function shouldKeepByLanguageMode(item, meta = {}, config = DEFAULT_CONFIG) {
  const flags = getLanguageFlags(item, meta, config);

  if (flags.mode === 'eng') {
    if (flags.isIta || flags.isMulti || flags.isOther) return false;
    return flags.isEng || flags.isNeutralScene;
  }

  if (flags.mode === 'all') {
    if (flags.isOther && !flags.isEng && !flags.isIta && !flags.isMulti) return false;
    return flags.isIta || flags.isEng || flags.isMulti || flags.isNeutralScene;
  }

  if (flags.isOther || flags.isEng) return false;
  return flags.isIta || flags.isMulti || flags.isNeutralScene;
}
function buildEpisodeContext(meta = {}) {
  const season = Number.isInteger(meta.season) ? meta.season : parseInt(meta.season, 10);
  const episode = Number.isInteger(meta.episode) ? meta.episode : parseInt(meta.episode, 10);
  const absoluteEpisode = Number.isInteger(meta.absoluteEpisode)
    ? meta.absoluteEpisode
    : Number.isInteger(meta.episodeNumber)
      ? meta.episodeNumber
      : parseInt(meta.absoluteEpisode || meta.episodeNumber, 10);

  return {
    season: Number.isFinite(season) ? season : null,
    episode: Number.isFinite(episode) ? episode : null,
    absoluteEpisode: Number.isFinite(absoluteEpisode) ? absoluteEpisode : null,
  };
}

function buildEpisodeMatchers(meta = {}) {
  const context = buildEpisodeContext(meta);
  const matchers = [];

  if (context.season != null && context.episode != null) {
    const s = String(context.season).padStart(2, '0');
    const e = String(context.episode).padStart(2, '0');

    matchers.push(new RegExp(`\\bS?${s}E${e}\\b`, 'i'));
    matchers.push(new RegExp(`\\b${context.season}x${context.episode}\\b`, 'i'));
    matchers.push(new RegExp(`\\bS${s}\\s*E${e}\\b`, 'i'));
    matchers.push(new RegExp(`\\bSeason\\s*${context.season}\\s*Episode\\s*${context.episode}\\b`, 'i'));
  }

  if (context.absoluteEpisode != null) {
    const abs = String(context.absoluteEpisode).padStart(2, '0');
    matchers.push(new RegExp(`\\bE?P?${abs}\\b`, 'i'));
  }

  return matchers;
}

function extractEpisodeMentions(text) {
  const title = normalizeText(text);
  const mentions = [];
  const patterns = [
    /\bS(\d{1,2})E(\d{1,3})\b/gi,
    /\b(\d{1,2})x(\d{1,3})\b/gi,
    /\bSeason\s*(\d{1,2})\s*Episode\s*(\d{1,3})\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of title.matchAll(pattern)) {
      mentions.push({
        season: parseInt(match[1], 10),
        episode: parseInt(match[2], 10),
      });
    }
  }

  return mentions;
}

function detectUploadTimestamp(item) {
  const candidates = [
    item.uploadDate,
    item.addedAt,
    item.createdAt,
    item.pubDate,
    item.publishedAt,
    item.date,
    item.timestamp,
    item.time,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate > 1e12 ? candidate : candidate * 1000;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
}

function getExpectedTitles(meta = {}) {
  const titles = new Set();
  const add = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }
    const text = normalizeText(value);
    if (text) titles.add(text);
  };

  add(meta.title);
  add(meta.name);
  add(meta.originalTitle);
  add(meta.originalName);
  add(meta.seriesTitle);
  add(meta.alternativeTitles);
  add(meta.altTitles);
  add(meta.aliases);
  add(meta.aka);

  return [...titles];
}

function computeTitleSimilarity(candidateTitle, expectedTitles = []) {
  const candidateTokens = new Set(tokenizeTitle(candidateTitle));
  if (!candidateTokens.size || !expectedTitles.length) return { score: 0, matchedTitle: '' };

  let bestScore = 0;
  let matchedTitle = '';

  for (const expected of expectedTitles) {
    const expectedTokens = new Set(tokenizeTitle(expected));
    if (!expectedTokens.size) continue;

    let intersection = 0;
    for (const token of candidateTokens) {
      if (expectedTokens.has(token)) intersection += 1;
    }

    const union = new Set([...candidateTokens, ...expectedTokens]).size || 1;
    const jaccard = intersection / union;
    const coverage = intersection / expectedTokens.size;
    const score = Math.max(jaccard, coverage * 0.9);

    if (score > bestScore) {
      bestScore = score;
      matchedTitle = expected;
    }
  }

  return { score: bestScore, matchedTitle };
}

function extractYears(text) {
  const years = new Set();
  for (const match of normalizeText(text).matchAll(/\b(19\d{2}|20\d{2}|21\d{2})\b/g)) {
    years.add(parseInt(match[1], 10));
  }
  return [...years];
}

function extractReleaseGroup(title, config) {
  const rawTitle = normalizeText(title);
  if (!rawTitle) return '';
  for (const pattern of config.heuristics.releaseGroupRegexes) {
    const match = rawTitle.match(pattern);
    const group = match?.groups?.group || match?.[1] || '';
    if (group && group.length >= 2) return group.toUpperCase();
  }
  return '';
}

function getUserReportDelta(item, config) {
  const hash = normalizeText(item.infoHash || item.hash || item.magnetHash).toLowerCase();
  const title = normalizeText(item.title).toLowerCase();
  const source = normalizeText(item.source || item.provider).toLowerCase();
  const keys = [
    hash && `hash:${hash}`,
    hash,
    title && source && `title:${title}|source:${source}`,
    title && `title:${title}`,
  ].filter(Boolean);

  for (const key of keys) {
    if (!(key in config.userReportsDB)) continue;
    const entry = config.userReportsDB[key];
    if (typeof entry === 'number') return entry;
    if (entry && typeof entry === 'object') {
      if (Number.isFinite(entry.scoreDelta)) return entry.scoreDelta;
      const positives = normalizeNumber(entry.positives);
      const negatives = normalizeNumber(entry.negatives);
      return positives * config.weights.reportPositiveBonus + negatives * config.weights.reportNegativePenalty;
    }
  }

  return 0;
}

function estimateRuntimeMinutes(meta = {}) {
  const candidates = [
    meta.runtime,
    meta.runtimeMinutes,
    meta.durationMinutes,
    meta.duration,
  ];

  for (const candidate of candidates) {
    const value = normalizeNumber(candidate);
    if (value <= 0) continue;
    if (value > 1000 && value < 1000 * 60 * 60 * 12) return Math.round(value / 60000);
    if (value > 0 && value < 600) return Math.round(value);
  }

  return 0;
}

function estimateExpectedSizeRange(meta = {}, quality) {
  const runtimeMinutes = estimateRuntimeMinutes(meta);
  if (!runtimeMinutes) return null;

  const perMinute = {
    '4K': { min: 90, max: 300 },
    '1080p': { min: 25, max: 120 },
    '720p': { min: 12, max: 60 },
    SD: { min: 4, max: 25 },
  };

  const selected = perMinute[quality] || perMinute.SD;
  return {
    minBytes: Math.round(runtimeMinutes * selected.min * 1024 * 1024),
    maxBytes: Math.round(runtimeMinutes * selected.max * 1024 * 1024),
  };
}

function evaluateEpisodeFit(title, meta, config) {
  const context = buildEpisodeContext(meta);
  const reasons = [];
  let delta = 0;

  const episodeMatchers = buildEpisodeMatchers(meta);
  if (episodeMatchers.length && episodeMatchers.some((re) => re.test(title))) {
    delta += config.weights.exactEpisodeBoost;
    reasons.push('EXACT_EPISODE');
    return { delta, reasons };
  }

  const mentions = extractEpisodeMentions(title);
  if (context.season != null && context.episode != null && mentions.length) {
    const sameSeasonWrongEpisode = mentions.some((m) => m.season === context.season && m.episode !== context.episode);
    const wrongSeason = mentions.some((m) => m.season !== context.season);
    if (sameSeasonWrongEpisode) {
      delta += config.weights.wrongEpisodePenalty;
      reasons.push('WRONG_EPISODE');
    }
    if (wrongSeason) {
      delta += config.weights.wrongSeasonPenalty;
      reasons.push('WRONG_SEASON');
    }
  }

  if (config.heuristics.packRegex.test(title)) {
    delta += config.weights.seasonPackBonus;
    reasons.push('PACK');
  }

  if (config.heuristics.completeSeriesRegex.test(title)) {
    delta += config.weights.completeSeriesBonus;
    reasons.push('COMPLETE_SERIES');
  }

  return { delta, reasons };
}


function computeScore(item, meta = {}, configInput = {}) {
  const config = configInput.weights ? configInput : deepMergeConfig(configInput);
  let score = 0;
  const reasons = [];
  const title = normalizeText(item.title || item.name);
  const loweredTitle = title.toLowerCase();
  const source = lowerText(item.source || item.provider);
  const quality = detectQuality(title);
  const langMode = resolveLangMode(meta, config);
  const langFlags = getLanguageFlags(item, meta, config);

  if (quality === '4K') {
    score += config.weights.quality4K;
    reasons.push('4K');
  } else if (quality === '1080p') {
    score += config.weights.quality1080p;
    reasons.push('1080p');
  } else if (quality === '720p') {
    score += config.weights.quality720p;
    reasons.push('720p');
  } else {
    score += config.weights.qualitySD;
    reasons.push('SD');
  }

  if (langMode === 'eng') {
    if (langFlags.isEng) {
      score += config.weights.languageENG;
      reasons.push('ENG');
    } else if (langFlags.isNeutralScene) {
      score += config.weights.languageNeutral;
      reasons.push('NEUTRAL');
    }
    if (langFlags.isIta) {
      score += config.weights.languageItaPenaltyInEng;
      reasons.push('ITA_PENALTY');
    }
    if (langFlags.isMulti) {
      score += config.weights.languageMultiPenaltyInEng;
      reasons.push('MULTI_PENALTY');
    }
    if (langFlags.isOther) {
      score += config.weights.languageOtherPenalty;
      reasons.push('OTHER_LANG');
    }
  } else if (langMode === 'all') {
    if (langFlags.isIta) {
      score += config.weights.languageITA;
      reasons.push('ITA');
    } else if (langFlags.isEng) {
      score += config.weights.languageENG;
      reasons.push('ENG');
    } else if (langFlags.isMulti) {
      score += config.weights.languageMULTI;
      reasons.push('MULTI');
    } else if (langFlags.isNeutralScene) {
      score += config.weights.languageNeutral;
      reasons.push('NEUTRAL');
    }
    if (langFlags.isOther) {
      score += Math.round(config.weights.languageOtherPenalty * 0.8);
      reasons.push('OTHER_LANG');
    }
  } else {
    if (langFlags.isIta) {
      score += config.weights.languageITA;
      reasons.push('ITA');
    } else if (langFlags.isMulti) {
      score += config.weights.languageMULTI;
      reasons.push('MULTI');
    } else if (langFlags.isNeutralScene) {
      score += Math.round(config.weights.languageNeutral * 0.35);
      reasons.push('NEUTRAL');
    }
    if (langFlags.isEng || langFlags.isOther) {
      score += Math.round(config.weights.languageOtherPenalty * 0.65);
      reasons.push('NON_ITA');
    }
  }

  if (langFlags.subtitleOnly && !langFlags.isIta) {
    score += config.weights.subtitleOnlyPenalty;
    reasons.push('SUB_ONLY');
  }

  if (config.heuristics.hevcRegex.test(loweredTitle)) {
    score += config.weights.hevcBonus;
    reasons.push('HEVC');
  }

  if (config.heuristics.hdrRegex.test(loweredTitle)) {
    score += config.weights.hdrBonus;
    reasons.push('HDR');
  }

  const episodeFit = evaluateEpisodeFit(title, meta, config);
  if (episodeFit.delta !== 0) score += episodeFit.delta;
  reasons.push(...episodeFit.reasons);

  const seeders = normalizeNumber(item.seeders);
  if (seeders > 0) {
    score += seeders * config.weights.seedersFactor;
    reasons.push(`SEED:${seeders}`);
  }

  const sourceTrustEntries = Object.entries(config.trust.sourceTrust || {});
  const trustedSourceEntry = sourceTrustEntries.find(([name]) => lowerText(name) === source);
  if (trustedSourceEntry && seeders > 0) {
    score += seeders * config.weights.seedersTrustBoost * normalizeNumber(trustedSourceEntry[1]);
    reasons.push(`TRUST:${trustedSourceEntry[0]}`);
  }

  if (config.trust.preferredSources.some((name) => lowerText(name) === source)) {
    score += config.weights.preferredSourceBonus;
    reasons.push('PREFERRED_SOURCE');
  }

  if (/\bcorsaro\b/i.test(source)) {
    score += config.weights.sourceCorsaroBonus;
    reasons.push('SOURCE:CORSARO');
  }

  if (config.heuristics.camRegex.test(loweredTitle)) {
    score += config.weights.camPenalty;
    reasons.push('CAM');
  }

  if (config.heuristics.screenerRegex.test(loweredTitle)) {
    score += config.weights.screenerPenalty;
    reasons.push('SCREENER');
  }

  const hash = normalizeText(item.infoHash || item.hash || item.magnetHash);
  if (hash) {
    score += config.weights.hashKnownBonus;
    reasons.push('HASH');
  }

  const group = extractReleaseGroup(title, config);
  if (group && Object.prototype.hasOwnProperty.call(config.trust.groupReputation, group)) {
    const rep = normalizeNumber(config.trust.groupReputation[group]);
    if (rep !== 0) {
      score += rep * config.weights.groupReputationFactor;
      reasons.push(`GROUP:${group}`);
    }
  }

  const userReportDelta = getUserReportDelta(item, config);
  if (userReportDelta !== 0) {
    score += userReportDelta;
    reasons.push(userReportDelta > 0 ? 'USER_REPORT_POS' : 'USER_REPORT_NEG');
  }

  const expectedTitles = getExpectedTitles(meta);
  if (expectedTitles.length) {
    const similarity = computeTitleSimilarity(title, expectedTitles);
    if (similarity.score > 0) {
      const similarityBonus = Math.round(similarity.score * config.weights.titleSimilarityFactor);
      score += similarityBonus;
      reasons.push(`TITLE_MATCH:${similarity.matchedTitle || 'best'}`);
    } else {
      score += config.weights.titleMismatchPenalty;
      reasons.push('TITLE_MISMATCH');
    }
  }

  const expectedYear = parseInt(meta.year || meta.releaseYear || meta.firstAirYear, 10);
  if (Number.isFinite(expectedYear)) {
    const yearsInTitle = extractYears(title);
    if (yearsInTitle.length) {
      if (yearsInTitle.includes(expectedYear)) {
        score += config.weights.exactYearBonus;
        reasons.push(`YEAR:${expectedYear}`);
      } else {
        score += config.weights.yearMismatchPenalty;
        reasons.push(`YEAR_MISMATCH:${yearsInTitle.join(',')}`);
      }
    }
  }

  const sizeBytes = parseSizeToBytes(item._size || item.sizeBytes || item.size);
  const expectedSizeRange = estimateExpectedSizeRange(meta, quality);
  if (sizeBytes > 0 && expectedSizeRange) {
    if (sizeBytes < expectedSizeRange.minBytes || sizeBytes > expectedSizeRange.maxBytes) {
      score += config.weights.sizeMismatchPenalty;
      reasons.push('SIZE_MISMATCH');
    }
  }

  const uploadedAt = detectUploadTimestamp(item);
  if (uploadedAt > 0) {
    const ageMs = Math.max(0, config.misc.nowTimestamp() - uploadedAt);
    const ageDays = Math.floor(ageMs / 86400000);
    if (ageDays > 0) {
      score += ageDays * config.weights.ageDecayPerDay;
      reasons.push(`AGE:${ageDays}d`);
    }
  }

  return {
    score,
    reasons,
    details: {
      quality,
      isIta: langFlags.isIta,
      isEng: langFlags.isEng,
      isMulti: langFlags.isMulti,
      isOther: langFlags.isOther,
      isNeutralScene: langFlags.isNeutralScene,
      sizeBytes,
      group,
      source,
      langMode,
    },
  };
}

function rankAndFilterResults(results = [], meta = {}, optConfig = {}) {
  const config = deepMergeConfig(optConfig);
  if (!Array.isArray(results)) return [];

  const ranked = results
    .map((item, index) => {
      const sizeBytes = parseSizeToBytes(item.sizeBytes || item.size || item._size);
      const cloned = { ...item, _size: sizeBytes || item._size || 0 };

      if (sizeBytes > 0 && sizeBytes < config.heuristics.minimalSizeBytes) {
        return {
          ...cloned,
          _score: -999999999,
          _reasons: ['SIZE_TOO_SMALL'],
          _rankMeta: {
            quality: detectQuality(cloned.title || cloned.name || ''),
            index,
          },
        };
      }

      const { score, reasons, details } = computeScore(cloned, meta, config);
      return {
        ...cloned,
        _score: score,
        _reasons: reasons,
        _rankMeta: {
          ...details,
          index,
        },
      };
    })
    .filter((item) => shouldKeepByLanguageMode(item, meta, config));

  ranked.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;

    const qualityA = config.heuristics.qualityOrder[a._rankMeta?.quality || detectQuality(a.title || '')] || 0;
    const qualityB = config.heuristics.qualityOrder[b._rankMeta?.quality || detectQuality(b.title || '')] || 0;
    if (qualityB !== qualityA) return qualityB - qualityA;

    const sizeA = normalizeNumber(a._size || a.sizeBytes || 0);
    const sizeB = normalizeNumber(b._size || b.sizeBytes || 0);
    if (sizeB !== sizeA) return sizeB - sizeA;

    const seedA = normalizeNumber(a.seeders);
    const seedB = normalizeNumber(b.seeders);
    if (seedB !== seedA) return seedB - seedA;

    const ageA = detectUploadTimestamp(a);
    const ageB = detectUploadTimestamp(b);
    if (ageA !== ageB) return ageB - ageA;

    return normalizeText(a.title || a.name).localeCompare(normalizeText(b.title || b.name));
  });

  return ranked;
}
module.exports = {
  rankAndFilterResults,
  DEFAULT_CONFIG,
  parseSizeToBytes,
  computeScore,
  detectQuality,
  detectItalianAudio,
  detectEnglishAudio,
  detectOtherLanguage,
  detectMultiAudio,
  resolveLangMode,
  shouldKeepByLanguageMode,
};
