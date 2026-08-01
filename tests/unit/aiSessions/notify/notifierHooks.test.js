'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildNotifyPayload } = require('../../../../out/aiSessions/notifyIntegration/notifier');

// ATTENTION-NOTIFY-PAYLOAD-BUILD-001

const event = {
    eventId: 'claude:018f:completed:deadbeef',
    key: 'claude:018f',
    reason: 'completed',
    generation: 1,
    detectedAt: 720000,
};

test('payload 携带 correlation id', () => {
    const payload = buildNotifyPayload(event, {
        providerId: 'claude',
        projectLabel: 'vscode-dashboard',
        sessionLabel: 'fix/x',
        hostLabel: 'dev-1',
        runStartedAtMs: 0,
    });
    assert.match(payload.correlationId, /^[A-Z2-7]{6}$/u);
    assert.equal(payload.eventId, event.eventId);
    assert.equal(payload.reason, 'completed');
    assert.equal(payload.occurredAtMs, 720000);
    assert.equal(payload.runStartedAtMs, 0);
});

test('basename 模式只保留目录名', () => {
    const payload = buildNotifyPayload(event, {
        providerId: 'claude',
        projectLabel: '/home/user/projects/vscode-dashboard',
        sessionLabel: 'fix/x',
        hostLabel: 'dev-1',
        runStartedAtMs: 0,
        projectPathMode: 'basename',
    });
    assert.equal(payload.projectLabel, 'vscode-dashboard');
});

test('full 模式保留完整路径', () => {
    const payload = buildNotifyPayload(event, {
        providerId: 'claude',
        projectLabel: '/home/user/projects/vscode-dashboard',
        sessionLabel: 'fix/x',
        hostLabel: 'dev-1',
        runStartedAtMs: 0,
        projectPathMode: 'full',
    });
    assert.equal(payload.projectLabel, '/home/user/projects/vscode-dashboard');
});

test('关闭 sessionLabel 时以短码代替', () => {
    const payload = buildNotifyPayload(event, {
        providerId: 'claude',
        projectLabel: 'p',
        sessionLabel: 'secret-branch-name',
        hostLabel: 'dev-1',
        runStartedAtMs: 0,
        includeSessionLabel: false,
    });
    assert.equal(payload.sessionLabel, `#${payload.correlationId}`);
});
