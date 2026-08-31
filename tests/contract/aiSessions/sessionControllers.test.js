'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AiSessionCreationController } = require('../../../out/aiSessions/creationController');
const { AiSessionResumeController } = require('../../../out/aiSessions/resumeController');
const { AiSessionTerminalCommandController } = require('../../../out/aiSessions/terminalCommandController');
const { AiSessionRuntimeTargetChangedError } = require('../../../out/aiSessions/runtimeTypes');
const {
    AiSessionExecutionController,
    shouldRefreshConversationForExecutionChange,
} = require('../../../out/aiSessions/executionController');
const {
    AiSessionLifecycleSignalReader,
} = require('../../../out/aiSessions/lifecycleSignalReader');

const workspace = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'singleFolder',
    displayName: 'Project',
    navigationUri: 'file:///work',
    environment: 'local',
    roots: [{ id: 'root:fixture', name: 'work', uri: 'file:///work', hostPath: '/work', ordinal: 0 }],
};
const directoryScope = {
    workspaceNavigationIdentity: workspace.navigationIdentity,
    workspaceScopeIdentity: workspace.scopeIdentity,
    workspaceRootHostPaths: ['/work'],
    writableRootHostPaths: ['/work'],
    worktreeKey: {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/work',
    },
    primaryRootId: 'root:fixture',
    primaryCwd: '/work',
    additionalDirectories: [],
};
function makeWorkspaceTarget(sessions = []) {
    return {
        cardId: 'p',
        workspace,
        sessions: {
            activeProvider: 'codex',
            expanded: true,
            sessionsByProvider: { codex: sessions },
            unavailableProviders: [],
            activeSessions: [],
        },
    };
}

test('SESSION-AI-SESSION-CREATION-CONTROLLER-001 creates one tracked pending terminal from validated public input', async () => {
    const effects = [];
    const requests = [];
    const launchSpecs = [];
    const receivedLaunchOptions = [];
    let launchOptionReads = 0;
    const controller = new AiSessionCreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget() : null,
        pickWorkspaceRoot: async () => undefined,
        pickProvider: async () => 'codex', getProviderLabel: () => 'Codex',
        getLaunchOptions: () => {
            launchOptionReads += 1;
            return { yolo: true };
        },
        getProvider: () => ({
            label: 'Codex',
            terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: (_scope, _title, _markerPath, launchOptions) => {
                receivedLaunchOptions.push(launchOptions);
                return { executable: 'codex', args: ['--new'], cwd: '/work' };
            },
        }),
        resolveWorkspaceDirectoryScope: () => directoryScope,
        showInputBox: async () => '  Fixture title  ', showActiveTab: async id => effects.push(['tab', id]),
        showWarningMessage: async message => effects.push(['warning', message]), refresh: () => effects.push(['refresh']),
        getExistingSessionIdsForCwd: () => ['existing'], getPendingMarkerPath: () => '/tmp/pending',
        scheduleNewSessionRefresh: provider => effects.push(['schedule', provider]), nowMs: () => 1000,
        createPendingId: () => 'pending-fixture',
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            create: async request => {
                requests.push(request);
                if (typeof request.createLaunchSpec === 'function') {
                    launchSpecs.push(request.createLaunchSpec());
                }
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
    });
    await controller.createSession('p');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].title, 'Fixture title');
    assert.equal(requests[0].identity.provider, 'codex');
    assert.equal(requests[0].identity.workspaceScopeIdentity, 'scope:fixture');
    assert.deepEqual(requests[0].identity.writableRootHostPaths, ['/work']);
    assert.deepEqual(requests[0].identity.worktreeKey, directoryScope.worktreeKey);
    assert.deepEqual(requests[0].excludedSessionIds, ['existing']);
    assert.equal(requests[0].launch, undefined);
    assert.equal(typeof requests[0].createLaunchSpec, 'function');
    assert.deepEqual(launchSpecs, [{
        executable: 'codex', args: ['--new'], cwd: '/work',
    }]);
    assert.equal(launchOptionReads, 1);
    assert.deepEqual(receivedLaunchOptions, [{ yolo: true }]);
    const before = effects.length;
    await controller.createSession('missing');
    assert.equal(effects.length, before + 1);
    assert.match(effects.at(-1)[1], /not found/i);
});

test('SESSION-CODEX-PROFILE-PICK-001 creation picks a profile, launches with it and records it after start', async () => {
    const remembered = [];
    const receivedLaunchOptions = [];
    let titlePrompts = 0;
    const controller = new AiSessionCreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget() : null,
        pickWorkspaceRoot: async () => undefined,
        pickProvider: async () => 'codex',
        pickCodexProfile: async () => 'deepseek',
        getProviderLabel: () => 'Codex',
        getLaunchOptions: () => ({ yolo: false }),
        getProvider: () => ({
            label: 'Codex',
            terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: (_scope, _title, _markerPath, launchOptions) => {
                receivedLaunchOptions.push(launchOptions);
                return { executable: 'codex', args: ['--new'] };
            },
        }),
        resolveWorkspaceDirectoryScope: () => directoryScope,
        rememberSessionProfile: (pendingId, decision) => remembered.push([pendingId, decision]),
        showInputBox: async () => {
            titlePrompts += 1;
            return '';
        },
        showActiveTab: async () => undefined,
        showWarningMessage: async () => undefined,
        refresh: () => undefined,
        getExistingSessionIdsForCwd: () => [],
        getPendingMarkerPath: () => '/tmp/pending',
        scheduleNewSessionRefresh: () => undefined,
        nowMs: () => 1000,
        createPendingId: () => 'pending-profile',
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            create: async request => {
                request.createLaunchSpec();
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
    });
    await controller.createSession('p');
    assert.equal(titlePrompts, 1, 'the profile pick happens before the title input');
    assert.deepEqual(receivedLaunchOptions, [{ yolo: false, codexProfile: 'deepseek' }]);
    assert.deepEqual(remembered, [[
        'pending-profile',
        { kind: 'profile', name: 'deepseek' },
    ]], 'the effective decision is recorded once the runtime started');
});

test('SESSION-CODEX-PROFILE-PICK-001 creation cancellation and base decisions never leak profiles', async () => {
    const remembered = [];
    let requests = 0;
    let titlePrompts = 0;
    const makeController = pickCodexProfile => new AiSessionCreationController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget() : null,
        pickWorkspaceRoot: async () => undefined,
        pickProvider: async () => 'codex',
        pickCodexProfile,
        getProviderLabel: () => 'Codex',
        getLaunchOptions: () => ({ yolo: false }),
        getProvider: () => ({
            label: 'Codex',
            terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: (_scope, _title, _markerPath, launchOptions) => {
                assert.deepEqual(launchOptions, { yolo: false }, 'base launches carry no profile');
                return { executable: 'codex', args: ['--new'] };
            },
        }),
        resolveWorkspaceDirectoryScope: () => directoryScope,
        rememberSessionProfile: (pendingId, decision) => remembered.push([pendingId, decision]),
        showInputBox: async () => {
            titlePrompts += 1;
            return '';
        },
        showActiveTab: async () => undefined,
        showWarningMessage: async () => undefined,
        refresh: () => undefined,
        getExistingSessionIdsForCwd: () => [],
        getPendingMarkerPath: () => '/tmp/pending',
        scheduleNewSessionRefresh: () => undefined,
        nowMs: () => 1000,
        createPendingId: () => 'pending-base',
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            create: async request => {
                requests += 1;
                request.createLaunchSpec();
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
    });

    // Cancelling the picker aborts before the title prompt and creates nothing.
    await makeController(async () => undefined).createSession('p');
    assert.equal(titlePrompts, 0);
    assert.equal(requests, 0);
    assert.deepEqual(remembered, []);

    // An explicit base decision is recorded as base, without any profile.
    await makeController(async () => 'base').createSession('p');
    assert.equal(requests, 1);
    assert.deepEqual(remembered, [['pending-base', { kind: 'base' }]]);
});

test('SESSION-CODEX-PROFILE-PICK-001 failed creations do not record decisions or last used', async () => {
    const remembered = [];
    for (const status of ['blocked', 'conflict', 'cancelled', 'settings']) {
        const controller = new AiSessionCreationController({
            isProviderId: value => value === 'codex',
            getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget() : null,
            pickWorkspaceRoot: async () => undefined,
            pickProvider: async () => 'codex',
            pickCodexProfile: async () => 'deepseek',
            getProviderLabel: () => 'Codex',
            getLaunchOptions: () => ({ yolo: false }),
            getProvider: () => ({
                label: 'Codex',
                terminalNamePrefix: 'Codex',
                buildNewSessionLaunchSpec: () => ({ executable: 'codex', args: [] }),
            }),
            resolveWorkspaceDirectoryScope: () => directoryScope,
            rememberSessionProfile: (pendingId, decision) => remembered.push([pendingId, decision]),
            showInputBox: async () => '',
            showActiveTab: async () => undefined,
            showWarningMessage: async () => undefined,
            refresh: () => undefined,
            getExistingSessionIdsForCwd: () => [],
            getPendingMarkerPath: () => '/tmp/pending',
            scheduleNewSessionRefresh: () => undefined,
            nowMs: () => 1000,
            createPendingId: () => `pending-${status}`,
            announceStatus: async () => undefined,
            runtimeCoordinator: {
                create: async () => ({ status }),
                getActive: () => [],
                getPending: () => [],
            },
        });
        await controller.createSession('p');
    }
    assert.deepEqual(remembered, [], 'non-started results never persist a profile decision');
});

