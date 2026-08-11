'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadMessageHandlers() {
    const fakeVscode = {
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        Uri: {
            file: value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value }),
            parse: value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value }),
        },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/dashboard/messageHandlers');
    } finally {
        Module._load = previousLoad;
    }
}

const { createDashboardMessageHandlers } = loadMessageHandlers();

function createFixture(overrides = {}) {
    const calls = [];
    const posted = [];
    const record = name => (...args) => {
        calls.push([name, ...args]);
        return Promise.resolve();
    };
    const handlers = createDashboardMessageHandlers({
        postMessage: async message => { posted.push(message); return true; },
        getStewardInfos: () => ({ config: { get: (_key, fallback) => fallback } }),
        projectService: { getGroups: () => [{ id: 'group-a', name: 'Work', projects: [] }] },
        promptDashboardController: {
            getPanelContent: requestId => ({ type: 'ai-panel-content', requestId }),
            handle: record('promptHandle'),
        },
        getPromptTerminalCommandController: () => ({ handleInsertRequest: record('promptInsert') }),
        aiSessionCommandController: {
            toggleSessionsExpanded: record('toggleSessionsExpanded'),
            selectProviders: record('selectProviders'),
            togglePin: record('togglePin'),
            renameSession: record('renameSession'),
            copySessionId: record('copySessionId'),
        },
        aiSessionTerminalCommandController: {
            focusActive: async (...args) => {
                calls.push(['focusActive', ...args]);
                return overrides.focused !== false;
            },
            focusPending: record('focusPending'),
            closeTerminal: record('closeTerminal'),
            stopSession: record('stopSession'),
        },
        conversationCapability: { followActiveConversation: record('followActiveConversation') },
        aiSessionArchiveController: { archiveSessions: record('archiveSessions') },
        acknowledgeAiSessionAttentionEventIds: overrides.acknowledgeAttention
            || record('acknowledgeAttention'),
        logOpenWorkspaceDiagnostic: (component, event) => calls.push(['rendererDiagnostic', component, event]),
        refreshStewardViews: reason => calls.push(['refreshStewardViews', reason]),
        requestActiveAiSessionTerminalHighlight: () => calls.push(['requestHighlight']),
        postAiSessionAttentionState: () => calls.push(['postAttentionState']),
        onOpenWorkspacesRendererReady: () => calls.push(['openWorkspacesRendererReady']),
        showAgentPivotSettings: async () => { calls.push(['showSettings']); },
        showBridgeExtension: async () => { calls.push(['showBridgeExtension']); },
        showSponsorOptions: async () => { calls.push(['showSponsorOptions']); },
        showWarningMessage: message => calls.push(['showWarningMessage', message]),
    });
    return { handlers, calls, posted };
}

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 exposes every extracted handler key', () => {
    const { handlers } = createFixture();

    assert.deepEqual(Object.keys(handlers), [
        'request-projects-panel',
        'request-ai-panel',
        'prompt-command',
        'prompt-insert-terminal',
        'toggle-codex-sessions',
        'select-ai-session-providers',
        'focus-ai-session-terminal',
        'focus-pending-ai-session',
        'close-ai-session-terminal',
        'detach-ai-session-terminal',
        'stop-ai-session-runtime',
        'toggle-ai-session-pin',
        'acknowledge-ai-session-attention',
        'rename-ai-session',
        'copy-ai-session-id',
        'request-full-refresh',
        'open-workspaces-renderer-ready',
        'open-workspaces-rendered',
        'request-active-ai-session-terminal',
        'request-ai-session-attention-state',
        'open-settings',
        'open-bridge-extension',
        'sponsor',
        'archive-ai-sessions',
    ]);
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 validates panel request envelopes and posts content', async () => {
    const { handlers, posted } = createFixture();

    await handlers['request-projects-panel']({ version: 1, requestId: 7 });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'projects-panel-content');
    assert.equal(posted[0].requestId, 7);
    assert.ok(posted[0].html.length > 0, 'the panel html renders from current groups');

    await handlers['request-projects-panel']({ version: 2, requestId: 8 });
    await handlers['request-projects-panel']({ version: 1, requestId: 0 });
    assert.equal(posted.length, 1, 'invalid panel envelopes stay ignored');

    await handlers['request-ai-panel']({
        type: 'request-ai-panel', version: 1, requestId: 'req-9',
        target: 'global-prompt-library', extra: 'kept-out',
    });
    assert.equal(posted.length, 1, 'a fifth envelope key must reject the ai panel request');

    await handlers['request-ai-panel']({
        type: 'request-ai-panel', version: 1, requestId: 'req-9', target: 'global-prompt-library',
    });
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[1], { type: 'ai-panel-content', requestId: 'req-9' });

    await handlers['request-ai-panel']({ type: 'request-ai-panel', version: 1, requestId: 'req-9', target: 'other' });
    assert.equal(posted.length, 2, 'unknown targets stay ignored');
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 posts prompt results only when produced', async () => {
    const { handlers, posted, calls } = createFixture();
    calls.length = 0;

    await handlers['prompt-command']({ type: 'prompt-command', requestId: 1 });
    await handlers['prompt-insert-terminal']({ type: 'prompt-insert-terminal', requestId: 2 });

    assert.deepEqual(calls, [
        ['promptHandle', { type: 'prompt-command', requestId: 1 }],
        ['promptInsert', { type: 'prompt-insert-terminal', requestId: 2 }],
    ]);
    assert.equal(posted.length, 0, 'undefined results post nothing');
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 sanitizes renderer diagnostics and refreshes', async () => {
    const { handlers, calls } = createFixture();

    await handlers['request-full-refresh']({ reason: 'x'.repeat(300) });
    assert.deepEqual(calls[0], ['rendererDiagnostic', 'Renderer', {
        event: 'full-refresh-requested',
        reason: 'x'.repeat(256),
    }]);
    assert.deepEqual(calls[1], ['refreshStewardViews', 'x'.repeat(256)],
        'the refresh reason is truncated to the same bound');

    calls.length = 0;
    await handlers['request-full-refresh']({});
    assert.deepEqual(calls[1], ['refreshStewardViews', 'webview-requested']);

    calls.length = 0;
    await handlers['open-workspaces-rendered']({
        semanticRevision: 'rev', currentWorkspaceCount: 1, navigationWorkspaceCount: 2,
        hasOtherWindowsGroup: true, otherWindowsStatus: 'ready',
    });
    assert.deepEqual(calls[0][2], {
        event: 'open-workspaces-rendered',
        semanticRevision: 'rev',
        currentWorkspaceCount: 1,
        navigationWorkspaceCount: 2,
        hasOtherWindowsGroup: true,
        otherWindowsStatus: 'ready',
    });

    calls.length = 0;
    await handlers['open-workspaces-rendered']({
        semanticRevision: 7, currentWorkspaceCount: 3, navigationWorkspaceCount: -1,
        otherWindowsStatus: 'bogus',
    });
    assert.deepEqual(calls[0][2], {
        event: 'open-workspaces-rendered',
        semanticRevision: 'invalid',
        currentWorkspaceCount: -1,
        navigationWorkspaceCount: -1,
        hasOtherWindowsGroup: false,
        otherWindowsStatus: 'invalid',
    }, 'malformed renderer reports sanitize to invalid markers');
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 delegates the simple openers and state requests', async () => {
    const { handlers, calls } = createFixture();

    await handlers['request-active-ai-session-terminal']({});
    await handlers['request-ai-session-attention-state']({});
    await handlers['open-workspaces-renderer-ready']({
        type: 'open-workspaces-renderer-ready', version: 1,
    });
    await handlers['open-settings']({});
    await handlers['open-bridge-extension']({});
    // WEBVIEW-SPONSOR-ENTRY-001 the toolbar sponsor button delegates to the sponsor picker.
    await handlers['sponsor']({});
    await handlers['acknowledge-ai-session-attention']({
        type: 'acknowledge-ai-session-attention', eventIds: ['a', 1, 'b'],
    });

    assert.deepEqual(calls, [
        ['requestHighlight'],
        ['postAttentionState'],
        ['rendererDiagnostic', 'Renderer', {
            event: 'open-workspaces-renderer-ready',
        }],
        ['openWorkspacesRendererReady'],
        ['showSettings'],
        ['showBridgeExtension'],
        ['showSponsorOptions'],
        ['acknowledgeAttention', ['a', 'b']],
    ], 'non-string attention event ids are filtered before acknowledgement');
});

