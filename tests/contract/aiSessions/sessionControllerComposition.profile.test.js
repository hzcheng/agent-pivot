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

// SESSION-CODEX-PROFILE-PICK-001
// SESSION-CODEX-PROFILE-CLI-PROBE-001
// SESSION-CODEX-PROFILE-RESUME-001

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
            return { marker: 'command' };
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
    createSessionControllerComposition({
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
        showWarningMessage: overrides.showWarningMessage || record('showWarningMessage'),
        showWarningWithItems: overrides.showWarningWithItems || record('showWarningWithItems'),
        showModalWarning: record('showModalWarning'),
        showInformationMessage: overrides.showInformationMessage || record('showInformationMessage'),
        showErrorMessage: record('showErrorMessage'),
        writeClipboard: record('writeClipboard'),
        focusTerminalView: record('focusTerminalView'),
        ...(overrides.compositionOptions || {}),
    }, factories);
    return { controllerOptions, calls, providers };
}

function createProfileFixture(profileOptions, fixtureOverrides = {}) {
    const storeCalls = [];
    const controller = {
        getLastUsed: () => profileOptions.lastUsed || null,
        recordPending: (...args) => storeCalls.push(['recordPending', ...args]),
        rememberLastUsed: (...args) => storeCalls.push(['rememberLastUsed', ...args]),
        getDecision: (...args) => {
            storeCalls.push(['getDecision', ...args]);
            return profileOptions.decision;
        },
    };
    const fixture = createFixture({
        ...fixtureOverrides,
        compositionOptions: {
            aiSessionProfileController: controller,
            getCodexDefaultProfile: () => profileOptions.defaultFromSetting,
            getCodexProfileSupport: async () => profileOptions.supported !== false,
            listCodexProfiles: () => profileOptions.profiles || [],
            isCodexProfileFileAvailable: name => (profileOptions.available || []).includes(name),
            openSettings: (...args) => {
                storeCalls.push(['openSettings', ...args]);
                return Promise.resolve();
            },
        },
    });
    return { ...fixture, storeCalls };
}

test('SESSION-CODEX-PROFILE-PICK-001 the picker stays hidden without discovered profiles', async () => {
    const picks = [];
    const { controllerOptions } = createProfileFixture(
        { profiles: [] },
        { showQuickPick: async items => { picks.push(items); return items[0]; } }
    );

    const result = await controllerOptions.creation.pickCodexProfile();
    assert.equal(result, 'base', 'no profiles means a base decision without prompting');
    assert.equal(picks.length, 0);
});

test('SESSION-CODEX-PROFILE-PICK-001 exactly one discovered profile still shows the picker', async () => {
    let pickCall;
    const { controllerOptions } = createProfileFixture(
        { profiles: ['deepseek'] },
        {
            showQuickPick: async (items, options) => {
                pickCall = { items, options };
                return items[0];
            },
        }
    );

    const result = await controllerOptions.creation.pickCodexProfile();
    assert.ok(pickCall, 'a single profile must still offer the picker');
    assert.equal(pickCall.options.title, 'Select a Codex profile');
    assert.equal(pickCall.options.ignoreFocusOut, true);
    assert.deepEqual(
        pickCall.items.map(item => item.label),
        ['Base configuration (no profile)', 'deepseek']
    );
    assert.equal(result, 'base', 'accepting the preselected item yields a base decision');
});

test('SESSION-CODEX-PROFILE-PICK-001 picker results map to decisions and remember wiring persists them', async () => {
    let pickCall;
    const { controllerOptions, storeCalls } = createProfileFixture(
        {
            profiles: ['deepseek', 'glm'],
            lastUsed: { kind: 'profile', name: 'glm' },
            defaultFromSetting: 'deepseek',
        },
        {
            showQuickPick: async (items, options) => {
                pickCall = { items, options };
                return items[0];
            },
        }
    );

    const result = await controllerOptions.creation.pickCodexProfile();
    assert.equal(pickCall.items[0].label, 'glm', 'the last used profile is preselected first');
    assert.ok(pickCall.items[0].description.includes('Current'));
    assert.ok(pickCall.items[0].description.includes('Last used'));
    assert.equal(result, 'glm');

    controllerOptions.creation.rememberSessionProfile('pending-1', { kind: 'profile', name: 'glm' });
    assert.deepEqual(storeCalls, [
        ['recordPending', 'pending-1', { kind: 'profile', name: 'glm' }],
        ['rememberLastUsed', { kind: 'profile', name: 'glm' }],
    ], 'a started session persists the pending decision and updates last used');
});

