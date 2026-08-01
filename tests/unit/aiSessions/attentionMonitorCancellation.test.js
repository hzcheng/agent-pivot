'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const AiSessionAttentionMonitor = require('../../../out/aiSessions/attentionMonitor').default;

// ATTENTION-NOTIFY-CANCEL-001

function signal(phase, token, reason) {
    return { token, phase, reason, occurredAtMs: Number(token.replace(/\D/gu, '')) || 1 };
}

test('needsAttention 后收到 running 信号时撤销事件', () => {
    const monitor = new AiSessionAttentionMonitor({ now: () => 1000 });
    const events = monitor.evaluate([
        { key: 'claude:s1', signal: signal('needsAttention', 't1', 'input-required') },
    ]);
    assert.equal(events.length, 1);
    assert.deepEqual(monitor.consumeCancelledEventIds(), []);

    monitor.evaluate([{ key: 'claude:s1', signal: signal('running', 't2') }]);
    assert.deepEqual(monitor.consumeCancelledEventIds(), [events[0].eventId]);
});

test('needsAttention 后收到 idle 信号时撤销事件', () => {
    const monitor = new AiSessionAttentionMonitor({ now: () => 1000 });
    const events = monitor.evaluate([
        { key: 'claude:s1', signal: signal('needsAttention', 't1', 'completed') },
    ]);
    monitor.evaluate([{ key: 'claude:s1', signal: signal('idle', 't2') }]);
    assert.deepEqual(monitor.consumeCancelledEventIds(), [events[0].eventId]);
});

test('discard 带事件的 key 时撤销事件', () => {
    const monitor = new AiSessionAttentionMonitor({ now: () => 1000 });
    const events = monitor.evaluate([
        { key: 'claude:s1', signal: signal('needsAttention', 't1', 'failed') },
    ]);
    monitor.discard(['claude:s1']);
    assert.deepEqual(monitor.consumeCancelledEventIds(), [events[0].eventId]);
});

test('没有待处理事件时不产生撤销', () => {
    const monitor = new AiSessionAttentionMonitor({ now: () => 1000 });
    monitor.evaluate([{ key: 'claude:s1', signal: signal('running', 't1') }]);
    monitor.discard(['claude:missing']);
    assert.deepEqual(monitor.consumeCancelledEventIds(), []);
});

test('consume 后清空,重复 consume 返回空', () => {
    const monitor = new AiSessionAttentionMonitor({ now: () => 1000 });
    monitor.evaluate([
        { key: 'claude:s1', signal: signal('needsAttention', 't1', 'completed') },
    ]);
    monitor.evaluate([{ key: 'claude:s1', signal: signal('running', 't2') }]);
    assert.equal(monitor.consumeCancelledEventIds().length, 1);
    assert.deepEqual(monitor.consumeCancelledEventIds(), []);
});
