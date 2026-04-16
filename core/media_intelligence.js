const { resolveLangMode: canonicalResolveLangMode } = require('./canonical/language_rules');

const STOP_WORDS = new Set([
  'il','lo','la','i','gli','le','l','un','uno','una','di','a','da','in','con','su','per','tra','fra',
  'e','ed','o','ma','se','che','del','dello','della','dei','degli','delle','dell','al','allo','alla','ai','agli','alle','all',
  'dal','dallo','dalla','dai','dagli','dalle','dall','nel','nello','nella','nei','negli','nelle','nell','sul','sullo','sulla','sui','sugli','sulle','sull',
  'col','coi','the','a','an','of','to','for','on','by','at','from','with','into','onto','and','or','nor','but','is','are','was','were','be','been',
  'that','this','these','those','my','your','his','her','its','our','their','feat','ft','vs','versus','pt','part','chapter','capitolo','movie','film'
]);

const JUNK_TOKENS = new Set([
  'h264','x264','h265','x265','hevc','1080p','720p','4k','2160p','1080i','720i','480p','sd','hd','fhd','uhd','sdr','hdr','dv','vision',
  'web','webdl','web-dl','webrip','bluray','rip','bdrip','dvdrip','hdrip','brrip','tsrip','camrip','cam','ts','hdtv','mkv','mp4','avi','divx','xvid','av1','vp9',
  'ac3','aac','dts','truehd','atmos','dd5','ddp5','stereo','dolby','dub','ita','eng','multi','sub','subita','subs','forced','hardcoded','softsubs','dual','audio',
  'repack','remux','proper','complete','pack','season','stagione','episode','episodio','vol','extended','directors','director','cut','unrated','uncut','theatrical','imax','series',
  'netflix','amazon','disney','hulu','hbo','prime','amzn','dsnp','nf','torrent','magnet','ddl','rarbg','knaben'
]);

const FORBIDDEN_EXPANSIONS = new Set([
  'new','blood','resurrection','returns','reborn','origins','legacy','revival','sequel','redemption','evolution','remake','reimagined','bootleg','unaired','pilot','bride','son','curse','revenge'
]);

const FORBIDDEN_REGEX = [/fanfic/i, /parody/i, /spoof/i, /mock/i, /fake/i];

const SEMANTIC_ALIASES = {
  'harry potter': ['hp','pietra filosofale','camera segreti','prigioniero azkaban','calice fuoco','ordine fenice','principe mezzosangue','doni morte'],
  'il signore degli anelli': ['lord of the rings','lotr','compagnia anello','due torri','ritorno re'],
  'fast and furious': ['fast & furious','fast x','f10'],
  'la casa di carta': ['money heist','la casa de papel'],
  'il trono di spade': ['game of thrones','got'],
  "l attacco dei giganti": ['attack on titan','aot','shingeki no kyojin'],
  'one piece': ['one piece','op'],
  'demon slayer': ['kimetsu no yaiba'],
  'jujutsu kaisen': ['sorcery fight'],
  'my hero academia': ['boku no hero academia'],
  'star wars': ['guerre stellari'],
  'the avengers': ['avengers']
};

