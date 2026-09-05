'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ManagedRemoteClientActionController,
} = require('../../../out/projects/managedRemote/clientActionController');
const {
    ManagedRemoteBridgeClientError,
} = require('../../../out/projects/managedRemote/bridgeClient');

const revisionId = `revision:${'a'.repeat(64)}`;

function snapshot(lifecycle = 'preview') {
    return {
        revisionId,
        lifecycle,
        migrationPlanId: 'migration:plan',
        catalog: {
            machines: [], environments: [], projects: [], conflicts: [],
            layout: {
                machineIds: [], environmentIdsByMachine: {},
                projectIdsByEnvironment: {}, favoriteProjectIds: [],
            },
        },
        machineConflictCandidates: {},
    };
}

test('MANAGED-REMOTE-CLIENT-ENABLE-001 previews local files before enabling an active catalog', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        bridge: {
            async execute(operation, expected) {
                calls.push(['bridge', operation, expected]);
                return operation === 'preflightEnable' ? {
                    activeConfigPath: '/home/dev/.ssh/config',
                    generatedConfigPath: '/home/dev/.agent-pivot/ssh/config',
                    backupPath: '/home/dev/.ssh/config.agent-pivot-backup',
                    editMode: 'automatic',
                } : { status: 'enabled' };
            },
        },
        async confirmEnable(summary) {
            calls.push(['confirm', summary.activeConfigPath]);
            return true;
        },
        async confirmDisable() { return false; },
        async refresh(value, state) { calls.push(['refresh', value.lifecycle, state]); },
        async showInformationMessage(message) { calls.push(['info', message]); },
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.enable(revisionId);
    assert.deepEqual(calls.slice(0, 5), [
        ['bridge', 'preflightEnable', revisionId],
        ['confirm', '/home/dev/.ssh/config'],
        ['refresh', 'active', 'applying'],
        ['bridge', 'beginEnable', revisionId],
        ['refresh', 'active', 'ready'],
    ]);
    assert.equal(calls.some(call => call[0] === 'error'), false);
});

test('managed client actions never activate a preview catalog', async () => {
    const calls = [];
    const preview = snapshot();
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return preview; },
        bridge: {
            async execute(operation, expected) {
                calls.push(['bridge', operation, expected]);
                return { status: 'enabled' };
            },
        },
        async confirmEnable() { calls.push(['confirm']); return false; },
        async confirmDisable() { return false; },
        async refresh(value, state) { calls.push(['refresh', value.lifecycle, state]); },
        async showInformationMessage(message) { calls.push(['info', message]); },
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.enableAutomatically(revisionId);

    assert.deepEqual(calls, [
        ['refresh', 'preview', 'attention'],
        ['error', 'Agent Pivot: The Managed Machine catalog is unavailable.'],
    ]);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 automatically materializes a synced catalog on a new computer', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async activateMigration() { throw new Error('must not activate'); },
        bridge: {
            async execute(operation, expected) {
                calls.push(['bridge', operation, expected]);
                if (operation === 'getStatus') {
                    return { status: 'disabled', generation: 0 };
                }
                return { status: 'enabled' };
            },
        },
        async confirmEnable() { calls.push(['confirm']); return false; },
        async confirmDisable() { return false; },
        async refresh(value, state) { calls.push(['refresh', value.lifecycle, state]); },
        async showInformationMessage(message) { calls.push(['info', message]); },
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.enableAutomatically(revisionId);

    assert.deepEqual(calls, [
        ['bridge', 'getStatus', undefined],
        ['refresh', 'active', 'applying'],
        ['bridge', 'beginEnable', revisionId],
        ['refresh', 'active', 'ready'],
    ]);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 automatically reconciles an already enabled computer', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async activateMigration() { throw new Error('must not activate'); },
        bridge: {
            async execute(operation, expected) {
                calls.push(['bridge', operation, expected]);
                return { status: 'enabled', generation: 2 };
            },
        },
        async confirmEnable() { throw new Error('must not confirm'); },
        async confirmDisable() { return false; },
        async refresh(value, state) { calls.push(['refresh', value.lifecycle, state]); },
        async showInformationMessage() {},
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.enableAutomatically(revisionId);

    assert.deepEqual(calls, [
        ['bridge', 'getStatus', undefined],
        ['refresh', 'active', 'applying'],
        ['bridge', 'reconcile', revisionId],
        ['refresh', 'active', 'ready'],
    ]);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 automatically re-enables a previously disabled local projection', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async activateMigration() { throw new Error('must not activate'); },
        bridge: {
            async execute(operation, expected) {
                calls.push(['bridge', operation, expected]);
                return operation === 'getStatus'
                    ? { status: 'disabled', generation: 3 }
                    : { status: 'enabled', generation: 4 };
            },
        },
        async confirmEnable() { throw new Error('must not confirm'); },
        async confirmDisable() { return false; },
        async refresh(value, state) { calls.push(['refresh', value.lifecycle, state]); },
        async showInformationMessage() {},
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.enableAutomatically(revisionId);

    assert.deepEqual(calls, [
        ['bridge', 'getStatus', undefined],
        ['refresh', 'active', 'applying'],
        ['bridge', 'beginEnable', revisionId],
        ['refresh', 'active', 'ready'],
    ]);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 automatically repairs an owned stale projection', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        bridge: {
            async execute(operation, expected) {
                calls.push(['bridge', operation, expected]);
                return operation === 'getStatus'
                    ? { status: 'recoveryRequired', generation: 4 }
                    : { status: 'enabled', generation: 5 };
            },
        },
        async confirmEnable() { throw new Error('must not confirm'); },
        async confirmDisable() { return false; },
        async refresh(value, state) { calls.push(['refresh', value.lifecycle, state]); },
        async showInformationMessage() { throw new Error('must not announce startup repair'); },
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.enableAutomatically(revisionId);

    assert.deepEqual(calls, [
        ['bridge', 'getStatus', undefined],
        ['refresh', 'active', 'applying'],
        ['bridge', 'recover', revisionId],
        ['refresh', 'active', 'ready'],
    ]);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 maps local consent status without mutating the catalog', async () => {
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async activateMigration() { throw new Error('must not activate'); },
        bridge: { async execute() { return { status: 'enabled' }; } },
        async confirmEnable() { return false; },
        async confirmDisable() { return false; },
        async refresh() {},
        async showInformationMessage() {},
        async showErrorMessage() {},
    });
    assert.equal(await controller.readState(active), 'ready');
    assert.equal(await controller.readState(snapshot()), 'preview');
});

