'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createAiSessionAttentionEventCapability,
} = require('../../../out/aiSessions/attentionEventCapability');

function flushAsync() {
    return new Promise(resolve => setImmediate(resolve));
}

async function flushAll() {
    for (let index = 0; index < 10; index++) {
        await flushAsync();
    }
}

function makeIdentity(overrides = {}) {
    return {
        provider: 'codex',
        workspaceScopeIdentity: 'scope-1',
        workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
        sessionId: 'session-a',
        ...overrides,
    };
}

function makeRuntime(overrides = {}) {
    return {
        identity: makeIdentity(overrides.identity),
        backend: 'vscode',
        state: 'active',
        markerPath: '/markers/a',
        runStartedAtMs: 700,
        attached: true,
        terminal: { name: 'terminal-a' },
        ...overrides,
    };
}

function createFixture(overrides = {}) {
    const calls = [];
    const listeners = {};
    const disposals = [];
    const terminal = { name: 'fixture-terminal' };
    const bridgeClient = {
        publish: async (items, forceHeartbeat) => {
            calls.push(['bridge-publish', items, forceHeartbeat]);
            return true;
        },
        acknowledge: async eventIds => {
            calls.push(['bridge-acknowledge', eventIds]);
        },
        dispose: () => {
            calls.push(['bridge-dispose']);
        },
    };
    const coordinator = {
        refreshForHost: async force => {
            calls.push(['refresh-for-host', force]);
            if (overrides.refreshForHostError) {
                throw overrides.refreshForHostError;
            }
        },
        getById: () => overrides.liveRuntime || null,
        getActive: () => overrides.activeRuntimes || [],
        getPending: () => overrides.pendingRuntimes || [],
        handleClosedTerminal: closed => {
            calls.push(['runtime-close', closed]);
        },
    };
    const attentionController = {
        evaluate: async runtimeOverrides => {
            calls.push(['attention-evaluate', runtimeOverrides]);
            return { enabled: true, published: true, eventIdsBySession: {}, inScopeSessionKeys: [], overflowedSessionKeys: [] };
        },
        acknowledge: eventIds => {
            calls.push(['local-acknowledge', eventIds]);
        },
        getRecoverySessionEvents: () => overrides.recoverySessionEvents
            || [{ sessionKey: 'codex:session-a', eventIds: ['evt-1', 'evt-1', 'evt-2'] }],
        getAttentionEventIds: () => ['evt-1', 'evt-2'],
        setRemoteAggregate: aggregate => {
            calls.push(['set-remote-aggregate', aggregate]);
            return overrides.remoteAggregateChanged !== false;
        },
    };
    const highlighter = {
        sync: () => {
            calls.push(['highlight-sync']);
        },
        handleTerminalClosed: closed => {
            calls.push(['highlight-close', closed]);
        },
        getIdentity: () => overrides.highlighterIdentity === undefined
            ? { provider: 'codex', sessionId: 'highlighted', workspaceScopeIdentity: 'scope-1' }
            : overrides.highlighterIdentity,
    };
    const registerListener = name => callback => {
        listeners[name] = callback;
        const entry = { name, disposed: false };
        disposals.push(entry);
        return { dispose: () => { entry.disposed = true; } };
    };
    const capability = createAiSessionAttentionEventCapability({
        tmuxRuntimeDiscovery: {
            loadPersistedInactive: async () => {
                calls.push(['load-persisted-inactive']);
                if (overrides.loadPersistedInactiveError) {
                    throw overrides.loadPersistedInactiveError;
                }
            },
            getActive: () => overrides.discoveryActive || [],
            getPending: () => overrides.discoveryPending || [],
            getInactive: () => overrides.discoveryInactive || [],
            getDiagnostics: () => overrides.discoveryDiagnostics || [],
        },
        tmuxRuntimeBackend: {
            getConflicts: () => overrides.backendConflicts || [],
            getFocusedRuntime: activeTerminal => {
                calls.push(['get-focused-runtime', activeTerminal]);
                return overrides.focusedTmuxRuntime || null;
            },
            isAttachTerminalCandidate: candidate => {
                calls.push(['is-attach-candidate', candidate]);
                return Boolean(overrides.attachCandidate);
            },
            restoreAttachTerminals: async terminals => {
                calls.push(['restore-attach-terminals', terminals]);
                if (overrides.restoreError) {
                    throw overrides.restoreError;
                }
            },
        },
        tmuxRuntimeStore: {
            listKnown: async () => {
                if (overrides.storeError) {
                    throw overrides.storeError;
                }
                return overrides.knownBindings || [];
            },
            listPending: async () => {
                if (overrides.storeError) {
                    throw overrides.storeError;
                }
                return overrides.pendingBindings || [];
            },
            listInactive: async () => {
                if (overrides.storeError) {
                    throw overrides.storeError;
                }
                return overrides.inactiveBindings || [];
            },
        },
        aiSessionTerminalService: {
            getTrackedTerminalEntries: () => overrides.trackedEntries || [],
            isComplete: () => true,
        },
        getRuntimeConfiguration: () => ({ mode: overrides.runtimeMode || 'vscode' }),
        getCurrentOpenWorkspace: () => overrides.workspace === undefined
            ? { scopeIdentity: 'scope-1' }
            : overrides.workspace,
        getActiveTerminal: () => overrides.activeTerminal === undefined ? terminal : overrides.activeTerminal,
        postMessage: message => {
            calls.push(['post-message', message]);
        },
        isVisible: () => overrides.visible !== false,
        assertActive: () => {
            if (overrides.assertActiveError) {
                throw overrides.assertActiveError;
            }
        },
        createBridgeClient: (onAggregate, onError) => {
            listeners.bridgeAggregate = onAggregate;
            listeners.bridgeError = onError;
            calls.push(['create-bridge-client']);
            return bridgeClient;
        },
        onDidOpenTerminal: registerListener('openTerminal'),
        onDidChangeActiveTerminal: registerListener('activeTerminal'),
        onDidCloseTerminal: registerListener('closeTerminal'),
        logError: (message, error) => {
            calls.push(['log-error', message, error]);
        },
        logAiSessionRuntimeFailure: (operation, error) => {
            calls.push(['runtime-failure', operation, error]);
        },
        getRuntimeCoordinator: () => coordinator,
        getAttentionController: () => attentionController,
        runSafeLifecycleTask: async (operation, task) => {
            calls.push(['lifecycle-task', operation]);
            try {
                await task();
            } catch (error) {
                calls.push(['lifecycle-task-failed', operation, error]);
            }
        },
        evaluateLifecycleTick: () => {
            calls.push(['lifecycle-tick']);
        },
        refreshViewsNow: reason => {
            calls.push(['refresh', reason || 'refresh']);
        },
        scheduleRefresh: reason => {
            calls.push(['schedule-refresh', reason]);
        },
        postOpenWorkspacesUpdated: () => {
            calls.push(['post-open-workspaces']);
        },
        getActiveTerminalHighlighter: () => highlighter,
        getTmuxFocusedRuntimeMonitor: () => ({
            request: async () => {
                calls.push(['monitor-request']);
            },
        }),
        publishRestoredAttachTerminal: () => {
            calls.push(['publish-restored-attach']);
        },
    });
    return { capability, calls, listeners, disposals, terminal, bridgeClient, coordinator };
}

