'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createEmptyManagedCatalogEnvelope } = require('../../../out/projects/managedRemote/envelope');
const { ManagedRemoteCatalogManagementStore } = require('../../../out/projects/managedRemote/managementStore');
const { ManagedCatalogCoordinator } = require('../../../out/projects/managedRemote/store');
const {
    ConfigurationManagedCatalogBackend,
    MementoManagedCatalogReplicaFacade,
} = require('../../../out/projects/managedRemote/productionStore');

class MemoryMemento {
    constructor() { this.values = new Map(); }
    get(key) { return this.values.get(key); }
    async update(key, value) {
        if (value === undefined) this.values.delete(key);
        else this.values.set(key, JSON.parse(JSON.stringify(value)));
    }
}

test('MANAGED-REMOTE-MANAGEMENT-002 writes the synchronized backend at application scope', async () => {
    const calls = [];
    const configuration = {
        value: null,
        get(key) { calls.push(['get', key]); return this.value; },
        async update(key, value, target) {
            calls.push(['update', key, target]);
            this.value = value;
        },
    };
    const backend = new ConfigurationManagedCatalogBackend(
        configuration,
        'managedRemoteCatalogData',
        1,
    );
    const envelope = createEmptyManagedCatalogEnvelope('actor');
    await backend.write(envelope);
    assert.deepEqual(backend.read(), envelope);
    assert.deepEqual(calls, [
        ['update', 'managedRemoteCatalogData', 1],
        ['get', 'managedRemoteCatalogData'],
    ]);
});

test('MANAGED-REMOTE-MANAGEMENT-002 does not persist an empty catalog before owner action', async () => {
    const calls = [];
    const configuration = {
        get() { return null; },
        async update(...args) { calls.push(args); },
    };
    const memento = new MemoryMemento();
    const writerIdentityMemento = new MemoryMemento();
    const coordinator = await ManagedCatalogCoordinator.create(
        new ConfigurationManagedCatalogBackend(
            configuration,
            'managedRemoteCatalogData',
            1,
        ),
        new MementoManagedCatalogReplicaFacade(
            memento,
            'managedRemote',
            writerIdentityMemento,
            (() => {
                const identities = ['writer', 'actor'];
                return () => identities.shift();
            })(),
        ),
    );

    const result = await coordinator.reconcile();
    assert.equal(result.repairedBackend, false);
    assert.equal(result.repairedReplica, false);
    assert.deepEqual(calls, []);
    assert.equal(memento.get('managedRemote.writers'), undefined);
    assert.ok(writerIdentityMemento.get('managedRemote.writerIdentity'));
});

test('MANAGED-REMOTE-MANAGEMENT-002 restores a synced backend from every durable local writer', async () => {
    const configuration = {
        value: null,
        get() { return this.value; },
        async update(_key, value) { this.value = JSON.parse(JSON.stringify(value)); },
    };
    const memento = new MemoryMemento();
    const identities = ['writer-a', 'actor-a', 'writer-b', 'actor-b'];
    const backend = new ConfigurationManagedCatalogBackend(
        configuration,
        'managedRemoteCatalogData',
        1,
    );
    const replicaA = new MementoManagedCatalogReplicaFacade(
        memento,
        'managedRemote',
        new MemoryMemento(),
        () => identities.shift(),
    );
    const coordinatorA = await ManagedCatalogCoordinator.create(backend, replicaA);
    const storeA = new ManagedRemoteCatalogManagementStore(
        coordinatorA,
        'catalog-a',
        prefix => `${prefix}-a`,
    );
    const first = await storeA.addMachine(null, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 2207,
    });
    assert.equal(first.catalog.machines.length, 1);

    configuration.value = null;
    const replicaB = new MementoManagedCatalogReplicaFacade(
        memento,
        'managedRemote',
        new MemoryMemento(),
        () => identities.shift(),
    );
    const coordinatorB = await ManagedCatalogCoordinator.create(backend, replicaB);
    const recovered = await new ManagedRemoteCatalogManagementStore(
        coordinatorB,
        'catalog-b',
    ).getSnapshot();

    assert.equal(recovered.catalog.machines[0].connection.port, 2207);
    assert.ok(configuration.value, 'the missing synchronized backend is repaired');
});

test('MANAGED-REMOTE-MANAGEMENT-002 resumes an unfinished writer and preserves every durable peer', async () => {
    const memento = new MemoryMemento();
    const identities = ['new-writer', 'new-actor'];
    const writerIdentityMemento = new MemoryMemento();
    const replicas = new MementoManagedCatalogReplicaFacade(
        memento,
        'managedRemote',
        writerIdentityMemento,
        () => identities.shift(),
    );
    const envelope = createEmptyManagedCatalogEnvelope('actor');
    await memento.update('managedRemote.writers', {
        old: {
            actorId: 'old-actor', nextCounter: 2, envelope,
            stagedCandidate: envelope,
        },
    });
    assert.deepEqual(await replicas.allocateWriter(), {
        writerId: 'old', actorId: 'old-actor',
    });

    await memento.update('managedRemote.writers', {
        ...memento.get('managedRemote.writers'),
        completed: { actorId: 'completed-actor', nextCounter: 2, envelope },
    });
    await replicas.writeWriter('old', {
        actorId: 'old-actor', nextCounter: 2, envelope,
    });
    assert.ok(memento.get('managedRemote.writers').completed);
    assert.ok(memento.get('managedRemote.writers').old);
    assert.deepEqual(replicas.readWriters().map(entry => entry.writerId), [
        'completed',
        'old',
    ]);
    assert.deepEqual(await replicas.allocateWriter(), {
        writerId: 'old', actorId: 'old-actor',
    });
});