test('SESSION-CODEX-PROFILE-PICK-001 picker cancellation propagates undefined', async () => {
    const { controllerOptions } = createProfileFixture(
        { profiles: ['deepseek'] },
        { showQuickPick: async () => undefined }
    );
    assert.equal(await controllerOptions.creation.pickCodexProfile(), undefined);
});

test('SESSION-CODEX-PROFILE-CLI-PROBE-001 unsupported CLIs fall back to base with a one-time hint', async () => {
    const { controllerOptions, calls } = createProfileFixture({ profiles: ['deepseek'], supported: false });

    assert.equal(await controllerOptions.creation.pickCodexProfile(), 'base');
    assert.equal(
        calls.filter(call => call[0] === 'showQuickPick').length,
        0,
        'no picker without CLI support'
    );
    const infoCalls = () => calls.filter(call => call[0] === 'showInformationMessage');
    assert.equal(infoCalls().length, 1, 'the upgrade hint fires once');
    assert.match(infoCalls()[0][1], /does not support configuration profiles/);

    assert.equal(await controllerOptions.creation.pickCodexProfile(), 'base');
    assert.equal(infoCalls().length, 1, 'the hint does not repeat');
});

test('SESSION-CODEX-PROFILE-PICK-001 a missing default profile file warns once and is not a candidate', async () => {
    let pickCall;
    const { controllerOptions, calls } = createProfileFixture(
        { profiles: ['deepseek'], defaultFromSetting: 'missing-profile' },
        {
            showQuickPick: async (items, options) => {
                pickCall = { items, options };
                return items[0];
            },
        }
    );

    await controllerOptions.creation.pickCodexProfile();
    assert.ok(pickCall.items.every(item => item.label !== 'missing-profile'));
    assert.equal(
        pickCall.items[0].label,
        'Base configuration (no profile)',
        'no stale preselection without last used or a discovered setting'
    );
    const warnings = () => calls.filter(call => call[0] === 'showWarningMessage');
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0][1], /codexDefaultProfile/);

    await controllerOptions.creation.pickCodexProfile();
    assert.equal(warnings().length, 1, 'the missing-file warning does not repeat');
});

test('SESSION-CODEX-PROFILE-RESUME-001 resolveResumeProfileDecision passes through available profiles', async () => {
    const { controllerOptions, storeCalls, calls } = createProfileFixture({
        decision: { kind: 'profile', name: 'deepseek' },
        available: ['deepseek'],
    });

    const result = await controllerOptions.resume.resolveResumeProfileDecision('codex', 's1');
    assert.deepEqual(result, { kind: 'profile', name: 'deepseek' });
    assert.deepEqual(storeCalls, [['getDecision', 'codex', 's1']]);
    assert.equal(
        calls.filter(call => call[0] === 'showWarningWithItems').length,
        0,
        'no prompt when the profile file exists'
    );
});

test('SESSION-CODEX-PROFILE-RESUME-001 legacy and base records resolve without prompting', async () => {
    for (const decision of [undefined, { kind: 'base' }]) {
        const { controllerOptions, storeCalls, calls } = createProfileFixture({ decision });
        const result = await controllerOptions.resume.resolveResumeProfileDecision('codex', 's1');
        assert.deepEqual(result, decision, 'legacy stays undefined and base stays base');
        assert.deepEqual(storeCalls, [['getDecision', 'codex', 's1']]);
        assert.equal(calls.filter(call => call[0] === 'showWarningWithItems').length, 0);
    }
});

test('AI-SESSION-QUICK-CREATE-001 SESSION-CODEX-PROFILE-PICK-001 quick-create default prefers an available last-used profile', () => {
    const { controllerOptions } = createProfileFixture({
        lastUsed: { kind: 'profile', name: 'glm' },
        available: ['glm'],
        defaultFromSetting: 'deepseek',
    });

    assert.deepEqual(
        controllerOptions.creation.getDefaultCodexProfileDecision(),
        { kind: 'profile', name: 'glm' },
        'the last-used profile wins over the configured default'
    );
});

