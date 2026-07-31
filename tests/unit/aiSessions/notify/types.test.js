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

test('接受合法的 bark sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's3', channel: 'bark', proxy: null, serverUrl: 'https://bark.example', deviceKey: 'dk123' },
    ]));
    assert.equal(config.sinks[0].serverUrl, 'https://bark.example');
    assert.equal(config.sinks[0].deviceKey, 'dk123');
});

test('bark sink 混入 telegram 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's3', channel: 'bark', proxy: null, serverUrl: 'https://bark.example', deviceKey: 'dk123', botToken: 'x' },
    ])), /bark sink/u);
});

test('接受合法的 feishu sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's4', channel: 'feishu', proxy: null, url: 'https://open.feishu.cn/hook/x' },
    ]));
    assert.equal(config.sinks[0].url, 'https://open.feishu.cn/hook/x');
});

test('feishu sink 混入 dingtalk 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's4', channel: 'feishu', proxy: null, url: 'https://open.feishu.cn/hook/x', secret: 'sec' },
    ])), /feishu sink/u);
});

test('接受合法的 wecom sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's5', channel: 'wecom', proxy: null, url: 'https://qyapi.weixin.qq.com/hook/x' },
    ]));
    assert.equal(config.sinks[0].url, 'https://qyapi.weixin.qq.com/hook/x');
});

test('wecom sink 混入 bark 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's5', channel: 'wecom', proxy: null, url: 'https://qyapi.weixin.qq.com/hook/x', deviceKey: 'dk' },
    ])), /wecom sink/u);
});

test('接受合法的 slack sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's6', channel: 'slack', proxy: null, url: 'https://hooks.slack.com/services/x' },
    ]));
    assert.equal(config.sinks[0].url, 'https://hooks.slack.com/services/x');
});

test('slack sink 混入 telegram 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's6', channel: 'slack', proxy: null, url: 'https://hooks.slack.com/services/x', botToken: 'x' },
    ])), /slack sink/u);
});

test('接受合法的 discord sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's7', channel: 'discord', proxy: null, url: 'https://discord.com/api/webhooks/x' },
    ]));
    assert.equal(config.sinks[0].url, 'https://discord.com/api/webhooks/x');
});

test('discord sink 混入 ntfy 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's7', channel: 'discord', proxy: null, url: 'https://discord.com/api/webhooks/x', topic: 'abc' },
    ])), /discord sink/u);
});

test('接受合法的 dingtalk sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's8', channel: 'dingtalk', proxy: null, url: 'https://oapi.dingtalk.com/robot/send', secret: 'SEC123' },
    ]));
    assert.equal(config.sinks[0].url, 'https://oapi.dingtalk.com/robot/send');
    assert.equal(config.sinks[0].secret, 'SEC123');
});

test('dingtalk sink 混入 telegram 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's8', channel: 'dingtalk', proxy: null, url: 'https://oapi.dingtalk.com/robot/send',
          secret: 'SEC123', chatId: '123' },
    ])), /dingtalk sink/u);
});

test('dingtalk sink 缺 secret 时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's8', channel: 'dingtalk', proxy: null, url: 'https://oapi.dingtalk.com/robot/send' },
    ])), /dingtalk sink/u);
});

test('接受合法的 custom sink', () => {
    const config = validateNotifyConfig(baseConfig([
        { id: 's9', channel: 'custom', proxy: null, url: 'https://custom.example/hook', method: 'POST',
          headers: { 'Content-Type': 'application/json' }, bodyTemplate: '{"text":"{{message}}"}' },
    ]));
    assert.equal(config.sinks[0].method, 'POST');
    assert.deepEqual(config.sinks[0].headers, { 'Content-Type': 'application/json' });
    assert.equal(config.sinks[0].bodyTemplate, '{"text":"{{message}}"}');
});

test('custom sink 混入 bark 字段时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's9', channel: 'custom', proxy: null, url: 'https://custom.example/hook', method: 'POST',
          headers: {}, bodyTemplate: 'x', deviceKey: 'dk' },
    ])), /custom sink/u);
});

test('custom sink headers 含非字符串值时拒绝', () => {
    assert.throws(() => validateNotifyConfig(baseConfig([
        { id: 's9', channel: 'custom', proxy: null, url: 'https://custom.example/hook', method: 'POST',
          headers: { 'X-Test': 123 }, bodyTemplate: 'x' },
    ])), /custom sink header/u);
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
