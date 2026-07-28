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
    'display-message',
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
    const environment = { ...process.env, NODE_V8_COVERAGE: '' };
    const result = spawnSync(process.execPath, [
        path.resolve(__dirname, '../../fixtures/aiSessions/runtimeHostActivationHarness.js'),
        mode,
    ], { encoding: 'utf8', env: environment });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

const RESTORE_EVENTS = new Set([
    'inactive-restored',
    'direct-restored',
    'direct-failed',
    'tmux-restored',
    'hydration-constructed',
]);

function isRestoreEvent(event) {
    return RESTORE_EVENTS.has(event);
}

test('WEBVIEW-TWO-STAGE-STARTUP-001 production activation returns while ordered bootstrap is pending', () => {
    const result = runProductionActivation('pending');
    assert.equal(result.failure, null);
    assert.equal(result.providerRegistrations, 1);
    assert.equal(result.pendingDirectRestoreEntered, true);
    assert.equal(result.activationReturnedBeforeDirectRestoreSettled, true);
    assert.equal(result.bootHtmlAssigned, true);
    assert.equal(result.inFlightListenerDisposedBeforeGateRelease, true);
    assert.equal(result.openTerminalListenerDisposals, 1);
    assert.deepEqual(result.lateResourceAcquisitions, []);
    assert.deepEqual(result.postDisposePublications, []);
    assert.equal(result.lateAttentionClientObserved, false);
});

test('WEBVIEW-DASHBOARD-COMMAND-AVAILABILITY-001 production activation exposes stable commands while bootstrap is pending', () => {
    const result = runProductionActivation('pending');
    assert.equal(result.failure, null);
    assert.deepEqual(result.registeredCommands, [
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
    ]);
    assert.equal(result.dashboardCommandRegistrationInvocations, 1);
    assert.equal(result.pendingOpenRevealedBootShell, true);
    assert.match(result.pendingUnavailableCommandError, /Agent Pivot is still starting/);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 production startup diagnostics preserve exact order and bounded fields', () => {
    const result = runProductionActivation('diagnostics');
    assert.equal(result.failure, null);
    const normalizedDiagnostics = result.startupDiagnostics.map(diagnostic => {
        if (!Object.hasOwn(diagnostic, 'durationMs')) {
            return diagnostic;
        }
        assert.equal(Number.isFinite(diagnostic.durationMs), true);
        assert.ok(diagnostic.durationMs >= 0);
        return { ...diagnostic, durationMs: '<durationMs>' };
    });
    assert.deepEqual(normalizedDiagnostics, [
        {
            event: 'agent-pivot-activation-entered',
        },
        {
            event: 'agent-pivot-boot-shell-assigned',
            generation: 1,
        },
        {
            event: 'agent-pivot-browser-first-paint',
            generation: 1,
            durationMs: '<durationMs>',
        },
        {
            event: 'agent-pivot-bootstrap-ready',
            generation: 1,
            durationMs: '<durationMs>',
        },
    ]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 production failure diagnostic is exact and privacy-safe', () => {
    const result = runProductionActivation('direct-failure');
    assert.equal(result.failure, null);
    assert.deepEqual(result.startupDiagnostics.at(-1), {
        event: 'agent-pivot-bootstrap-failed',
        generation: 1,
        category: 'dashboard-bootstrap',
    });
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

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 SESSION-ALIAS-THREAD-SWITCH-001 ATTENTION-ACTIVE-UNREGISTER-ON-DEACTIVATE-001 production activation wires lifecycle ownership and restores before hydration', () => {
    const result = runProductionActivation('success');
    assert.equal(result.failure, null);
    assert.deepEqual(result.events.filter(isRestoreEvent), [
        'inactive-restored', 'direct-restored', 'tmux-restored', 'hydration-constructed',
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
});

test('RUNTIME-HOST-RUNTIME-COMPOSITION-001 production activation blocks tmux restore and hydration after Direct failure', () => {
    const result = runProductionActivation('direct-failure');
    assert.equal(result.failure, null);
    assert.equal(result.bootstrapState, 'failed');
    assert.deepEqual(result.events.filter(isRestoreEvent), [
        'inactive-restored',
        'direct-failed',
    ]);
    assert.equal(result.events.includes('tmux-restored'), false);
    assert.equal(result.events.includes('hydration-constructed'), false);
    assert.equal(result.rawDirectFailureExposedInHtml, false);
    assert.deepEqual(result.verified, [
        'client-store-discovery', 'thread-switch-alias-wiring',
    ]);
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
