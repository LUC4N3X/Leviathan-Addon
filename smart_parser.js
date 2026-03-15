const FuzzySet = require("fuzzyset");

const ULTRA_JUNK_TOKENS = new Set([
  
  "h264", "x264", "h265", "x265", "hevc", "1080p", "720p", "4k", "2160p",
  "1080i", "720i", "480p", "sd", "hd", "fhd", "uhd", "sdr", "hdr", "dv", "vision",
  
  "web", "webdl", "webrip", "bluray", "rip", "bdrip", "dvdrip", "hdrip", "brrip",
  "tsrip", "camrip", "cam", "ts", "hdtv", "mkv", "mp4", "avi", "divx", "xvid",
  
  "ac3", "aac", "dts", "truehd", "atmos", "dd5", "ddp5", "stereo", "dolby", "dub",
  
  "ita", "eng", "multi", "sub", "subs", "forced", "hardcoded", "softsubs",

  "repack", "remux", "proper", "complete", "pack", "season", "stagione",
  "episode", "episodio", "vol", "extended", "directors", "cut", "unrated",
  "theatrical", "imax", "series",
  
  "netflix", "amazon", "disney", "hulu", "hbo", "prime", "amzn", "dsnp", "nf",
  
  "torrent", "magnet", "ddl", "rarbg", "knaben"
]);

const ULTRA_STOP_WORDS = new Set([
  "il", "lo", "la", "i", "gli", "le", "l", "un", "uno", "una",
  "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
  "e", "ed", "o", "ma", "se", "che",
  "del", "dello", "della", "dei", "degli", "delle", "dell",
  "al", "allo", "alla", "ai", "agli", "alle", "all",
  "dal", "dallo", "dalla", "dai", "dagli", "dalle", "dall",
  "nel", "nello", "nella", "nei", "negli", "nelle", "nell",
  "sul", "sullo", "sulla", "sui", "sugli", "sulle", "sull",
  "col", "coi",
  "the", "an", "of", "to", "for", "on", "by", "at", "from", "with", "into", "onto",
  "and", "or", "nor", "but", "is", "are", "was", "were", "be", "been",
  "that", "this", "these", "those", "my", "your", "his", "her", "its", "our", "their",
  "feat", "ft", "vs", "versus", "pt", "part", "chapter", "capitolo"
]);

const ULTRA_FORBIDDEN_EXPANSIONS = new Set([
  "new", "blood", "resurrection", "returns", "reborn",
  "origins", "legacy", "revival", "sequel",
  "redemption", "evolution", "remake", "reimagined", "bootleg",
  "unaired", "pilot", "bride", "son", "curse", "revenge"
]);

const FORBIDDEN_REGEX = [/fanfic/i, /parody/i, /spoof/i, /mock/i, /fake/i];

const ULTRA_SPINOFF_GRAPH = {
  "star wars": { spinoffs: ["mandalorian", "andor", "obi wan", "obi wan kenobi", "obi wan", "ahsoka", "book of boba fett", "bad batch", "tales of the jedi", "visions", "resistance", "rebels", "clone wars", "acolyte", "skeleton crew"] },
  "star trek": { spinoffs: ["next generation", "tng", "deep space nine", "ds9", "voyager", "enterprise", "discovery", "picard", "strange new worlds", "lower decks", "prodigy", "short treks"] },
  "game of thrones": { spinoffs: ["house of the dragon", "snow", "knight of the seven kingdoms"] },
  "the walking dead": { spinoffs: ["dead city", "world beyond", "fear the walking dead", "daryl dixon", "ones who live", "tales of the walking dead"] },
  "doctor who": { spinoffs: ["torchwood", "sarah jane adventures", "class"] },
  "the boys": { spinoffs: ["gen v", "diabolical"] },
  "dune": { spinoffs: ["prophecy", "sisterhood"] },
  "the witcher": { spinoffs: ["blood origin", "nightmare of the wolf", "sirens of the deep"] },
  "vikings": { spinoffs: ["valhalla"] },
  "money heist": { spinoffs: ["berlin", "korea"] },
  "la casa de papel": { spinoffs: ["berlin", "corea"] },
  "bridgerton": { spinoffs: ["queen charlotte"] },
  "csi": { spinoffs: ["miami", "ny", "cyber", "vegas"] },
  "ncis": { spinoffs: ["los angeles", "new orleans", "hawaii", "sydney", "origins"] },
  "criminal minds": { spinoffs: ["suspect behavior", "beyond borders", "evolution"] },
  "law and order": { spinoffs: ["special victims unit", "svu", "criminal intent", "organized crime", "trial by jury", "la", "true crime"] },
  "chicago": { spinoffs: ["pd", "fire", "med", "justice"] },
  "fbi": { spinoffs: ["most wanted", "international"] },
  "911": { spinoffs: ["lone star"] },
  "rookie": { spinoffs: ["feds"] },
  "yellowstone": { spinoffs: ["1883", "1923", "6666", "1944"] },
  "breaking bad": { spinoffs: ["better call saul", "el camino"] },
  "dexter": { spinoffs: ["new blood", "original sin"] },
  "power": { spinoffs: ["book ii", "book 2", "ghost", "book iii", "book 3", "raising kanan", "book iv", "book 4", "force"] },
  "suits": { spinoffs: ["pearson", "la"] },
  "pretty little liars": { spinoffs: ["ravenswood", "perfectionists", "original sin", "summer school"] },
  "gossip girl": { spinoffs: ["2021"] },
  "dragon ball": { spinoffs: ["z", "super", "gt", "kai", "daima", "heroes"] },
  "naruto": { spinoffs: ["shippuden", "boruto", "rock lee"] },
  "one piece": { spinoffs: ["film red", "stampede", "gold", "strong world", "z"] },
  "saint seiya": { spinoffs: ["lost canvas", "omega", "soul of gold", "saintia sho", "knights of the zodiac"] },
  "jojo": { spinoffs: ["rohan"] },
  "pokemon": { spinoffs: ["horizons", "concierge", "generations", "evolutions"] },
  "90 day fiance": { spinoffs: ["happily ever after", "before the 90 days", "the other way", "single life", "pillow talk", "uk", "love in paradise"] },
  "rupaul": { spinoffs: ["all stars", "untucked", "uk", "canada", "down under", "italia", "espana", "philippines", "thailand", "vs the world", "global"] },
  "below deck": { spinoffs: ["mediterranean", "sailing yacht", "down under", "adventure"] },
  "real housewives": { spinoffs: ["beverly hills", "atlanta", "potomac", "salt lake city", "miami", "new york", "orange county", "new jersey", "dubai"] },
  "bachelor": { spinoffs: ["bachelorette", "paradise", "winter games", "golden"] },
  "american horror story": { spinoffs: ["american horror stories"] },
  "the conjuring": { spinoffs: ["annabelle", "nun", "curse of la llorona"] },
  "insidious": { spinoffs: ["chapter 2", "chapter 3", "last key", "red door"] }
};

