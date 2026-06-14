'use strict';

const {
  REGEX_STRONG_ITA,
  REGEX_CONTEXT_IT,
  REGEX_MULTI_ITA,
  REGEX_TRUSTED_GROUPS,
  REGEX_SUB_ONLY,
  REGEX_AUDIO_CONFIRM,
  parseTitleDetails,
  stripFalseItalianDomainTokens,
  getLanguageInfo,
  isTrustedSource,
  isStrictGlobalLanguageSource
} = require('../utils/text');

const REGEX_EXPLICIT_ENG = /(?:🇬🇧|🇺🇸|\b(?:ENG|ENGLISH|TRUE\s*ENGLISH|AUDIO\s*ENG|ENG\s*(?:AC3|AAC|DDP|DTS|TRUEHD)|ENG(?:LISH)?\s*ONLY|DUBBED\s*ENG)\b)/i;
const REGEX_EXPLICIT_OTHER = /\b(?:FRENCH|GERMAN|SPANISH|ESP|LATINO|RUS|RUSSIAN|JPN|JAP|JAPANESE|VOSTFR|POLISH|PORTUGUESE|PT-BR|HINDI|KOREAN|CHINESE|ARABIC|TURKISH)\b/i;
const REGEX_GENERIC_MULTI = /\b(?:MULTI|MULTILANG(?:UAGE)?|DUAL[\s.-]?AUDIO|TRIPLE[\s.-]?AUDIO)\b/i;
const REGEX_ITA_ENG_PAIR = /(?:\b(?:ITA|IT|ITALIAN|ITALIANO)[\s._/+,-]*(?:ENG|EN|ENGLISH)\b|\b(?:ENG|EN|ENGLISH)[\s._/+,-]*(?:ITA|IT|ITALIAN|ITALIANO)\b)/i;
const REGEX_AUDIO_ITA_CONTEXT = /(?:dub(?:bed)?|audio|lang|lingua|vo|doppiat[oa])(?:[\s.\-_:/-]+)(?:it|ita|italian|italiano)\b/i;
const REGEX_AUDIO_CONFIRM_NO_FLAG = /(?:\b(?:AUDIO|AC3|AAC|DTS|MD|LD|DDP|MP3|LINGUA)[\s.\-_]+(?:\d[\s.,]?\d[\s.\-_]+)?(?:ITA|IT)\b|\b(?:ITA|ITALIAN|ITALIANO|ITALIANA)[\s.\-_]+(?:\d[\s.,]?\d[\s.\-_]+)?(?:AUDIO|DUB|DUBBED|AC3|AAC|DTS|DDP|EAC3|TRUEHD|ATMOS)\b)/i;
const REGEX_STRONG_ITA_NO_FLAG = /\b(?:ITA|ITALIAN|ITALIANO|ITALIANA)\b/i;

