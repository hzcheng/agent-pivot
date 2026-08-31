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

test('CONVERSATION-WORKING-INDICATOR-001 synchronizes the viewed Conversation lifecycle before refreshing its matching edge', async () => {
    const operations = [];
    const viewer = {
        getCurrentTarget: () => ({
            projectId: 'project-a', provider: 'codex', sessionId: 'session-a',
        }),
        refresh: async () => {
            operations.push('refresh');
        },
    };
    const reconcile = async () => {
        operations.push('reconcile');
        await viewer.refresh();
        return true;
    };

    assert.equal(
        await refreshViewedConversationForExecutionLifecycle(
            viewer, ['codex:background-session'], reconcile
        ),
        false
    );
    assert.deepEqual(operations, [],
        'background lifecycle edges must not replace the current reader page');

    assert.equal(
        await refreshViewedConversationForExecutionLifecycle(
            viewer, ['codex:session-a'], reconcile
        ),
        true
    );
    assert.deepEqual(operations, ['reconcile', 'refresh'],
        'the Dashboard lifecycle callback must project running/stopped state with one refresh');
});

test('CONVERSATION-WORKING-INDICATOR-001 does not refresh a newly selected Conversation after an older lifecycle reconcile', async () => {
    const refreshes = [];
    let currentTarget = {
        projectId: 'project-a', provider: 'codex', sessionId: 'session-a',
    };
    let releaseReconcile;
    const viewer = {
        getCurrentTarget: () => currentTarget,
        refresh: async () => {
            refreshes.push(currentTarget.sessionId);
        },
    };
    const reconcile = () => new Promise(resolve => {
        releaseReconcile = resolve;
    });

    const refresh = refreshViewedConversationForExecutionLifecycle(
        viewer, ['codex:session-a'], reconcile
    );
    await Promise.resolve();
    currentTarget = {
        projectId: 'project-a', provider: 'codex', sessionId: 'session-b',
    };
    releaseReconcile();

    assert.equal(await refresh, false);
    assert.deepEqual(refreshes, [],
        'a lifecycle edge for the previous session must not replace the newly selected reader');
});

test('CONVERSATION-WORKING-INDICATOR-001 falls back to one direct refresh when lifecycle reconciliation cannot refresh', async () => {
    const operations = [];
    const viewer = {
        getCurrentTarget: () => ({
            projectId: 'project-a', provider: 'codex', sessionId: 'session-a',
        }),
        refresh: async () => {
            operations.push('refresh');
        },
    };

    assert.equal(
        await refreshViewedConversationForExecutionLifecycle(
            viewer,
            ['codex:session-a'],
            async () => {
                operations.push('reconcile');
                return false;
            }
        ),
        true
    );
    assert.deepEqual(operations, ['reconcile', 'refresh']);
});

test('CONVERSATION-WORKING-INDICATOR-001 delivers a completed viewed lifecycle through the Dashboard handler without refreshing for another session', async () => {
    const operations = [];
    const viewer = {
        getCurrentTarget: () => ({
            projectId: 'project-a', provider: 'codex', sessionId: 'session-a',
        }),
        refresh: async () => {
            operations.push('refresh');
        },
    };
    const reconcile = async () => {
        operations.push('reconcile');
        await viewer.refresh();
        return true;
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
            void refreshViewedConversationForExecutionLifecycle(
                viewer, changedKeys, reconcile
            );
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
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(operations, ['reconcile', 'refresh'],
        'a running edge after restoring a Conversation must seed its lifecycle projection');
    operations.length = 0;

    backgroundState = 'stopped';
    controller.evaluate(signals());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(operations, [],
        'an unrelated completed session must not refresh the viewed Conversation');

    sessionState = 'stopped';
    controller.evaluate(signals());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(operations, ['reconcile', 'refresh'],
        'the viewed completion must refresh its Conversation even when only lifecycle state changed');
});
