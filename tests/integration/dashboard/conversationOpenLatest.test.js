'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function fakeUri(value) {
    return {
        scheme: value.split(':', 1)[0],
        path: value,
        fsPath: value,
        toString: () => value,
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(next => {
        resolve = next;
    });
    return { promise, resolve };
}

function loadConversationComposition() {
    const fakeVscode = {
        ViewColumn: { Beside: 2 },
        Uri: {
            file: value => fakeUri(`file://${value}`),
            parse: value => fakeUri(value),
        },
        commands: {
            async executeCommand() {},
        },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/aiSessions/conversation/composition');
    } finally {
        Module._load = previousLoad;
    }
}

const {
    createConversationCapability,
} = loadConversationComposition();
const {
    ConversationPanelRestoreCoordinator,
} = require('../../../out/aiSessions/conversation/panelRestoreCoordinator');

function makeService(provider) {
    return {
        getSessions: () => ({
            available: true,
            sessions: [],
            scannedFiles: 0,
            parsedFiles: 0,
        }),
        getLifecycleSignals: () => ({}),
        watchSessionChanges: () => ({ dispose() {} }),
        archiveSession: () => false,
        invalidateCache() {},
        resolveConversationSource: () => null,
        provider,
    };
}

function makeOutline(provider, sessionId, interactionIds) {
    return {
        provider,
        sessionId,
        sourceRevision: 'native-1',
        interactions: interactionIds.map(id => ({
            id,
            userPreview: id,
            userGraphemeCount: id.length,
            responseState: 'complete',
        })),
        totalInteractions: interactionIds.length,
        partial: false,
    };
}

function makeSession(overrides = {}) {
    return {
        key: 'codex:session-a',
        provider: 'codex',
        sessionId: 'session-a',
        name: 'Focused session',
        executionState: 'stopped',
        status: 'focused',
        focused: true,
        needsAttention: false,
        pending: false,
        backend: 'vscode',
        attached: true,
        ...overrides,
    };
}