function makeQuickCreateController(overrides = {}) {
    const effects = [];
    const requests = [];
    const receivedLaunchOptions = [];
    const pickers = [];
    const rememberedProviders = [];
    const rememberedProfiles = [];
    const rememberedScopes = [];
    const resolvedScopes = [];
    const picker = name => () => {
        pickers.push(name);
        return Promise.resolve(undefined);
    };
    const controller = new AiSessionCreationController({
        isProviderId: value => ['codex', 'kimi', 'claude'].includes(value),
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget() : null,
        pickWorkspaceRoot: picker('pickWorkspaceRoot'),
        pickProvider: picker('pickProvider'),
        pickCodexProfile: picker('pickCodexProfile'),
        getProviderLabel: () => 'Codex',
        getLaunchOptions: () => ({ yolo: false }),
        getProvider: () => ({
            label: 'Codex',
            terminalNamePrefix: 'Codex',
            buildNewSessionLaunchSpec: (_scope, _title, _markerPath, launchOptions) => {
                receivedLaunchOptions.push(launchOptions);
                return { executable: 'codex', args: ['--new'] };
            },
        }),
        resolveWorkspaceDirectoryScope: (...args) => {
            resolvedScopes.push(args);
            return directoryScope;
        },
        rememberDirectoryScope: scope => { rememberedScopes.push(scope); },
        rememberSessionProvider: (scope, providerId) => { rememberedProviders.push([scope, providerId]); },
        rememberSessionProfile: (pendingId, decision) => { rememberedProfiles.push([pendingId, decision]); },
        showInputBox: picker('showInputBox'),
        showActiveTab: async () => undefined,
        showWarningMessage: async message => effects.push(['warning', message]),
        showErrorMessage: async message => effects.push(['error', message]),
        refresh: () => effects.push(['refresh']),
        getExistingSessionIdsForCwd: () => [],
        getPendingMarkerPath: () => '/tmp/pending',
        scheduleNewSessionRefresh: () => undefined,
        nowMs: () => 1000,
        createPendingId: () => 'pending-quick',
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            create: async request => {
                requests.push(request);
                request.createLaunchSpec();
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
        ...overrides,
    });
    return {
        controller, effects, requests, receivedLaunchOptions, pickers,
        rememberedProviders, rememberedProfiles, rememberedScopes, resolvedScopes,
    };
}

test('AI-SESSION-QUICK-CREATE-001 quick-create skips every picker, starts the given provider, and persists the choice', async () => {
    const fixture = makeQuickCreateController();

    const created = await fixture.controller.createSessionQuick('p', 'kimi');

    assert.equal(created, true);
    assert.deepEqual(fixture.pickers, [], 'quick-create never prompts for root, provider, profile, or title');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].identity.provider, 'kimi');
    assert.equal(fixture.requests[0].title, '', 'quick-create leaves the title to the session id');
    assert.deepEqual(fixture.receivedLaunchOptions, [{ yolo: false }],
        'no codex profile leaks into a non-codex launch');
    assert.deepEqual(fixture.rememberedProviders, [['scope:fixture', 'kimi']],
        'the started provider becomes the next quick-create default');
    assert.deepEqual(fixture.rememberedScopes, [directoryScope]);
    assert.deepEqual(fixture.rememberedProfiles, []);
    assert.deepEqual(fixture.effects, [['refresh']]);
});

test('SESSION-HANDOFF-001 SESSION-HANDOFF-002 handoff starts a fresh session with a transcript-linked prompt and the source worktree', async () => {
    const key = {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/worktrees/feature-auth',
    };
    const sourceSession = {
        id: 's1', name: 'Auth fix', provider: 'codex', cwd: '/worktrees/feature-auth',
        worktreeKey: key,
    };
    const receivedPrompts = [];
    const selections = [];
    const fixture = makeQuickCreateController({
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([sourceSession]) : null,
        getSessionTranscriptPath: (providerId, sessionId) => `/transcripts/${providerId}/${sessionId}.jsonl`,
        selectCreationScopeTarget: async (_workspace, explicitKey) => {
            selections.push(explicitKey);
            return { kind: 'worktree', key: explicitKey };
        },
        getProvider: providerId => ({
            label: providerId,
            terminalNamePrefix: providerId,
            buildNewSessionLaunchSpec: (_scope, _title, _markerPath, _launchOptions, initialPrompt) => {
                receivedPrompts.push(initialPrompt);
                return { executable: providerId, args: ['--new'] };
            },
        }),
    });

    const created = await fixture.controller.handoffSession('p', 'codex', 's1', 'claude');

    assert.equal(created, true);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].identity.provider, 'claude',
        'the new chat runs on the selected target provider');
    assert.deepEqual(selections, [key],
        'the source session worktree is reused without prompting');
    assert.equal(receivedPrompts.length, 1);
    assert.match(receivedPrompts[0], /previous Codex chat \("Auth fix"\) \(session s1\)/);
    assert.match(receivedPrompts[0], /\/transcripts\/codex\/s1\.jsonl/);
    assert.match(receivedPrompts[0], /worked in: \/worktrees\/feature-auth/);
    assert.equal(fixture.requests[0].title, 'Auth fix (2)',
        'the relay chat is named after its source so the lineage stays visible');
});

test('SESSION-HANDOFF-001 SESSION-HANDOFF-002 handoff falls back to provider storage guidance without a transcript path', async () => {
    const receivedPrompts = [];
    const fixture = makeQuickCreateController({
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([
            { id: 's2', name: '', provider: 'codex', cwd: '/work' },
        ]) : null,
        getSessionTranscriptPath: () => null,
        getProvider: providerId => ({
            label: providerId,
            terminalNamePrefix: providerId,
            buildNewSessionLaunchSpec: (_scope, _title, _markerPath, _launchOptions, initialPrompt) => {
                receivedPrompts.push(initialPrompt);
                return { executable: providerId, args: ['--new'] };
            },
        }),
    });

    const created = await fixture.controller.handoffSession('p', 'codex', 's2', 'kimi');

    assert.equal(created, true);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].identity.provider, 'kimi');
    assert.equal(receivedPrompts.length, 1);
    assert.match(receivedPrompts[0], /previous Codex chat \(session s2\)/);
    assert.match(receivedPrompts[0], /provider's session storage/);
    assert.equal(fixture.requests[0].title, 'Handoff from Codex · s2',
        'an unnamed source falls back to a provider + short-id label');
});

test('SESSION-HANDOFF-001 handoff warns and creates nothing when the source chat is gone', async () => {
    const fixture = makeQuickCreateController({
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([]) : null,
    });

    const created = await fixture.controller.handoffSession('p', 'codex', 'missing', 'codex');

    assert.equal(created, false);
    assert.equal(fixture.requests.length, 0);
    assert.ok(fixture.effects.some(effect => effect[0] === 'warning'
        && /not found/i.test(effect[1])));
});

test('SESSION-HANDOFF-001 handoff to a CLI without interactive prompt support copies the prompt instead of passing --prompt', async () => {
    const receivedPrompts = [];
    const clipboard = [];
    const fixture = makeQuickCreateController({
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([
            { id: 's2', name: '', provider: 'codex', cwd: '/work' },
        ]) : null,
        getSessionTranscriptPath: () => null,
        resolveInteractiveCliPromptSupport: async () => false,
        writeClipboard: value => clipboard.push(value),
        getProvider: providerId => ({
            label: providerId,
            terminalNamePrefix: providerId,
            buildNewSessionLaunchSpec: (_scope, _title, _markerPath, _launchOptions, initialPrompt) => {
                receivedPrompts.push(initialPrompt);
                return { executable: providerId, args: ['--new'] };
            },
        }),
    });

    const created = await fixture.controller.handoffSession('p', 'codex', 's2', 'kimi');

    assert.equal(created, true);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].identity.provider, 'kimi');
    assert.deepEqual(receivedPrompts, [undefined],
        'the kimi-code dialect must never receive --prompt (it runs one headless turn and exits)');
    assert.equal(clipboard.length, 1);
    assert.match(clipboard[0], /previous Codex chat \(session s2\)/,
        'the dropped prompt lands on the clipboard for a manual paste');
    assert.ok(fixture.effects.some(effect => effect[0] === 'warning'
        && /cannot prefill a prompt/i.test(effect[1])));
});

