'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { cloneManagedValue } = require('../../../out/projects/managedRemote/causal');
const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { parseManagedCatalogEnvelope } = require('../../../out/projects/managedRemote/envelope');
const { joinManagedRemoteCatalogs } = require('../../../out/projects/managedRemote/merge');
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

test('MANAGED-REMOTE-MANAGEMENT-002 activates the catalog on the first owner mutation', async () => {
    const { store } = await fixture();
    const empty = await store.getSnapshot();
    assert.equal(empty.lifecycle, 'disabled');
    assert.equal(empty.revisionId, null);

    const added = await store.addMachine(null, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22022,
    });
    assert.equal(added.lifecycle, 'active');
    assert.match(added.revisionId, /^revision:/);
    assert.equal(added.catalog.machines[0].name, 'Build');
    assert.equal(added.catalog.environments[0].kind, 'host');

    const edited = await store.editMachine(
        added.revisionId,
        added.catalog.machines[0].id,
        { name: 'Build WSL' },
    );
    assert.equal(edited.lifecycle, 'active');
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

test('MANAGED-REMOTE-MANAGEMENT-002 MANAGED-REMOTE-DEV-CONTAINER-001 adds a Dev Container Environment and Project atomically', async () => {
    const { store } = await fixture();
    const added = await store.addMachine(null, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22,
    });
    const machine = added.catalog.machines[0];
    const saved = await store.addDevContainerProject(added.revisionId, {
        machineId: machine.id,
        environmentName: 'API Container',
        anchor: {
            version: 1,
            originalAuthority: 'dev-container+aa@ssh-remote+build',
            sourceKind: 'config',
            sourceLocator: '/work/api/.devcontainer/devcontainer.json',
        },
        project: { name: 'API', remotePath: '/workspace/api' },
    });

    const container = saved.catalog.environments.find(environment =>
        environment.kind === 'devContainer');
    assert.ok(container);
    assert.equal(container.machineId, machine.id);
    assert.equal(saved.catalog.projects[0].environmentId, container.id);
    assert.equal(saved.catalog.projects[0].remotePath, '/workspace/api');
    assert.equal(saved.lifecycle, 'active');
});

test('MANAGED-REMOTE-MANAGEMENT-002 preserves active lifecycle across writers', async () => {
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
    assert.equal(rightSnapshot.lifecycle, 'active');
    assert.deepEqual(merged.catalog.machines.map(machine => machine.name), ['Left', 'Right']);
});

test('MANAGED-REMOTE-MANAGEMENT-002 rejects a second concurrent mutation from one writer', async () => {
    const { store } = await fixture();

    const results = await Promise.allSettled([
        store.addMachine(null, {
            name: 'Left', host: 'left.example.com', user: 'dev', port: 22,
        }),
        store.addMachine(null, {
            name: 'Right', host: 'right.example.com', user: 'dev', port: 22,
        }),
    ]);

    const final = await store.getSnapshot();
    assert.equal(final.lifecycle, 'active');
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
    assert.match(results[1].reason.message, /changed/u);
    assert.deepEqual(final.catalog.machines.map(machine => machine.name), ['Left']);
});

test('MANAGED-REMOTE-MANAGEMENT-002 joins concurrent mutations from distinct writers', async () => {
    const backend = new MemoryBackend();
    const coordinator = await ManagedCatalogCoordinator.create(
        backend,
        new MemoryReplicas(),
    );
    const left = new ManagedRemoteCatalogManagementStore(
        coordinator, 'catalog:left', prefix => `${prefix}:left`,
    );
    const right = new ManagedRemoteCatalogManagementStore(
        coordinator, 'catalog:right', prefix => `${prefix}:right`,
    );

    await Promise.all([
        left.addMachine(null, {
            name: 'Left', host: 'left.example.com', user: 'dev', port: 22,
        }),
        right.addMachine(null, {
            name: 'Right', host: 'right.example.com', user: 'dev', port: 22,
        }),
    ]);

    const final = await left.getSnapshot();
    assert.deepEqual(
        final.catalog.machines.map(machine => machine.name).sort(),
        ['Left', 'Right'],
    );
});

test('MANAGED-REMOTE-MANAGEMENT-002 exposes the surviving side of a delete-update conflict', async () => {
    const { backend, coordinator, store } = await fixture();
    const active = await store.addMachine(null, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22,
    });
    const machine = active.catalog.machines[0];
    const authority = parseManagedCatalogEnvelope(backend.value)
        .envelope.authority.candidates[0].value;
    const deleted = new ManagedRemoteCatalogService(
        authority.active.document, 'catalog:delete', prefix => `${prefix}:delete`,
    );
    const updated = new ManagedRemoteCatalogService(
        authority.active.document, 'catalog:update', prefix => `${prefix}:update`,
    );
    deleted.removeMachine(machine.id);
    updated.editMachine(machine.id, { host: 'other.example.com' });
    const stageId = await coordinator.stageCatalog(joinManagedRemoteCatalogs(
        deleted.getDocument(),
        updated.getDocument(),
    ));
    await coordinator.activateStagedCatalog(stageId);

    const conflicted = await store.getSnapshot();
    assert.equal(conflicted.catalog.conflicts.some(conflict =>
        conflict.entityId === machine.id && conflict.kind === 'delete-update'), true);
    assert.deepEqual(
        conflicted.machineConflictCandidates[machine.id]
            .map(candidate => candidate.connection.host),
        ['other.example.com'],
    );
});
