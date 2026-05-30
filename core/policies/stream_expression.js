'use strict';

/**
 * Safe Stream Expression Language.
 *
 * No eval / Function constructor.
 * Supported:
 *   cached && resolution("1080p","2160p") && seeders >= 5
 *   quality in ["webdl", "webrip"] && !language("ita")
 *   regex("web[- .]?dl", "i") && sizeGB < 20
 *   service == "rd" || debrid == "tb"
 */

const TOKEN = {
    NUMBER: 'number',
    STRING: 'string',
    IDENT: 'ident',
    OP: 'op',
    PUNC: 'punc',
    EOF: 'eof'
};

const MAX_TOKENS = 512;
const MAX_STRING = 512;

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function joinedText(item = {}) {
    return [
        item.title,
        item.name,
        item.filename,
        item.fileName,
        item.file_title,
        item.quality,
        item.resolution,
        item.source,
        item.provider,
        item.externalAddon,
        item.externalGroup,
        item.releaseGroup,
        item.language,
        item.languages,
        item._rdCacheState,
        item.rdCacheState,
        item.cacheState,
        item.behaviorHints?.filename,
        item.behaviorHints?.videoResolution,
        item.behaviorHints?.cacheState
    ].flat().filter(Boolean).join(' ');
}

function getSizeBytes(item = {}) {
    const candidates = [
        item._size,
        item.sizeBytes,
        item.fileSize,
        item.file_size,
        item.mainFileSize,
        item.behaviorHints?.videoSize,
        item.size
    ];
    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
        const match = String(value || '').match(/(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB)\b/i);
        if (match) {
            const amount = Number(match[1].replace(',', '.'));
            const unit = match[2].toUpperCase();
            const power = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 }[unit] || 0;
            return Math.round(amount * Math.pow(1024, power));
        }
    }
    return 0;
}

function detectResolution(item = {}) {
    const text = normalizeText(joinedText(item));
    const match = text.match(/\b(2160p|1080p|720p|576p|480p|360p|4k|uhd)\b/);
    if (!match) return '';
    return match[1].replace('4k', '2160p').replace('uhd', '2160p');
}

function detectQuality(item = {}) {
    const text = normalizeText(joinedText(item)).replace(/web\s*[-.]?\s*dl/g, 'webdl');
    const match = text.match(/\b(remux|bluray|bdrip|bdmux|webdl|webrip|web|hdtv|hdrip|dvdrip|cam|hdcam|telesync|telecine|ts)\b/);
    if (!match) return '';
    const value = match[1];
    if (value === 'web') return 'web';
    return value;
}

function detectEncode(item = {}) {
    const text = normalizeText(joinedText(item));
    const match = text.match(/\b(av1|x265|h265|hevc|x264|h264|vp9)\b/);
    if (!match) return '';
    const value = match[1];
    if (value === 'h265' || value === 'hevc') return 'x265';
    if (value === 'h264') return 'x264';
    return value;
}

function detectLanguage(item = {}) {
    const explicit = [item.language, item.languages, item._language, item.lang].flat().filter(Boolean).join(' ');
    const text = normalizeText(`${explicit} ${joinedText(item)}`);
    const langs = [];
    if (/(?:🇮🇹|\bita\b|\bitalian(?:o|a)?\b|(?:^|[^a-z0-9])it(?:[^a-z0-9]|$))/.test(text)) langs.push('ita');
    if (/(?:🇬🇧|🇺🇸|\beng\b|\benglish\b|(?:^|[^a-z0-9])en(?:[^a-z0-9]|$))/.test(text)) langs.push('eng');
    if (/\bmulti\b|\bdual\b|dual[-\s]?audio/.test(text)) langs.push('multi');
    return [...new Set(langs)];
}

function detectService(item = {}) {
    const text = normalizeText([
        item.service,
        item.debridService,
        item.provider,
        item.source,
        item.externalAddon,
        item.externalGroup,
        item.behaviorHints?.service
    ].filter(Boolean).join(' '));
    if (/\b(real[-\s]?debrid|rd)\b/.test(text)) return 'rd';
    if (/\b(torbox|tb)\b/.test(text)) return 'tb';
    if (/\b(premiumize|pm)\b/.test(text)) return 'pm';
    if (/\b(alldebrid|ad)\b/.test(text)) return 'ad';
    return text.split(/\s+/)[0] || '';
}

