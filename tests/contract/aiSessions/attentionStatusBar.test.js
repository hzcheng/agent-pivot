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
    filterAttentionQueueToReachableWindows,
    formatAttentionStatusBar,
} = require('../../../out/aiSessions/attentionQueue');
const {
    createAttentionQueueJumpHandler,
} = require('../../../out/dashboard/attentionQueueJump');
const {
    createRunningSessionJumpHandler,
} = require('../../../out/dashboard/runningSessionJump');
const {
    createSessionNavigationCoordinator,
} = require('../../../out/dashboard/sessionNavigationCoordinator');

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

test('ATTENTION-STATUS-BAR-QUEUE-001 removes attention from closed remote windows before presenting the queue', () => {
    const queue = buildAttentionQueue(makeQueueInput());
    const reachable = filterAttentionQueueToReachableWindows(
        queue,
        projectId => projectId !== projectKeyOf('file:///work/other')
    );

    assert.deepEqual(reachable.items.map(item => `${item.provider}:${item.sessionId}`), [
        'kimi:sess-1',
        'codex:sess-2',
    ]);
    assert.equal(reachable.total, 2);
    assert.equal(reachable.localCount, 2);
    assert.equal(reachable.remoteCount, 0);
    assert.equal(queue.total, 3,
        'filtering an unreachable window does not acknowledge or mutate its source aggregate');
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
                return queue.openSucceeds !== false;
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

test('ATTENTION-STATUS-BAR-QUEUE-001 keeps attention unread when the conversation does not open', async () => {
    const queue = buildAttentionQueue(makeQueueInput());
    queue.openSucceeds = false;
    const { calls, options } = makeJumpOptions(queue, true);

    await options();

    assert.deepEqual(calls, [
        ['focusSession', 'kimi:sess-1'],
        ['openConversation', 'kimi:sess-1'],
    ], 'a failed or superseded conversation open must not clear the unread event');
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

test('ATTENTION-STATUS-BAR-QUEUE-001 skips a window that closes during Next Attention and reaches the next live session', async () => {
    const closedProject = projectKeyOf('file:///work/closed');
    const liveProject = projectKeyOf('file:///work/live');
    const queue = {
        items: [
            {
                provider: 'claude', sessionId: 'closed-session', projectId: closedProject,
                eventIds: ['closed-event'], reasons: ['failed'], observedAtMs: 1, local: false,
            },
            {
                provider: 'codex', sessionId: 'live-session', projectId: liveProject,
                eventIds: ['live-event'], reasons: ['input-required'], observedAtMs: 2, local: false,
            },
        ],
        localCount: 0,
        remoteCount: 2,
        total: 2,
    };
    const calls = [];
    const jump = createAttentionQueueJumpHandler({
        buildQueue: () => queue,
        focusSession: async () => true,
        openConversation: async () => true,
        acknowledge: async () => {},
        shouldAcknowledge: () => false,
        findNavigationCardId: projectId => {
            calls.push(['findNavigationCardId', projectId]);
            return projectId === liveProject ? 'live-card' : null;
        },
        openNavigationCard: async cardId => { calls.push(['openNavigationCard', cardId]); },
        showInformationMessage: message => { calls.push(['info', message]); },
        showWarningMessage: message => { calls.push(['warning', message]); },
    });

    await jump();

    assert.deepEqual(calls, [
        ['findNavigationCardId', closedProject],
        ['findNavigationCardId', liveProject],
        ['openNavigationCard', 'live-card'],
    ]);
});

test('ATTENTION-STATUS-BAR-QUEUE-001 skips a closed window without re-landing on the watched session', async () => {
    const currentProject = projectKeyOf('file:///work/current');
    const closedProject = projectKeyOf('file:///work/closed');
    const liveProject = projectKeyOf('file:///work/live');
    const queue = {
        items: [
            {
                provider: 'codex', sessionId: 'current-session', projectId: currentProject,
                eventIds: ['current-event'], reasons: ['input-required'], observedAtMs: 1, local: true,
            },
            {
                provider: 'claude', sessionId: 'closed-session', projectId: closedProject,
                eventIds: ['closed-event'], reasons: ['failed'], observedAtMs: 2, local: false,
            },
            {
                provider: 'kimi', sessionId: 'live-session', projectId: liveProject,
                eventIds: ['live-event'], reasons: ['completed'], observedAtMs: 3, local: false,
            },
        ],
        localCount: 1,
        remoteCount: 2,
        total: 3,
    };
    const calls = [];
    const jump = createAttentionQueueJumpHandler({
        buildQueue: () => queue,
        focusSession: async item => {
            calls.push(['focusSession', item.sessionId]);
            return true;
        },
        openConversation: async () => true,
        acknowledge: async () => {},
        shouldAcknowledge: () => false,
        getCurrentIdentity: () => ({ provider: 'codex', sessionId: 'current-session' }),
        findNavigationCardId: projectId => {
            calls.push(['findNavigationCardId', projectId]);
            return projectId === liveProject ? 'live-card' : null;
        },
        openNavigationCard: async cardId => { calls.push(['openNavigationCard', cardId]); },
        showInformationMessage: message => { calls.push(['info', message]); },
        showWarningMessage: message => { calls.push(['warning', message]); },
    });

    await jump();

    assert.deepEqual(calls, [
        ['findNavigationCardId', closedProject],
        ['findNavigationCardId', liveProject],
        ['openNavigationCard', 'live-card'],
    ]);
});

test('ATTENTION-STATUS-BAR-QUEUE-001 reports no reachable attention when every remote window has closed', async () => {
    const remoteQueue = buildAttentionQueue({
        aggregate: makeQueueInput().aggregate,
        workspace: null,
    });
    const remote = makeJumpOptions(remoteQueue);
    await remote.options();
    assert.deepEqual(remote.calls, [
        ['findNavigationCardId', projectKeyOf('file:///work/other')],
        ['findNavigationCardId', projectKeyOf('file:///work/alpha')],
        ['findNavigationCardId', projectKeyOf('file:///work/alpha')],
        ['info', 'Agent Pivot: no reachable AI sessions need attention.'],
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
            return true;
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

test('ATTENTION-STATUS-BAR-QUEUE-001 jump re-anchors a manual detour with three candidates', async () => {
    const queue = buildAttentionQueue(makeQueueInput());
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
    ], 'the watched session must re-anchor the next press regardless of queue length');
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

test('ATTENTION-STATUS-BAR-QUEUE-001 hands a remote target to its owning window even when it is already focused', async () => {
    const globalItems = [
        {
            provider: 'codex', sessionId: 'a', projectId: 'A', eventIds: ['ea'],
            reasons: ['completed'], observedAtMs: 1,
        },
        {
            provider: 'codex', sessionId: 'b', projectId: 'B', eventIds: ['eb'],
            reasons: ['completed'], observedAtMs: 2,
        },
    ];
    const world = { active: 'A', focused: { A: 'a', B: 'b' } };
    const calls = [];
    const windows = {};
    for (const name of ['A', 'B']) {
        const items = globalItems.map(item => ({ ...item, local: item.projectId === name }));
        const queue = { items, localCount: 1, remoteCount: 1, total: 2 };
        windows[name] = createAttentionQueueJumpHandler({
            buildQueue: () => queue,
            focusSession: async item => {
                world.focused[name] = item.sessionId;
                calls.push(['focus', name, item.sessionId]);
                return true;
            },
            openConversation: async item => {
                calls.push(['open', name, item.sessionId]);
                return true;
            },
            acknowledge: async eventIds => calls.push(['ack', name, eventIds]),
            shouldAcknowledge: () => true,
            requestRemoteFocus: async item => {
                const target = item.projectId;
                await windows[target].jumpToAttentionSession(item);
                return true;
            },
            findNavigationCardId: projectId => projectId,
            openNavigationCard: async cardId => {
                calls.push(['switch', name, cardId]);
                world.active = cardId;
            },
            showInformationMessage: () => {},
            showWarningMessage: () => {},
            getCurrentIdentity: () => ({
                provider: 'codex',
                sessionId: world.focused[name],
            }),
        });
    }

    await windows.A();
    await windows.B();

    assert.deepEqual(calls, [
        ['focus', 'B', 'b'],
        ['open', 'B', 'b'],
        ['ack', 'B', ['eb']],
        ['switch', 'A', 'B'],
        ['focus', 'A', 'a'],
        ['open', 'A', 'a'],
        ['ack', 'A', ['ea']],
        ['switch', 'B', 'A'],
    ], 'each remote press must complete the exact target before switching windows');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 preserves every rapid relative invocation', async () => {
    const items = ['a', 'b', 'c'].map((sessionId, index) => ({
        provider: 'codex', sessionId, projectId: 'A', eventIds: [`e${index}`],
        reasons: ['completed'], observedAtMs: index, local: true,
    }));
    const queue = { items, localCount: 3, remoteCount: 0, total: 3 };
    const releases = [];
    const picked = [];
    let focused = 'a';
    const jump = createAttentionQueueJumpHandler({
        buildQueue: () => queue,
        focusSession: item => new Promise(resolve => {
            picked.push(item.sessionId);
            releases.push(() => {
                focused = item.sessionId;
                resolve(true);
            });
        }),
        openConversation: async () => true,
        acknowledge: async () => {},
        shouldAcknowledge: () => false,
        findNavigationCardId: () => null,
        openNavigationCard: async () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        getCurrentIdentity: () => ({ provider: 'codex', sessionId: focused }),
    });

    const first = jump();
    const second = jump();
    const third = jump();
    await Promise.resolve();
    assert.deepEqual(picked, ['b'], 'the second invocation waits for the first focus');
    releases.shift()();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(picked, ['b', 'c']);
    releases.shift()();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(picked, ['b', 'c', 'a']);
    releases.shift()();
    await Promise.all([first, second, third]);
    assert.equal(focused, 'a');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 AI-SESSION-NEXT-RUNNING-COMMAND-001 serializes interleaved navigation commands so the last invocation wins', async () => {
    const navigationCoordinator = createSessionNavigationCoordinator();
    let releaseRunningFocus;
    let focused = 'running-a';
    const calls = [];
    const running = createRunningSessionJumpHandler({
        navigationCoordinator,
        buildQueue: () => ({
            items: [
                { kind: 'local', key: 'session:codex:running-a', provider: 'codex', sessionId: 'running-a' },
                { kind: 'local', key: 'session:codex:running-b', provider: 'codex', sessionId: 'running-b' },
            ],
            localCount: 2,
            remoteCount: 0,
            total: 2,
        }),
        focusSession: item => new Promise(resolve => {
            calls.push(['running-focus-start', item.sessionId]);
            releaseRunningFocus = () => {
                focused = item.sessionId;
                calls.push(['running-focus-end', item.sessionId]);
                resolve(true);
            };
        }),
        openConversation: async item => calls.push(['running-open', item.sessionId]),
        requestRemoteFocus: async () => true,
        openNavigationCard: async () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        getCurrentKey: () => `session:codex:${focused}`,
    });
    const attention = createAttentionQueueJumpHandler({
        navigationCoordinator,
        buildQueue: () => ({
            items: [{
                provider: 'codex', sessionId: 'attention', projectId: 'A',
                eventIds: ['event'], reasons: ['completed'], observedAtMs: 1, local: true,
            }],
            localCount: 1,
            remoteCount: 0,
            total: 1,
        }),
        focusSession: async item => {
            focused = item.sessionId;
            calls.push(['attention-focus', item.sessionId]);
            return true;
        },
        openConversation: async item => {
            calls.push(['attention-open', item.sessionId]);
            return true;
        },
        acknowledge: async () => {},
        shouldAcknowledge: () => false,
        findNavigationCardId: () => null,
        openNavigationCard: async () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        getCurrentIdentity: () => null,
    });

    const runningJump = running.jumpToNextRunningSession();
    await Promise.resolve();
    const attentionJump = attention();
    await Promise.resolve();

    assert.deepEqual(calls, [['running-focus-start', 'running-b']],
        'Attention must wait for the earlier Running focus transaction');
    releaseRunningFocus();
    await Promise.all([runningJump, attentionJump]);

    assert.deepEqual(calls, [
        ['running-focus-start', 'running-b'],
        ['running-focus-end', 'running-b'],
        ['running-open', 'running-b'],
        ['attention-focus', 'attention'],
        ['attention-open', 'attention'],
    ]);
    assert.equal(focused, 'attention', 'the latest navigation invocation must own final focus');
});
