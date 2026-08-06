'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../../../..');
const dashboardPath = path.join(root, 'out/dashboard.js');
const attentionEventCapabilityPath = path.join(root, 'out/aiSessions/attentionEventCapability.js');

function disposable(dispose = () => undefined) {
    return { dispose };
}

async function waitFor(predicate, label) {
    const timeoutMs = 5_000;
    const startedAtMs = Date.now();
    while (Date.now() - startedAtMs <= timeoutMs) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function createHarnessVscode(listeners, commands) {
    const configuration = { get: (_key, fallback) => fallback, inspect: () => undefined, update: async () => undefined };
    const uri = value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value });
    return {
        ConfigurationTarget: { Global: 1, Workspace: 2 }, ExtensionMode: { Test: 3 }, ViewColumn: { One: 1 },
        Uri: { file: uri, parse: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        window: {
            terminals: [], activeTerminal: null, activeTextEditor: undefined, visibleTextEditors: [],
            createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
            createTerminal: () => ({ name: 'fixture', show: () => undefined, dispose: () => undefined, sendText: () => undefined }),
            registerWebviewViewProvider: (_id, provider) => {
                listeners.viewProvider = provider;
                return disposable();
            },
            registerWebviewPanelSerializer: () => disposable(),
            onDidChangeActiveTerminal: callback => { listeners.activeTerminal = callback; return disposable(); },
            onDidOpenTerminal: () => disposable(),
            onDidCloseTerminal: callback => { listeners.closeTerminal = callback; return disposable(); },
            onDidChangeWindowState: callback => { listeners.windowState = callback; return disposable(); },
            onDidChangeVisibleTextEditors: () => disposable(), onDidChangeActiveTextEditor: () => disposable(),
            showErrorMessage: async () => undefined, showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined, showInputBox: async () => undefined,
            showQuickPick: async () => undefined, showOpenDialog: async () => undefined,
        },
        workspace: {
            workspaceFile: undefined, workspaceFolders: undefined,
            getConfiguration: () => configuration, updateWorkspaceFolders: () => true,
            onDidChangeConfiguration: callback => { listeners.configuration = callback; return disposable(); },
            onDidChangeWorkspaceFolders: callback => { listeners.workspaceFolders = callback; return disposable(); },
            onWillSaveTextDocument: () => disposable(), openTextDocument: async () => ({}),
        },
        commands: {
            registerCommand: (id, callback) => { commands.set(id, callback); return disposable(() => commands.delete(id)); },
            executeCommand: async () => undefined,
        },
        env: {
            remoteName: undefined, machineId: 'fixture-machine',
            clipboard: { writeText: async () => undefined }, openExternal: async () => true,
        },
        extensions: { getExtension: () => undefined, all: [] },
    };
}

function loadTransformedModule(modulePath, transform) {
    const source = transform(fs.readFileSync(modulePath, 'utf8'));
    const loaded = new Module(modulePath, module);
    loaded.filename = modulePath;
    loaded.paths = Module._nodeModulePaths(path.dirname(modulePath));
    loaded._compile(source, modulePath);
    return loaded.exports;
}

function loadDashboard(transform) {
    return loadTransformedModule(dashboardPath, transform);
}

function indexOfCall(calls, name, fromIndex = 0) {
    return calls.findIndex((call, index) => index >= fromIndex && call[0] === name);
}

function indexOfLifecycleTask(calls, operation, fromIndex = 0) {
    return calls.findIndex((call, index) => index >= fromIndex
        && call[0] === 'lifecycle-task' && call[1] === operation);
}

function replaceOnce(source, needle, replacement, _label) {
    if (!source.includes(needle)) {
        return source;
    }
    return source.replace(needle, replacement);
}

// Each mutation's needle lives in exactly one of the transformed modules
// (dashboard.js or attentionEventCapability.js); trackTransform asserts the
// mutation landed somewhere after every module was compiled.
function trackTransform(label, transform) {
    const tracked = source => {
        const next = transform(source);
        if (next !== source) {
            tracked.applied = true;
        }
        return next;
    };
    tracked.applied = false;
    tracked.assertApplied = () => assert.ok(tracked.applied,
        `controlled mutation must find the production needle for ${label}`);
    return tracked;
}