test('SESSION-HANDOFF-001 handoff keeps --prompt when the CLI supports interactive prompt seeding', async () => {
    const receivedPrompts = [];
    const clipboard = [];
    const fixture = makeQuickCreateController({
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([
            { id: 's2', name: '', provider: 'codex', cwd: '/work' },
        ]) : null,
        getSessionTranscriptPath: () => null,
        resolveInteractiveCliPromptSupport: async () => true,
        writeClipboard: value => clipboard.push(value),
        getProvider: providerId => ({
            label: providerId,
            terminalNamePrefix: providerId,
            buildNewSessionLaunchSpec: (_scope, _title, _markerPath, _launchOptions, initialPrompt) => {
                receivedPrompts.push(initialPrompt);
                return { executable: providerId, args: ['--new'] };
            },
        }),
    });

    const created = await fixture.controller.handoffSession('p', 'codex', 's2', 'kimi');

    assert.equal(created, true);
    assert.equal(receivedPrompts.length, 1);
    assert.match(receivedPrompts[0], /previous Codex chat \(session s2\)/);
    assert.deepEqual(clipboard, []);
    assert.ok(!fixture.effects.some(effect => effect[0] === 'warning'));
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a session on a retired path persists its claim before side effects', async () => {
    const order = [];
    const discarded = [];
    const claimInputs = [];
    const fixture = makeQuickCreateController({
        prepareGenerationClaim: async input => {
            order.push(['claim', input.pendingId]);
            claimInputs.push(input);
            return 'claim-1';
        },
        discardGenerationClaim: async input => {
            discarded.push(input.claimId);
        },
        runtimeCoordinator: {
            create: async request => {
                order.push(['create', request.identity.pendingId]);
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
    });

    assert.equal(await fixture.controller.createSessionQuick('p', 'kimi', undefined, {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/worktrees/feature-auth',
    }), true);
    assert.deepEqual(order, [['claim', 'pending-quick'], ['create', 'pending-quick']],
        'the pending claim is durable before the runtime is created');
    assert.equal(claimInputs[0].provider, 'kimi');
    assert.equal(claimInputs[0].launchMarkerPath, '/tmp/pending',
        'the claim carries the launch marker for crash reconciliation');
    assert.equal(claimInputs[0].navigationIdentity, 'navigation:fixture');
    assert.deepEqual(discarded, [], 'a started session keeps its pending claim');
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a claim write failure rejects creation before any side effect', async () => {
    let creates = 0;
    const fixture = makeQuickCreateController({
        prepareGenerationClaim: async () => {
            throw new Error('store-full');
        },
        runtimeCoordinator: {
            create: async () => {
                creates += 1;
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
    });

    await fixture.controller.createSessionQuick('p', 'kimi', undefined, {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/worktrees/feature-auth',
    });
    assert.equal(creates, 0, 'no terminal/provider side effect happened');
    assert.ok(fixture.effects.some(effect => effect[0] === 'error'));
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 a non-started creation discards its pending claim', async () => {
    const discarded = [];
    const fixture = makeQuickCreateController({
        prepareGenerationClaim: async () => 'claim-1',
        discardGenerationClaim: async input => {
            discarded.push([input.navigationIdentity, input.claimId]);
        },
        runtimeCoordinator: {
            create: async () => ({ status: 'cancelled' }),
            getActive: () => [],
            getPending: () => [],
        },
    });

    await fixture.controller.createSessionQuick('p', 'kimi', undefined, {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/worktrees/feature-auth',
    });
    assert.deepEqual(discarded, [['navigation:fixture', 'claim-1']],
        'the compensating delete releases the pending claim');
});

test('WORKTREE-SESSION-CREATE-TARGET-001 quick-create carries an explicit worktree through scope resolution', async () => {
    const key = {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/worktrees/feature-auth',
    };
    const selections = [];
    const fixture = makeQuickCreateController({
        selectCreationScopeTarget: async (selectedWorkspace, explicitKey) => {
            selections.push([selectedWorkspace.scopeIdentity, explicitKey]);
            return { kind: 'worktree', key: explicitKey };
        },
    });

    assert.equal(await fixture.controller.createSessionQuick('p', 'kimi', undefined, key), true);
    assert.deepEqual(selections, [['scope:fixture', key]]);
    assert.deepEqual(fixture.resolvedScopes, [[
        makeWorkspaceTarget(),
        'kimi',
        undefined,
        key,
    ]]);
    assert.equal(fixture.requests.length, 1);
});

test('WORKTREE-ISOLATED-SESSION-001 WORKTREE-PROVISIONING-STATE-001 isolated creation uses the task title and reports actual runtime start', async () => {
    const key = {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/worktrees/feature-auth',
    };
    const fixture = makeQuickCreateController({
        selectCreationScopeTarget: async (_workspace, explicitKey) => ({
            kind: 'worktree', key: explicitKey,
        }),
    });

    assert.equal(await fixture.controller.createSessionInWorktree(
        'p', 'codex', ' Fix login race ', key), true);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].title, 'Fix login race');
    assert.deepEqual(fixture.requests[0].identity.worktreeKey, directoryScope.worktreeKey);

    const blocked = makeQuickCreateController({
        selectCreationScopeTarget: async (_workspace, explicitKey) => ({
            kind: 'worktree', key: explicitKey,
        }),
        runtimeCoordinator: {
            create: async () => ({ status: 'blocked' }),
            getActive: () => [],
            getPending: () => [],
        },
    });
    assert.equal(await blocked.controller.createSessionInWorktree(
        'p', 'kimi', 'Task', key), false,
    'provisioning must not settle as success for a non-started runtime result');
});

test('WORKTREE-SESSION-CREATE-TARGET-001 cancellation stops quick-create before scope or runtime work', async () => {
    const fixture = makeQuickCreateController({
        selectCreationScopeTarget: async () => null,
    });

    assert.equal(await fixture.controller.createSessionQuick('p', 'codex'), true);
    assert.deepEqual(fixture.resolvedScopes, []);
    assert.deepEqual(fixture.requests, []);
    assert.deepEqual(fixture.rememberedProviders, []);
});

test('AI-SESSION-QUICK-CREATE-001 rejects unknown workspaces and invalid providers without side effects', async () => {
    const fixture = makeQuickCreateController();

    assert.equal(await fixture.controller.createSessionQuick('missing', 'codex'), false);
    assert.equal(await fixture.controller.createSessionQuick('p', 'vim'), false);
    assert.deepEqual(fixture.pickers, []);
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(fixture.rememberedProviders, []);
    assert.deepEqual(fixture.effects, []);

    assert.equal(await fixture.controller.createSessionQuick('p', 'codex'), true,
        'rejections release the creating guard for later attempts');
    assert.equal(fixture.requests.length, 1);
});

test('AI-SESSION-QUICK-CREATE-001 a quick-create in flight rejects concurrent attempts and recovers afterwards', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fixture = makeQuickCreateController({
        runtimeCoordinator: {
            create: async () => {
                await gate;
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
    });

    const first = fixture.controller.createSessionQuick('p', 'codex');
    assert.equal(fixture.controller.isCreatingSession(), true,
        'the host can acknowledge a rapid follow-up instead of silently dropping it');
    assert.equal(await fixture.controller.createSessionQuick('p', 'codex'), false,
        'a concurrent quick-create must not start a second runtime');
    release();
    assert.equal(await first, true);
    assert.equal(fixture.controller.isCreatingSession(), false);
    assert.equal(await fixture.controller.createSessionQuick('p', 'codex'), true,
        'the creating guard releases once the first attempt settles');
});

test('AI-SESSION-QUICK-CREATE-001 SESSION-CODEX-PROFILE-PICK-001 quick-create applies the default codex profile without prompting', async () => {
    const defaultReads = [];
    const fixture = makeQuickCreateController({
        getDefaultCodexProfileDecision: () => {
            defaultReads.push('read');
            return { kind: 'profile', name: 'glm' };
        },
    });

    assert.equal(await fixture.controller.createSessionQuick('p', 'codex'), true);
    assert.deepEqual(fixture.pickers, [], 'the codex profile picker stays closed for quick-create');
    assert.deepEqual(defaultReads, ['read']);
    assert.deepEqual(fixture.receivedLaunchOptions, [{ yolo: false, codexProfile: 'glm' }]);
    assert.deepEqual(fixture.rememberedProfiles, [['pending-quick', { kind: 'profile', name: 'glm' }]],
        'the effective default decision is persisted after start');

    const explicit = makeQuickCreateController({
        getDefaultCodexProfileDecision: () => { throw new Error('must not be consulted'); },
    });
    await explicit.controller.createSessionQuick('p', 'codex', { kind: 'base' });
    assert.deepEqual(explicit.receivedLaunchOptions, [{ yolo: false }],
        'an explicit decision wins over the remembered default');
    assert.deepEqual(explicit.rememberedProfiles, [['pending-quick', { kind: 'base' }]]);

    const kimi = makeQuickCreateController({
        getDefaultCodexProfileDecision: () => { throw new Error('must not be consulted'); },
    });
    await kimi.controller.createSessionQuick('p', 'kimi');
    assert.deepEqual(kimi.receivedLaunchOptions, [{ yolo: false }]);
    assert.deepEqual(kimi.rememberedProfiles, []);
});

test('AI-SESSION-QUICK-CREATE-001 awaits the provider memory write before revealing the session', async () => {
    const order = [];
    let releaseWrite;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const fixture = makeQuickCreateController({
        rememberSessionProvider: (scope, providerId) => {
            order.push(['remember:start', scope, providerId]);
            return writeGate.then(() => { order.push(['remember:write']); });
        },
        showActiveTab: async id => { order.push(['showActiveTab', id]); },
        refresh: () => { order.push(['refresh']); },
    });

    const pending = fixture.controller.createSessionQuick('p', 'kimi');
    for (let index = 0; index < 20 && order.length === 0; index += 1) {
        await Promise.resolve();
    }
    assert.deepEqual(order, [['remember:start', 'scope:fixture', 'kimi']],
        'the reveal and refresh must park behind a delayed memory write');

    releaseWrite();
    assert.equal(await pending, true);
    assert.deepEqual(order, [
        ['remember:start', 'scope:fixture', 'kimi'],
        ['remember:write'],
        ['showActiveTab', 'p'],
        ['refresh'],
    ], 'the refresh after a started quick-create reads the settled provider memory');
});

test('AI-SESSION-QUICK-CREATE-001 remembers the provider only after the runtime started', async () => {
    for (const status of ['blocked', 'conflict', 'cancelled', 'settings']) {
        const fixture = makeQuickCreateController({
            runtimeCoordinator: {
                create: async () => ({ status }),
                getActive: () => [],
                getPending: () => [],
            },
        });
        assert.equal(await fixture.controller.createSessionQuick('p', 'codex'), true,
            `${status} results still resolve true: the attempt surfaces its own UI feedback`);
        assert.deepEqual(fixture.rememberedProviders, [],
            `${status} must not persist the provider choice`);
        assert.deepEqual(fixture.rememberedScopes, []);
    }

    const refused = makeQuickCreateController({ resolveWorkspaceDirectoryScope: () => null });
    assert.equal(await refused.controller.createSessionQuick('p', 'codex'), true);
    assert.deepEqual(refused.rememberedProviders, [],
        'a refused directory scope must not persist the provider choice');
});

test('AI-SESSION-QUICK-CREATE-001 quick-create defers the multi-root choice to scope resolution without prompting', async () => {
    const target = makeWorkspaceTarget();
    target.workspace = {
        ...workspace,
        roots: [
            { id: 'root-a', name: 'a', uri: 'file:///a', hostPath: '/a', ordinal: 0 },
            { id: 'root-b', name: 'b', uri: 'file:///b', hostPath: '/b', ordinal: 1 },
        ],
    };
    const fixture = makeQuickCreateController({
        getWorkspaceTarget: id => id === 'p' ? target : null,
    });

    assert.equal(await fixture.controller.createSessionQuick('p', 'codex'), true);
    assert.deepEqual(fixture.pickers, [], 'the root picker stays closed for quick-create');
    assert.equal(fixture.resolvedScopes.length, 1);
    assert.equal(fixture.resolvedScopes[0][1], 'codex');
    assert.equal(fixture.resolvedScopes[0][2], undefined,
        'no explicit root: resolution falls back to the active editor or remembered primary root');
});

test('SESSION-CODEX-PROFILE-RESUME-001 resume reuses the recorded profile decision', async () => {
    const receivedLaunchOptions = [];
    const controller = new AiSessionResumeController({
        getWorkspaceTarget: id => id === 'p'
            ? makeWorkspaceTarget([{ id: 's', name: 'Session', cwd: '/work' }])
            : null,
        getLaunchOptions: () => ({ yolo: true }),
        resolveResumeProfileDecision: async (providerId, sessionId) => {
            assert.equal(providerId, 'codex');
            assert.equal(sessionId, 's');
            return { kind: 'profile', name: 'deepseek' };
        },
        getProvider: () => ({
            label: 'Codex',
            terminalEnvKey: 'CODEX',
            buildResumeLaunchSpec: (_id, _scope, _markerPath, launchOptions) => {
                receivedLaunchOptions.push(launchOptions);
                return { executable: 'codex', args: ['resume', 's'] };
            },
        }),
        resolveWorkspaceDirectoryScope: () => directoryScope,
        getTerminalName: () => 'Codex: Session',
        getMarkerPath: () => '/tmp/resume',
        showWarningMessage: () => undefined,
        refresh: () => undefined,
        showActiveTab: () => undefined,
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            resume: async request => {
                request.createLaunchSpec();
                return { status: 'started', backend: 'vscode' };
            },
        },
    });
    await controller.resumeProjectSession('p', 'codex', 's');
    assert.deepEqual(receivedLaunchOptions, [{ yolo: true, codexProfile: 'deepseek' }]);
});

test('SESSION-CODEX-PROFILE-RESUME-001 recorded base and legacy sessions resume without a profile', async () => {
    const receivedLaunchOptions = [];
    const decisions = [{ kind: 'base' }, undefined];
    for (const decision of decisions) {
        const controller = new AiSessionResumeController({
            getWorkspaceTarget: id => id === 'p'
                ? makeWorkspaceTarget([{ id: 's', name: 'Session', cwd: '/work' }])
                : null,
            getLaunchOptions: () => ({ yolo: false }),
            resolveResumeProfileDecision: async () => decision,
            getProvider: () => ({
                label: 'Codex',
                terminalEnvKey: 'CODEX',
                buildResumeLaunchSpec: (_id, _scope, _markerPath, launchOptions) => {
                    receivedLaunchOptions.push(launchOptions);
                    return { executable: 'codex', args: ['resume', 's'] };
                },
            }),
            resolveWorkspaceDirectoryScope: () => directoryScope,
            getTerminalName: () => 'Codex: Session',
            getMarkerPath: () => '/tmp/resume',
            showWarningMessage: () => undefined,
            refresh: () => undefined,
            showActiveTab: () => undefined,
            announceStatus: async () => undefined,
            runtimeCoordinator: {
                resume: async request => {
                    request.createLaunchSpec();
                    return { status: 'started', backend: 'vscode' };
                },
            },
        });
        await controller.resumeProjectSession('p', 'codex', 's');
    }
    assert.deepEqual(
        receivedLaunchOptions,
        [{ yolo: false }, { yolo: false }],
        'recorded base and legacy records resume without -p and never fall back to the setting'
    );
    for (const options of receivedLaunchOptions) {
        assert.equal('codexProfile' in options, false);
    }
});

test('SESSION-CODEX-PROFILE-RESUME-001 an unavailable profile can cancel or downgrade the resume', async () => {
    const outcomes = [];
    for (const resolution of ['cancel', { kind: 'base' }]) {
        const controller = new AiSessionResumeController({
            getWorkspaceTarget: id => id === 'p'
                ? makeWorkspaceTarget([{ id: 's', name: 'Session', cwd: '/work' }])
                : null,
            getLaunchOptions: () => ({ yolo: false }),
            resolveResumeProfileDecision: async () => resolution,
            getProvider: () => ({
                label: 'Codex',
                terminalEnvKey: 'CODEX',
                buildResumeLaunchSpec: (_id, _scope, _markerPath, launchOptions) => {
                    outcomes.push(launchOptions);
                    return { executable: 'codex', args: ['resume', 's'] };
                },
            }),
            resolveWorkspaceDirectoryScope: () => directoryScope,
            getTerminalName: () => 'Codex: Session',
            getMarkerPath: () => '/tmp/resume',
            showWarningMessage: () => undefined,
            refresh: () => undefined,
            showActiveTab: () => undefined,
            announceStatus: async () => undefined,
            runtimeCoordinator: {
                resume: async request => {
                    outcomes.push('resume-request');
                    request.createLaunchSpec();
                    return { status: 'started', backend: 'vscode' };
                },
            },
        });
        await controller.resumeProjectSession('p', 'codex', 's');
    }
    assert.deepEqual(
        outcomes,
        ['resume-request', { yolo: false }],
        'cancel aborts before dispatch; base downgrades to a profile-less launch'
    );
});

test('SESSION-AI-SESSION-RESUME-CONTROLLER-001 delegates scoped resume and reveals successful runtime results', async () => {
    const effects = [];
    const requests = [];
    const launchSpecs = [];
    const receivedLaunchOptions = [];
    const receivedPrompts = [];
    let launchOptionReads = 0;
    const controller = new AiSessionResumeController({
        getWorkspaceTarget: id => id === 'p'
            ? makeWorkspaceTarget([{ id: 's', name: 'Session', cwd: '/work' }])
            : null,
        getLaunchOptions: () => {
            launchOptionReads += 1;
            return { yolo: true };
        },
        getProvider: () => ({
            label: 'Codex',
            terminalEnvKey: 'CODEX',
            buildResumeLaunchSpec: (
                _id, _scope, _markerPath, launchOptions, prompt
            ) => {
                receivedLaunchOptions.push(launchOptions);
                receivedPrompts.push(prompt);
                return {
                    executable: 'codex',
                    args: ['resume', 's', prompt],
                    cwd: '/work',
                };
            },
        }),
        resolveWorkspaceDirectoryScope: () => directoryScope,
        getTerminalName: () => 'Codex: Session', getMarkerPath: () => '/tmp/new', showWarningMessage: message => effects.push(message),
        refresh: () => effects.push('refresh'), showActiveTab: id => effects.push(`tab:${id}`),
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            resume: async request => {
                requests.push(request);
                if (typeof request.createLaunchSpec === 'function') {
                    launchSpecs.push(request.createLaunchSpec());
                }
                return { status: 'started', backend: 'vscode' };
            },
        },
    });
    const result = await controller.resumeProjectSession(
        'p', 'codex', 's', undefined, 'Handle both comments.'
    );
    assert.deepEqual(effects, ['tab:p', 'refresh']);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].identity.sessionId, 's');
    assert.equal(requests[0].identity.workspaceScopeIdentity, 'scope:fixture');
    assert.deepEqual(requests[0].identity.writableRootHostPaths, ['/work']);
    assert.deepEqual(requests[0].identity.worktreeKey, directoryScope.worktreeKey);
    assert.equal(requests[0].launch, undefined);
    assert.equal(typeof requests[0].createLaunchSpec, 'function');
    assert.deepEqual(launchSpecs, [{
        executable: 'codex',
        args: ['resume', 's', 'Handle both comments.'],
        cwd: '/work',
    }]);
    assert.equal(launchOptionReads, 1);
    assert.deepEqual(receivedLaunchOptions, [{ yolo: true }]);
    assert.deepEqual(receivedPrompts, ['Handle both comments.']);
    assert.equal(result.status, 'started');
});

