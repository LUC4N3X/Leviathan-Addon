'use strict';

let ptt = null;
try {
  ptt = require('parse-torrent-title');
} catch (_) {
  ptt = null;
}

const RELEASE_MARKERS = Object.freeze([
  /[([]?\b(?:19|20)\d{2}\b[)\]]?/,
  /\b(?:2160p|1080[pi]|720p|576p|480p|4k|uhd)\b/i,
  /\b(?:blu[ .-]?ray|bd(?:rip|remux)|bdmux|br[ .-]?rip|remux|web[ .-]?(?:dl|rip|mux)|webdl|hdtv|pdtv|dvd(?:rip|scr)?|hdrip|hdts|cam(?:rip)?|telesync|telecine|screener|scr)\b/i,
  /\b(?:x[ .]?26[45]|h[ .]?26[45]|hevc|avc|av1|xvid|divx)\b/i,
  /\b(?:aac|ac-?3|e-?ac-?3|ddp|dd\+|dts(?:-?hd)?|truehd|atmos|flac|opus|lpcm|pcm|mp3)\b/i,
  /\b(?:s\d{1,2}(?:e\d{1,3})?|\d{1,2}x\d{1,3})\b/i,
  /\b(?:season|stagion[ei]|saison|temporada|episodio?|episode|ep[ .]?\d)\b/i,
  /\b(?:hdr10\+?|hdr|dolby[ .]?vision|dovi|10[ .-]?bit|8[ .-]?bit)\b/i,
  /\.(?:mkv|mp4|avi|m2ts)$/i
]);

