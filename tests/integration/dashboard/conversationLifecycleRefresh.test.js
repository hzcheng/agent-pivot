'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const {
    AiSessionExecutionController,
} = require('../../../out/aiSessions/executionController');

function loadDashboard() {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return {};
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/dashboard');
    } finally {
        Module._load = previousLoad;
    }
}

const {
    refreshViewedConversationForExecutionLifecycle,
} = loadDashboard();

test('CONVERSATION-WORKING-INDICATOR-001 refreshes the viewed Conversation only for its matching lifecycle edge', async () => {
    const refreshes = [];
    const viewer = {
        getCurrentTarget: () => ({
            projectId: 'project-a', provider: 'codex', sessionId: 'session-a',
        }),
        refresh: async () => {
            refreshes.push('refresh');
        },
    };

    assert.equal(
        refreshViewedConversationForExecutionLifecycle(
            viewer, ['codex:background-session']
        ),
        false
    );
    await Promise.resolve();
    assert.deepEqual(refreshes, [],
        'background lifecycle edges must not replace the current reader page');

    assert.equal(
        refreshViewedConversationForExecutionLifecycle(
            viewer, ['codex:session-a']
        ),
        true
    );
    await Promise.resolve();
    assert.deepEqual(refreshes, ['refresh'],
        'the Dashboard lifecycle callback must refresh the viewed Conversation');
});

test('CONVERSATION-WORKING-INDICATOR-001 delivers a completed viewed lifecycle through the Dashboard handler without refreshing for another session', async () => {
    const refreshes = [];
    const viewer = {
        getCurrentTarget: () => ({
            projectId: 'project-a', provider: 'codex', sessionId: 'session-a',
        }),
        refresh: async () => {
            refreshes.push('refresh');
        },
    };
    let sessionState = 'running';
    let backgroundState = 'running';
    const controller = new AiSessionExecutionController({
        getActiveSessions: () => [
            { provider: 'codex', sessionId: 'session-a', runStartedAtMs: 1 },
            { provider: 'codex', sessionId: 'background-session', runStartedAtMs: 1 },
        ],
        scheduleRefresh: () => undefined,
        onExecutionLifecycleChanged: changedKeys => {
            refreshViewedConversationForExecutionLifecycle(viewer, changedKeys);
        },
        nowMs: () => 10,
    });
    const signals = () => ({
        codex: {
            'session-a': {
                token: `session-a:${sessionState}`,
                occurredAtMs: sessionState === 'running' ? 1 : 2,
                executionState: sessionState === 'running' ? 'running' : 'stopped',
            },
            'background-session': {
                token: `background:${backgroundState}`,
                occurredAtMs: backgroundState === 'running' ? 1 : 2,
                executionState: backgroundState === 'running' ? 'running' : 'stopped',
            },
        },
    });

    controller.evaluate(signals());
    await Promise.resolve();
    refreshes.length = 0;

    backgroundState = 'stopped';
    controller.evaluate(signals());
    await Promise.resolve();
    assert.deepEqual(refreshes, [],
        'an unrelated completed session must not refresh the viewed Conversation');

    sessionState = 'stopped';
    controller.evaluate(signals());
    await Promise.resolve();
    assert.deepEqual(refreshes, ['refresh'],
        'the viewed completion must refresh its Conversation even when only lifecycle state changed');
});
