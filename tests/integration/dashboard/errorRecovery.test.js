'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createDashboardMessageRouter } = require('../../../out/dashboard/messageRouter');
const { getErrorContent } = require('../../../out/dashboard/errorContent');
const { DashboardLifecycleController } = require('../../../out/dashboard/lifecycleController');
const { DashboardRuntimeController } = require('../../../out/dashboard/runtimeController');
const { DashboardStartupController } = require('../../../out/dashboard/startupController');
const { AgentPivotViewProvider } = require('../../../out/dashboard/viewProvider');
const { TmuxRuntimeDiscovery } = require('../../../out/aiSessions/tmuxRuntimeDiscovery');
const {
    createSyntheticTmuxStore,
    makeTmuxDiscoveryRow,
} = require('../../helpers/runtimeContract');
const {
    OpenWorkspaceCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceCoordinator');
const {
    createSyntheticOpenWorkspaceStore,
    makePublication,
} = require('../../contract/openProjects/helpers');

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function loadConversationComposition() {
    const fakeUri = value => ({
        scheme: value.split(':', 1)[0],
        path: value,
        fsPath: value,
        toString: () => value,
    });
    const fakeVscode = {
        ViewColumn: { Beside: 2 },
        Uri: {
            file: value => fakeUri(`file://${value}`),
            parse: fakeUri,
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

function unavailableService() {
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
    };
}

function constructionFailureHarness(throwAt) {
    const creations = [];
    const disposals = new Map();
    const diagnostics = [];
    const incrementDisposal = name => {
        disposals.set(name, (disposals.get(name) || 0) + 1);
    };
    const createResource = (name, owned = []) => {
        creations.push(name);
        return {
            dispose() {
                incrementDisposal(name);
                owned.forEach(resource => resource.dispose());
            },
        };
    };
    const maybeThrow = name => {
        creations.push(`${name}:throw`);
        throw new Error([
            `/private/${name}/conversation.jsonl`,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'private prompt',
            'private response',
        ].join(' '));
    };
    const service = unavailableService();
    const capability = createConversationCapability({
        services: { codex: service, kimi: service, claude: service },
        resolveTarget: () => null,
        publish: async () => true,
        createPanel: () => {
            throw new Error('must not create panel');
        },
        openExternal: async () => true,
        spawnCodex: () => {
            throw new Error('must not spawn Codex');
        },
        now: () => 1000,
        setTimer: () => 1,
        clearTimer: () => undefined,
        onDiagnostic: event => diagnostics.push(event),
    }, {
        createCodexClient: () => createResource('client'),
        createCodexAdapter: options => throwAt === 'codex'
            ? maybeThrow('codex')
            : createResource('codex', [options.client]),
        createKimiAdapter: () => throwAt === 'kimi'
            ? maybeThrow('kimi')
            : createResource('kimi'),
        createClaudeAdapter: () => throwAt === 'claude'
            ? maybeThrow('claude')
            : createResource('claude'),
        createCoordinator: options => {
            if (throwAt === 'coordinator') {
                return maybeThrow('coordinator');
            }
            return {
                ...createResource(
                    'coordinator',
                    Object.values(options.adapters)
                ),
                async readOutline() {},
                async readPage() {},
                watch() {
                    return { dispose() {} };
                },
                releaseSubscription() {},
                setSessionStopped() {},
            };
        },
        createViewer: () => throwAt === 'viewer'
            ? maybeThrow('viewer')
            : {
                ...createResource('viewer'),
                async open() {},
                async refresh() {},
            },
        createController: () => throwAt === 'controller'
            ? maybeThrow('controller')
            : createResource('controller'),
    });
    return { capability, creations, diagnostics, disposals };
}

function makeConfigurationEvent(...sections) {
    return {
        affectsConfiguration(candidate) {
            return sections.some(section => (
                section === candidate || section.startsWith(`${candidate}.`)
            ));
        },
    };
}

function makeStartupController(migrateDataIfNeeded, events) {
    return new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded,
        refreshDashboard: async () => events.push('refresh'),
        publishOpenWorkspace: () => events.push('publish'),
        showInformationMessage: () => events.push('information'),
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error]),
        showAgentPivot: () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'fixture',
        getVisibleEditorLanguageIds: () => [],
    });
}

