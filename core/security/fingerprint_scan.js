'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { IMPIT_CEILING } = require('./fingerprint_manifest');

const DEFAULT_ROOTS = Object.freeze(['core', 'providers']);
const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.cache']);

const PATTERNS = Object.freeze([
    Object.freeze({ family: 'chrome', source: 'Chrome\\/(\\d+)', ceilingKey: 'chrome' }),
    Object.freeze({ family: 'edge', source: 'Edg(?:[A-Za-z]+)?\\/(\\d+)', ceilingKey: 'edge' }),
    Object.freeze({ family: 'firefox', source: 'Firefox\\/(\\d+)', ceilingKey: 'firefox' })
]);

function walk(dir, out) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return out;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
        } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

function scanRepoUserAgents(rootDir, roots = DEFAULT_ROOTS, ceiling = IMPIT_CEILING) {
    const files = [];
    for (const root of roots) walk(path.resolve(rootDir, root), files);

    const violations = [];
    for (const file of files) {
        let content = '';
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch (_) {
            continue;
        }
        for (const pattern of PATTERNS) {
            const regex = new RegExp(pattern.source, 'g');
            let match = regex.exec(content);
            while (match !== null) {
                const found = Number(match[1]);
                const expected = ceiling[pattern.ceilingKey];
                if (Number.isFinite(found) && found !== expected) {
                    violations.push({ file: path.relative(rootDir, file), family: pattern.family, expected, found });
                }
                match = regex.exec(content);
            }
        }
    }
    return violations;
}

module.exports = {
    DEFAULT_ROOTS,
    scanRepoUserAgents
};
