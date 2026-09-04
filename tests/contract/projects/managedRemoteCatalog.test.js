'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { stableManagedValue } = require('../../../out/projects/managedRemote/causal');
const {
    applyManagedCatalogTransaction,
    createEmptyManagedRemoteCatalog,
    hostEnvironmentId,
    joinManagedRemoteCatalogs,
    materializeManagedRemoteCatalog,
} = require('../../../out/projects/managedRemote/merge');
const {
    ManagedRemoteCatalogService,
} = require('../../../out/projects/managedRemote/catalogService');
const {
    parseManagedRemoteCatalog,
} = require('../../../out/projects/managedRemote/validation');

function idFactory() {
    let counter = 0;
    return prefix => `${prefix}:${++counter}`;
}

function service(actor = 'actor-a') {
    return ManagedRemoteCatalogService.create(actor, idFactory());
}

function addMachine(catalog, name = 'Build', overrides = {}) {
    return catalog.addMachine({
        name,
        host: overrides.host || 'build.example.com',
        user: overrides.user || 'dev',
        port: overrides.port,
    });
}

test('MANAGED-REMOTE-CATALOG-001 creates a Machine and its fixed Host atomically', () => {
    const catalog = service();
    const machine = addMachine(catalog);
    const view = catalog.getCatalog();

    assert.equal(machine.connection.port, 22);
    assert.deepEqual(view.machines, [machine]);
    assert.deepEqual(view.environments, [{
        id: hostEnvironmentId(machine.id),
        machineId: machine.id,
        kind: 'host',
        name: 'Host',
    }]);
    assert.deepEqual(view.conflicts, []);
    assert.ok(parseManagedRemoteCatalog(catalog.getDocument()));
});

test('MANAGED-REMOTE-CATALOG-001 supports custom SSH ports and rejects credentials', () => {
    const catalog = service();
    const machine = addMachine(catalog, 'Remote WSL', { port: 22022 });
    assert.equal(machine.connection.port, 22022);

    const injected = catalog.getDocument();
    injected.machines[machine.id].candidates[0].value.connection.identityFile = '~/.ssh/id_rsa';
    assert.equal(parseManagedRemoteCatalog(injected), null);
    assert.throws(() => catalog.addMachine({
        name: 'Bad Port', host: 'bad.example.com', user: 'dev', port: 65536,
    }), /invalid|unsupported/i);
});

test('MANAGED-REMOTE-CATALOG-001 keeps Project placement immutable', () => {
    const catalog = service();
    const first = addMachine(catalog, 'First');
    const second = addMachine(catalog, 'Second', { host: 'second.example.com' });
    const project = catalog.addProject({
        environmentId: hostEnvironmentId(first.id),
        name: 'API',
        remotePath: '/work/api',
        tags: ['backend'],
        favorite: true,
    });
    const edited = catalog.editProject(project.id, {
        name: 'API service', tags: ['backend', 'active'],
    });

    assert.equal(edited.environmentId, hostEnvironmentId(first.id));
    assert.deepEqual(catalog.getCatalog().layout.favoriteProjectIds, [project.id]);
    assert.throws(() => applyManagedCatalogTransaction(
        catalog.getDocument(),
        'actor-b',
        { projects: { [project.id]: { ...edited, environmentId: hostEnvironmentId(second.id) } } },
    ), /ownership is immutable/i);
});

test('MANAGED-REMOTE-CATALOG-001 requires explicit Dev Container removal before Machine removal', () => {
    const catalog = service();
    const machine = addMachine(catalog);
    const environment = catalog.addDevContainer(machine.id, 'API Container', {
        version: 1,
        originalAuthority: 'dev-container+aa@ssh-remote+build',
        sourceKind: 'config',
        sourceLocator: '/work/api/.devcontainer/devcontainer.json',
    });

    assert.throws(() => catalog.removeMachine(machine.id), /Dev Container Environments/);
    catalog.removeEnvironment(environment.id);
    catalog.removeMachine(machine.id);
    assert.deepEqual(catalog.getCatalog().machines, []);
});

test('MANAGED-REMOTE-CATALOG-002 join is commutative, associative, and idempotent', () => {
    const baseService = service('base');
    const machine = addMachine(baseService);
    const base = baseService.getDocument();
    const branchAService = new ManagedRemoteCatalogService(base, 'actor-a', idFactory());
    const branchBService = new ManagedRemoteCatalogService(base, 'actor-b', idFactory());
    branchAService.editMachine(machine.id, { name: 'Same' });
    branchBService.editMachine(machine.id, { name: 'Same' });
    const branchA = branchAService.getDocument();
    const branchB = branchBService.getDocument();
    const branchCService = new ManagedRemoteCatalogService(branchA, 'actor-c', idFactory());
    branchCService.editMachine(machine.id, { name: 'From A' });
    const branchC = branchCService.getDocument();

    assert.equal(
        stableManagedValue(joinManagedRemoteCatalogs(branchA, branchB)),
        stableManagedValue(joinManagedRemoteCatalogs(branchB, branchA)),
    );
    assert.equal(
        stableManagedValue(joinManagedRemoteCatalogs(joinManagedRemoteCatalogs(branchA, branchB), branchC)),
        stableManagedValue(joinManagedRemoteCatalogs(branchA, joinManagedRemoteCatalogs(branchB, branchC))),
    );
    assert.equal(
        stableManagedValue(joinManagedRemoteCatalogs(branchA, branchA)),
        stableManagedValue(branchA),
    );
    const joined = joinManagedRemoteCatalogs(branchA, branchB);
    assert.equal(joined.machines[machine.id].candidates.length, 2,
        'concurrent equal values retain both causal dots');
});

