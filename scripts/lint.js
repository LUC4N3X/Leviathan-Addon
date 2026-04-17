'use strict';

const {
  findMissingLocalRequires,
  listLintFiles,
  runNodeSyntaxCheck,
  toProjectRelative
} = require('./lib/project_tools');

const files = listLintFiles();
const failures = [];

for (const filePath of files) {
  const syntax = runNodeSyntaxCheck(filePath);
  if (syntax.status !== 0) {
    failures.push(`Syntax error in ${toProjectRelative(filePath)}\n${(syntax.stderr || syntax.stdout || '').trim()}`);
    continue;
  }

  const missingRequires = findMissingLocalRequires(filePath);
  if (missingRequires.length > 0) {
    failures.push(`Missing local require target(s) in ${toProjectRelative(filePath)}: ${missingRequires.join(', ')}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log(`[lint] OK - verified ${files.length} source files.`);