test('ATTENTION-SESSION-CARD-ACKNOWLEDGEMENT-001 validates requests and posts one correlated outcome', async () => {
    const request = {
        type: 'acknowledge-ai-session-attention',
        version: 1,
        requestId: 7,
        provider: 'codex',
        sessionId: 'session-a',
        workspaceScopeIdentity: 'scope-project-a',
        projectionRevision: 5,
        eventIds: ['event-a', 'event-b'],
    };
    const expected = outcome => ({
        type: 'ai-session-attention-acknowledgement-result',
        version: 1,
        requestId: request.requestId,
        provider: request.provider,
        sessionId: request.sessionId,
        workspaceScopeIdentity: request.workspaceScopeIdentity,
        projectionRevision: request.projectionRevision,
        outcome,
    });

    const malformed = createFixture();
    await malformed.handlers['acknowledge-ai-session-attention']({
        ...request, unexpected: true,
    });
    assert.deepEqual(malformed.calls, [], 'strict validation rejects unknown request fields');
    assert.deepEqual(malformed.posted, [expected('rejected')],
        'a recognized invalid request receives exactly one correlated rejection');

    const invalidCorrelation = createFixture();
    await invalidCorrelation.handlers['acknowledge-ai-session-attention']({
        ...request, requestId: 0,
    });
    assert.deepEqual(invalidCorrelation.calls, []);
    assert.deepEqual(invalidCorrelation.posted, [],
        'an unsafe correlation is ignored without falling through to legacy mutation');

    for (const outcome of ['committed', 'degraded-local']) {
        const fixture = createFixture({
            acknowledgeAttention: async eventIds => {
                fixture.calls.push(['acknowledgeAttention', eventIds]);
                return outcome;
            },
        });
        await fixture.handlers['acknowledge-ai-session-attention'](request);
        assert.deepEqual(fixture.calls, [['acknowledgeAttention', request.eventIds]]);
        assert.deepEqual(fixture.posted, [expected(outcome)],
            `${outcome} is posted exactly once with the complete correlation identity`);
    }

    let executions = 0;
    const duplicate = createFixture({
        acknowledgeAttention: async () => {
            executions += 1;
            return 'committed';
        },
    });
    await Promise.all([
        duplicate.handlers['acknowledge-ai-session-attention'](request),
        duplicate.handlers['acknowledge-ai-session-attention'](request),
    ]);
    assert.equal(executions, 1, 'a replayed request shares one Host mutation flight');
    assert.deepEqual(duplicate.posted, [expected('committed'), expected('committed')],
        'each delivery receives the same idempotent correlated outcome');

    const conflicting = createFixture({
        acknowledgeAttention: async () => {
            executions += 1;
            return 'committed';
        },
    });
    executions = 0;
    await Promise.all([
        conflicting.handlers['acknowledge-ai-session-attention'](request),
        conflicting.handlers['acknowledge-ai-session-attention']({
            ...request, eventIds: [...request.eventIds].reverse(),
        }),
    ]);
    assert.equal(executions, 1, 'one correlation cannot start a second payload flight');
    assert.deepEqual(conflicting.posted.map(message => message.outcome).sort(), [
        'committed', 'rejected',
    ]);

    executions = 0;
    const degraded = createFixture({
        acknowledgeAttention: async () => {
            executions += 1;
            return 'degraded-local';
        },
    });
    await degraded.handlers['acknowledge-ai-session-attention'](request);
    await degraded.handlers['acknowledge-ai-session-attention'](request);
    assert.equal(executions, 1, 'a degraded correlation remains an idempotent terminal result');

    const releases = [];
    let pendingExecutions = 0;
    const crowded = createFixture({
        acknowledgeAttention: () => new Promise(resolve => {
            pendingExecutions += 1;
            releases.push(resolve);
        }),
    });
    const crowdedRequests = Array.from({ length: 257 }, (_, index) => ({
        ...request, requestId: index + 1,
    }));
    const crowdedFlights = crowdedRequests.map(item =>
        crowded.handlers['acknowledge-ai-session-attention'](item)
    );
    const firstReplay = crowded.handlers['acknowledge-ai-session-attention'](crowdedRequests[0]);
    assert.equal(pendingExecutions, 257, 'capacity pruning cannot evict an unresolved flight');
    releases.forEach(resolve => resolve('committed'));
    await Promise.all([...crowdedFlights, firstReplay]);
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 rejects malformed open-workspaces renderer readiness', async () => {
    const { handlers, calls } = createFixture();

    await handlers['open-workspaces-renderer-ready']({});
    await handlers['open-workspaces-renderer-ready']({
        type: 'open-workspaces-renderer-ready', version: 2,
    });
    await handlers['open-workspaces-renderer-ready']({
        type: 'open-workspaces-renderer-ready', version: 1, extra: true,
    });

    assert.deepEqual(calls, []);
});