const LANGUAGE_SIGNALS = Object.freeze([
  { tag: 'multi subs', pattern: /\bmulti(?:ple)?[ .-]*(?:su?$|sub\w*|dub\w*)\b|msub/i, consumes: true },
  { tag: 'multi audio', pattern: /\bmulti(?:ple)?[ .-]*(?:lang(?:uages?)?|audio|VF2)?\b/i },
  { tag: 'multi audio', pattern: /\btri(?:ple)?[ .-]*(?:audio|dub\w*)\b/i },
  { tag: 'dual audio', pattern: /\bdual[ .-]*(?:au?$|[aá]udio|line)\b/i },
  { tag: 'dual audio', pattern: /\bdual\b(?![ .-]*sub)/i },
  { tag: 'italian', pattern: /\bITA\b/i },
  { tag: 'italian', pattern: /\b(?<!w{3}\.\w+\.)IT(?=[ .,/-]+(?:[a-zA-Z]{2}[ .,/-]+){2,})\b/ },
  { tag: 'italian', pattern: /\bit(?=\.(?:ass|ssa|srt|sub|idx)$)/i },
  { tag: 'italian', pattern: /\bitaliano?\b/i, guarded: true },
  { tag: 'english', pattern: /\bengl?(?:sub[A-Z]*)?\b/i },
  { tag: 'english', pattern: /\beng?sub[A-Z]*\b/i },
  { tag: 'english', pattern: /\bing(?:l[eéê]s)?\b/i },
  { tag: 'english', pattern: /\benglish\W+(?:subs?|sdh|hi)\b/i },
  { tag: 'english', pattern: /\bEN\b/i },
  { tag: 'english', pattern: /\benglish?\b/i, guarded: true },
  { tag: 'latino', pattern: /\bspanish\W?latin|american\W*(?:spa|esp?)/i, consumes: true },
  { tag: 'latino', pattern: /\b(?:audio.)?lat(?:i|ino)?\b/i },
  { tag: 'spanish', pattern: /\b(?:audio.)?(?:ESP|spa|(?:en[ .]+)?espa[nñ]ola?|castellano)\b/i },
  { tag: 'spanish', pattern: /\bes(?=[ .,/-]+(?:[A-Z]{2}[ .,/-]+){2,})\b/i },
  { tag: 'spanish', pattern: /\b(?<=[ .,/-]+(?:[A-Z]{2}[ .,/-]+){2,})es\b/i },
  { tag: 'spanish', pattern: /\b(?<=[ .,/-]+[A-Z]{2}[ .,/-]+)es(?=[ .,/-]+[A-Z]{2}[ .,/-]+)\b/i },
  { tag: 'spanish', pattern: /\bes(?=\.(?:ass|ssa|srt|sub|idx)$)/i },
  { tag: 'spanish', pattern: /\bspanish\W+subs?\b/i },
  { tag: 'spanish', pattern: /\b(?:spanish|espanhol)\b/i, guarded: true },
  { tag: 'portuguese', pattern: /\b(?:p[rt]|en|port)[. (\\/-]*BR\b/i, consumes: true },
  { tag: 'portuguese', pattern: /\bbr(?:a|azil|azilian)\W+(?:pt|por)\b/i, consumes: true },
  { tag: 'portuguese', pattern: /\b(?:leg(?:endado|endas?)?|dub(?:lado)?|portugu[eèê]se?)[. -]*BR\b/i },
  { tag: 'portuguese', pattern: /\bleg(?:endado|endas?)\b/i },
  { tag: 'portuguese', pattern: /\bportugu[eèê]s[ea]?\b/i },
  { tag: 'portuguese', pattern: /\bPT[. -]*(?:PT|ENG?|sub(?:s|titles?))\b/i },
  { tag: 'portuguese', pattern: /\bpt(?=\.(?:ass|ssa|srt|sub|idx)$)/i },
  { tag: 'portuguese', pattern: /\bpor\b/i },
  { tag: 'french', pattern: /\bFR(?:ench|a|e|anc[eê]s)?\b/i },
  { tag: 'french', pattern: /\b(?:Truefrench|VF[FI])\b/i },
  { tag: 'french', pattern: /\b(?:VOST(?:FR?|A)?|SUBFRENCH)\b/i },
  { tag: 'german', pattern: /\b(?:GER|DEU)\b/i },
  { tag: 'german', pattern: /\bde(?=[ .,/-]+(?:[A-Z]{2}[ .,/-]+){2,})\b/i },
  { tag: 'german', pattern: /\b(?<=[ .,/-]+(?:[A-Z]{2}[ .,/-]+){2,})de\b/i },
  { tag: 'german', pattern: /\b(?<=[ .,/-]+[A-Z]{2}[ .,/-]+)de(?=[ .,/-]+[A-Z]{2}[ .,/-]+)\b/i },
  { tag: 'german', pattern: /\bde(?=\.(?:ass|ssa|srt|sub|idx)$)/i },
  { tag: 'german', pattern: /\b(?:german|alem[aã]o)\b/i, guarded: true },
  { tag: 'russian', pattern: /\bRUS?\b/i },
  { tag: 'russian', pattern: /\b(?:russian|russo)\b/i, guarded: true },
  { tag: 'ukrainian', pattern: /\bUKR\b/i },
  { tag: 'ukrainian', pattern: /\bukrainian\b/i, guarded: true },
  { tag: 'polish', pattern: /\b(?:PLDUB|Dubbing.PL|Lektor.PL|Film.Polski)\b/i, consumes: true },
  { tag: 'polish', pattern: /\b(?:Napisy.PL|PLSUB(?:BED)?)\b/i, consumes: true },
  { tag: 'polish', pattern: /\b(?:(?<!w{3}\.\w+\.)PL|pol)\b/i },
  { tag: 'polish', pattern: /\b(?:polish|polon[eê]s|polaco)\b/i, guarded: true },
  { tag: 'czech', pattern: /\bCZ[EH]?\b/i, guarded: true },
  { tag: 'czech', pattern: /\bczech\b/i, guarded: true },
  { tag: 'slovakian', pattern: /\bslo(?:vak|vakian|subs|[\]_)]?\.\w{2,4}$)\b/i },
  { tag: 'hungarian', pattern: /\bHU\b/ },
  { tag: 'hungarian', pattern: /\bHUN(?:garian)?\b/i },
  { tag: 'romanian', pattern: /\bROM(?:anian)?\b/i },
  { tag: 'romanian', pattern: /\bRO(?=[ .,/-]*(?:[A-Z]{2}[ .,/-]+)*sub)/i },
  { tag: 'bulgarian', pattern: /\bbul(?:garian)?\b/i },
  { tag: 'serbian', pattern: /\b(?:srp|serbian)\b/i },
  { tag: 'croatian', pattern: /\b(?:HRV|croatian)\b/i },
  { tag: 'croatian', pattern: /\bHR(?=[ .,/-]*(?:[A-Z]{2}[ .,/-]+)*sub)\b/i },
  { tag: 'slovenian', pattern: /\bslovenian\b/i },
  { tag: 'lithuanian', pattern: /\b(?<!YTS\.)LT\b/ },
  { tag: 'lithuanian', pattern: /\blithuanian\b/i, guarded: true },
  { tag: 'latvian', pattern: /\blatvian\b/i, guarded: true },
  { tag: 'estonian', pattern: /\bestonian\b/i, guarded: true },
  { tag: 'greek', pattern: /\bgreek[ .-]*(?:audio|lang(?:uage)?|subs?(?:titles?)?)?\b/i, guarded: true },
  { tag: 'dutch', pattern: /\b(?:(?<!w{3}\.\w+\.)NL|dut|holand[eê]s)\b/i },
  { tag: 'dutch', pattern: /\bdutch\b/i },
  { tag: 'dutch', pattern: /\bflemish\b/i },
  { tag: 'danish', pattern: /\b(?:DK|danska|dansub|nordic)\b/i },
  { tag: 'danish', pattern: /\b(?:danish|dinamarqu[eê]s)\b/i },
  { tag: 'danish', pattern: /\bdan\b(?=.*\.(?:srt|vtt|ssa|ass|sub|idx)$)/i },
  { tag: 'finnish', pattern: /\b(?:(?<!w{3}\.\w+\.)FI|finsk|finsub|nordic)\b/i },
  { tag: 'finnish', pattern: /\bfinnish\b/i },
  { tag: 'swedish', pattern: /\b(?:(?<!w{3}\.\w+\.)SE|swe|swesubs?|sv(?:ensk)?|nordic)\b/i },
  { tag: 'swedish', pattern: /\b(?:swedish|sueco)\b/i },
  { tag: 'norwegian', pattern: /\b(?:NOR|norsk|norsub|nordic)\b/i },
  { tag: 'norwegian', pattern: /\b(?:norwegian|noruegu[eê]s|bokm[aå]l|nob|nor(?=[\]_)]?\.\w{2,4}$))\b/i },
  { tag: 'japanese', pattern: /\b(?:JP|JAP|JPN)\b/i },
  { tag: 'japanese', pattern: /\b(?:japanese|japon[eê]s)\b/i, guarded: true },
  { tag: 'korean', pattern: /\b(?:KOR|kor[ .-]?sub)\b/i },
  { tag: 'korean', pattern: /\b(?:korean|coreano)\b/i, guarded: true },
  { tag: 'taiwanese', pattern: /\b(?:traditional\W*chinese|chinese\W*traditional)(?:\Wchi)?\b/i, consumes: true },
  { tag: 'taiwanese', pattern: /\bzh-hant\b/i },
  { tag: 'chinese', pattern: /\b(?:mand[ae]rin|ch[sn])\b/i },
  { tag: 'chinese', pattern: /\bCH[IT]\b/ },
  { tag: 'chinese', pattern: /\b(?:chinese|chin[eê]s|chi)\b/i, guarded: true },
  { tag: 'chinese', pattern: /\bzh-hans\b/i },
  { tag: 'hindi', pattern: /\bhin(?:di)?\b/i },
  { tag: 'telugu', pattern: /\b(?:(?<!w{3}\.\w+\.)tel(?!\W*aviv)|telugu)\b/i },
  { tag: 'tamil', pattern: /\bt[aâ]m(?:il)?\b/i },
  { tag: 'thai', pattern: /\b(?:thai|tailand[eê]s)\b/i, guarded: true },
  { tag: 'thai', pattern: /\b(?:THA|tha)\b/ },
  { tag: 'vietnamese', pattern: /\bvietnamese\b|\bvie(?=[\]_)]?\.\w{2,4}$)/i },
  { tag: 'indonesian', pattern: /\bind(?:onesian)?\b/i },
  { tag: 'malay', pattern: /\b(?:malay|may(?=[\]_)]?\.\w{2,4}$)|(?<=subs?\([a-z,]+)may)\b/i, guarded: true },
  { tag: 'arabic', pattern: /\b(?:arabic|[aá]rabe|ara)\b/i, guarded: true },
  { tag: 'arabic', pattern: /\barab.*(?:audio|lang(?:uage)?|sub(?:s|titles?)?)\b/i },
  { tag: 'arabic', pattern: /\bar(?=\.(?:ass|ssa|srt|sub|idx)$)/i },
  { tag: 'turkish', pattern: /\b(?:turkish|tur(?:co)?)\b/i },
  { tag: 'hebrew', pattern: /\bheb(?:rew|raico)?\b/i },
  { tag: 'persian', pattern: /\b(?:persian|persa)\b/i }
]);