const mutations = {
    'completion-suppression': {
        scenario: 'baseline',
        transform: source => replaceOnce(
            source,
            'getRuntimeCoordinator().handleClosedTerminal(terminal);',
            'getRuntimeCoordinator().handleClosedTerminal(terminal);'
                + '\n            getAttentionController().suppressRuntimeCompletion(\'synthetic-exit\');',
            'callback',
        ),
    },
    'acknowledge-order': {
        scenario: 'user-close',
        transform: source => replaceOnce(
            source,
            'getAttentionController().acknowledge(uniqueEventIds);\n'
                + '        refreshAiSessionViewsIncrementally();\n'
                + '        yield aiSessionAttentionBridgeClient.acknowledge(uniqueEventIds);',
            'getAttentionController().acknowledge(uniqueEventIds);\n'
                + '        yield aiSessionAttentionBridgeClient.acknowledge(uniqueEventIds);\n'
                + '        refreshAiSessionViewsIncrementally();',
            'acknowledgement ordering',
        ),
    },
    'attention-state-before-render': {
        scenario: 'attention-state-order',
        transform: source => replaceOnce(
            source,
            'currentAiSessionRefreshReason = reason;\n'
                + '                        postAiSessionAttentionState();',
            'currentAiSessionRefreshReason = reason;',
            'attention state publication',
        ),
    },
    'aggregate-auto-acknowledge': {
        scenario: 'remote-aggregate',
        transform: source => replaceOnce(
            source,
            'if (getAttentionController().setRemoteAggregate(aggregate)) {',
            'getAttentionController().getReleasedSessions()'
                + '.forEach(() => getAttentionController().acknowledge([\'synthetic-released\']));\n'
                + '            if (getAttentionController().setRemoteAggregate(aggregate)) {',
            'bridge aggregate callback',
        ),
    },
    'aggregate-refresh-skipped': {
        scenario: 'remote-aggregate',
        transform: source => replaceOnce(
            source,
            'if (getAttentionController().setRemoteAggregate(aggregate)) {\n'
                + '                scheduleAttentionViewsRefresh();\n'
                + '            }',
            'if (getAttentionController().setRemoteAggregate(aggregate)) {\n'
                + '            }',
            'aggregate refresh scheduling',
        ),
    },
    'completion-queue-skipped': {
        scenario: 'highlighter-completion',
        transform: source => replaceOnce(
            source,
            'if (!resolution.entry.runtimeIdentity) {',
            'if (true) {',
            'completion identity guard',
        ),
    },
    'active-terminal-bare-evaluate': {
        scenario: 'active-terminal',
        transform: source => replaceOnce(
            source,
            'void runSafeAiSessionRuntimeLifecycleTask(\'evaluate-attention-active-terminal\', evaluateAiSessionAttention);',
            'void evaluateAiSessionAttention();',
            'active terminal lifecycle task',
        ),
    },
    'close-tick-skipped': {
        scenario: 'baseline',
        transform: source => replaceOnce(
            source,
            'getRuntimeCoordinator().handleClosedTerminal(terminal);\n'
                + '            evaluateAiSessionLifecycleTick();',
            'getRuntimeCoordinator().handleClosedTerminal(terminal);',
            'close handler lifecycle tick',
        ),
    },
};

