'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ManagedRemoteManagementController,
} = require('../../../out/projects/managedRemote/managementController');
const {
    prepareAutomaticManagedRemoteMigration,
} = require('../../../out/projects/managedRemote/composition');

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
        async rollbackMigration(expected) { calls.push(['rollbackMigration', expected]); return changed; },
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
        async reviewMigration(plan) { calls.push(['reviewMigration', plan]); return plan; },
        async confirmRollbackMigration() { return true; },
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

test('MANAGED-REMOTE-MIGRATION-003 automatically prepares existing remote Projects once', async () => {
    const disabled = snapshot();
    disabled.lifecycle = 'disabled';
    disabled.revisionId = null;
    const migrated = { ...disabled, lifecycle: 'preview', revisionId: nextRevisionId };
    const plan = {
        schemaVersion: 1,
        planId: `migration:${'c'.repeat(64)}`,
        sourceChecksum: 'c'.repeat(64),
        records: [{ classification: 'ready' }],
    };
    const calls = [];
    const result = await prepareAutomaticManagedRemoteMigration({
        async getSnapshot() { calls.push('snapshot'); return disabled; },
        prepareMigration() { calls.push('prepare'); return plan; },
        async beginMigration(expected, resolved) {
            calls.push(['begin', expected, resolved]);
            return migrated;
        },
    }, {
        async reviewMigration(value) { calls.push(['resolve', value]); return value; },
    });

    assert.equal(result, migrated);
    assert.deepEqual(calls, [
        'snapshot',
        'prepare',
        ['resolve', plan],
        ['begin', null, plan],
    ]);
});

test('MANAGED-REMOTE-MIGRATION-003 skips local-only and already-settled catalogs', async () => {
    const localOnly = snapshot();
    localOnly.lifecycle = 'disabled';
    localOnly.revisionId = null;
    const localCalls = [];
    const localResult = await prepareAutomaticManagedRemoteMigration({
        async getSnapshot() { localCalls.push('snapshot'); return localOnly; },
        prepareMigration() {
            localCalls.push('prepare');
            return { records: [{ classification: 'clientLocal' }] };
        },
    }, {
        async reviewMigration() { localCalls.push('resolve'); throw new Error('unexpected'); },
    });
    assert.equal(localResult, localOnly);
    assert.deepEqual(localCalls, ['snapshot', 'prepare']);

    const active = snapshot();
    active.lifecycle = 'active';
    const activeCalls = [];
    const activeResult = await prepareAutomaticManagedRemoteMigration({
        async getSnapshot() { activeCalls.push('snapshot'); return active; },
        prepareMigration() { activeCalls.push('prepare'); throw new Error('unexpected'); },
    }, {
        async reviewMigration() { throw new Error('unexpected'); },
    });
    assert.equal(activeResult, active);
    assert.deepEqual(activeCalls, ['snapshot']);
});

test('MANAGED-REMOTE-MIGRATION-003 adopts a concurrent window migration result', async () => {
    const disabled = { ...snapshot(), lifecycle: 'disabled', revisionId: null };
    const concurrent = { ...snapshot(), lifecycle: 'preview' };
    let reads = 0;
    const result = await prepareAutomaticManagedRemoteMigration({
        async getSnapshot() { reads += 1; return reads === 1 ? disabled : concurrent; },
        prepareMigration() { return { records: [{ classification: 'ready' }] }; },
        async beginMigration() { throw new Error('revision changed'); },
    }, {
        async reviewMigration(plan) { return plan; },
    });
    assert.equal(result, concurrent);
    assert.equal(reads, 2);
});

test('MANAGED-REMOTE-MIGRATION-ROLLBACK-001 confirms before rolling active authority back', async () => {
    const active = snapshot();
    active.lifecycle = 'active';
    active.migrationPlanId = `migration:${'c'.repeat(64)}`;
    const { controller, calls } = fixture({ snapshot: active });

    await controller.handle(request('rollbackMigration'));

    assert.deepEqual(calls.slice(0, 3), [
        ['rollbackMigration', revisionId],
        ['refresh', requestId, 'rollbackMigration', nextRevisionId],
        ['settle', 'applied'],
    ]);
});
