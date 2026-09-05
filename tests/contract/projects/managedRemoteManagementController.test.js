'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ManagedRemoteManagementController,
} = require('../../../out/projects/managedRemote/managementController');

const requestId = 'request-1234567890';
const revisionId = `revision:${'a'.repeat(64)}`;
const nextRevisionId = `revision:${'b'.repeat(64)}`;

function snapshot() {
    return {
        revisionId,
        lifecycle: 'preview',
        catalog: {
            machines: [{
                id: 'machine:one',
                name: 'Build',
                connection: { kind: 'ssh', host: 'build.example.com', user: 'dev', port: 22 },
            }],
            environments: [{
                id: 'environment:host:machine:one',
                machineId: 'machine:one',
                kind: 'host',
                name: 'Host',
            }],
            projects: [{
                id: 'project:one',
                environmentId: 'environment:host:machine:one',
                name: 'API',
                remotePath: '/work/api',
                favorite: false,
            }],
            layout: {
                machineIds: ['machine:one'],
                environmentIdsByMachine: {
                    'machine:one': ['environment:host:machine:one'],
                },
                projectIdsByEnvironment: {
                    'environment:host:machine:one': ['project:one'],
                },
                favoriteProjectIds: [],
            },
            conflicts: [],
        },
        machineConflictCandidates: {},
    };
}

function fixture(overrides = {}) {
    const calls = [];
    const settlements = [];
    const current = overrides.snapshot || snapshot();
    const changed = { ...current, revisionId: nextRevisionId };
    const migrationPlan = {
        schemaVersion: 1,
        planId: `migration:${'c'.repeat(64)}`,
        sourceChecksum: 'c'.repeat(64),
        records: [],
    };
    const store = {
        async getSnapshot() { return current; },
        async addMachine(expected, input) { calls.push(['addMachine', expected, input]); return changed; },
        async editMachine(expected, id, input) { calls.push(['editMachine', expected, id, input]); return changed; },
        async removeMachine(expected, id) { calls.push(['removeMachine', expected, id]); return changed; },
        async addProject(expected, input) { calls.push(['addProject', expected, input]); return changed; },
        async editProject(expected, id, input) { calls.push(['editProject', expected, id, input]); return changed; },
        async removeProject(expected, id) { calls.push(['removeProject', expected, id]); return changed; },
        async resolveMachineConflict(expected, id, selected) { calls.push(['resolve', expected, id, selected]); return changed; },
        prepareMigration() { calls.push(['prepareMigration']); return migrationPlan; },
        async beginMigration(expected, plan) { calls.push(['beginMigration', expected, plan]); return changed; },
        ...overrides.store,
    };
    const prompts = {
        async addMachine() { return { name: 'New', host: 'new.example.com', user: 'dev', port: 22022 }; },
        async editMachine() { return { name: 'Build 2' }; },
        async confirmRemoveMachine() { return true; },
        async chooseMachineForProject(machines) { return machines[0]; },
        async addProject() { return { environmentId: 'environment:host:machine:one', name: 'Web', remotePath: '/work/web' }; },
        async editProject() { return { name: 'API 2' }; },
        async confirmRemoveProject() { return true; },
        async resolveMachineConflict(_id, candidates) { return candidates[0]; },
        ...overrides.prompts,
    };
    const controller = new ManagedRemoteManagementController({
        store,
        prompts,
        async refreshAuthoritative(id, operation, result) {
            calls.push(['refresh', id, operation, result.revisionId]);
        },
        async postSettlement(value) {
            calls.push(['settle', value.status]);
            settlements.push(value);
        },
    });
    return { controller, calls, settlements };
}

function request(operation, targetId, expectedRevisionId = revisionId) {
    return {
        type: 'managed-remote-action',
        version: 1,
        requestId,
        operation,
        expectedRevisionId,
        ...(targetId ? { targetId } : {}),
    };
}

test('MANAGED-REMOTE-MANAGEMENT-001 refreshes authoritative HTML before success settlement', async () => {
    const { controller, calls, settlements } = fixture();
    await controller.handle(request('addMachine'));
    assert.deepEqual(calls, [
        ['addMachine', revisionId, {
            name: 'New', host: 'new.example.com', user: 'dev', port: 22022,
        }],
        ['refresh', requestId, 'addMachine', nextRevisionId],
        ['settle', 'applied'],
    ]);
    assert.equal(settlements[0].authoritativeRevisionId, nextRevisionId);
});