function indexOfCall(calls, name, fromIndex = 0) {
    return calls.findIndex((call, index) => index >= fromIndex && call[0] === name);
}

test('ATTENTION-EXECUTION-STATE-SYNC-001 attention ownership probes fail open when the tmux store listing fails', async () => {
    const { capability, calls } = createFixture({ storeError: new Error('store offline') });
    assert.equal(await capability.hasLiveTmuxOwnership(), true,
        'a store listing failure must keep ownership so attention keeps flowing');
    const relevanceFailures = calls.filter(call =>
        call[0] === 'runtime-failure' && call[1] === 'attention-relevance');
    assert.ok(relevanceFailures.length >= 1, 'the fail-open path reports the attention-relevance reason');

    const withInactiveProbe = createFixture({ storeError: new Error('store offline') });
    const evaluation = await withInactiveProbe.capability.evaluateAttention([]);
    assert.equal(evaluation.enabled, true, 'evaluation still reaches the attention controller');
    assert.equal(withInactiveProbe.calls.some(call => call[0] === 'refresh-for-host'), true,
        'the fail-open relevance probe still routes through the host refresh');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 attention evaluation proceeds when the inactive restore fails', async () => {
    const overrides = [{
        providerId: 'codex',
        sessionId: 'session-a',
        attentionKey: 'key-a',
        runtime: makeRuntime(),
    }];
    const { capability, calls } = createFixture({
        loadPersistedInactiveError: new Error('inactive restore offline'),
    });
    const evaluation = await capability.evaluateAttention(overrides);
    assert.equal(evaluation.enabled, true);
    const evaluateCall = calls.find(call => call[0] === 'attention-evaluate');
    assert.equal(evaluateCall[1], overrides, 'the exact runtime overrides reach the controller');
    assert.ok(calls.some(call =>
        call[0] === 'runtime-failure' && call[1] === 'attention-inactive-restore'),
    'the restore failure is reported with the attention-inactive-restore reason');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 attention evaluation proceeds when the host refresh fails', async () => {
    const { capability, calls } = createFixture({
        discoveryActive: [makeRuntime({ backend: 'tmux' })],
        refreshForHostError: new Error('refresh offline'),
    });
    const evaluation = await capability.evaluateAttention([]);
    assert.equal(evaluation.enabled, true, 'a host refresh failure must not skip the evaluation');
    assert.deepEqual(calls.filter(call => call[0] === 'refresh-for-host'), [['refresh-for-host', false]]);
    assert.ok(calls.some(call => call[0] === 'runtime-failure' && call[1] === 'attention-refresh'),
        'the refresh failure is reported with the attention-refresh reason');

    const irrelevant = createFixture({});
    await irrelevant.capability.evaluateAttention([]);
    assert.equal(irrelevant.calls.some(call => call[0] === 'refresh-for-host'), false,
        'without relevant tmux runtimes the host refresh is skipped');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 focused identity prefers the in-workspace tmux runtime and falls back otherwise', () => {
    const tmuxIdentity = makeIdentity({ sessionId: 'tmux-focused' });
    const inWorkspace = createFixture({
        focusedTmuxRuntime: makeRuntime({ backend: 'tmux', identity: tmuxIdentity }),
    });
    assert.deepEqual(inWorkspace.capability.getFocusedRuntimeIdentity(), tmuxIdentity,
        'the focused tmux runtime identity wins inside the current workspace');

    const outOfWorkspace = createFixture({
        focusedTmuxRuntime: makeRuntime({
            backend: 'tmux',
            identity: makeIdentity({ sessionId: 'tmux-focused', workspaceScopeIdentity: 'scope-elsewhere' }),
        }),
    });
    assert.deepEqual(outOfWorkspace.capability.getFocusedRuntimeIdentity(), {
        provider: 'codex', sessionId: 'highlighted', workspaceScopeIdentity: 'scope-1',
    }, 'a tmux runtime from another workspace falls back to the highlighter identity');

    const noFocused = createFixture({ activeTerminal: null });
    assert.deepEqual(noFocused.capability.getFocusedRuntimeIdentity(), {
        provider: 'codex', sessionId: 'highlighted', workspaceScopeIdentity: 'scope-1',
    }, 'without a focused tmux runtime the highlighter identity wins');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 deferred tmux restore publishes once settled, ready, and visible', () => {
    const { capability, calls } = createFixture({});
    capability.publishDeferredRestoreIfReady();
    capability.setDeferredRestoreSettled();
    capability.publishDeferredRestoreIfReady();
    assert.equal(calls.some(call => call[0] === 'refresh'), false,
        'the deferred refresh waits for readiness');
    capability.setDeferredRestoreRefreshReady(true);
    capability.publishDeferredRestoreIfReady();
    assert.deepEqual(calls.filter(call => call[0] === 'refresh'),
        [['refresh', 'tmux-bootstrap-restore']]);
    capability.publishDeferredRestoreIfReady();
    assert.equal(calls.filter(call => call[0] === 'refresh').length, 1,
        'the deferred refresh publishes exactly once');

    const hidden = createFixture({ visible: false });
    hidden.capability.setDeferredRestoreSettled();
    hidden.capability.setDeferredRestoreRefreshReady(true);
    hidden.capability.publishDeferredRestoreIfReady();
    assert.equal(hidden.calls.some(call => call[0] === 'refresh'), false,
        'the deferred refresh waits for visibility');

    const disposed = createFixture({ assertActiveError: new Error('disposed') });
    disposed.capability.setDeferredRestoreSettled();
    disposed.capability.setDeferredRestoreRefreshReady(true);
    disposed.capability.publishDeferredRestoreIfReady();
    assert.equal(disposed.calls.some(call => call[0] === 'refresh'), false,
        'the deferred refresh stays silent after disposal');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 terminal handlers register exactly three listeners and dispose them all', async () => {
    const { capability, calls, listeners, disposals, terminal } = createFixture({});
    const restoreRegistration = capability.registerTerminalRestoreHandler();
    const registration = capability.registerTerminalEventHandlers();
    assert.equal(typeof listeners.openTerminal, 'function');
    assert.equal(typeof listeners.activeTerminal, 'function');
    assert.equal(typeof listeners.closeTerminal, 'function');
    assert.equal(disposals.length, 3, 'exactly three listener registrations');
    restoreRegistration.dispose();
    registration.dispose();
    assert.ok(disposals.every(entry => entry.disposed), 'dispose releases every listener');

    listeners.activeTerminal();
    await flushAll();
    const syncIndex = indexOfCall(calls, 'highlight-sync');
    const monitorIndex = indexOfCall(calls, 'monitor-request');
    const refreshIndex = indexOfCall(calls, 'refresh');
    const taskIndex = indexOfCall(calls, 'lifecycle-task');
    const evaluateIndex = indexOfCall(calls, 'attention-evaluate');
    assert.ok(syncIndex >= 0 && monitorIndex > syncIndex && refreshIndex > monitorIndex,
        'the active terminal change syncs, reconciles, then refreshes');
    assert.ok(taskIndex > refreshIndex
        && calls[taskIndex][1] === 'evaluate-attention-active-terminal',
    'the active terminal evaluation runs inside the guarded lifecycle task');
    assert.ok(evaluateIndex > taskIndex, 'the guarded task drives the evaluation');
});

