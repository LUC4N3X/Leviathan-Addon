'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeProviderId } = require('./provider_result_normalizer');

const DEFAULT_RECIPE_DIR = path.join(__dirname, '..', 'provider_recipes');

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function uniqueList(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of asArray(values)) {
        const text = String(value || '').trim();
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function normalizeRecipe(rawRecipe = {}) {
    const id = normalizeProviderId(rawRecipe.id || rawRecipe.key || rawRecipe.name);
    const name = String(rawRecipe.name || rawRecipe.label || id || '').trim();
    const baseUrls = uniqueList(rawRecipe.baseUrls || rawRecipe.baseUrl || rawRecipe.domains);
    const tags = uniqueList(rawRecipe.tags || rawRecipe.capabilities);

    return {
        ...rawRecipe,
        id,
        key: rawRecipe.key || id,
        name,
        baseUrls,
        baseUrl: rawRecipe.baseUrl || baseUrls[0] || '',
        tags,
        headers: rawRecipe.headers || {},
        search: rawRecipe.search || {},
        selectors: rawRecipe.selectors || {},
        parsing: rawRecipe.parsing || {},
        recovery: rawRecipe.recovery || {},
        fallback: rawRecipe.fallback || rawRecipe.fallbacks || [],
        timeouts: rawRecipe.timeouts || {},
        reliability: rawRecipe.reliability || { initial: 'good' },
        antiBot: rawRecipe.antiBot || { mode: 'direct-first' },
        enabled: rawRecipe.enabled !== false
    };
}

function validateProviderRecipe(recipe = {}) {
    const errors = [];
    if (!recipe || typeof recipe !== 'object') errors.push('recipe must be an object');
    if (!recipe.id) errors.push('missing id');
    if (!recipe.name) errors.push('missing name');
    if (recipe.search && typeof recipe.search !== 'object') errors.push('search must be an object');
    if (recipe.selectors && typeof recipe.selectors !== 'object') errors.push('selectors must be an object');
    if (recipe.headers && typeof recipe.headers !== 'object') errors.push('headers must be an object');
    if (recipe.fallback && !Array.isArray(recipe.fallback)) errors.push('fallback must be an array');
    if (recipe.recovery && typeof recipe.recovery !== 'object') errors.push('recovery must be an object');
    return { ok: errors.length === 0, errors };
}

function loadRecipeFile(filePath) {
    const loaded = require(filePath);
    const rawRecipe = loaded && loaded.default ? loaded.default : loaded;
    const recipe = normalizeRecipe(typeof rawRecipe === 'function' ? rawRecipe() : rawRecipe);
    const validation = validateProviderRecipe(recipe);
    return { recipe, validation, filePath };
}

function loadProviderRecipes({ recipesDir = DEFAULT_RECIPE_DIR, logger = null } = {}) {
    if (!fs.existsSync(recipesDir)) return [];

    const files = fs.readdirSync(recipesDir)
        .filter((name) => /\.recipe\.js$/i.test(name))
        .sort();

    const recipes = [];
    for (const fileName of files) {
        const filePath = path.join(recipesDir, fileName);
        try {
            const { recipe, validation } = loadRecipeFile(filePath);
            if (!validation.ok) {
                if (logger?.warn) logger.warn(`[PROVIDER ENGINE] invalid recipe ${fileName}: ${validation.errors.join(', ')}`);
                continue;
            }
            recipes.push(recipe);
        } catch (error) {
            if (logger?.warn) logger.warn(`[PROVIDER ENGINE] failed to load recipe ${fileName}: ${error?.message || error}`);
        }
    }
    return recipes;
}

function buildRecipeIndex(recipes = []) {
    const index = new Map();
    for (const rawRecipe of recipes) {
        const recipe = normalizeRecipe(rawRecipe);
        const aliases = uniqueList([
            recipe.id,
            recipe.key,
            recipe.name,
            recipe.cacheName,
            recipe.sourceName,
            recipe.aliases
        ]);
        for (const alias of aliases) index.set(normalizeProviderId(alias), recipe);
    }
    return index;
}

module.exports = {
    DEFAULT_RECIPE_DIR,
    buildRecipeIndex,
    loadProviderRecipes,
    normalizeRecipe,
    validateProviderRecipe
};
