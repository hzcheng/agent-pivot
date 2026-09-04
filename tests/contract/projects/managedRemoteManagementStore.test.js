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
    const coordinator = await ManagedCatalogCoordinator.create(
        new MemoryBackend(),
        new MemoryReplicas(),
    );
    let nextId = 0;
    const store = new ManagedRemoteCatalogManagementStore(
        coordinator,
        'catalog:one',
        prefix => `${prefix}:${++nextId}`,
    );
    return { coordinator, store };
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
