'use strict';

let cheerio = null;
try {
    cheerio = require('cheerio');
} catch (_) {
    cheerio = null;
}
const { normalizeProviderResults, normalizeUrl } = require('./provider_result_normalizer');
const { ProviderFallbackManager, shouldTryFallback } = require('./provider_fallback_manager');

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function encodePath(template = '', context = {}) {
    return String(template || '').replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, key) => {
        const value = key.split('.').reduce((acc, part) => acc && acc[part], context);
        return encodeURIComponent(String(value ?? ''));
    });
}

function buildSearchUrl(recipe = {}, context = {}) {
    const search = recipe.search || {};
    const baseUrl = recipe.baseUrl || recipe.baseUrls?.[0] || '';
    const rawPath = typeof search.path === 'function' ? search.path(context, recipe) : encodePath(search.path || '', context);
    return normalizeUrl(rawPath, baseUrl);
}

function buildRequestDescriptor(recipe = {}, context = {}) {
    const search = recipe.search || {};
    if (typeof search.buildRequest === 'function') return search.buildRequest(context, recipe);

    const method = String(search.method || 'GET').toUpperCase();
    const url = buildSearchUrl(recipe, context);
    const headers = typeof recipe.headers?.build === 'function'
        ? recipe.headers.build(context, recipe)
        : { ...(recipe.headers?.static || recipe.headers || {}) };
    const query = typeof search.buildQuery === 'function' ? search.buildQuery(context, recipe) : (search.query || null);
    const body = typeof search.buildBody === 'function' ? search.buildBody(context, recipe) : (search.body || null);

    return { method, url, headers, query, body, timeout: recipe.timeouts?.searchMs || search.timeoutMs };
}

function selectText($, root, selector) {
    if (!selector) return '';
    if (typeof selector === 'function') return selector($, root) || '';
    const raw = String(selector || '');
    const attrMatch = raw.match(/(.+)@([a-zA-Z0-9:_-]+)$/);
    if (attrMatch) return root.find(attrMatch[1]).first().attr(attrMatch[2]) || '';
    return root.find(raw).first().text().trim();
}

function parseWithFallbackRegex(html = '', recipe = {}) {
    const selectors = recipe.selectors || {};
    const itemClass = String(selectors.resultItems || '').match(/\.([a-zA-Z0-9_-]+)/)?.[1];
    if (!itemClass) return [];
    const itemRegex = new RegExp(`<([a-z0-9]+)[^>]+class=["'][^"']*${itemClass}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const out = [];
    let match;
    while ((match = itemRegex.exec(String(html || ''))) !== null) {
        const block = match[2] || '';
        const href = (block.match(/<a[^>]+href=["']([^"']+)["']/i) || [])[1] || '';
        const title = (block.match(/class=["'][^"']*(?:title|name)[^"']*["'][^>]*>([^<]+)/i) || [])[1]
            || (block.match(/<a[^>]*>([^<]+)/i) || [])[1]
            || '';
        const quality = (block.match(/class=["'][^"']*quality[^"']*["'][^>]*>([^<]+)/i) || [])[1] || '';
        const language = (block.match(/class=["'][^"']*language[^"']*["'][^>]*>([^<]+)/i) || [])[1] || '';
        if (title || href) out.push({ title: title.trim(), href, quality: quality.trim(), language: language.trim() });
    }
    return out;
}

function parseWithSelectors(html = '', recipe = {}, context = {}) {
    const selectors = recipe.selectors || {};
    if (!selectors.resultItems) return [];
    if (!cheerio) return parseWithFallbackRegex(html, recipe);

    const $ = cheerio.load(String(html || ''));
    const out = [];
    $(selectors.resultItems).each((_, element) => {
        const root = $(element);
        const result = {
            title: selectText($, root, selectors.title),
            href: selectText($, root, selectors.href),
            year: selectText($, root, selectors.year),
            quality: selectText($, root, selectors.quality),
            language: selectText($, root, selectors.language),
            description: selectText($, root, selectors.description)
        };
        if (result.title || result.href) out.push(result);
    });

    if (typeof recipe.parsing?.mapResults === 'function') return recipe.parsing.mapResults(out, context, recipe) || [];
    return out;
}

function parseProviderResponse(response, recipe = {}, context = {}) {
    if (typeof recipe.parsing?.parseResponse === 'function') return recipe.parsing.parseResponse(response, context, recipe) || [];
    if (Array.isArray(response)) return response;
    if (response && Array.isArray(response.results)) return response.results;
    const html = response?.data ?? response?.body ?? response?.text ?? response;
    return parseWithSelectors(html, recipe, context);
}

async function runProviderPipeline({ recipe = {}, context = {}, fetcher, logger = null, fallbackManager = null } = {}) {
    const startedAt = Date.now();
    const manager = fallbackManager || new ProviderFallbackManager({ logger });
    const request = buildRequestDescriptor(recipe, context);
    const stageLog = [];
    let rawResults = [];
    let error = null;

    try {
        if (typeof recipe.preflight === 'function') await recipe.preflight(context, recipe);
        if (typeof fetcher !== 'function') throw new Error('provider pipeline fetcher is required');
        const response = await fetcher(request, { recipe, context });
        rawResults = parseProviderResponse(response, recipe, context);
        stageLog.push({ stage: 'search', ok: true, count: asArray(rawResults).length });
    } catch (caught) {
        error = caught;
        stageLog.push({ stage: 'search', ok: false, error: caught?.message || String(caught) });
    }

    let fallbackAttempts = [];
    if ((!rawResults || rawResults.length === 0) && shouldTryFallback(error)) {
        const fallbackPass = await manager.runFallbacks({
            recipe,
            context,
            reason: error,
            runner: async (fallback) => {
                if (typeof recipe.runFallback === 'function') return recipe.runFallback(fallback, context, recipe);
                if (typeof fetcher === 'function') {
                    return fetcher({ fallback, recipe, context }, { fallback, recipe, context });
                }
                return [];
            }
        });
        rawResults = fallbackPass.results;
        fallbackAttempts = fallbackPass.attempts;
    }

    const results = normalizeProviderResults(rawResults, recipe, context);
    return {
        ok: !error || results.length > 0,
        providerId: recipe.id,
        providerName: recipe.name,
        request,
        results,
        count: results.length,
        ms: Date.now() - startedAt,
        stages: stageLog,
        fallbackAttempts,
        error: error ? { message: error.message || String(error), status: error.status || error.statusCode || error.response?.status || 0 } : null
    };
}

module.exports = {
    buildRequestDescriptor,
    buildSearchUrl,
    parseProviderResponse,
    parseWithSelectors,
    runProviderPipeline
};
