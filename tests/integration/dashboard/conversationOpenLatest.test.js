'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

function hashSessionId(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

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

function makePage(provider, sessionId, interactionId) {
    return {
        provider,
        sessionId,
        sourceRevision: 'native-1',
        anchorInteractionId: interactionId,
        messages: [{
            id: `${interactionId}:user`,
            interactionId,
            role: 'user',
            markdown: interactionId,
        }],
        interactionStates: [{
            interactionId,
            responseState: 'complete',
        }],
        isStart: true,
        isEnd: true,
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
    const viewerSnapshots = [];
    const followedViewerTargets = [];
    const restoredViewerTargets = [];
    const viewerNotices = [];
    let viewerFocuses = 0;
    let capturedViewerOptions;
    let outlineReads = 0;
    let snapshotReads = 0;
    const snapshotReadTargets = [];
    let viewerRefreshes = 0;
    let currentViewerTarget;
    const session = 'session' in options ? options.session : makeSession({
        conversationDisplayName: options.conversationDisplayName,
        duplicateConversationDisplayName:
            options.duplicateConversationDisplayName,
    });
    const fakeAdapter = provider => () => ({
        ...(options.enableSnapshots ? {
            async readSnapshot(sessionId, preferredInteractionId, signal) {
                snapshotReads += 1;
                snapshotReadTargets.push(`${provider}:${sessionId}`);
                if (options.readSnapshot) {
                    return options.readSnapshot(
                        provider,
                        sessionId,
                        preferredInteractionId,
                        signal
                    );
                }
                const interactionIds = options.interactionIds
                    || ['input-a', 'input-b'];
                const selected = interactionIds.includes(preferredInteractionId)
                    ? preferredInteractionId
                    : interactionIds.at(-1);
                return {
                    outline: makeOutline(provider, sessionId, interactionIds),
                    page: makePage(provider, sessionId, selected),
                };
            },
        } : {}),
        async readOutline(sessionId) {
            outlineReads += 1;
            if (options.requireSnapshot) {
                throw new Error('initial Conversation load must use one snapshot');
            }
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
        ...(options.cacheDiagnostics ? {
            getCacheDiagnostics: () => options.cacheDiagnostics,
        } : {}),
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
        syncSession: options.syncSession,
        publish: async () => true,
        createPanel: () => {
            throw new Error('createPanel is not used by openLatestConversation');
        },
        openExternal: async () => true,
        spawnCodex: () => {
            throw new Error('spawnCodex is not used by openLatestConversation');
        },
        now: options.now || (() => Date.now()),
        setTimer: options.setTimer
            || ((callback, delayMs) => setTimeout(callback, delayMs)),
        clearTimer: options.clearTimer || (handle => clearTimeout(handle)),
        onDiagnostic: options.onDiagnostic || (() => {}),
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
                getCurrentTarget: () => (
                    options.getCurrentViewerTarget?.()
                    || options.getFocusedViewerTarget?.()
                    || options.focusedViewerTarget
                    || currentViewerTarget
                ),
                getFocusedTarget: () => (
                    options.getFocusedViewerTarget?.()
                    || options.focusedViewerTarget
                )
                    ? {
                        interactionId: 'input-a',
                        expectedRevision: 'native-1',
                        displayName: 'Focused session',
                        duplicateDisplayName: false,
                        ...(options.getFocusedViewerTarget?.()
                            || options.focusedViewerTarget),
                    }
                    : undefined,
                getFocusedSessionTarget: () => options.focusedViewerTarget,
                open: async (target, snapshot) => {
                    viewerTargets.push(target);
                    viewerSnapshots.push(snapshot);
                    currentViewerTarget = target;
                    await options.openViewer?.(target);
                },
                restore: async (panel, target) => {
                    restoredViewerTargets.push({ panel, target });
                },
                follow: async (target, snapshot) => {
                    followedViewerTargets.push(target);
                    viewerSnapshots.push(snapshot);
                    const followed = options.followViewer
                        ? options.followViewer(target)
                        : true;
                    if (await followed) {
                        currentViewerTarget = target;
                        return true;
                    }
                    return false;
                },
                focus: () => {
                    viewerFocuses += 1;
                    options.focusViewer?.();
                    return true;
                },
                showNotice: text => {
                    viewerNotices.push(text);
                    return true;
                },
                rebindSession: async () => false,
                freezeSessionMetadata: async () => false,
                refresh: async () => { viewerRefreshes += 1; },
                revalidateLatest: async () => { viewerRefreshes += 1; },
                reconcileAuthority: async () => undefined,
                dispose() {},
            };
        },
    });
    return {
        capability,
        viewerTargets,
        viewerSnapshots,
        followedViewerTargets,
        restoredViewerTargets,
        viewerNotices,
        get viewerOptions() {
            return capturedViewerOptions;
        },
        get outlineReads() {
            return outlineReads;
        },
        get snapshotReads() {
            return snapshotReads;
        },
        get snapshotReadTargets() {
            return [...snapshotReadTargets];
        },
        get viewerRefreshes() {
            return viewerRefreshes;
        },
        get viewerFocuses() {
            return viewerFocuses;
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
        workspaceName: '',
        sessionId: 'session-a',
        interactionId: 'input-b',
        expectedRevision: 'r1',
        displayName: 'Focused session',
        duplicateDisplayName: false,
    }]);
    capability.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 opens Codex, Kimi, and Claude with one shared provider snapshot each', async () => {
    for (const provider of ['codex', 'kimi', 'claude']) {
        const sessionId = `${provider}-session`;
        const harness = createHarness({
            enableSnapshots: true,
            requireSnapshot: true,
            session: makeSession({
                key: `${provider}:${sessionId}`,
                provider,
                sessionId,
                name: `${provider} Session`,
            }),
        });
        assert.equal(await harness.capability.openLatestConversation({
            projectId: 'project-a',
            provider,
            sessionId,
        }), 'opened');
        assert.equal(harness.snapshotReads, 1, `${provider} snapshot reads`);
        assert.equal(harness.outlineReads, 0, `${provider} outline re-reads`);
        assert.equal(harness.viewerSnapshots.length, 1);
        assert.equal(harness.viewerSnapshots[0].outline.provider, provider);
        assert.equal(harness.viewerSnapshots[0].page.provider, provider);
        harness.capability.dispose();
    }
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 warms adjacent Codex, Kimi, and Claude snapshots and revalidates after instant switching', async () => {
    const sessions = ['codex', 'kimi', 'claude'].map((provider, index) =>
        makeSession({
            key: `${provider}:session-${index}`,
            provider,
            sessionId: `session-${index}`,
            name: `${provider} Session`,
        })
    );
    const harness = createHarness({
        enableSnapshots: true,
        requireSnapshot: true,
        viewerOpen: true,
        session: sessions[0],
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session => session.provider === provider
                && session.sessionId === sessionId) || null,
        resolveActiveTargets: () => sessions,
    });

    assert.equal(await harness.capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-0',
    }), 'opened');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(harness.snapshotReadTargets.sort(), [
        'claude:session-2',
        'codex:session-0',
        'kimi:session-1',
    ]);

    assert.equal(await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'session-1',
    }), 'opened');
    assert.equal(harness.snapshotReadTargets.filter(target =>
        target === 'kimi:session-1'
    ).length, 1, 'Kimi switch must consume the warm snapshot');

    assert.equal(await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'claude',
        sessionId: 'session-2',
    }), 'opened');
    assert.equal(harness.snapshotReadTargets.filter(target =>
        target === 'claude:session-2'
    ).length, 1, 'Claude switch must consume the warm snapshot');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(harness.viewerRefreshes, 1,
        'only the latest warm switch may run its authoritative refresh');
    assert.equal(harness.snapshotReadTargets.filter(target =>
        target === 'codex:session-0'
    ).length, 2, 'the latest switch must prefetch its new adjacent sessions');
    assert.equal(harness.snapshotReadTargets.filter(target =>
        target === 'kimi:session-1'
    ).length, 2, 'the consumed warm snapshot must be prefetched again');
    harness.capability.dispose();
});