test('MANAGED-REMOTE-CATALOG-002 keeps delete/update and missing Host conflicts reviewable', () => {
    const baseService = service('base');
    const machine = addMachine(baseService);
    const base = baseService.getDocument();
    const deleted = new ManagedRemoteCatalogService(base, 'delete', idFactory());
    const updated = new ManagedRemoteCatalogService(base, 'update', idFactory());
    deleted.removeMachine(machine.id);
    updated.editMachine(machine.id, { name: 'Updated' });

    const joined = joinManagedRemoteCatalogs(
        deleted.getDocument(), updated.getDocument(),
    );
    const view = materializeManagedRemoteCatalog(joined);
    assert.ok(view.machines.some(candidate => candidate.id === machine.id));
    assert.ok(view.conflicts.some(conflict =>
        conflict.entityId === machine.id && conflict.kind === 'delete-update'));
    assert.ok(view.conflicts.some(conflict =>
        conflict.entityId === machine.id && conflict.kind === 'missing-host'));

    const recovery = new ManagedRemoteCatalogService(joined, 'resolver', idFactory());
    recovery.resolveMachineConflict(machine.id, {
        ...machine,
        name: 'Recovered',
    });
    assert.deepEqual(recovery.getCatalog().conflicts, []);
    assert.equal(recovery.getCatalog().environments[0].kind, 'host');
});

test('MANAGED-REMOTE-CATALOG-003 hidden placement candidates block parent deletion', () => {
    const baseService = service('base');
    const first = addMachine(baseService, 'First');
    const second = addMachine(baseService, 'Second', { host: 'second.example.com' });
    const base = baseService.getDocument();
    const firstBranch = new ManagedRemoteCatalogService(base, 'first', idFactory());
    const secondBranch = new ManagedRemoteCatalogService(base, 'second', idFactory());
    firstBranch.addProject({
        id: 'shared-project',
        environmentId: hostEnvironmentId(first.id),
        name: 'Shared',
        remotePath: '/work/shared',
    });
    secondBranch.addProject({
        id: 'shared-project',
        environmentId: hostEnvironmentId(second.id),
        name: 'Shared',
        remotePath: '/work/shared',
    });
    const joined = joinManagedRemoteCatalogs(
        firstBranch.getDocument(), secondBranch.getDocument(),
    );
    const reconciled = new ManagedRemoteCatalogService(joined, 'reconciler', idFactory());

    assert.throws(() => reconciled.removeMachine(second.id), /Remove Projects/);
    assert.equal(reconciled.getDocument().machines[second.id].candidates
        .some(candidate => candidate.value !== null), true);
});

test('MANAGED-REMOTE-CATALOG-003 hidden Environment kind candidates block Machine cascade', () => {
    const baseService = service('base');
    const machine = addMachine(baseService);
    const base = baseService.getDocument();
    const hostId = hostEnvironmentId(machine.id);
    const devBranch = applyManagedCatalogTransaction(base, 'dev', {
        environments: {
            [hostId]: {
                id: hostId,
                machineId: machine.id,
                kind: 'devContainer',
                name: 'Hidden container',
                devContainerAnchor: {
                    version: 1,
                    originalAuthority: 'dev-container+aa@ssh-remote+build',
                    sourceKind: 'workspace',
                    sourceLocator: '/work',
                },
            },
        },
    });
    const hostBranch = applyManagedCatalogTransaction(base, 'host', {
        environments: { [hostId]: { ...baseService.getCatalog().environments[0], name: 'Host' } },
    });
    const catalog = new ManagedRemoteCatalogService(
        joinManagedRemoteCatalogs(devBranch, hostBranch),
        'reconciler',
        idFactory(),
    );

    assert.throws(() => catalog.removeMachine(machine.id), /Dev Container Environments/);
});

test('MANAGED-REMOTE-CATALOG-004 accepts a 10,001st causal writer', () => {
    const document = createEmptyManagedRemoteCatalog('seed');
    for (let index = 0; index < 10000; index += 1) {
        document.versionVector[`history-${index}`] = 1;
    }
    const updated = applyManagedCatalogTransaction(document, 'writer-10001', {});
    assert.equal(updated.versionVector['writer-10001'], 1);
    assert.ok(parseManagedRemoteCatalog(updated));
});
