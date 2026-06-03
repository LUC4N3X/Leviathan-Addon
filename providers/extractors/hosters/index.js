'use strict';

const { extractLoadm, isLoadmUrl } = require('./loadm');
const { extractDeltabit, isDeltabitUrl } = require('./deltabit');
const { extractMaxstream, isMaxstreamUrl } = require('./maxstream');
const { extractMixdrop, isMixdropUrl } = require('./mixdrop');
const { extractSupervideo, isSupervideoUrl } = require('./supervideo');
const { extractDropload, isDroploadUrl } = require('./dropload');
const { extractStreamtape, isStreamtapeUrl } = require('./streamtape');
const { extractUqload, isUqloadUrl } = require('./uqload');
const { extractUpstream, isUpstreamUrl } = require('./upstream');
const { extractUprot, isUprotUrl, resolveUprotToMaxstream } = require('./uprot');
const { extractVidoza, isVidozaUrl } = require('./vidoza');
const { extractVixcloud, isVixcloudUrl } = require('./vixcloud');
const { extractVidxgo, isVidxgoUrl } = require('./vidxgo');
const { extractStreamhg, isStreamhgUrl } = require('./streamhg');
const { extractTurbovid, isTurbovidUrl, normalizeTurbovidUrl } = require('./turbovid');
const { extractVoe, isVoeUrl } = require('./voe');

module.exports = {
    extractDeltabit,
    isDeltabitUrl,
    extractLoadm,
    isLoadmUrl,
    extractMaxstream,
    isMaxstreamUrl,
    extractMixdrop,
    isMixdropUrl,
    extractSupervideo,
    isSupervideoUrl,
    extractDropload,
    isDroploadUrl,
    extractStreamtape,
    isStreamtapeUrl,
    extractUqload,
    isUqloadUrl,
    extractUpstream,
    isUpstreamUrl,
    extractUprot,
    isUprotUrl,
    resolveUprotToMaxstream,
    extractVidoza,
    isVidozaUrl,
    extractVixcloud,
    isVixcloudUrl,
    extractVidxgo,
    isVidxgoUrl,
    extractStreamhg,
    isStreamhgUrl,
    extractTurbovid,
    isTurbovidUrl,
    normalizeTurbovidUrl,
    extractVoe,
    isVoeUrl
};
