'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const { DirectTerminalRuntimeBackend } = require('../../../out/aiSessions/directTerminalRuntimeBackend');
const { AiSessionRuntimeCoordinator } = require('../../../out/aiSessions/runtimeCoordinator');
const { TmuxAttachBindingStore } = require('../../../out/aiSessions/tmuxAttachBindingStore');
const { TmuxClient } = require('../../../out/aiSessions/tmuxClient');
const { TmuxRuntimeBackend } = require('../../../out/aiSessions/tmuxRuntimeBackend');
const { TmuxRuntimeBindingStore } = require('../../../out/aiSessions/tmuxRuntimeBindingStore');
const { TmuxRuntimeDiscovery } = require('../../../out/aiSessions/tmuxRuntimeDiscovery');

const REQUIRED_COMMANDS = [
    'new-session', 'new-window', 'list-windows', 'list-panes', 'set-option', 'show-options',
    'select-window', 'attach-session', 'has-session', 'rename-session', 'rename-window',
    'display-message', 'kill-session', 'kill-window',
];

function createTerminalService(events) {
    return {
        getTrackedTerminalEntries: () => [],
        getPendingTerminals: () => [],
        isComplete: () => false,
        replacePendingTerminals() {},
        handleClosedTerminal() {},
        async restorePersistedTerminals() { events.push('direct-restored'); },
    };
}

function createWorkspaceState() {
    const values = new Map();
    return {
        get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
        update: async (key, value) => {
            if (value === undefined) values.delete(key);
            else values.set(key, value);
        },
    };
}