function createHarness(options = {}) {
    const viewerTargets = [];
    const followedViewerTargets = [];
    const restoredViewerTargets = [];
    let capturedViewerOptions;
    let outlineReads = 0;
    const session = 'session' in options ? options.session : makeSession({
        conversationDisplayName: options.conversationDisplayName,
        duplicateConversationDisplayName:
            options.duplicateConversationDisplayName,
    });
    const fakeAdapter = provider => () => ({
        async readOutline(sessionId) {
            outlineReads += 1;
            if (options.readOutline) {
                return options.readOutline(provider, sessionId);
            }
            if (options.readOutlineError) {
                throw options.readOutlineError;
            }
            return makeOutline(
                provider,
                sessionId,
                options.interactionIds || ['input-a', 'input-b']
            );
        },
        async readPage() {
            throw new Error('readPage is not used by openLatestConversation');
        },
        watch() {
            return { dispose() {} };
        },
        dispose() {},
    });
    const capability = createConversationCapability({
        services: {
            codex: makeService('codex'),
            kimi: makeService('kimi'),
            claude: makeService('claude'),
        },
        resolveTarget: options.resolveTarget || (() => session),
        resolveActiveTargets: options.resolveActiveTargets
            || (() => (session ? [session] : [])),
        focusSession: options.focusSession,
        publish: async () => true,
        createPanel: () => {
            throw new Error('createPanel is not used by openLatestConversation');
        },
        openExternal: async () => true,
        spawnCodex: () => {
            throw new Error('spawnCodex is not used by openLatestConversation');
        },
        now: () => Date.now(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => clearTimeout(handle),
        onDiagnostic: () => {},
        resolveReboundTarget: options.resolveReboundTarget,
    }, {
        createCodexClient: options.createCodexClient || (() => ({ dispose() {} })),
        createCodexAdapter: fakeAdapter('codex'),
        createKimiAdapter: fakeAdapter('kimi'),
        createClaudeAdapter: fakeAdapter('claude'),
        createViewer: viewerOptions => {
            capturedViewerOptions = viewerOptions;
            return {
                isOpen: () => options.viewerOpen === true,
                open: async target => {
                    viewerTargets.push(target);
                },
                restore: async (panel, target) => {
                    restoredViewerTargets.push({ panel, target });
                },
                follow: async target => {
                    followedViewerTargets.push(target);
                    return true;
                },
                rebindSession: async () => false,
                freezeSessionMetadata: async () => false,
                refresh: async () => undefined,
                reconcileAuthority: async () => undefined,
                dispose() {},
            };
        },
    });
    return {
        capability,
        viewerTargets,
        followedViewerTargets,
        restoredViewerTargets,
        get viewerOptions() {
            return capturedViewerOptions;
        },
        get outlineReads() {
            return outlineReads;
        },
    };
}

test('CONVERSATION-OPEN-LATEST-001 opens the latest interaction of the resolved session', async () => {
    const { capability, viewerTargets } = createHarness();
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'opened');
    assert.deepEqual(viewerTargets, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-b',
        expectedRevision: 'r1',
        displayName: 'Focused session',
        duplicateDisplayName: false,
    }]);
    capability.dispose();
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 dashboard registers a serializer that restores AI Conversation panels', () => {
    const dashboardSource = fs.readFileSync(
        path.join(__dirname, '../../../src/dashboard.ts'),
        'utf8'
    );
    assert.match(
        dashboardSource,
        /registerWebviewPanelSerializer\([\s\S]*AGENT_PIVOT_CONVERSATION_VIEW_TYPE[\s\S]*deserializeWebviewPanel[\s\S]*conversationPanelRestore\.restorePanel\(/
    );
    assert.ok(
        dashboardSource.indexOf('registerWebviewPanelSerializer(')
            < dashboardSource.indexOf('bootstrapController.start()'),
        'the serializer must be registered before activation returns'
    );
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 queues retained panels until the asynchronous dashboard capability is ready', async () => {
    const coordinator = new ConversationPanelRestoreCoordinator();
    const runtimeAuthority = deferred();
    const restored = [];
    let disposed = false;
    const panel = {
        webview: { html: 'stale transcript' },
        dispose() { disposed = true; },
    };
    let settled = false;
    const restoration = coordinator.restorePanel(panel, { saved: true })
        .then(() => { settled = true; });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.match(panel.webview.html, /Restoring conversation/);

    const connection = coordinator.connectWhenReady({
        async restorePanel(restoredPanel, state) {
            restored.push({ restoredPanel, state });
        },
    }, runtimeAuthority.promise);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restored.length, 0, 'runtime authority must settle first');

    runtimeAuthority.resolve();
    await restoration;
    assert.equal(disposed, false);
    assert.deepEqual(restored, [{ restoredPanel: panel, state: { saved: true } }]);

    connection.dispose();
    coordinator.dispose();
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 waits for direct and tmux runtime restoration before resolving panel authority', () => {
    const dashboardSource = fs.readFileSync(
        path.join(__dirname, '../../../src/dashboard.ts'),
        'utf8'
    );
    assert.match(
        dashboardSource,
        /conversationPanelRestore\.connectWhenReady\([\s\S]*Promise\.all\(\[[\s\S]*directTerminalRestoreOutcomeTask[\s\S]*tmuxRestoreTask/
    );
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 restores only an authoritative serialized target at its saved interaction', async () => {
    const harness = createHarness();
    const panel = { dispose() { throw new Error('must not dispose'); } };

    await harness.capability.restorePanel(panel, {
        conversationSidebar: { open: true },
        conversationViewer: {
            version: 1,
            target: {
                projectId: 'project-a',
                provider: 'codex',
                sessionId: 'session-a',
                interactionId: 'input-a',
            },
        },
    });

    assert.equal(harness.restoredViewerTargets.length, 1);
    assert.equal(harness.restoredViewerTargets[0].panel, panel);
    assert.deepEqual(harness.restoredViewerTargets[0].target, {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-a',
        expectedRevision: 'r1',
        displayName: 'Focused session',
        duplicateDisplayName: false,
    });
    harness.capability.dispose();
});

test('CONVERSATION-SESSION-REBIND-001 restores an old serialized target through the explicit rebound Session', async () => {
    const harness = createHarness({
        resolveTarget: (_projectId, _provider, sessionId) =>
            sessionId === 'new-root'
                ? makeSession({ id: 'new-root', sessionId: 'new-root' })
                : null,
        resolveReboundTarget: target => target.sessionId === 'old-root'
            ? { ...target, sessionId: 'new-root' }
            : target,
    });
    const panel = { dispose() { throw new Error('must not dispose'); } };

    await harness.capability.restorePanel(panel, {
        conversationViewer: {
            version: 1,
            target: {
                projectId: 'project-a',
                provider: 'codex',
                sessionId: 'old-root',
                interactionId: 'input-a',
                subagentId: 'old-root-subagent',
            },
        },
    });

    assert.equal(harness.restoredViewerTargets.length, 1);
    assert.equal(harness.restoredViewerTargets[0].target.sessionId, 'new-root');
    assert.equal(
        harness.restoredViewerTargets[0].target.subagent,
        undefined,
        'a subagent from the old root must not be resolved in the new root'
    );
    assert.equal(await harness.capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    }), 'unknownSession', 'an explicit historical open must not be redirected');
    harness.capability.dispose();
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 closes a retained panel with invalid or stale restore authority', async () => {
    let disposeCount = 0;
    const panel = { dispose() { disposeCount += 1; } };
    const invalidHarness = createHarness();
    await invalidHarness.capability.restorePanel(panel, {
        conversationViewer: {
            version: 1,
            target: {
                projectId: 'project-a',
                provider: 'codex',
                sessionId: 'session-a',
            },
        },
    });
    invalidHarness.capability.dispose();

    const staleHarness = createHarness({ session: null });
    await staleHarness.capability.restorePanel(panel, {
        conversationViewer: {
            version: 1,
            target: {
                projectId: 'project-a',
                provider: 'codex',
                sessionId: 'session-a',
                interactionId: 'input-a',
            },
        },
    });
    staleHarness.capability.dispose();

    assert.equal(disposeCount, 2);
});

