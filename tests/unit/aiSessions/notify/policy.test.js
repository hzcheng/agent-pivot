'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateNotifyPolicy } = require('../../../../out/aiSessions/notify/policy');

// ATTENTION-NOTIFY-POLICY-001

const policy = {
    reasons: ['completed', 'failed', 'input-required'],
    minRunDurationMs: 60000,
    debounceMs: 5000,
    rateLimitPerMin: 6,
    escalateAfterMs: null,
};

function payload(overrides) {
    return Object.assign({
        eventId: 'e1',
        correlationId: 'ABC234',
        providerId: 'claude',
        reason: 'completed',
        projectLabel: 'p',
        sessionLabel: 's',
        hostLabel: 'h',
        runStartedAtMs: 0,
        occurredAtMs: 120000,
    }, overrides);
}

const clean = { alreadyNotified: false, acknowledged: false, sentWithinLastMinute: 0 };

test('满足全部条件时发送', () => {
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, clean), { action: 'send' });
});

test('reason 不在列表中时跳过', () => {
    const narrow = Object.assign({}, policy, { reasons: ['failed'] });
    assert.deepEqual(evaluateNotifyPolicy(payload(), narrow, clean), { action: 'skip', reason: 'reason-filtered' });
});

test('运行时长不足时跳过', () => {
    const short = payload({ runStartedAtMs: 100000, occurredAtMs: 120000 });
    assert.deepEqual(evaluateNotifyPolicy(short, policy, clean), { action: 'skip', reason: 'too-short' });
});

test('运行时长恰好等于阈值时发送', () => {
    const exact = payload({ runStartedAtMs: 0, occurredAtMs: 60000 });
    assert.deepEqual(evaluateNotifyPolicy(exact, policy, clean), { action: 'send' });
});

test('已发送过时跳过', () => {
    const context = Object.assign({}, clean, { alreadyNotified: true });
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, context), { action: 'skip', reason: 'already-notified' });
});

test('已被确认时跳过', () => {
    const context = Object.assign({}, clean, { acknowledged: true });
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, context), { action: 'skip', reason: 'acknowledged' });
});

test('达到限流上限时合并', () => {
    const context = Object.assign({}, clean, { sentWithinLastMinute: 6 });
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, context), { action: 'merge' });
});

test('确认优先于限流', () => {
    const context = { alreadyNotified: false, acknowledged: true, sentWithinLastMinute: 99 };
    assert.deepEqual(evaluateNotifyPolicy(payload(), policy, context), { action: 'skip', reason: 'acknowledged' });
});
