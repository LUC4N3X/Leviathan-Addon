const test = require('node:test');
const assert = require('node:assert/strict');

const { renderTemplate } = require('../core/lib/format_template_engine');
const { formatStreamSelector } = require('../core/lib/stream_formatter');

const ctx = {
    stream: {
        title: 'Dune Part Two',
        resolution: '4K',
        size: 12 * 1024 * 1024 * 1024,
        visualTags: ['BluRay', 'HDR', 'AV1'],
        group: '',
        seeders: 0,
    },
    service: { name: 'RD', cached: true },
    addon: { name: 'Leviathan' },
};

test('resolves namespaced paths and copies literals verbatim', () => {
    assert.equal(renderTemplate('{addon.name} • {stream.resolution}', ctx), 'Leviathan • 4K');
});

test('bytes modifier formats byte counts', () => {
    assert.equal(renderTemplate('{stream.size::bytes}', ctx), '12.00 GB');
});

test('join modifier joins arrays with a separator', () => {
    assert.equal(renderTemplate('{stream.visualTags::join(" • ")}', ctx), 'BluRay • HDR • AV1');
});

test('conditional renders the truthy branch and supports nested templates', () => {
    assert.equal(
        renderTemplate('{service.cached::["⚡ {service.name}"||"⏳ Download"]}', ctx),
        '⚡ RD'
    );
    assert.equal(
        renderTemplate('{stream.seeders::["{stream.seeders} seeders"||"cached"]}', ctx),
        'cached'
    );
});

test('default modifier falls back when value is empty', () => {
    assert.equal(renderTemplate('{stream.group::default(Unknown)}', ctx), 'Unknown');
});

test('unknown paths and modifiers degrade to empty / passthrough', () => {
    assert.equal(renderTemplate('[{stream.nope}]', ctx), '[]');
    assert.equal(renderTemplate('{stream.resolution::bogus}', ctx), '4K');
});

test('custom formatter still renders legacy flat variables', () => {
    const config = { formatter: 'custom', customTemplate: '{title} - {quality} - {size}' };
    const result = formatStreamSelector('Dune.Part.Two.2024.2160p.BluRay.x265-GROUP', 'BluRay', 12 * 1024 ** 3, 50, 'RD', config, null, false, false, 'cached');
    assert.match(result.title, /Dune/);
    assert.match(result.title, /4K/);
    assert.match(result.name, /Leviathan/);
});

test('custom formatter splits name and description on |||', () => {
    const config = { formatter: 'custom', customTemplate: '{service.name} {stream.resolution}|||🎬 {stream.title}' };
    const result = formatStreamSelector('Inception.2010.1080p.WEB-DL.x264-ABC', 'WEB-DL', 3 * 1024 ** 3, 10, 'TB', config, null, false, false, 'cached');
    assert.equal(result.name.includes('|||'), false);
    assert.match(result.name, /TB/);
    assert.match(result.title, /🎬/);
});