test('AI-SESSION-QUICK-CREATE-001 SESSION-CODEX-PROFILE-PICK-001 quick-create default falls back when the last-used profile file is gone', () => {
    const { controllerOptions } = createProfileFixture({
        lastUsed: { kind: 'profile', name: 'deleted-profile' },
        available: ['deepseek'],
        defaultFromSetting: 'deepseek',
    });
    assert.deepEqual(
        controllerOptions.creation.getDefaultCodexProfileDecision(),
        { kind: 'profile', name: 'deepseek' },
        'an unavailable last-used profile falls back to the configured default'
    );

    const missing = createProfileFixture({
        lastUsed: { kind: 'profile', name: 'deleted-profile' },
        available: [],
    });
    assert.equal(
        missing.controllerOptions.creation.getDefaultCodexProfileDecision(),
        undefined,
        'no remembered or configured profile means a profile-less quick-create'
    );
});

test('AI-SESSION-QUICK-CREATE-001 SESSION-CODEX-PROFILE-PICK-001 quick-create default keeps an explicit base decision', () => {
    const { controllerOptions } = createProfileFixture({
        lastUsed: { kind: 'base' },
        available: ['deepseek'],
        defaultFromSetting: 'deepseek',
    });

    assert.deepEqual(
        controllerOptions.creation.getDefaultCodexProfileDecision(),
        { kind: 'base' },
        'an explicit base choice is never upgraded to a profile'
    );
});

test('AI-SESSION-QUICK-CREATE-001 SESSION-CODEX-PROFILE-PICK-001 quick-create default resolves without a profile controller', () => {
    const { controllerOptions } = createFixture({
        compositionOptions: {
            getCodexDefaultProfile: () => 'deepseek',
            isCodexProfileFileAvailable: name => name === 'deepseek',
        },
    });
    assert.deepEqual(
        controllerOptions.creation.getDefaultCodexProfileDecision(),
        { kind: 'profile', name: 'deepseek' },
        'the configured default applies when no last-used decision exists'
    );

    const unavailable = createFixture({
        compositionOptions: {
            getCodexDefaultProfile: () => 'deleted-profile',
            isCodexProfileFileAvailable: () => false,
        },
    });
    assert.equal(
        unavailable.controllerOptions.creation.getDefaultCodexProfileDecision(),
        undefined,
        'a configured default whose file is missing is not a candidate'
    );

    const bare = createFixture();
    assert.equal(
        bare.controllerOptions.creation.getDefaultCodexProfileDecision(),
        undefined,
        'without any profile state the quick-create default stays empty'
    );
});

test('SESSION-CODEX-PROFILE-RESUME-001 unavailable profiles offer base, settings, or cancel', async () => {
    const scenarios = [
        { choice: 'Use Base Configuration', expected: { kind: 'base' }, opensSettings: false },
        { choice: 'Open Settings', expected: 'cancel', opensSettings: true },
        { choice: undefined, expected: 'cancel', opensSettings: false },
    ];
    for (const scenario of scenarios) {
        const prompts = [];
        const { controllerOptions, storeCalls } = createProfileFixture(
            {
                decision: { kind: 'profile', name: 'deleted-profile' },
                available: [],
            },
            {
                showWarningWithItems: async (message, ...items) => {
                    prompts.push([message, ...items]);
                    return scenario.choice;
                },
            }
        );
        const result = await controllerOptions.resume.resolveResumeProfileDecision('codex', 's1');
        assert.deepEqual(result, scenario.expected, `choice ${scenario.choice || '(dismissed)'}`);
        assert.equal(prompts.length, 1, 'the user is prompted for a missing profile');
        assert.match(prompts[0][0], /deleted-profile\.config\.toml/);
        assert.match(prompts[0][0], /stores the profile name, not a configuration snapshot/);
        assert.deepEqual(prompts[0].slice(1), ['Use Base Configuration', 'Open Settings']);
        assert.deepEqual(
            storeCalls.filter(call => call[0] === 'openSettings'),
            scenario.opensSettings ? [['openSettings', 'agentPivot.codexDefaultProfile']] : []
        );
    }
});