test('ERROR-ERROR-CONTENT-001 escapes hostile render failures and never emits executable HTML', () => {
    const raw = '<script>steal("credential")</script>';
    const html = getErrorContent(new Error(raw));
    assert.match(html, /Agent Pivot could not render this view/);
    assert.equal(html.includes(raw), false);
    assert.match(html, /&lt;script&gt;steal\(&quot;credential&quot;\)&lt;\/script&gt;/);
});

test('SESSION-SIDEBAR-STEWARD-VIEW-PROVIDER-ORDERING-001 keeps view and message failures generic', async () => {
    const logs = [];
    let receiveMessage;
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage(callback) {
                receiveMessage = callback;
                return { dispose() {} };
            },
            postMessage: async () => true,
        },
        onDidChangeVisibility() {
            return { dispose() {} };
        },
        onDidDispose() {
            return { dispose() {} };
        },
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({ enableScripts: true }),
        renderContent: () => { throw new Error('private render credential'); },
        renderError: getErrorContent,
        onMessage: async () => { throw new Error('private message credential'); },
        onVisibleChanged: async () => undefined,
        logError: (message, error) => logs.push([message, error]),
    });

    await provider.resolveWebviewView(view, {}, {});
    await receiveMessage({ type: 'private-message' });

    assert.match(view.webview.html, /Unexpected Agent Pivot view failure/);
    assert.equal(view.webview.html.includes('private render credential'), false);
    assert.deepEqual(logs.map(([message]) => message), [
        'Failed to render Agent Pivot view.',
        'Failed to handle an Agent Pivot message.',
    ]);
    assert.ok(logs.every(([, error]) => error.message === 'Unexpected Agent Pivot view failure.'));
});

test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 renders cached HTML before visible preparation settles', async () => {
    const visibilityGate = deferred();
    const order = [];
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        onDidDispose() {
            return { dispose() {} };
        },
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => { order.push('render'); return '<main>fresh</main>'; },
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async visible => {
            order.push(`visible:${visible}:start`);
            await visibilityGate.promise;
            order.push(`visible:${visible}:end`);
        },
        onDisposed: () => undefined,
        logError: () => undefined,
    });

    let resolved = false;
    const resolution = provider.resolveWebviewView(view, {}, {}).then(() => {
        resolved = true;
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(view.webview.html, '<main>fresh</main>');
    assert.deepEqual(order, ['render', 'visible:true:start']);
    assert.equal(resolved, true);

    visibilityGate.resolve();
    await resolution;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['render', 'visible:true:start', 'visible:true:end']);
});

test('SESSION-SIDEBAR-STEWARD-VIEW-PROVIDER-ORDERING-001 preserves healthy HTML when visible preparation fails', async () => {
    const visibilityGate = deferred();
    const logs = [];
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        onDidDispose: () => ({ dispose() {} }),
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => '<main>healthy cached dashboard</main>',
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async () => {
            await visibilityGate.promise;
            throw new Error('private refresh failure');
        },
        onDisposed: () => undefined,
        logError: (message, error) => logs.push([message, error.message]),
    });

    const resolution = provider.resolveWebviewView(view, {}, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.webview.html, '<main>healthy cached dashboard</main>');

    visibilityGate.resolve();
    await resolution;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(view.webview.html, '<main>healthy cached dashboard</main>');
    assert.deepEqual(logs, [[
        'Failed to prepare Agent Pivot view.',
        'Unexpected Agent Pivot view failure.',
    ]]);
});

