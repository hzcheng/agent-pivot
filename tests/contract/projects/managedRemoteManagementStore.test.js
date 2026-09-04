'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { cloneManagedValue } = require('../../../out/projects/managedRemote/causal');
const {
    ManagedRemoteCatalogManagementStore,
} = require('../../../out/projects/managedRemote/managementStore');
const { ManagedCatalogCoordinator } = require('../../../out/projects/managedRemote/store');

class MemoryBackend {
    constructor() { this.value = null; }
    read() { return cloneManagedValue(this.value); }
    async write(value) { this.value = cloneManagedValue(value); }
}

class MemoryReplicas {
    constructor() { this.values = new Map(); }
    async allocateWriter() { return { writerId: 'writer:one', actorId: 'envelope:one' }; }
    readWriter(id) { return cloneManagedValue(this.values.get(id) || null); }
    async writeWriter(id, value) { this.values.set(id, cloneManagedValue(value)); }
}

async function fixture() {
    const backend = new MemoryBackend();
    const coordinator = await ManagedCatalogCoordinator.create(
        backend,
        new MemoryReplicas(),
    );
    let nextId = 0;
    const store = new ManagedRemoteCatalogManagementStore(
        coordinator,
        'catalog:one',
        prefix => `${prefix}:${++nextId}`,
    );
    return { backend, coordinator, store };
}

test('MANAGED-REMOTE-MANAGEMENT-002 creates and edits a preview catalog without activating managed mode', async () => {
    const { store } = await fixture();
    const empty = await store.getSnapshot();
    assert.equal(empty.lifecycle, 'disabled');
    assert.equal(empty.revisionId, null);

    const added = await store.addMachine(null, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22022,
    });
    assert.equal(added.lifecycle, 'preview');
    assert.match(added.revisionId, /^revision:/);
    assert.equal(added.catalog.machines[0].name, 'Build');
    assert.equal(added.catalog.environments[0].kind, 'host');

    const edited = await store.editMachine(
        added.revisionId,
        added.catalog.machines[0].id,
        { name: 'Build WSL' },
    );
    assert.equal(edited.lifecycle, 'preview');
    assert.equal(edited.catalog.machines[0].name, 'Build WSL');
});

test('MANAGED-REMOTE-MANAGEMENT-002 enforces revision identity and Project placement', async () => {
    const { store } = await fixture();
    const added = await store.addMachine(null, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22,
    });
    await assert.rejects(
        store.editMachine(null, added.catalog.machines[0].id, { name: 'Stale' }),
        /changed/,
    );
    const host = added.catalog.environments[0];
    const withProject = await store.addProject(added.revisionId, {
        environmentId: host.id,
        name: 'API',
        remotePath: '/work/api',
    });
    assert.equal(withProject.catalog.projects[0].environmentId, host.id);
    assert.equal(withProject.catalog.projects[0].remotePath, '/work/api');
});

test('MANAGED-REMOTE-MANAGEMENT-002 preserves preview lifecycle across writers', async () => {
    const backend = new MemoryBackend();
    const leftCoordinator = await ManagedCatalogCoordinator.create(backend, new MemoryReplicas());
    const rightCoordinator = await ManagedCatalogCoordinator.create(backend, new MemoryReplicas());
    const left = new ManagedRemoteCatalogManagementStore(
        leftCoordinator, 'catalog:left', prefix => `${prefix}:left`,
    );
    const right = new ManagedRemoteCatalogManagementStore(
        rightCoordinator, 'catalog:right', prefix => `${prefix}:right`,
    );
    const leftSnapshot = await left.addMachine(null, {
        name: 'Left', host: 'left.example.com', user: 'dev', port: 22,
    });
    await right.getSnapshot();
    const rightSnapshot = await right.addMachine(leftSnapshot.revisionId, {
        name: 'Right', host: 'right.example.com', user: 'dev', port: 22,
    });
    const merged = await left.getSnapshot();
    assert.equal(rightSnapshot.lifecycle, 'preview');
    assert.deepEqual(merged.catalog.machines.map(machine => machine.name), ['Left', 'Right']);
});

test('MANAGED-REMOTE-MIGRATION-003 freezes V1 authority and installs only reviewed remote Projects', async () => {
    const backend = new MemoryBackend();
    const coordinator = await ManagedCatalogCoordinator.create(backend, new MemoryReplicas());
    const groups = [{
        id: 'group', groupName: 'Backend', projects: [{
            id: 'remote', name: 'API',
            path: 'vscode-remote://ssh-remote%2Bdev%40build.example.com%3A2207/work/api',
            favorite: true,
        }, {
            id: 'local', name: 'Local', path: '/work/local',
        }],
    }];
    const projectData = [{ id: 'legacy', value: true }];
    const projectSyncData = { schemaVersion: 1, marker: 'frozen' };
    const store = new ManagedRemoteCatalogManagementStore(
        coordinator,
        'catalog:migration',
        undefined,
        {
            getGroups: () => JSON.parse(JSON.stringify(groups)),
            getProjectData: () => JSON.parse(JSON.stringify(projectData)),
            getProjectSyncData: () => JSON.parse(JSON.stringify(projectSyncData)),
        },
    );

    const plan = store.prepareMigration();
    const snapshot = await store.beginMigration(null, plan);
    assert.equal(snapshot.lifecycle, 'preview');
    assert.equal(snapshot.migrationPlanId, plan.planId);
    assert.deepEqual(snapshot.catalog.projects.map(value => value.id), ['remote']);
    const envelope = backend.value;
    const journal = envelope.migrationPlans[plan.planId].candidates[0].value;
    assert.equal(journal.phase, 'prepared');
    assert.deepEqual(journal.frozenLegacy.projectData, projectData);
    assert.deepEqual(journal.frozenLegacy.projectSyncData, projectSyncData);
    assert.equal(journal.candidate.revisionId, snapshot.revisionId);

    const active = await store.activateMigration(snapshot.revisionId);
    assert.equal(active.lifecycle, 'active');
    assert.equal(active.migrationPlanId, plan.planId);
    const completed = backend.value.migrationPlans[plan.planId].candidates[0].value;
    assert.equal(completed.phase, 'complete');
});
