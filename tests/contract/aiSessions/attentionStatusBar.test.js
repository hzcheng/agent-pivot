'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadWithFakeVscode(request, fakeVscode) {
    const previousLoad = Module._load;
    try {
        Module._load = function (id, parent, isMain) {
            if (id === 'vscode') return fakeVscode;
            return previousLoad.call(this, id, parent, isMain);
        };
        return require(request);
    } finally {
        Module._load = previousLoad;
    }
}

const {
    getAttentionProjectKey,
    getAttentionProjectPath,
    getAttentionRuntimeSessionKey,
} = require('../../../out/aiSessions/attentionProject');
const {
    buildAttentionQueue,
    formatAttentionStatusBar,
} = require('../../../out/aiSessions/attentionQueue');
const {
    createAttentionQueueJumpHandler,
} = require('../../../out/dashboard/attentionQueueJump');

function projectKeyOf(uri) {
    return getAttentionProjectKey(getAttentionProjectPath(uri));
}

function runtimeKey(scope, provider, sessionId, runStartedAtMs = 7) {
    return getAttentionRuntimeSessionKey({
        workspaceScopeIdentity: scope,
        provider,
        sessionId,
        runStartedAtMs,
        backend: 'tmux',
    });
}

const SCOPE_LOCAL = 'a'.repeat(64);
const SCOPE_REMOTE = 'b'.repeat(64);

function makeAggregate(sessions) {
    return {
        protocolVersion: 1,
        aggregateRevision: 'c'.repeat(64),
        generatedAtMs: 10_000,
        sessions,
    };
}

function makeWorkspace() {
    return {
        roots: [{ id: 'root-a', uri: 'file:///work/alpha' }],
        sessions: [
            { provider: 'kimi', id: 'sess-1', name: 'reminder feature', primaryRootId: 'root-a' },
            { provider: 'codex', id: 'sess-2', name: 'parser spike', primaryRootId: 'root-a' },
        ],
    };
}

function makeQueueInput() {
    return {
        workspace: makeWorkspace(),
        aggregate: makeAggregate([
            {
                projectId: projectKeyOf('file:///work/alpha'),
                sessionKey: runtimeKey(SCOPE_LOCAL, 'kimi', 'sess-1'),
                reasons: ['completed'],
                eventIds: ['e-1'],
                observedAtMs: 1_000,
            },
            {
                projectId: projectKeyOf('file:///work/alpha'),
                sessionKey: runtimeKey(SCOPE_LOCAL, 'codex', 'sess-2'),
                reasons: ['input-required'],
                eventIds: ['e-2'],
                observedAtMs: 2_000,
            },
            {
                projectId: projectKeyOf('file:///work/other'),
                sessionKey: runtimeKey(SCOPE_REMOTE, 'claude', 'sess-9'),
                reasons: ['failed'],
                eventIds: ['e-9'],
                observedAtMs: 500,
            },
        ]),
    };
}

test('ATTENTION-STATUS-BAR-QUEUE-001 builds a global oldest-first queue with parsed identities', () => {
    const queue = buildAttentionQueue(makeQueueInput());

    assert.equal(queue.total, 3);
    assert.equal(queue.localCount, 2);
    assert.equal(queue.remoteCount, 1);
    assert.deepEqual(queue.items.map(item => `${item.provider}:${item.sessionId}`), [
        'claude:sess-9',
        'kimi:sess-1',
        'codex:sess-2',
    ], 'one oldest-first cycle shared by every window; locality only flags jump mechanics');
    assert.deepEqual(queue.items.map(item => item.local), [false, true, true]);
    assert.equal(queue.items[1].sessionName, 'reminder feature');
    assert.deepEqual(queue.items[1].eventIds, ['e-1']);
    assert.deepEqual(queue.items[2].reasons, ['input-required']);
    assert.equal(queue.items[0].sessionName, undefined,
        'remote sessions carry no local display name');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 matches logical session keys and missing roots to the primary root', () => {
    const input = makeQueueInput();
    input.aggregate.sessions[0].sessionKey = 'kimi:sess-1';
    input.workspace.sessions[1] = { provider: 'codex', id: 'sess-2', name: 'parser spike' };

    const queue = buildAttentionQueue(input);

    assert.equal(queue.localCount, 2, 'logical keys and primary-root fallback still match');
    assert.equal(buildAttentionQueue({ aggregate: input.aggregate, workspace: null }).localCount, 0);
    assert.deepEqual(buildAttentionQueue({ aggregate: null, workspace: makeWorkspace() }).items, []);
});