test('RUNTIME-DASHBOARD-VISIBILITY-RESILIENCE-001 renders the dashboard after a runtime refresh failure', async () => {
    const diagnostics = [];
    const incrementalRefreshes = [];
    const providerLogs = [];
    const runtime = new DashboardRuntimeController({
        isVisible: () => true,
        refreshProvider: () => undefined,
        logDashboardDiagnostic: () => undefined,
        executeCommand: async () => undefined,
        viewType: 'agentPivot.views.sidebar',
        publishOpenWorkspace: () => undefined,
        getCurrentSavedProject: () => null,
        syncProjectColorToCurrentWindow: async () => undefined,
        postMessage: async () => true,
        logError: () => undefined,
        refreshAiSessionRuntimes: async () => {
            throw new Error('transient runtime refresh');
        },
        logAiSessionRuntimeFailure: (operation, error) => diagnostics.push([
            operation,
            error.message,
        ]),
    });
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        onDidDispose: () => ({ dispose() {} }),
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => '<main>dashboard ready</main>',
        renderError: getErrorContent,
        onMessage: async () => undefined,
        onVisibleChanged: visible =>
            runtime.handleAiSessionViewVisibilityChanged(visible),
        onVisiblePrepared: async () => {
            incrementalRefreshes.push('dashboard-visible');
        },
        onDisposed: () => undefined,
        logError: (message, error) => providerLogs.push([message, error.message]),
    });

    await provider.resolveWebviewView(view, {}, {});
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(view.webview.html, '<main>dashboard ready</main>');
    assert.deepEqual(diagnostics, [['dashboard-visible', 'transient runtime refresh']]);
    assert.deepEqual(incrementalRefreshes, ['dashboard-visible']);
    assert.deepEqual(providerLogs, []);
});

test('SESSION-SIDEBAR-STEWARD-VIEW-PROVIDER-ORDERING-001 releases sidebar-owned conversation state on disposal', async () => {
    let disposeView;
    let disposed = 0;
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility() {
            return { dispose() {} };
        },
        onDidDispose(callback) {
            disposeView = callback;
            return { dispose() {} };
        },
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => '<main>ready</main>',
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async () => undefined,
        onDisposed: () => {
            disposed += 1;
        },
        logError: () => undefined,
    });

    await provider.resolveWebviewView(view, {}, {});
    disposeView();
    disposeView();
    assert.equal(disposed, 1);
    assert.equal(provider.visible, false);
    assert.equal(await provider.postMessage({ type: 'after-dispose' }), false);
});

test('SESSION-SIDEBAR-STEWARD-VIEW-PROVIDER-OWNERSHIP-001 ignores stale visibility and disposal callbacks after view replacement', async () => {
    const visibility = [];
    const renders = [];
    const disposalVisibility = [];
    let disposed = 0;
    let holdNextVisibility = false;
    const visibilityGate = deferred();
    const makeView = name => {
        let visibilityChanged;
        let disposeView;
        const posted = [];
        const view = {
            visible: true,
            webview: {
                name,
                html: '',
                options: {},
                onDidReceiveMessage: () => ({ dispose() {} }),
                postMessage: async message => {
                    posted.push(message);
                    return true;
                },
            },
            onDidChangeVisibility(callback) {
                visibilityChanged = callback;
                return { dispose() {} };
            },
            onDidDispose(callback) {
                disposeView = callback;
                return { dispose() {} };
            },
        };
        return {
            view,
            posted,
            fireVisibility: () => visibilityChanged(),
            fireDispose: () => disposeView(),
        };
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: webview => {
            renders.push(webview.name);
            return `<main>${webview.name}</main>`;
        },
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async visible => {
            visibility.push(visible);
            if (holdNextVisibility) {
                holdNextVisibility = false;
                await visibilityGate.promise;
            }
        },
        onDisposed: () => {
            disposalVisibility.push(provider.visible);
            disposed += 1;
        },
        logError: () => undefined,
    });
    const viewA = makeView('a');
    const viewB = makeView('b');

    await provider.resolveWebviewView(viewA.view, {}, {});
    holdNextVisibility = true;
    const staleInFlight = viewA.fireVisibility();
    await new Promise(resolve => setImmediate(resolve));
    await provider.resolveWebviewView(viewB.view, {}, {});
    assert.deepEqual(renders, ['a', 'a', 'b']);
    assert.equal(disposed, 1);
    assert.deepEqual(disposalVisibility, [false]);

    visibilityGate.resolve();
    await staleInFlight;
    assert.deepEqual(
        renders,
        ['a', 'a', 'b'],
        'an old post-await continuation must not refresh the current view'
    );

    const visibilityBeforeOldCallbacks = visibility.slice();
    viewA.view.visible = false;
    await viewA.fireVisibility();
    await viewA.fireDispose();
    assert.deepEqual(visibility, visibilityBeforeOldCallbacks);
    assert.equal(disposed, 1);
    assert.equal(provider.visible, true);
    assert.equal(await provider.postMessage({ type: 'current-b' }), true);
    assert.deepEqual(viewB.posted, [{ type: 'current-b' }]);

    viewB.view.visible = false;
    await viewB.fireVisibility();
    assert.equal(provider.visible, false);
    viewB.view.visible = true;
    await viewB.fireVisibility();
    assert.equal(provider.visible, true);
    assert.deepEqual(renders, ['a', 'a', 'b', 'b']);
    await viewB.fireDispose();
    assert.equal(disposed, 2);
    assert.deepEqual(disposalVisibility, [false, false]);
    assert.equal(provider.visible, false);
    assert.equal(await provider.postMessage({ type: 'after-b' }), false);
});

