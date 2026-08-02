'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadComposition() {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return {};
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/aiSessions/sessionControllerComposition');
    } finally {
        Module._load = previousLoad;
    }
}

const { createSessionControllerComposition } = loadComposition();

function createFixture(overrides = {}) {
    const calls = [];
    const record = name => (...args) => {
        calls.push([name, ...args]);
        return Promise.resolve();
    };
    const controllerOptions = {};
    const factories = {
        createCommandController: options => {
            controllerOptions.command = options;
            return { marker: 'command', ...overrides.commandController };
        },
        createCreationController: options => {
            controllerOptions.creation = options;
            return { marker: 'creation' };
        },
        createArchiveController: options => {
            controllerOptions.archive = options;
            return { marker: 'archive' };
        },
        createTerminalCommandController: options => {
            controllerOptions.terminal = options;
            return { marker: 'terminal' };
        },
        createResumeController: options => {
            controllerOptions.resume = options;
            return { marker: 'resume' };
        },
    };
    const providers = [{ id: 'codex' }, { id: 'kimi' }, { id: 'claude' }];
    const composition = createSessionControllerComposition({
        getCurrentWorkspaceActionTarget: cardId => ({ cardId }),
        getCurrentOpenWorkspace: () => ({ scopeIdentity: 'scope-1' }),
        getActiveEditorUri: () => undefined,
        isWorkspaceTrusted: () => true,
        getRegisteredAiSessionProvider: providerId => providers.find(provider => provider.id === providerId) || null,
        getRegisteredAiSessionProviders: () => providers,
        providerDirectoryCapability: { probe: record('probeCapability') },
        workspacePrimaryRootStore: {
            getPrimaryRootId: record('getPrimaryRootId'),
            setPrimaryRootId: record('setPrimaryRootId'),
        },
        aiSessionWorkspaceStateStore: {
            setExpanded: record('setExpanded'),
            setProviderSelection: record('setProviderSelection'),
        },
        aiSessionPinController: { toggle: record('pinToggle'), remove: record('pinRemove') },
        aiSessionAliasController: {
            getAll: () => ({}),
            saveAll: record('saveAliases'),
            getOriginalName: record('getOriginalName'),
            remove: record('aliasRemove'),
        },
        aiSessionReadCoordinator: { getProviderResult: record('getProviderResult') },
        aiSessionRuntimeCoordinator: {
            refreshForHost: record('refreshForHost'),
            focus: record('runtimeFocus'),
        },
        aiSessionTerminalService: {
            getPendingMarkerPath: record('getPendingMarkerPath'),
            getMarkerPath: record('getMarkerPath'),
            deleteMarker: record('deleteMarker'),
            untrack: record('untrack'),
        },
        aiSessionProviders: providers,
        getAiSessionRuntimeById: record('getRuntimeById'),
        getAiSessionRuntimeCollision: record('getRuntimeCollision'),
        getAiSessionPinKey: (providerId, sessionId) => `${providerId}:${sessionId}`,
        runSafeLifecycleTask: (operation, task) => {
            calls.push(['runSafeLifecycleTask', operation]);
            return Promise.resolve().then(task).then(() => undefined, () => undefined);
        },
        acknowledgeAttention: record('acknowledgeAttention'),
        syncActiveRuntime: () => calls.push(['syncActiveRuntime']),
        getLaunchOptions: () => ({ launch: true }),
        postMessage: record('postMessage'),
        appendOutput: record('appendOutput'),
        postBatchArchiveCompletion: record('postBatchArchiveCompletion'),
        logError: record('logError'),
        logAiSessionRuntimeFailure: record('logRuntimeFailure'),
        refreshAiSessionViewsIncrementally: () => calls.push(['refreshViews']),
        scheduleNewAiSessionRefresh: record('scheduleNewSessionRefresh'),
        nowMs: () => 1234,
        showInputBox: record('showInputBox'),
        showQuickPick: overrides.showQuickPick || record('showQuickPick'),
        showWarningMessage: record('showWarningMessage'),
        showWarningWithItems: record('showWarningWithItems'),
        showModalWarning: record('showModalWarning'),
        showInformationMessage: record('showInformationMessage'),
        showErrorMessage: record('showErrorMessage'),
        writeClipboard: record('writeClipboard'),
        focusTerminalView: record('focusTerminalView'),
    }, factories);
    return { composition, controllerOptions, calls, providers };
}