test('SESSION-CONVERSATION-COMMENTS-RESUME-001 resume drops --prompt and copies it when the CLI lacks interactive prompt seeding', async () => {
    const effects = [];
    const receivedPrompts = [];
    const clipboard = [];
    const controller = new AiSessionResumeController({
        getWorkspaceTarget: id => id === 'p'
            ? makeWorkspaceTarget([{ id: 's', name: 'Session', cwd: '/work' }])
            : null,
        getLaunchOptions: () => ({ yolo: false }),
        getProvider: () => ({
            label: 'Kimi',
            terminalEnvKey: 'KIMI',
            buildResumeLaunchSpec: (_id, _scope, _markerPath, _launchOptions, prompt) => {
                receivedPrompts.push(prompt);
                return { executable: 'kimi', args: ['--resume', 's'], cwd: '/work' };
            },
        }),
        resolveWorkspaceDirectoryScope: () => directoryScope,
        getTerminalName: () => 'Kimi: Session', getMarkerPath: () => '/tmp/new',
        showWarningMessage: message => effects.push(message),
        resolveInteractiveCliPromptSupport: async () => false,
        writeClipboard: value => clipboard.push(value),
        refresh: () => undefined, showActiveTab: () => undefined,
        announceStatus: async () => undefined,
        runtimeCoordinator: {
            resume: async request => {
                if (typeof request.createLaunchSpec === 'function') {
                    request.createLaunchSpec();
                }
                return { status: 'started', backend: 'vscode' };
            },
        },
    });

    // The fixture workspace lists the session under `codex`; the provider id
    // only routes lookups here, the dialect gate answers "unsupported" for it.
    const result = await controller.resumeProjectSession('p', 'codex', 's', undefined, 'Handle both comments.');

    assert.equal(result.status, 'started');
    assert.deepEqual(receivedPrompts, [undefined],
        'the kimi-code dialect must never receive --prompt (it runs one headless turn and exits)');
    assert.deepEqual(clipboard, ['Handle both comments.']);
    assert.ok(effects.some(message => /cannot prefill a prompt/i.test(message)));
});

