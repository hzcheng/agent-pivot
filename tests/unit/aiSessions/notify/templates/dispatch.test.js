'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildNotifyRequest } = require('../../../../../out/aiSessions/notify/templates');

// ATTENTION-NOTIFY-TEMPLATE-DISPATCH-001

const payload = {
    eventId: 'e1',
    correlationId: 'K7M2QX',
    providerId: 'claude',
    reason: 'input-required',
    projectLabel: 'proj',
    sessionLabel: 'sess',
    hostLabel: 'host',
    runStartedAtMs: 0,
    occurredAtMs: 720000,
};

test('按 channel 分发到 ntfy', () => {
    const request = buildNotifyRequest(
        { id: 'a', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', topic: 't', token: null, priority: 4 },
        payload, 0);
    assert.equal(request.url, 'https://ntfy.sh/t');
    assert.match(request.body, /项目\s+proj/u);
});

test('按 channel 分发到 slack', () => {
    const request = buildNotifyRequest(
        { id: 'a', channel: 'slack', proxy: null, url: 'https://hooks.slack.com/x' }, payload, 0);
    assert.match(JSON.parse(request.body).text, /Claude 在等你输入/u);
});

test('custom 模板替换占位符', () => {
    const request = buildNotifyRequest({
        id: 'a', channel: 'custom', proxy: null,
        url: 'https://example.test/hook',
        method: 'PUT',
        headers: { 'X-Token': 'k' },
        bodyTemplate: '{"p":"${project}","r":"${reason}","c":"${correlationId}"}',
    }, payload, 0);
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers['X-Token'], 'k');
    assert.deepEqual(JSON.parse(request.body), { p: 'proj', r: 'input-required', c: 'K7M2QX' });
});

test('buildNotifyRequestFromText 用给定文案而非 payload 渲染', () => {
    const { buildNotifyRequestFromText } = require('../../../../../out/aiSessions/notify/templates');
    const request = buildNotifyRequestFromText(
        { id: 'a', channel: 'slack', proxy: null, url: 'https://hooks.slack.com/x' },
        payload, '合并标题', '合并正文', 4, 0);
    assert.equal(JSON.parse(request.body).text, '合并标题\n合并正文');
});

test('custom 模板中未知占位符保持原样', () => {
    const request = buildNotifyRequest({
        id: 'a', channel: 'custom', proxy: null,
        url: 'https://example.test/hook', method: 'POST', headers: {},
        bodyTemplate: '${unknown}',
    }, payload, 0);
    assert.equal(request.body, '${unknown}');
});