test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 ignores prepared completion from a superseded view', async () => {
    const visibilityGate = deferred();
    const prepared = [];
    let visibilityCalls = 0;
    const makeView = name => ({
        visible: true,
        webview: {
            name,
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        onDidDispose: () => ({ dispose() {} }),
    });
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: webview => `<main>${webview.name}</main>`,
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async () => {
            visibilityCalls += 1;
            if (visibilityCalls === 1) {
                await visibilityGate.promise;
            }
        },
        onVisiblePrepared: async () => {
            prepared.push('prepared');
        },
        onDisposed: () => undefined,
        logError: () => undefined,
    });
    const viewA = makeView('a');
    const viewB = makeView('b');

    await provider.resolveWebviewView(viewA, {}, {});
    await new Promise(resolve => setImmediate(resolve));
    await provider.resolveWebviewView(viewB, {}, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prepared, ['prepared']);

    prepared.length = 0;
    visibilityGate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prepared, []);
});

test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 ignores prepared completion from an older visibility epoch', async () => {
    const firstVisibleGate = deferred();
    const prepared = [];
    let visibilityChanged;
    let visibilityCalls = 0;
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility(callback) {
            visibilityChanged = callback;
            return { dispose() {} };
        },
        onDidDispose: () => ({ dispose() {} }),
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => '<main>cached dashboard</main>',
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async () => {
            visibilityCalls += 1;
            if (visibilityCalls === 1) {
                await firstVisibleGate.promise;
            }
        },
        onVisiblePrepared: async () => {
            prepared.push('prepared');
        },
        onDisposed: () => undefined,
        logError: () => undefined,
    });

    await provider.resolveWebviewView(view, {}, {});
    await new Promise(resolve => setImmediate(resolve));
    view.visible = false;
    await visibilityChanged();
    view.visible = true;
    await visibilityChanged();
    assert.deepEqual(prepared, ['prepared']);

    prepared.length = 0;
    firstVisibleGate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prepared, []);
});

test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 preserves healthy HTML when prepared delivery rejects', async () => {
    const logs = [];
    const view = {
        visible: true,
        webview: {
            html: '',
            options: {},
            onDidReceiveMessage: () => ({ dispose() {} }),
            postMessage: async () => true,
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        onDidDispose: () => ({ dispose() {} }),
    };
    const provider = new AgentPivotViewProvider({
        getWebviewOptions: () => ({}),
        renderContent: () => '<main>healthy cached dashboard</main>',
        renderError: () => '<main>safe error</main>',
        onMessage: async () => undefined,
        onVisibleChanged: async () => undefined,
        onVisiblePrepared: async () => {
            throw new Error('private delivery failure');
        },
        onDisposed: () => undefined,
        logError: (message, error) => logs.push([message, error.message]),
    });

    await provider.resolveWebviewView(view, {}, {});
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(view.webview.html, '<main>healthy cached dashboard</main>');
    assert.deepEqual(logs, [[
        'Failed to prepare Agent Pivot view.',
        'Unexpected Agent Pivot view failure.',
    ]]);
});

