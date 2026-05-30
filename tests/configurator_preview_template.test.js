const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const helpersStart = html.indexOf('        function previewTemplateTruthy(value) {');
const helpersEnd = html.indexOf("        function updateCustomPreview() { updatePreview('custom'); updateFluxStream(); }");
const previewHelpers = html.slice(helpersStart, helpersEnd);

function render(template, context) {
    const sandbox = { context, output: '' };
    vm.runInNewContext(`${previewHelpers}\noutput = previewRenderTemplate(${JSON.stringify(template)}, context);`, sandbox);
    return sandbox.output;
}

test('configurator preview includes its documented template renderer', () => {
    assert.notEqual(helpersStart, -1);
    assert.notEqual(helpersEnd, -1);
    assert.match(html, /desc = previewRenderTemplate\(descriptionTemplate, context\)\.trim\(\);/);
});

test('configurator preview renders namespaced bytes modifiers and conditionals', () => {
    const context = {
        stream: { size: 12 * 1024 ** 3 },
        service: { cached: true }
    };
    assert.equal(render('{stream.size::bytes}', context), '12.00 GB');
    assert.equal(render('{service.cached::["⚡ Cached"||"⏳ Download"]}', context), '⚡ Cached');
});