async function runTerminalCloseContract(transform = source => source, scenario = 'baseline') {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-close-wiring-'));
    const listeners = {};
    const commands = new Map();
    const vscode = createHarnessVscode(listeners, commands);
    const previousLoad = Module._load;
    const calls = [];
    let activeFixtures = [];
    let bridgeAggregateHandler = null;
    let highlighterOptions = null;
    const restores = [];
    const patchMethod = (prototype, name, replacement) => {
        const original = prototype[name];
        prototype[name] = replacement;
        restores.push(() => { prototype[name] = original; });
    };
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        const fromHarness = Boolean(parent && parent.filename === __filename);
        if (!fromHarness && request.endsWith('aiSessions/attentionBridgeClient')) {
            const AttentionBridgeClient = attentionBridgeClientModule.default;
            return {
                ...attentionBridgeClientModule,
                default: class extends AttentionBridgeClient {
                    constructor(onAggregate, onError, options) {
                        super(onAggregate, onError, options);
                        bridgeAggregateHandler = onAggregate;
                    }
                },
            };
        }
        if (!fromHarness && request.endsWith('aiSessions/attentionEventCapability')) {
            return loadTransformedModule(attentionEventCapabilityPath, transform);
        }
        if (!fromHarness && request.endsWith('aiSessions/runtimeSettlementCapability')) {
            return {
                ...runtimeSettlementModule,
                createAiSessionRuntimeSettlementCapability: options => {
                    const capability = runtimeSettlementModule
                        .createAiSessionRuntimeSettlementCapability(options);
                    const queueSettlements = capability.queueSettlements;
                    const runSafeLifecycleTask = capability.runSafeLifecycleTask;
                    capability.queueSettlements = settlements => {
                        calls.push(['queue-settlements', settlements]);
                        return queueSettlements(settlements);
                    };
                    capability.runSafeLifecycleTask = (operation, task) => {
                        calls.push(['lifecycle-task', operation]);
                        return runSafeLifecycleTask(operation, task);
                    };
                    return capability;
                },
            };
        }
        if (!fromHarness && request.endsWith('aiSessions/statusCapability')) {
            return {
                ...statusCapabilityModule,
                createAiSessionStatusCapability: options => {
                    const capability = statusCapabilityModule.createAiSessionStatusCapability(options);
                    const tick = capability.tick;
                    capability.tick = () => {
                        calls.push(['lifecycle-tick']);
                        return tick();
                    };
                    return capability;
                },
            };
        }
        if (!fromHarness && request.endsWith('aiSessions/activeTerminalHighlight')) {
            const ActiveAiSessionTerminalHighlighter = activeTerminalHighlightModule.default;
            return {
                ...activeTerminalHighlightModule,
                default: class extends ActiveAiSessionTerminalHighlighter {
                    constructor(options) {
                        super(options);
                        highlighterOptions = options;
                    }
                },
            };
        }
        return previousLoad.call(this, request, parent, isMain);
    };
    const attentionBridgeClientModule = require('../../../../out/aiSessions/attentionBridgeClient');
    const runtimeSettlementModule = require('../../../../out/aiSessions/runtimeSettlementCapability');
    const statusCapabilityModule = require('../../../../out/aiSessions/statusCapability');
    const activeTerminalHighlightModule = require('../../../../out/aiSessions/activeTerminalHighlight');
    const state = (synchronized = false) => ({
        get: (_key, fallback) => fallback,
        update: async () => undefined,
        ...(synchronized ? { setKeysForSync: () => undefined } : {}),
    });
    const uri = value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value });
    const context = {
        globalStoragePath: storageRoot, globalStorageUri: uri(storageRoot),
        extensionPath: root, extensionUri: uri(root),
        subscriptions: [], globalState: state(true), workspaceState: state(),
        extension: { packageJSON: { version: '2.1.3' } }, extensionMode: 3,
    };

    try {
        const { AiSessionRuntimeCoordinator } = require('../../../../out/aiSessions/runtimeCoordinator');
        const ActiveAiSessionTerminalHighlighter = require('../../../../out/aiSessions/activeTerminalHighlight').default;
        const { AiSessionAttentionController } = require('../../../../out/aiSessions/attentionController');
        const { AiSessionDashboardController } = require('../../../../out/aiSessions/dashboardController');
        const { AiSessionTerminalCommandController } = require(
            '../../../../out/aiSessions/terminalCommandController'
        );
        const AttentionBridgeClient = require('../../../../out/aiSessions/attentionBridgeClient').default;
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'getActive', function () { return activeFixtures; });
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'getPending', function () { return []; });
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'handleClosedTerminal', terminal => {
            calls.push(['runtime-close', terminal]);
        });
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'getById', function () {
            return activeFixtures.length === 1 ? activeFixtures[0] : null;
        });
        patchMethod(AiSessionRuntimeCoordinator.prototype, 'detach', async identity => {
            calls.push(['runtime-detach', identity]);
        });
        patchMethod(ActiveAiSessionTerminalHighlighter.prototype, 'handleTerminalClosed', terminal => {
            calls.push(['highlight-close', terminal]);
        });
        const originalHighlightSync = ActiveAiSessionTerminalHighlighter.prototype.sync;
        patchMethod(ActiveAiSessionTerminalHighlighter.prototype, 'sync', function (...args) {
            calls.push(['highlight-sync']);
            return originalHighlightSync.apply(this, args);
        });
        patchMethod(AiSessionAttentionController.prototype, 'getRecoverySessionEvents', () => [{
            sessionKey: 'codex:session', eventIds: ['attention-event'],
        }]);
        patchMethod(AiSessionAttentionController.prototype, 'getAttentionEventIds', () => ['attention-event']);
        patchMethod(AiSessionAttentionController.prototype, 'acknowledge', eventIds => {
            calls.push(['local-acknowledge', eventIds]);
        });
        patchMethod(AiSessionAttentionController.prototype, 'setRemoteAggregate', aggregate => {
            calls.push(['set-remote-aggregate', aggregate]);
            return true;
        });
        patchMethod(AiSessionAttentionController.prototype, 'getReleasedSessions', () => {
            calls.push(['released-sessions']);
            return [{ sessionKey: 'codex:session', eventIds: ['released-event'] }];
        });
        patchMethod(AiSessionAttentionController.prototype, 'suppressRuntimeCompletion', attentionKey => {
            calls.push(['suppress-runtime-completion', attentionKey]);
        });
        patchMethod(AiSessionAttentionController.prototype, 'restoreRuntimeCompletion', attentionKey => {
            calls.push(['restore-runtime-completion', attentionKey]);
        });
        patchMethod(AiSessionAttentionController.prototype, 'evaluate', async () => {
            calls.push(['attention-evaluate']);
            return { enabled: true, published: true, inScopeSessionKeys: [], eventIdsBySession: {}, overflowedSessionKeys: [] };
        });
        patchMethod(AttentionBridgeClient.prototype, 'acknowledge', async eventIds => {
            calls.push(['bridge-acknowledge', eventIds]);
        });
        const originalRefreshNow = AiSessionDashboardController.prototype.refreshNow;
        patchMethod(AiSessionDashboardController.prototype, 'refreshNow', function (...args) {
            calls.push(['refresh', args[0] || 'refresh']);
            return originalRefreshNow.apply(this, args);
        });
        const originalScheduleRefresh = AiSessionDashboardController.prototype.scheduleRefresh;
        patchMethod(AiSessionDashboardController.prototype, 'scheduleRefresh', function (...args) {
            calls.push(['schedule-refresh', args[0] || 'refresh']);
            return originalScheduleRefresh.apply(this, args);
        });
        if (scenario === 'explicit-close' || scenario === 'explicit-detach') {
            patchMethod(AiSessionTerminalCommandController.prototype, 'closeTerminal', async function () {
                const runtime = activeFixtures[0];
                this.options.onRuntimeCloseStart?.(runtime);
                calls.push(['runtime-detach', runtime.identity]);
                this.options.onRuntimeCloseEnd?.(runtime, true);
            });
        }
        if (scenario === 'explicit-terminate') {
            patchMethod(AiSessionTerminalCommandController.prototype, 'stopSession', async function () {
                const runtime = activeFixtures[0];
                this.options.onRuntimeCloseStart?.(runtime);
                calls.push(['runtime-terminate', runtime.identity]);
                this.options.onRuntimeCloseEnd?.(runtime, true);
            });
        }

        const dashboard = loadDashboard(transform);
        await dashboard.activate(context);
        if (typeof transform.assertApplied === 'function') {
            transform.assertApplied();
        }
        await waitFor(() => listeners.closeTerminal, 'terminal close listener registration');
        assert.equal(typeof listeners.closeTerminal, 'function',
            'ATTENTION-RUNTIME-EXIT-NEUTRAL-001 production activation must register terminal close');
        const terminal = {
            name: 'tracked fixture terminal',
            exitStatus: scenario === 'user-close'
                ? { code: undefined, reason: 3 }
                : { code: 0, reason: 2 },
        };

        if (scenario === 'attention-state-order') {
            const postedMessages = [];
            const webview = {
                options: {}, html: '', cspSource: 'fixture', asWebviewUri: value => value,
                onDidReceiveMessage: () => disposable(),
                postMessage: async message => {
                    postedMessages.push(message);
                    return true;
                },
            };
            const view = { visible: true, webview, onDidChangeVisibility: () => disposable() };
            await listeners.viewProvider.resolveWebviewView(view, {}, {});
            const messageMark = postedMessages.length;
            listeners.activeTerminal(terminal);
            await waitFor(
                () => postedMessages.slice(messageMark)
                    .some(message => message && message.type === 'ai-sessions-updated'),
                'incremental AI-session render after the active terminal change',
            );
            const renderedMessages = postedMessages.slice(messageMark);
            const attentionStateIndex = renderedMessages
                .findIndex(message => message && message.type === 'ai-session-attention-state');
            const updateIndex = renderedMessages
                .findIndex(message => message && message.type === 'ai-sessions-updated');
            assert.ok(attentionStateIndex >= 0,
                'WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001 every incremental render must publish the current attention event map');
            assert.ok(updateIndex > attentionStateIndex,
                'WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001 the attention event map must reach the webview before the HTML update');
            assert.deepEqual(renderedMessages[attentionStateIndex].sessionEvents,
                [{ sessionKey: 'codex:session', eventIds: ['attention-event'] }],
                'WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001 the attention state must carry every recovery session event');
            assert.deepEqual(renderedMessages[attentionStateIndex].eventIds, ['attention-event'],
                'WEBVIEW-AI-SESSION-DASHBOARD-CONTROLLER-001 the attention state must carry the current attention event ids');
            return calls;
        }

        if (scenario === 'remote-aggregate') {
            assert.equal(typeof bridgeAggregateHandler, 'function',
                'ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 the dashboard must hand the bridge client an aggregate callback');
            const aggregate = { protocolVersion: 1, semanticRevision: 7, sessions: [] };
            const aggregateMark = calls.length;
            bridgeAggregateHandler(aggregate);
            assert.ok(calls.slice(aggregateMark)
                .some(call => call[0] === 'set-remote-aggregate' && call[1] === aggregate),
                'ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 a bridge aggregate must reach the attention controller');
            assert.ok(calls.slice(aggregateMark)
                .some(call => call[0] === 'schedule-refresh' && call[1] === 'attention'),
                'ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 a bridge aggregate must schedule an attention views refresh');
            assert.equal(calls.slice(aggregateMark).some(call => call[0] === 'released-sessions'), false,
                'ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 a later aggregate must not scan released sessions');
            assert.equal(calls.slice(aggregateMark)
                .some(call => call[0] === 'local-acknowledge' || call[0] === 'bridge-acknowledge'), false,
                'ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 a later aggregate must not auto-acknowledge a delivered completion');
            return calls;
        }

        if (scenario === 'highlighter-completion') {
            assert.ok(highlighterOptions && typeof highlighterOptions.onComplete === 'function',
                'ATTENTION-EXECUTION-STATE-SYNC-001 the dashboard must wire the highlighter completion callback');
            const completionTerminal = { name: 'completed fixture terminal' };
            const runtimeIdentity = {
                provider: 'codex',
                sessionId: 'session',
                workspaceScopeIdentity: 'a'.repeat(64),
                workspaceNavigationIdentity: 'navigation:fixture',
                workspaceRootHostPaths: ['/fixture'],
                cwd: '/fixture',
            };
            const completionMark = calls.length;
            highlighterOptions.onComplete({
                terminal: completionTerminal,
                entry: { runtimeIdentity, markerPath: '/fixture/marker', runStartedAtMs: 42 },
            });
            const queueCall = calls.slice(completionMark).find(call => call[0] === 'queue-settlements');
            assert.ok(queueCall,
                'ATTENTION-EXECUTION-STATE-SYNC-001 a terminal completion must queue a runtime settlement');
            assert.equal(queueCall[1].length, 1,
                'ATTENTION-EXECUTION-STATE-SYNC-001 one completion must queue exactly one settlement');
            assert.deepEqual(queueCall[1][0], {
                identity: runtimeIdentity,
                backend: 'vscode',
                state: 'completed',
                markerPath: '/fixture/marker',
                runStartedAtMs: 42,
                attached: true,
                terminal: completionTerminal,
            }, 'ATTENTION-EXECUTION-STATE-SYNC-001 the settlement must carry the completed runtime snapshot');
            const guardMark = calls.length;
            highlighterOptions.onComplete({
                terminal: completionTerminal,
                entry: { runtimeIdentity: null, markerPath: '/fixture/marker', runStartedAtMs: 42 },
            });
            assert.equal(calls.slice(guardMark).some(call => call[0] === 'queue-settlements'), false,
                'ATTENTION-EXECUTION-STATE-SYNC-001 a completion without a runtime identity must not queue a settlement');
            return calls;
        }

        if (scenario === 'active-terminal') {
            const activeMark = calls.length;
            listeners.activeTerminal(terminal);
            await waitFor(
                () => indexOfCall(calls, 'attention-evaluate', activeMark) >= 0,
                'active terminal attention evaluation',
            );
            const highlightSyncIndex = indexOfCall(calls, 'highlight-sync', activeMark);
            const refreshIndex = indexOfCall(calls, 'refresh', activeMark);
            const lifecycleTaskIndex = indexOfLifecycleTask(calls, 'evaluate-attention-active-terminal', activeMark);
            const evaluateIndex = indexOfCall(calls, 'attention-evaluate', activeMark);
            assert.ok(highlightSyncIndex >= activeMark,
                'WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 an active terminal change must sync the highlighter');
            assert.ok(refreshIndex > highlightSyncIndex,
                'WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 the highlighter sync must precede the incremental refresh');
            assert.ok(lifecycleTaskIndex > refreshIndex,
                'WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 the attention evaluation must be routed through the safe lifecycle task');
            assert.ok(evaluateIndex > lifecycleTaskIndex,
                'WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 a bare fire-and-forget evaluation must not replace the lifecycle task');
            return calls;
        }

        activeFixtures = [{
            backend: 'vscode', terminal, state: 'active', runStartedAtMs: 1,
            identity: {
                provider: 'codex',
                sessionId: 'session',
                workspaceScopeIdentity: 'a'.repeat(64),
                workspaceNavigationIdentity: 'navigation:fixture',
                workspaceRootHostPaths: ['/fixture'],
                cwd: '/fixture',
            },
        }];
        listeners.closeTerminal(terminal);
        await waitFor(
            () => calls.some(call => call[0] === 'runtime-close')
                && calls.some(call => call[0] === 'highlight-close')
                && calls.some(call => call[0] === 'attention-evaluate'),
            'terminal close lifecycle effects',
        );
        assert.ok(calls.some(call => call[0] === 'runtime-close'));
        assert.ok(calls.some(call => call[0] === 'highlight-close'));
        if (scenario === 'user-close') {
            await waitFor(
                () => calls.some(call => call[0] === 'local-acknowledge')
                    && calls.some(call => call[0] === 'bridge-acknowledge'),
                'user terminal close attention acknowledgement',
            );
            const suppressionIndex = calls.findIndex(call => call[0] === 'suppress-runtime-completion');
            const runtimeCloseIndex = calls.findIndex(call => call[0] === 'runtime-close');
            const localAcknowledgeIndex = calls.findIndex(call => call[0] === 'local-acknowledge');
            assert.equal(suppressionIndex, -1,
                'ATTENTION-RUNTIME-EXIT-NEUTRAL-001 runtime exit must never suppress completion attention');
            assert.ok(localAcknowledgeIndex > runtimeCloseIndex,
                'ATTENTION-USER-TERMINAL-CLOSE-001 must acknowledge after the user close is observed');
            const refreshAfterAcknowledgeIndex = indexOfCall(calls, 'refresh', localAcknowledgeIndex);
            const bridgeAcknowledgeIndex = indexOfCall(calls, 'bridge-acknowledge');
            assert.ok(refreshAfterAcknowledgeIndex > localAcknowledgeIndex,
                'ATTENTION-USER-TERMINAL-CLOSE-001 acknowledgement must refresh the local view before waiting for the cross-window bridge');
            assert.ok(bridgeAcknowledgeIndex > refreshAfterAcknowledgeIndex,
                'ATTENTION-USER-TERMINAL-CLOSE-001 the cross-window bridge must be awaited only after the local refresh');
            const acknowledgeTaskIndex = indexOfLifecycleTask(calls, 'acknowledge-user-terminal-close');
            assert.ok(acknowledgeTaskIndex >= 0 && acknowledgeTaskIndex < localAcknowledgeIndex,
                'ATTENTION-USER-TERMINAL-CLOSE-001 acknowledgement must run inside the guarded lifecycle task');
        } else {
            assert.equal(calls.some(call => call[0] === 'suppress-runtime-completion'), false,
                'ATTENTION-RUNTIME-EXIT-NEUTRAL-001 runtime exit must never suppress completion attention');
            assert.equal(calls.some(call => call[0] === 'local-acknowledge' || call[0] === 'bridge-acknowledge'), false,
                'ATTENTION-RUNTIME-EXIT-NEUTRAL-001 process exit must not acknowledge unread attention');
            const runtimeCloseIndex = indexOfCall(calls, 'runtime-close');
            const highlightCloseIndex = indexOfCall(calls, 'highlight-close', runtimeCloseIndex);
            const lifecycleTickIndex = indexOfCall(calls, 'lifecycle-tick', runtimeCloseIndex);
            assert.ok(lifecycleTickIndex > runtimeCloseIndex && lifecycleTickIndex < highlightCloseIndex,
                'ATTENTION-RUNTIME-EXIT-NEUTRAL-001 terminal close must re-run the lifecycle tick right after runtime close handling');
            assert.equal(calls[highlightCloseIndex][1], terminal,
                'WEBVIEW-ACTIVE-AI-SESSION-TERMINAL-HIGHLIGHT-001 the highlighter must observe the exact closed terminal');
        }
        if (scenario === 'explicit-close' || scenario === 'explicit-detach' || scenario === 'explicit-terminate') {
            if (scenario === 'explicit-detach' || scenario === 'explicit-terminate') {
                activeFixtures[0] = {
                    ...activeFixtures[0],
                    backend: 'tmux',
                    tmux: { layout: 'project', sessionName: 'project', windowName: 'session' },
                };
            }
            let onMessage;
            const webview = {
                options: {}, html: '', cspSource: 'fixture', asWebviewUri: value => value,
                onDidReceiveMessage: callback => { onMessage = callback; return disposable(); },
                postMessage: async () => true,
            };
            const view = { visible: false, webview, onDidChangeVisibility: () => disposable() };
            await listeners.viewProvider.resolveWebviewView(view, {}, {});
            assert.equal(typeof onMessage, 'function');
            await onMessage({
                type: scenario === 'explicit-detach'
                    ? 'detach-ai-session-terminal'
                    : scenario === 'explicit-terminate'
                        ? 'stop-ai-session-runtime'
                        : 'close-ai-session-terminal',
                projectId: '__currentWorkspace',
                provider: 'codex',
                sessionId: 'session',
            });
            const actionCall = scenario === 'explicit-terminate' ? 'runtime-terminate' : 'runtime-detach';
            await waitFor(
                () => calls.some(call => call[0] === actionCall)
                    && calls.some(call => call[0] === 'local-acknowledge'),
                'explicit runtime close attention acknowledgement',
            );
            const suppressionIndex = calls.findIndex(call => call[0] === 'suppress-runtime-completion');
            const actionIndex = calls.findIndex(call => call[0] === actionCall);
            const localAcknowledgeIndex = calls.findIndex(call => call[0] === 'local-acknowledge');
            assert.equal(suppressionIndex, -1,
                'ATTENTION-RUNTIME-EXIT-NEUTRAL-001 explicit runtime actions must not suppress completion attention');
            assert.ok(localAcknowledgeIndex > actionIndex,
                'ATTENTION-EXPLICIT-SESSION-CLOSE-001 must acknowledge only after the confirmed runtime action succeeds');
            assert.equal(calls.some(call => call[0] === 'restore-runtime-completion'), false);
        }
        return calls;
    } finally {
        for (const subscription of context.subscriptions.slice().reverse()) subscription.dispose?.();
        await new Promise(resolve => setImmediate(resolve));
        restores.reverse().forEach(restore => restore());
        Module._load = previousLoad;
        fs.rmSync(storageRoot, { recursive: true, force: true });
    }
}

const mode = process.argv[2] || 'baseline';
const mutationName = mode === 'mutation'
    ? 'completion-suppression'
    : (mode.startsWith('mutation:') ? mode.slice('mutation:'.length) : null);
const mutation = mutationName ? mutations[mutationName] : null;
assert.ok(!mutationName || mutation, `unknown mutation ${mutationName}`);
const scenario = mutation ? mutation.scenario : mode;
const transform = mutation ? trackTransform(mutationName, mutation.transform) : source => source;

runTerminalCloseContract(transform, scenario).catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
