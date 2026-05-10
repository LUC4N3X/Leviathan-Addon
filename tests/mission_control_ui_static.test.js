'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('mission control html is self contained and reads the protected API', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'mission-control.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.match(html, /Mission Control/);
  assert.match(html, /\/api\/mission-control\?traceLimit=30/);
  assert.match(html, /credentials:\s*'same-origin'/);
  assert.doesNotMatch(html, /https?:\/\//);
});