test('ATTENTION-STATUS-BAR-QUEUE-001 formats the status bar text and tooltip', () => {
    const { text, tooltip } = formatAttentionStatusBar(
        buildAttentionQueue(makeQueueInput()),
        () => 61_000
    );

    assert.equal(text, '$(bell) 3');
    const lines = tooltip.split('\n');
    assert.equal(lines[0], '3 AI sessions need attention');
    assert.match(lines[1], /^Kimi · reminder feature — completed · 1m ago$/);
    assert.match(lines[2], /^Codex · parser spike — needs input · 59s ago$/);
    assert.match(lines[3], /1 more in other windows/);
    assert.equal(lines.at(-1), 'Click to jump to the next session.');

    const single = formatAttentionStatusBar({
        items: [], localCount: 0, remoteCount: 0, total: 0,
    }, () => 0);
    assert.equal(single.text, '');
    assert.equal(single.tooltip, '');
});

function createStatusBarItemRecorder() {
    const calls = [];
    const item = {
        alignment: undefined,
        command: undefined,
        name: undefined,
        showCalls: 0,
        hideCalls: 0,
        textSets: [],
        tooltipSets: [],
        disposed: false,
        show() { this.showCalls += 1; },
        hide() { this.hideCalls += 1; },
        dispose() { this.disposed = true; },
    };
    let textValue = '';
    let tooltipValue = '';
    Object.defineProperty(item, 'text', {
        get: () => textValue,
        set: value => { textValue = value; item.textSets.push(value); },
    });
    Object.defineProperty(item, 'tooltip', {
        get: () => tooltipValue,
        set: value => { tooltipValue = value; item.tooltipSets.push(value); },
    });
    const fakeVscode = {
        StatusBarAlignment: { Left: 1, Right: 2 },
        window: {
            createStatusBarItem: (alignment, priority) => {
                calls.push(['createStatusBarItem', alignment, priority]);
                item.alignment = alignment;
                return item;
            },
        },
    };
    const { createAttentionStatusBarController } = loadWithFakeVscode(
        '../../../out/aiSessions/attentionStatusBarController',
        fakeVscode
    );
    return { calls, item, createAttentionStatusBarController };
}

test('ATTENTION-STATUS-BAR-QUEUE-001 drives the status bar item visibility and content', () => {
    const { calls, item, createAttentionStatusBarController } =
        createStatusBarItemRecorder();
    let enabled = true;
    const controller = createAttentionStatusBarController({
        isEnabled: () => enabled,
        command: 'agentPivot.nextAttentionSession',
        nowMs: () => 61_000,
    });

    assert.deepEqual(calls, [['createStatusBarItem', 2, undefined]],
        'the item anchors to the right side of the status bar');
    assert.equal(item.command, 'agentPivot.nextAttentionSession');

    const emptyQueue = { items: [], localCount: 0, remoteCount: 0, total: 0 };
    controller.refresh(emptyQueue);
    assert.equal(item.showCalls, 0, 'an empty queue never shows the item');

    const queue = buildAttentionQueue(makeQueueInput());
    controller.refresh(queue);
    assert.equal(item.showCalls, 1);
    assert.equal(item.text, '$(bell) 3');
    assert.match(item.tooltip, /3 AI sessions need attention/);

    const textSets = item.textSets.length;
    controller.refresh(buildAttentionQueue(makeQueueInput()));
    assert.equal(item.textSets.length, textSets,
        'an unchanged refresh must not reassign item properties');
    assert.equal(item.showCalls, 1);

    enabled = false;
    controller.refresh(queue);
    assert.equal(item.hideCalls, 1, 'disabling attention hides the item');
    enabled = true;
    controller.refresh(emptyQueue);
    assert.equal(item.showCalls, 1, 'an emptied queue stays hidden');

    controller.dispose();
    assert.equal(item.disposed, true);
});

