'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeClock } = require('../../helpers/fakeClock');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');
const { buildAiSessionsUpdatedMessage } = loadFreshWithFakeVscode(
    '../../../out/dashboard/webviewUpdateMessages', {}, __dirname
);
const { AI_SESSION_PROVIDER_DEFINITIONS } = require('../../../out/aiSessions/providers');
const { AiSessionTerminalCommandController } = require('../../../out/aiSessions/terminalCommandController');
const { hydrateWorkspaceAiSessions } = require('../../../out/workspaces/sessionHydration');
const { getAttentionProjectKeys } = require('../../../out/aiSessions/attentionProject');
const { getAiSessionTerminalCandidates } = require('../../../out/aiSessions/terminalCandidates');
const ActiveAiSessionTerminalHighlighter = require('../../../out/aiSessions/activeTerminalHighlight').default;
const {
    projectWorkspaceActiveSessions,
} = require('../../../out/workspaces/activeSessionPresentation');

function makeProjection(revision, eventIds = []) {
    return {
        revision,
        presentation: {
            workspaceScopeIdentity: 'scope:app',
            workspaceNavigationIdentity: 'navigation:app',
            attentionCount: eventIds.length ? 1 : 0,
            activeAttentionCount: eventIds.length ? 1 : 0,
            runningSessionCount: 0,
            focusedTarget: { provider: 'codex', sessionId: 'session-a' },
            attentionSessions: eventIds.length
                ? [{ sessionKey: 'codex:session-a', eventIds }]
                : [],
            sessions: [{
                provider: 'codex', sessionId: 'session-a',
                executionState: 'stopped', focused: true,
                needsAttention: eventIds.length > 0, conflict: false, eventIds,
            }],
        },
    };
}

test('PROJECT-TERMINAL-CANDIDATE-001 reads provider sessions through the terminal-candidate cache reason', () => {
    const sessions = [{ id: 'candidate', name: 'Candidate' }];
    const calls = [];
    const result = getAiSessionTerminalCandidates('kimi', {
        getProviderResult(providerId, options) {
            calls.push({ providerId, options });
            return { available: true, sessions, scannedFiles: 1, parsedFiles: 1 };
        },
    });

    assert.equal(result, sessions);
    assert.deepEqual(calls, [{ providerId: 'kimi', options: { reason: 'terminal-candidates' } }]);
});