const SPINOFF_GRAPH = {
  'star wars': { spinoffs: ['mandalorian','andor','obi wan','obi wan kenobi','ahsoka','book of boba fett','bad batch','tales of the jedi','visions','resistance','rebels','clone wars','acolyte','skeleton crew'] },
  'star trek': { spinoffs: ['next generation','tng','deep space nine','ds9','voyager','enterprise','discovery','picard','strange new worlds','lower decks','prodigy','short treks'] },
  'game of thrones': { spinoffs: ['house of the dragon','snow','knight of the seven kingdoms'] },
  'the walking dead': { spinoffs: ['dead city','world beyond','fear the walking dead','daryl dixon','ones who live','tales of the walking dead'] },
  'doctor who': { spinoffs: ['torchwood','sarah jane adventures','class'] },
  'the boys': { spinoffs: ['gen v','diabolical'] },
  'dune': { spinoffs: ['prophecy','sisterhood'] },
  'the witcher': { spinoffs: ['blood origin','nightmare of the wolf','sirens of the deep'] },
  'vikings': { spinoffs: ['valhalla'] },
  'money heist': { spinoffs: ['berlin','korea'] },
  'la casa de papel': { spinoffs: ['berlin','corea'] },
  'bridgerton': { spinoffs: ['queen charlotte'] },
  'csi': { spinoffs: ['miami','ny','cyber','vegas'] },
  'ncis': { spinoffs: ['los angeles','new orleans','hawaii','sydney','origins'] },
  'criminal minds': { spinoffs: ['suspect behavior','beyond borders','evolution'] },
  'law and order': { spinoffs: ['special victims unit','svu','criminal intent','organized crime','trial by jury','la','true crime'] },
  'chicago': { spinoffs: ['pd','fire','med','justice'] },
  'fbi': { spinoffs: ['most wanted','international'] },
  '911': { spinoffs: ['lone star'] },
  'rookie': { spinoffs: ['feds'] },
  'yellowstone': { spinoffs: ['1883','1923','6666','1944'] },
  'breaking bad': { spinoffs: ['better call saul','el camino'] },
  'dexter': { spinoffs: ['new blood','original sin'] },
  'power': { spinoffs: ['book ii','book 2','ghost','book iii','book 3','raising kanan','book iv','book 4','force'] },
  'suits': { spinoffs: ['pearson','la'] },
  'pretty little liars': { spinoffs: ['ravenswood','perfectionists','original sin','summer school'] },
  'gossip girl': { spinoffs: ['2021'] },
  'dragon ball': { spinoffs: ['z','super','gt','kai','daima','heroes'] },
  'naruto': { spinoffs: ['shippuden','boruto','rock lee'] },
  'one piece': { spinoffs: ['film red','stampede','gold','strong world','z'] },
  'saint seiya': { spinoffs: ['lost canvas','omega','soul of gold','saintia sho','knights of the zodiac'] },
  'jojo': { spinoffs: ['rohan'] },
  'pokemon': { spinoffs: ['horizons','concierge','generations','evolutions'] },
  'american horror story': { spinoffs: ['american horror stories'] },
  'the conjuring': { spinoffs: ['annabelle','nun','curse of la llorona'] },
  'insidious': { spinoffs: ['chapter 2','chapter 3','last key','red door'] }
};

function romanToArabic(str) {
  const map = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  let prev = 0;
  for (const c of String(str || '').toLowerCase().split('').reverse()) {
    const val = map[c] || 0;
    total += val < prev ? -val : val;
    prev = val;
  }
  return total;
}