test('CONVERSATION-OPEN-LATEST-001 prefers conversation display metadata for the viewer target', async () => {
    const { capability, viewerTargets } = createHarness({
        conversationDisplayName: 'Renamed session',
        duplicateConversationDisplayName: true,
    });
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'opened');
    assert.equal(viewerTargets.length, 1);
    assert.equal(viewerTargets[0].displayName, 'Renamed session');
    assert.equal(viewerTargets[0].duplicateDisplayName, true);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 reports empty when the conversation has no interactions', async () => {
    const { capability, viewerTargets } = createHarness({ interactionIds: [] });
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'empty');
    assert.deepEqual(viewerTargets, []);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 reports unavailable when the outline cannot be read', async () => {
    const { capability, viewerTargets } = createHarness({
        readOutlineError: new Error('boom'),
    });
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'unavailable');
    assert.deepEqual(viewerTargets, []);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 reports unknownSession when the target is not authoritative', async () => {
    const { capability, viewerTargets } = createHarness({ session: null });
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'unknownSession');
    assert.deepEqual(viewerTargets, []);
    capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 unavailable capability rejects openLatestConversation', async () => {
    const { capability, viewerTargets } = createHarness({
        createCodexClient: () => {
            throw new Error('construction failed');
        },
    });
    assert.equal(capability.availability, 'unavailable');
    const result = await capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'unavailable');
    assert.deepEqual(viewerTargets, []);
    capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 follows the latest interaction only while AI Conversation is already open', async () => {
    const openHarness = createHarness({ viewerOpen: true });
    assert.equal(await openHarness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'opened');
    assert.deepEqual(openHarness.followedViewerTargets, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-b',
        expectedRevision: 'r1',
        displayName: 'Focused session',
        duplicateDisplayName: false,
    }]);
    assert.deepEqual(openHarness.viewerTargets, []);

    const closedHarness = createHarness({
        viewerOpen: false,
        readOutlineError: new Error('must not read while closed'),
    });
    assert.equal(await closedHarness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'closed');
    assert.equal(closedHarness.outlineReads, 0);
    assert.deepEqual(closedHarness.followedViewerTargets, []);
    openHarness.capability.dispose();
    closedHarness.capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 routes a successful Active Session card focus into Conversation following', () => {
    const handlersSource = fs.readFileSync(
        path.join(__dirname, '../../../src/dashboard/messageHandlers.ts'),
        'utf8'
    );
    const handler = handlersSource.match(
        /'focus-ai-session-terminal': async e => \{[\s\S]*?\n\s*\},\n\s*'focus-pending-ai-session'/
    );
    assert.ok(handler, 'Active Session focus handler must remain inspectable');
    assert.match(handler[0], /focusActive\(/);
    assert.match(
        handler[0],
        /if \(focused\) \{[\s\S]*followActiveConversation\(/
    );
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 lets the newest Session follow intent win when an older outline resolves late', async () => {
    const slowOutline = deferred();
    const harness = createHarness({
        viewerOpen: true,
        resolveTarget: (_projectId, provider, sessionId) => makeSession({
            key: `${provider}:${sessionId}`,
            provider,
            sessionId,
            name: sessionId,
        }),
        readOutline: (provider, sessionId) => sessionId === 'session-a'
            ? slowOutline.promise
            : makeOutline(provider, sessionId, ['input-b']),
    });
    const first = harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-b',
    }), 'opened');
    slowOutline.resolve(makeOutline('codex', 'session-a', ['input-a']));
    assert.equal(await first, 'superseded');
    assert.deepEqual(
        harness.followedViewerTargets.map(target => target.sessionId),
        ['session-b']
    );
    harness.capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 follows the adjacent active session in dashboard order', async () => {
    const sessions = [
        makeSession({
            key: 'codex:session-a',
            sessionId: 'session-a',
            name: 'First',
        }),
        makeSession({
            key: 'codex:session-b',
            sessionId: 'session-b',
            name: 'Second',
        }),
        makeSession({
            key: 'kimi:session-c',
            provider: 'kimi',
            sessionId: 'session-c',
            name: 'Third',
        }),
    ];
    const focusedSessions = [];
    const harness = createHarness({
        viewerOpen: true,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async target => {
            focusedSessions.push(target);
        },
    });
    const switchSession = harness.viewerOptions.followAdjacentConversation;
    assert.equal(typeof switchSession, 'function');

    assert.equal(await switchSession('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'opened');
    assert.deepEqual(harness.followedViewerTargets.map(target => target.sessionId), [
        'session-b',
    ]);
    assert.equal(harness.followedViewerTargets[0].interactionId, 'input-b');
    assert.equal(harness.followedViewerTargets[0].displayName, 'Second');
    // A successful switch also syncs the session terminal/tmux window.
    assert.deepEqual(focusedSessions, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-b',
    }]);

    // The previous direction wraps around the ordered active list.
    assert.equal(await switchSession('previous', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'opened');
    assert.deepEqual(harness.followedViewerTargets.map(target => target.sessionId), [
        'session-b',
        'session-c',
    ]);
    assert.deepEqual(focusedSessions.map(target => target.sessionId), [
        'session-b',
        'session-c',
    ]);
    harness.capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 skips pending sessions and reports when no adjacent session exists', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({
            key: 'kimi:pending',
            provider: 'kimi',
            sessionId: undefined,
            pending: true,
        }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
    ];
    const focusedSessions = [];
    const harness = createHarness({
        viewerOpen: true,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async target => {
            focusedSessions.push(target);
        },
    });
    assert.equal(await harness.viewerOptions.followAdjacentConversation('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'opened');
    assert.deepEqual(harness.followedViewerTargets.map(target => target.sessionId), [
        'session-b',
    ]);
    assert.deepEqual(focusedSessions.map(target => target.sessionId), [
        'session-b',
    ]);
    harness.capability.dispose();

    const singleHarness = createHarness({ viewerOpen: true });
    assert.equal(await singleHarness.viewerOptions.followAdjacentConversation('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'noAdjacentSession');
    assert.equal(await singleHarness.viewerOptions.followAdjacentConversation('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-elsewhere',
    }), 'noAdjacentSession');
    assert.deepEqual(singleHarness.followedViewerTargets, []);
    singleHarness.capability.dispose();

    const closedHarness = createHarness({ viewerOpen: false });
    assert.equal(await closedHarness.viewerOptions.followAdjacentConversation('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'closed');
    assert.equal(closedHarness.outlineReads, 0);
    closedHarness.capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 lets the newest adjacent switch win when an older outline resolves late', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
        makeSession({ key: 'codex:session-c', sessionId: 'session-c' }),
    ];
    const slowOutline = deferred();
    const focusedSessions = [];
    const harness = createHarness({
        viewerOpen: true,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async target => {
            focusedSessions.push(target);
        },
        readOutline: (provider, sessionId) => sessionId === 'session-b'
            ? slowOutline.promise
            : makeOutline(provider, sessionId, ['input-x']),
    });
    const switchSession = harness.viewerOptions.followAdjacentConversation;
    const first = switchSession('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await switchSession('previous', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'opened');
    slowOutline.resolve(makeOutline('codex', 'session-b', ['input-b']));
    assert.equal(await first, 'superseded');
    assert.deepEqual(harness.followedViewerTargets.map(target => target.sessionId), [
        'session-c',
    ]);
    // Only the winning switch syncs the session terminal.
    assert.deepEqual(focusedSessions.map(target => target.sessionId), [
        'session-c',
    ]);
    harness.capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 fails closed when the active list cannot be resolved', async () => {
    const harness = createHarness({
        viewerOpen: true,
        resolveActiveTargets: () => {
            throw new Error('workspace snapshot unavailable');
        },
    });
    assert.equal(await harness.viewerOptions.followAdjacentConversation('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'unavailable');
    assert.deepEqual(harness.followedViewerTargets, []);
    harness.capability.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 keeps the switch settled when terminal sync fails', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
    ];
    const harness = createHarness({
        viewerOpen: true,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async () => {
            throw new Error('terminal focus failed');
        },
    });
    assert.equal(await harness.viewerOptions.followAdjacentConversation('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'opened');
    assert.deepEqual(harness.followedViewerTargets.map(target => target.sessionId), [
        'session-b',
    ]);
    harness.capability.dispose();
});