test('PROJECT-ACTIVE-AI-SESSION-PROJECTION-001 OPEN-OPEN-PROJECT-AI-SESSION-VIEW-MODEL-BUILDER-001 RUNTIME-RUNTIME-PROJECTION-001 projects Direct, tmux, pending, attention, conflict, and stale runtime state', () => {
    const workspace = {
        navigationIdentity: 'navigation:app',
        scopeIdentity: 'scope:app',
        kind: 'singleFolder',
        displayName: 'App',
        navigationUri: 'file:///fixtures/app',
        environment: 'local',
        roots: [{
            id: 'root:app',
            name: 'app',
            uri: 'file:///fixtures/app',
            hostPath: '/fixtures/app',
            ordinal: 0,
        }],
    };
    const runtimeIdentity = (provider, id, pending = false) => ({
        provider,
        workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceRootHostPaths: ['/fixtures/app'],
        cwd: '/fixtures/app',
        ...(pending ? { pendingId: id } : { sessionId: id }),
    });
    const projected = hydrateWorkspaceAiSessions({
        workspace,
        providers: Object.values(AI_SESSION_PROVIDER_DEFINITIONS),
        sessionResults: {
            codex: {
                available: true,
                sessions: [{ id: 'direct', name: 'Direct', cwd: '/fixtures/app' }],
            },
            kimi: {
                available: true,
                sessions: [{ id: 'tmux', name: 'Tmux', cwd: '/fixtures/app' }],
            },
            claude: { available: true, sessions: [] },
        },
        getSessionComparableCwd: (_provider, session) => session.cwd,
        pinnedSessions: new Set(),
        aliases: {},
        activeRuntimes: [{
            identity: runtimeIdentity('codex', 'direct'),
            backend: 'vscode', state: 'active', markerPath: '/tmp/direct.done',
            runStartedAtMs: 10, attached: true,
        }, {
            identity: runtimeIdentity('kimi', 'tmux'),
            backend: 'tmux', state: 'conflict', markerPath: '/tmp/tmux.done',
            runStartedAtMs: 20, attached: false, stale: true,
            tmux: { layout: 'project', sessionName: 'managed', windowName: 'ai-kimi-tmux' },
        }],
        pendingRuntimes: [{
            identity: runtimeIdentity('claude', 'pending', true),
            backend: 'tmux', state: 'pending', markerPath: '/tmp/pending.done',
            runStartedAtMs: 30, attached: false, createdAt: '2026-07-18T10:00:00.000Z',
            excludedSessionIds: [], tmux: { layout: 'session', sessionName: 'pending-managed' },
        }],
        executionSnapshot: {
            'codex:direct': { state: 'running', stateChangedAt: 100 },
            'kimi:tmux': { state: 'stopped', stateChangedAt: 200 },
        },
        focusedIdentity: runtimeIdentity('codex', 'direct'),
        attentionAggregate: {
            protocolVersion: 1,
            aggregateRevision: 'a'.repeat(64),
            generatedAtMs: 1,
            sessions: [{
                projectId: getAttentionProjectKeys(['file:///fixtures/app'])[0],
                sessionKey: 'kimi:tmux',
                reasons: ['input-required'],
                eventIds: ['attention'],
                observedAtMs: 1,
            }, {
                projectId: getAttentionProjectKeys(['file:///fixtures/app'])[0],
                sessionKey: 'codex:direct',
                reasons: ['completed'],
                eventIds: ['stale-running-attention'],
                observedAtMs: 1,
            }],
        },
    });

    assert.deepEqual(projected.activeSessions.map(runtime => ({
        provider: runtime.provider,
        backend: runtime.backend,
        executionState: runtime.executionState,
        focused: runtime.focused,
        needsAttention: runtime.needsAttention,
        attached: runtime.attached,
        conflict: runtime.conflict || false,
        stale: runtime.stale || false,
    })), [{
        provider: 'kimi', backend: 'tmux', executionState: 'stopped', focused: false,
        needsAttention: true, attached: false,
        conflict: true, stale: true,
    }, {
        provider: 'codex', backend: 'vscode', executionState: 'running', focused: true,
        needsAttention: false, attached: true,
        conflict: false, stale: false,
    }, {
        provider: 'claude', backend: 'tmux', executionState: 'starting', focused: false,
        needsAttention: false, attached: false,
        conflict: false, stale: false,
    }]);
    assert.equal(projected.attentionCount, 1,
        'a running Active Session suppresses its stale Attention from the card summary too');
    assert.equal(projected.sessionsByProvider.codex[0].active, true);
    assert.equal(projected.sessionsByProvider.kimi[0].attention.eventId, 'attention');
});

test('PROJECT-ACTIVE-AI-SESSION-PROJECTION-001 projects pending focus as an authoritative target', () => {
    const workspace = {
        navigationIdentity: 'navigation:pending-focus',
        scopeIdentity: 'scope:pending-focus',
        kind: 'singleFolder',
        displayName: 'Pending Focus',
        navigationUri: 'file:///fixtures/pending-focus',
        environment: 'local',
        roots: [{
            id: 'root:pending-focus',
            name: 'pending-focus',
            uri: 'file:///fixtures/pending-focus',
            hostPath: '/fixtures/pending-focus',
            ordinal: 0,
        }],
    };
    const identity = {
        provider: 'codex',
        workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceRootHostPaths: ['/fixtures/pending-focus'],
        cwd: '/fixtures/pending-focus',
        pendingId: 'pending-focus-one',
    };

    const presentation = projectWorkspaceActiveSessions({
        workspace,
        activeRuntimes: [],
        pendingRuntimes: [{
            identity,
            backend: 'tmux',
            state: 'pending',
            markerPath: '/tmp/pending-focus.done',
            runStartedAtMs: 30,
            attached: true,
            createdAt: '2026-08-10T00:00:00.000Z',
            excludedSessionIds: [],
            tmux: { layout: 'project', sessionName: 'pending-focus' },
        }],
        executionSnapshot: {},
        focusedIdentity: identity,
        attentionAggregate: null,
    });

    assert.deepEqual(presentation.focusedTarget, {
        provider: 'codex',
        pendingId: 'pending-focus-one',
    });
});

