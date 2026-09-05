'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ManagedRemoteActionController,
} = require('../../../out/projects/managedRemote/actionController');

const revisionId = `revision:${'a'.repeat(64)}`;

function snapshot() {
    return {
        revisionId,
        lifecycle: 'active',
        catalog: {
            machines: [{
                id: 'machine:build', name: 'Build',
                connection: {
                    kind: 'ssh', host: '2001:db8::8', user: 'domain\\dev', port: 22022,
                },
            }],
            environments: [{
                id: 'host:machine:build', machineId: 'machine:build',
                kind: 'host', name: 'Host',
            }],
            projects: [{
                id: 'project:api', environmentId: 'host:machine:build',
                name: 'API', remotePath: '/work/api',
            }],
            conflicts: [],
            layout: {
                machineIds: ['machine:build'],
                environmentIdsByMachine: {},
                projectIdsByEnvironment: {},
                favoriteProjectIds: [],
            },
        },
        machineConflictCandidates: {},
    };
}

function controller(overrides = {}) {
    const effects = [];
    const instance = new ManagedRemoteActionController({
        getCurrentSnapshot: () => snapshot(),
        openCurrentProject: async () => false,
        bridge: {
            execute: async (...args) => { effects.push(['bridge', ...args]); return {}; },
        },
        writeClipboard: async value => { effects.push(['clipboard', value]); },
        showInformationMessage: async message => { effects.push(['info', message]); },
        showErrorMessage: async message => { effects.push(['error', message]); },
        logProjectionError: error => { effects.push(['projection-error', error.message]); },
        ...overrides,
    });
    return { instance, effects };
}

test('MANAGED-REMOTE-SSH-COMMAND-001 stalled background projection never blocks Copy SSH Command', async () => {
    const never = new Promise(() => undefined);
    const { instance, effects } = controller({
        bridge: {
            execute: async operation => operation === 'reconcile' ? never : {},
        },
        writeClipboard: async value => { effects.push(['clipboard', value]); },
    });

    instance.syncProjection(revisionId);
    await instance.copySshCommand('machine:build', revisionId);

    assert.deepEqual(effects, [
        ['clipboard', 'ssh -p 22022 -l "domain\\dev" "2001:db8::8"'],
        ['info', 'Copied SSH command for Build.'],
    ]);
});

test('MANAGED-REMOTE-NAVIGATION-001 stalled background projection never blocks the current Project', async () => {
    const never = new Promise(() => undefined);
    const { instance, effects } = controller({
        bridge: {
            execute: async operation => operation === 'reconcile' ? never : {},
        },
        openCurrentProject: async (_snapshot, projectId) => {
            effects.push(['current-project', projectId]);
            return true;
        },
    });

    instance.syncProjection(revisionId);
    await instance.openProject('project:api', revisionId);

    assert.deepEqual(effects, [['current-project', 'project:api']]);
});

test('MANAGED-REMOTE-ACTIONS-001 user actions do not share the projection queue', async () => {
    const never = new Promise(() => undefined);
    const { instance, effects } = controller({
        bridge: {
            execute: async (operation, revision, target) => {
                effects.push(['bridge', operation, revision, target]);
                return operation === 'reconcile' ? never : {};
            },
        },
    });

    instance.syncProjection(revisionId);
    await instance.openMachine('machine:build', revisionId);
    await instance.openSshTerminal('machine:build', revisionId);

    assert.deepEqual(effects, [
        ['bridge', 'reconcile', revisionId, undefined],
        ['bridge', 'openManagedMachine', revisionId, 'machine:build'],
        ['bridge', 'openLocalSshTerminal', revisionId, 'machine:build'],
    ]);
});

test('MANAGED-REMOTE-ACTIONS-001 rejects conflicted targets before any user effect', async () => {
    const conflicted = snapshot();
    conflicted.catalog.conflicts.push({
        kind: 'update-update', entityType: 'machine', entityId: 'machine:build',
    });
    const { instance, effects } = controller({ getCurrentSnapshot: () => conflicted });

    await instance.copySshCommand('machine:build', revisionId);
    await instance.openProject('project:api', revisionId);

    assert.equal(effects.some(effect => effect[0] === 'clipboard'), false);
    assert.equal(effects.some(effect => effect[0] === 'bridge'), false);
    assert.equal(effects.filter(effect => effect[0] === 'error').length, 2);
});

test('MANAGED-REMOTE-ACTIONS-001 validates and routes the complete webview message', async () => {
    const calls = [];
    const current = snapshot();
    const controller = new ManagedRemoteActionController({
        getCurrentSnapshot() { return current; },
        async openCurrentProject() { return false; },
        bridge: { async execute(...args) { calls.push(args); } },
        async writeClipboard() {},
        async showInformationMessage() {},
        async showErrorMessage(message) { calls.push(['error', message]); },
        logProjectionError() {},
    });
    await controller.handleMessage({
        type: 'managed-remote-client-action',
        version: 1,
        requestId: 'request-12345678',
        action: 'openProject',
        expectedRevisionId: revisionId,
        targetId: 'project:api',
    });
    await controller.handleMessage({
        type: 'managed-remote-client-action',
        version: 1,
        requestId: 'request-87654321',
        action: 'openMachine',
        expectedRevisionId: revisionId,
        targetId: 'machine:build',
        host: 'attacker.example.com',
    });
    assert.deepEqual(calls, [[
        'openManagedProject', revisionId, 'project:api',
    ]]);
});
