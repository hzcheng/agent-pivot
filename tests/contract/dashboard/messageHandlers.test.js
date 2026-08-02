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
        },
        conversationCapability: { followActiveConversation: record('followActiveConversation') },
        aiSessionArchiveController: { archiveSessions: record('archiveSessions') },
        acknowledgeAiSessionAttentionEventIds: record('acknowledgeAttention'),
        logOpenWorkspaceDiagnostic: (component, event) => calls.push(['rendererDiagnostic', component, event]),
        refreshStewardViews: reason => calls.push(['refreshStewardViews', reason]),
        requestActiveAiSessionTerminalHighlight: () => calls.push(['requestHighlight']),
        postAiSessionAttentionState: () => calls.push(['postAttentionState']),
        showAgentPivotSettings: async () => { calls.push(['showSettings']); },
        showBridgeExtension: async () => { calls.push(['showBridgeExtension']); },
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
        'toggle-ai-session-pin',
        'acknowledge-ai-session-attention',
        'rename-ai-session',
        'copy-ai-session-id',
        'request-full-refresh',
        'open-workspaces-rendered',
        'request-active-ai-session-terminal',
        'request-ai-session-attention-state',
        'open-settings',
        'open-bridge-extension',
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
    await handlers['open-settings']({});
    await handlers['open-bridge-extension']({});
    await handlers['acknowledge-ai-session-attention']({ eventIds: ['a', 1, 'b'] });

    assert.deepEqual(calls, [
        ['requestHighlight'],
        ['postAttentionState'],
        ['showSettings'],
        ['showBridgeExtension'],
        ['acknowledgeAttention', ['a', 'b']],
    ], 'non-string attention event ids are filtered before acknowledgement');
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
