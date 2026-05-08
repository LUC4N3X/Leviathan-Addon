'use strict';

const {
    DEFAULT_RECIPE_DIR,
    buildRecipeIndex,
    loadProviderRecipes,
    normalizeRecipe,
    validateProviderRecipe
} = require('./provider_recipe_loader');
const { runProviderPipeline } = require('./provider_pipeline');
const { ProviderFallbackManager } = require('./provider_fallback_manager');
const { normalizeProviderId } = require('./provider_result_normalizer');

let defaultEngine = null;

class ProviderDefinitionEngine {
    constructor({ recipes = null, recipesDir = DEFAULT_RECIPE_DIR, logger = null, fetcher = null } = {}) {
        this.recipesDir = recipesDir;
        this.logger = logger;
        this.fetcher = fetcher;
        this.fallbackManager = new ProviderFallbackManager({ logger });
        this.reload(recipes);
    }

    reload(recipes = null) {
        const loadedRecipes = Array.isArray(recipes)
            ? recipes.map(normalizeRecipe)
            : loadProviderRecipes({ recipesDir: this.recipesDir, logger: this.logger });
        this.recipes = loadedRecipes.filter((recipe) => recipe.enabled !== false);
        this.index = buildRecipeIndex(this.recipes);
        if (this.logger?.info) this.logger.info(`[PROVIDER ENGINE] loaded recipes=${this.recipes.length}`);
        return this.recipes;
    }

    listRecipes() {
        return this.recipes.map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            tags: recipe.tags || [],
            antiBot: recipe.antiBot || {},
            reliability: recipe.reliability || {},
            fallback: recipe.fallback || []
        }));
    }

    getRecipe(value) {
        const key = normalizeProviderId(value);
        return key ? this.index.get(key) || null : null;
    }

    hasRecipe(value) {
        return Boolean(this.getRecipe(value));
    }

    validateRecipe(value) {
        const recipe = typeof value === 'string' ? this.getRecipe(value) : normalizeRecipe(value);
        return validateProviderRecipe(recipe || {});
    }

    async run(value, context = {}, options = {}) {
        const recipe = typeof value === 'string' ? this.getRecipe(value) : normalizeRecipe(value);
        if (!recipe) throw new Error(`Unknown provider recipe: ${value}`);
        return runProviderPipeline({
            recipe,
            context,
            fetcher: options.fetcher || this.fetcher,
            logger: options.logger || this.logger,
            fallbackManager: options.fallbackManager || this.fallbackManager
        });
    }
}

function getDefaultProviderDefinitionEngine(options = {}) {
    if (!defaultEngine || options.forceReload === true) defaultEngine = new ProviderDefinitionEngine(options);
    return defaultEngine;
}

function getProviderRecipe(value) {
    return getDefaultProviderDefinitionEngine().getRecipe(value);
}

module.exports = {
    ProviderDefinitionEngine,
    getDefaultProviderDefinitionEngine,
    getProviderRecipe
};
