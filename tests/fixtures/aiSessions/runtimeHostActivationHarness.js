'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const dashboardPath = path.join(root, 'out/dashboard.js');

function disposable() {
    return { dispose() {} };
}

async function waitFor(predicate, label) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function createVscode(lifecycle) {
    const registeredCommands = [];
    const registeredCommandCallbacks = new Map();
    const executedCommands = [];
    const webviewHtmlHistory = [];
    let bootWebviewMessageCallback;
    let providerRegistrations = 0;
    let registeredProvider;
    let providerResolution = Promise.resolve();
    const configuration = { get: (_key, fallback) => fallback, inspect: () => undefined, update: async () => undefined };
    const uri = value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value });
    const webview = {
        cspSource: 'fixture-webview',
        options: {},
        postMessage: async message => {
            lifecycle.postedWebviewMessages.push(message);
            if (lifecycle.activationDisposed) {
                lifecycle.postDisposeWebviewMessages.push(message?.type || 'unknown');
            }
            return true;
        },
        asWebviewUri: value => value,
        onDidReceiveMessage: callback => {
            bootWebviewMessageCallback = callback;
            return disposable();
        },
        get html() {
            return webviewHtmlHistory[webviewHtmlHistory.length - 1] || '';
        },
        set html(value) {
            webviewHtmlHistory.push(value);
        },
    };
    const webviewView = {
        visible: true,
        webview,
        onDidChangeVisibility: () => disposable(),
        onDidDispose: () => disposable(),
    };
    const trackedResource = (kind, onDispose = () => undefined) => {
        if (lifecycle.activationDisposed) {
            lifecycle.lateResourceAcquisitions.push(kind);
        }
        let disposed = false;
        return {
            dispose() {
                if (disposed) return;
                disposed = true;
                onDispose();
            },
        };
    };
    const trackedListener = kind => trackedResource(kind);
    return {
        registeredCommands,
        webviewHtmlHistory,
        get bootWebviewMessageCallback() { return bootWebviewMessageCallback; },
        get providerRegistrations() { return providerRegistrations; },
        get providerResolution() { return providerResolution; },
        get registeredProvider() { return registeredProvider; },
        ConfigurationTarget: { Global: 1, Workspace: 2 }, ExtensionMode: { Test: 3 }, ViewColumn: { One: 1 },
        Uri: { file: uri, parse: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        window: {
            terminals: [], activeTerminal: null, activeTextEditor: undefined, visibleTextEditors: [],
            createOutputChannel: () => ({
                appendLine: value => lifecycle.outputLines.push(value),
                dispose() {},
            }),
            createTerminal: options => ({ name: options.name || 'fixture', processId: Promise.resolve(1), show() {}, dispose() {}, sendText() {} }),
            registerWebviewViewProvider: (_viewType, provider) => {
                providerRegistrations += 1;
                registeredProvider = provider;
                providerResolution = Promise.resolve(provider.resolveWebviewView(
                    webviewView,
                    {},
                    { isCancellationRequested: false }
                ));
                return trackedResource('provider-registration');
            },
            onDidChangeActiveTerminal: () => trackedListener('active-terminal-listener'),
            onDidOpenTerminal: () => {
                lifecycle.activeOpenTerminalListeners += 1;
                return trackedResource('open-terminal-listener', () => {
                    lifecycle.activeOpenTerminalListeners -= 1;
                    lifecycle.openTerminalListenerDisposals += 1;
                });
            },
            onDidCloseTerminal: () => trackedListener('close-terminal-listener'),
            onDidChangeWindowState: () => trackedListener('window-state-listener'),
            onDidChangeVisibleTextEditors: () => trackedListener('visible-editors-listener'),
            onDidChangeActiveTextEditor: () => trackedListener('active-editor-listener'),
            showErrorMessage: async () => undefined, showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined, showInputBox: async () => undefined,
            showQuickPick: async () => undefined, showOpenDialog: async () => undefined,
        },
        workspace: {
            workspaceFile: undefined, workspaceFolders: undefined,
            getConfiguration: () => configuration, updateWorkspaceFolders: () => true,
            onDidChangeConfiguration: () => trackedListener('configuration-listener'),
            onDidChangeWorkspaceFolders: () => trackedListener('workspace-folders-listener'),
            onWillSaveTextDocument: () => trackedListener('save-document-listener'),
            openTextDocument: async () => ({}),
        },
        commands: {
            registerCommand: (command, callback) => {
                registeredCommands.push(command);
                registeredCommandCallbacks.set(command, callback);
                return trackedResource(`command:${command}`);
            },
            executeCommand: async command => {
                executedCommands.push(command);
                if (lifecycle.activationDisposed
                    && (command === '_agentPivotAttention.bridge.publish'
                        || command === '_agentPivotOpenWorkspaces.bridge.publish')) {
                    lifecycle.postDisposePublications.push(command);
                }
                return undefined;
            },
        },
        registeredCommandCallbacks,
        executedCommands,
        env: {
            remoteName: undefined, machineId: 'fixture-machine',
            clipboard: { writeText: async () => undefined }, openExternal: async () => true,
        },
        extensions: { getExtension: () => undefined, all: [] },
    };
}

