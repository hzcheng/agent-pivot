'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ManagedRemoteClientActionController,
} = require('../../../out/projects/managedRemote/clientActionController');

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

test('MANAGED-REMOTE-CLIENT-ENABLE-001 previews local files before enabling and activating migration', async () => {
    const calls = [];
    const preview = snapshot();
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return preview; },
        async activateMigration(expected) {
            calls.push(['activate', expected]);
            return active;
        },
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
    assert.deepEqual(calls.slice(0, 6), [
        ['bridge', 'preflightEnable', revisionId],
        ['confirm', '/home/dev/.ssh/config'],
        ['refresh', 'preview', 'applying'],
        ['bridge', 'beginEnable', revisionId],
        ['activate', revisionId],
        ['refresh', 'active', 'ready'],
    ]);
    assert.equal(calls.some(call => call[0] === 'error'), false);
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

test('MANAGED-REMOTE-CLIENT-DISABLE-001 previews owned files and disables only this computer', async () => {
    const calls = [];
    const active = snapshot('active');
    const controller = new ManagedRemoteClientActionController({
        async getSnapshot() { return active; },
        async activateMigration() { throw new Error('must not activate'); },
        bridge: {
            async execute(operation, expected) {
                calls.push(['bridge', operation, expected]);
                return operation === 'preflightDisable' ? {
                    activeConfigPath: '/home/dev/.ssh/config',
                    generatedDirectory: '/home/dev/.agent-pivot/ssh',
                    backupPath: '/home/dev/.ssh/config.agent-pivot-backup',
                    editMode: 'automatic',
                } : { status: 'disabled' };
            },
        },
        async confirmEnable() { return false; },
        async confirmDisable(summary) {
            calls.push(['confirm', summary.activeConfigPath, summary.generatedDirectory]);
            return true;
        },
        async refresh(value, state) { calls.push(['refresh', value.lifecycle, state]); },
        async showInformationMessage(message) { calls.push(['info', message]); },
        async showErrorMessage(message) { calls.push(['error', message]); },
    });

    await controller.disable(revisionId);

    assert.deepEqual(calls.slice(0, 5), [
        ['bridge', 'preflightDisable', undefined],
        ['confirm', '/home/dev/.ssh/config', '/home/dev/.agent-pivot/ssh'],
        ['refresh', 'active', 'applying'],
        ['bridge', 'beginDisable', undefined],
        ['refresh', 'active', 'enableRequired'],
    ]);
    assert.match(calls.find(call => call[0] === 'info')[1], /Synced Machines and Projects were not changed/u);
    assert.equal(calls.some(call => call[0] === 'error'), false);
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
