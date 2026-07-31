'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateNotifyConfig } = require('../../../../out/aiSessions/notify/types');

// ATTENTION-NOTIFY-CONFIG-VALIDATION-001

function baseConfig(sinks) {
    return {
        schemaVersion: 1,
        enabled: true,
        sinks,
        policy: {
            reasons: ['completed', 'input-required', 'failed'],
            minRunDurationMs: 60000,
            debounceMs: 5000,
            rateLimitPerMin: 6,
            escalateAfterMs: null,
        },
        redaction: { projectPathMode: 'basename', includeSessionLabel: true },
    };
}

test('接受合法的 ntfy sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's1', channel: 'ntfy', baseUrl: 'https://ntfy.sh', topic: 'abc', token: null, priority: 4, proxy: null },
    ]));
    assert.equal(config.sinks[0].channel, 'ntfy');
    assert.equal(config.sinks[0].topic, 'abc');
});

test('接受合法的 telegram sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's2', channel: 'telegram', botToken: 't', chatId: '123', proxy: null },
    ]));
    assert.equal(config.sinks[0].botToken, 't');
});

test('telegram sink 缺 chatId 时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's2', channel: 'telegram', botToken: 't', proxy: null },
    ])), /telegram sink/u);
});

test('ntfy sink 混入 telegram 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's1', channel: 'ntfy', baseUrl: 'https://ntfy.sh', topic: 'abc', token: null,
          priority: 4, proxy: null, botToken: 'x' },
    ])), /ntfy sink/u);
});

test('未知 channel 拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's9', channel: 'sms', url: 'https://x' },
    ])), /channel/u);
});

test('reasons 含 aborted 时拒绝', () => {
    const config = baseConfig([]);
    config.policy.reasons = ['aborted'];
    assert.throws(() => validateNotifyConfig(config), /reasons/u);
});

test('schemaVersion 不为 1 时拒绝', () => {
    const config = baseConfig([]);
    config.schemaVersion = 2;
    assert.throws(() => validateNotifyConfig(config), /schemaVersion/u);
});

test('多余的顶层字段被拒绝', () => {
    const config = baseConfig([]);
    config.extra = true;
    assert.throws(() => validateNotifyConfig(config), /notify config/u);
});