test('CONVERSATION-OPEN-LATEST-001 retries an empty speculative snapshot before reporting an active session empty', async () => {
    const sessions = ['codex', 'kimi'].map((provider, index) => makeSession({
        key: `${provider}:session-${index}`,
        provider,
        sessionId: `session-${index}`,
        name: `${provider} Session`,
    }));
    let kimiReads = 0;
    const harness = createHarness({
        enableSnapshots: true,
        requireSnapshot: true,
        viewerOpen: true,
        session: sessions[0],
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session => session.provider === provider
                && session.sessionId === sessionId) || null,
        resolveActiveTargets: () => sessions,
        readSnapshot: async (provider, sessionId) => {
            if (provider === 'kimi' && ++kimiReads === 1) {
                return {
                    outline: makeOutline(provider, sessionId, []),
                };
            }
            return {
                outline: makeOutline(provider, sessionId, ['input-a']),
                page: makePage(provider, sessionId, 'input-a'),
            };
        },
    });

    assert.equal(await harness.capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-0',
    }), 'opened');
    while (!harness.snapshotReadTargets.includes('kimi:session-1')) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(await harness.capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'session-1',
    }), 'opened');
    assert.equal(kimiReads, 2,
        'an empty warm snapshot must be confirmed by an authoritative read');
    harness.capability.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 shares a slow in-flight warmup instead of starting a duplicate provider read', async () => {
    const sessions = ['codex', 'kimi'].map((provider, index) => makeSession({
        key: `${provider}:slow-${index}`,
        provider,
        sessionId: `slow-${index}`,
        name: `${provider} Session`,
    }));
    const slowKimiSnapshot = deferred();
    let now = 1_000;
    const harness = createHarness({
        enableSnapshots: true,
        requireSnapshot: true,
        viewerOpen: true,
        session: sessions[0],
        now: () => now,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session => session.provider === provider
                && session.sessionId === sessionId) || null,
        resolveActiveTargets: () => sessions,
        readSnapshot: async (provider, sessionId) => {
            if (provider === 'kimi') {
                return slowKimiSnapshot.promise;
            }
            return {
                outline: makeOutline(provider, sessionId, ['input-a']),
                page: makePage(provider, sessionId, 'input-a'),
            };
        },
    });

    assert.equal(await harness.capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'slow-0',
    }), 'opened');
    while (!harness.snapshotReadTargets.includes('kimi:slow-1')) {
        await new Promise(resolve => setImmediate(resolve));
    }

    now += 10_000;
    const supersededSwitch = harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'slow-1',
    });
    await new Promise(resolve => setImmediate(resolve));
    const switching = harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'slow-1',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.snapshotReadTargets.filter(target =>
        target === 'kimi:slow-1'
    ).length, 1, 'rapid intents must share the existing warmup');

    slowKimiSnapshot.resolve({
        outline: makeOutline('kimi', 'slow-1', ['input-a']),
        page: makePage('kimi', 'slow-1', 'input-a'),
    });
    assert.equal(await supersededSwitch, 'superseded');
    assert.equal(await switching, 'opened');
    harness.capability.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 times out a hung speculative read before the user switches', async () => {
    const sessions = ['codex', 'kimi'].map((provider, index) => makeSession({
        key: `${provider}:hung-${index}`,
        provider,
        sessionId: `hung-${index}`,
        name: `${provider} Session`,
    }));
    const timers = [];
    let kimiReads = 0;
    const harness = createHarness({
        enableSnapshots: true,
        requireSnapshot: true,
        viewerOpen: true,
        session: sessions[0],
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session => session.provider === provider
                && session.sessionId === sessionId) || null,
        resolveActiveTargets: () => sessions,
        setTimer: (callback, delayMs) => {
            const timer = { callback, delayMs, cleared: false };
            timers.push(timer);
            if (delayMs === 0) {
                setImmediate(() => {
                    if (!timer.cleared) callback();
                });
            }
            return timer;
        },
        clearTimer: timer => { timer.cleared = true; },
        readSnapshot: async (provider, sessionId) => {
            if (provider === 'kimi' && ++kimiReads === 1) {
                return new Promise(() => {});
            }
            return {
                outline: makeOutline(provider, sessionId, ['input-a']),
                page: makePage(provider, sessionId, 'input-a'),
            };
        },
    });

    assert.equal(await harness.capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'hung-0',
    }), 'opened');
    while (!harness.snapshotReadTargets.includes('kimi:hung-1')) {
        await new Promise(resolve => setImmediate(resolve));
    }
    const warmTimeout = timers.find(timer => timer.delayMs === 5_000);
    assert.ok(warmTimeout, 'the speculative read must have a hard timeout');
    warmTimeout.callback();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'hung-1',
    }), 'opened');
    assert.equal(kimiReads, 2,
        'the user switch must retry after the hung warmup is abandoned');
    harness.capability.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 evicts completed speculative snapshots without requiring another navigation', async () => {
    const sessions = ['codex', 'kimi'].map((provider, index) => makeSession({
        key: `${provider}:retained-${index}`,
        provider,
        sessionId: `retained-${index}`,
        name: `${provider} Session`,
    }));
    const timers = [];
    let nowMs = 1_000;
    const harness = createHarness({
        enableSnapshots: true,
        requireSnapshot: true,
        viewerOpen: true,
        session: sessions[0],
        now: () => nowMs,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session => session.provider === provider
                && session.sessionId === sessionId) || null,
        resolveActiveTargets: () => sessions,
        setTimer: (callback, delayMs) => {
            const timer = { callback, delayMs, cleared: false };
            timers.push(timer);
            if (delayMs === 0) {
                setImmediate(() => {
                    if (!timer.cleared) callback();
                });
            }
            return timer;
        },
        clearTimer: timer => { timer.cleared = true; },
    });

    assert.equal(await harness.capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'retained-0',
    }), 'opened');
    while (!harness.snapshotReadTargets.includes('kimi:retained-1')) {
        await new Promise(resolve => setImmediate(resolve));
    }
    await new Promise(resolve => setImmediate(resolve));

    const completedExpiry = timers.find(timer =>
        timer.delayMs === 5_000 && !timer.cleared
    );
    assert.ok(completedExpiry,
        'a completed warm snapshot must retain an active expiry timer');
    nowMs += 5_001;
    completedExpiry.callback();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'retained-1',
    }), 'opened');
    assert.equal(harness.snapshotReadTargets.filter(target =>
        target === 'kimi:retained-1'
    ).length, 2, 'an expired speculative snapshot must be read authoritatively');
    harness.capability.dispose();
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
        workspaceName: '',
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
        workspaceName: '',
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

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 delegates Active Session card focus to the shared Conversation-aware navigation path', () => {
    const handlersSource = fs.readFileSync(
        path.join(__dirname, '../../../src/dashboard/messageHandlers.ts'),
        'utf8'
    );
    const handler = handlersSource.match(
        /'focus-ai-session-terminal': async e => \{[\s\S]*?\n\s*\},\n\s*'focus-pending-ai-session'/
    );
    assert.ok(handler, 'Active Session focus handler must remain inspectable');
    assert.match(handler[0], /focusAiSessionAndFollowConversation\(target\)/);

    const dashboardSource = fs.readFileSync(
        path.join(__dirname, '../../../src/dashboard.ts'),
        'utf8'
    );
    const navigationPath = dashboardSource.match(
        /const focusAiSessionAndFollowConversation[\s\S]*?\n\s*};\n\s*const conversationHandlers/
    );
    assert.ok(navigationPath, 'shared Active Session navigation path must remain inspectable');
    assert.match(navigationPath[0], /focusActive\(/);
    assert.match(
        navigationPath[0],
        /if \(focused(?: && [^)]+)?\) \{[\s\S]*followActiveConversation\(/
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

test('CONVERSATION-FOLLOW-FEEDBACK-001 surfaces an in-panel notice and sanitized diagnostic when a follow finds no conversation', async () => {
    const diagnostics = [];
    const harness = createHarness({
        viewerOpen: true,
        interactionIds: [],
        onDiagnostic: event => diagnostics.push(event),
    });
    const result = await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'empty');
    assert.deepEqual(harness.followedViewerTargets, []);
    assert.deepEqual(harness.viewerNotices, [
        'This AI session has no conversation yet.',
    ]);
    assert.deepEqual(diagnostics, [{
        event: 'conversation-follow',
        category: 'empty',
        provider: 'codex',
        sessionIdHash: hashSessionId('session-a'),
        snapshotSource: 'fresh',
        discardedEmptyWarmSnapshot: false,
        outlineInteractions: 0,
        sourceRevision: 'r1',
    }]);
    harness.capability.dispose();
});

test('CONVERSATION-FOLLOW-DIAGNOSTICS-001 an empty follow reports warm provenance and sanitized cache state', async () => {
    const sessions = ['codex', 'kimi'].map((provider, index) => makeSession({
        key: `${provider}:session-${index}`,
        provider,
        sessionId: `session-${index}`,
        name: `${provider} Session`,
    }));
    const diagnostics = [];
    const harness = createHarness({
        enableSnapshots: true,
        viewerOpen: true,
        session: sessions[0],
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session => session.provider === provider
                && session.sessionId === sessionId) || null,
        resolveActiveTargets: () => sessions,
        readSnapshot: async (provider, sessionId) => {
            if (provider === 'kimi') {
                return { outline: makeOutline(provider, sessionId, []) };
            }
            return {
                outline: makeOutline(provider, sessionId, ['input-a']),
                page: makePage(provider, sessionId, 'input-a'),
            };
        },
        cacheDiagnostics: {
            cachedInteractions: 0,
            cachedNextOffset: 4096,
            continuation: true,
            partial: false,
            sourceSize: 4096,
        },
        onDiagnostic: event => diagnostics.push(event),
    });

    assert.equal(await harness.capability.openLatestConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-0',
    }), 'opened');
    while (!harness.snapshotReadTargets.includes('kimi:session-1')) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'kimi',
        sessionId: 'session-1',
    }), 'empty');
    assert.deepEqual(harness.viewerNotices, [
        'This AI session has no conversation yet.',
    ]);
    assert.deepEqual(
        diagnostics.find(event => event.event === 'conversation-follow'),
        {
            event: 'conversation-follow',
            category: 'empty',
            provider: 'kimi',
            sessionIdHash: hashSessionId('session-1'),
            snapshotSource: 'fresh',
            discardedEmptyWarmSnapshot: true,
            outlineInteractions: 0,
            sourceRevision: 'r1',
            cachedInteractions: 0,
            cachedNextOffset: 4096,
            continuation: true,
            partial: false,
            sourceSize: 4096,
        }
    );
    harness.capability.dispose();
});

