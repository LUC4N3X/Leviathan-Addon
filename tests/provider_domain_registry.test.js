'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createProviderDomainRegistry,
    getProviderDomain,
    getProviderDomains,
    normalizeProviderDomain,
    resetProviderDomainRegistryForTests
} = require('../providers/utils/provider_domain_registry');
const { normalizeRecipe } = require('../providers/engine/provider_recipe_loader');

test('normalizes provider domains to safe origins only', () => {
    assert.equal(normalizeProviderDomain('https://www.animeworld.ac/path?q=1'), 'https://www.animeworld.ac');
    assert.equal(normalizeProviderDomain('http://toonitalia.xyz/'), 'http://toonitalia.xyz');
    assert.equal(normalizeProviderDomain('javascript:alert(1)'), null);
    assert.equal(normalizeProviderDomain('https://user:pass@example.com'), null);
    assert.equal(normalizeProviderDomain('https://127.0.0.1:3000'), null);
    assert.equal(normalizeProviderDomain('https://[::1]:3000'), null);
});

test('registry accepts only known providers and safe domains from manifests', async () => {
    const registry = createProviderDomainRegistry({
        fetcher: async () => ({
            status: 200,
            headers: {},
            json: async () => ({
                animeworld: 'https://www.animeworld.new/path',
                evilprovider: 'https://evil.example',
                animeunity: 'file:///tmp/nope',
                toonitalia: ['https://toonitalia.org', 'https://127.0.0.1:3000']
            })
        })
    });

    const manifest = await registry.refresh({ sourceUrl: 'https://updates.example.test/provider-domains.json', force: true });

    assert.deepEqual(manifest.domains.animeworld, ['https://www.animeworld.new']);
    assert.deepEqual(manifest.domains.toonitalia, ['https://toonitalia.org']);
    assert.equal(manifest.domains.evilprovider, undefined);
    assert.equal(manifest.domains.animeunity, undefined);
});

test('registry follows redirects and keeps cached domains when refresh fails', async () => {
    const calls = [];
    const registry = createProviderDomainRegistry({
        fetcher: async (url) => {
            calls.push(url);
            if (url === 'https://updates.example.test/provider-domains.json') {
                return { status: 302, headers: { location: 'https://cdn.example.test/provider-domains.json' } };
            }
            if (url === 'https://cdn.example.test/provider-domains.json') {
                return {
                    status: 200,
                    headers: {},
                    json: async () => ({ streamingcommunity: 'https://vixsrc.new' })
                };
            }
            throw new Error('unexpected url');
        }
    });

    await registry.refresh({ sourceUrl: 'https://updates.example.test/provider-domains.json', force: true });
    assert.deepEqual(calls, [
        'https://updates.example.test/provider-domains.json',
        'https://cdn.example.test/provider-domains.json'
    ]);
    assert.equal(registry.get('streamingcommunity'), 'https://vixsrc.new');

    registry.setFetcher(async () => { throw new Error('network down'); });
    await registry.refresh({ sourceUrl: 'https://updates.example.test/provider-domains.json', force: true });
    assert.equal(registry.get('streamingcommunity'), 'https://vixsrc.new');
});

test('default registry feeds recipe loader and provider lookups', () => {
    resetProviderDomainRegistryForTests({
        domains: {
            altadefinizione: ['https://altadefinizione.cache'],
            animeworld: ['https://www.animeworld.cache'],
            streamingcommunity: ['https://vixsrc.cache']
        }
    });

    try {
        const recipe = normalizeRecipe({ id: 'animeworld', name: 'AnimeWorld' });

        assert.equal(recipe.baseUrl, 'https://www.animeworld.cache');
        assert.equal(recipe.baseUrls[0], 'https://www.animeworld.cache');
        assert.ok(recipe.baseUrls.includes('https://www.animeworld.ac'));

        const recipeWithStaticBase = normalizeRecipe({
            id: 'altadefinizione',
            name: 'Altadefinizione',
            baseUrl: 'https://altadefinizionestreaming.com'
        });
        assert.equal(recipeWithStaticBase.baseUrl, 'https://altadefinizione.cache');
        assert.ok(recipeWithStaticBase.baseUrls.includes('https://altadefinizionestreaming.com'));

        assert.equal(getProviderDomain('streamingcommunity'), 'https://vixsrc.cache');
        assert.ok(getProviderDomains('toonitalia').includes('https://toonitalia.xyz'));
    } finally {
        resetProviderDomainRegistryForTests();
    }
});