test('PROJECT-ACTIVE-AI-SESSION-PROJECTION-001 keeps active session cards stable when terminal focus changes', () => {
    const workspace = {
        navigationIdentity: 'navigation:stable',
        scopeIdentity: 'scope:stable',
        kind: 'singleFolder',
        displayName: 'Stable',
        navigationUri: 'file:///fixtures/stable',
        environment: 'local',
        roots: [{
            id: 'root:stable',
            name: 'stable',
            uri: 'file:///fixtures/stable',
            hostPath: '/fixtures/stable',
            ordinal: 0,
        }],
    };
    const runtimeIdentity = sessionId => ({
        provider: 'codex',
        sessionId,
        workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceRootHostPaths: ['/fixtures/stable'],
        cwd: '/fixtures/stable',
    });
    const activeRuntimes = [{
        identity: runtimeIdentity('older'),
        backend: 'vscode',
        state: 'active',
        markerPath: '/tmp/older.done',
        runStartedAtMs: 100,
        attached: true,
    }, {
        identity: runtimeIdentity('newer'),
        backend: 'vscode',
        state: 'active',
        markerPath: '/tmp/newer.done',
        runStartedAtMs: 200,
        attached: true,
    }];
    const hydrate = (focusedSessionId, olderUpdatedAt) => hydrateWorkspaceAiSessions({
        workspace,
        providers: Object.values(AI_SESSION_PROVIDER_DEFINITIONS),
        sessionResults: {
            codex: {
                available: true,
                sessions: [{
                    id: 'older',
                    name: 'Older',
                    cwd: '/fixtures/stable',
                    updatedAt: olderUpdatedAt,
                }, {
                    id: 'newer',
                    name: 'Newer',
                    cwd: '/fixtures/stable',
                    updatedAt: '2026-07-24T09:00:00.000Z',
                }],
            },
            kimi: { available: true, sessions: [] },
            claude: { available: true, sessions: [] },
        },
        getSessionComparableCwd: (_provider, session) => session.cwd,
        pinnedSessions: new Set(),
        aliases: {},
        activeRuntimes,
        focusedIdentity: runtimeIdentity(focusedSessionId),
    });

    const before = hydrate('newer', '2026-07-24T08:00:00.000Z');
    const after = hydrate('older', '2026-07-24T10:00:00.000Z');

    assert.deepEqual(before.activeSessions.map(session => session.sessionId), ['newer', 'older']);
    assert.deepEqual(after.activeSessions.map(session => session.sessionId), ['newer', 'older']);
    assert.equal(after.activeSessions.find(session => session.sessionId === 'older').focused, true);
});