test('CONVERSATION-FOLLOW-FEEDBACK-001 surfaces a retry hint notice when a follow cannot read the conversation', async () => {
    const diagnostics = [];
    const harness = createHarness({
        viewerOpen: true,
        readOutlineError: new Error('boom'),
        onDiagnostic: event => diagnostics.push(event),
    });
    const result = await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(result, 'unavailable');
    assert.deepEqual(harness.viewerNotices, [
        'Unable to read the AI session conversation. Click the session again to retry.',
    ]);
    assert.deepEqual(diagnostics.at(-1), {
        event: 'conversation-follow',
        category: 'unavailable',
        provider: 'codex',
        sessionIdHash: hashSessionId('session-a'),
    });
    const allowedKeys = new Set([
        'event', 'category', 'provider', 'count', 'durationMs', 'version',
        'sessionIdHash', 'effectiveSessionIdHash', 'snapshotSource',
        'discardedEmptyWarmSnapshot', 'outlineInteractions', 'sourceRevision',
        'sourceSize', 'cachedNextOffset', 'cachedInteractions',
        'continuation', 'partial',
    ]);
    for (const event of diagnostics) {
        for (const key of Object.keys(event)) {
            assert.ok(
                allowedKeys.has(key),
                `follow diagnostics must stay sanitized, found ${key}`
            );
        }
        assert.ok(
            !JSON.stringify(event).includes('session-a'),
            'raw session identifiers must stay out of follow diagnostics'
        );
    }
    harness.capability.dispose();
});

