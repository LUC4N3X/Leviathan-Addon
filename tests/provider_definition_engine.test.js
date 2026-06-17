'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderDefinitionEngine } = require('../providers/engine/provider_definition_engine');

const html = `
<html><body>
  <article class="result-item">
    <a href="/from-s01e07">FROM S01E07</a>
    <span class="title">FROM S01E07</span>
    <span class="quality">1080p</span>
    <span class="language">ITA</span>
  </article>
</body></html>`;

test('provider definition engine loads recipes and validates current web providers', () => {
    const engine = new ProviderDefinitionEngine();
    const ids = engine.listRecipes().map((recipe) => recipe.id);
    assert.ok(ids.includes('guardahd'));
    assert.ok(ids.includes('animeworld'));
});

test('provider pipeline parses selector-based recipe with injected fetcher', async () => {
    const engine = new ProviderDefinitionEngine({
        recipes: [{
            id: 'demo',
            name: 'Demo',
            baseUrl: 'https://example.test',
            search: { method: 'GET', path: '/search/{title}' },
            selectors: {
                resultItems: '.result-item',
                title: '.title',
                href: 'a@href',
                quality: '.quality',
                language: '.language'
            },
            fallback: []
        }]
    });

    const pass = await engine.run('demo', { title: 'FROM' }, {
        fetcher: async () => ({ data: html, status: 200 })
    });

    assert.equal(pass.ok, true);
    assert.equal(pass.results.length, 1);
    assert.equal(pass.results[0].providerId, 'demo');
    assert.equal(pass.results[0].title, 'FROM S01E07');
    assert.equal(pass.results[0].quality, '1080p');
    assert.equal(pass.results[0].language, 'ITA');
    assert.equal(pass.results[0].url, 'https://example.test/from-s01e07');
});