test('PRODUCTION-CONVERSATION-UNAVAILABLE-001 isolates constructor failures from dashboard activation and unrelated routes', async () => {
    const privateFailure = [
        '/home/private/conversation.jsonl',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'private prompt',
        'private response',
    ].join(' ');
    const diagnostics = [];
    const publications = [];
    const panels = [];
    const spawns = [];
    let unrelatedRoutes = 0;
    const service = unavailableService();
    const capability = createConversationCapability({
        services: { codex: service, kimi: service, claude: service },
        resolveTarget: () => null,
        publish: async message => {
            publications.push(message);
            return true;
        },
        createPanel: () => {
            panels.push(true);
            throw new Error('panel must stay unavailable');
        },
        openExternal: async () => true,
        spawnCodex: () => {
            spawns.push(true);
            throw new Error('child must stay unavailable');
        },
        now: () => 1000,
        setTimer: () => 1,
        clearTimer: () => undefined,
        onDiagnostic: event => diagnostics.push(event),
    }, {
        createCoordinator: () => {
            throw new Error(privateFailure);
        },
    });
    const router = createDashboardMessageRouter({
        handlers: {
            'request-ai-session-conversation-outline': message =>
                capability.controller.handleOutline(message),
            'open-ai-session-conversation': message =>
                capability.controller.handleOpen(message),
            'cancel-ai-session-conversation': message =>
                capability.controller.cancel(message),
            'request-projects-panel': () => {
                unrelatedRoutes += 1;
            },
        },
    });

    assert.equal(capability.availability, 'unavailable');
    await router({ type: 'request-projects-panel' });
    await router({
        type: 'request-ai-session-conversation-outline',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 0,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(unrelatedRoutes, 1);
    assert.deepEqual(diagnostics, [{
        event: 'conversation-read',
        category: 'unavailable',
    }]);
    assert.equal(
        JSON.stringify(diagnostics).includes(privateFailure),
        false
    );
    assert.equal(publications.length, 1);
    assert.equal(publications[0].error.code, 'unavailable');
    assert.deepEqual(panels, []);
    assert.deepEqual(spawns, []);
    capability.dispose();
    capability.dispose();
});

for (const scenario of [
    {
        throwAt: 'codex',
        created: ['client', 'codex:throw'],
        disposed: ['client'],
    },
    {
        throwAt: 'kimi',
        created: ['client', 'codex', 'kimi:throw'],
        disposed: ['client', 'codex'],
    },
    {
        throwAt: 'claude',
        created: ['client', 'codex', 'kimi', 'claude:throw'],
        disposed: ['client', 'codex', 'kimi'],
    },
    {
        throwAt: 'coordinator',
        created: [
            'client',
            'codex',
            'kimi',
            'claude',
            'coordinator:throw',
        ],
        disposed: ['client', 'codex', 'kimi', 'claude'],
    },
    {
        throwAt: 'viewer',
        created: [
            'client',
            'codex',
            'kimi',
            'claude',
            'coordinator',
            'viewer:throw',
        ],
        disposed: ['client', 'codex', 'kimi', 'claude', 'coordinator'],
    },
    {
        throwAt: 'controller',
        created: [
            'client',
            'codex',
            'kimi',
            'claude',
            'coordinator',
            'viewer',
            'controller:throw',
        ],
        disposed: [
            'client',
            'codex',
            'kimi',
            'claude',
            'coordinator',
            'viewer',
        ],
    },
]) {
    test(`PRODUCTION-CONVERSATION-OWNERSHIP-001 releases each completed owner exactly once when ${scenario.throwAt} construction throws`, () => {
        const harness = constructionFailureHarness(scenario.throwAt);

        assert.equal(harness.capability.availability, 'unavailable');
        assert.deepEqual(harness.creations, scenario.created);
        assert.deepEqual(
            Object.fromEntries(
                scenario.disposed.map(name => [
                    name,
                    harness.disposals.get(name) || 0,
                ])
            ),
            Object.fromEntries(scenario.disposed.map(name => [name, 1]))
        );
        assert.deepEqual(harness.diagnostics, [{
            event: 'conversation-read',
            category: 'unavailable',
        }]);
        assert.equal(
            JSON.stringify(harness.diagnostics).includes('private prompt'),
            false
        );
        const beforeUnavailableDispose = new Map(harness.disposals);
        harness.capability.dispose();
        harness.capability.dispose();
        assert.deepEqual(harness.disposals, beforeUnavailableDispose);
    });
}

test('PRODUCTION-CONVERSATION-OWNERSHIP-002 disposes each steady-state capability resource exactly once', () => {
    const harness = constructionFailureHarness();
    const resources = [
        'client',
        'codex',
        'kimi',
        'claude',
        'coordinator',
        'viewer',
        'controller',
    ];

    assert.equal(harness.capability.availability, 'available');
    assert.deepEqual(harness.creations, resources);
    harness.capability.dispose();
    harness.capability.dispose();
    assert.deepEqual(
        Object.fromEntries(resources.map(name => [
            name,
            harness.disposals.get(name) || 0,
        ])),
        Object.fromEntries(resources.map(name => [name, 1]))
    );
});

test('WEBVIEW-DASHBOARD-MESSAGE-ROUTER-001 ignores invalid Webview messages without mutating host state', async () => {
    const mutations = [];
    const router = createDashboardMessageRouter({
        handlers: {
            'request-projects-panel': message => mutations.push(message),
        },
        getAiSessionProviderIds: () => ['codex'],
        resumeAiSession: message => mutations.push(message),
    });

    for (const message of [null, undefined, 'message', [], {}, { type: '' }, { type: 'unknown' }]) {
        await assert.doesNotReject(router(message));
    }
    assert.deepEqual(mutations, []);
});

test('ARCH-COORDINATOR-001 retries bridge delivery after an unchanged publication fails', async t => {
    let fireWatcher;
    let resolveSecondAttempt;
    const secondAttempt = new Promise(resolve => { resolveSecondAttempt = resolve; });
    const attempts = [];
    const coordinator = new OpenWorkspaceCoordinator('/synthetic-error-recovery', {
        now: () => 1000,
        setInterval: () => 'error-recovery-interval',
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close() {} };
        },
        createStore: () => createSyntheticOpenWorkspaceStore(),
        deliverAggregate: aggregate => {
            attempts.push(aggregate);
            if (attempts.length === 1) throw new Error('bridge unavailable');
            resolveSecondAttempt();
        },
    });
    t.after(() => coordinator.dispose());

    await assert.rejects(coordinator.publish(makePublication()), /bridge unavailable/);
    fireWatcher();
    await secondAttempt;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].semanticRevision, attempts[0].semanticRevision);
});