const HDR_SIGNALS = Object.freeze([
  { tag: 'DV', pattern: /\bDV\b|dolby.?vision|\bDoVi\b/i },
  { tag: 'HDR10+', pattern: /HDR10(?:\+|plus)/i },
  { tag: 'HDR', pattern: /\bHDR(?:10)?\b/i }
]);

const DEPTH_SIGNALS = Object.freeze([
  { tag: null, pattern: /(?:8|10|12)[- ]?bit/i },
  { tag: '10bit', pattern: /\bhevc\s?10\b/i },
  { tag: '10bit', pattern: /\bhdr10\b/i },
  { tag: '10bit', pattern: /\bhi10\b/i }
]);

const STEREO_SIGNALS = Object.freeze([
  { tag: '3D HSBS', pattern: /\b3D\b.*\b(?:Half-?SBS|H[-\\/]?SBS)\b/i },
  { tag: '3D HSBS', pattern: /\bHalf.Side.?By.?Side\b/i },
  { tag: '3D SBS', pattern: /\b3D\b.*\b(?:Full-?SBS|SBS)\b/i },
  { tag: '3D SBS', pattern: /\bSide.?By.?Side\b/i },
  { tag: '3D HOU', pattern: /\b3D\b.*\b(?:Half-?OU|H[-\\/]?OU)\b/i },
  { tag: '3D HOU', pattern: /\bHalf.?Over.?Under\b/i },
  { tag: '3D OU', pattern: /\b3D\b.*\bOU\b/i },
  { tag: '3D OU', pattern: /\bOver.?Under\b/i },
  { tag: '3D', pattern: /\b(?:BD)?3D\b/i, guarded: true }
]);

