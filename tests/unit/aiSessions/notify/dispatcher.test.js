'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { NotifyDispatcher } = require('../../../../out/aiSessions/notify/dispatcher');
const { NotifiedEventStore } = require('../../../../out/aiSessions/notify/store');
const { makeTempDirectory } = require('../../../helpers/tempDirectory');

// ATTENTION-NOTIFY-DISPATCHER-001

function createConfig(overrides) {
    return {
        schemaVersion: 1,
        enabled: true,
        sinks: [{ id: 's1', channel: 'slack', proxy: null, url: 'https://hooks.slack.com/x' }],
        policy: Object.assign({
            reasons: ['completed', 'input-required', 'failed'],
            minRunDurationMs: 0,
            debounceMs: 5000,
            rateLimitPerMin: 6,
            escalateAfterMs: null,
        }, overrides),
        redaction: { projectPathMode: 'basename', includeSessionLabel: true },
    };
}

function createPayload(eventId) {
    return {
        eventId,
        correlationId: 'ABC234',
        providerId: 'claude',
        reason: 'completed',
        projectLabel: 'p',
        sessionLabel: 's',
        hostLabel: 'h',
        runStartedAtMs: 0,
        occurredAtMs: 60000,
    };
}

function createHarness(t, configOverrides) {
    const sent = [];
    const logs = [];
    const timers = [];
    let now = 0;
    const store = new NotifiedEventStore(path.join(makeTempDirectory(t, 'notify-dispatch-'), 'notified.json'));
    const dispatcher = new NotifyDispatcher({
        transport: {
            send: async request => { sent.push(request); return { statusCode: 200, durationMs: 1, viaProxy: false }; },
        },
        store,
        nowMs: () => now,
        setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length - 1; },
        clearTimeout: handle => { if (timers[handle]) { timers[handle].cancelled = true; } },
        sleep: async () => {},
        globalProxy: () => '',
        env: {},
        onLog: line => { logs.push(line); },
    });
    dispatcher.setConfig(createConfig(configOverrides));
    return {
        dispatcher,
        sent,
        logs,
        store,
        async advance(ms) {
            now += ms;
            for (const timer of timers) {
                if (!timer.cancelled && !timer.fired && timer.at <= now) {
                    timer.fired = true;
                    await timer.fn();
                }
            }
            await dispatcher.flushForTest();
        },
    };
}

test('防抖期满后发送一次', async t => {
    const harness = createHarness(t);
    harness.dispatcher.enqueue(createPayload('e1'));
    assert.equal(harness.sent.length, 0);
    await harness.advance(5000);
    assert.equal(harness.sent.length, 1);
});

test('防抖期内取消则不发送', async t => {
    const harness = createHarness(t);
    harness.dispatcher.enqueue(createPayload('e1'));
    harness.dispatcher.cancel(['e1']);
    await harness.advance(5000);
    assert.equal(harness.sent.length, 0);
});

test('同一 eventId 重复入队只发送一次', async t => {
    const harness = createHarness(t);
    harness.dispatcher.enqueue(createPayload('e1'));
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 1);
});

test('发送过的 eventId 再次入队不重发', async t => {
    const harness = createHarness(t);
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 1);
});

test('enabled 为 false 时不发送', async t => {
    const harness = createHarness(t);
    const config = createConfig();
    config.enabled = false;
    harness.dispatcher.setConfig(config);
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 0);
});

test('超过限流上限时合并为一条', async t => {
    const harness = createHarness(t, { rateLimitPerMin: 2 });
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
        harness.dispatcher.enqueue(createPayload(id));
    }
    await harness.advance(5000);
    assert.equal(harness.sent.length, 3);
    const merged = JSON.parse(harness.sent[2].body).text;
    // 合并项全是 completed,标题用“已完成”而非“在等你”。
    assert.match(merged, /2 个 AI 会话已完成/u);
});

test('store 持久化失败时仍投递并记录日志', async t => {
    const harness = createHarness(t);
    harness.store.save = () => { throw new Error('disk full'); };
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 1);
    assert.ok(harness.logs.some(line => /failed to persist notified store/u.test(line)));
});

test('多个 sink 各发一次', async t => {
    const harness = createHarness(t);
    const config = createConfig();
    config.sinks.push({ id: 's2', channel: 'discord', proxy: null, url: 'https://discord.com/api/webhooks/y' });
    harness.dispatcher.setConfig(config);
    harness.dispatcher.enqueue(createPayload('e1'));
    await harness.advance(5000);
    assert.equal(harness.sent.length, 2);
});