test('SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001 delegates focus and close flows', async () => {
    const { handlers, calls } = createFixture();

    await handlers['focus-ai-session-terminal']({ projectId: 'p1', provider: 'codex', sessionId: 's1' });
    assert.deepEqual(calls[0], ['focusActive', 'p1', 'codex', 's1']);
    assert.deepEqual(calls[1], ['followActiveConversation', { projectId: 'p1', provider: 'codex', sessionId: 's1' }],
        'a successful focus follows the conversation');

    const unfocused = createFixture({ focused: false });
    await unfocused.handlers['focus-ai-session-terminal']({ projectId: 'p1', provider: 'codex', sessionId: 's1' });
    assert.equal(unfocused.calls.filter(call => call[0] === 'followActiveConversation').length, 0,
        'no conversation follows an unfocused terminal');

    await handlers['focus-pending-ai-session']({ projectId: 'p1', provider: 'kimi', createdAt: 'c1' });
    await handlers['close-ai-session-terminal']({ projectId: 'p1', provider: 'codex', sessionId: 's1', pendingCreatedAt: 'pc1' });
    await handlers['detach-ai-session-terminal']({ projectId: 'p1', provider: 'codex', sessionId: 's2' });

    assert.deepEqual(calls[2], ['focusPending', 'p1', 'kimi', 'c1']);
    assert.deepEqual(calls[3], ['closeTerminal', {
        projectId: 'p1', providerId: 'codex', sessionId: 's1',
        pendingCreatedAt: 'pc1', expectedBackend: 'vscode',
    }]);
    assert.deepEqual(calls[4], ['closeTerminal', {
        projectId: 'p1', providerId: 'codex', sessionId: 's2',
        pendingCreatedAt: undefined, expectedBackend: 'tmux',
    }], 'detach keeps the tmux backend marker');
});