function normalizeTitle(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[’'`:;,.!?\-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, m => String(romanToArabic(m)))
    .replace(/\s+/g, ' ')
    .trim();
}

function ultraNormalizeTitle(value) {
  return normalizeTitle(value);
}

function tokenize(value) {
  return normalizeTitle(value).split(/\s+/).filter(Boolean);
}

function buildCleanTokens(value, { dropJunk = false } = {}) {
  return tokenize(value).filter(token => !STOP_WORDS.has(token) && (!dropJunk || !JUNK_TOKENS.has(token)));
}

function stripArticles(title) {
  if (!title) return null;
  const stripped = normalizeTitle(title).replace(/^(the|il|lo|la|i|gli|le|un|uno|una|a|an)\s+/i, '').trim();
  return stripped && stripped !== normalizeTitle(title) ? stripped : null;
}

function getNumericVariants(title) {
  const normalized = normalizeTitle(title);
  if (!normalized) return [];
  const romanMap = { ' 1 ': ' i ', ' 2 ': ' ii ', ' 3 ': ' iii ', ' 4 ': ' iv ', ' 5 ': ' v ', ' 6 ': ' vi ', ' 7 ': ' vii ', ' 8 ': ' viii ', ' 9 ': ' ix ', ' 10 ': ' x ' };
  const arabicMap = Object.fromEntries(Object.entries(romanMap).map(([a, b]) => [b, a]));
  const padded = ` ${normalized} `;
  const variants = new Set();
  for (const [from, to] of Object.entries(romanMap)) if (padded.includes(from)) variants.add(padded.replace(from, to).trim());
  for (const [from, to] of Object.entries(arabicMap)) if (padded.includes(from)) variants.add(padded.replace(from, to).trim());
  return [...variants];
}

function containsPhrase(text, phrase) {
  return String(text || '').includes(String(phrase || ''));
}

function autoExpandAliases(cleanTitle) {
  const normalized = normalizeTitle(cleanTitle);
  const aliases = new Set();
  for (const [key, variants] of Object.entries(SEMANTIC_ALIASES)) {
    const nKey = normalizeTitle(key);
    if (normalized.includes(nKey) || nKey.includes(normalized)) {
      for (const variant of variants) aliases.add(normalizeTitle(variant));
    }
  }
  return [...aliases].filter(Boolean);
}

function commonWordsOnly(text) {
  const normalized = normalizeTitle(text);
  if (!normalized) return true;
  return normalized.split(' ').every(word => STOP_WORDS.has(word));
}

function expandBaseTitles(base, originalTitle = '', dynamicAliases = []) {
  const titles = new Set();
  const enqueue = value => {
    const normalized = normalizeTitle(value);
    if (!normalized || normalized.length < 2) return;
    titles.add(normalized);
    const stripped = stripArticles(normalized);
    if (stripped && stripped.length > 2) titles.add(stripped);
    for (const variant of getNumericVariants(normalized)) titles.add(variant);
    if (normalized.includes(':') || normalized.includes('-')) {
      const firstPart = normalizeTitle(normalized.split(/[:\-]/)[0]);
      if (firstPart.length > 3 && !commonWordsOnly(firstPart)) titles.add(firstPart);
    }
  };
  enqueue(base);
  enqueue(originalTitle);
  for (const alias of dynamicAliases || []) enqueue(alias);
  const current = [...titles];
  for (const title of current) for (const alias of autoExpandAliases(title)) enqueue(alias);
  return [...titles].filter(Boolean);
}

function resolveLangMode(meta = {}, allowEngOrLangMode = false) {
  if (typeof allowEngOrLangMode === 'string') {
    return canonicalResolveLangMode({ language: allowEngOrLangMode, meta, defaultMode: 'ita' });
  }
  if (allowEngOrLangMode && typeof allowEngOrLangMode === 'object') {
    return canonicalResolveLangMode({ ...allowEngOrLangMode, meta, defaultMode: 'ita' });
  }
  return canonicalResolveLangMode({ allowEng: Boolean(allowEngOrLangMode), meta, defaultMode: 'ita' });
}

function isAnimeMeta(meta = {}) {
  return Boolean(meta?.kitsu_id || meta?.isAnime || String(meta?.type || '').toLowerCase() === 'anime');
}

function collectMetaAliases(meta = {}) {
  return [
    ...(Array.isArray(meta?.aka_titles) ? meta.aka_titles : []),
    ...(Array.isArray(meta?.aliases) ? meta.aliases : []),
    ...(Array.isArray(meta?.titles) ? meta.titles : []),
    ...(Array.isArray(meta?.alternativeTitles) ? meta.alternativeTitles : []),
    ...(Array.isArray(meta?.altTitles) ? meta.altTitles : [])
  ].filter(Boolean);
}

function getTitleCandidates(meta = {}, dynamicAliases = [], allowEngOrLangMode = false) {
  const aliasPool = [...collectMetaAliases(meta), ...(Array.isArray(dynamicAliases) ? dynamicAliases : [dynamicAliases])].filter(Boolean);
  const primary = expandBaseTitles(meta.title || '', meta.originalTitle || meta.originalName || '', aliasPool);
  const langMode = resolveLangMode(meta, allowEngOrLangMode);
  const ita = new Set(primary);
  const eng = new Set();
  if (langMode === 'eng' || langMode === 'all') {
    for (const title of primary) eng.add(title);
  }
  return { ita: [...ita], eng: [...eng], langMode };
}

function generateSmartQueries(meta = {}, dynamicAliases = [], allowEngOrLangMode = false) {
  const { year, season, episode, isSeries } = meta || {};
  const animeAbsoluteEpisode = Number(meta.anime_absolute_episode || meta.requested_kitsu_episode || meta.anime_episode || 0);
  const { ita, eng, langMode } = getTitleCandidates(meta, dynamicAliases, allowEngOrLangMode);
  const animeMode = isAnimeMeta(meta);
  const sNum = Number(season);
  const eNum = Number(episode);
  const yNum = Number(year);
  const sStr = Number.isFinite(sNum) && sNum > 0 ? String(sNum).padStart(2, '0') : '';
  const eStr = Number.isFinite(eNum) && eNum > 0 ? String(eNum).padStart(2, '0') : '';
  const finalQueries = [];

  const itaQueries = new Set();
  if (langMode === 'ita' || langMode === 'all') {
    for (const title of ita) {
      if (isSeries) {
        if (animeMode) {
          if (Number.isFinite(eNum) && eNum > 0) {
            itaQueries.add(`${title} - ${eStr}`);
            itaQueries.add(`${title} ${eStr}`);
            itaQueries.add(`${title} episodio ${eNum}`);
            itaQueries.add(`${title} episode ${eNum}`);
            if (animeAbsoluteEpisode > 0 && animeAbsoluteEpisode !== eNum) {
              itaQueries.add(`${title} episodio ${animeAbsoluteEpisode}`);
              itaQueries.add(`${title} episode ${animeAbsoluteEpisode}`);
              itaQueries.add(`${title} - ${String(animeAbsoluteEpisode).padStart(2, '0')}`);
            }
            if (Number.isFinite(sNum) && sNum > 1) {
              itaQueries.add(`${title} S${sNum} - ${eStr}`);
              itaQueries.add(`${title} stagione ${sNum} episodio ${eNum}`);
              itaQueries.add(`${title} season ${sNum} episode ${eNum}`);
            }
          }
          if (Number.isFinite(yNum) && yNum > 0) {
            itaQueries.add(`${title} ${yNum}`);
            itaQueries.add(`${title} anime ${yNum}`);
          }
          itaQueries.add(`${title} anime`);
          itaQueries.add(`${title} batch`);
          itaQueries.add(`${title} complete`);
          itaQueries.add(`${title} pack`);
          itaQueries.add(title);
          itaQueries.add(`${title} ITA`);
          itaQueries.add(`${title} MULTI`);
        } else {
          if (Number.isFinite(eNum) && eNum > 0) {
            itaQueries.add(`${title} S${sStr}E${eStr} ITA`);
            itaQueries.add(`${title} S${sStr}E${eStr}`);
            itaQueries.add(`${title} ${sNum}x${eStr}`);
            itaQueries.add(`${title} episodio ${eNum}`);
          }
          if (Number.isFinite(sNum) && sNum > 0) {
            itaQueries.add(`${title} stagione ${sNum} ITA`);
            itaQueries.add(`${title} S${sStr} ITA`);
            itaQueries.add(`${title} stagione ${sNum}`);
          }
          itaQueries.add(`${title} ITA`);
        }
      } else {
        if (Number.isFinite(yNum) && yNum > 0) {
          itaQueries.add(`${title} ${yNum} ITA`);
          itaQueries.add(`${title} ${yNum}`);
          itaQueries.add(`${title} ${yNum - 1} ITA`);
          itaQueries.add(`${title} ${yNum + 1} ITA`);
        }
        itaQueries.add(`${title} ITA`);
        itaQueries.add(title);
      }
    }
  }

  const engQueries = new Set();
  if (langMode === 'eng' || langMode === 'all') {
    for (const title of eng) {
      if (isSeries) {
        if (animeMode) {
          if (Number.isFinite(eNum) && eNum > 0) {
            engQueries.add(`${title} - ${eStr}`);
            engQueries.add(`${title} ${eStr}`);
            engQueries.add(`${title} episode ${eNum}`);
            engQueries.add(`${title} ep ${eNum}`);
            if (animeAbsoluteEpisode > 0 && animeAbsoluteEpisode !== eNum) {
              engQueries.add(`${title} episode ${animeAbsoluteEpisode}`);
              engQueries.add(`${title} ep ${animeAbsoluteEpisode}`);
              engQueries.add(`${title} - ${String(animeAbsoluteEpisode).padStart(2, '0')}`);
            }
            if (Number.isFinite(sNum) && sNum > 1) {
              engQueries.add(`${title} S${sNum} - ${eStr}`);
              engQueries.add(`${title} season ${sNum} episode ${eNum}`);
            }
          }
          if (Number.isFinite(yNum) && yNum > 0) {
            engQueries.add(`${title} ${yNum}`);
            engQueries.add(`${title} anime ${yNum}`);
          }
          engQueries.add(`${title} anime`);
          engQueries.add(`${title} batch`);
          engQueries.add(`${title} complete`);
          engQueries.add(`${title} pack`);
          if (title.length >= 3 && !commonWordsOnly(title)) engQueries.add(title);
        } else {
          if (Number.isFinite(eNum) && eNum > 0) {
            engQueries.add(`${title} S${sStr}E${eStr}`);
            engQueries.add(`${title} ${sNum}x${eStr}`);
            engQueries.add(`${title} episode ${eNum}`);
          }
          if (Number.isFinite(sNum) && sNum > 0) {
            engQueries.add(`${title} season ${sNum}`);
            engQueries.add(`${title} S${sStr}`);
          }
        }
      } else {
        if (Number.isFinite(yNum) && yNum > 0) {
          engQueries.add(`${title} ${yNum}`);
          engQueries.add(`${title} ${yNum - 1}`);
          engQueries.add(`${title} ${yNum + 1}`);
        }
        if (title.length >= 3 && !commonWordsOnly(title)) engQueries.add(title);
      }
    }
  }

  if (langMode === 'eng') {
    finalQueries.push(...[...engQueries].sort((a, b) => b.length - a.length));
  } else if (langMode === 'all') {
    const itaSorted = [...itaQueries].sort((a, b) => b.length - a.length);
    const engSorted = [...engQueries].sort((a, b) => b.length - a.length);
    const maxLen = Math.max(itaSorted.length, engSorted.length);
    for (let i = 0; i < maxLen; i += 1) {
      if (itaSorted[i]) finalQueries.push(itaSorted[i]);
      if (engSorted[i]) finalQueries.push(engSorted[i]);
    }
  } else {
    finalQueries.push(...[...itaQueries].sort((a, b) => b.length - a.length));
  }

  const seen = new Set();
  return finalQueries.filter(q => {
    const key = normalizeTitle(q);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractEpisodeInfo(filename) {
  const upper = String(filename || '').toUpperCase();
  const sxe = upper.match(/\bS(\d{1,2})(?:[._\s-]*E|X)(\d{1,3})\b/);
  if (sxe) return { season: parseInt(sxe[1], 10), episode: parseInt(sxe[2], 10) };
  const x = upper.match(/\b(\d{1,2})X(\d{1,3})\b/);
  if (x) return { season: parseInt(x[1], 10), episode: parseInt(x[2], 10) };
  const ita = upper.match(/\bSTAGIONE\s*(\d{1,2}).*?(?:EPISODIO|EP)\s*(\d{1,3})\b/);
  if (ita) return { season: parseInt(ita[1], 10), episode: parseInt(ita[2], 10) };
  const season = upper.match(/\b(?:S|SEASON|STAGIONE|STG)[._\s-]*(\d{1,2})\b/);
  const ep = upper.match(/\b(?:EPISODE|EP|EPISODIO|E)\s*\.?\s*(\d{1,3})\b/);
  if (season && ep) return { season: parseInt(season[1], 10), episode: parseInt(ep[1], 10) };
  return null;
}

function extractYear(filename) {
  const match = String(filename || '').match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

function isSeasonPack(filename, metaSeason) {
  if (!Number.isFinite(metaSeason)) return false;
  const match = String(filename || '').match(/(?:\bS|\bSeason|\bStagione|\bStg)[._\s-]*(\d{1,2})(?!\d|E|x)/i);
  return !!match && parseInt(match[1], 10) === metaSeason;
}

function auditNumbers(filename, metaSeason, metaEpisode) {
  const clean = String(filename || '').replace(/[^0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return true;
  const numbers = clean.split(' ').map(v => parseInt(v, 10)).filter(Number.isFinite);
  const safe = new Set([1080,720,2160,480,264,265,10,8,12,51,71,20,21,5,7,2,metaSeason,metaEpisode].filter(Number.isFinite));
  const currentYear = new Date().getFullYear();
  for (const num of numbers) {
    if (num >= 1900 && num <= currentYear + 2) continue;
    if (safe.has(num)) continue;
    if (num < 100) return false;
  }
  return true;
}

function overlapRatio(metaTokens, fileTokens) {
  const uniqueMeta = [...new Set(metaTokens)];
  if (uniqueMeta.length === 0) return 0;
  let matched = 0;
  for (const metaToken of uniqueMeta) {
    if (fileTokens.some(fileToken => fileToken === metaToken || (metaToken.length > 3 && fileToken.includes(metaToken)))) matched += 1;
  }
  return matched / uniqueMeta.length;
}

function levenshtein(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    let current = [i];
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < current.length; j += 1) prev[j] = current[j];
  }
  return prev[y.length];
}

function ngrams(input, size = 3) {
  const text = `  ${String(input || '')}  `;
  const set = new Set();
  for (let i = 0; i <= text.length - size; i += 1) set.add(text.slice(i, i + size));
  return set;
}

function diceSimilarity(a, b) {
  const left = ngrams(a, 3);
  const right = ngrams(b, 3);
  if (!left.size || !right.size) return 0;
  let matches = 0;
  for (const gram of left) if (right.has(gram)) matches += 1;
  return (2 * matches) / (left.size + right.size);
}

function similarityScore(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  const dice = diceSimilarity(left, right);
  const lev = levenshtein(left, right);
  const maxLen = Math.max(left.length, right.length, 1);
  const levScore = 1 - lev / maxLen;
  return Math.max(dice, levScore * 0.97);
}

function containsAnyPhrase(text, phrases = []) {
  return phrases.some(phrase => containsPhrase(text, phrase));
}

function isUnwantedSpinoff(cleanMeta, cleanFile) {
  for (const [parent, data] of Object.entries(SPINOFF_GRAPH)) {
    if (!containsPhrase(cleanMeta, parent)) continue;
    const searchingSpecificSpinoff = containsAnyPhrase(cleanMeta, data.spinoffs);
    if (searchingSpecificSpinoff) continue;
    if (containsAnyPhrase(cleanFile, data.spinoffs)) return true;
  }
  return false;
}

function hasForbiddenExpansion(cleanMetaString, cleanFileString, metaTokens, fileTokens) {
  const isCleanSearch = !metaTokens.some(token => FORBIDDEN_EXPANSIONS.has(token));
  if (!isCleanSearch) return false;
  if (fileTokens.some(token => FORBIDDEN_EXPANSIONS.has(token))) return true;
  const multiWord = ['dead city','world beyond','fear the walking dead','extended edition','new blood'];
  return multiWord.some(entry => cleanFileString.includes(entry) && !cleanMetaString.includes(entry));
}

function checkTitleMatch(metaTokens, fileTokens, cleanMetaString, cleanFileString) {
  if (!metaTokens.length) return false;
  if (cleanMetaString.length <= 4) return overlapRatio(metaTokens, fileTokens) >= 1;
  if (cleanFileString.includes(cleanMetaString) || cleanMetaString.includes(cleanFileString)) return true;
  if (similarityScore(cleanMetaString, cleanFileString) > 0.91) return true;
  return overlapRatio(metaTokens, fileTokens) >= 0.9;
}

function smartMatch(metaTitle, filename, isSeries = false, metaSeason = null, metaEpisode = null, metaYear = null) {
  if (!filename || !metaTitle) return false;
  const lower = String(filename).toLowerCase();
  if (FORBIDDEN_REGEX.some(regex => regex.test(lower))) return false;
  if (/(^|\b)(sample|trailer|bonus)(\b|$)/i.test(lower)) return false;

  const cleanMetaString = normalizeTitle(metaTitle);
  const cleanFileString = normalizeTitle(filename);
  if (!cleanMetaString || !cleanFileString) return false;
  if (isUnwantedSpinoff(cleanMetaString, cleanFileString)) return false;

  const fileTokens = buildCleanTokens(filename, { dropJunk: true });
  const metaTokens = buildCleanTokens(metaTitle, { dropJunk: false });
  if (metaTokens.length === 0) return false;

  if (cleanMetaString.length <= 4) {
    for (let i = 0; i < metaTokens.length; i += 1) if (fileTokens[i] !== metaTokens[i]) return false;
    if (fileTokens.length > metaTokens.length) {
      const nextToken = fileTokens[metaTokens.length];
      const seasonLike = /^(s\d+|e\d+|\d+x\d+|stagione|season)$/i.test(nextToken);
      const yearLike = /^(19|20)\d{2}$/.test(nextToken);
      const techLike = JUNK_TOKENS.has(nextToken);
      if (!seasonLike && !yearLike && !techLike) return false;
    }
  }

  if (hasForbiddenExpansion(cleanMetaString, cleanFileString, metaTokens, fileTokens)) return false;

  if (isSeries && Number.isFinite(metaSeason)) {
    if (!auditNumbers(filename, metaSeason, metaEpisode)) return false;
    const epInfo = extractEpisodeInfo(filename);
    if (epInfo) {
      if (epInfo.season !== metaSeason) return false;
      if (Number.isFinite(metaEpisode) && epInfo.episode !== metaEpisode) return false;
      return checkTitleMatch(metaTokens, fileTokens, cleanMetaString, cleanFileString);
    }
    if (isSeasonPack(filename, metaSeason)) return checkTitleMatch(metaTokens, fileTokens, cleanMetaString, cleanFileString);
    return false;
  }

  if (Number.isFinite(metaYear)) {
    const fileYear = extractYear(filename);
    if (fileYear && Math.abs(fileYear - metaYear) >= 1 && similarityScore(cleanMetaString, cleanFileString) < 0.95) return false;
  }

  return checkTitleMatch(metaTokens, fileTokens, cleanMetaString, cleanFileString);
}

function matchAndScore(meta = {}, filename = '') {
  const matched = smartMatch(meta.title || meta.originalTitle || '', filename, !!meta.isSeries, Number(meta.season), Number(meta.episode), Number(meta.year));
  const cleanMeta = normalizeTitle(meta.title || meta.originalTitle || '');
  const cleanFile = normalizeTitle(filename);
  const score = similarityScore(cleanMeta, cleanFile);
  return { matched, score, cleanMeta, cleanFile, year: extractYear(filename), episode: extractEpisodeInfo(filename) };
}

module.exports = {
  generateSmartQueries,
  smartMatch,
  matchAndScore,
  normalizeTitle,
  ultraNormalizeTitle,
  tokenize,
  buildCleanTokens,
  extractEpisodeInfo,
  extractYear,
  auditNumbers,
  isSeasonPack,
  stripArticles,
  getNumericVariants,
  getTitleCandidates,
  autoExpandAliases,
  commonWordsOnly,
  resolveLangMode,
  similarityScore,
  SEMANTIC_ALIASES,
  ULTRA_SEMANTIC_ALIASES: SEMANTIC_ALIASES,
  JUNK_TOKENS,
  ULTRA_JUNK_TOKENS: JUNK_TOKENS,
  STOP_WORDS,
  FORBIDDEN_EXPANSIONS,
  SPINOFF_GRAPH
};