test('MANAGED-REMOTE-MANAGEMENT-001 resolves targets from the authoritative snapshot', async () => {
    const seen = [];
    const { controller, calls } = fixture({
        prompts: {
            async editMachine(machine, count) {
                seen.push([machine.name, count]);
                return { host: 'next.example.com' };
            },
        },
    });
    await controller.handle(request('editMachine', 'machine:one'));
    assert.deepEqual(seen, [['Build', 1]]);
    assert.deepEqual(calls[0], [
        'editMachine', revisionId, 'machine:one', { host: 'next.example.com' },
    ]);
});

test('MANAGED-REMOTE-MANAGEMENT-001 cancel and stale revision settle without mutation or refresh', async () => {
    const cancelled = fixture({ prompts: { async addMachine() { return undefined; } } });
    await cancelled.controller.handle(request('addMachine'));
    assert.deepEqual(cancelled.calls, [['settle', 'cancelled']]);

    const stale = fixture();
    await stale.controller.handle(request('removeProject', 'project:one', null));
    assert.deepEqual(stale.calls, [['settle', 'failed']]);
    assert.match(stale.settlements[0].message, /changed/);
});

test('MANAGED-REMOTE-MANAGEMENT-001 malformed correlated input settles exactly once', async () => {
    const { controller, calls, settlements } = fixture();
    await controller.handle({
        ...request('editProject', 'project:one'),
        remotePath: '/injected',
    });
    assert.deepEqual(calls, [['settle', 'failed']]);
    assert.match(settlements[0].message, /invalid/);
});

test('MANAGED-REMOTE-MANAGEMENT-001 toggle Favorite derives the new value from authority', async () => {
    const { controller, calls } = fixture();
    await controller.handle(request('toggleFavorite', 'project:one'));
    assert.deepEqual(calls[0], [
        'editProject', revisionId, 'project:one', { favorite: true },
    ]);
});

test('MANAGED-REMOTE-MANAGEMENT-001 resolves a conflict from raw causal candidates', async () => {
    const current = snapshot();
    const second = {
        ...current.catalog.machines[0],
        connection: {
            ...current.catalog.machines[0].connection,
            host: 'other.example.com',
        },
    };
    current.catalog.conflicts = [{
        kind: 'update-update',
        entityType: 'machine',
        entityId: 'machine:one',
    }];
    current.machineConflictCandidates = {
        'machine:one': [current.catalog.machines[0], second],
    };
    const selected = [];
    const { controller, calls } = fixture({
        snapshot: current,
        prompts: {
            async resolveMachineConflict(_id, candidates) {
                selected.push(candidates.map(value => value.connection.host));
                return candidates[1];
            },
        },
    });
    await controller.handle(request('resolveMachineConflict', 'machine:one'));
    assert.deepEqual(selected, [['build.example.com', 'other.example.com']]);
    assert.equal(calls[0][0], 'resolve');
    assert.equal(calls[0][3].connection.host, 'other.example.com');
});

test('MANAGED-REMOTE-MANAGEMENT-001 saves the open window without prompting', async () => {
    const { controller, calls } = fixture({
        prompts: {
            async addProject() {
                throw new Error('saving the open window must not prompt');
            },
            async chooseMachineForProject() {
                throw new Error('saving the open window must not prompt');
            },
        },
    });

    // The Environment and the path are already determined by the open window, so
    // prompting could only introduce a mismatch that stops the Project from
    // being recognised as saved.
    const result = await controller.addProjectDirectly({
        environmentId: 'environment:host:machine:one',
        name: 'task-541ab4',
        remotePath: '/work/task-541ab4',
    });

    assert.equal(result.revisionId, nextRevisionId);
    assert.deepEqual(calls, [
        ['addProject', revisionId, {
            environmentId: 'environment:host:machine:one',
            name: 'task-541ab4',
            remotePath: '/work/task-541ab4',
        }],
        ['refresh', 'save-workspace', 'addProject', nextRevisionId],
    ]);
});

test('MANAGED-REMOTE-MANAGEMENT-001 surfaces a rejected direct save to the caller', async () => {
    const { controller } = fixture({
        store: {
            async addProject() { throw new Error('catalog revision is out of date'); },
        },
    });

    // The Save button must not silently report success when the write failed.
    await assert.rejects(
        controller.addProjectDirectly({
            environmentId: 'environment:host:machine:one',
            name: 'API',
            remotePath: '/work/api',
        }),
        /out of date/u,
    );
});