test('ATTENTION-RUNTIME-EXIT-NEUTRAL-001 a process-exit close runs the lifecycle tick without acknowledging attention', async () => {
    const runtime = makeRuntime({ backend: 'vscode' });
    const terminal = { name: 'closing', exitStatus: { code: 0, reason: 2 } };
    runtime.terminal = terminal;
    const { capability, calls, listeners } = createFixture({ activeRuntimes: [runtime] });
    capability.registerTerminalEventHandlers();
    listeners.closeTerminal(terminal);
    await flushAll();
    const closeIndex = indexOfCall(calls, 'runtime-close');
    const tickIndex = indexOfCall(calls, 'lifecycle-tick');
    const highlightIndex = indexOfCall(calls, 'highlight-close');
    const refreshIndex = indexOfCall(calls, 'refresh');
    const closedTaskIndex = calls.findIndex(call =>
        call[0] === 'lifecycle-task' && call[1] === 'evaluate-attention-closed-terminal');
    assert.ok(closeIndex >= 0 && tickIndex > closeIndex && highlightIndex > tickIndex,
        'the close handler ticks the lifecycle right after runtime close handling');
    assert.ok(refreshIndex > highlightIndex, 'the views refresh after the highlighter observes the close');
    assert.ok(closedTaskIndex > refreshIndex,
        'the closed-terminal evaluation runs inside the guarded lifecycle task');
    assert.equal(calls.some(call => call[0] === 'local-acknowledge' || call[0] === 'bridge-acknowledge'), false,
        'a process exit must not acknowledge unread attention');
    assert.equal(calls.some(call => call[0] === 'lifecycle-task' && call[1] === 'acknowledge-user-terminal-close'), false,
        'a process exit must not run the user-close acknowledgement task');
});

