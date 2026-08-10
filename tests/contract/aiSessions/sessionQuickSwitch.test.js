'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    createAiSessionMruTracker,
} = require('../../../out/aiSessions/sessionMru');
const {
    buildAiSessionSwitchItems,
    createAiSessionQuickSwitchHandlers,
} = require('../../../out/dashboard/sessionQuickSwitch');
const {
    createRunningSessionJumpHandler,
} = require('../../../out/dashboard/runningSessionJump');
const {
    createAttentionQueueJumpHandler,
} = require('../../../out/dashboard/attentionQueueJump');
const {
    createSessionNavigationCoordinator,
} = require('../../../out/dashboard/sessionNavigationCoordinator');
const {
    createSessionNavigationFocusExecutor,
} = require('../../../out/dashboard/sessionNavigationFocusExecutor');

const WINDOW_A = 'a'.repeat(64);
const WINDOW_B = 'b'.repeat(64);

function session(provider, sessionId, overrides = {}) {
    return {
        key: `${provider}:${sessionId}`,
        provider,
        sessionId,
        name: overrides.name || sessionId,
        executionState: overrides.executionState || 'running',
        status: overrides.status || 'running',
        focused: overrides.focused === true,
        needsAttention: overrides.needsAttention === true,
        pending: false,
        backend: 'vscode',
        attached: true,
    };
}

function remoteWindow(navigationIdentity, runningSessionCount = 1) {
    return {
        cardId: `card-${navigationIdentity.slice(0, 8)}`,
        navigationIdentity,
        displayName: `Window ${navigationIdentity.slice(0, 4)}`,
        runningSessionCount,
    };
}

