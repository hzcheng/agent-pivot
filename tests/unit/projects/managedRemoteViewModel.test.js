'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildManagedRemoteProjectsViewModel,
} = require('../../../out/projects/managedRemote/viewModel');

function snapshot() {
    return {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'preview',
        machineConflictCandidates: {},
        catalog: {
            machines: [{
                id: 'machine:build',
                name: 'Build',
                connection: { kind: 'ssh', host: '2001:db8::1', user: 'dev', port: 22022 },
            }],
            environments: [{ id: 'environment:host', machineId: 'machine:build', kind: 'host', name: 'Host' }],
            projects: [{
                id: 'project:api', environmentId: 'environment:host', name: 'API',
                remotePath: '/work/api', tags: ['Backend'], favorite: true, color: '#ef4444',
            }],
            layout: {
                machineIds: ['machine:build'],
                environmentIdsByMachine: { 'machine:build': ['environment:host'] },
                projectIdsByEnvironment: { 'environment:host': ['project:api'] },
                favoriteProjectIds: ['project:api'],
            },
            conflicts: [],
        },
    };
}

test('MANAGED-REMOTE-MANAGEMENT-003 builds endpoint-qualified preview rows without enabling Open', () => {
    const model = buildManagedRemoteProjectsViewModel(snapshot());
    assert.equal(model.machines[0].endpoint, 'dev@[2001:db8::1]:22022');
    assert.equal(model.machines[0].openable, false);
    assert.equal(model.machines[0].environments[0].projects[0].openable, false);
    assert.equal(model.favorites[0].id, 'project:api');
    assert.deepEqual(model.tags, ['Backend']);
});

test('MANAGED-REMOTE-MANAGEMENT-003 exposes conflict recovery instead of an open target', () => {
    const current = snapshot();
    current.catalog.conflicts.push({
        kind: 'update-update', entityType: 'machine', entityId: 'machine:build',
    });
    const model = buildManagedRemoteProjectsViewModel(current, 'ready');
    assert.equal(model.machines[0].conflict, true);
    assert.equal(model.machines[0].openable, false);
    assert.match(model.machines[0].unavailableReason, /Conflict/i);
    assert.equal(model.machines[0].environments[0].projects[0].openable, false);
});

test('MANAGED-REMOTE-NAVIGATION-001 keeps active catalog actions independent from local SSH projection state', () => {
    const current = snapshot();
    current.lifecycle = 'active';

    for (const clientState of [
        'enableRequired', 'applying', 'attention', 'remoteSshMissing',
    ]) {
        const model = buildManagedRemoteProjectsViewModel(current, clientState);
        assert.equal(model.machines[0].openable, true);
        assert.equal(model.machines[0].environments[0].projects[0].openable, true);
    }
});
