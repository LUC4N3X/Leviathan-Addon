'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CaptchaOrchestrator, createCaptchaKey } = require('../core/security/captcha_orchestrator');

test('captcha orchestrator stores scoped state and enforces retry budget', async () => {
    const orchestrator = new CaptchaOrchestrator({ defaultTtlMs: 10_000, failureTtlMs: 10_000, defaultRetryBudget: 2 });
    const context = { provider: 'eurostreaming', hoster: 'safego', captchaType: 'image-ocr', scope: 'https://safego.test/a' };

    assert.equal(createCaptchaKey(context), 'eurostreaming:safego:image-ocr:https://safego.test/a');
    assert.equal(orchestrator.shouldAttempt(context).ok, true);

    orchestrator.markFailure(context, 'ocr_failed');
    assert.equal(orchestrator.shouldAttempt(context).ok, true);

    orchestrator.markFailure(context, 'ocr_failed');
    const blocked = orchestrator.shouldAttempt(context);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'ocr_failed');

    orchestrator.markSuccess(context, { cookieState: { cookies: { sid: 'ok' } } });
    assert.deepEqual(orchestrator.get(context).cookieState.cookies, { sid: 'ok' });
    assert.equal(orchestrator.shouldAttempt(context).ok, true);
});

test('captcha orchestrator coalesces concurrent state generation', async () => {
    const orchestrator = new CaptchaOrchestrator({ defaultTtlMs: 10_000 });
    const context = { provider: 'web', hoster: 'uprot', captchaType: 'image-ocr-state', scope: 'uprot.net' };
    let calls = 0;

    const [a, b] = await Promise.all([
        orchestrator.ensureState(context, async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { cookies: { xfss: '1' }, captchaData: { captcha: '12345' } };
        }),
        orchestrator.ensureState(context, async () => {
            calls += 1;
            return { cookies: { xfss: '2' }, captchaData: { captcha: '99999' } };
        })
    ]);

    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    assert.equal(orchestrator.get(context).reason, 'state_ready');
});