function detectCacheState(item = {}) {
    if (
        item.isSavedCloud || item._savedCloud || item.savedCloud ||
        item._dbCachedRd === true || item.cached_rd === true ||
        item.isCached === true || item.cached === true ||
        item._tbCached === true || item.tbCached === true ||
        item.behaviorHints?.cached === true
    ) return 'cached';

    const text = normalizeText([
        item._rdCacheState,
        item.rdCacheState,
        item.cacheState,
        item.rdStatus,
        item._tbCacheState,
        item.tbCacheState,
        item.behaviorHints?.rdCacheState,
        item.behaviorHints?.cacheState,
        item.title,
        item.name
    ].filter(Boolean).join(' '));

    if (/cached|instant|available|⚡/.test(text)) return 'cached';
    if (/likely/.test(text)) return 'likely_cached';
    if (/uncached|not_cached|not cached/.test(text)) return 'uncached';
    if (/probing|checking/.test(text)) return 'probing';
    return 'unknown';
}

function buildStreamExpressionContext(item = {}, meta = {}, extra = {}) {
    const sizeBytes = getSizeBytes(item);
    const languages = detectLanguage(item);
    const cacheState = detectCacheState(item);
    const service = detectService(item);
    const text = joinedText(item);
    const seeders = Number(item.seeders ?? item.seeds ?? item.peers ?? item.seedCount ?? 0) || 0;
    const rank = Number(extra.rank ?? item._rank ?? item.rank ?? 0) || 0;
    const score = Number(item._score ?? item._compositeScore ?? item.score ?? 0) || 0;

    return {
        item,
        meta,
        title: String(item.title || item.name || item.filename || ''),
        text,
        textLower: normalizeText(text),
        resolution: detectResolution(item),
        quality: detectQuality(item),
        encode: detectEncode(item),
        languages,
        language: languages[0] || '',
        service,
        debrid: service,
        source: String(item.source || item.provider || item.externalAddon || item.externalGroup || ''),
        provider: String(item.provider || item.source || ''),
        cached: cacheState === 'cached',
        likelyCached: cacheState === 'likely_cached',
        uncached: cacheState === 'uncached',
        cacheState,
        rdState: String(item._rdCacheState || item.rdCacheState || item.cacheState || ''),
        tbState: String(item._tbCacheState || item.tbCacheState || ''),
        savedCloud: Boolean(item.isSavedCloud || item._savedCloud || item.savedCloud),
        http: /^https?:\/\//i.test(String(item.url || '')),
        lazy: /\/play_lazy\//i.test(String(item.url || '')) || Boolean(item.lazy || item._lazy),
        magnet: /^magnet:/i.test(String(item.url || item.magnet || '')),
        seeders,
        sizeBytes,
        sizeMB: sizeBytes / (1024 * 1024),
        sizeGB: sizeBytes / (1024 * 1024 * 1024),
        bitrate: Number(item.bitrate || item._bitrate || 0) || 0,
        rank,
        score,
        fileIdx: item.fileIdx ?? item.fileIndex ?? item.file_index ?? null,
        season: meta?.season ?? item.season ?? null,
        episode: meta?.episode ?? item.episode ?? null,
        isSeries: Boolean(meta?.isSeries || meta?.season || meta?.episode || item.season || item.episode)
    };
}

function tokenize(input) {
    const src = String(input || '');
    const tokens = [];
    let i = 0;

    const push = (type, value) => {
        tokens.push({ type, value });
        if (tokens.length > MAX_TOKENS) throw new Error('expression_too_long');
    };

    while (i < src.length) {
        const ch = src[i];
        if (/\s/.test(ch)) { i += 1; continue; }

        if (ch === '"' || ch === "'") {
            const quote = ch;
            i += 1;
            let out = '';
            while (i < src.length && src[i] !== quote) {
                if (src[i] === '\\' && i + 1 < src.length) {
                    const next = src[i + 1];
                    out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
                    i += 2;
                } else {
                    out += src[i];
                    i += 1;
                }
                if (out.length > MAX_STRING) throw new Error('string_too_long');
            }
            if (src[i] !== quote) throw new Error('unterminated_string');
            i += 1;
            push(TOKEN.STRING, out);
            continue;
        }

        if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1]))) {
            const start = i;
            i += 1;
            while (i < src.length && /[\d.]/.test(src[i])) i += 1;
            push(TOKEN.NUMBER, Number(src.slice(start, i)));
            continue;
        }

        const two = src.slice(i, i + 2);
        if (['&&', '||', '==', '!=', '>=', '<=', '=~', '!~'].includes(two)) {
            push(TOKEN.OP, two); i += 2; continue;
        }

        if (['!', '>', '<'].includes(ch)) {
            push(TOKEN.OP, ch); i += 1; continue;
        }

        if ('(),[]?:'.includes(ch)) {
            push(TOKEN.PUNC, ch); i += 1; continue;
        }

        if (/[A-Za-z_]/.test(ch)) {
            const start = i;
            i += 1;
            while (i < src.length && /[A-Za-z0-9_.-]/.test(src[i])) i += 1;
            const word = src.slice(start, i);
            if (['in', 'contains', 'startsWith', 'endsWith'].includes(word)) push(TOKEN.OP, word);
            else push(TOKEN.IDENT, word);
            continue;
        }

        throw new Error(`unexpected_token:${ch}`);
    }

    push(TOKEN.EOF, '');
    return tokens;
}

