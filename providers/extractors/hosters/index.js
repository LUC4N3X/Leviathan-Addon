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
const { extractVidoza, isVidozaUrl } = require('./vidoza');
const { extractVixcloud, isVixcloudUrl } = require('./vixcloud');
const { extractVidxgo, isVidxgoUrl } = require('./vidxgo');

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
    extractVidoza,
    isVidozaUrl,
    extractVixcloud,
    isVixcloudUrl,
    extractVidxgo,
    isVidxgoUrl
};