test('RUNTIME-WORKSPACE-TOPOLOGY-CONTINUITY-001 keeps a projected Active Session actionable after workspace roots change', async () => {
    const workspace = {
        navigationIdentity: 'navigation:reddb-dev',
        scopeIdentity: 'scope:five-roots',
        kind: 'savedMultiRoot',
        displayName: 'reddb-dev',
        navigationUri: 'file:///work/reddb-dev.code-workspace',
        environment: 'local',
        roots: [{
            id: 'root:existing', name: 'existing', uri: 'file:///work/existing',
            hostPath: '/work/existing', ordinal: 0,
        }, {
            id: 'root:added', name: 'added', uri: 'file:///work/added',
            hostPath: '/work/added', ordinal: 1,
        }],
    };
    const runtime = {
        identity: {
            provider: 'codex',
            sessionId: 'still-active',
            workspaceScopeIdentity: 'scope:three-roots',
            workspaceNavigationIdentity: workspace.navigationIdentity,
            workspaceRootHostPaths: ['/work/existing'],
            cwd: '/work/existing',
        },
        backend: 'tmux', state: 'active', markerPath: '/tmp/still-active.done',
        runStartedAtMs: 10, attached: true,
        tmux: { layout: 'project', sessionName: 'reddb-dev', windowName: 'still-active' },
    };
    const projected = hydrateWorkspaceAiSessions({
        workspace,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionResults: {
            codex: { available: true, sessions: [{
                id: 'still-active', name: 'Still active', cwd: '/work/existing',
            }] },
        },
        getSessionComparableCwd: (_provider, session) => session.cwd,
        pinnedSessions: new Set(), aliases: {}, activeRuntimes: [runtime],
    });
    assert.equal(projected.activeSessions.length, 1,
        'the navigation identity keeps the runtime visible after the scope changes');

    const focused = [];
    const detached = [];
    let activeRuntimes = [runtime];
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: projectId => projectId === 'current-card' ? {
            cardId: projectId,
            workspace,
            sessions: projected,
        } : null,
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'Codex',
        refresh: () => undefined,
        runtimeCoordinator: {
            getById: (provider, sessionId, scopeIdentity) => activeRuntimes.find(candidate =>
                candidate.identity.provider === provider
                && candidate.identity.sessionId === sessionId
                && candidate.identity.workspaceScopeIdentity === scopeIdentity) || null,
            getActive: () => activeRuntimes,
            getPending: () => [],
            focus: async identity => focused.push(identity),
            detach: async identity => detached.push(identity),
            terminate: async () => undefined,
        },
        confirmRuntimeClose: async (_message, action) => action,
        announceStatus: async () => undefined,
    });

    assert.equal(await controller.focusActive('current-card', 'codex', 'still-active'), true);
    assert.deepEqual(focused, [runtime.identity],
        'the action must use the surviving runtime identity instead of the new workspace scope');

    activeRuntimes = [runtime, {
        ...runtime,
        identity: {
            ...runtime.identity,
            workspaceScopeIdentity: workspace.scopeIdentity,
            workspaceRootHostPaths: workspace.roots.map(root => root.hostPath),
        },
        runStartedAtMs: 20,
    }];
    await controller.closeTerminal({
        projectId: 'current-card', providerId: 'codex', sessionId: 'still-active',
    });
    assert.deepEqual(detached, [],
        'an ambiguous pre-change and post-change runtime must fail closed');
});

test('WEBVIEW-AI-SESSION-DASHBOARD-WATCHER-COALESCING-001 coalesces watcher refreshes and preserves attention refresh priority', async () => {
    const clock = createFakeClock(1000);
    const messages = [];
    const reasons = [];
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [], getCards: () => [],
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        beginProjection: reason => {
            reasons.push(reason);
            return { revision: messages.length + 1 };
        },
        buildAiSessionsUpdatedMessage,
        postMessage: message => { messages.push(message); return Promise.resolve(true); },
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        afterRefresh: () => undefined,
        nowMs: () => clock.nowMs,
        debounceMs: 100,
        watcherRefreshMinIntervalMs: 1000,
        newSessionRefreshDelaysMs: [],
        setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
        clearTimeout: handle => clock.clearTimeout(handle),
    });

    controller.scheduleRefresh('watcher');
    clock.advanceBy(100);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, ['watcher']);
    assert.equal(messages.length, 1);

    clock.advanceBy(100);
    controller.scheduleRefresh('watcher');
    controller.scheduleRefresh('watcher');
    clock.advanceBy(900);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, ['watcher', 'watcher']);
    assert.equal(messages.length, 1, 'unchanged watcher snapshots are built once but not posted twice');

    controller.scheduleRefresh('attention');
    clock.advanceBy(100);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, ['watcher', 'watcher', 'attention']);
});

