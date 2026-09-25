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

test('MANAGED-REMOTE-MANAGEMENT-002 recovers into a usable catalog from an unreadable stored value', async () => {
    // A stored value the current schema cannot read must not take the whole
    // catalog down. Failing closed here left the Project tab permanently empty
    // with no way back, which is strictly worse than starting empty.
    const backend = new MemoryBackend();
    backend.value = { envelopeVersion: 99, totally: 'unreadable' };
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

    const snapshot = await store.getSnapshot();
    assert.equal(snapshot.catalog.machines.length, 0);

    // And it must stay usable: adding a Machine has to succeed and activate.
    const added = await store.addMachine(snapshot.revisionId, {
        name: 'RedDev', host: 'reddev.example.com', user: 'dev', port: 22,
    });
    assert.equal(added.lifecycle, 'active');
    assert.equal(added.catalog.machines[0].name, 'RedDev');
});

test('MANAGED-REMOTE-MANAGEMENT-002 exposes Project deletion candidates and refuses stale or injected recovery', async () => {
    const { coordinator, store } = await fixture();
    const seed = ManagedRemoteCatalogService.create('seed');
    const machine = seed.addMachine({ name: 'Build', host: 'build', user: 'dev' });
    const env = seed.getCatalog().environments[0];
    const project = seed.addProject({ environmentId: env.id, name: 'API', remotePath: '/api' });
    const base = seed.getDocument();
    const edited = new ManagedRemoteCatalogService(base, 'edited');
    const deleted = new ManagedRemoteCatalogService(base, 'deleted');
    edited.editProject(project.id, { name: 'API updated' });
    deleted.removeProject(project.id);
    const joined = joinManagedRemoteCatalogs(edited.getDocument(), deleted.getDocument());
    const stage = await coordinator.stageCatalog(joined);
    await coordinator.activateStagedCatalog(stage);
    const before = await store.getSnapshot();
    assert.equal(before.projectConflictCandidates[project.id].length, 2);
    assert.ok(before.projectConflictCandidates[project.id].includes(null));
    assert.deepEqual(before.machineRemovalCounts[machine.id], { projectCount: 1, environmentCount: 1 });
    await assert.rejects(store.resolveProjectConflict(before.revisionId, project.id, { ...project, name: 'Injected' }), /existing Project conflict version/);
    const after = await store.resolveProjectConflict(before.revisionId, project.id, null);
    assert.deepEqual(after.catalog.projects, []);
    assert.equal(after.projectConflictCandidates[project.id], undefined);
    await assert.rejects(store.resolveProjectConflict(before.revisionId, project.id, project), /catalog changed/);
});

test('MANAGED-REMOTE-MANAGEMENT-002 Machine cascade joined with Project editing retains an orphan deletion recovery', async () => {
    const { coordinator, store } = await fixture();
    const seed = ManagedRemoteCatalogService.create('seed');
    const machine = seed.addMachine({ name: 'Build', host: 'build', user: 'dev' });
    const environment = seed.getCatalog().environments[0];
    const project = seed.addProject({ environmentId: environment.id, name: 'API', remotePath: '/api', favorite: true });
    const deleted = new ManagedRemoteCatalogService(seed.getDocument(), 'deleted');
    const edited = new ManagedRemoteCatalogService(seed.getDocument(), 'edited');
    deleted.removeMachine(machine.id);
    edited.editProject(project.id, { name: 'Changed while offline' });
    const joined = joinManagedRemoteCatalogs(deleted.getDocument(), edited.getDocument());
    await coordinator.activateStagedCatalog(await coordinator.stageCatalog(joined));
    const before = await store.getSnapshot();
    assert.deepEqual(before.catalog.machines, []);
    assert.deepEqual(before.catalog.environments, []);
    assert.deepEqual(before.catalog.projects, []);
    assert.ok(before.catalog.conflicts.some(value => value.entityId === project.id && value.kind === 'missing-parent'));
    assert.ok(before.projectConflictCandidates[project.id].includes(null));
    assert.equal(before.projectConflictCandidates[project.id].filter(Boolean)[0].name, 'Changed while offline');
    const recovered = await store.resolveProjectConflict(before.revisionId, project.id, null);
    assert.deepEqual(recovered.catalog.conflicts, []);
    assert.deepEqual(recovered.catalog.layout.favoriteProjectIds, []);
});

