'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const configurationReads = [];
const configurationFixture = { marker: 'agent-pivot-configuration' };
const originalLoad = Module._load;
Module._load = function loadWithVscodeFixture(request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration(section, scope) {
                    configurationReads.push([section, scope]);
                    return configurationFixture;
                },
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const configuration = require('../../out/dashboard/configuration');
Module._load = originalLoad;
const constants = require('../../out/constants');
const { shouldOpenAgentPivotOnStartup } = require('../../out/dashboard/startup');
const { DashboardLifecycleController } = require('../../out/dashboard/lifecycleController');
const { DashboardRuntimeController } = require('../../out/dashboard/runtimeController');
const { DashboardCommandRegistration } = require('../../out/dashboard/commandRegistration');
const {
    ActiveTerminalFileReferenceController,
    formatFileReference,
    getPrimarySelectionLineRange,
} = require('../../out/dashboard/activeTerminalFileReference');

function configured(values = {}, members = {}) {
    return {
        ...members,
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
        },
        inspect(key) {
            return Object.prototype.hasOwnProperty.call(values, key) ? { globalValue: values[key] } : undefined;
        },
    };
}

function flushAsync() {
    return new Promise(resolve => setImmediate(resolve));
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

test('SESSION-CONFIGURATION-001 reads only the scoped Agent Pivot configuration', () => {
    const scope = { uri: 'fixture://workspace' };
    assert.equal(configuration.getAgentPivotConfiguration(scope), configurationFixture);
    assert.deepEqual(configurationReads, [['agentPivot', scope]]);

    const constantsSource = fs.readFileSync(path.resolve(__dirname, '../../src/constants.ts'), 'utf8');
    const configurationSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/dashboard/configuration.ts'),
        'utf8'
    );
    const lifecycleSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/dashboard/lifecycleController.ts'),
        'utf8'
    );
    assert.equal(constants.AGENT_PIVOT_CONFIG_SECTION, 'agentPivot');
    assert.equal(constantsSource.includes('LEGACY_DASHBOARD_CONFIG_SECTION'), false);
    assert.equal(configurationSource.includes('LEGACY_DASHBOARD_CONFIG_SECTION'), false);
    assert.equal(configurationSource.includes("getConfiguration('dashboard')"), false);
    assert.equal(lifecycleSource.includes("affectsConfiguration('dashboard')"), false);
    assert.equal(lifecycleSource.includes("'dashboard.storeProjectsInSettings'"), false);
});

test('SESSION-STARTUP-001 preserves reopen, always, never, and genuinely empty-workspace startup behavior', () => {
    const decide = input => shouldOpenAgentPivotOnStartup({
        reopenReason: 0, reopenNoneValue: 0, openOnStartup: 'empty workspace',
        workspaceName: '', visibleEditorLanguageIds: [], ...input,
    });
    assert.equal(decide({ reopenReason: 1, openOnStartup: 'never', workspaceName: 'project' }), true);
    assert.equal(decide({ openOnStartup: 'always', workspaceName: 'project' }), true);
    assert.equal(decide({ openOnStartup: 'never' }), false);
    assert.equal(decide({}), true);
    assert.equal(decide({ visibleEditorLanguageIds: ['code-runner-output'] }), true);
    assert.equal(decide({ visibleEditorLanguageIds: ['typescript'] }), false);
    assert.equal(decide({ visibleEditorLanguageIds: ['code-runner-output', 'typescript'] }), false);
    assert.equal(decide({ workspaceName: 'project' }), false);
    assert.equal(decide({ openOnStartup: 'unrecognized' }), true);
});

function runtimeHarness(overrides = {}) {
    const events = [];
    let visible = true;
    const options = {
        isVisible: () => visible,
        refreshProvider: () => events.push(['refresh']),
        logDashboardDiagnostic: value => events.push(['diagnostic', value]),
        executeCommand: async (command, ...args) => events.push(['command', command, ...args]),
        viewType: 'fixture.view',
        publishOpenWorkspace: () => events.push(['publish']),
        getCurrentSavedProject: () => ({ id: 'project', path: '/work' }),
        syncProjectColorToCurrentWindow: async project => events.push(['color', project?.id || null]),
        postMessage: async message => events.push(['message', message]),
        logError: (message, error) => events.push(['error', message, error.message]),
        ...overrides,
    };
    return {
        controller: new DashboardRuntimeController(options),
        events,
        setVisible(value) { visible = value; },
    };
}

