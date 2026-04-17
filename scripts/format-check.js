'use strict';

const fs = require('fs');
const {
  listTextFiles,
  normalizeTextFile,
  toProjectRelative
} = require('./lib/project_tools');

const offenders = [];
for (const filePath of listTextFiles()) {
  const original = fs.readFileSync(filePath, 'utf8');
  const normalized = normalizeTextFile(original);
  if (original !== normalized) offenders.push(toProjectRelative(filePath));
}

if (offenders.length > 0) {
  console.error('Formatting issues detected in:');
  for (const file of offenders) console.error(` - ${file}`);
  process.exit(1);
}

console.log('[format-check] OK - text files use LF and trailing newline.');