const ANTHOLOGY_SIGNALS = Object.freeze([
  /(?:\bthe\W)?(?:\bcomplete|collection|dvd)?\b[ .]?\bbox[ .-]?set\b/i,
  /(?:\bthe\W)?(?:\bcomplete|collection|dvd)?\b[ .]?\bmini[ .-]?series\b/i,
  /(?:\bthe\W)?(?:\bcomplete|full|all)\b.*\b(?:series|seasons|collection|episodes|set|pack|movies)\b/i,
  /\b(?:series|seasons|movies?)\b.*\b(?:complete|collection)\b/i,
  /\bcollection\b.*\b(?:set|pack|movies)\b/i,
  /duology|trilogy|quadr[oi]logy|tetralogy|pentalogy|hexalogy|heptalogy|anthology|saga/i
]);

const COLLECTION_HINTS = Object.freeze([
  /(?:\bthe\W)?\bultimate\b[ .]\bcollection\b/i,
  /\b(?:collection|completa)\b/i,
  /\bkolekcja\b(?:\Wfilm(?:y|ów|ow)?)?/i
]);

const DUB_PATTERN = /\b(?:DUBBED|dublado|dubbing|DUBS?)\b/i;
const MULTI_AUDIO_TAGS = Object.freeze(['multi audio', 'dual audio']);

