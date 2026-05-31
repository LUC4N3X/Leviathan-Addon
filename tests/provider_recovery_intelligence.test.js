'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderDefinitionEngine } = require('../providers/engine/provider_definition_engine');
const { classifyProviderFailure } = require('../core/intelligence/provider_failure_classifier');
const { runProviderRecovery } = require('../core/intelligence/provider_recovery_intelligence');

const changedLayoutHtml = `
<html><body>
  <header><a href="/login">Login</a><a href="/privacy">Privacy</a></header>
  <main>
    <section class="fresh-layout">
      <h2><a href="/titles/from-s01e07">FROM S01E07 - ITA</a></h2>
      <p>Serie aggiornata 2024</p>
    </section>
    <a href="magnet:?xt=urn:btih:demo">FROM S01E07 magnet</a>
    <a href="/category/serie-tv">Serie TV</a>
  </main>
</body></html>`;

test('provider failure classifier detects selector misses on changed HTML layouts', () => {
    const failure = classifyProviderFailure({
        response: { data: changedLayoutHtml, status: 200 },
        rawResults: [],
        recipe: { id: 'demo' },
        context: { title: 'FROM', season: 1, episode: 7 }
    });

    assert.equal(failure.type, 'selector_miss');
    assert.equal(failure.recoverable, true);
    assert.equal(failure.canFallback, true);
});

test('provider recovery returns scored page-result candidates without direct media links', () => {
    const pass = runProviderRecovery({
        response: { data: changedLayoutHtml, status: 200 },
        recipe: {
            id: 'demo',
            name: 'Demo',
            baseUrl: 'https://example.test',
            recovery: {
                enabled: true,
                triggerOn: ['selector_miss'],
                minScore: 0.6,
                maxCandidates: 4,
                allowDomains: ['same-origin']
            }
        },
        context: { title: 'FROM', season: 1, episode: 7, year: 2024 },
        failure: { type: 'selector_miss', reason: 'selector_miss' }
    });

    assert.equal(pass.attempt.ok, true);
    assert.equal(pass.results.length, 1);
    assert.equal(pass.results[0].url, 'https://example.test/titles/from-s01e07');
    assert.equal(pass.results[0].recoveryUsed, true);
    assert.ok(pass.results[0].recoveryScore >= 0.6);
    assert.equal(pass.results.some((result) => String(result.url).startsWith('magnet:')), false);
});

test('provider pipeline uses recovery before recipe fallbacks', async () => {
    const engine = new ProviderDefinitionEngine({
        recipes: [{
            id: 'demo',
            name: 'Demo',
            baseUrl: 'https://example.test',
            search: { method: 'GET', path: '/search/{title}' },
            selectors: {
                resultItems: '.old-card',
                title: '.title',
                href: 'a@href'
            },
            recovery: {
                enabled: true,
                triggerOn: ['selector_miss'],
                minScore: 0.6,
                maxCandidates: 4,
                allowDomains: ['same-origin']
            },
            fallback: [{ id: 'fallback-search', stopOnHit: true }]
        }]
    });

    const pass = await engine.run('demo', { title: 'FROM', season: 1, episode: 7, year: 2024 }, {
        fetcher: async (request) => {
            assert.equal(Boolean(request.fallback), false);
            return { data: changedLayoutHtml, status: 200 };
        }
    });

    assert.equal(pass.ok, true);
    assert.equal(pass.count, 1);
    assert.equal(pass.results[0].recoveryUsed, true);
    assert.equal(pass.fallbackAttempts.length, 0);
    assert.equal(pass.recoveryAttempt.ok, true);
});