test('SESSION-AI-SESSION-YOLO-LAZY-001 does not read options or build specs for non-dispatch controller results', async () => {
    for (const status of ['focused', 'blocked', 'conflict', 'cancelled', 'settings']) {
        let creationReads = 0;
        let creationBuilds = 0;
        let creationRequest;
        const creation = new AiSessionCreationController({
            isProviderId: value => value === 'codex',
            getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget() : null,
            pickWorkspaceRoot: async () => undefined,
            pickProvider: async () => 'codex',
            getProviderLabel: () => 'Codex',
            getLaunchOptions: () => {
                creationReads += 1;
                return { yolo: true };
            },
            getProvider: () => ({
                label: 'Codex',
                terminalNamePrefix: 'Codex',
                buildNewSessionLaunchSpec: () => {
                    creationBuilds += 1;
                    return { executable: 'codex', args: [] };
                },
            }),
            resolveWorkspaceDirectoryScope: () => directoryScope,
            showInputBox: async () => '',
            showActiveTab: async () => undefined,
            showWarningMessage: async () => undefined,
            refresh: () => undefined,
            getExistingSessionIdsForCwd: () => [],
            getPendingMarkerPath: () => '/tmp/pending',
            scheduleNewSessionRefresh: () => undefined,
            nowMs: () => 1000,
            createPendingId: () => `pending-${status}`,
            announceStatus: async () => undefined,
            runtimeCoordinator: {
                create: async request => {
                    creationRequest = request;
                    return { status };
                },
                getActive: () => [],
                getPending: () => [],
            },
        });

        await creation.createSession('p');

        assert.equal(typeof creationRequest.createLaunchSpec, 'function');
        assert.equal(creationReads, 0, `creation ${status} must not read configuration`);
        assert.equal(creationBuilds, 0, `creation ${status} must not build a launch spec`);

        let resumeReads = 0;
        let resumeBuilds = 0;
        let resumeRequest;
        const resume = new AiSessionResumeController({
            getWorkspaceTarget: id => id === 'p'
                ? makeWorkspaceTarget([{ id: 's', name: 'Session', cwd: '/work' }])
                : null,
            getLaunchOptions: () => {
                resumeReads += 1;
                return { yolo: true };
            },
            getProvider: () => ({
                label: 'Codex',
                terminalEnvKey: 'CODEX',
                buildResumeLaunchSpec: () => {
                    resumeBuilds += 1;
                    return { executable: 'codex', args: ['resume', 's'] };
                },
            }),
            resolveWorkspaceDirectoryScope: () => directoryScope,
            getTerminalName: () => 'Codex: Session',
            getMarkerPath: () => '/tmp/resume',
            showWarningMessage: () => undefined,
            refresh: () => undefined,
            showActiveTab: () => undefined,
            announceStatus: async () => undefined,
            runtimeCoordinator: {
                resume: async request => {
                    resumeRequest = request;
                    return { status };
                },
            },
        });

        await resume.resumeProjectSession('p', 'codex', 's');

        assert.equal(typeof resumeRequest.createLaunchSpec, 'function');
        assert.equal(resumeReads, 0, `resume ${status} must not read configuration`);
        assert.equal(resumeBuilds, 0, `resume ${status} must not build a launch spec`);
    }
});

test('SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001 ATTENTION-EXPLICIT-SESSION-CLOSE-001 CONVERSATION-FOLLOW-ACTIVE-SESSION-001 CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 reports whether a project-owned terminal was focused', async () => {
    const effects = [];
    const terminal = { show: () => effects.push('show'), dispose: () => effects.push('dispose') };
    const identity = {
        provider: 'codex',
        sessionId: 's',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
    };
    const runtime = {
        backend: 'vscode', state: 'active', identity, terminal,
        attached: true, stale: false, runStartedAtMs: 1,
    };
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async message => effects.push(message), getProviderLabel: () => 'Codex', refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: (_provider, session, scope) =>
                session === 's' && scope === 'scope:fixture' ? runtime : null,
            getPending: () => [],
            focus: async () => effects.push('show'),
            detach: async () => effects.push('dispose'),
            terminate: async () => effects.push('terminate'),
        },
        confirmRuntimeClose: async () => 'Close Terminal',
        announceStatus: async () => undefined,
        focusTerminalView: async () => effects.push('focus-terminal-view'),
        onRuntimeCloseStart: current => effects.push(`close-start:${current.runStartedAtMs}`),
        onRuntimeCloseEnd: (current, succeeded) =>
            effects.push(`close-end:${current.runStartedAtMs}:${succeeded}`),
    });
    const focused = await controller.focusActive('p', 'codex', 's');
    await controller.closeTerminal({ projectId: 'p', providerId: 'codex', sessionId: 's' });
    const before = effects.length;
    const missing = await controller.focusActive('other', 'codex', 's');
    assert.deepEqual(
        effects.slice(0, 7),
        [
            'show', 'focus-terminal-view', 'refresh',
            'close-start:1', 'dispose', 'close-end:1:true', 'refresh',
        ]
    );
    assert.equal(effects.length, before);
    assert.equal(focused, true);
    assert.equal(missing, false);
});

test('ATTENTION-STATUS-BAR-QUEUE-001 ACTIVE-SESSION-FOCUS-REVEAL-001 refreshes the sidebar after terminal focus settles', async () => {
    const projectedSessions = [];
    let activeTerminalSessionId = 'previous';
    const identity = {
        provider: 'codex',
        sessionId: 'target',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
    };
    const runtime = {
        backend: 'tmux',
        state: 'active',
        identity,
        terminal: { show() {}, dispose() {} },
        attached: true,
        stale: false,
        runStartedAtMs: 1,
        tmux: { layout: 'project', sessionName: 'project', windowName: 'target' },
    };
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: () => makeWorkspaceTarget([{ id: 'target' }]),
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'Codex',
        refresh: () => projectedSessions.push(activeTerminalSessionId),
        runtimeCoordinator: {
            getById: () => runtime,
            getPending: () => [],
            focus: async () => undefined,
            detach: async () => undefined,
            terminate: async () => undefined,
        },
        confirmRuntimeClose: async () => undefined,
        announceStatus: async () => undefined,
        focusTerminalView: async () => {
            // VS Code publishes activeTerminal only after the workbench focus
            // transition. A refresh before this point projects the old card.
            activeTerminalSessionId = 'target';
        },
    });

    assert.equal(await controller.focusActive('p', 'codex', 'target'), true);
    assert.deepEqual(projectedSessions, ['target'],
        'the final sidebar projection must agree with the terminal and tmux target');
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 can synchronize an active runtime without moving keyboard focus to the Terminal view', async () => {
    const effects = [];
    const identity = {
        provider: 'codex',
        sessionId: 'session-b',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
    };
    const runtime = {
        backend: 'tmux',
        state: 'active',
        identity,
        terminal: { show() {}, dispose() {} },
        attached: true,
        stale: false,
        runStartedAtMs: 1,
    };
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: () => makeWorkspaceTarget([{ id: 'session-b' }]),
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'Codex',
        refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: () => runtime,
            getPending: () => [],
            focus: async (_identity, options) => effects.push(
                `focus-runtime:${options?.preserveFocus === true}`
            ),
            detach: async () => undefined,
            terminate: async () => undefined,
        },
        confirmRuntimeClose: async () => 'Cancel',
        announceStatus: async () => undefined,
        focusTerminalView: async () => effects.push('focus-terminal-view'),
        onRuntimeCloseStart() {},
        onRuntimeCloseEnd() {},
    });

    assert.equal(await controller.focusActive(
        'p',
        'codex',
        'session-b',
        { revealTerminal: false }
    ), true);
    assert.deepEqual(effects, ['focus-runtime:true', 'refresh']);
});

