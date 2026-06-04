'use strict';

const common = require('./common');
const hosters = require('./hosters');
const registry = require('./registry');
const providerRegistry = require('./provider_registry');
const semantic = require('./semantic_candidate_extractor');

module.exports = {
    ...common,
    ...hosters,
    ...registry,
    ...providerRegistry,
    ...semantic
};
