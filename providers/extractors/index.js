'use strict';

const common = require('./common');
const hosters = require('./hosters');
const registry = require('./registry');
const providerRegistry = require('./provider_registry');

module.exports = {
    ...common,
    ...hosters,
    ...registry,
    ...providerRegistry
};
