'use strict';

const {
    extractDeltabit,
    extractDropload,
    extractLoadm,
    extractMixdrop,
    extractMaxstream,
    extractStreamtape,
    extractSupervideo,
    extractUpstream,
    extractUqload,
    extractVidoza,
    extractVixcloud,
    extractVidxgo,
    isDeltabitUrl,
    isDroploadUrl,
    isLoadmUrl,
    isMixdropUrl,
    isMaxstreamUrl,
    isStreamtapeUrl,
    isSupervideoUrl,
    isUpstreamUrl,
    isUqloadUrl,
    isVidozaUrl,
    isVixcloudUrl,
    isVidxgoUrl
} = require('./hosters');

const HOSTER_DIRECT_LINK_PATTERN = String.raw`https?:\/\/(?:www\.)?(?:supervideo|vixcloud|(?:v\.)?vidxgo|dropload|dr0pstream|mixdrop|m1xdrop|mxcontent|loadm(?:\.cam)?|deltabit|safego|clicka|uprot\.net|maxstream\.video|stayonline\.pro|maxstream|upstream|uqload|streamtape|vidoza)[^"'<\s]+`;
const HOSTER_ESCAPED_DIRECT_LINK_PATTERN = String.raw`https?:\\\/\\\/(?:www\\.)?(?:supervideo|vixcloud|(?:v\.)?vidxgo|dropload|dr0pstream|mixdrop|m1xdrop|mxcontent|loadm(?:\\.cam)?|deltabit|safego|clicka|uprot\\.net|maxstream\\.video|stayonline\\.pro|maxstream|upstream|uqload|streamtape|vidoza)[^"'<\s]+`;

const HOSTER_DEFINITIONS = [
    {
        key: 'supervideo',
        label: 'SuperVideo',
        matches: isSupervideoUrl,
        extract: extractSupervideo,
        priority: 0
    },

    {
        key: 'maxstream',
        label: 'MaxStream',
        matches: isMaxstreamUrl,
        extract: extractMaxstream,
        priority: 0
    },
    {
        key: 'deltabit',
        label: 'DeltaBit',
        matches: isDeltabitUrl,
        extract: extractDeltabit,
        priority: 1
    },
    {
        key: 'vixcloud',
        label: 'VixCloud',
        matches: isVixcloudUrl,
        extract: extractVixcloud,
        priority: 1
    },

    {
        key: 'vidxgo',
        label: 'VidxGo',
        matches: isVidxgoUrl,
        extract: extractVidxgo,
        priority: 0
    },
    {
        key: 'dropload',
        label: 'DropLoad',
        matches: isDroploadUrl,
        extract: extractDropload,
        priority: 2
    },
    {
        key: 'loadm',
        label: 'LoadM',
        matches: isLoadmUrl,
        extract: extractLoadm,
        priority: 4
    },
    {
        key: 'mixdrop',
        label: 'MixDrop',
        matches: isMixdropUrl,
        extract: extractMixdrop,
        priority: 3
    },
    {
        key: 'upstream',
        label: 'Upstream',
        matches: isUpstreamUrl,
        extract: extractUpstream,
        priority: 5
    },
    {
        key: 'uqload',
        label: 'Uqload',
        matches: isUqloadUrl,
        extract: extractUqload,
        priority: 6
    },
    {
        key: 'streamtape',
        label: 'StreamTape',
        matches: isStreamtapeUrl,
        extract: extractStreamtape,
        priority: 7
    },
    {
        key: 'vidoza',
        label: 'Vidoza',
        matches: isVidozaUrl,
        extract: extractVidoza,
        priority: 8
    }
];

function resolveExtractorDefinition(url) {
    return HOSTER_DEFINITIONS.find((definition) => definition.matches(url)) || null;
}

async function extractFromUrl(url, options = {}) {
    const definition = resolveExtractorDefinition(url);
    if (!definition) return null;

    const extracted = await definition.extract(url, options);
    if (!extracted?.url) return null;

    return {
        ...extracted,
        key: definition.key,
        extractor: extracted.extractor || definition.label,
        name: extracted.name || definition.label,
        priority: extracted.priority ?? definition.priority
    };
}

module.exports = {
    HOSTER_DEFINITIONS,
    HOSTER_DIRECT_LINK_PATTERN,
    HOSTER_ESCAPED_DIRECT_LINK_PATTERN,
    resolveExtractorDefinition,
    extractFromUrl
};
