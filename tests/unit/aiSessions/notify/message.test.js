'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    renderNotifyTitle, renderNotifyBody, renderMergedTitle, renderMergedBody, notifyPriority,
} = require('../../../../out/aiSessions/notify/message');

// ATTENTION-NOTIFY-MESSAGE-001

const payload = {
    eventId: 'e1',
    correlationId: 'K7M2QX',
    providerId: 'claude',
    reason: 'input-required',
    projectLabel: 'vscode-dashboard',
    sessionLabel: 'fix/attention-notify',
    hostLabel: 'dev-server-03',
    runStartedAtMs: 0,
    occurredAtMs: 720000,
};

test('标题含 provider 与状态', () => {
    assert.equal(renderNotifyTitle(payload), '⏸ Claude 在等你输入');
});

test('completed 的标题不同于 input-required', () => {
    const done = Object.assign({}, payload, { reason: 'completed' });
    assert.equal(renderNotifyTitle(done), '✅ Claude 已完成');
});

test('failed 的标题不同', () => {
    const failed = Object.assign({}, payload, { reason: 'failed' });
    assert.equal(renderNotifyTitle(failed), '⚠️ Claude 执行失败');
});

test('正文含项目、会话、时长、主机与短码', () => {
    const body = renderNotifyBody(payload);
    assert.match(body, /项目\s+vscode-dashboard/u);
    assert.match(body, /会话\s+fix\/attention-notify/u);
    assert.match(body, /已运行 12 分钟/u);
    assert.match(body, /主机\s+dev-server-03/u);
    assert.match(body, /#K7M2QX/u);
});

test('正文不含任何路径分隔符开头的绝对路径', () => {
    assert.doesNotMatch(renderNotifyBody(payload), /\s\/[A-Za-z]/u);
});

test('合并标题含数量', () => {
    assert.equal(renderMergedTitle(3), '⏸ 3 个 AI 会话在等你');
});

test('合并正文每行一个会话', () => {
    const lines = renderMergedBody([payload, Object.assign({}, payload, {
        providerId: 'codex', projectLabel: 'api-gateway', reason: 'failed',
    })]).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Claude \/ vscode-dashboard/u);
    assert.match(lines[1], /Codex \/ api-gateway/u);
});

test('priority 按 reason 区分', () => {
    assert.equal(notifyPriority('input-required'), 4);
    assert.equal(notifyPriority('failed'), 4);
    assert.equal(notifyPriority('completed'), 3);
});