class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
    }

    peek() { return this.tokens[this.pos] || { type: TOKEN.EOF, value: '' }; }
    next() { return this.tokens[this.pos++] || { type: TOKEN.EOF, value: '' }; }
    match(value) {
        if (this.peek().value === value) { this.next(); return true; }
        return false;
    }
    expect(value) {
        if (!this.match(value)) throw new Error(`expected:${value}`);
    }

    parse() {
        const ast = this.parseTernary();
        if (this.peek().type !== TOKEN.EOF) throw new Error(`unexpected:${this.peek().value}`);
        return ast;
    }

    parseTernary() {
        const condition = this.parseOr();
        if (this.match('?')) {
            const consequent = this.parseTernary();
            this.expect(':');
            const alternate = this.parseTernary();
            return { type: 'ternary', condition, consequent, alternate };
        }
        return condition;
    }

    parseOr() {
        let node = this.parseAnd();
        while (this.match('||')) node = { type: 'binary', op: '||', left: node, right: this.parseAnd() };
        return node;
    }

    parseAnd() {
        let node = this.parseCompare();
        while (this.match('&&')) node = { type: 'binary', op: '&&', left: node, right: this.parseCompare() };
        return node;
    }

    parseCompare() {
        let node = this.parseUnary();
        while (['==', '!=', '>', '>=', '<', '<=', '=~', '!~', 'in', 'contains', 'startsWith', 'endsWith'].includes(this.peek().value)) {
            const op = this.next().value;
            node = { type: 'binary', op, left: node, right: this.parseUnary() };
        }
        return node;
    }

    parseUnary() {
        if (this.match('!')) return { type: 'unary', op: '!', value: this.parseUnary() };
        return this.parsePrimary();
    }

    parsePrimary() {
        const token = this.next();

        if (token.type === TOKEN.NUMBER) return { type: 'literal', value: token.value };
        if (token.type === TOKEN.STRING) return { type: 'literal', value: token.value };

        if (token.type === TOKEN.IDENT) {
            if (token.value === 'true') return { type: 'literal', value: true };
            if (token.value === 'false') return { type: 'literal', value: false };
            if (token.value === 'null') return { type: 'literal', value: null };

            if (this.match('(')) {
                const args = [];
                if (!this.match(')')) {
                    do { args.push(this.parseOr()); } while (this.match(','));
                    this.expect(')');
                }
                return { type: 'call', name: token.value, args };
            }

            return { type: 'ident', name: token.value };
        }

        if (token.value === '(') {
            const node = this.parseOr();
            this.expect(')');
            return node;
        }

        if (token.value === '[') {
            const values = [];
            if (!this.match(']')) {
                do { values.push(this.parseOr()); } while (this.match(','));
                this.expect(']');
            }
            return { type: 'array', values };
        }

        throw new Error(`unexpected_primary:${token.value}`);
    }
}

function getValue(ctx, name) {
    if (!name) return undefined;
    if (Object.prototype.hasOwnProperty.call(ctx, name)) return ctx[name];

    const parts = String(name).split('.');
    let value = ctx;
    for (const part of parts) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
    }
    return value;
}

function toComparable(value) {
    if (Array.isArray(value)) return value.map(toComparable);
    if (typeof value === 'string') return normalizeText(value);
    return value;
}

function includesValue(left, right) {
    const l = toComparable(left);
    const r = toComparable(right);
    if (Array.isArray(l)) return l.includes(r);
    if (Array.isArray(r)) return r.includes(l);
    return String(l).includes(String(r));
}

function aggregateField(subContext, field) {
    const key = String(field || 'seeders');
    if (key === 'size' || key === 'sizeBytes') return Number(subContext.sizeBytes || 0) || 0;
    if (key === 'size_gb' || key === 'sizeGB' || key === 'gb') return Number(subContext.sizeGB || 0) || 0;
    const value = Number(subContext[key]);
    return Number.isFinite(value) ? value : 0;
}

