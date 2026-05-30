'use strict';

/**
 * AIOStreams-style template engine for the Leviathan formatter.
 *
 * Grammar (inside `{ ... }`):
 *   {path}                         -> resolve a value from the context
 *   {path::modifier}              -> apply a modifier
 *   {path::mod1::mod2(arg)}       -> chain modifiers left-to-right
 *   {path::["TRUE"||"FALSE"]}     -> conditional: render TRUE when path is
 *                                    truthy, otherwise FALSE. Both branches are
 *                                    themselves templates and may contain {...}.
 *
 * Everything outside `{ ... }` is copied verbatim. Unknown paths resolve to an
 * empty string and unknown modifiers leave the value untouched, so a malformed
 * template degrades gracefully instead of throwing.
 *
 * Backward compatibility: flat legacy variables ({title}, {quality}, {size}...)
 * keep working because they are exposed as top-level keys on the context.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const MAX_DEPTH = 6;
const MAX_OUTPUT = 8000;

function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
    const size = value / Math.pow(1024, unitIndex);
    const decimals = unitIndex === 0 ? 0 : 2;
    return `${size.toFixed(decimals)} ${UNITS[unitIndex]}`;
}

function isTruthy(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
    if (typeof value === 'string') return value.trim().length > 0;
    return Boolean(value);
}

function stringify(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : '';
    if (Array.isArray(value)) return value.filter((entry) => entry !== null && entry !== undefined && entry !== '').join(' ');
    return String(value);
}

function resolvePath(ctx, path) {
    const key = String(path || '').trim();
    if (!key) return '';
    if (Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key];
    const parts = key.split('.');
    let value = ctx;
    for (const part of parts) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
    }
    return value;
}

// Split `str` by `sep` while honouring quotes and [] nesting.
function splitTopLevel(str, sep) {
    const out = [];
    let buffer = '';
    let depth = 0;
    let quote = '';
    for (let i = 0; i < str.length; i += 1) {
        const ch = str[i];
        if (quote) {
            buffer += ch;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
        if (ch === '[') { depth += 1; buffer += ch; continue; }
        if (ch === ']') { depth = Math.max(0, depth - 1); buffer += ch; continue; }
        if (depth === 0 && str.startsWith(sep, i)) {
            out.push(buffer);
            buffer = '';
            i += sep.length - 1;
            continue;
        }
        buffer += ch;
    }
    out.push(buffer);
    return out;
}

function unquote(value) {
    const trimmed = String(value || '').trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function parseArgs(raw) {
    if (raw === undefined) return [];
    return splitTopLevel(raw, ',').map((arg) => unquote(arg));
}

function applyModifier(value, modifierRaw, ctx, depth) {
    const modifier = String(modifierRaw || '').trim();
    if (!modifier) return value;

    // Conditional: ["TRUE"||"FALSE"]
    if (modifier.startsWith('[') && modifier.endsWith(']')) {
        const inner = modifier.slice(1, -1);
        const branches = splitTopLevel(inner, '||');
        const truthy = isTruthy(value);
        const chosen = truthy ? branches[0] : (branches[1] !== undefined ? branches[1] : '');
        return render(unquote(chosen), ctx, depth + 1);
    }

    const callMatch = modifier.match(/^([a-zA-Z_][\w]*)\s*(?:\((.*)\))?$/s);
    if (!callMatch) return value;
    const name = callMatch[1].toLowerCase();
    const args = parseArgs(callMatch[2]);

    switch (name) {
        case 'upper': return stringify(value).toUpperCase();
        case 'lower': return stringify(value).toLowerCase();
        case 'title': return stringify(value).replace(/\b\w/g, (c) => c.toUpperCase());
        case 'trim': return stringify(value).trim();
        case 'bytes': return formatBytes(value);
        case 'join': return Array.isArray(value) ? value.filter(isTruthy).join(args[0] !== undefined ? args[0] : ' ') : stringify(value);
        case 'first': return Array.isArray(value) ? (value[0] === undefined ? '' : value[0]) : stringify(value);
        case 'length': case 'count': return Array.isArray(value) ? value.length : stringify(value).length;
        case 'default': case 'or': return isTruthy(value) ? value : (args[0] !== undefined ? args[0] : '');
        case 'prefix': return isTruthy(value) ? `${args[0] !== undefined ? args[0] : ''}${stringify(value)}` : '';
        case 'suffix': return isTruthy(value) ? `${stringify(value)}${args[0] !== undefined ? args[0] : ''}` : '';
        case 'replace': return stringify(value).split(args[0] !== undefined ? args[0] : '').join(args[1] !== undefined ? args[1] : '');
        case 'exists': return isTruthy(value);
        case 'number': case 'int': { const n = Number(value); return Number.isFinite(n) ? n : ''; }
        default: return value;
    }
}

function evaluateToken(inner, ctx, depth) {
    const segments = splitTopLevel(inner, '::');
    const path = segments[0];
    let value = resolvePath(ctx, path);
    for (let i = 1; i < segments.length; i += 1) {
        value = applyModifier(value, segments[i], ctx, depth);
    }
    return stringify(value);
}

function render(template, ctx, depth = 0) {
    const src = String(template || '');
    if (!src || depth > MAX_DEPTH) return src;

    let out = '';
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '{') {
            // Find matching closing brace, respecting nested braces in branches.
            let braceDepth = 1;
            let quote = '';
            let j = i + 1;
            while (j < src.length && braceDepth > 0) {
                const cj = src[j];
                if (quote) {
                    if (cj === quote) quote = '';
                } else if (cj === '"' || cj === "'") {
                    quote = cj;
                } else if (cj === '{') {
                    braceDepth += 1;
                } else if (cj === '}') {
                    braceDepth -= 1;
                    if (braceDepth === 0) break;
                }
                j += 1;
            }
            if (braceDepth !== 0) { out += src.slice(i); break; }
            const inner = src.slice(i + 1, j);
            out += evaluateToken(inner, ctx, depth);
            i = j + 1;
            if (out.length > MAX_OUTPUT) break;
            continue;
        }
        out += ch;
        i += 1;
        if (out.length > MAX_OUTPUT) break;
    }
    return out;
}

function renderTemplate(template, ctx = {}) {
    const result = render(template, ctx, 0);
    return result.replace(/\\n/g, '\n');
}

module.exports = {
    renderTemplate,
    formatBytes,
    isTruthy,
    splitTopLevel
};
