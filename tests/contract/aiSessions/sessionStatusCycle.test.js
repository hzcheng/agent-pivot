'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createSessionStatusCycleHandler,
} = require('../../../out/dashboard/sessionStatusCycle');

function item(provider, sessionId) {
    return { provider, sessionId };
}

function makeHandler(overrides = {}) {
    const calls = [];
    const handler = createSessionStatusCycleHandler({
        buildItems: kind => (overrides.items || {})[kind] || [],
        navigateSession: (target, executionOptions) => {
            calls.push(['navigate', target.provider, target.sessionId]);
            if (overrides.focusResult === false) {
                return Promise.resolve({
                    focused: false,
                    conversationOpened: false,
                });
            }
            executionOptions.onFocused?.();
            return Promise.resolve({ focused: true, conversationOpened: true });
        },
        showInformationMessage: message => calls.push(['info', message]),
        showWarningMessage: message => calls.push(['warn', message]),
    });
    return { calls, handler };
}

test('CONVERSATION-SESSION-STATUS-001 reports an empty kind without navigating', async () => {
    const { calls, handler } = makeHandler();

    await handler.cycleToNext('running');
    await handler.cycleToNext('attention');
    await handler.cycleToNext('idle');

    assert.deepEqual(calls, [
        ['info', 'Agent Pivot: no running AI sessions in this window.'],
        ['info', 'Agent Pivot: no AI sessions need attention in this window.'],
        ['info', 'Agent Pivot: no idle AI sessions in this window.'],
    ]);
});

test('CONVERSATION-SESSION-STATUS-001 cycles in order with wrap-around', async () => {
    const { calls, handler } = makeHandler({
        items: {
            running: [item('codex', 'c1'), item('kimi', 'k1'), item('claude', 'l1')],
        },
    });

    await handler.cycleToNext('running');
    await handler.cycleToNext('running');
    await handler.cycleToNext('running');
    await handler.cycleToNext('running');

    assert.deepEqual(calls, [
        ['navigate', 'codex', 'c1'],
        ['navigate', 'kimi', 'k1'],
        ['navigate', 'claude', 'l1'],
        ['navigate', 'codex', 'c1'],
    ]);
});

test('CONVERSATION-SESSION-STATUS-001 re-anchors to the watched session after a manual detour', async () => {
    const { calls, handler } = makeHandler({
        items: { running: [item('codex', 'c1'), item('kimi', 'k1'), item('claude', 'l1')] },
    });

    await handler.cycleToNext('running');
    await handler.cycleToNext('running');
    assert.deepEqual(calls, [
        ['navigate', 'codex', 'c1'],
        ['navigate', 'kimi', 'k1'],
    ]);

    // The user clicked over to claude:l1 on their own: the next cycle
    // continues after the watched session, not after the stale cursor.
    await handler.cycleToNext('running', { provider: 'claude', sessionId: 'l1' });
    assert.deepEqual(calls[2], ['navigate', 'codex', 'c1']);
});

test('CONVERSATION-SESSION-STATUS-001 resolves a command anchor inside the shared navigation queue', async () => {
    let focused = item('codex', 'c1');
    const calls = [];
    const handler = createSessionStatusCycleHandler({
        buildItems: kind => kind === 'running'
            ? [item('codex', 'c1'), item('kimi', 'k1'), item('claude', 'l1')]
            : [],
        navigateSession: async target => {
            focused = target;
            calls.push(['navigate', target.provider, target.sessionId]);
            return { focused: true, conversationOpened: true };
        },
        showInformationMessage: message => calls.push(['info', message]),
        showWarningMessage: message => calls.push(['warn', message]),
    });

    await Promise.all([
        handler.cycleToNext('running', () => focused),
        handler.cycleToNext('running', () => focused),
    ]);
    assert.deepEqual(calls, [
        ['navigate', 'kimi', 'k1'],
        ['navigate', 'claude', 'l1'],
    ]);
});

test('CONVERSATION-SESSION-STATUS-001 keeps independent cursors per kind', async () => {
    const { calls, handler } = makeHandler({
        items: {
            running: [item('codex', 'c1'), item('kimi', 'k1')],
            idle: [item('codex', 'c2'), item('kimi', 'k2')],
        },
    });

    await handler.cycleToNext('running');
    await handler.cycleToNext('idle');
    await handler.cycleToNext('running');

    assert.deepEqual(calls, [
        ['navigate', 'codex', 'c1'],
        ['navigate', 'codex', 'c2'],
        ['navigate', 'kimi', 'k1'],
    ]);
});

test('CONVERSATION-SESSION-STATUS-001 advances past a session that ended mid-cycle', async () => {
    const { calls, handler } = makeHandler({
        items: { running: [item('codex', 'c1'), item('kimi', 'k1')] },
        focusResult: false,
    });

    await handler.cycleToNext('running');
    assert.deepEqual(calls, [
        ['navigate', 'codex', 'c1'],
        ['warn', 'Agent Pivot: the selected AI session is no longer active.'],
    ]);
});

test('CONVERSATION-SESSION-STATUS-001 drops invalid and duplicate items', async () => {
    const { calls, handler } = makeHandler({
        items: {
            idle: [
                item('codex', 'c1'),
                item('codex', 'c1'),
                item('kimi', ''),
                null,
                item('kimi', 'k1'),
            ],
        },
    });

    await handler.cycleToNext('idle');
    await handler.cycleToNext('idle');
    await handler.cycleToNext('idle');

    assert.deepEqual(calls, [
        ['navigate', 'codex', 'c1'],
        ['navigate', 'kimi', 'k1'],
        ['navigate', 'codex', 'c1'],
    ]);
});

test('CONVERSATION-SESSION-STATUS-001 stays on the only session of its kind', async () => {
    const { calls, handler } = makeHandler({
        items: { attention: [item('kimi', 'k1')] },
    });

    await handler.cycleToNext('attention', { provider: 'kimi', sessionId: 'k1' });
    await handler.cycleToNext('attention', { provider: 'kimi', sessionId: 'k1' });

    assert.deepEqual(calls, [
        ['navigate', 'kimi', 'k1'],
        ['navigate', 'kimi', 'k1'],
    ]);
});