function romanToArabic(str) {
  const map = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  let prev = 0;
  const lower = String(str || "").toLowerCase();
  for (const c of lower.split("").reverse()) {
    const val = map[c] || 0;
    total += val < prev ? -val : val;
    prev = val;
  }
  return total;
}

function normalizeTitle(t) {
  if (!t) return "";
  return String(t)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`:;\-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, m => String(romanToArabic(m)))
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(str) {
  return normalizeTitle(str).split(/\s+/).filter(Boolean);
}

function buildCleanTokens(str, { dropJunk = false } = {}) {
  return tokenize(str).filter(t => !ULTRA_STOP_WORDS.has(t) && (!dropJunk || !ULTRA_JUNK_TOKENS.has(t)));
}

function extractEpisodeInfo(filename) {
  const upper = String(filename || "").toUpperCase();

  const sxeMatch = upper.match(/\bS(\d{1,2})(?:[._\s-]*E|X)(\d{1,3})\b/);
  if (sxeMatch) return { season: parseInt(sxeMatch[1], 10), episode: parseInt(sxeMatch[2], 10) };

  const xMatch = upper.match(/\b(\d{1,2})X(\d{1,3})\b/);
  if (xMatch) return { season: parseInt(xMatch[1], 10), episode: parseInt(xMatch[2], 10) };

  const itaMatch = upper.match(/\bSTAGIONE\s*(\d{1,2}).*?EPISODIO\s*(\d{1,3})\b/);
  if (itaMatch) return { season: parseInt(itaMatch[1], 10), episode: parseInt(itaMatch[2], 10) };

  const seasonMatch = upper.match(/\b(?:S|SEASON|STAGIONE|STG)[._\s-]*(\d{1,2})\b/);
  const epMatch = upper.match(/\b(?:EPISODE|EP|EPISODIO|E)\s*\.?\s*(\d{1,3})\b/);
  if (seasonMatch && epMatch) {
    return { season: parseInt(seasonMatch[1], 10), episode: parseInt(epMatch[1], 10) };
  }

  return null;
}

function extractYear(filename) {
  const match = String(filename || "").match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

function containsPhrase(text, phrase) {
  return text.includes(phrase);
}

function isUnwantedSpinoff(cleanMeta, cleanFile) {
  for (const [parent, data] of Object.entries(ULTRA_SPINOFF_GRAPH)) {
    if (!containsPhrase(cleanMeta, parent)) continue;

    const searchingSpecificSpinoff = data.spinoffs.some(sp => containsPhrase(cleanMeta, sp));
    if (searchingSpecificSpinoff) continue;

    for (const sp of data.spinoffs) {
      if (containsPhrase(cleanFile, sp)) return true;
    }
  }
  return false;
}

function overlapRatio(metaTokens, fileTokens) {
  const uniqueMeta = [...new Set(metaTokens)];
  if (uniqueMeta.length === 0) return 0;
  let matched = 0;
  for (const mt of uniqueMeta) {
    if (fileTokens.some(ft => ft === mt || (mt.length > 3 && ft.includes(mt)))) {
      matched += 1;
    }
  }
  return matched / uniqueMeta.length;
}

function checkTitleMatch(mTokens, fTokens, cleanMetaString, cleanFileString) {
  if (!mTokens.length) return false;

  if (cleanMetaString.length <= 4) {
    return overlapRatio(mTokens, fTokens) >= 1;
  }

  const fuzzy = FuzzySet([cleanMetaString]).get(cleanFileString);
  if (fuzzy && fuzzy[0] && fuzzy[0][0] > 0.9) return true;

  return overlapRatio(mTokens, fTokens) >= 0.9;
}

function auditNumbers(filename, metaSeason, metaEpisode) {
  const clean = String(filename || "").replace(/[^0-9]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return true;

  const numbers = clean.split(" ").map(n => parseInt(n, 10)).filter(Number.isFinite);
  const safeTechnicalValues = new Set([
    1080, 720, 2160, 480,
    264, 265,
    10, 8, 12,
    51, 71, 20, 21, 5, 7, 2,
    metaSeason,
    metaEpisode
  ].filter(v => Number.isFinite(v)));

  const currentYear = new Date().getFullYear();

  for (const num of numbers) {
    if (num >= 1900 && num <= currentYear + 2) continue;
    if (safeTechnicalValues.has(num)) continue;
    if (num < 100) return false;
  }

  return true;
}

function hasForbiddenExpansion(cleanMetaString, cleanFileString, mTokens, fTokens) {
  const isCleanSearch = !mTokens.some(mt => ULTRA_FORBIDDEN_EXPANSIONS.has(mt));
  if (!isCleanSearch) return false;

  if (fTokens.some(ft => ULTRA_FORBIDDEN_EXPANSIONS.has(ft))) return true;

  const multiWordExpansions = [
    "dead city", "world beyond", "fear the walking dead", "extended edition", "new blood"
  ];
  return multiWordExpansions.some(exp => cleanFileString.includes(exp) && !cleanMetaString.includes(exp));
}

function isSeasonPack(filename, metaSeason) {
  if (!Number.isFinite(metaSeason)) return false;
  const match = String(filename || "").match(/(?:\bS|\bSeason|\bStagione|\bStg)[._\s-]*(\d{1,2})(?!\d|E|x)/i);
  return !!match && parseInt(match[1], 10) === metaSeason;
}

function smartMatch(metaTitle, filename, isSeries = false, metaSeason = null, metaEpisode = null, metaYear = null) {
  if (!filename || !metaTitle) return false;

  const fLower = String(filename).toLowerCase();
  if (FORBIDDEN_REGEX.some(r => r.test(fLower))) return false;
  if (/(^|\b)(sample|trailer|bonus)(\b|$)/i.test(fLower)) return false;

  const cleanMetaString = normalizeTitle(metaTitle);
  const cleanFileString = normalizeTitle(filename);

  if (isUnwantedSpinoff(cleanMetaString, cleanFileString)) return false;

  const fTokens = buildCleanTokens(filename, { dropJunk: true });
  const mTokens = buildCleanTokens(metaTitle, { dropJunk: false });
  if (mTokens.length === 0) return false;

  if (cleanMetaString.length <= 4) {
    for (let i = 0; i < mTokens.length; i += 1) {
      if (fTokens[i] !== mTokens[i]) return false;
    }
    if (fTokens.length > mTokens.length) {
      const nextToken = fTokens[mTokens.length];
      const isSeason = /^(s\d+|e\d+|\d+x\d+|stagione|season)$/i.test(nextToken);
      const isYear = /^(19|20)\d{2}$/.test(nextToken);
      const isTech = ULTRA_JUNK_TOKENS.has(nextToken);
      if (!isSeason && !isYear && !isTech) return false;
    }
  }

  if (hasForbiddenExpansion(cleanMetaString, cleanFileString, mTokens, fTokens)) return false;

  if (isSeries && Number.isFinite(metaSeason)) {
    if (!auditNumbers(filename, metaSeason, metaEpisode)) return false;

    const epInfo = extractEpisodeInfo(filename);
    if (epInfo) {
      if (epInfo.season !== metaSeason) return false;
      if (Number.isFinite(metaEpisode) && epInfo.episode !== metaEpisode) return false;
      return checkTitleMatch(mTokens, fTokens, cleanMetaString, cleanFileString);
    }

    if (isSeasonPack(filename, metaSeason)) {
      return checkTitleMatch(mTokens, fTokens, cleanMetaString, cleanFileString);
    }

    return false;
  }

  if (Number.isFinite(metaYear)) {
    const fileYear = extractYear(filename);
    if (fileYear && Math.abs(fileYear - metaYear) >= 1) {
      const strictFuzzy = FuzzySet([cleanMetaString]).get(cleanFileString);
      if (!strictFuzzy || !strictFuzzy[0] || strictFuzzy[0][0] < 0.95) return false;
    }
  }

  return checkTitleMatch(mTokens, fTokens, cleanMetaString, cleanFileString);
}

module.exports = {
  smartMatch,
  normalizeTitle,
  tokenize,
  extractEpisodeInfo,
  extractYear,
  auditNumbers
};