test('MANAGED-REMOTE-NAVIGATION-001 forwards only active revision and stable target identity', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async activateMigration() { throw new Error('must not activate'); },
        bridge: { async execute(...args) { calls.push(args); return {}; } },
        async confirmEnable() { return false; },
        async confirmDisable() { return false; },
        async refresh() {},
        async showInformationMessage() {},
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.openMachine('machine:one', revisionId);
    await controller.openProject('project:one', revisionId);
    await controller.openEnvironment('environment:one', revisionId);
    assert.deepEqual(calls, [
        ['openManagedMachine', revisionId, 'machine:one'],
        ['openManagedProject', revisionId, 'project:one'],
        ['openManagedEnvironment', revisionId, 'environment:one'],
    ]);
});

test('MANAGED-REMOTE-NAVIGATION-001 opens a Project directly inside the current Environment without the UI Bridge', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async openProjectFromCurrentMachine(value, projectId) {
            calls.push(['direct', value.revisionId, projectId]);
            return true;
        },
        bridge: {
            async execute(...args) {
                calls.push(['bridge', ...args]);
                throw new Error('the bridge must not be used for the current Environment');
            },
        },
        async confirmEnable() { return false; },
        async refresh() {},
        async showInformationMessage() {},
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.openProject('project:one', revisionId);

    assert.deepEqual(calls, [
        ['direct', revisionId, 'project:one'],
    ]);
});

test('MANAGED-REMOTE-NAVIGATION-001 does not queue a current-machine Project open behind local SSH projection startup', async () => {
    const calls = [];
    const active = snapshot('active');
    let releaseStatus;
    const pendingStatus = new Promise(resolve => { releaseStatus = resolve; });
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async openProjectFromCurrentMachine(value, projectId) {
            calls.push(['direct', value.revisionId, projectId]);
            return true;
        },
        bridge: {
            async execute(operation) {
                calls.push(['bridge', operation]);
                if (operation === 'getStatus') { return pendingStatus; }
                return { status: 'enabled' };
            },
        },
        async confirmEnable() { return false; },
        async refresh() {},
        async showInformationMessage() {},
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    const startup = controller.enableAutomatically(revisionId);
    await new Promise(resolve => setImmediate(resolve));
    const opening = controller.openProject('project:one', revisionId);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls, [
        ['bridge', 'getStatus'],
        ['direct', revisionId, 'project:one'],
    ]);

    releaseStatus({ status: 'enabled' });
    await Promise.all([startup, opening]);
});

test('MANAGED-REMOTE-NAVIGATION-001 uses the UI Bridge only when the Project is outside the current Environment', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async openProjectFromCurrentMachine(value, projectId) {
            calls.push(['direct', value.revisionId, projectId]);
            return false;
        },
        bridge: { async execute(...args) { calls.push(['bridge', ...args]); return {}; } },
        async confirmEnable() { return false; },
        async refresh() {},
        async showInformationMessage() {},
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.openProject('project:other', revisionId);

    assert.deepEqual(calls, [
        ['direct', revisionId, 'project:other'],
        ['bridge', 'openManagedProject', revisionId, 'project:other'],
    ]);
});

test('MANAGED-REMOTE-NAVIGATION-001 repairs the local projection and retries Project navigation', async () => {
    const calls = [];
    const active = snapshot('active');
    let openAttempts = 0;
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        bridge: {
            async execute(...args) {
                calls.push(['bridge', ...args]);
                if (args[0] === 'openManagedProject' && openAttempts++ === 0) {
                    throw new ManagedRemoteBridgeClientError(
                        'recoveryRequired',
                        'The local SSH projection needs recovery.',
                    );
                }
                return args[0] === 'recover' ? { status: 'enabled' } : {};
            },
        },
        async confirmEnable() { return false; },
        async refresh(value, state) { calls.push(['refresh', value.lifecycle, state]); },
        async showInformationMessage() {},
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.openProject('project:one', revisionId);

    assert.deepEqual(calls, [
        ['bridge', 'openManagedProject', revisionId, 'project:one'],
        ['refresh', 'active', 'applying'],
        ['bridge', 'recover', revisionId],
        ['refresh', 'active', 'ready'],
        ['bridge', 'openManagedProject', revisionId, 'project:one'],
    ]);
});
