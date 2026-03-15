const DEFAULT_CONFIG = {
  weights: {
    quality4K: 50000000,
    quality1080p: 20000000,
    quality720p: 100,
    qualitySD: 0,

    languageITA: 500000,
    languageMULTI: 250000,

    hevcBonus: 5000,
    hdrBonus: 5000,
    exactEpisodeBoost: 20000,
    seasonPackBonus: 10000,

    camPenalty: -100000000,
    sizeMismatchPenalty: -5000,

    sourceCorsaroBonus: 5000,
    seedersFactor: 1,
    seedersTrustBoost: 100,

    ageDecayPerDay: -1,
    hashKnownBonus: 2000,
  },
  heuristics: {
    camRegex: /\b(cam|ts|telecine|telesync|camrip|cam\.|hdcam|hdtc)\b/i,
    packRegex: /\b(pack|complete|tutta|tutte|full ?season|season ?pack|stagione ?(?:completa|complete)?|serie completa)\b/i,
    itaPatterns: [
      /\b(?:ITALIAN|ITALIANO)\b/i,
      /\b(?:AUDIO|LINGUA)\s*[:\-]?\s*(?:ITA|IT|ITALIANO)\b/i,
      /\b(?:AC-?3|AAC|DDP?|DTS|PCM|TRUEHD|ATMOS|MP3|WMA|FLAC)[^\n]{0,24}\b(?:ITA|IT|ITALIANO)\b/i,
      /\b(?:MULTI|DUAL|TRIPLE)[^\n]{0,24}\b(?:ITA|IT|ITALIANO)\b/i,
    ],
    multiPatterns: [/\b(MULTI|MULTILANG|MULTILANGUAGE|ITA[._ -]?ENG|ITA-ENG|DUAL)\b/i],
    subtitleOnlyPatterns: [/\b(?:SUB|SUBS|SOTTOTITOLI|SUB[._ -]?ITA|SUB-?ITA)\b/i],
    minimalSizeBytes: 150 * 1024 * 1024,
  },
  trust: {
    sourceTrust: { Corsaro: 1.0, Knaben: 1.0 },
    groupReputation: { FAKEGRP: -1.0 },
  },
  userReportsDB: {},
  misc: { nowTimestamp: () => Date.now() },
};