test('ACTIVE-SESSION-PRESENTATION-TRANSACTION-001 builds cards and HTML with one projection revision', () => {
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    const projection = {
        ...makeProjection(17),
        marker: 'same-transaction',
    };
    let cardsProjection = null;
    let completed = 0;
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [],
        getCards: value => { cardsProjection = value; return []; },
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        beginProjection: reason => {
            assert.equal(reason, 'transaction-test');
            return projection;
        },
        buildAiSessionsUpdatedMessage,
        postMessage: () => Promise.resolve(true),
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        afterRefresh: () => { completed += 1; },
        debounceMs: 1,
        newSessionRefreshDelaysMs: [],
        setTimeout: () => ({}),
        clearTimeout: () => undefined,
    });

    const message = controller.getUpdatedMessage('transaction-test');
    assert.equal(cardsProjection, projection);
    assert.equal(message.sequence, projection.revision);
    assert.equal(message.projectionRevision, projection.revision);
    assert.equal(message.presentation.projectionRevision, projection.revision);
    assert.equal(message.version, 3);
    assert.equal(completed, 1);
});

test('ACTIVE-SESSION-INCREMENTAL-PRESENTATION-ENVELOPE-001 posts changed owner events even when rendered HTML is unchanged', async () => {
    const deliveries = [];
    let projection = makeProjection(1, ['event-a']);
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'], isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [], getCards: () => [],
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        beginProjection: () => projection,
        buildAiSessionsUpdatedMessage,
        postMessage: message => { deliveries.push(message); return Promise.resolve(true); },
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        debounceMs: 1, newSessionRefreshDelaysMs: [],
        setTimeout: callback => { callback(); return {}; }, clearTimeout: () => undefined,
    });

    await controller.refreshNow('attention');
    projection = makeProjection(2, ['event-a', 'event-b']);
    await controller.refreshNow('attention');

    assert.equal(deliveries.length, 2);
    assert.deepEqual(
        deliveries[1].presentation.attentionSessions[0].eventIds,
        ['event-a', 'event-b']
    );
});

test('WEBVIEW-SIDEBAR-VISIBILITY-RETENTION-001 reuses provider watchers across rapid sidebar visibility changes', () => {
    const clock = createFakeClock(1000);
    let visible = true;
    let watcherStarts = 0;
    let watcherDisposals = 0;
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    const controller = new AiSessionDashboardController({
        providerIds: ['codex', 'kimi', 'claude'],
        isVisible: () => visible,
        invalidateCache: () => undefined,
        watchSessionChanges: () => {
            watcherStarts += 1;
            return { dispose: () => { watcherDisposals += 1; } };
        },
        getGroups: () => [], getCards: () => [],
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        beginProjection: () => ({ revision: 1 }),
        buildAiSessionsUpdatedMessage,
        postMessage: () => Promise.resolve(true),
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        debounceMs: 100,
        watcherStopGraceMs: 5000,
        newSessionRefreshDelaysMs: [],
        setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
        clearTimeout: handle => clock.clearTimeout(handle),
    });

    controller.setWatchersActive(true);
    for (let iteration = 0; iteration < 15; iteration += 1) {
        visible = false;
        controller.setWatchersActive(false);
        clock.advanceBy(100);
        visible = true;
        controller.setWatchersActive(true);
    }

    assert.equal(watcherStarts, 3, 'each provider watcher must be created only once');
    assert.equal(watcherDisposals, 0, 'brief hidden epochs must keep the watchers reusable');

    visible = false;
    controller.setWatchersActive(false);
    clock.advanceBy(4999);
    assert.equal(watcherDisposals, 0, 'watchers stay alive throughout the visibility grace period');
    clock.advanceBy(1);
    assert.equal(watcherDisposals, 3, 'a genuinely hidden dashboard eventually releases every watcher');
    controller.dispose();
});