test('ATTENTION-EXPLICIT-SESSION-CLOSE-001 reports failed detach without a success acknowledgement', async () => {
    const effects = [];
    const identity = {
        provider: 'codex',
        sessionId: 's',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
    };
    const runtime = {
        backend: 'vscode', state: 'active', identity,
        terminal: { show() {}, dispose() {} },
        attached: true, stale: false, runStartedAtMs: 2,
    };
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async message => effects.push(`error:${message}`),
        getProviderLabel: () => 'Codex',
        refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: () => runtime,
            getPending: () => [],
            focus: async () => undefined,
            detach: async () => { effects.push('dispose'); throw new Error('close failed'); },
            terminate: async () => undefined,
        },
        confirmRuntimeClose: async () => 'Close Terminal',
        announceStatus: async () => undefined,
        onRuntimeCloseStart: current => effects.push(`close-start:${current.runStartedAtMs}`),
        onRuntimeCloseEnd: (current, succeeded) =>
            effects.push(`close-end:${current.runStartedAtMs}:${succeeded}`),
    });

    await controller.closeTerminal({ projectId: 'p', providerId: 'codex', sessionId: 's' });

    assert.deepEqual(effects, [
        'close-start:2',
        'dispose',
        'close-end:2:false',
        'error:Could not close the AI session terminal.',
        'refresh',
    ]);
});

function makeTmuxStopFixture() {
    const effects = [];
    const confirmations = [];
    const identity = {
        provider: 'codex',
        sessionId: 's',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
    };
    const runtime = {
        backend: 'tmux', state: 'active', identity,
        attached: true, stale: false, runStartedAtMs: 3,
        tmux: { layout: 'session', sessionName: 'ap-project-session-a1b2c3d4' },
    };
    return { effects, confirmations, identity, runtime };
}

test('RUNTIME-TMUX-TERMINATE-SESSION-001 stops a tmux session only after confirmation and acknowledges the close', async () => {
    const { effects, confirmations, runtime } = makeTmuxStopFixture();
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async message => effects.push(`error:${message}`),
        getProviderLabel: () => 'Codex',
        refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: () => runtime,
            getPending: () => [],
            focus: async () => undefined,
            detach: async () => undefined,
            terminate: async () => effects.push('terminate'),
        },
        confirmRuntimeClose: async (message, action) => {
            confirmations.push([message, action]);
            return action;
        },
        announceStatus: async () => undefined,
        onRuntimeCloseStart: current => effects.push(`close-start:${current.runStartedAtMs}`),
        onRuntimeCloseEnd: (current, succeeded) =>
            effects.push(`close-end:${current.runStartedAtMs}:${succeeded}`),
    });

    await controller.stopSession({
        projectId: 'p', providerId: 'codex', sessionId: 's', expectedBackend: 'tmux',
    });

    assert.deepEqual(confirmations, [[
        'Closing this Codex chat will terminate the AI task running in tmux.', 'Close Chat',
    ]]);
    assert.deepEqual(effects, [
        'close-start:3', 'terminate', 'close-end:3:true', 'refresh',
    ]);
});

test('RUNTIME-TMUX-TERMINATE-SESSION-001 closes a direct runtime only after confirmation and acknowledges its exact terminal', async () => {
    const { effects, confirmations, runtime } = makeTmuxStopFixture();
    const directRuntime = {
        ...runtime,
        backend: 'vscode',
        runStartedAtMs: 4,
        terminal: { show() {}, dispose() {} },
        tmux: undefined,
    };
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async message => effects.push(`error:${message}`),
        getProviderLabel: () => 'Codex',
        refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: () => directRuntime,
            getPending: () => [],
            focus: async () => undefined,
            detach: async () => undefined,
            terminate: async identity => {
                assert.deepEqual(identity, directRuntime.identity,
                    'the controller must terminate the confirmed direct runtime identity');
                effects.push('terminate-direct');
            },
        },
        confirmRuntimeClose: async (message, action) => {
            confirmations.push([message, action]);
            return action;
        },
        announceStatus: async () => undefined,
        onRuntimeCloseStart: current => effects.push(`close-start:${current.runStartedAtMs}`),
        onRuntimeCloseEnd: (current, succeeded) =>
            effects.push(`close-end:${current.runStartedAtMs}:${succeeded}`),
    });

    await controller.stopSession({
        projectId: 'p', providerId: 'codex', sessionId: 's', expectedBackend: 'vscode',
    });

    assert.deepEqual(confirmations, [[
        'Closing this Codex chat may interrupt a running AI task.', 'Close Chat',
    ]]);
    assert.deepEqual(effects, [
        'close-start:4', 'terminate-direct', 'close-end:4:true', 'refresh',
    ]);
});

test('PENDING-CHAT-CANCEL-001 cancels the selected pending runtime and follows its unique promoted successor', async () => {
    const createdAt = '2026-08-28T01:02:03.000Z';
    const terminal = { show() {}, dispose() {} };
    const pendingIdentity = {
        provider: 'codex',
        pendingId: 'pending-cancel',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
    };
    const pending = {
        backend: 'vscode', state: 'pending', identity: pendingIdentity,
        terminal, markerPath: '/tmp/pending-cancel',
        runStartedAtMs: Date.parse(createdAt), attached: true, stale: false,
        createdAt, excludedSessionIds: [],
    };
    const otherPending = {
        ...pending,
        identity: { ...pendingIdentity, pendingId: 'pending-other' },
        terminal: { show() {}, dispose() {} },
        markerPath: '/tmp/pending-other',
        createdAt: '2026-08-28T01:02:04.000Z',
        runStartedAtMs: Date.parse('2026-08-28T01:02:04.000Z'),
    };
    const promoted = {
        ...pending,
        state: 'active',
        identity: { ...pendingIdentity, pendingId: undefined, sessionId: 'promoted-session' },
    };
    let pendingRuntimes = [pending, otherPending];
    let activeRuntimes = [];
    const confirmations = [];
    const terminated = [];
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p'
            ? makeWorkspaceTarget([{ id: 'promoted-session' }]) : null,
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'Codex',
        refresh: () => undefined,
        runtimeCoordinator: {
            getById: () => null,
            getActive: () => activeRuntimes,
            getPending: () => pendingRuntimes,
            focus: async () => undefined,
            detach: async () => undefined,
            terminate: async identity => terminated.push(identity),
        },
        confirmRuntimeClose: async (message, action) => {
            confirmations.push([message, action]);
            return action;
        },
        announceStatus: async () => undefined,
    });

    await controller.stopSession({
        projectId: 'p', providerId: 'codex', pendingCreatedAt: createdAt,
        pendingId: 'pending-cancel', pendingRuntimeMarker: '/tmp/pending-cancel',
        expectedBackend: 'vscode',
    });
    assert.deepEqual(confirmations, [[
        'Cancelling this Codex chat may interrupt its startup.', 'Cancel Chat',
    ]]);
    assert.deepEqual(terminated, [pendingIdentity],
        'Cancel must target only the selected pending runtime');

    await controller.stopSession({
        projectId: 'p', providerId: 'codex', pendingCreatedAt: createdAt,
        pendingId: 'pending-cancel', expectedBackend: 'vscode',
    });
    assert.deepEqual(terminated.at(-1), pendingIdentity,
        'a uniquely identified legacy pending runtime remains cancellable without a marker');

    pendingRuntimes = [];
    activeRuntimes = [promoted];
    await controller.stopSession({
        projectId: 'p', providerId: 'codex', pendingCreatedAt: createdAt,
        pendingId: 'pending-cancel', pendingRuntimeMarker: '/tmp/pending-cancel',
        expectedBackend: 'vscode',
    });
    assert.deepEqual(confirmations.at(-1), [
        'Closing this Codex chat may interrupt a running AI task.', 'Close Chat',
    ], 'a chat promoted before Host handling uses the established Close confirmation');
    assert.deepEqual(terminated.at(-1), promoted.identity,
        'a unique promoted successor receives the original Cancel request');

    const unrelated = {
        ...promoted,
        identity: { ...promoted.identity, sessionId: 'unrelated-session' },
        markerPath: '/tmp/unrelated-runtime',
    };
    const confirmationsBeforeUnrelatedRuntime = confirmations.length;
    const terminationsBeforeUnrelatedRuntime = terminated.length;
    activeRuntimes = [unrelated];
    await controller.stopSession({
        projectId: 'p', providerId: 'codex', pendingCreatedAt: createdAt,
        pendingId: 'pending-cancel', pendingRuntimeMarker: '/tmp/pending-cancel',
        expectedBackend: 'vscode',
    });
    assert.equal(confirmations.length, confirmationsBeforeUnrelatedRuntime,
        'a promoted runtime with a different marker must not reach confirmation');
    assert.equal(terminated.length, terminationsBeforeUnrelatedRuntime,
        'a promoted runtime with a different marker must never be terminated');

    pendingRuntimes = [pending];
    activeRuntimes = [];
    const promotionDuringConfirmation = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p'
            ? makeWorkspaceTarget([{ id: 'promoted-session' }]) : null,
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'Codex',
        refresh: () => undefined,
        runtimeCoordinator: {
            getById: () => null,
            getActive: () => activeRuntimes,
            getPending: () => pendingRuntimes,
            focus: async () => undefined,
            detach: async () => undefined,
            terminate: async identity => terminated.push(identity),
        },
        confirmRuntimeClose: async (message, action) => {
            assert.deepEqual([message, action], [
                'Cancelling this Codex chat may interrupt its startup.', 'Cancel Chat',
            ]);
            pendingRuntimes = [];
            activeRuntimes = [promoted];
            return action;
        },
        announceStatus: async () => undefined,
    });
    await promotionDuringConfirmation.stopSession({
        projectId: 'p', providerId: 'codex', pendingCreatedAt: createdAt,
        pendingId: 'pending-cancel', pendingRuntimeMarker: '/tmp/pending-cancel',
        expectedBackend: 'vscode',
    });
    assert.deepEqual(terminated.at(-1), promoted.identity,
        'promotion during confirmation must still close the same runtime');
});

