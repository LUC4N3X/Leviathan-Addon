'use strict';

const fs = require('fs');
const {
  listTextFiles,
  normalizeTextFile,
  toProjectRelative
} = require('./lib/project_tools');

let updated = 0;
for (const filePath of listTextFiles()) {
  const original = fs.readFileSync(filePath, 'utf8');
  const normalized = normalizeTextFile(original);
  if (original === normalized) continue;
  fs.writeFileSync(filePath, normalized, 'utf8');
  updated += 1;
  console.log(`[format] normalized ${toProjectRelative(filePath)}`);
}

console.log(`[format] Done - updated ${updated} file(s).`);