test('WEBVIEW-AI-SESSION-DASHBOARD-WATCHER-COALESCING-001 never postpones a pending status refresh behind later watcher events', async () => {
    const clock = createFakeClock(1000);
    const reasons = [];
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    let cardRevision = 0;
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [],
        // A live session keeps mutating, so no refresh is ever skipped as unchanged.
        getCards: () => { cardRevision += 1; return []; },
        getRunningCardAnimation: () => `revision-${cardRevision}`,
        getRunningIconAnimation: () => undefined,
        beginProjection: reason => {
            reasons.push({ reason, atMs: clock.nowMs });
            return { revision: reasons.length + 1 };
        },
        buildAiSessionsUpdatedMessage,
        postMessage: () => Promise.resolve(true),
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        afterRefresh: () => undefined,
        nowMs: () => clock.nowMs,
        debounceMs: 100,
        watcherRefreshMinIntervalMs: 1000,
        newSessionRefreshDelaysMs: [],
        setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
        clearTimeout: handle => clock.clearTimeout(handle),
    });

    // Establish lastWatcherRefreshAtMs, exactly as a live session does.
    controller.scheduleRefresh('watcher');
    clock.advanceBy(100);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reasons.length, 1);

    // The execution monitor observes a state change and asks for a prompt repaint.
    const requestedAtMs = clock.nowMs;
    controller.scheduleRefresh('execution');

    // The provider JSONL poller keeps firing while the session streams output.
    // Each watcher event must not push the pending execution refresh further out.
    for (let index = 0; index < 4; index += 1) {
        clock.advanceBy(90);
        controller.scheduleRefresh('watcher');
        await new Promise(resolve => setImmediate(resolve));
    }
    clock.advanceBy(1000);
    await new Promise(resolve => setImmediate(resolve));

    const settled = reasons.find(entry => entry.atMs > requestedAtMs);
    assert.ok(settled, 'the pending status refresh must eventually run');
    assert.equal(
        settled.atMs - requestedAtMs,
        100,
        'a status refresh must land on its own debounce deadline, not the watcher interval'
    );
    assert.equal(
        settled.reason,
        'execution',
        'a coalesced status refresh must keep the urgent reason instead of being downgraded'
    );
});

test('WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001 invalidates and refreshes for every new-session delay', async () => {
    const invalidated = [];
    const messages = [];
    const reasons = [];
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'], isVisible: () => true,
        invalidateCache: providerId => invalidated.push(providerId),
        watchSessionChanges: () => ({ dispose() {} }), getGroups: () => [],
        getCards: () => [],
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        beginProjection: reason => {
            reasons.push(reason);
            return { revision: messages.length + 1 };
        },
        buildAiSessionsUpdatedMessage,
        postMessage: message => { messages.push(message); return Promise.resolve(true); },
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        debounceMs: 1,
        newSessionRefreshDelaysMs: [1, 2],
        setTimeout: callback => { callback(); return {}; },
        clearTimeout: () => undefined,
    });

    controller.scheduleNewSessionRefresh('codex');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(invalidated, ['codex', 'codex']);
    assert.deepEqual(reasons, ['new-session', 'new-session']);
    // Both delays still invalidate and rebuild, but the second build is
    // byte-identical to the first, so it is skipped instead of posting a
    // redundant replacement (skip now applies to every refresh reason).
    assert.deepEqual(messages.map(message => message.type), [
        'ai-sessions-updated',
    ]);
    controller.dispose();
});