test('ATTENTION-USER-TERMINAL-CLOSE-001 a user close acknowledges locally, refreshes, then awaits the bridge', async () => {
    const runtime = makeRuntime({ backend: 'vscode' });
    const terminal = { name: 'closing', exitStatus: { code: undefined, reason: 3 } };
    runtime.terminal = terminal;
    const { capability, calls, listeners } = createFixture({ activeRuntimes: [runtime] });
    capability.startBridgeClient();
    capability.registerTerminalEventHandlers();
    listeners.closeTerminal(terminal);
    await flushAll();
    const closeIndex = indexOfCall(calls, 'runtime-close');
    const acknowledgeTaskIndex = calls.findIndex(call =>
        call[0] === 'lifecycle-task' && call[1] === 'acknowledge-user-terminal-close');
    const localAcknowledgeIndex = indexOfCall(calls, 'local-acknowledge');
    const refreshAfterAcknowledgeIndex = indexOfCall(calls, 'refresh', localAcknowledgeIndex);
    const bridgeAcknowledgeIndex = indexOfCall(calls, 'bridge-acknowledge');
    assert.ok(acknowledgeTaskIndex >= 0 && acknowledgeTaskIndex > closeIndex,
        'the acknowledgement runs inside the guarded lifecycle task');
    assert.deepEqual(calls[localAcknowledgeIndex][1], ['evt-1', 'evt-2'],
        'the acknowledgement dedupes the recovery session event ids');
    assert.ok(localAcknowledgeIndex > acknowledgeTaskIndex,
        'the acknowledgement follows the user close observation');
    assert.ok(refreshAfterAcknowledgeIndex > localAcknowledgeIndex,
        'the local refresh lands before the bridge await');
    assert.ok(bridgeAcknowledgeIndex > refreshAfterAcknowledgeIndex,
        'the cross-window bridge is awaited only after the local refresh');

    const empty = createFixture({ recoverySessionEvents: [] });
    empty.capability.startBridgeClient();
    await empty.capability.acknowledgeAttention({
        provider: 'codex', sessionId: 'unknown', workspaceScopeIdentity: 'scope-1',
    });
    assert.equal(empty.calls.some(call => call[0] === 'local-acknowledge'), false,
        'an empty event id list skips the acknowledgement entirely');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 the open terminal handler restores attach candidates and reports failures', async () => {
    const ignored = createFixture({ attachCandidate: false });
    ignored.capability.registerTerminalRestoreHandler();
    ignored.listeners.openTerminal({ name: 'plain' });
    await flushAll();
    assert.deepEqual(ignored.calls.filter(call => call[0] === 'is-attach-candidate').length, 1);
    assert.equal(ignored.calls.some(call => call[0] === 'restore-attach-terminals'), false,
        'non-candidate terminals skip the attach restore');

    const restored = createFixture({ attachCandidate: true });
    restored.capability.registerTerminalRestoreHandler();
    const candidate = { name: 'tmux-attach' };
    restored.listeners.openTerminal(candidate);
    await flushAll();
    assert.deepEqual(restored.calls.filter(call => call[0] === 'restore-attach-terminals'),
        [['restore-attach-terminals', [candidate]]]);
    assert.equal(restored.calls.some(call => call[0] === 'publish-restored-attach'), true,
        'a restored attach publishes the restored terminal');

    const failing = createFixture({ attachCandidate: true, restoreError: new Error('restore offline') });
    failing.capability.registerTerminalRestoreHandler();
    failing.listeners.openTerminal({ name: 'tmux-attach' });
    await flushAll();
    assert.ok(failing.calls.some(call =>
        call[0] === 'runtime-failure' && call[1] === 'restore-opened-tmux-attach-terminal'),
    'a restore failure keeps its diagnostic reason');
    assert.equal(failing.calls.some(call => call[0] === 'publish-restored-attach'), false);
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 the bridge client publishes, acknowledges, and schedules attention refreshes', async () => {
    const { capability, calls, listeners, bridgeClient } = createFixture({});
    capability.startBridgeClient();
    assert.equal(capability.bridgeClient, bridgeClient, 'the bridge client is exposed read-only');
    assert.deepEqual(calls.filter(call => call[0] === 'create-bridge-client').length, 1);

    await capability.publish([{ sessionKey: 'codex:session-a' }], true);
    assert.deepEqual(calls.filter(call => call[0] === 'bridge-publish'),
        [['bridge-publish', [{ sessionKey: 'codex:session-a' }], true]],
    'publishing delegates to the bridge client');

    const aggregate = { protocolVersion: 1, semanticRevision: 7, sessions: [] };
    listeners.bridgeAggregate(aggregate);
    assert.deepEqual(calls.filter(call => call[0] === 'set-remote-aggregate'),
        [['set-remote-aggregate', aggregate]]);
    assert.deepEqual(calls.filter(call => call[0] === 'schedule-refresh'),
        [['schedule-refresh', 'attention']],
    'a changed aggregate schedules the attention views refresh');
    assert.deepEqual(calls.filter(call => call[0] === 'post-open-workspaces').length, 1,
        'a changed aggregate updates the open workspaces view');

    const unchanged = createFixture({ remoteAggregateChanged: false });
    unchanged.capability.startBridgeClient();
    unchanged.listeners.bridgeAggregate(aggregate);
    assert.equal(unchanged.calls.some(call => call[0] === 'schedule-refresh'), false,
        'an unchanged aggregate skips the refresh');

    const error = new Error('bridge offline');
    listeners.bridgeError(error);
    assert.deepEqual(calls.filter(call => call[0] === 'log-error'),
        [['log-error', 'AI session attention bridge unavailable; using local-window monitoring.', error]]);

    capability.dispose();
    assert.deepEqual(calls.filter(call => call[0] === 'bridge-dispose').length, 1,
        'disposing the capability disposes the bridge client');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 runtime lookups resolve collision, live, and inactive runtimes', () => {
    const collisionIdentity = makeIdentity({ sessionId: 'collided' });
    const collisionFixture = createFixture({
        discoveryDiagnostics: [{ kind: 'tmux-locator-collision', identity: collisionIdentity }],
    });
    const collision = collisionFixture.capability.getRuntimeById('codex', 'collided');
    assert.equal(collision.state, 'conflict', 'a discovery collision wins over every other lookup');
    assert.equal(collision.backend, 'tmux');

    const liveRuntime = makeRuntime({ identity: makeIdentity({ sessionId: 'live' }) });
    const liveFixture = createFixture({ liveRuntime });
    assert.equal(liveFixture.capability.getRuntimeById('codex', 'live'), liveRuntime,
        'a live runtime resolves through the coordinator');

    const conflicted = makeRuntime({ identity: makeIdentity({ sessionId: 'duo' }) });
    const conflictFixture = createFixture({ activeRuntimes: [
        conflicted,
        makeRuntime({ identity: makeIdentity({ sessionId: 'duo' }) }),
    ] });
    const conflictSnapshot = conflictFixture.capability.getRuntimeById('codex', 'duo');
    assert.equal(conflictSnapshot.state, 'conflict', 'multiple live runtimes surface as a conflict');

    const inactive = makeRuntime({
        backend: 'tmux',
        identity: makeIdentity({ sessionId: 'inactive' }),
        tmux: { layout: 'session', sessionName: 'ap-x', windowName: 'w' },
    });
    const inactiveFixture = createFixture({ discoveryInactive: [inactive] });
    const inactiveSnapshot = inactiveFixture.capability.getRuntimeById('codex', 'inactive');
    assert.equal(inactiveSnapshot.backend, 'tmux');
    assert.equal('terminal' in inactiveSnapshot, false, 'inactive tmux snapshots detach the terminal');

    const completedTerminal = { name: 'completed' };
    const completedFixture = createFixture({ trackedEntries: [{
        provider: 'codex',
        sessionId: 'done',
        runtimeIdentity: makeIdentity({ sessionId: 'done' }),
        markerPath: '/markers/done',
        runStartedAtMs: 42,
        terminal: completedTerminal,
    }] });
    const completedSnapshot = completedFixture.capability.getRuntimeById('codex', 'done');
    assert.equal(completedSnapshot.state, 'completed');
    assert.equal(completedSnapshot.terminal, completedTerminal);

    const empty = createFixture({});
    assert.equal(empty.capability.getRuntimeById('codex', 'missing'), null);
    const noWorkspace = createFixture({ workspace: null });
    assert.equal(noWorkspace.capability.getRuntimeById('codex', 'live'), null,
        'lookups stay empty without a current workspace');

    assert.equal(empty.capability.belongsToCurrentWorkspace(makeRuntime()), true);
    assert.equal(empty.capability.belongsToCurrentWorkspace(
        makeRuntime({ identity: makeIdentity({ workspaceScopeIdentity: 'scope-elsewhere' }) })
    ), false);
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 attention state posts the recovery session events and event ids', () => {
    const { capability, calls } = createFixture({});
    capability.postAttentionState();
    assert.deepEqual(calls.filter(call => call[0] === 'post-message'), [['post-message', {
        type: 'ai-session-attention-state',
        sessionEvents: [{ sessionKey: 'codex:session-a', eventIds: ['evt-1', 'evt-1', 'evt-2'] }],
        eventIds: ['evt-1', 'evt-2'],
    }]]);
});