function firstMarkerIndex(title) {
  let earliest = null;
  for (const marker of RELEASE_MARKERS) {
    const match = title.match(marker);
    if (match && (earliest === null || match.index < earliest)) earliest = match.index;
  }
  return earliest;
}

function scanSignals(title, signals, markerIndex, firstOnly = false) {
  let scope = title;
  const tags = [];
  for (const signal of signals) {
    const match = scope.match(signal.pattern);
    if (!match) continue;
    if (signal.guarded && markerIndex !== null && match.index < markerIndex) continue;
    const tag = signal.tag === null ? match[0] : signal.tag;
    if (!tags.includes(tag)) tags.push(tag);
    if (firstOnly) break;
    if (signal.consumes) scope = scope.slice(0, match.index) + scope.slice(match.index + match[0].length);
  }
  return tags;
}

function extractReleaseSignals(rawTitle) {
  const title = String(rawTitle || '');
  const signals = {
    languages: [],
    hdr: [],
    bitDepth: null,
    threeD: null,
    dubbed: false,
    complete: false,
    anthology: false
  };
  if (!title.trim()) return signals;

  const markerIndex = firstMarkerIndex(title);

  signals.languages = scanSignals(title, LANGUAGE_SIGNALS, markerIndex);
  if (!signals.languages.includes('portuguese') && !signals.languages.includes('spanish') && /\bdublado\b/i.test(title)) {
    signals.languages.push('portuguese');
  }

  signals.hdr = scanSignals(title, HDR_SIGNALS, markerIndex);

  const depth = scanSignals(title, DEPTH_SIGNALS, markerIndex, true)[0] || null;
  signals.bitDepth = depth ? depth.toLowerCase().replace(/[ -]/, '') : null;

  signals.threeD = scanSignals(title, STEREO_SIGNALS, markerIndex, true)[0] || null;

  signals.anthology = ANTHOLOGY_SIGNALS.some((pattern) => pattern.test(title));
  signals.complete = signals.anthology || COLLECTION_HINTS.some((pattern) => pattern.test(title));

  signals.dubbed = DUB_PATTERN.test(title)
    || MULTI_AUDIO_TAGS.some((tag) => signals.languages.includes(tag));

  return signals;
}

let bound = false;

function bindToTitleParser(target = null) {
  const parser = target || ptt;
  if (!parser || typeof parser.addHandler !== 'function') return false;
  if (!target) {
    if (bound) return true;
    bound = true;
  }
  parser.addHandler('releaseSignals', ({ title, result }) => {
    const signals = extractReleaseSignals(title);
    if (result.languages === undefined && signals.languages.length > 0) result.languages = signals.languages;
    if (result.hdr === undefined && signals.hdr.length > 0) result.hdr = signals.hdr;
    if (result.bitDepth === undefined && signals.bitDepth) result.bitDepth = signals.bitDepth;
    if (result.threeD === undefined && signals.threeD) result.threeD = signals.threeD;
    if (result.complete === undefined && signals.complete) result.complete = true;
    if (result.anthology === undefined && signals.anthology) result.anthology = true;
    if (result.dubbed === undefined && signals.dubbed) result.dubbed = true;
    return null;
  });
  return true;
}

bindToTitleParser();

module.exports = {
  extractReleaseSignals,
  bindToTitleParser
};