test('PENDING-CHAT-CANCEL-001 follows a uniquely marked tmux promotion', async () => {
    const createdAt = '2026-08-28T01:02:03.000Z';
    const pendingIdentity = {
        provider: 'codex', pendingId: 'pending-tmux-cancel',
        workspaceScopeIdentity: 'scope:fixture', workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'], cwd: '/work',
    };
    const pending = {
        backend: 'tmux', state: 'pending', identity: pendingIdentity,
        markerPath: '/tmp/pending-tmux-cancel', runStartedAtMs: Date.parse(createdAt),
        attached: true, stale: false, createdAt, excludedSessionIds: [],
        tmux: { layout: 'project', sessionName: 'project', windowName: 'pending' },
    };
    const promoted = {
        ...pending, state: 'active',
        identity: { ...pendingIdentity, pendingId: undefined, sessionId: 'promoted-tmux-session' },
        tmux: { layout: 'project', sessionName: 'project', windowName: 'promoted' },
    };
    const terminated = [];
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p'
            ? makeWorkspaceTarget([{ id: 'promoted-tmux-session' }]) : null,
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'Codex', refresh: () => undefined,
        runtimeCoordinator: {
            getById: () => null, getActive: () => [promoted], getPending: () => [],
            focus: async () => undefined, detach: async () => undefined,
            terminate: async identity => terminated.push(identity),
        },
        confirmRuntimeClose: async (message, action) => {
            assert.deepEqual([message, action], [
                'Closing this Codex chat will terminate the AI task running in tmux.', 'Close Chat',
            ]);
            return action;
        },
        announceStatus: async () => undefined,
    });
    await controller.stopSession({
        projectId: 'p', providerId: 'codex', pendingCreatedAt: createdAt,
        pendingId: 'pending-tmux-cancel', pendingRuntimeMarker: '/tmp/pending-tmux-cancel',
        expectedBackend: 'tmux',
    });
    assert.deepEqual(terminated, [promoted.identity],
        'the renamed tmux runtime is terminated only after its marker binds it to the pending chat');
});

test('PENDING-CHAT-CANCEL-001 retries once when coordinator refresh promotes the pending runtime', async () => {
    const createdAt = '2026-08-28T01:02:03.000Z';
    const terminal = { show() {}, dispose() {} };
    const pendingIdentity = {
        provider: 'codex', pendingId: 'pending-refresh-promotion',
        workspaceScopeIdentity: 'scope:fixture', workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'], cwd: '/work',
    };
    const pending = {
        backend: 'vscode', state: 'pending', identity: pendingIdentity, terminal,
        markerPath: '/tmp/pending-refresh-promotion', runStartedAtMs: Date.parse(createdAt),
        attached: true, stale: false, createdAt, excludedSessionIds: [],
    };
    const promoted = {
        ...pending, state: 'active',
        identity: { ...pendingIdentity, pendingId: undefined, sessionId: 'refresh-promoted' },
    };
    let pendingRuntimes = [pending];
    let activeRuntimes = [];
    const terminationAttempts = [];
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p'
            ? makeWorkspaceTarget([{ id: 'refresh-promoted' }]) : null,
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'Codex', refresh: () => undefined,
        runtimeCoordinator: {
            getById: () => null, getActive: () => activeRuntimes, getPending: () => pendingRuntimes,
            focus: async () => undefined, detach: async () => undefined,
            terminate: async identity => {
                terminationAttempts.push(identity);
                if (identity.pendingId) {
                    pendingRuntimes = [];
                    activeRuntimes = [promoted];
                    throw new AiSessionRuntimeTargetChangedError();
                }
            },
        },
        confirmRuntimeClose: async (_message, action) => action,
        announceStatus: async () => undefined,
    });
    await controller.stopSession({
        projectId: 'p', providerId: 'codex', pendingCreatedAt: createdAt,
        pendingId: 'pending-refresh-promotion', pendingRuntimeMarker: '/tmp/pending-refresh-promotion',
        expectedBackend: 'vscode',
    });
    assert.deepEqual(terminationAttempts, [pendingIdentity, promoted.identity],
        'a target change caused by this pending runtime promotion retries exactly once on its successor');
});

test('RUNTIME-TMUX-TERMINATE-SESSION-001 rejects forged backends, cancelled confirmations, and changed runtimes without terminating', async () => {
    const { effects, confirmations, runtime } = makeTmuxStopFixture();
    let currentRuntime = runtime;
    let confirmResult;
    const announcements = [];
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async message => effects.push(`error:${message}`),
        getProviderLabel: () => 'Codex',
        refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: () => currentRuntime,
            getPending: () => [],
            focus: async () => undefined,
            detach: async () => undefined,
            terminate: async () => effects.push('terminate'),
        },
        confirmRuntimeClose: async (message, action) => {
            confirmations.push([message, action]);
            return confirmResult;
        },
        announceStatus: async (projectId, message) => { announcements.push(message); },
    });

    confirmResult = 'Close Chat';
    await controller.stopSession({
        projectId: 'p', providerId: 'codex', sessionId: 's', expectedBackend: 'vscode',
    });
    assert.equal(confirmations.length, 0,
        'a forged backend-specific route must be rejected before confirmation');

    confirmResult = undefined;
    await controller.stopSession({
        projectId: 'p', providerId: 'codex', sessionId: 's', expectedBackend: 'tmux',
    });
    assert.equal(confirmations.length, 1);
    assert.equal(effects.filter(effect => effect === 'terminate').length, 0,
        'a cancelled confirmation must not terminate the runtime');

    confirmResult = 'Close Chat';
    let confirmCalls = 0;
    const hijacked = {
        ...runtime,
        tmux: { layout: 'session', sessionName: 'ap-project-session-deadbeef' },
    };
    const swappingController = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async () => undefined,
        getProviderLabel: () => 'Codex',
        refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: () => confirmCalls++ === 0 ? runtime : hijacked,
            getPending: () => [],
            focus: async () => undefined,
            detach: async () => undefined,
            terminate: async () => effects.push('terminate'),
        },
        confirmRuntimeClose: async () => 'Close Chat',
        announceStatus: async (projectId, message) => { announcements.push(message); },
    });
    await swappingController.stopSession({
        projectId: 'p', providerId: 'codex', sessionId: 's', expectedBackend: 'tmux',
    });
    assert.equal(effects.filter(effect => effect === 'terminate').length, 0,
        'a runtime that changed before confirmation must not be terminated');
    assert.ok(announcements.includes('The AI session runtime changed before terminal confirmation.'));
});

test('RUNTIME-TMUX-TERMINATE-SESSION-001 reports a failed terminate without a success acknowledgement', async () => {
    const { effects, runtime } = makeTmuxStopFixture();
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async message => effects.push(`error:${message}`),
        getProviderLabel: () => 'Codex',
        refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: () => runtime,
            getPending: () => [],
            focus: async () => undefined,
            detach: async () => undefined,
            terminate: async () => { effects.push('terminate'); throw new Error('kill failed'); },
        },
        confirmRuntimeClose: async () => 'Close Chat',
        announceStatus: async () => undefined,
        onRuntimeCloseStart: current => effects.push(`close-start:${current.runStartedAtMs}`),
        onRuntimeCloseEnd: (current, succeeded) =>
            effects.push(`close-end:${current.runStartedAtMs}:${succeeded}`),
    });

    await controller.stopSession({
        projectId: 'p', providerId: 'codex', sessionId: 's', expectedBackend: 'tmux',
    });

    assert.deepEqual(effects, [
        'close-start:3',
        'terminate',
        'close-end:3:false',
        'error:Could not close the AI chat.',
        'refresh',
    ]);
});