async function main() {
    const mode = process.argv[2] || 'success';
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'PRIVATE_PATH_CANARY-'));
    const privacyCanaries = [
        storageRoot,
        'PRIVATE_PROJECT_CANARY',
        'PRIVATE_PROMPT_CANARY',
        'PRIVATE_SESSION_CANARY',
        'PRIVATE_PROVIDER_PAYLOAD_CANARY',
        'PRIVATE_RAW_ERROR_CANARY',
    ];
    const lifecycle = {
        activationDisposed: false,
        activeOpenTerminalListeners: 0,
        lateResourceAcquisitions: [],
        openTerminalListenerDisposals: 0,
        outputLines: [],
        postDisposePublications: [],
        postDisposeWebviewMessages: [],
        postedWebviewMessages: [],
    };
    const vscode = createVscode(lifecycle);
    const previousLoad = Module._load;
    const restores = [];
    const events = [];
    const verified = new Set();
    const aliasRebinds = [];
    let simulatedAliasRebind = false;
    let dashboardCommandRegistrationInvocations = 0;
    let attentionShutdownCalls = 0;
    let activationReturnedBeforeDirectRestoreSettled = false;
    let directRestoreSettled = false;
    let initialInactiveRestoreRecorded = false;
    let pendingDirectRestoreEntered = false;
    let releasePendingDirectRestore;
    let pendingTmuxRestoreEntered = false;
    let tmuxRestoreSettled = false;
    let releasePendingTmuxRestore;
    const synchronizedGlobalStateKeySets = [];
    const patch = (prototype, name, replacement) => {
        const original = prototype[name];
        prototype[name] = replacement;
        restores.push(() => { prototype[name] = original; });
    };
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        const loaded = previousLoad.call(this, request, parent, isMain);
        if (parent?.filename === dashboardPath && request === './workspaces/sessionHydrationController') {
            const Original = loaded.WorkspaceSessionHydrationController;
            return {
                ...loaded,
                WorkspaceSessionHydrationController: class extends Original {
                    constructor(...args) {
                        events.push('hydration-constructed');
                        super(...args);
                    }
                },
            };
        }
        return loaded;
    };
    const state = (synchronized = false) => ({
        get: (_key, fallback) => fallback,
        update: async () => undefined,
        ...(synchronized
            ? { setKeysForSync: keys => synchronizedGlobalStateKeySets.push(keys.slice()) }
            : {}),
    });
    const uri = value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value });
    const context = {
        globalStoragePath: storageRoot, globalStorageUri: uri(storageRoot), extensionPath: root,
        extensionUri: uri(root), subscriptions: [], globalState: state(true), workspaceState: state(),
        extension: { packageJSON: { version: '2.1.3' } }, extensionMode: 3,
    };
    let contextSubscriptionsDisposed = false;
    const disposeContextSubscriptions = () => {
        if (contextSubscriptionsDisposed) return;
        contextSubscriptionsDisposed = true;
        lifecycle.activationDisposed = true;
        for (const subscription of context.subscriptions.slice().reverse()) {
            subscription.dispose?.();
        }
    };

    try {
        const TerminalService = require('../../../out/aiSessions/terminalService').default;
        const { DirectTerminalRuntimeBackend } = require('../../../out/aiSessions/directTerminalRuntimeBackend');
        const { AiSessionRuntimeCoordinator } = require('../../../out/aiSessions/runtimeCoordinator');
        const { TmuxAttachBindingStore } = require('../../../out/aiSessions/tmuxAttachBindingStore');
        const { TmuxClient } = require('../../../out/aiSessions/tmuxClient');
        const { TmuxRuntimeBackend } = require('../../../out/aiSessions/tmuxRuntimeBackend');
        const { TmuxRuntimeBindingStore } = require('../../../out/aiSessions/tmuxRuntimeBindingStore');
        const { TmuxRuntimeDiscovery } = require('../../../out/aiSessions/tmuxRuntimeDiscovery');
        const { AiSessionAttentionController } = require('../../../out/aiSessions/attentionController');
        const AttentionBridgeClient = require('../../../out/aiSessions/attentionBridgeClient').default;
        const AiSessionAliasController = require('../../../out/aiSessions/aliasController').default;
        const { DashboardCommandRegistration } = require('../../../out/dashboard/commandRegistration');

        const originalDashboardRegister = DashboardCommandRegistration.prototype.register;
        patch(DashboardCommandRegistration.prototype, 'register', function (...args) {
            dashboardCommandRegistrationInvocations += 1;
            return originalDashboardRegister.apply(this, args);
        });
        patch(AiSessionAliasController.prototype, 'copyForRebind', function (...args) {
            aliasRebinds.push(args);
        });

        patch(TmuxRuntimeDiscovery.prototype, 'loadPersistedInactive', async function () {
            assert.ok(this instanceof TmuxRuntimeDiscovery);
            assert.ok(this.options.client instanceof TmuxClient);
            assert.ok(this.options.bindingStore instanceof TmuxRuntimeBindingStore);
            assert.equal(typeof this.options.onSessionRebound, 'function');
            if (!simulatedAliasRebind) {
                simulatedAliasRebind = true;
                this.options.onSessionRebound(
                    { provider: 'codex', sessionId: 'old-root' },
                    { provider: 'codex', sessionId: 'new-root' }
                );
            }
            verified.add('client-store-discovery');
            verified.add('thread-switch-alias-wiring');
            if (!initialInactiveRestoreRecorded) {
                initialInactiveRestoreRecorded = true;
                events.push('inactive-restored');
            }
        });
        patch(TerminalService.prototype, 'restorePersistedTerminals', async function () {
            assert.ok(this instanceof TerminalService);
            if (mode === 'pending' || mode === 'diagnostics') {
                pendingDirectRestoreEntered = true;
                await new Promise(resolve => {
                    releasePendingDirectRestore = resolve;
                });
            }
            if (mode === 'direct-failure') {
                events.push('direct-failed');
                directRestoreSettled = true;
                throw new Error(privacyCanaries.join(' '));
            }
            events.push('direct-restored');
            directRestoreSettled = true;
        });
        patch(TmuxRuntimeBackend.prototype, 'restoreAttachTerminals', async function () {
            assert.ok(this instanceof TmuxRuntimeBackend);
            assert.ok(this.dependencies.discovery instanceof TmuxRuntimeDiscovery);
            assert.ok(this.dependencies.runtimeStore instanceof TmuxRuntimeBindingStore);
            assert.ok(this.dependencies.attachStore instanceof TmuxAttachBindingStore);
            verified.add('tmux-backend');
            if (mode === 'slow-tmux-restore' || mode === 'slow-tmux-restore-dispose') {
                pendingTmuxRestoreEntered = true;
                await new Promise(resolve => {
                    releasePendingTmuxRestore = resolve;
                });
            }
            events.push('tmux-restored');
            tmuxRestoreSettled = true;
        });
        patch(AiSessionRuntimeCoordinator.prototype, 'getActive', function () {
            assert.ok(this.dependencies.direct instanceof DirectTerminalRuntimeBackend);
            assert.ok(this.dependencies.tmux instanceof TmuxRuntimeBackend);
            verified.add('direct-tmux-coordinator');
            return [];
        });
        patch(AiSessionRuntimeCoordinator.prototype, 'getPending', () => []);
        patch(AiSessionAttentionController.prototype, 'getRecoverySessionEvents', () => []);
        patch(AiSessionAttentionController.prototype, 'evaluate', async () => ({
            enabled: true, published: true, inScopeSessionKeys: [], eventIdsBySession: {}, overflowedSessionKeys: [],
        }));
        const originalAttentionShutdown = AttentionBridgeClient.prototype.shutdown;
        patch(AttentionBridgeClient.prototype, 'shutdown', async function () {
            attentionShutdownCalls += 1;
            if (typeof originalAttentionShutdown === 'function') {
                await originalAttentionShutdown.call(this);
            }
            events.push('attention-shutdown-complete');
        });

        delete require.cache[require.resolve(dashboardPath)];
        const dashboard = require(dashboardPath);
        let failure = null;
        let activationSettled = false;
        const activationFlight = (async () => {
            try {
                await dashboard.activate(context);
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
            }
            activationReturnedBeforeDirectRestoreSettled = !directRestoreSettled;
            events.push('activation-returned');
            activationSettled = true;
        })();
        let dashboardDeactivated = false;
        let readyBeforeTmuxRestoreSettled = false;
        if (mode === 'pending') {
            await waitFor(
                () => pendingDirectRestoreEntered,
                'pending Direct restoration to begin'
            );
            await waitFor(
                () => activationSettled,
                'activation to return while Direct restoration is pending'
            );
        }
        await activationFlight;
        if (mode === 'slow-tmux-restore' || mode === 'slow-tmux-restore-dispose') {
            await waitFor(
                () => pendingTmuxRestoreEntered,
                'pending tmux restoration to begin'
            );
            const deadline = Date.now() + 1_500;
            while (Date.now() < deadline
                && vscode.registeredProvider?.lifecycle?.kind !== 'ready') {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            readyBeforeTmuxRestoreSettled =
                vscode.registeredProvider?.lifecycle?.kind === 'ready'
                && !tmuxRestoreSettled;
            if (mode === 'slow-tmux-restore-dispose' && readyBeforeTmuxRestoreSettled) {
                await dashboard.deactivate();
                events.push('dashboard-deactivated');
                disposeContextSubscriptions();
                dashboardDeactivated = true;
            }
            releasePendingTmuxRestore?.();
            await waitFor(() => tmuxRestoreSettled, 'released tmux restoration to settle');
            if (mode === 'slow-tmux-restore') {
                const refreshDeadline = Date.now() + 1_500;
                while (Date.now() < refreshDeadline
                    && !lifecycle.outputLines.some(line =>
                        line.includes('"reason":"tmux-bootstrap-restore"'))) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                assert.equal(
                    lifecycle.outputLines.some(line =>
                        line.includes('"reason":"tmux-bootstrap-restore"')),
                    true,
                    'Timed out waiting for deferred tmux restoration refresh'
                );
            }
        }
        let pendingOpenRevealedBootShell = false;
        let pendingUnavailableCommandError = null;
        if (failure === null && mode === 'pending') {
            const openCommand = vscode.registeredCommandCallbacks.get('agentPivot.open');
            const addProjectCommand = vscode.registeredCommandCallbacks.get('agentPivot.addProject');
            if (openCommand) {
                await openCommand();
                pendingOpenRevealedBootShell = vscode.executedCommands.includes(
                    'workbench.view.extension.agentPivot'
                ) && vscode.executedCommands.includes('agentPivot.dashboard.focus');
            }
            if (addProjectCommand) {
                try {
                    await addProjectCommand();
                } catch (error) {
                    pendingUnavailableCommandError =
                        error instanceof Error ? error.message : String(error);
                }
            }
        }
        if (failure === null) {
            await waitFor(() => vscode.providerRegistrations === 1, 'provider registration');
            await vscode.providerResolution;
            await waitFor(() => vscode.webviewHtmlHistory.length > 0, 'Webview HTML assignment');
            const generation = vscode.registeredProvider?.lifecycle?.generation;
            if (Number.isSafeInteger(generation) && generation > 0
                && vscode.bootWebviewMessageCallback) {
                await vscode.bootWebviewMessageCallback({
                    type: 'agent-pivot-browser-first-paint',
                    version: 1,
                    generation,
                });
            }
            if (mode === 'diagnostics') {
                releasePendingDirectRestore?.();
            }
            if (mode !== 'pending') {
                await waitFor(
                    () => ['ready', 'failed'].includes(vscode.registeredProvider?.lifecycle?.kind),
                    'dashboard bootstrap completion'
                );
            }
            if (mode === 'success') {
                await waitFor(
                    () => verified.has('direct-tmux-coordinator'),
                    'ready dashboard visibility preparation'
                );
            }
        }
        let inFlightListenerDisposedBeforeGateRelease = false;
        let lateAttentionClientObserved = false;
        if (failure === null && mode === 'pending') {
            const shutdownCallsBeforeDisposal = attentionShutdownCalls;
            await dashboard.deactivate();
            events.push('dashboard-deactivated');
            disposeContextSubscriptions();
            inFlightListenerDisposedBeforeGateRelease =
                lifecycle.activeOpenTerminalListeners === 0;
            releasePendingDirectRestore?.();
            await waitFor(() => directRestoreSettled, 'released Direct restoration to settle');
            await waitFor(
                () => lifecycle.outputLines.includes(
                    'Failed to initialize Agent Pivot dashboard.'
                ) || dashboardCommandRegistrationInvocations > 0,
                'disposed bootstrap to stop or acquire a late command'
            );
            await dashboard.deactivate();
            lateAttentionClientObserved =
                attentionShutdownCalls > shutdownCallsBeforeDisposal;
        } else if (failure === null && !dashboardDeactivated) {
            await dashboard.deactivate();
            events.push('dashboard-deactivated');
        }
        const bootHtmlAssigned = vscode.webviewHtmlHistory.some(
            html => html.includes('data-agent-pivot-boot-card-area')
        );
        const readyHtmlAssignments = vscode.webviewHtmlHistory.filter(
            html => !html.includes('agent-pivot-boot-shell')
        ).length;
        const dashboardDiagnostics = lifecycle.outputLines
            .filter(line => line.startsWith('[Dashboard] '))
            .map(line => JSON.parse(line.slice('[Dashboard] '.length)))
            .map(({ loggedAt: _loggedAt, ...event }) => event);
        const startupDiagnosticEvents = new Set([
            'agent-pivot-activation-entered',
            'agent-pivot-boot-shell-assigned',
            'agent-pivot-browser-first-paint',
            'agent-pivot-bootstrap-phases',
            'agent-pivot-bootstrap-ready',
            'agent-pivot-bootstrap-failed',
            'agent-pivot-bootstrap-tmux-restore-deferred',
            'agent-pivot-bootstrap-tmux-restore-settled',
        ]);
        const startupDiagnostics = dashboardDiagnostics.filter(
            diagnostic => startupDiagnosticEvents.has(diagnostic.event)
        );
        const aiSessionDiagnostics = lifecycle.outputLines
            .filter(line => line.startsWith('[AiSessions] '))
            .map(line => JSON.parse(line.slice('[AiSessions] '.length)));
        process.stdout.write(JSON.stringify({
            activationReturnedBeforeDirectRestoreSettled,
            providerRegistrations: vscode.providerRegistrations,
            bootHtmlAssigned,
            readyHtmlAssignments,
            bootstrapState: vscode.registeredProvider?.lifecycle?.kind || 'unavailable',
            events,
            failure,
            pendingDirectRestoreEntered,
            pendingOpenRevealedBootShell,
            pendingUnavailableCommandError,
            inFlightListenerDisposedBeforeGateRelease,
            openTerminalListenerDisposals: lifecycle.openTerminalListenerDisposals,
            lateResourceAcquisitions: lifecycle.lateResourceAcquisitions,
            postDisposePublications: lifecycle.postDisposePublications,
            postDisposeWebviewMessages: lifecycle.postDisposeWebviewMessages,
            lateAttentionClientObserved,
            pendingTmuxRestoreEntered,
            readyBeforeTmuxRestoreSettled,
            tmuxRestoreRefreshCount: aiSessionDiagnostics.filter(
                diagnostic => diagnostic.event === 'ai-session-message-build'
                    && diagnostic.reason === 'tmux-bootstrap-restore'
            ).length,
            tmuxRestoreDiagnostics: startupDiagnostics.filter(diagnostic =>
                diagnostic.event === 'agent-pivot-bootstrap-tmux-restore-deferred'
                    || diagnostic.event === 'agent-pivot-bootstrap-tmux-restore-settled'),
            rawDirectFailureExposedInHtml: vscode.webviewHtmlHistory.some(
                html => privacyCanaries.some(canary => html.includes(canary))
            ),
            verified: [...verified].sort(),
            registeredCommands: vscode.registeredCommands,
            dashboardCommandRegistrationInvocations,
            aliasRebinds,
            attentionShutdownCalls,
            synchronizedGlobalStateKeySets,
            startupDiagnostics,
        }));
    } finally {
        disposeContextSubscriptions();
        restores.reverse().forEach(restore => restore());
        Module._load = previousLoad;
        fs.rmSync(storageRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