test('RUNTIME-DASHBOARD-RUNTIME-CONTROLLER-001 refreshes and reveals only through the stable production command boundary', async () => {
    const harness = runtimeHarness();
    harness.controller.refresh('manual');
    harness.setVisible(false);
    harness.controller.refresh('hidden');
    harness.setVisible(true);
    await harness.controller.showAgentPivot();
    await harness.controller.openSettings();

    assert.deepEqual(harness.events, [
        ['diagnostic', { event: 'full-refresh', reason: 'manual' }],
        ['refresh'],
        ['publish'],
        ['command', 'workbench.view.extension.agentPivot'],
        ['command', 'fixture.view.focus'],
        ['diagnostic', { event: 'full-refresh', reason: 'show-agent-pivot' }],
        ['refresh'],
        ['command', 'workbench.action.openSettings', '@ext:hzcheng.agent-pivot'],
    ]);

    const attempts = [];
    const retry = runtimeHarness({
        executeCommand(command) {
            attempts.push(command);
            if (command === 'fixture.view.focus' && attempts.filter(value => value === command).length === 1) {
                return Promise.reject(new Error('focus race'));
            }
            return Promise.resolve();
        },
    });
    await retry.controller.revealAgentPivotDashboard();
    assert.deepEqual(attempts, [
        'workbench.view.extension.agentPivot', 'fixture.view.focus', 'fixture.view.focus',
    ]);

    const revealThrows = runtimeHarness({ executeCommand: () => { throw new Error('reveal failed'); } });
    await assert.doesNotReject(revealThrows.controller.revealAgentPivotDashboard());
});

test('RUNTIME-DASHBOARD-RUNTIME-CONTROLLER-001 publishes exact batch, terminal, mutation, color, and visibility effects', async () => {
    const harness = runtimeHarness();
    const batch = { type: 'ai-session-batch-archive-completed', archived: 2 };
    harness.controller.postBatchArchiveCompletion(batch);
    harness.controller.postActiveAiSessionTerminalChanged({ provider: 'codex', sessionId: 's1' });
    harness.controller.postActiveAiSessionTerminalChanged(null);
    harness.controller.applyProjectColorToCurrentWindow();
    harness.controller.applyProjectColorToCurrentWindow({ id: 'save', showSaveAction: true });
    harness.controller.refreshAfterMutation('saved');
    await flushAsync();

    assert.deepEqual(harness.events, [
        ['message', batch],
        ['message', { type: 'active-ai-session-terminal-changed', provider: 'codex', sessionId: 's1' }],
        ['message', { type: 'active-ai-session-terminal-changed', provider: null, sessionId: null }],
        ['color', 'project'],
        ['color', 'save'],
        ['color', 'project'],
        ['diagnostic', { event: 'full-refresh', reason: 'saved' }],
        ['refresh'],
        ['publish'],
    ]);

    const visibleEffects = [];
    const visibility = runtimeHarness({
        refreshAiSessionRuntimes: async (reason, force) => visibleEffects.push([reason, force]),
    });
    await visibility.controller.handleAiSessionViewVisibilityChanged(false);
    await visibility.controller.handleAiSessionViewVisibilityChanged(true);
    assert.deepEqual(visibleEffects, [['dashboard-visible', true]]);
});

