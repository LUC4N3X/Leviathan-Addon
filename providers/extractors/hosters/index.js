'use strict';

const { extractLoadm, isLoadmUrl } = require('./loadm');
const { extractMixdrop, isMixdropUrl } = require('./mixdrop');
const { extractSupervideo, isSupervideoUrl } = require('./supervideo');
const { extractDropload, isDroploadUrl } = require('./dropload');
const { extractStreamtape, isStreamtapeUrl } = require('./streamtape');
const { extractUqload, isUqloadUrl } = require('./uqload');
const { extractUpstream, isUpstreamUrl } = require('./upstream');
const { extractVidoza, isVidozaUrl } = require('./vidoza');
const { extractVixcloud, isVixcloudUrl } = require('./vixcloud');

module.exports = {
    extractLoadm,
    isLoadmUrl,
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
    isVixcloudUrl
};