// Collection-aware overloads. They only trigger when the first argument is an
// array of stream sub-contexts (i.e. the `streams` identifier), so per-item
// usage like `resolution("1080p")` keeps its original boolean behaviour.
function evalCollectionCall(n, values) {
    const collection = values[0];
    const args = values.slice(1);
    const normalizedArgs = args.map(normalizeText);

    switch (n) {
        case 'count': return collection.length;
        case 'sum': return collection.reduce((acc, c) => acc + aggregateField(c, args[0]), 0);
        case 'avg': return collection.length ? collection.reduce((acc, c) => acc + aggregateField(c, args[0]), 0) / collection.length : 0;
        case 'max': return collection.reduce((acc, c) => Math.max(acc, aggregateField(c, args[0])), -Infinity);
        case 'min': return collection.reduce((acc, c) => Math.min(acc, aggregateField(c, args[0])), Infinity);
        case 'resolution': return collection.filter((c) => normalizedArgs.includes(c.resolution));
        case 'quality': return collection.filter((c) => normalizedArgs.includes(c.quality));
        case 'encode': return collection.filter((c) => normalizedArgs.includes(c.encode));
        case 'language': case 'lang': return collection.filter((c) => normalizedArgs.some((v) => c.languages.includes(v)));
        case 'service': case 'debrid': return collection.filter((c) => normalizedArgs.includes(c.service));
        case 'source': return collection.filter((c) => normalizedArgs.some((v) => normalizeText(c.source).includes(v)));
        case 'text': return collection.filter((c) => normalizedArgs.some((v) => c.textLower.includes(v)));
        case 'cached': return collection.filter((c) => c.cached);
        case 'likelyCached': return collection.filter((c) => c.likelyCached);
        case 'uncached': return collection.filter((c) => c.uncached);
        case 'savedCloud': return collection.filter((c) => c.savedCloud);
        case 'http': return collection.filter((c) => c.http);
        case 'regex': {
            try {
                const re = new RegExp(String(args[0] || '').slice(0, 300), String(args[1] || 'i').replace(/[^gimsuy]/g, '') || 'i');
                return collection.filter((c) => {
                    re.lastIndex = 0;
                    return re.test(c.text);
                });
            } catch (_) {
                return [];
            }
        }
        default: return [];
    }
}

function evalCall(name, args, ctx) {
    const values = args.map((arg) => evaluateAst(arg, ctx));
    const n = String(name || '').trim();

    if (Array.isArray(values[0])) return evalCollectionCall(n, values);
    if (n === 'count') return Number(values[0]) || 0;

    if (n === 'resolution') return values.map(normalizeText).includes(ctx.resolution);
    if (n === 'quality') return values.map(normalizeText).includes(ctx.quality);
    if (n === 'encode') return values.map(normalizeText).includes(ctx.encode);
    if (n === 'language' || n === 'lang') return values.map(normalizeText).some((v) => ctx.languages.includes(v));
    if (n === 'service' || n === 'debrid') return values.map(normalizeText).includes(ctx.service);
    if (n === 'source') return values.map(normalizeText).some((v) => normalizeText(ctx.source).includes(v));
    if (n === 'cached') return ctx.cached;
    if (n === 'likelyCached') return ctx.likelyCached;
    if (n === 'uncached') return ctx.uncached;
    if (n === 'savedCloud') return ctx.savedCloud;
    if (n === 'http') return ctx.http;
    if (n === 'lazy') return ctx.lazy;
    if (n === 'text') return values.map(normalizeText).some((v) => ctx.textLower.includes(v));
    if (n === 'has') return Boolean(getValue(ctx, values[0]));
    if (n === 'regex') {
        try {
            const pattern = String(values[0] || '').slice(0, 300);
            const flags = String(values[1] || 'i').replace(/[^gimsuy]/g, '') || 'i';
            return new RegExp(pattern, flags).test(ctx.text);
        } catch (_) {
            return false;
        }
    }

    return Boolean(getValue(ctx, n));
}