test('RUNTIME-DASHBOARD-RUNTIME-CONTROLLER-001 maps rejected promises and synchronous throws to stable diagnostics', async () => {
    for (const mode of ['reject', 'throw']) {
        const errors = [];
        const fail = () => {
            const error = new Error(`${mode} failure`);
            if (mode === 'throw') throw error;
            return Promise.reject(error);
        };
        const controller = new DashboardRuntimeController({
            isVisible: () => true, refreshProvider() {}, logDashboardDiagnostic() {},
            executeCommand: async () => undefined, viewType: 'fixture.view', publishOpenWorkspace() {},
            getCurrentSavedProject: () => ({ id: 'project' }), syncProjectColorToCurrentWindow: fail,
            postMessage: fail,
            logError: (message, error) => errors.push([message, error.message]),
        });
        controller.postBatchArchiveCompletion({ type: 'batch' });
        controller.postActiveAiSessionTerminalChanged(null);
        controller.applyProjectColorToCurrentWindow();
        await flushAsync();
        assert.deepEqual(errors, [
            ['Failed to post batch AI session archive completion.', `${mode} failure`],
            ['Failed to post the active AI session terminal.', `${mode} failure`],
            ['Failed to apply project color to current window.', `${mode} failure`],
        ]);
    }
});

test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 composes prepared visibility with incremental session refresh', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/dashboard.ts'),
        'utf8'
    );
    assert.match(
        dashboardSource,
        /onVisiblePrepared:\s*\(\)\s*=>\s*[\r\n\s]*aiSessionDashboardController\.refreshNow\('dashboard-visible',\s*\{[\r\n\s]*fallbackToFullRefresh:\s*false,[\r\n\s]*\}\)/
    );
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 production activation registers one provider before background bootstrap', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/dashboard.ts'),
        'utf8'
    );
    const activateStart = dashboardSource.indexOf(
        'export async function activate(context: vscode.ExtensionContext): Promise<void> {'
    );
    const deactivateStart = dashboardSource.indexOf(
        'export async function deactivate(): Promise<void>'
    );
    const initializeStart = dashboardSource.indexOf(
        'async function initializeDashboard(',
        activateStart
    );
    const activationSource = dashboardSource.slice(activateStart, initializeStart);
    const providerRegistration = activationSource.indexOf('registerWebviewViewProvider(');
    const backgroundBootstrapStart = activationSource.indexOf('bootstrapController.start();');

    assert.ok(activateStart >= 0);
    assert.ok(initializeStart > activateStart);
    assert.ok(deactivateStart > activateStart);
    assert.ok(providerRegistration >= 0);
    assert.ok(backgroundBootstrapStart > providerRegistration);
    assert.doesNotMatch(
        activationSource,
        /await\s+dashboardStartupController\.startUp\(\)/
    );
    assert.equal(
        (dashboardSource.match(/registerWebviewViewProvider\(/g) || []).length,
        1
    );
});

test('WEBVIEW-DASHBOARD-STARTUP-CONTROLLER-001 production startup uses the bootstrap generation liveness guard', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/dashboard.ts'),
        'utf8'
    );

    assert.match(
        dashboardSource,
        /new DashboardStartupController\(\{[\s\S]*?assertActive:\s*\(\)\s*=>\s*resources\.assertActive\(\),[\s\S]*?\}\);/
    );
});

test('PERSIST-DASHBOARD-LIFECYCLE-CONTROLLER-001 production configuration listener owns async rejection handling', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(__dirname, '../../src/dashboard.ts'),
        'utf8'
    );

    assert.match(
        dashboardSource,
        /onDidChangeConfiguration\(\s*event\s*=>\s*dashboardLifecycleController\.handleConfigurationChange\(event\)\s*\)/
    );
    assert.doesNotMatch(
        dashboardSource,
        /onDidChangeConfiguration\(async\s+event/
    );
});

test('WEBVIEW-AI-DASHBOARD-001 refreshes external Prompt configuration incrementally and consumes local echoes', async () => {
    const events = [];
    let localEcho = true;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => events.push('migrate'),
        consumePromptDataWriteEcho: () => {
            events.push('consume-prompt');
            return localEcho;
        },
        applyProjectColorToCurrentWindow: () => events.push('color'),
        refresh: reason => events.push(['refresh', reason]),
        refreshPrompts: reason => events.push(['prompts', reason]),
        publishOpenWorkspace: () => events.push('publish'),
        evaluateAiSessionAttention: () => undefined,
    });
    const promptChange = makeConfigurationEvent('agentPivot.promptData');

    await controller.handleConfigurationChanged(promptChange);
    assert.deepEqual(events, ['consume-prompt']);

    events.length = 0;
    localEcho = false;
    await controller.handleConfigurationChanged(promptChange);
    assert.deepEqual(events, [
        'consume-prompt',
        ['prompts', 'configuration-changed'],
    ]);
});