function createRunner(calls) {
    return {
        run: async (file, args) => {
            calls.push({ file, args });
            if (args[0] === '-V') return { exitCode: 0, stdout: 'tmux 3.4\n', stderr: '' };
            if (args[0] === 'list-commands') {
                return { exitCode: 0, stdout: REQUIRED_COMMANDS.join('\n'), stderr: '' };
            }
            if (args[0] === 'list-windows') {
                return { exitCode: 1, stdout: '', stderr: 'no server running on /tmp/tmux' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
}

function assembleRuntimeHost(t, events) {
    const root = makeTempDirectory(t, 'runtime-composition-');
    const calls = [];
    const terminalService = createTerminalService(events);
    const runtimeStore = new TmuxRuntimeBindingStore(root, () => Date.parse('2026-07-23T00:00:00.000Z'));
    const attachStore = new TmuxAttachBindingStore(createWorkspaceState());
    const client = new TmuxClient('/opt/bin/tmux', createRunner(calls));
    const discovery = new TmuxRuntimeDiscovery({
        client,
        bindingStore: runtimeStore,
        markerIsCurrent: () => true,
        cacheTtlMs: 0,
    });
    const direct = new DirectTerminalRuntimeBackend(terminalService);
    const tmux = new TmuxRuntimeBackend({
        platform: 'linux', client, discovery, runtimeStore, attachStore,
        withCreationLock: async (_key, operation) => operation(),
        createTerminal: options => ({ name: options.name, processId: Promise.resolve(1), dispose() {}, show() {} }),
        nowMs: () => Date.parse('2026-07-23T00:00:00.000Z'),
    });
    const restoreAttachTerminals = tmux.restoreAttachTerminals.bind(tmux);
    tmux.restoreAttachTerminals = async terminals => {
        await restoreAttachTerminals(terminals);
        events.push('tmux-restored');
    };
    const coordinator = new AiSessionRuntimeCoordinator({
        direct,
        tmux,
        getConfiguration: () => ({ mode: 'vscode', tmuxLayout: 'project', tmuxPath: '/opt/bin/tmux' }),
        chooseTmuxFallback: async () => 'cancel',
        hasLiveTmuxOwnership: async () => false,
    });
    return { attachStore, calls, client, coordinator, direct, discovery, runtimeStore, terminalService, tmux };
}

async function restoreRuntimeHost(composition, terminals, createHydration) {
    await composition.discovery.loadPersistedInactive();
    await composition.terminalService.restorePersistedTerminals(terminals);
    await composition.tmux.restoreAttachTerminals(terminals);
    return createHydration();
}

function runProductionActivation(mode) {
    // NODE_V8_COVERAGE is inherited on purpose. This harness is the only thing
    // that executes src/dashboard.ts, so clearing it (as the tmux smoke harness
    // deliberately does, to keep instrumentation out of a real-tmux run) made
    // the largest file in the extension invisible to c8 entirely.
    const result = spawnSync(process.execPath, [
        path.resolve(__dirname, '../../fixtures/aiSessions/runtimeHostActivationHarness.js'),
        mode,
    ], { encoding: 'utf8', env: process.env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

const RESTORE_EVENTS = new Set([
    'inactive-restored',
    'direct-restored',
    'direct-failed',
    'tmux-restored',
    'tmux-restore-failed',
    'hydration-constructed',
]);

function isRestoreEvent(event) {
    return RESTORE_EVENTS.has(event);
}

test('WEBVIEW-TWO-STAGE-STARTUP-001 RUNTIME-BOOTSTRAP-TMUX-RESTORE-DEFERRAL-001 production activation adopts ready UI while runtime recovery is pending', () => {
    const result = runProductionActivation('pending');
    assert.equal(result.failure, null);
    assert.equal(result.providerRegistrations, 1);
    assert.equal(result.pendingDirectRestoreEntered, true);
    assert.equal(result.tmuxRestoreEnteredBeforeDirectRestoreSettled, true,
        'tmux discovery must start while Direct terminal process IDs are still pending');
    assert.equal(result.tmuxRestorePublishedBeforeDirectRestoreSettled, true,
        'tmux settlement must publish without waiting for Direct terminal process IDs');
    assert.equal(result.activationReturnedBeforeDirectRestoreSettled, true);
    assert.equal(result.bootHtmlAssigned, true);
    assert.ok(result.readyHtmlAssignments >= 1,
        'the authoritative dashboard document must render while Direct recovery is pending');
    assert.equal(result.inFlightListenerDisposedBeforeGateRelease, true);
    assert.equal(result.openTerminalListenerDisposals, 1);
    assert.deepEqual(result.lateResourceAcquisitions, []);
    assert.deepEqual(result.postDisposePublications, []);
    assert.equal(result.lateAttentionClientObserved, true);
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 restored provisioning rows publish after composition settles', () => {
    // Regression: restoring persisted provisioning rows published during the
    // IsolatedSessionController constructor, reaching view refreshes before
    // the dashboard composition existed and killing bootstrap with a TDZ
    // error whenever a recovery record survived into activation.
    const result = runProductionActivation('restored-provisioning');
    assert.equal(result.bootstrapState, 'ready',
        'activation with a persisted provisioning record must not fail bootstrap');
    assert.equal(result.failure, null);
    assert.equal(result.providerRegistrations, 1);
});

test('WEBVIEW-DASHBOARD-COMMAND-AVAILABILITY-001 production activation exposes commands while runtime recovery is pending', () => {
    const result = runProductionActivation('pending');
    assert.equal(result.failure, null);
    assert.deepEqual(result.registeredCommands.filter(command => command.startsWith('agentPivot.')), [
        'agentPivot.open',
        'agentPivot.addProject',
        'agentPivot.saveProject',
        'agentPivot.removeProject',
        'agentPivot.editProjects',
        'agentPivot.addGroup',
        'agentPivot.removeGroup',
        'agentPivot.addProjectsFromFolder',
        'agentPivot.addFileToActiveTerminal',
        'agentPivot.insertPromptToActiveTerminal',
        'agentPivot.migrateSkillsToCentral',
        'agentPivot.changeGlobalSkillsLocation',
        'agentPivot.openCurrentAiSessionConversation',
        'agentPivot.seekLatestConversationInteraction',
        'agentPivot.previousActiveSession',
        'agentPivot.nextActiveSession',
        'agentPivot.nextAttentionSession',
        'agentPivot.nextRunningSession',
        'agentPivot.nextActiveChatInWindow',
        'agentPivot.nextAttentionChatInWindow',
        'agentPivot.switchToAiSession',
        'agentPivot.switchWorktreeOrSession',
        'agentPivot.toggleLastAiSession',
        'agentPivot.switchToOpenWindow',
        'agentPivot.notify.setWebhook',
        'agentPivot.notify.showOutput',
        'agentPivot.notify.sendTest',
        'agentPivot.sponsor',
    ]);
    assert.equal(result.dashboardCommandRegistrationInvocations, 1);
    assert.equal(result.pendingOpenRevealedBootShell, true);
    assert.equal(result.pendingUnavailableCommandError, null);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 production startup diagnostics preserve exact order and bounded fields', () => {
    const result = runProductionActivation('diagnostics');
    assert.equal(result.failure, null);
    const normalizedDiagnostics = result.startupDiagnostics.map(diagnostic => {
        let normalized = diagnostic;
        if (Object.hasOwn(normalized, 'phases')) {
            assert.deepEqual(Object.keys(normalized.phases), [
                'skill-scan',
                'tmux-persisted-inactive-restore',
                'direct-terminal-restore',
                'tmux-attach-restore',
                'tmux-restore-wait',
                'startup-sequence',
            ]);
            for (const value of Object.values(normalized.phases)) {
                assert.equal(Number.isFinite(value), true);
                assert.ok(value >= 0);
            }
            normalized = { ...normalized, phases: '<phases>' };
        }
        if (Object.hasOwn(normalized, 'sinceModuleLoadMs')) {
            assert.equal(Number.isFinite(normalized.sinceModuleLoadMs), true);
            assert.ok(normalized.sinceModuleLoadMs >= 0);
            normalized = { ...normalized, sinceModuleLoadMs: '<sinceModuleLoadMs>' };
        }
        if (!Object.hasOwn(normalized, 'durationMs')) {
            return normalized;
        }
        assert.equal(Number.isFinite(normalized.durationMs), true);
        assert.ok(normalized.durationMs >= 0);
        return { ...normalized, durationMs: '<durationMs>' };
    });
    assert.deepEqual(normalizedDiagnostics, [
        {
            event: 'agent-pivot-activation-entered',
            sinceModuleLoadMs: '<sinceModuleLoadMs>',
        },
        {
            event: 'agent-pivot-boot-shell-assigned',
            generation: 1,
        },
        {
            event: 'agent-pivot-bootstrap-tmux-restore-deferred',
            generation: 1,
            budgetMs: 0,
        },
        {
            event: 'agent-pivot-bootstrap-phases',
            generation: 1,
            phases: '<phases>',
        },
        {
            event: 'agent-pivot-bootstrap-ready',
            generation: 1,
            durationMs: '<durationMs>',
        },
        {
            event: 'agent-pivot-bootstrap-tmux-restore-settled',
            generation: 1,
            outcome: 'restored',
        },
    ]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 deferred Direct recovery failure keeps ready diagnostics privacy-safe', () => {
    const result = runProductionActivation('direct-failure');
    assert.equal(result.failure, null);
    assert.equal(result.bootstrapState, 'ready');
    assert.equal(result.startupDiagnostics.some(diagnostic =>
        diagnostic.event === 'agent-pivot-bootstrap-tmux-restore-settled'
            && diagnostic.outcome === 'restored'), true);
    assert.equal(result.startupDiagnostics.some(diagnostic =>
        diagnostic.event === 'agent-pivot-bootstrap-ready'), true);
    const serialized = JSON.stringify(result.startupDiagnostics);
    for (const canary of [
        'PRIVATE_PATH_CANARY',
        'PRIVATE_PROJECT_CANARY',
        'PRIVATE_PROMPT_CANARY',
        'PRIVATE_SESSION_CANARY',
        'PRIVATE_PROVIDER_PAYLOAD_CANARY',
        'PRIVATE_RAW_ERROR_CANARY',
    ]) {
        assert.equal(serialized.includes(canary), false, canary);
    }
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 SESSION-ALIAS-THREAD-SWITCH-001 CONVERSATION-SESSION-REBIND-001 ATTENTION-ACTIVE-UNREGISTER-ON-DEACTIVATE-001 production activation wires lifecycle ownership around deferred recovery', () => {
    const result = runProductionActivation('success');
    assert.equal(result.failure, null);
    assert.deepEqual(result.events.filter(isRestoreEvent), [
        'inactive-restored', 'direct-restored', 'hydration-constructed', 'tmux-restored',
    ]);
    assert.deepEqual(result.events.slice(-2), [
        'attention-shutdown-complete', 'dashboard-deactivated',
    ]);
    assert.equal(result.attentionShutdownCalls, 1);
    assert.deepEqual(result.verified, [
        'client-store-discovery', 'direct-tmux-coordinator', 'thread-switch-alias-wiring',
        'tmux-backend',
    ]);
    assert.deepEqual(result.aliasRebinds, [['codex', 'old-root', 'new-root']]);
    assert.deepEqual(result.conversationMetadataRebinds, [
        ['comments', {
            projectId: result.expectedConversationProjectId,
            provider: 'codex',
            sessionId: 'old-root',
        }, {
            projectId: result.expectedConversationProjectId,
            provider: 'codex',
            sessionId: 'new-root',
        }],
        ['bookmarks', {
            projectId: result.expectedConversationProjectId,
            provider: 'codex',
            sessionId: 'old-root',
        }, {
            projectId: result.expectedConversationProjectId,
            provider: 'codex',
            sessionId: 'new-root',
        }],
    ]);
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 Direct recovery failure preserves independent tmux restore without blocking hydration', () => {
    const result = runProductionActivation('direct-failure');
    assert.equal(result.failure, null);
    assert.equal(result.bootstrapState, 'ready');
    assert.deepEqual(result.events.filter(isRestoreEvent), [
        'inactive-restored',
        'direct-failed',
        'hydration-constructed',
        'tmux-restored',
    ]);
    assert.equal(result.tmuxRestoreEnteredBeforeDirectRestoreSettled, false);
    assert.equal(result.events.includes('hydration-constructed'), true);
    assert.equal(result.rawDirectFailureExposedInHtml, false);
    assert.deepEqual(result.verified, [
        'client-store-discovery', 'direct-tmux-coordinator', 'thread-switch-alias-wiring',
        'tmux-backend',
    ]);
});

test('RUNTIME-BOOTSTRAP-TMUX-RESTORE-DEFERRAL-001 slow tmux recovery does not block ready rendering and refreshes after settlement', () => {
    const result = runProductionActivation('slow-tmux-restore');
    assert.equal(result.failure, null);
    assert.equal(result.pendingTmuxRestoreEntered, true);
    assert.equal(result.readyBeforeTmuxRestoreSettled, true);
    assert.deepEqual(result.events.filter(isRestoreEvent), [
        'inactive-restored',
        'direct-restored',
        'hydration-constructed',
        'tmux-restored',
    ]);
    assert.equal(result.tmuxRestoreRefreshCount, 1);
    assert.deepEqual(result.tmuxRestoreDiagnostics, [
        {
            event: 'agent-pivot-bootstrap-tmux-restore-deferred',
            generation: 1,
            budgetMs: 0,
        },
        {
            event: 'agent-pivot-bootstrap-tmux-restore-settled',
            generation: 1,
            outcome: 'restored',
        },
    ]);
});

test('RUNTIME-BOOTSTRAP-TMUX-RESTORE-DEFERRAL-001 late Direct recovery publishes its own refresh after tmux', () => {
    const result = runProductionActivation('slow-direct-restore');
    assert.equal(result.failure, null);
    assert.equal(result.pendingDirectRestoreEntered, true);
    assert.equal(result.tmuxRestoreEnteredBeforeDirectRestoreSettled, true);
    assert.equal(result.directRestoreRefreshAfterSettlement, true);
    assert.equal(result.directRestoreRefreshCount, 1);
});

test('RUNTIME-BOOTSTRAP-TMUX-RESTORE-DEFERRAL-001 slow startup runtime recovery does not block ready rendering', () => {
    const result = runProductionActivation('slow-runtime-restore');
    assert.equal(result.failure, null);
    assert.equal(result.pendingInactiveRestoreEntered, true);
    assert.equal(result.pendingDirectRestoreEntered, true);
    assert.equal(result.readyBeforeRuntimeRestoresSettled, true);
    assert.deepEqual(result.events.filter(isRestoreEvent), [
        'hydration-constructed',
        'inactive-restored',
        'direct-restored',
        'tmux-restored',
    ]);
    assert.equal(result.tmuxRestoreRefreshCount, 1);
    assert.deepEqual(result.tmuxRestoreDiagnostics, [
        {
            event: 'agent-pivot-bootstrap-tmux-restore-deferred',
            generation: 1,
            budgetMs: 0,
        },
        {
            event: 'agent-pivot-bootstrap-tmux-restore-settled',
            generation: 1,
            outcome: 'restored',
        },
    ]);
});

test('RUNTIME-BOOTSTRAP-TMUX-RESTORE-DEFERRAL-001 ready rendering does not depend on the restore budget timer', () => {
    const result = runProductionActivation('blocked-restore-budget');
    assert.equal(result.failure, null);
    assert.equal(result.pendingInactiveRestoreEntered, true);
    assert.equal(result.pendingDirectRestoreEntered, true);
    assert.equal(result.readyBeforeRuntimeRestoresSettled, true);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 ready rendering does not wait for post-ready startup effects while mutations wait for migration', () => {
    const result = runProductionActivation('slow-startup-sequence');
    assert.equal(result.failure, null);
    assert.equal(result.pendingStartupSequenceEntered, true);
    assert.equal(result.readyBeforeStartupSequenceSettled, true);
    assert.equal(result.projectMutationBlockedDuringMigration, true);
    assert.equal(result.projectMutationInvocations, 1);
    assert.equal(result.readOnlyHydrationPassedDuringMigration, true);
});

test('RUNTIME-BOOTSTRAP-TMUX-RESTORE-DEFERRAL-001 disposed bootstrap ignores late tmux recovery settlement', () => {
    const result = runProductionActivation('slow-tmux-restore-dispose');
    assert.equal(result.failure, null);
    assert.equal(result.readyBeforeTmuxRestoreSettled, true);
    assert.deepEqual(result.postDisposePublications, []);
    assert.deepEqual(result.postDisposeWebviewMessages, []);
    assert.equal(result.tmuxRestoreRefreshCount, 0);
    assert.deepEqual(result.tmuxRestoreDiagnostics, [
        {
            event: 'agent-pivot-bootstrap-tmux-restore-deferred',
            generation: 1,
            budgetMs: 0,
        },
    ]);
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 RUNTIME-TMUX-STORE-001 production activation stores tmux runtime bindings under the locked extension storage', () => {
    const result = runProductionActivation('success');
    assert.equal(result.failure, null);
    assert.deepEqual(result.runtimeStoreRoots, [
        path.join(result.storageRoot, 'ai-session-tmux-runtimes'),
    ]);
    assert.equal(
        result.tmuxCreationLockInvocations.every(
            invocation => invocation.root === result.storageRoot
        ),
        true,
        'tmux filesystem mutation locks must stay inside the extension global storage'
    );
    assert.equal(
        result.tmuxCreationLockInvocations.some(
            invocation => invocation.key === 'runtime-binding-final-records'
        ),
        true,
        'final runtime binding records must be serialized under the creation lock'
    );
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 production tmux fallback prompt is modal for known hints and plain otherwise', () => {
    const result = runProductionActivation('fallback-choice');
    assert.equal(result.failure, null);
    assert.deepEqual(result.warningMessages, [
        {
            message: 'Agent Pivot cannot verify the previous tmux runtime.'
                + ' Resuming in VS Code may start a duplicate AI process.',
            modal: true,
            items: ['Resume in VS Code Anyway', 'Open Settings'],
        },
        {
            message: 'Agent Pivot cannot use tmux in this extension host.',
            modal: false,
            items: ['Use VS Code Terminal This Time', 'Open Settings'],
        },
    ]);
    assert.deepEqual(result.fallbackResumeStatuses, ['cancelled', 'cancelled']);
    assert.deepEqual(
        result.tmuxRuntimeFailureDiagnostics.filter(
            diagnostic => diagnostic.operation === 'resume-fallback'
        ),
        [
            { event: 'tmux-runtime-failure', operation: 'resume-fallback', backend: 'tmux', category: 'not-found' },
            { event: 'tmux-runtime-failure', operation: 'resume-fallback', backend: 'tmux', category: 'not-found' },
        ]
    );
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 RUNTIME-RUNTIME-CONFIGURATION-001 CONVERSATION-THINKING-VISIBILITY-001 production configuration change routes runtime and Conversation settings', () => {
    const result = runProductionActivation('configuration-change');
    assert.equal(result.failure, null);
    assert.deepEqual(result.runtimeConfigurationSequence, [
        'set-executable-path:tmux',
        'discovery-invalidated',
        'refresh-for-host:true',
    ]);
    assert.equal(
        result.affectsConfigurationQueries.includes('agentPivot.aiSessionTerminalMode'),
        true,
        'the configuration listener must match the AI session terminal mode key'
    );
    assert.equal(
        result.affectsConfigurationQueries.includes(
            'agentPivot.aiConversation.showThinking'
        ),
        true,
        'the configuration listener must match the shared Thinking visibility key'
    );
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 production tmux restore failure stays privacy-safe and does not block hydration', () => {
    const result = runProductionActivation('tmux-restore-failure');
    assert.equal(result.failure, null);
    assert.equal(result.bootstrapState, 'ready');
    assert.deepEqual(result.events.filter(isRestoreEvent), [
        'inactive-restored',
        'direct-restored',
        'hydration-constructed',
        'tmux-restore-failed',
    ]);
    assert.deepEqual(result.tmuxRuntimeFailureDiagnostics, [
        {
            event: 'tmux-runtime-failure',
            operation: 'restore-attach-terminals',
            backend: 'tmux',
            category: 'unexpected',
        },
    ]);
    assert.deepEqual(result.leakedPrivacyCanaries, []);
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 production activation restores tmux attachments for terminals opened after activation', () => {
    const result = runProductionActivation('opened-terminal-restore');
    assert.equal(result.failure, null);
    assert.deepEqual(result.restoreAttachTerminalsInvocations, [
        [],
        ['tmux-attach-terminal'],
    ], 'a terminal opened after activation must recover its tmux attachment exactly once');
    assert.equal(
        result.refreshMessageBuildsAfterOpenedTerminal > result.refreshMessageBuildsBeforeOpenedTerminal,
        true,
        'restoring an opened attach terminal must publish an incremental refresh'
    );
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 production activation hydrates the workspace through the coordinator runtimes', () => {
    const result = runProductionActivation('workspace-hydration');
    assert.equal(result.failure, null);
    const hydration = result.hydrationDiagnostics.find(diagnostic => diagnostic.workspaceCount === 1);
    assert.ok(hydration, 'a workspace folder must hydrate through the workspace path');
    assert.ok(result.coordinatorGetActiveCalls >= 1 && result.coordinatorGetPendingCalls >= 1,
        'the projection snapshot must consume both dashboard runtime coordinator views');
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 assembles real runtime components and restores ownership before hydration', async t => {
    const events = [];
    const composition = assembleRuntimeHost(t, events);
    assert.ok(composition.direct instanceof DirectTerminalRuntimeBackend);
    assert.ok(composition.client instanceof TmuxClient);
    assert.ok(composition.discovery instanceof TmuxRuntimeDiscovery);
    assert.ok(composition.runtimeStore instanceof TmuxRuntimeBindingStore);
    assert.ok(composition.attachStore instanceof TmuxAttachBindingStore);
    assert.ok(composition.tmux instanceof TmuxRuntimeBackend);
    assert.ok(composition.coordinator instanceof AiSessionRuntimeCoordinator);

    const hydrated = await restoreRuntimeHost(composition, [], () => {
        events.push('hydration-created');
        return { coordinator: composition.coordinator };
    });
    assert.deepEqual(events, ['direct-restored', 'tmux-restored', 'hydration-created']);
    assert.equal(hydrated.coordinator, composition.coordinator);
    assert.ok(composition.calls.some(call => call.args[0] === 'list-windows'));
    await composition.coordinator.refreshForHost(true);
    assert.deepEqual(composition.coordinator.getActive(), []);
    assert.deepEqual(composition.coordinator.getPending(), []);
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 does not construct hydration when Direct restoration fails', async t => {
    const events = [];
    const composition = assembleRuntimeHost(t, events);
    composition.terminalService.restorePersistedTerminals = async () => {
        events.push('direct-failed');
        throw new Error('restore failed');
    };
    let hydrationCalls = 0;
    await assert.rejects(restoreRuntimeHost(composition, [], () => {
        hydrationCalls += 1;
    }), /restore failed/);
    assert.deepEqual(events, ['direct-failed']);
    assert.equal(hydrationCalls, 0);
    assert.equal(composition.calls.some(call => call.args[0] === 'list-windows'), false);
});