test('RUNTIME-TMUX-DISCOVERY-001 retains a safe stopped record when a runtime resource disappears', async () => {
    let rows = [makeTmuxDiscoveryRow({ sessionId: 'disappearing' })];
    const discovery = new TmuxRuntimeDiscovery({
        client: { listWindows: async () => rows },
        bindingStore: createSyntheticTmuxStore(),
        markerIsCurrent: () => false,
        nowMs: () => 2000,
        cacheTtlMs: 0,
    });

    await discovery.refresh(true);
    rows = [];
    await discovery.refresh(true);
    assert.deepEqual(discovery.getActive(), []);
    assert.deepEqual(discovery.getInactive().map(runtime => ({
        sessionId: runtime.identity.sessionId,
        state: runtime.state,
    })), [{ sessionId: 'disappearing', state: 'stopped' }]);
});

test('PERSIST-DASHBOARD-LIFECYCLE-CONTROLLER-001 allows a later configuration migration after one failure', async () => {
    const events = [];
    let attempts = 0;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async openAfter => {
            attempts += 1;
            events.push(['migrate', openAfter]);
            if (attempts === 1) throw new Error('migration unavailable');
        },
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
    });
    const change = makeConfigurationEvent('agentPivot.storeProjectsInSettings');

    await assert.rejects(controller.handleConfigurationChanged(change), /migration unavailable/);
    assert.deepEqual(events, [['migrate', false]]);
    await controller.handleConfigurationChanged(change);
    assert.deepEqual(events.slice(1), [
        ['migrate', false],
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);
});