function evaluateAst(node, ctx) {
    switch (node.type) {
        case 'literal': return node.value;
        case 'ident': return getValue(ctx, node.name);
        case 'array': return node.values.map((value) => evaluateAst(value, ctx));
        case 'unary': return !Boolean(evaluateAst(node.value, ctx));
        case 'ternary': return Boolean(evaluateAst(node.condition, ctx))
            ? evaluateAst(node.consequent, ctx)
            : evaluateAst(node.alternate, ctx);
        case 'call': return evalCall(node.name, node.args, ctx);
        case 'binary': {
            if (node.op === '&&') return Boolean(evaluateAst(node.left, ctx)) && Boolean(evaluateAst(node.right, ctx));
            if (node.op === '||') return Boolean(evaluateAst(node.left, ctx)) || Boolean(evaluateAst(node.right, ctx));

            const left = evaluateAst(node.left, ctx);
            const right = evaluateAst(node.right, ctx);
            const l = toComparable(left);
            const r = toComparable(right);

            if (node.op === '==') return Array.isArray(l) ? l.includes(r) : l === r;
            if (node.op === '!=') return Array.isArray(l) ? !l.includes(r) : l !== r;
            if (node.op === '>') return Number(left) > Number(right);
            if (node.op === '>=') return Number(left) >= Number(right);
            if (node.op === '<') return Number(left) < Number(right);
            if (node.op === '<=') return Number(left) <= Number(right);
            if (node.op === 'contains') return includesValue(left, right);
            if (node.op === 'in') return includesValue(right, left);
            if (node.op === 'startsWith') return String(l).startsWith(String(r));
            if (node.op === 'endsWith') return String(l).endsWith(String(r));
            if (node.op === '=~' || node.op === '!~') {
                let ok = false;
                try { ok = new RegExp(String(right), 'i').test(String(left)); } catch (_) { ok = false; }
                return node.op === '=~' ? ok : !ok;
            }
            return false;
        }
        default:
            return false;
    }
}

const AST_CACHE = new Map();

function compileExpression(expression) {
    const key = String(expression || '').trim();
    if (!key) return null;
    if (key.length > 1000) throw new Error('expression_too_long');
    if (AST_CACHE.has(key)) return AST_CACHE.get(key);
    const ast = new Parser(tokenize(key)).parse();
    AST_CACHE.set(key, ast);
    while (AST_CACHE.size > 256) AST_CACHE.delete(AST_CACHE.keys().next().value);
    return ast;
}

function evaluateExpression(expression, itemOrContext = {}, meta = {}, extra = {}) {
    try {
        const ast = compileExpression(expression);
        if (!ast) return false;
        const ctx = itemOrContext && itemOrContext.item
            ? itemOrContext
            : buildStreamExpressionContext(itemOrContext, meta, extra);
        return Boolean(evaluateAst(ast, ctx));
    } catch (error) {
        if (extra.logger && typeof extra.logger.warn === 'function') {
            extra.logger.warn(`[SEL] expression failed | expr=${String(expression).slice(0, 120)} | error=${error.message}`);
        }
        return false;
    }
}

function selectByExpression(items = [], expression = '', meta = {}, options = {}) {
    const list = Array.isArray(items) ? items : [];
    return list.filter((item, index) => evaluateExpression(expression, item, meta, { ...options, rank: index + 1 }));
}

function buildCollectionContext(items = [], meta = {}) {
    const streams = items.map((item, index) => buildStreamExpressionContext(item, meta, { rank: index + 1 }));
    return { streams, meta, total: streams.length };
}

// Evaluates a collection-aware expression once over the whole set. The result
// is expected to be the subset of stream sub-contexts to remove (typically the
// "then"/"else" branch of a ternary). Returns the raw evaluation result.
function evaluateCollectionExpression(items = [], expression = '', meta = {}, options = {}) {
    try {
        const ast = compileExpression(expression);
        if (!ast) return null;
        const ctx = buildCollectionContext(items, meta);
        return evaluateAst(ast, ctx);
    } catch (error) {
        if (options.logger && typeof options.logger.warn === 'function') {
            options.logger.warn(`[SEL] collection expression failed | expr=${String(expression).slice(0, 120)} | error=${error.message}`);
        }
        return null;
    }
}

// Removes the streams selected by a collection expression. Only an array result
// prunes items; anything else is a safe no-op so a malformed or boolean
// expression never silently drops the whole list.
function selectStreamsByCollectionExpression(items = [], expression = '', meta = {}, options = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!String(expression || '').trim() || list.length === 0) return { results: list, removed: 0 };

    const result = evaluateCollectionExpression(list, expression, meta, options);
    if (!Array.isArray(result) || result.length === 0) return { results: list, removed: 0 };

    const removeSet = new Set(result.map((entry) => entry && entry.item).filter(Boolean));
    if (removeSet.size === 0) return { results: list, removed: 0 };

    const results = list.filter((item) => !removeSet.has(item));
    return { results, removed: list.length - results.length };
}

module.exports = {
    buildStreamExpressionContext,
    evaluateExpression,
    selectByExpression,
    evaluateCollectionExpression,
    selectStreamsByCollectionExpression,
    compileExpression,
    normalizeText,
    detectResolution,
    detectQuality,
    detectEncode,
    detectLanguage,
    detectService,
    detectCacheState,
    getSizeBytes
};