const DASHBOARD_COMMANDS = [
    'agentPivot.open', 'agentPivot.addProject', 'agentPivot.saveProject',
    'agentPivot.removeProject', 'agentPivot.editProjects', 'agentPivot.addGroup',
    'agentPivot.removeGroup', 'agentPivot.addProjectsFromFolder',
    'agentPivot.addFileToActiveTerminal', 'agentPivot.insertPromptToActiveTerminal',
    'agentPivot.migrateSkillsToCentral', 'agentPivot.openCurrentAiSessionConversation',
];

test('WEBVIEW-DASHBOARD-COMMAND-REGISTRATION-001 WEBVIEW-DASHBOARD-COMMAND-AVAILABILITY-001 registers once and switches generation handlers safely', async () => {
    const registered = new Map();
    const subscriptions = [];
    const calls = [];
    const handlerNames = [
        'open', 'addProject', 'saveProject', 'removeProject', 'editProjects', 'addGroup', 'removeGroup',
        'addProjectsFromFolder', 'addFileToActiveTerminal', 'insertPromptToActiveTerminal',
        'migrateSkillsToCentral', 'openCurrentAiSessionConversation',
    ];
    const facade = new DashboardCommandRegistration({
        registerCommand: (command, callback) => {
            registered.set(command, callback);
            return { command, dispose() {} };
        },
        pushSubscription: disposable => subscriptions.push(disposable),
        openWhileUnavailable: (...args) => calls.push(['boot-open', ...args]),
    });
    facade.register();

    assert.deepEqual([...registered.keys()], DASHBOARD_COMMANDS);
    assert.deepEqual(subscriptions.map(value => value.command), DASHBOARD_COMMANDS);

    await registered.get('agentPivot.open')('boot');
    await assert.rejects(
        registered.get('agentPivot.addProject')('ignored'),
        /Agent Pivot is still starting/
    );
    assert.deepEqual(calls, [['boot-open', 'boot']]);

    const firstHandlers = Object.fromEntries(
        handlerNames.map(name => [name, (...args) => calls.push([`first:${name}`, ...args])])
    );
    const secondHandlers = Object.fromEntries(
        handlerNames.map(name => [name, (...args) => calls.push([`second:${name}`, ...args])])
    );
    assert.equal(facade.stage(1, firstHandlers), true);
    assert.equal(facade.activate(2), false);
    assert.equal(facade.activate(1), true);
    for (const callback of registered.values()) await callback('ready');
    assert.deepEqual(
        calls.slice(1),
        handlerNames.map(name => [`first:${name}`, 'ready'])
    );

    assert.equal(facade.stage(2, secondHandlers), true);
    facade.discard(1);
    await registered.get('agentPivot.open')('still-first');
    assert.deepEqual(calls.at(-1), ['boot-open', 'still-first']);
    assert.equal(facade.activate(2), true);
    await registered.get('agentPivot.open')('second');
    assert.deepEqual(calls.at(-1), ['second:open', 'second']);

    facade.dispose();
    await assert.rejects(
        registered.get('agentPivot.open')('disposed'),
        /Agent Pivot is not available/
    );
});

test('WEBVIEW-DASHBOARD-COMMAND-REGISTRATION-001 contributes the Prompt terminal command exactly once without a default keybinding', () => {
    const manifest = require('../../package.json');
    const commands = manifest.contributes.commands
        .filter(command => command.command === 'agentPivot.insertPromptToActiveTerminal');
    assert.deepEqual(commands, [{
        command: 'agentPivot.insertPromptToActiveTerminal',
        title: 'Agent Pivot: Insert Prompt into Active Terminal',
    }]);
    assert.equal(manifest.contributes.keybindings.some(
        keybinding => keybinding.command === 'agentPivot.insertPromptToActiveTerminal'
    ), false);
});