test('WEBVIEW-AI-SESSION-DASHBOARD-UNCHANGED-MESSAGE-SKIP-001 retries an unchanged message after delivery failure', async () => {
    const diagnostics = [];
    const deliveries = [];
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    let delivered = false;
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'], isVisible: () => true, invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }), getGroups: () => [],
        getCards: () => [],
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        beginProjection: () => ({ revision: deliveries.length + 1 }),
        buildAiSessionsUpdatedMessage,
        postMessage: message => { deliveries.push(message); return Promise.resolve(delivered); },
        refresh: () => undefined,
        logError: (_message, error) => { throw error; },
        logDiagnostic: event => diagnostics.push(event),
        debounceMs: 1, newSessionRefreshDelaysMs: [],
        setTimeout: callback => { callback(); return {}; }, clearTimeout: () => undefined,
    });

    await controller.refreshNow('watcher');
    await new Promise(resolve => setImmediate(resolve));
    delivered = true;
    await controller.refreshNow('watcher');
    await controller.refreshNow('watcher');
    assert.equal(deliveries.length, 2);
    assert.ok(diagnostics.some(event => event.event === 'ai-session-message-skip'));
});

test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 keeps dashboard-visible delivery failures incremental-only', async () => {
    const refreshes = [];
    const logs = [];
    let failureMode = 'undelivered';
    const { AiSessionDashboardController } = loadFreshWithFakeVscode(
        '../../../out/aiSessions/dashboardController', {}, __dirname
    );
    const controller = new AiSessionDashboardController({
        providerIds: ['codex'],
        isVisible: () => true,
        invalidateCache: () => undefined,
        watchSessionChanges: () => ({ dispose() {} }),
        getGroups: () => [],
        getCards: () => {
            if (failureMode === 'build') {
                throw new Error('build failed');
            }
            return [];
        },
        getRunningCardAnimation: () => undefined,
        getRunningIconAnimation: () => undefined,
        beginProjection: () => ({ revision: 1 }),
        buildAiSessionsUpdatedMessage,
        postMessage: () => failureMode === 'rejected'
            ? Promise.reject(new Error('delivery failed'))
            : Promise.resolve(false),
        refresh: reason => refreshes.push(reason),
        logError: (message, error) => logs.push([message, error.message]),
        debounceMs: 1,
        newSessionRefreshDelaysMs: [],
        setTimeout: callback => { callback(); return {}; },
        clearTimeout: () => undefined,
    });

    for (const mode of ['undelivered', 'rejected', 'build']) {
        failureMode = mode;
        await controller.refreshNow('dashboard-visible', {
            fallbackToFullRefresh: false,
        });
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.deepEqual(refreshes, []);
    assert.deepEqual(logs, [
        ['Failed to post AI session update message.', 'delivery failed'],
        ['Failed to update AI sessions incrementally.', 'build failed'],
    ]);
});

test('WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 ATTENTION-AI-SESSION-ATTENTION-CONTROLLER-001 terminal close clears focus without publishing completion', () => {
    const terminal = { name: 'fixture terminal' };
    let activeTerminal = terminal;
    let complete = false;
    let completionCount = 0;
    const publications = [];
    const timers = [];
    const highlighter = new ActiveAiSessionTerminalHighlighter({
        isVisible: () => true,
        getActiveTerminal: () => activeTerminal,
        resolveTerminal: value => value === terminal
            ? {
                terminal,
                provider: 'codex',
                sessionId: 'session',
                workspaceScopeIdentity: 'scope:fixture',
                entry: { markerPath: '/tmp/marker' },
            }
            : null,
        isComplete: () => complete,
        publish: identity => publications.push(identity),
        onComplete: () => { completionCount += 1; },
        setInterval: callback => { const handle = { callback, active: true }; timers.push(handle); return handle; },
        clearInterval: handle => { handle.active = false; },
    });

    highlighter.sync();
    assert.deepEqual(publications.pop(), {
        provider: 'codex',
        sessionId: 'session',
        workspaceScopeIdentity: 'scope:fixture',
    });
    highlighter.handleTerminalClosed(terminal);
    assert.equal(publications.pop(), null);
    assert.equal(completionCount, 0);

    activeTerminal = terminal;
    highlighter.sync();
    complete = true;
    timers.find(timer => timer.active).callback();
    assert.equal(completionCount, 1);
    assert.equal(publications.pop(), null);
});
