'use strict';

const { extractLoadm, isLoadmUrl, extractMixdrop, isMixdropUrl } = require('./hosters');

const HOSTER_DEFINITIONS = [
    {
        key: 'loadm',
        label: 'LoadM',
        matches: isLoadmUrl,
        extract: extractLoadm,
        priority: 0
    },
    {
        key: 'mixdrop',
        label: 'MixDrop',
        matches: isMixdropUrl,
        extract: extractMixdrop,
        priority: 1
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
    resolveExtractorDefinition,
    extractFromUrl
};