function makeJumpOptions(queue, clearOnNextSession = false) {
    const calls = [];
    return {
        calls,
        options: createAttentionQueueJumpHandler({
            buildQueue: () => queue,
            focusSession: async item => {
                calls.push(['focusSession', `${item.provider}:${item.sessionId}`]);
                return queue.focusSucceeds !== false;
            },
            openConversation: async item => {
                calls.push(['openConversation', `${item.provider}:${item.sessionId}`]);
            },
            acknowledge: async eventIds => {
                calls.push(['acknowledge', eventIds]);
            },
            shouldAcknowledge: () => clearOnNextSession,
            findNavigationCardId: projectId => {
                calls.push(['findNavigationCardId', projectId]);
                return queue.navigationCardId || null;
            },
            openNavigationCard: async cardId => {
                calls.push(['openNavigationCard', cardId]);
            },
            showInformationMessage: message => {
                calls.push(['info', message]);
            },
            showWarningMessage: message => {
                calls.push(['warning', message]);
            },
        }),
    };
}

test('ATTENTION-STATUS-BAR-QUEUE-001 jump cycles local sessions while keeping them unread by default', async () => {
    const queue = buildAttentionQueue(makeQueueInput());
    const { calls, options } = makeJumpOptions(queue);

    await options();
    await options();

    assert.deepEqual(calls, [
        ['focusSession', 'kimi:sess-1'],
        ['openConversation', 'kimi:sess-1'],
        ['focusSession', 'codex:sess-2'],
        ['openConversation', 'codex:sess-2'],
    ], 'navigation advances without clearing attention unless the setting opts in');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 jump acknowledges after focus and open when enabled', async () => {
    const queue = buildAttentionQueue(makeQueueInput());
    const { calls, options } = makeJumpOptions(queue, true);

    await options();

    assert.deepEqual(calls, [
        ['focusSession', 'kimi:sess-1'],
        ['openConversation', 'kimi:sess-1'],
        ['acknowledge', ['e-1']],
    ], 'the opt-in setting drains the queue only after focus and open succeed');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 jump keeps an unfocusable session unread and warns', async () => {
    const queue = buildAttentionQueue(makeQueueInput());
    queue.focusSucceeds = false;
    const { calls, options } = makeJumpOptions(queue);

    await options();
    await options();

    assert.deepEqual(calls, [
        ['focusSession', 'kimi:sess-1'],
        ['warning', 'Agent Pivot: the selected AI session is no longer active.'],
        ['focusSession', 'codex:sess-2'],
        ['warning', 'Agent Pivot: the selected AI session is no longer active.'],
    ]);
});

test('ATTENTION-STATUS-BAR-QUEUE-001 jump hops to the window owning a remote session without acknowledging it', async () => {
    const queue = buildAttentionQueue({
        aggregate: makeQueueInput().aggregate,
        workspace: null,
    });
    queue.navigationCardId = 'card-remote';
    const { calls, options } = makeJumpOptions(queue);

    await options();

    assert.deepEqual(calls, [
        ['findNavigationCardId', projectKeyOf('file:///work/other')],
        ['openNavigationCard', 'card-remote'],
    ], 'remote jumps switch windows; the remote window drains its own queue');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 jump reports an unmatchable remote session and an empty queue', async () => {
    const remoteQueue = buildAttentionQueue({
        aggregate: makeQueueInput().aggregate,
        workspace: null,
    });
    const remote = makeJumpOptions(remoteQueue);
    await remote.options();
    assert.deepEqual(remote.calls, [
        ['findNavigationCardId', projectKeyOf('file:///work/other')],
        ['warning', 'Agent Pivot: the session that needs attention is in a window that is no longer open.'],
    ]);

    const empty = makeJumpOptions({
        items: [], localCount: 0, remoteCount: 0, total: 0,
    });
    await empty.options();
    assert.deepEqual(empty.calls, [
        ['info', 'Agent Pivot: no AI sessions need attention.'],
    ]);
});

function makeFocusContinuityJump(queue, state) {
    const calls = [];
    const jump = createAttentionQueueJumpHandler({
        buildQueue: () => queue,
        focusSession: async item => {
            state.focused = `${item.provider}:${item.sessionId}`;
            calls.push(['focusSession', state.focused]);
            return true;
        },
        openConversation: async item => {
            calls.push(['openConversation', `${item.provider}:${item.sessionId}`]);
        },
        acknowledge: async () => {},
        shouldAcknowledge: () => false,
        findNavigationCardId: () => 'card-remote',
        openNavigationCard: async cardId => {
            calls.push(['openNavigationCard', cardId]);
        },
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        getCurrentIdentity: () => {
            const [provider, sessionId] = state.focused.split(':');
            return { provider, sessionId };
        },
    });
    return { calls, jump };
}

