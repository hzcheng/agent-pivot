'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assembleNotifyConfig, NOTIFY_SECRET_KEY_PREFIX } =
    require('../../../../out/aiSessions/notifyIntegration/credentials');

// ATTENTION-NOTIFY-CREDENTIALS-001

const settings = {
    enabled: true,
    sinks: [{ id: 's1', channel: 'ntfy', baseUrl: 'https://ntfy.sh', priority: 4, proxy: null }],
    reasons: ['completed', 'input-required', 'failed'],
    minRunDurationMs: 60000,
    debounceMs: 5000,
    rateLimitPerMin: 6,
    escalateAfterMs: 0,
    projectPathMode: 'basename',
    includeSessionLabel: true,
};

test('secret key 前缀稳定', () => {
    assert.equal(NOTIFY_SECRET_KEY_PREFIX, 'agentPivot.notify.sink.');
});

test('把 secret 合并进 sink 后产出合法配置', () => {
    const config = assembleNotifyConfig(settings, {
        s1: JSON.stringify({ topic: 'my-topic', token: null }),
    });
    assert.equal(config.sinks.length, 1);
    assert.equal(config.sinks[0].topic, 'my-topic');
    assert.equal(config.policy.minRunDurationMs, 60000);
});

test('缺少 secret 的 sink 被丢弃而不是抛异常', () => {
    const config = assembleNotifyConfig(settings, {});
    assert.equal(config.sinks.length, 0);
    assert.equal(config.enabled, true);
});

test('secret 内容非法时该 sink 被丢弃', () => {
    const config = assembleNotifyConfig(settings, { s1: 'not json' });
    assert.equal(config.sinks.length, 0);
});

test('escalateAfterMs 为 0 时归一化为 null', () => {
    const config = assembleNotifyConfig(settings, { s1: JSON.stringify({ topic: 't', token: null }) });
    assert.equal(config.policy.escalateAfterMs, null);
});

test('policy 非法时降级为关闭配置而不抛异常', () => {
    const logs = [];
    const invalid = { ...settings, reasons: [] };
    const config = assembleNotifyConfig(invalid, {
        s1: JSON.stringify({ topic: 'my-topic', token: null }),
    }, line => logs.push(line));
    assert.equal(config.enabled, false);
    assert.equal(config.sinks.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /invalid policy or redaction/u);
});

test('单个坏 sink 只丢自己并记录原因', () => {
    const logs = [];
    const twoSinks = {
        ...settings,
        sinks: [
            settings.sinks[0],
            { id: 's2', channel: 'slack', proxy: null },
        ],
    };
    // s2 的 secret 按 telegram 字段录入,与 slack 骨架合并后 exactKeys 不匹配。
    const config = assembleNotifyConfig(twoSinks, {
        s1: JSON.stringify({ topic: 'my-topic', token: null }),
        s2: JSON.stringify({ botToken: 'x', chatId: 'y' }),
    }, line => logs.push(line));
    assert.equal(config.sinks.length, 1);
    assert.equal(config.sinks[0].id, 's1');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /dropped sink "s2"/u);
});