test('SESSION-AI-SESSION-TERMINAL-COMMAND-CONTROLLER-001 focuses the workbench only after pending and selected-conflict runtime success', async () => {
    const effects = [];
    let rejectFocus = false;
    const pendingIdentity = {
        provider: 'codex',
        pendingId: 'pending',
        workspaceScopeIdentity: 'scope:fixture',
        workspaceNavigationIdentity: 'navigation:fixture',
        workspaceRootHostPaths: ['/work'],
        cwd: '/work',
    };
    const pending = {
        backend: 'tmux', state: 'pending', identity: pendingIdentity,
        createdAt: '2026-07-24T00:00:00.000Z', excludedSessionIds: [],
        attached: false, stale: false, runStartedAtMs: 1,
        tmux: { layout: 'project', sessionName: 'project', windowName: 'pending' },
    };
    const conflictIdentity = {
        ...pendingIdentity,
        pendingId: undefined,
        sessionId: 's',
    };
    const conflict = {
        backend: 'tmux', state: 'conflict', identity: conflictIdentity,
        attached: true, stale: false, runStartedAtMs: 1,
        tmux: { layout: 'project', sessionName: 'project', windowName: 'session' },
    };
    const controller = new AiSessionTerminalCommandController({
        isProviderId: value => value === 'codex',
        getWorkspaceTarget: id => id === 'p' ? makeWorkspaceTarget([{ id: 's' }]) : null,
        showErrorMessage: async message => effects.push(`error:${message}`),
        getProviderLabel: () => 'Codex',
        refresh: () => effects.push('refresh'),
        runtimeCoordinator: {
            getById: () => conflict,
            getActiveCandidates: () => [conflict],
            getPending: () => [pending],
            focus: async () => {
                effects.push('focus-runtime');
                if (rejectFocus) throw new Error('focus failed');
            },
            focusSelected: async () => {
                effects.push('focus-selected-runtime');
                return true;
            },
            detach: async () => undefined,
            terminate: async () => undefined,
        },
        chooseRuntimeConflict: async () => conflict,
        confirmRuntimeClose: async () => undefined,
        announceStatus: async () => undefined,
        focusTerminalView: async () => effects.push('focus-terminal-view'),
    });

    await controller.focusPending('p', 'codex', pending.createdAt);
    assert.deepEqual(effects, ['focus-runtime', 'refresh', 'focus-terminal-view']);

    effects.length = 0;
    await controller.focusActive('p', 'codex', 's');
    assert.deepEqual(effects, ['focus-selected-runtime', 'focus-terminal-view', 'refresh']);

    effects.length = 0;
    rejectFocus = true;
    await controller.focusPending('p', 'codex', pending.createdAt);
    assert.deepEqual(effects, [
        'focus-runtime',
        'error:Could not focus the AI session terminal.',
        'refresh',
    ]);
});

test('SESSION-AI-SESSION-EXECUTION-CONTROLLER-001 CONVERSATION-WORKING-INDICATOR-001 schedules Dashboard and Conversation refreshes only when lifecycle output changes', () => {
    const refreshes = [];
    const conversationRefreshes = [];
    let token = 'one';
    const controller = new AiSessionExecutionController({
        getActiveSessions: () => [{ provider: 'codex', sessionId: 's', runStartedAtMs: 1 }],
        scheduleRefresh: reason => refreshes.push(reason),
        onExecutionLifecycleChanged: keys => conversationRefreshes.push(keys),
        nowMs: () => 1,
    });
    const signals = () => ({ codex: { s: {
        token, occurredAtMs: token === 'one' ? 2 : 3, executionState: token === 'one' ? 'running' : 'stopped',
    } } });
    controller.evaluate(signals());
    controller.evaluate(signals());
    token = 'two';
    controller.evaluate(signals());
    assert.deepEqual(refreshes, ['execution', 'execution']);
    assert.deepEqual(conversationRefreshes, [
        ['codex:s'],
        ['codex:s'],
    ], 'every lifecycle edge must refresh the Conversation independently of Dashboard visibility');
    assert.equal(controller.getSnapshot()['codex:s'].state, 'stopped');

    assert.deepEqual(controller.getLifecycleRequests(), {
        codex: [{ sessionId: 's', runStartedAtMs: 1 }],
    }, 'the controller publishes its request set for the shared reader to merge');
});

test('CONVERSATION-WORKING-INDICATOR-001 refreshes only the Conversation whose execution state changed', () => {
    const changedKeys = ['codex:background-session'];
    assert.equal(
        shouldRefreshConversationForExecutionChange(
            changedKeys, 'codex', 'session-a'
        ),
        false,
        'an unrelated lifecycle edge must not re-render the viewed Conversation'
    );
    assert.equal(
        shouldRefreshConversationForExecutionChange(
            changedKeys, 'codex', 'background-session'
        ),
        true
    );
});

test('CONVERSATION-WORKING-INDICATOR-001 refreshes on a first-observed terminal lifecycle signal', () => {
    const refreshes = [];
    const conversationRefreshes = [];
    const controller = new AiSessionExecutionController({
        getActiveSessions: () => [{
            provider: 'codex', sessionId: 'session-a', runStartedAtMs: 1,
        }],
        scheduleRefresh: reason => refreshes.push(reason),
        onExecutionLifecycleChanged: keys => conversationRefreshes.push(keys),
        nowMs: () => 10,
    });
    const completed = {
        codex: {
            'session-a': {
                token: 'completed-first-observation',
                occurredAtMs: 10,
                executionState: 'stopped',
            },
        },
    };

    controller.evaluate(completed);
    controller.evaluate(completed);

    assert.deepEqual(refreshes, [],
        'the stopped execution projection did not change from its initial value');
    assert.deepEqual(conversationRefreshes, [['codex:session-a']],
        'the first terminal token still clears a stale Working presentation once');
});

test('SESSION-AI-SESSION-EXECUTION-MONITOR-001 reads lifecycle signals once for the union of every consumer', () => {
    const calls = [];
    const service = providerId => ({
        getLifecycleSignals: requests => {
            calls.push({
                provider: providerId,
                requests: requests.map(request => request.sessionId).sort(),
            });
            return Object.fromEntries(requests.map(request => [request.sessionId, {
                token: `${providerId}:${request.sessionId}`,
                phase: 'running',
                executionState: 'running',
                occurredAtMs: 10,
            }]));
        },
    });
    const providers = [
        { id: 'codex', service: service('codex') },
        { id: 'claude', service: service('claude') },
    ];

    // Execution tracks the live runtimes; attention additionally keeps a session
    // whose runtime is settling. Each provider must see one merged request set
    // covering only its own sessions.
    const reader = new AiSessionLifecycleSignalReader({
        getProviders: () => providers,
        getRequests: () => [
            { codex: [{ sessionId: 'shared', runStartedAtMs: 0 }] },
            {
                codex: [
                    { sessionId: 'shared', runStartedAtMs: 0 },
                    { sessionId: 'settling', runStartedAtMs: 0 },
                ],
            },
        ],
    });
    const signals = reader.read();

    assert.deepEqual(calls, [{ provider: 'codex', requests: ['settling', 'shared'] }],
        'the owning provider is asked once for the union and foreign providers are not asked');
    assert.equal(signals.codex.shared.token, 'codex:shared');
    assert.equal(signals.codex.settling.token, 'codex:settling');
    assert.deepEqual(signals.claude, {}, 'a provider with no requested session still reports an empty map');
});

test('SESSION-AI-SESSION-EXECUTION-MONITOR-001 keeps the first run start when consumers disagree', () => {
    const calls = [];
    const providers = [{
        id: 'codex',
        service: {
            getLifecycleSignals: requests => {
                calls.push(requests.map(request => `${request.sessionId}@${request.runStartedAtMs}`));
                return {};
            },
        },
    }];
    const reader = new AiSessionLifecycleSignalReader({
        getProviders: () => providers,
        getRequests: () => [
            { codex: [{ sessionId: 'a', runStartedAtMs: 100 }] },
            // A stale duplicate must not add a second request for the same session,
            // which would make the provider rebuild its cursor every read.
            { codex: [{ sessionId: 'a', runStartedAtMs: 200 }] },
        ],
    });
    reader.read();
    assert.deepEqual(calls, [['a@100']]);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 every worktree session creation enters the deletion admission mutex', async () => {
    // No retired identity: prepareGenerationClaim returns null, but the
    // admission wrapper must still run around claim + create.
    const order = [];
    const fixture = makeQuickCreateController({
        prepareGenerationClaim: async () => {
            order.push('claim');
            return null;
        },
        withWorktreeDeletionAdmission: async (scope, operation) => {
            order.push('admission-enter');
            const result = await operation();
            order.push('admission-exit');
            return result;
        },
        runtimeCoordinator: {
            create: async () => {
                order.push('create');
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
    });
    assert.equal(await fixture.controller.createSessionQuick('p', 'kimi', undefined, {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/worktrees/feature-auth',
    }), true);
    assert.deepEqual(order, ['admission-enter', 'claim', 'create', 'admission-exit'],
        'claim persistence and runtime creation both run inside the admission lock');
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 a leased group refuses the session before any side effect', async () => {
    let creates = 0;
    let claims = 0;
    const fixture = makeQuickCreateController({
        prepareGenerationClaim: async () => {
            claims += 1;
            return 'claim-1';
        },
        withWorktreeDeletionAdmission: async () => {
            const error = new Error('group-leased');
            error.code = 'group-leased';
            throw error;
        },
        runtimeCoordinator: {
            create: async () => {
                creates += 1;
                return { status: 'started', backend: 'vscode' };
            },
            getActive: () => [],
            getPending: () => [],
        },
    });
    // The legacy quick-create boolean always reports true; the lease
    // guarantee is zero side effects plus a user-visible warning.
    await fixture.controller.createSessionQuick('p', 'kimi', undefined, {
        repositoryKey: '/work/.git',
        canonicalWorktreePath: '/worktrees/feature-auth',
    });
    assert.equal(creates, 0, 'no runtime was created');
    assert.equal(claims, 0, 'no claim is written once the lease check fails');
    assert.ok(fixture.effects.some(effect =>
        effect[0] === 'warning' && /being deleted/.test(effect[1])));
});