test('ATTENTION-STATUS-BAR-QUEUE-001 jump continues after the focused session instead of re-landing on it', async () => {
    const queue = buildAttentionQueue(makeQueueInput());
    const state = { focused: 'kimi:sess-1' };
    const { calls, jump } = makeFocusContinuityJump(queue, state);

    await jump();

    assert.deepEqual(calls, [
        ['focusSession', 'codex:sess-2'],
        ['openConversation', 'codex:sess-2'],
    ], 'a press while watching the queue head must move to the next waiting session');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 jump re-anchors to the watched session instead of following a stale cursor', async () => {
    const input = makeQueueInput();
    input.aggregate.sessions = input.aggregate.sessions.slice(0, 2);
    const queue = buildAttentionQueue(input);
    const state = { focused: 'kimi:sess-1' };
    const { calls, jump } = makeFocusContinuityJump(queue, state);

    await jump();
    state.focused = 'kimi:sess-1';
    await jump();

    assert.deepEqual(calls, [
        ['focusSession', 'codex:sess-2'],
        ['openConversation', 'codex:sess-2'],
        ['focusSession', 'codex:sess-2'],
        ['openConversation', 'codex:sess-2'],
    ], 'a manual detour must re-anchor the cycle where the user is');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 jump keeps the global cycle moving after a manual detour', async () => {
    const queue = buildAttentionQueue(makeQueueInput());
    const state = { focused: 'kimi:sess-1' };
    const { calls, jump } = makeFocusContinuityJump(queue, state);

    await jump();
    state.focused = 'kimi:sess-1';
    await jump();

    assert.deepEqual(calls, [
        ['focusSession', 'codex:sess-2'],
        ['openConversation', 'codex:sess-2'],
        ['openNavigationCard', 'card-remote'],
    ], 'a manual detour home must not trap the cycle; the press continues after the last jump target');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 jump starts at the oldest local session when nothing anchors the cycle', async () => {
    const queue = buildAttentionQueue(makeQueueInput());
    const { calls, options } = makeJumpOptions(queue);

    await options();

    assert.deepEqual(calls, [
        ['focusSession', 'kimi:sess-1'],
        ['openConversation', 'kimi:sess-1'],
    ], 'a fresh press stays home first even when the globally oldest session is remote');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 jump cycle eventually focuses every waiting session across windows', async () => {
    const aggregate = makeQueueInput().aggregate;
    const queueA = buildAttentionQueue({ aggregate, workspace: makeWorkspace() });
    const queueB = buildAttentionQueue({
        aggregate,
        workspace: {
            roots: [{ id: 'root-b', uri: 'file:///work/other' }],
            sessions: [{ provider: 'claude', id: 'sess-9', name: 'other project', primaryRootId: 'root-b' }],
        },
    });
    const world = {
        active: 'A',
        // A's focused terminal lingers on codex:sess-2; remote jumps never move it.
        focused: { A: 'codex:sess-2', B: null },
    };
    const focusedByJumps = new Set();
    const windows = {};
    for (const [name, queue] of [['A', queueA], ['B', queueB]]) {
        windows[name] = createAttentionQueueJumpHandler({
            buildQueue: () => queue,
            focusSession: async item => {
                world.focused[name] = `${item.provider}:${item.sessionId}`;
                focusedByJumps.add(world.focused[name]);
                return true;
            },
            openConversation: async () => {},
            acknowledge: async () => {},
            shouldAcknowledge: () => false,
            findNavigationCardId: () => 'card-remote',
            openNavigationCard: async () => {
                world.active = name === 'A' ? 'B' : 'A';
            },
            showInformationMessage: () => {},
            showWarningMessage: () => {},
            getCurrentIdentity: () => {
                const focused = world.focused[name];
                if (!focused) {
                    return null;
                }
                const [provider, sessionId] = focused.split(':');
                return { provider, sessionId };
            },
        });
    }

    for (let press = 0; press < 6; press += 1) {
        await windows[world.active]();
    }

    assert.deepEqual([...focusedByJumps].sort(), [
        'claude:sess-9',
        'codex:sess-2',
        'kimi:sess-1',
    ], 'a stale watched anchor must not starve a waiting session out of the cycle');
});
