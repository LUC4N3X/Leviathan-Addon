'use strict';

const { createWebProviderTools } = require('./web_providers');

function createWebStreamTools(deps) {
    return createWebProviderTools(deps);
}

module.exports = { createWebStreamTools };