function normalizeText(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildLanguageEvidence(title = '', sourceName = '', parsedInfo = null) {
  const rawTitle = normalizeText(title);
  const rawSource = normalizeText(sourceName);
  const combined = `${rawTitle} ${rawSource}`.trim();
  const scanTitle = stripFalseItalianDomainTokens(rawTitle);
  const scanCombined = stripFalseItalianDomainTokens(combined);
  const parsed = parsedInfo || parseTitleDetails(rawTitle);

  const langInfo = getLanguageInfo(rawTitle, null, rawSource, parsed);
  const detected = new Set(Array.isArray(langInfo?.detectedLanguages) ? langInfo.detectedLanguages.map((v) => String(v)) : []);

  const explicitItalian = detected.has('Italian')
    || /🇮🇹/.test(scanCombined)
    || REGEX_STRONG_ITA.test(scanCombined)
    || REGEX_AUDIO_CONFIRM.test(scanCombined)
    || REGEX_CONTEXT_IT.test(scanCombined)
    || REGEX_AUDIO_ITA_CONTEXT.test(scanCombined)
    || REGEX_ITA_ENG_PAIR.test(scanCombined);

  const multiItalian = REGEX_MULTI_ITA.test(scanCombined) || REGEX_ITA_ENG_PAIR.test(scanCombined);
  const trustedItalianGroup = REGEX_TRUSTED_GROUPS.test(combined);
  const trustedItalianSource = Boolean(rawSource && isTrustedSource(rawSource, null));
  const strictGlobalSource = isStrictGlobalLanguageSource(rawSource);
  const subtitleOnlyItalian = REGEX_SUB_ONLY.test(scanTitle) && !REGEX_AUDIO_CONFIRM.test(scanCombined) && !REGEX_AUDIO_ITA_CONTEXT.test(scanCombined);
  const explicitEnglish = detected.has('English') || REGEX_EXPLICIT_ENG.test(scanCombined);
  const explicitOther = REGEX_EXPLICIT_OTHER.test(scanCombined);
  const genericMulti = detected.has('Multi') || REGEX_GENERIC_MULTI.test(scanCombined);

  const hasItalianAudioEvidence = Boolean(explicitItalian || multiItalian || trustedItalianGroup || trustedItalianSource);

  return {
    rawTitle,
    rawSource,
    combined,
    parsed,
    langInfo,
    detectedLanguages: [...detected],
    explicitItalian,
    multiItalian,
    trustedItalianGroup,
    trustedItalianSource,
    strictGlobalSource,
    subtitleOnlyItalian,
    explicitEnglish,
    explicitOther,
    genericMulti,
    hasItalianAudioEvidence
  };
}

function hasStrictGlobalSourceItalianAudioEvidence(evidence) {
  if (!evidence?.strictGlobalSource) return false;

  // ThePirateBay/BestTorrents sono globali e sporchi: non ci si deve fidare
  // di bandierine, source label, titolo italiano localizzato o MULTI generico.
  // Deve esserci un segnale audio ITA scritto nella release reale.
  const titleScan = stripFalseItalianDomainTokens(evidence.rawTitle);
  const trustedItalianGroupInTitle = REGEX_TRUSTED_GROUPS.test(titleScan);
  const explicitAudioContextInTitle = REGEX_AUDIO_CONFIRM_NO_FLAG.test(titleScan)
    || REGEX_CONTEXT_IT.test(titleScan)
    || REGEX_AUDIO_ITA_CONTEXT.test(titleScan)
    || REGEX_ITA_ENG_PAIR.test(titleScan);
  const explicitItaTokenInTitle = REGEX_STRONG_ITA_NO_FLAG.test(titleScan);
  const explicitMultiItaInTitle = REGEX_MULTI_ITA.test(titleScan) || REGEX_ITA_ENG_PAIR.test(titleScan);
  const subtitleOnlyInTitle = REGEX_SUB_ONLY.test(titleScan)
    && !explicitAudioContextInTitle
    && !trustedItalianGroupInTitle;

  if (subtitleOnlyInTitle) return false;
  return Boolean(trustedItalianGroupInTitle || explicitAudioContextInTitle || explicitMultiItaInTitle || explicitItaTokenInTitle);
}

function hasStrictItalianEvidence(title = '', sourceName = '', parsedInfo = null) {
  const evidence = buildLanguageEvidence(title, sourceName, parsedInfo);
  if (evidence.strictGlobalSource) return hasStrictGlobalSourceItalianAudioEvidence(evidence);
  return evidence.hasItalianAudioEvidence && !evidence.subtitleOnlyItalian;
}

function shouldKeepStrictItalianCandidate(title = '', sourceName = '', parsedInfo = null) {
  const evidence = buildLanguageEvidence(title, sourceName, parsedInfo);

  if (evidence.subtitleOnlyItalian) return false;

  const strictGlobalAudioEvidence = evidence.strictGlobalSource
    ? hasStrictGlobalSourceItalianAudioEvidence(evidence)
    : false;

  if (evidence.strictGlobalSource && !strictGlobalAudioEvidence) return false;
  if (!evidence.strictGlobalSource && !evidence.hasItalianAudioEvidence) return false;

  const hasExplicitItaMarker = evidence.strictGlobalSource
    ? strictGlobalAudioEvidence
    : (evidence.explicitItalian || evidence.multiItalian);
  if ((evidence.explicitEnglish || evidence.explicitOther) && !hasExplicitItaMarker) return false;
  if (evidence.genericMulti && !hasExplicitItaMarker && !evidence.trustedItalianGroup && !evidence.trustedItalianSource) return false;

  return true;
}

module.exports = {
  buildLanguageEvidence,
  hasStrictGlobalSourceItalianAudioEvidence,
  hasStrictItalianEvidence,
  shouldKeepStrictItalianCandidate,
  isStrictGlobalLanguageSource
};