test('MANAGED-REMOTE-MANAGEMENT-002 orphan Host deletion is valid only after its Machine was deleted', async () => {
    const { applyManagedCatalogTransaction } = require('../../../out/projects/managedRemote/merge');
    const { coordinator, store } = await fixture();
    const seed = ManagedRemoteCatalogService.create('seed');
    const machine = seed.addMachine({ name: 'Build', host: 'build', user: 'dev' });
    const environment = seed.getCatalog().environments[0];
    seed.addProject({ environmentId: environment.id, name: 'API', remotePath: '/api' });
    const base = seed.getDocument();
    const deleted = new ManagedRemoteCatalogService(base, 'deleted');
    deleted.removeMachine(machine.id);
    const edited = applyManagedCatalogTransaction(base, 'edited', { environments: { [environment.id]: { ...environment, name: 'Renamed Host' } } });
    const joined = joinManagedRemoteCatalogs(deleted.getDocument(), edited);
    await coordinator.activateStagedCatalog(await coordinator.stageCatalog(joined));
    const before = await store.getSnapshot();
    assert.deepEqual(before.catalog.environments, []);
    assert.ok(before.environmentConflictCandidates[environment.id].includes(null));
    const recovered = await store.resolveEnvironmentConflict(before.revisionId, environment.id, null);
    assert.deepEqual(recovered.catalog.conflicts, []);
    const hostDeletedOnly = applyManagedCatalogTransaction(base, 'host-delete', { environments: { [environment.id]: null } });
    const liveParentConflict = new ManagedRemoteCatalogService(joinManagedRemoteCatalogs(hostDeletedOnly, edited), 'resolve');
    assert.throws(() => liveParentConflict.resolveEnvironmentConflict(environment.id, null), /Keep the Host Environment/);
});

test('MANAGED-REMOTE-MANAGEMENT-002 a concurrently added orphan Project can be removed without inventing a deletion candidate', async () => {
    const { coordinator, store } = await fixture();
    const seed = ManagedRemoteCatalogService.create('seed');
    const machine = seed.addMachine({ name: 'Build', host: 'build', user: 'dev' });
    const environment = seed.getCatalog().environments[0];
    const deleted = new ManagedRemoteCatalogService(seed.getDocument(), 'deleted');
    const added = new ManagedRemoteCatalogService(seed.getDocument(), 'added');
    deleted.removeMachine(machine.id);
    const project = added.addProject({ environmentId: environment.id, name: 'New offline Project', remotePath: '/new' });
    const joined = joinManagedRemoteCatalogs(deleted.getDocument(), added.getDocument());
    await coordinator.activateStagedCatalog(await coordinator.stageCatalog(joined));
    const before = await store.getSnapshot();
    assert.deepEqual(before.catalog.projects, []);
    assert.deepEqual(before.projectConflictCandidates[project.id], [project]);
    assert.ok(before.catalog.conflicts.some(value => value.kind === 'missing-parent' && value.entityId === project.id));
    const recovered = await store.resolveProjectConflict(before.revisionId, project.id, null);
    assert.deepEqual(recovered.catalog.conflicts, []);
    assert.deepEqual(recovered.projectConflictCandidates, {});
    assert.throws(() => added.resolveProjectConflict(project.id, null), /no longer has concurrent changes/);
});

test('MANAGED-REMOTE-MANAGEMENT-002 a concurrently added orphan Container removes its saved Project records', async () => {
    const { coordinator, store } = await fixture();
    const seed = ManagedRemoteCatalogService.create('seed');
    const machine = seed.addMachine({ name: 'Build', host: 'build', user: 'dev' });
    const deleted = new ManagedRemoteCatalogService(seed.getDocument(), 'deleted');
    const added = new ManagedRemoteCatalogService(seed.getDocument(), 'added');
    deleted.removeMachine(machine.id);
    const environment = added.addDevContainer(machine.id, 'Offline Container', { version: 1, originalAuthority: 'dev-container+aa@ssh-remote+build', sourceKind: 'workspace', sourceLocator: '/work' });
    added.addProject({ environmentId: environment.id, name: 'Offline API', remotePath: '/api' });
    const joined = joinManagedRemoteCatalogs(deleted.getDocument(), added.getDocument());
    await coordinator.activateStagedCatalog(await coordinator.stageCatalog(joined));
    const before = await store.getSnapshot();
    assert.deepEqual(before.catalog.environments, []);
    assert.deepEqual(before.catalog.projects, []);
    assert.deepEqual(before.environmentConflictCandidates[environment.id], [environment]);
    assert.equal(before.environmentRemovalProjectCounts[environment.id], 1);
    const recovered = await store.resolveEnvironmentConflict(before.revisionId, environment.id, null);
    assert.deepEqual(recovered.catalog.conflicts, []);
    assert.deepEqual(recovered.environmentRemovalProjectCounts, {});
    assert.throws(() => added.resolveEnvironmentConflict(environment.id, null), /no longer has concurrent changes/);
});