test('SESSION-AI-SESSION-CREATION-CONTROLLER-001 returns all five composed controllers', () => {
    const { composition } = createFixture();

    assert.deepEqual(
        Object.keys(composition),
        [
            'aiSessionCommandController',
            'aiSessionCreationController',
            'aiSessionArchiveController',
            'aiSessionTerminalCommandController',
            'aiSessionResumeController',
        ]
    );
    assert.deepEqual(
        Object.values(composition).map(controller => controller.marker),
        ['command', 'creation', 'archive', 'terminal', 'resume']
    );
});

test('SESSION-AI-SESSION-PROVIDER-AVAILABILITY-001 wires the workspace root and provider picks', async () => {
    const picks = [];
    const { controllerOptions } = createFixture({
        showQuickPick: async (items, options) => {
            picks.push({ items, options });
            return items[0];
        },
    });

    const workspace = {
        scopeIdentity: 'scope-1',
        roots: [{ id: 'root-1', name: 'api', hostPath: '/work/api' }],
    };
    const rootId = await controllerOptions.command.pickWorkspaceRoot(workspace, 'resume');
    assert.equal(rootId, 'root-1');
    assert.equal(picks[0].options.title, 'Resume AI Session in Workspace Root');
    assert.deepEqual(picks[0].items, [{ label: 'api', description: '/work/api', rootId: 'root-1' }]);

    const providerId = await controllerOptions.creation.pickProvider();
    assert.equal(providerId, 'codex', 'provider picks come from the registry order');
    assert.equal(picks[1].options.title, 'Select an AI provider');

    await controllerOptions.command.getProviderDirectoryCapability({ id: 'codex' });
    assert.equal(picks.length, 2);
});

test('SESSION-AI-SESSION-CREATION-CONTROLLER-001 delegates directory scopes to the command controller', async () => {
    const resolved = [];
    const { controllerOptions, calls } = createFixture({
        commandController: {
            resolveWorkspaceDirectoryScope: async (...args) => {
                resolved.push(args);
                return { rootId: 'root-1' };
            },
            rememberDirectoryScope: async () => { throw new Error('disk full'); },
        },
    });

    await controllerOptions.creation.resolveWorkspaceDirectoryScope({ workspace: 'w' }, 'codex', 'root-9');
    assert.deepEqual(resolved, [['w', 'codex', undefined, 'root-9']],
        'creation resolves against the target workspace');

    await controllerOptions.resume.resolveWorkspaceDirectoryScope({ workspace: 'w' }, 'session', 'kimi', 'root-8');
    assert.deepEqual(resolved[1], ['w', 'kimi', 'session', 'root-8'],
        'resume resolves against the target workspace with the session');

    await controllerOptions.creation.rememberDirectoryScope({ rootId: 'root-1' });
    const logErrorCall = calls.find(call => call[0] === 'logError');
    assert.equal(logErrorCall[1], 'Could not save the AI session workspace root.');
    assert.ok(logErrorCall[2] instanceof Error && logErrorCall[2].message === 'disk full',
        'a failed scope memory logs instead of throwing');
});

test('SESSION-AI-SESSION-CREATION-CONTROLLER-001 wires refresh cadence, markers, and status posts', async () => {
    const { controllerOptions, calls } = createFixture();
    const creation = controllerOptions.creation;

    await creation.getExistingSessionIdsForCwd('codex', '/work/api');
    assert.deepEqual(calls.find(call => call[0] === 'getProviderResult'),
        ['getProviderResult', 'codex', {
            forceRefresh: true,
            candidatePaths: ['/work/api'],
            reason: 'new-session',
        }]);

    creation.showActiveTab('project-1');
    creation.announceStatus('project-1', 'ready');
    assert.deepEqual(calls.filter(call => call[0] === 'postMessage'), [
        ['postMessage', { type: 'ai-session-tab-selection-requested', projectId: 'project-1', tab: 'active' }],
        ['postMessage', { type: 'ai-session-status-announcement', projectId: 'project-1', message: 'ready' }],
    ]);
    assert.equal(creation.nowMs(), 1234);
    assert.equal(typeof creation.createPendingId(), 'string');
    assert.equal(creation.createPendingId().length, 32);
});