test('CONVERSATION-FOLLOW-FEEDBACK-001 surfaces a notice when the followed session is no longer active', async () => {
    const diagnostics = [];
    const harness = createHarness({
        viewerOpen: true,
        session: null,
        onDiagnostic: event => diagnostics.push(event),
    });
    const result = await harness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'claude',
        sessionId: 'session-a',
    });
    assert.equal(result, 'unknownSession');
    assert.deepEqual(harness.viewerNotices, [
        'This AI session is no longer active.',
    ]);
    assert.deepEqual(diagnostics, [{
        event: 'conversation-follow',
        category: 'unknownSession',
        provider: 'claude',
        sessionIdHash: hashSessionId('session-a'),
    }]);
    harness.capability.dispose();
});

test('CONVERSATION-FOLLOW-FEEDBACK-001 keeps opened, closed, and superseded follows notice-free', async () => {
    const slowOutline = deferred();
    const diagnostics = [];
    const harness = createHarness({
        viewerOpen: true,
        onDiagnostic: event => diagnostics.push(event),
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

    const closedHarness = createHarness({
        viewerOpen: false,
        onDiagnostic: event => diagnostics.push(event),
    });
    assert.equal(await closedHarness.capability.followActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-c',
    }), 'closed');

    assert.deepEqual(harness.viewerNotices, []);
    assert.deepEqual(closedHarness.viewerNotices, []);
    assert.deepEqual(diagnostics, []);
    harness.capability.dispose();
    closedHarness.capability.dispose();
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

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 switches from the current Conversation target even when the viewer is unfocused', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
    ];
    const currentTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const focusedSessions = [];
    const harness = createHarness({
        viewerOpen: true,
        focusedViewerTarget: currentTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async target => {
            focusedSessions.push(target);
        },
    });

    assert.equal(
        await harness.capability.followAdjacentActiveConversation('next'),
        'opened'
    );
    assert.deepEqual(
        harness.followedViewerTargets.map(target => target.sessionId),
        ['session-b']
    );
    assert.deepEqual(
        focusedSessions.map(target => target.sessionId),
        ['session-b'],
        'command navigation must activate the target terminal/session'
    );
    assert.equal(harness.viewerFocuses, 1);
    harness.capability.dispose();

    const unfocused = createHarness({
        viewerOpen: true,
        getCurrentViewerTarget: () => currentTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
    });
    assert.equal(
        await unfocused.capability.followAdjacentActiveConversation('previous'),
        'opened'
    );
    assert.deepEqual(
        unfocused.followedViewerTargets.map(target => target.sessionId),
        ['session-b']
    );
    assert.equal(unfocused.viewerFocuses, 1);
    unfocused.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 synchronizes runtime authority without revealing the Terminal during Conversation navigation', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'kimi:session-b', provider: 'kimi', sessionId: 'session-b' }),
    ];
    const revealed = [];
    const synchronized = [];
    const harness = createHarness({
        viewerOpen: true,
        focusedViewerTarget: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'session-a',
        },
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async target => revealed.push(target),
        syncSession: async target => synchronized.push(target),
    });

    assert.equal(
        await harness.capability.followAdjacentActiveConversation('next'),
        'opened'
    );
    assert.deepEqual(revealed, []);
    assert.deepEqual(synchronized.map(target => [
        target.provider,
        target.sessionId,
    ]), [['kimi', 'session-b']]);
    assert.equal(harness.viewerFocuses, 1);
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 rolls a rejected command switch back before restoring Conversation focus', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
    ];
    const focusOrder = [];
    const harness = createHarness({
        viewerOpen: true,
        focusedViewerTarget: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'session-a',
        },
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async target => {
            focusOrder.push(`terminal:${target.sessionId}`);
            return target.sessionId === 'session-a';
        },
        focusViewer: () => focusOrder.push('conversation'),
    });

    assert.equal(
        await harness.capability.followAdjacentActiveConversation('next'),
        'unavailable'
    );
    assert.deepEqual(
        harness.followedViewerTargets.map(target => target.sessionId),
        ['session-b', 'session-a']
    );
    assert.deepEqual(focusOrder, [
        'terminal:session-b',
        'terminal:session-a',
        'conversation',
    ]);
    assert.equal(harness.viewerFocuses, 1);
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 rolls consecutive rejected commands back to the last confirmed terminal authority', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
        makeSession({ key: 'codex:session-c', sessionId: 'session-c' }),
    ];
    let currentViewerTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const slowBFocusStarted = deferred();
    const releaseSlowBFocus = deferred();
    const focusOrder = [];
    const harness = createHarness({
        viewerOpen: true,
        getFocusedViewerTarget: () => currentViewerTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        followViewer: async target => {
            currentViewerTarget = target;
            return true;
        },
        focusSession: async target => {
            focusOrder.push(`terminal:${target.sessionId}`);
            if (target.sessionId === 'session-b') {
                slowBFocusStarted.resolve();
                await releaseSlowBFocus.promise;
                return false;
            }
            return target.sessionId === 'session-a';
        },
        focusViewer: () => focusOrder.push('conversation'),
    });

    const first = harness.capability.followAdjacentActiveConversation('next');
    await slowBFocusStarted.promise;
    const second = harness.capability.followAdjacentActiveConversation('next');
    releaseSlowBFocus.resolve();

    assert.equal(await first, 'superseded');
    assert.equal(await second, 'unavailable');
    assert.deepEqual(focusOrder, [
        'terminal:session-b',
        'terminal:session-c',
        'terminal:session-a',
        'conversation',
    ]);
    assert.equal(currentViewerTarget.sessionId, 'session-a');
    assert.equal(harness.viewerFocuses, 1);
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 refreshes authority after opening the current terminal Conversation', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
    ];
    let currentViewerTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    let rejectB = false;
    const focusOrder = [];
    const harness = createHarness({
        viewerOpen: true,
        getFocusedViewerTarget: () => currentViewerTarget,
        getCurrentViewerTarget: () => currentViewerTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        openViewer: async target => {
            currentViewerTarget = target;
        },
        followViewer: async target => {
            currentViewerTarget = target;
            return true;
        },
        focusSession: async target => {
            focusOrder.push(`terminal:${target.sessionId}`);
            return target.sessionId !== 'session-b' || !rejectB;
        },
    });

    assert.equal(
        await harness.capability.followAdjacentActiveConversation('next'),
        'opened'
    );
    assert.equal(currentViewerTarget.sessionId, 'session-b');

    assert.equal(await harness.capability.openLatestActiveConversation({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }), 'opened');
    rejectB = true;

    assert.equal(
        await harness.capability.followAdjacentActiveConversation('next'),
        'unavailable'
    );
    assert.equal(currentViewerTarget.sessionId, 'session-a');
    assert.deepEqual(focusOrder, [
        'terminal:session-b',
        'terminal:session-b',
        'terminal:session-a',
    ]);
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 does not confirm a queued terminal focus skipped after supersession', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
        makeSession({ key: 'codex:session-c', sessionId: 'session-c' }),
        makeSession({ key: 'codex:session-d', sessionId: 'session-d' }),
    ];
    let currentViewerTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const slowBFocusStarted = deferred();
    const releaseSlowBFocus = deferred();
    const focusOrder = [];
    const harness = createHarness({
        viewerOpen: true,
        getFocusedViewerTarget: () => currentViewerTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        followViewer: async target => {
            currentViewerTarget = target;
            return true;
        },
        focusSession: async target => {
            focusOrder.push(`terminal:${target.sessionId}`);
            if (target.sessionId === 'session-b') {
                slowBFocusStarted.resolve();
                await releaseSlowBFocus.promise;
                return true;
            }
            return target.sessionId !== 'session-d';
        },
    });

    const first = harness.capability.followAdjacentActiveConversation('next');
    await slowBFocusStarted.promise;
    const second = harness.capability.followAdjacentActiveConversation('next');
    await new Promise(resolve => setImmediate(resolve));
    const third = harness.capability.followAdjacentActiveConversation('next');
    releaseSlowBFocus.resolve();

    assert.equal(await first, 'superseded');
    assert.equal(await second, 'superseded');
    assert.equal(await third, 'unavailable');
    assert.deepEqual(focusOrder, [
        'terminal:session-b',
        'terminal:session-d',
        'terminal:session-b',
    ]);
    assert.equal(currentViewerTarget.sessionId, 'session-b');
    assert.equal(harness.viewerFocuses, 1);
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 refreshes the rollback snapshot after in-session interaction navigation', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
        makeSession({ key: 'codex:session-c', sessionId: 'session-c' }),
    ];
    let currentViewerTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const harness = createHarness({
        viewerOpen: true,
        getFocusedViewerTarget: () => currentViewerTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        followViewer: async target => {
            currentViewerTarget = target;
            return true;
        },
        focusSession: async target => target.sessionId !== 'session-c',
    });

    assert.equal(
        await harness.capability.followAdjacentActiveConversation('next'),
        'opened'
    );
    const inSessionTarget = {
        ...currentViewerTarget,
        interactionId: 'input-new',
        expectedRevision: 'native-new',
        subagent: { id: 'subagent-new', label: 'Research' },
    };
    currentViewerTarget = inSessionTarget;

    assert.equal(
        await harness.capability.followAdjacentActiveConversation('next'),
        'unavailable'
    );
    assert.deepEqual(currentViewerTarget, inSessionTarget);
    assert.deepEqual(
        harness.followedViewerTargets.at(-1),
        inSessionTarget
    );
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 restores Conversation focus after an older terminal focus has already started', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
        makeSession({ key: 'codex:session-c', sessionId: 'session-c' }),
    ];
    const currentTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const slowTerminalFocusStarted = deferred();
    const releaseSlowTerminalFocus = deferred();
    const focusOrder = [];
    const harness = createHarness({
        viewerOpen: true,
        focusedViewerTarget: currentTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async target => {
            focusOrder.push(`terminal:${target.sessionId}:started`);
            slowTerminalFocusStarted.resolve();
            await releaseSlowTerminalFocus.promise;
            focusOrder.push(`terminal:${target.sessionId}:finished`);
        },
        focusViewer: () => {
            focusOrder.push('conversation');
        },
    });

    const oldSwitch = harness.viewerOptions.followAdjacentConversation(
        'next',
        currentTarget
    );
    await slowTerminalFocusStarted.promise;
    const commandSwitch = harness.capability.followAdjacentActiveConversation(
        'previous'
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(focusOrder, ['terminal:session-b:started']);

    releaseSlowTerminalFocus.resolve();
    assert.equal(await oldSwitch, 'superseded');
    assert.equal(await commandSwitch, 'opened');
    assert.deepEqual(focusOrder, [
        'terminal:session-b:started',
        'terminal:session-b:finished',
        'terminal:session-c:started',
        'terminal:session-c:finished',
        'conversation',
    ]);
    assert.equal(harness.viewerFocuses, 1);
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 restores Conversation focus when the commanded viewer follow fails', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
        makeSession({ key: 'codex:session-c', sessionId: 'session-c' }),
    ];
    const currentTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const slowTerminalFocusStarted = deferred();
    const releaseSlowTerminalFocus = deferred();
    const focusOrder = [];
    const harness = createHarness({
        viewerOpen: true,
        focusedViewerTarget: currentTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        followViewer: async target => target.sessionId !== 'session-c',
        focusSession: async target => {
            focusOrder.push(`terminal:${target.sessionId}`);
            slowTerminalFocusStarted.resolve();
            await releaseSlowTerminalFocus.promise;
        },
        focusViewer: () => focusOrder.push('conversation'),
    });

    const oldSwitch = harness.viewerOptions.followAdjacentConversation(
        'next',
        currentTarget
    );
    await slowTerminalFocusStarted.promise;
    const commandSwitch = harness.capability.followAdjacentActiveConversation(
        'previous'
    );
    releaseSlowTerminalFocus.resolve();

    assert.equal(await oldSwitch, 'superseded');
    assert.equal(await commandSwitch, 'closed');
    assert.deepEqual(focusOrder, ['terminal:session-b', 'conversation']);
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 restores Conversation focus when no adjacent session remains', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
    ];
    let activeSessions = sessions;
    const currentTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };
    const slowTerminalFocusStarted = deferred();
    const releaseSlowTerminalFocus = deferred();
    const focusOrder = [];
    const harness = createHarness({
        viewerOpen: true,
        focusedViewerTarget: currentTarget,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => activeSessions,
        focusSession: async target => {
            focusOrder.push(`terminal:${target.sessionId}`);
            slowTerminalFocusStarted.resolve();
            await releaseSlowTerminalFocus.promise;
        },
        focusViewer: () => focusOrder.push('conversation'),
    });

    const oldSwitch = harness.viewerOptions.followAdjacentConversation(
        'next',
        currentTarget
    );
    await slowTerminalFocusStarted.promise;
    activeSessions = [sessions[0]];
    const commandSwitch = harness.capability.followAdjacentActiveConversation(
        'next'
    );
    releaseSlowTerminalFocus.resolve();

    assert.equal(await oldSwitch, 'superseded');
    assert.equal(await commandSwitch, 'noAdjacentSession');
    assert.deepEqual(focusOrder, ['terminal:session-b', 'conversation']);
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

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 prevents a superseded in-viewer switch from restoring the old terminal focus', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
        makeSession({ key: 'codex:session-c', sessionId: 'session-c' }),
    ];
    const slowFollowStarted = deferred();
    const releaseSlowFollow = deferred();
    const focusedSessions = [];
    const harness = createHarness({
        viewerOpen: true,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        followViewer: async target => {
            if (target.sessionId === 'session-b') {
                slowFollowStarted.resolve();
                await releaseSlowFollow.promise;
            }
            return true;
        },
        focusSession: async target => {
            focusedSessions.push(target);
        },
    });
    const switchSession = harness.viewerOptions.followAdjacentConversation;
    const currentTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };

    const first = switchSession('next', currentTarget);
    await slowFollowStarted.promise;
    assert.equal(await switchSession('previous', currentTarget), 'opened');
    releaseSlowFollow.resolve();
    assert.equal(await first, 'superseded');
    assert.deepEqual(
        focusedSessions.map(target => target.sessionId),
        ['session-c']
    );
    harness.capability.dispose();
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 serializes terminal focus so the latest Conversation remains authoritative', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
        makeSession({ key: 'codex:session-b', sessionId: 'session-b' }),
        makeSession({ key: 'codex:session-c', sessionId: 'session-c' }),
    ];
    const slowFocusStarted = deferred();
    const releaseSlowFocus = deferred();
    const completedFocuses = [];
    const harness = createHarness({
        viewerOpen: true,
        resolveTarget: (_projectId, provider, sessionId) =>
            sessions.find(session =>
                session.provider === provider && session.sessionId === sessionId
            ) || null,
        resolveActiveTargets: () => sessions,
        focusSession: async target => {
            if (target.sessionId === 'session-b') {
                slowFocusStarted.resolve();
                await releaseSlowFocus.promise;
            }
            completedFocuses.push(target.sessionId);
        },
    });
    const switchSession = harness.viewerOptions.followAdjacentConversation;
    const currentTarget = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    };

    const first = switchSession('next', currentTarget);
    await slowFocusStarted.promise;
    const second = switchSession('previous', currentTarget);
    await new Promise(resolve => setImmediate(resolve));
    releaseSlowFocus.resolve();

    assert.equal(await first, 'superseded');
    assert.equal(await second, 'opened');
    assert.deepEqual(completedFocuses, ['session-b', 'session-c']);
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

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 rolls Conversation and terminal authority back when terminal sync fails', async () => {
    const sessions = [
        makeSession({ key: 'codex:session-a', sessionId: 'session-a' }),
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
            focusedSessions.push(target.sessionId);
            return target.sessionId === 'session-a';
        },
    });
    assert.equal(await harness.viewerOptions.followAdjacentConversation('next', {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        interactionId: 'input-a',
        expectedRevision: 'native-1',
        displayName: 'Session A',
        duplicateDisplayName: false,
    }), 'unavailable');
    assert.deepEqual(harness.followedViewerTargets.map(target => target.sessionId), [
        'session-b',
        'session-a',
    ]);
    assert.deepEqual(focusedSessions, ['session-b', 'session-a']);
    harness.capability.dispose();
});