function normalizeNumber(n) {
  if (typeof n === 'number') return Number.isFinite(n) ? n : 0;
  if (typeof n === 'string') {
    const cleaned = n.replace(/[^\d.,-]/g, '').replace(',', '.');
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

  const match = raw.match(/([\d.,]+)\s*(B|BYTE|BYTES|KB|KIB|MB|MIB|GB|GIB|TB|TIB)/i);
  if (!match) return 0;

  const amount = parseFloat(match[1].replace(',', '.'));
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

function deepMergeConfig(optConfig = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...optConfig,
    weights: { ...DEFAULT_CONFIG.weights, ...(optConfig.weights || {}) },
    heuristics: { ...DEFAULT_CONFIG.heuristics, ...(optConfig.heuristics || {}) },
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

function detectItalianAudio(item, config) {
  const source = lowerText(item.source || item.provider);
  const title = normalizeText(item.title);
  const loweredTitle = title.toLowerCase();

  if (/\b(corsaro|knaben)\b/i.test(source)) return true;

  const hasSubtitleOnlyMarker = config.heuristics.subtitleOnlyPatterns.some((pattern) => pattern.test(title));
  const hasStrongItaMarker = config.heuristics.itaPatterns.some((pattern) => pattern.test(title));

  if (hasStrongItaMarker) return true;

  if (hasSubtitleOnlyMarker) return false;

  return /\b(?:ita|italian|italiano)\b/i.test(loweredTitle);
}

function detectMultiAudio(item, config) {
  const title = normalizeText(item.title);
  return config.heuristics.multiPatterns.some((pattern) => pattern.test(title));
}

function buildEpisodeMatchers(meta = {}) {
  const season = Number.isInteger(meta.season) ? meta.season : parseInt(meta.season, 10);
  const episode = Number.isInteger(meta.episode) ? meta.episode : parseInt(meta.episode, 10);

  if (!Number.isFinite(season) || !Number.isFinite(episode)) return [];

  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');

  return [
    new RegExp(`\\bS?${s}E${e}\\b`, 'i'),
    new RegExp(`\\b${season}x${episode}\\b`, 'i'),
    new RegExp(`\\bS${s}\\s*E${e}\\b`, 'i'),
  ];
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

function computeScore(item, meta, config) {
  let score = 0;
  const reasons = [];
  const title = normalizeText(item.title);
  const loweredTitle = title.toLowerCase();
  const source = lowerText(item.source || item.provider);
  const quality = detectQuality(title);

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

  const isIta = detectItalianAudio(item, config);
  const isMulti = !isIta && detectMultiAudio(item, config);

  if (isIta) {
    score += config.weights.languageITA;
    reasons.push('ITA');
  } else if (isMulti) {
    score += config.weights.languageMULTI;
    reasons.push('MULTI');
  }

  if (/\b(x265|h265|hevc)\b/i.test(loweredTitle)) {
    score += config.weights.hevcBonus;
    reasons.push('HEVC');
  }

  if (/\b(hdr|hdr10\+?|dolby\s*vision|dv)\b/i.test(loweredTitle)) {
    score += config.weights.hdrBonus;
    reasons.push('HDR');
  }

  const episodeMatchers = buildEpisodeMatchers(meta);
  if (episodeMatchers.length && episodeMatchers.some((re) => re.test(title))) {
    score += config.weights.exactEpisodeBoost;
    reasons.push('EXACT_EPISODE');
  }

  if (config.heuristics.packRegex.test(title)) {
    score += config.weights.seasonPackBonus;
    reasons.push('PACK');
  }

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

  if (/\bcorsaro\b/i.test(source)) {
    score += config.weights.sourceCorsaroBonus;
    reasons.push('SOURCE:CORSARO');
  }

  if (config.heuristics.camRegex.test(loweredTitle)) {
    score += config.weights.camPenalty;
    reasons.push('CAM');
  }

  const hash = normalizeText(item.infoHash || item.hash || item.magnetHash);
  if (hash) {
    score += config.weights.hashKnownBonus;
    reasons.push('HASH');
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

  return { score, reasons };
}

function rankAndFilterResults(results = [], meta = {}, optConfig = {}) {
  const config = deepMergeConfig(optConfig);
  if (!Array.isArray(results)) return [];

  const ranked = results.map((item) => {
    const sizeBytes = parseSizeToBytes(item.sizeBytes || item.size || item._size);
    const cloned = { ...item, _size: sizeBytes || item._size || 0 };

    if (sizeBytes > 0 && sizeBytes < config.heuristics.minimalSizeBytes) {
      return {
        ...cloned,
        _score: -999999999,
        _reasons: ['SIZE_TOO_SMALL'],
      };
    }

    const { score, reasons } = computeScore(cloned, meta, config);
    return {
      ...cloned,
      _score: score,
      _reasons: reasons,
    };
  });

  ranked.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    const sizeA = normalizeNumber(a._size || a.sizeBytes || 0);
    const sizeB = normalizeNumber(b._size || b.sizeBytes || 0);
    if (sizeB !== sizeA) return sizeB - sizeA;
    const seedA = normalizeNumber(a.seeders);
    const seedB = normalizeNumber(b.seeders);
    if (seedB !== seedA) return seedB - seedA;
    return normalizeText(a.title).localeCompare(normalizeText(b.title));
  });

  return ranked;
}

module.exports = {
  rankAndFilterResults,
  DEFAULT_CONFIG,
  parseSizeToBytes,
  computeScore,
};