function makeMru(keys) {
    const tracker = createAiSessionMruTracker({ now: () => 1000 });
    for (const key of [...keys].reverse()) {
        const separator = key.indexOf(':');
        tracker.record(key.slice(0, separator), key.slice(separator + 1));
    }
    return tracker;
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeOptions(overrides = {}) {
    const calls = [];
    const options = {
        getLocalSessions: () => overrides.localSessions || [],
        getRemoteWindows: () => overrides.remoteWindows || [],
        getFocusedSessionKey: () => overrides.focusedKey ?? null,
        mru: overrides.mru || makeMru([]),
        showPick: (items, placeHolder) => {
            calls.push(['pick', placeHolder, items.map(item => item.label)]);
            return Promise.resolve(
                overrides.pick === undefined
                    ? undefined
                    : items[overrides.pick]
            );
        },
        navigateSession: async (target, executionOptions) => {
            calls.push(['focus', target.provider, target.sessionId]);
            if (overrides.focusResult === false) {
                return { focused: false, conversationOpened: false };
            }
            executionOptions.onFocused?.();
            calls.push(['open', target.provider, target.sessionId]);
            return {
                focused: true,
                conversationOpened: overrides.conversationOpened !== false,
            };
        },
        requestRemoteFocus: target => {
            calls.push(['request', target.navigationIdentity]);
            if (overrides.requestThrows) {
                return Promise.reject(new Error('command is not registered'));
            }
            return Promise.resolve(overrides.requestResult !== false);
        },
        openNavigationCard: cardId => {
            calls.push(['navigate', cardId]);
            return Promise.resolve();
        },
        showInformationMessage: message => calls.push(['info', message]),
        showWarningMessage: message => calls.push(['warn', message]),
    };
    return { calls, options };
}

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 wires the MRU to a completion-independent focus resolver', () => {
    // Regression: the first wiring read the attention highlighter's focused
    // identity, which is cleared when a turn completes or the dashboard
    // hides, and waited for onDidChangeActiveTerminal, which tmux window
    // switches inside one attach terminal never fire — so the tracker
    // starved and the toggle always reported no previous session. The MRU
    // must sample a completion-independent terminal resolution instead.
    const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/dashboard.ts'),
        'utf8'
    );
    const resolver = /const getFocusedAiSessionIdentity = [\s\S]*?\n    \};/;
    assert.match(source, resolver);
    const resolverBody = source.match(resolver)[0];
    assert.match(resolverBody, /tmuxRuntimeBackend\.getFocusedRuntime\(activeTerminal\)/);
    assert.match(resolverBody, /candidate\.terminal === activeTerminal/);
    assert.doesNotMatch(resolverBody, /getFocusedAiSessionRuntimeIdentity/);

    const sampler = /setInterval\(\(\) => \{\s*const identity = getFocusedAiSessionIdentity\(\);[\s\S]*?aiSessionMru\.record\(/;
    assert.match(source, sampler);
    const quickSwitchSource = fs.readFileSync(
        path.resolve(__dirname, '../../../src/dashboard/sessionQuickSwitch.ts'),
        'utf8'
    );
    assert.match(
        quickSwitchSource,
        /onFocused: \(\) => options\.mru\.record\(target\.provider, target\.sessionId\)/
    );
    assert.match(
        source,
        /navigateSession: \(target, executionOptions\) =>\s*sessionNavigationFocusExecutor\.execute\(target, executionOptions\)/
    );
    assert.match(source, /getFocusedSessionKey: \(\) => \{\s*const identity = getFocusedAiSessionIdentity\(\);/);
    assert.match(
        source,
        /createSessionNavigationFocusExecutor\(\{[\s\S]*?onFocused: target =>\s*aiSessionMru\.record\(target\.provider, target\.sessionId\)/,
        'every successful shared focus transaction must update Toggle Last synchronously'
    );
    assert.match(
        source,
        /followAdjacentActiveConversationWithFeedback[\s\S]*?result === 'opened'[\s\S]*?aiSessionMru\.record\(identity\.provider, identity\.sessionId\)/,
        'Previous and Next Active Session must update Toggle Last synchronously'
    );
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 tracker keeps a bounded deduplicated newest-first order', () => {
    const tracker = createAiSessionMruTracker({ now: () => 1000, maxEntries: 3 });

    tracker.record('codex', 'c1');
    tracker.record('kimi', 'k1');
    tracker.record('codex', 'c1');
    tracker.record('claude', 'l1');
    tracker.record('kimi', 'k2');

    assert.deepEqual(tracker.entries().map(entry => entry.key), [
        'kimi:k2',
        'claude:l1',
        'codex:c1',
    ]);
    assert.equal(tracker.mostRecentKey(), 'kimi:k2');
    assert.equal(tracker.mostRecentKey('kimi:k2'), 'claude:l1');
    assert.equal(tracker.mostRecentKey('kimi:k9'), 'kimi:k2');

    tracker.record('', 'x1');
    assert.equal(tracker.entries().length, 3);

    tracker.prune(new Set(['codex:c1']));
    assert.deepEqual(tracker.entries().map(entry => entry.key), ['codex:c1']);
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 switch items are MRU-first locals then window-granular remotes', () => {
    const items = buildAiSessionSwitchItems({
        localSessions: [
            session('kimi', 'k2', { name: 'Beta' }),
            session('codex', 'c1', { name: 'Alpha', focused: true, needsAttention: true }),
            session('codex', 'c1'),
            session('claude', ''),
            null,
        ],
        remoteWindows: [
            remoteWindow(WINDOW_B, 2),
            remoteWindow(WINDOW_A),
            remoteWindow(WINDOW_A),
            remoteWindow('c'.repeat(64), 0),
        ],
        mruOrder: ['kimi:k2'],
    });

    assert.deepEqual(items.map(item => item.label), [
        '$(terminal) Beta',
        '$(terminal) Alpha',
        `$(arrow-right) Window ${'aaaa'}`,
        `$(arrow-right) Window ${'bbbb'}`,
    ]);
    assert.equal(items[0].description, 'Kimi · Running');
    assert.equal(items[1].description, 'Codex · Running · Focused · Needs attention');
    assert.equal(items[2].description, '1 running session in another window');
    assert.equal(items[3].description, '2 running sessions in another window');
    assert.deepEqual(items.map(item => item.target.kind), [
        'local', 'local', 'remote', 'remote',
    ]);
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 switch jumps locally, cancels quietly, and reports an empty list', async () => {
    const empty = makeOptions({});
    await createAiSessionQuickSwitchHandlers(empty.options).switchToAiSession();
    assert.deepEqual(empty.calls, [['info', 'Agent Pivot: no active AI sessions.']]);

    const cancelled = makeOptions({ localSessions: [session('codex', 'c1')] });
    await createAiSessionQuickSwitchHandlers(cancelled.options).switchToAiSession();
    assert.equal(cancelled.calls.length, 1);
    assert.equal(cancelled.calls[0][0], 'pick');

    const picked = makeOptions({
        localSessions: [session('codex', 'c1', { name: 'Alpha' }), session('kimi', 'k1')],
        pick: 1,
    });
    await createAiSessionQuickSwitchHandlers(picked.options).switchToAiSession();
    assert.deepEqual(picked.calls.slice(1), [
        ['focus', 'kimi', 'k1'],
        ['open', 'kimi', 'k1'],
    ]);

    const stale = makeOptions({
        localSessions: [session('codex', 'c1')],
        pick: 0,
        focusResult: false,
    });
    await createAiSessionQuickSwitchHandlers(stale.options).switchToAiSession();
    assert.deepEqual(stale.calls.slice(1), [
        ['focus', 'codex', 'c1'],
        ['warn', 'Agent Pivot: the selected AI session is no longer active.'],
    ]);
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 switch hands off remote windows and degrades to plain navigation', async () => {
    const handedOff = makeOptions({
        localSessions: [session('codex', 'c1')],
        remoteWindows: [remoteWindow(WINDOW_A, 2)],
        pick: 1,
    });
    await createAiSessionQuickSwitchHandlers(handedOff.options).switchToAiSession();
    assert.deepEqual(handedOff.calls.slice(1), [
        ['request', WINDOW_A],
        ['navigate', `card-${'a'.repeat(8)}`],
    ]);

    for (const overrides of [{ requestResult: false }, { requestThrows: true }]) {
        const degraded = makeOptions({
            ...overrides,
            remoteWindows: [remoteWindow(WINDOW_A)],
            pick: 0,
        });
        await createAiSessionQuickSwitchHandlers(degraded.options).switchToAiSession();
        assert.deepEqual(degraded.calls.slice(1), [
            ['request', WINDOW_A],
            ['navigate', `card-${'a'.repeat(8)}`],
            ['info', 'Agent Pivot: switched to Window aaaa;'
                + ' run Next Running Session there to focus a session.'],
        ]);
    }
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 AI-SESSION-NEXT-RUNNING-COMMAND-001 serializes Quick Switch behind an older navigation so the latest command wins', async () => {
    const coordinator = createSessionNavigationCoordinator();
    const olderStarted = deferred();
    const releaseOlder = deferred();
    const settled = [];
    let terminal = 'initial';
    let conversation = 'initial';
    const running = createRunningSessionJumpHandler({
        navigationCoordinator: coordinator,
        buildQueue: () => ({
            items: [{
                kind: 'local',
                key: 'session:codex:older',
                provider: 'codex',
                sessionId: 'older',
                name: 'Older',
            }],
            localCount: 1,
            remoteCount: 0,
            total: 1,
        }),
        navigateSession: async item => {
            olderStarted.resolve();
            await releaseOlder.promise;
            terminal = item.sessionId;
            conversation = item.sessionId;
            settled.push(item.sessionId);
            return { focused: true, conversationOpened: true };
        },
        requestRemoteFocus: async () => false,
        openNavigationCard: async () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
    });
    const quick = createAiSessionQuickSwitchHandlers({
        navigationCoordinator: coordinator,
        getLocalSessions: () => [session('codex', 'newer')],
        getRemoteWindows: () => [],
        getFocusedSessionKey: () => null,
        mru: makeMru([]),
        showPick: async items => items[0],
        navigateSession: async (target, executionOptions) => {
            terminal = target.sessionId;
            executionOptions.onFocused?.();
            conversation = target.sessionId;
            settled.push(target.sessionId);
            return { focused: true, conversationOpened: true };
        },
        // The unfixed implementation ignores the shared transaction options
        // and calls these independent legacy callbacks immediately.
        focusSession: async target => {
            terminal = target.sessionId;
            return true;
        },
        openConversation: async target => {
            conversation = target.sessionId;
            settled.push(target.sessionId);
        },
        requestRemoteFocus: async () => false,
        openNavigationCard: async () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
    });

    const older = running.jumpToNextRunningSession();
    await olderStarted.promise;
    const newer = quick.switchToAiSession();
    await new Promise(resolve => setImmediate(resolve));
    releaseOlder.resolve();
    await Promise.all([older, newer]);

    assert.deepEqual(settled, ['older', 'newer']);
    assert.deepEqual({ terminal, conversation }, {
        terminal: 'newer',
        conversation: 'newer',
    });
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 toggle alternates the two most recent local sessions', async () => {
    const mru = makeMru(['codex:c1', 'kimi:k1']);
    const toggling = makeOptions({
        localSessions: [session('codex', 'c1'), session('kimi', 'k1')],
        focusedKey: 'kimi:k1',
        mru,
    });
    const handler = createAiSessionQuickSwitchHandlers(toggling.options);

    await handler.toggleLastAiSession();
    assert.deepEqual(toggling.calls, [['focus', 'codex', 'c1'], ['open', 'codex', 'c1']]);

    // The natural focus event after the jump records c1 as most recent.
    mru.record('codex', 'c1');
    toggling.options.getFocusedSessionKey = () => 'codex:c1';
    await handler.toggleLastAiSession();
    assert.deepEqual(toggling.calls.slice(2), [['focus', 'kimi', 'k1'], ['open', 'kimi', 'k1']]);
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 AI-SESSION-NEXT-RUNNING-COMMAND-001 resolves Toggle Last after older navigation settles', async () => {
    const coordinator = createSessionNavigationCoordinator();
    const olderStarted = deferred();
    const releaseOlder = deferred();
    const settled = [];
    let focusedKey = 'codex:newer';
    const mru = makeMru(['codex:newer', 'codex:older']);
    const running = createRunningSessionJumpHandler({
        navigationCoordinator: coordinator,
        buildQueue: () => ({
            items: [{
                kind: 'local',
                key: 'session:codex:older',
                provider: 'codex',
                sessionId: 'older',
                name: 'Older',
            }],
            localCount: 1,
            remoteCount: 0,
            total: 1,
        }),
        navigateSession: async item => {
            olderStarted.resolve();
            await releaseOlder.promise;
            focusedKey = `${item.provider}:${item.sessionId}`;
            settled.push(item.sessionId);
            return { focused: true, conversationOpened: true };
        },
        requestRemoteFocus: async () => false,
        openNavigationCard: async () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
    });
    const toggle = createAiSessionQuickSwitchHandlers({
        navigationCoordinator: coordinator,
        getLocalSessions: () => [
            session('codex', 'older'),
            session('codex', 'newer'),
        ],
        getRemoteWindows: () => [],
        getFocusedSessionKey: () => focusedKey,
        mru,
        showPick: async () => undefined,
        navigateSession: async (target, executionOptions) => {
            focusedKey = `${target.provider}:${target.sessionId}`;
            executionOptions.onFocused?.();
            settled.push(target.sessionId);
            return { focused: true, conversationOpened: true };
        },
        requestRemoteFocus: async () => false,
        openNavigationCard: async () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
    });

    const older = running.jumpToNextRunningSession();
    await olderStarted.promise;
    const newer = toggle.toggleLastAiSession();
    releaseOlder.resolve();
    await Promise.all([older, newer]);

    assert.deepEqual(settled, ['older', 'newer']);
    assert.equal(focusedKey, 'codex:newer');
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 ATTENTION-STATUS-BAR-QUEUE-001 alternates immediately after Attention navigation without waiting for focus sampling', async () => {
    const coordinator = createSessionNavigationCoordinator();
    const mru = makeMru(['codex:session-a']);
    let focusedKey = 'codex:session-a';
    let terminal = 'session-a';
    let conversation = 'session-a';
    const executor = createSessionNavigationFocusExecutor({
        getProjectId: () => 'project-a',
        focusActive: async (_projectId, provider, sessionId) => {
            terminal = sessionId;
            focusedKey = `${provider}:${sessionId}`;
            return true;
        },
        openConversation: async target => {
            conversation = target.sessionId;
            return true;
        },
        onFocused: target => mru.record(target.provider, target.sessionId),
    });
    const attention = createAttentionQueueJumpHandler({
        navigationCoordinator: coordinator,
        buildQueue: () => ({
            items: [{
                provider: 'codex', sessionId: 'session-b', projectId: 'project-a',
                eventIds: ['event-b'], reasons: ['completed'], observedAtMs: 1, local: true,
            }],
            localCount: 1,
            remoteCount: 0,
            total: 1,
        }),
        navigateSession: (target, executionOptions) =>
            executor.execute(target, executionOptions),
        acknowledge: async () => {},
        shouldAcknowledge: () => false,
        findNavigationCardId: () => null,
        openNavigationCard: async () => {},
        showInformationMessage: () => {},
        showWarningMessage: () => {},
        getCurrentIdentity: () => {
            const separator = focusedKey.indexOf(':');
            return {
                provider: focusedKey.slice(0, separator),
                sessionId: focusedKey.slice(separator + 1),
            };
        },
    });
    const messages = [];
    const toggle = createAiSessionQuickSwitchHandlers({
        navigationCoordinator: coordinator,
        getLocalSessions: () => [
            session('codex', 'session-a'),
            session('codex', 'session-b'),
        ],
        getRemoteWindows: () => [],
        getFocusedSessionKey: () => focusedKey,
        mru,
        showPick: async () => undefined,
        navigateSession: (target, executionOptions) =>
            executor.execute(target, executionOptions),
        requestRemoteFocus: async () => false,
        openNavigationCard: async () => {},
        showInformationMessage: message => messages.push(message),
        showWarningMessage: () => {},
    });

    await attention();
    await toggle.toggleLastAiSession();
    await toggle.toggleLastAiSession();

    assert.deepEqual({ terminal, conversation, focusedKey }, {
        terminal: 'session-b',
        conversation: 'session-b',
        focusedKey: 'codex:session-b',
    });
    assert.deepEqual(messages, []);

    for (let index = 0; index < 100; index += 1) {
        await toggle.toggleLastAiSession();
        const expected = index % 2 === 0 ? 'session-a' : 'session-b';
        assert.deepEqual({ terminal, conversation, focusedKey }, {
            terminal: expected,
            conversation: expected,
            focusedKey: `codex:${expected}`,
        });
    }
    assert.deepEqual(messages, []);
});

test('AI-SESSION-QUICK-SWITCH-COMMANDS-001 toggle prunes dead sessions and reports an empty history', async () => {
    const mru = makeMru(['codex:dead', 'kimi:k1']);
    const { calls, options } = makeOptions({
        localSessions: [session('kimi', 'k1')],
        focusedKey: null,
        mru,
    });
    await createAiSessionQuickSwitchHandlers(options).toggleLastAiSession();
    assert.deepEqual(calls, [['focus', 'kimi', 'k1'], ['open', 'kimi', 'k1']]);
    assert.deepEqual(mru.entries().map(entry => entry.key), ['kimi:k1']);

    const empty = makeOptions({ localSessions: [session('codex', 'c1')] });
    await createAiSessionQuickSwitchHandlers(empty.options).toggleLastAiSession();
    assert.deepEqual(empty.calls, [
        ['info', 'Agent Pivot: no previous AI session in this window.'],
    ]);

    const onlyCurrent = makeOptions({
        localSessions: [session('codex', 'c1')],
        focusedKey: 'codex:c1',
        mru: makeMru(['codex:c1']),
    });
    await createAiSessionQuickSwitchHandlers(onlyCurrent.options).toggleLastAiSession();
    assert.deepEqual(onlyCurrent.calls, [
        ['info', 'Agent Pivot: no previous AI session in this window.'],
    ]);
});
