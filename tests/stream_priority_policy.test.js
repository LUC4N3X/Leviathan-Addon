'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    applyStreamPriorityPolicy
} = require('../core/lib/stream_priority_policy');

test('stream priority policy exports the generator-compatible apply function', () => {
    assert.equal(typeof applyStreamPriorityPolicy, 'function');
});