test('PERSIST-MULTI-PROVIDER-BATCH-ARCHIVE-001 wires archive guards, confirmations, and completion', async () => {
    const { controllerOptions, calls } = createFixture();
    const archive = controllerOptions.archive;

    await archive.refreshRuntimeGuard();
    assert.deepEqual(calls.find(call => call[0] === 'refreshForHost'), ['refreshForHost', true]);

    archive.confirmSingleArchive('Codex');
    assert.deepEqual(calls.find(call => call[0] === 'showModalWarning'),
        ['showModalWarning', 'Archive this Codex session?', 'Archive']);

    archive.postCompletion({ type: 'batch' });
    assert.deepEqual(calls.find(call => call[0] === 'postBatchArchiveCompletion'),
        ['postBatchArchiveCompletion', { type: 'batch' }]);

    archive.syncActiveRuntime();
    assert.deepEqual(calls.filter(call => call[0] === 'syncActiveRuntime').length, 1);
});

test('SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001 closes runtimes through the settlement boundary', async () => {
    const { controllerOptions, calls } = createFixture();
    const terminal = controllerOptions.terminal;

    terminal.onRuntimeCloseEnd({ identity: { provider: 'codex', sessionId: 's1', workspaceScopeIdentity: 'scope-1' } }, true);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.find(call => call[0] === 'runSafeLifecycleTask'),
        ['runSafeLifecycleTask', 'acknowledge-explicit-session-close']);
    assert.deepEqual(calls.find(call => call[0] === 'acknowledgeAttention'),
        ['acknowledgeAttention', { provider: 'codex', sessionId: 's1', workspaceScopeIdentity: 'scope-1' }]);

    calls.length = 0;
    terminal.onRuntimeCloseEnd({ identity: { provider: 'codex', sessionId: 's1' } }, false);
    terminal.onRuntimeCloseEnd({ identity: { provider: 'codex', workspaceScopeIdentity: 'scope-1' } }, true);
    assert.deepEqual(calls, [], 'failed or session-less closes must not acknowledge');

    terminal.confirmRuntimeClose('Close it?', 'Close');
    assert.deepEqual(calls[0], ['showModalWarning', 'Close it?', 'Close']);
});

test('SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001 builds exact runtime conflict picks', async () => {
    const runtimes = [
        {
            backend: 'tmux',
            tmux: { layout: 'project', sessionName: 'agent-pivot', windowName: 'main' },
            attached: true,
            identity: { sessionId: 's-tmux' },
        },
        {
            backend: 'vscode',
            terminal: { name: 'term-1' },
            attached: false,
            identity: { sessionId: 's-direct' },
        },
    ];
    let pickCall;
    const { controllerOptions } = createFixture({
        showQuickPick: async (items, options) => {
            pickCall = { items, options };
            return items[1];
        },
    });

    const selected = await controllerOptions.terminal.chooseRuntimeConflict(runtimes);
    assert.equal(selected.identity.sessionId, 's-direct');
    assert.deepEqual(pickCall.items.map(item => [item.label, item.description, item.detail]), [
        ['$(terminal) tmux · project layout', 'attached', 'Target: agent-pivot:main'],
        ['$(terminal) Direct · VS Code Terminal', 'detached', 'Target: term-1'],
    ]);
});

test('SESSION-AI-SESSION-RESUME-CONTROLLER-001 wires names, conflicts, and markers', async () => {
    const { controllerOptions, calls, providers } = createFixture();
    const resume = controllerOptions.resume;

    resume.getRuntimeConflict('codex', 's1', 'scope-1');
    assert.deepEqual(calls.find(call => call[0] === 'getRuntimeCollision'),
        ['getRuntimeCollision', 'codex', 's1', 'scope-1']);

    resume.getMarkerPath('codex', 's1');
    assert.deepEqual(calls.find(call => call[0] === 'getMarkerPath'), ['getMarkerPath', 'codex', 's1']);

    const name = resume.getTerminalName('codex', { id: 's1', name: 'Fix bug' }, providers);
    assert.equal(typeof name, 'string');
});