test('PERSIST-DASHBOARD-LIFECYCLE-CONTROLLER-001 routes workspace, configuration, and focus changes once', async () => {
    const events = [];
    const controller = new DashboardLifecycleController({
        checkDataMigration: async openAfter => events.push(['migrate', openAfter]),
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: followsFocus => events.push(['publish', followsFocus]),
        evaluateAiSessionAttention: () => events.push('attention'),
    });

    await controller.handleConfigurationChanged(
        makeConfigurationEvent('agentPivot.customCss')
    );
    assert.deepEqual(events, [
        'color',
        ['refresh', 'configuration-changed'],
        ['publish', undefined],
    ]);
    events.length = 0;
    controller.handleWorkspaceFoldersChanged();
    controller.handleWindowStateChanged({ focused: true });
    controller.handleWindowStateChanged({ focused: false });
    assert.deepEqual(events, [
        'color',
        ['refresh', 'workspace-folders-changed'],
        ['publish', undefined],
        ['publish', true],
        'attention',
        'attention',
    ]);
});

test('TODO-COMPLETION-INCREMENTAL-001 suppresses only a local todoData configuration echo', async () => {
    const events = [];
    let localEcho = true;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => events.push('migrate'),
        reconcileProjectCatalog: async () => events.push('reconcile'),
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
        consumeTodoDataWriteEcho: () => localEcho,
    });
    const todoDataChange = makeConfigurationEvent('agentPivot.todoData');

    await controller.handleConfigurationChanged(todoDataChange);
    assert.deepEqual(events, []);

    localEcho = false;
    await controller.handleConfigurationChanged(todoDataChange);
    assert.deepEqual(events, [
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);

    events.length = 0;
    localEcho = true;
    await controller.handleConfigurationChanged(makeConfigurationEvent(
        'agentPivot.todoData',
        'agentPivot.storeProjectsInSettings',
        'agentPivot.projectSyncData',
        'agentPivot.customCss'
    ));
    assert.deepEqual(events, [
        'migrate',
        'reconcile',
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 reconciles synchronized project data before dashboard publication', async () => {
    const events = [];
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => undefined,
        reconcileProjectCatalog: async () => {
            events.push('reconcile:start');
            await Promise.resolve();
            events.push('reconcile:end');
        },
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        refreshProjects: reason => events.push(['projects', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
    });

    await controller.handleConfigurationChanged(
        makeConfigurationEvent('agentPivot.projectSyncData')
    );

    assert.deepEqual(events, [
        'reconcile:start',
        'reconcile:end',
        ['projects', 'configuration-changed'],
        'color',
        'publish',
    ]);
});

test('PROJECT-INCREMENTAL-REFRESH-001 suppresses local catalog echoes and routes external catalog changes partially', async () => {
    const events = [];
    let localEcho = true;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => events.push('migrate'),
        reconcileProjectCatalog: async () => events.push('reconcile'),
        consumeProjectCatalogWriteEcho: change => {
            events.push(['consume', change]);
            return localEcho;
        },
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        refreshProjects: reason => events.push(['projects', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
    });
    const catalogChange = makeConfigurationEvent(
        'agentPivot.projectSyncData',
        'agentPivot.projectData'
    );

    await controller.handleConfigurationChanged(catalogChange);
    assert.deepEqual(events, [[
        'consume',
        { syncData: true, legacyGroups: true },
    ]]);

    events.length = 0;
    localEcho = false;
    await controller.handleConfigurationChanged(catalogChange);
    assert.deepEqual(events, [
        ['consume', { syncData: true, legacyGroups: true }],
        'reconcile',
        ['projects', 'configuration-changed'],
        'color',
        'publish',
    ]);

    events.length = 0;
    await controller.handleConfigurationChanged(makeConfigurationEvent(
        'agentPivot.projectSyncData',
        'agentPivot.customCss'
    ));
    assert.deepEqual(events, [
        ['consume', { syncData: true, legacyGroups: false }],
        'reconcile',
        'color',
        ['refresh', 'configuration-changed'],
        'publish',
    ]);
});

test('WEBVIEW-DASHBOARD-STARTUP-CONTROLLER-001 retries a failed migration without stale refresh or publication', async () => {
    const events = [];
    let attempt = 0;
    const controller = makeStartupController(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('destination unavailable');
        return { projects: { migrated: true }, todos: { migrated: false } };
    }, events);

    await controller.checkDataMigration();
    assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), ['log', 'error']);
    await controller.checkDataMigration();
    assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), [
        'log', 'error', 'refresh', 'publish', 'information',
    ]);
});