test('CONVERSATION-FOLLOW-FEEDBACK-001 warns when the clicked session can no longer be focused', async () => {
    const { handlers, calls } = createFixture({ focused: false });

    await handlers['focus-ai-session-terminal']({
        projectId: 'p1', provider: 'codex', sessionId: 's1',
    });

    assert.deepEqual(
        calls.filter(call => call[0] === 'showWarningMessage'),
        [[
            'showWarningMessage',
            'Agent Pivot: the selected AI session is no longer active.',
        ]],
        'a failed focus must not stay silent'
    );
    assert.equal(
        calls.filter(call => call[0] === 'followActiveConversation').length,
        0,
        'no conversation follows an unfocused terminal'
    );
});

test('RUNTIME-TMUX-TERMINATE-SESSION-001 routes the stop message with the tmux backend marker', async () => {
    const { handlers, calls } = createFixture();

    await handlers['stop-ai-session-runtime']({
        projectId: 'p1', provider: 'kimi', sessionId: 's9', pendingCreatedAt: 'pc9',
    });

    assert.deepEqual(calls[0], ['stopSession', {
        projectId: 'p1', providerId: 'kimi', sessionId: 's9',
        pendingCreatedAt: 'pc9', expectedBackend: 'tmux',
    }]);
});

test('PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001 delegates archive, provider, and pin mutations', async () => {
    const { handlers, calls } = createFixture();

    await handlers['archive-ai-sessions']({ projectId: 'p1', items: ['i1'], requestId: 'r1', version: 1 });
    await handlers['toggle-codex-sessions']({ projectId: 'p1', expanded: 1 });
    await handlers['select-ai-session-providers']({ projectId: 'p1', selectedProviders: ['codex'], requestId: 'r2', version: 1 });
    await handlers['toggle-ai-session-pin']({ provider: 'codex', sessionId: 's1' });
    await handlers['rename-ai-session']({ provider: 'codex', sessionId: 's1' });
    await handlers['copy-ai-session-id']({ sessionId: 's1' });

    assert.deepEqual(calls, [
        ['archiveSessions', 'p1', ['i1'], 'r1', 1],
        ['toggleSessionsExpanded', 'p1', true],
        ['selectProviders', 'p1', ['codex'], 'r2', 1],
        ['togglePin', 'codex', 's1'],
        ['renameSession', 'codex', 's1'],
        ['copySessionId', 's1'],
    ]);
});