test('WEBVIEW-DASHBOARD-COMMAND-REGISTRATION-001 production activation installs the exact Dashboard public command surface', () => {
    const environment = { ...process.env, NODE_V8_COVERAGE: '' };
    const result = spawnSync(process.execPath, [
        path.resolve(__dirname, '../fixtures/aiSessions/runtimeHostActivationHarness.js'), 'success',
    ], { encoding: 'utf8', env: environment });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const activation = JSON.parse(result.stdout);
    assert.equal(activation.failure, null);
    assert.equal(activation.dashboardCommandRegistrationInvocations, 1);
    assert.deepEqual(activation.synchronizedGlobalStateKeySets, [['promptData.v1']]);
    assert.deepEqual(
        activation.registeredCommands.filter(command => command.startsWith('agentPivot.')),
        DASHBOARD_COMMANDS
    );
});

function fileReferenceHarness({ editor, terminal, relativePath = 'src/file.ts' }) {
    const sent = [];
    const warnings = [];
    let shown = 0;
    const activeTerminal = terminal === undefined ? {
        sendText: (value, addNewLine) => sent.push([value, addNewLine]),
        show: () => { shown += 1; },
    } : terminal;
    const controller = new ActiveTerminalFileReferenceController({
        getActiveTextEditor: () => editor,
        getActiveTerminal: () => activeTerminal,
        asRelativePath: () => relativePath,
        showWarningMessage: message => warnings.push(message),
    });
    return { controller, sent, warnings, get shown() { return shown; } };
}

test('SESSION-ACTIVE-TERMINAL-FILE-REFERENCE-001 formats local, empty, reversed, and remote saved-file references', async () => {
    assert.equal(formatFileReference('src/file.ts', null), 'src/file.ts');
    assert.equal(formatFileReference('src/file.ts', { startLine: 3, endLine: 3 }), 'src/file.ts:3');
    assert.equal(formatFileReference('src/file.ts', { startLine: 3, endLine: 5 }), 'src/file.ts:3-5');
    assert.equal(getPrimarySelectionLineRange(null), null);
    assert.equal(getPrimarySelectionLineRange({ isEmpty: true, start: { line: 9 }, end: { line: 9 } }), null);
    const reversed = { isEmpty: false, start: { line: 4 }, end: { line: 2 } };
    assert.deepEqual(getPrimarySelectionLineRange(reversed), { startLine: 3, endLine: 5 });

    const local = fileReferenceHarness({
        editor: { document: { uri: { scheme: 'file', fsPath: '/repo/src/file.ts' } }, selection: reversed },
    });
    await local.controller.addFileToActiveTerminal();
    assert.deepEqual(local.sent, [['src/file.ts:3-5', false]]);
    assert.equal(local.shown, 1);

    const remote = fileReferenceHarness({
        editor: {
            document: { uri: { scheme: 'vscode-remote', path: '/work/app.ts' } },
            selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
        },
        relativePath: 'app.ts',
    });
    await remote.controller.addFileToActiveTerminal();
    assert.deepEqual(remote.sent, [['app.ts', false]]);
});

test('SESSION-ACTIVE-TERMINAL-FILE-REFERENCE-001 warns without effects for missing terminals and unsaved editors', async () => {
    const editor = {
        document: { uri: { scheme: 'file', fsPath: '/repo/src/file.ts' } },
        selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
    };
    const missingTerminal = fileReferenceHarness({ editor, terminal: null });
    await missingTerminal.controller.addFileToActiveTerminal();
    assert.deepEqual(missingTerminal.warnings, ['No active terminal to receive the file reference.']);
    assert.deepEqual(missingTerminal.sent, []);

    const untitled = fileReferenceHarness({
        editor: { ...editor, document: { uri: { scheme: 'untitled', path: 'Untitled-1' } } },
    });
    await untitled.controller.addFileToActiveTerminal();
    assert.deepEqual(untitled.warnings, ['Open a saved file before adding it to the active terminal.']);
    assert.deepEqual(untitled.sent, []);
});
