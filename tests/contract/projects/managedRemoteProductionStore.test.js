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

class ConcurrentWriterMemento extends MemoryMemento {
    constructor() { super(); this.pendingWriterUpdates = []; this.released = false; }
    async update(key, value) {
        if (key !== 'managedRemote.writers' || this.released) {
            return super.update(key, value);
        }
        await new Promise(resolve => {
            this.pendingWriterUpdates.push({ key, value, resolve });
            if (this.pendingWriterUpdates.length === 2) {
                this.released = true;
                for (const pending of this.pendingWriterUpdates) {
                    super.update(pending.key, pending.value).then(pending.resolve);
                }
            }
        });
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
    assert.equal(writerIdentityMemento.get('managedRemote.writerIdentity'), undefined);
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

test('MANAGED-REMOTE-MANAGEMENT-002 never adopts another window unfinished writer', async () => {
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
        writerId: 'new-writer', actorId: 'catalog-actor:new-actor',
    });

    await memento.update('managedRemote.writers', {
        ...memento.get('managedRemote.writers'),
        completed: { actorId: 'completed-actor', nextCounter: 2, envelope },
    });
    await replicas.writeWriter('new-writer', {
        actorId: 'catalog-actor:new-actor', nextCounter: 2, envelope,
    });
    assert.ok(memento.get('managedRemote.writers').completed);
    assert.ok(memento.get('managedRemote.writers').old);
    assert.deepEqual(replicas.readWriters().map(entry => entry.writerId), [
        'completed',
        'new-writer',
        'old',
    ]);
    assert.deepEqual(await replicas.allocateWriter(), {
        writerId: 'new-writer', actorId: 'catalog-actor:new-actor',
    });
});

test('MANAGED-REMOTE-MANAGEMENT-002 retains concurrent durable window replicas', async () => {
    const memento = new ConcurrentWriterMemento();
    const identityA = new MemoryMemento();
    const identityB = new MemoryMemento();
    await identityA.update('managedRemote.writerIdentity', {
        writerId: 'writer-a', actorId: 'actor-a',
    });
    await identityB.update('managedRemote.writerIdentity', {
        writerId: 'writer-b', actorId: 'actor-b',
    });
    const replicaA = new MementoManagedCatalogReplicaFacade(
        memento, 'managedRemote', identityA,
    );
    const replicaB = new MementoManagedCatalogReplicaFacade(
        memento, 'managedRemote', identityB,
    );
    const envelope = createEmptyManagedCatalogEnvelope('actor');

    await Promise.all([
        replicaA.writeWriter('writer-a', {
            actorId: 'actor-a', nextCounter: 2, envelope,
        }),
        replicaB.writeWriter('writer-b', {
            actorId: 'actor-b', nextCounter: 2, envelope,
        }),
    ]);

    assert.ok(replicaA.readWriter('writer-a'));
    assert.ok(replicaB.readWriter('writer-b'));
});

/**
 * A faithful stand-in for `vscode.workspace.getConfiguration`, which returns a
 * snapshot: a configuration object never observes writes made after it was
 * handed out. Sharing one mutable fake hides that, and hides any code that
 * caches the object instead of re-acquiring it.
 */
function configurationSource() {
    const stored = new Map();
    const handed = [];
    return {
        stored,
        handed,
        acquire() {
            const snapshot = new Map(stored);
            const configuration = {
                get(key) { return snapshot.get(key); },
                async update(key, value) {
                    stored.set(key, JSON.parse(JSON.stringify(value)));
                },
            };
            handed.push(configuration);
            return configuration;
        },
    };
}

test('MANAGED-REMOTE-MANAGEMENT-002 reads back a catalog it just wrote through configuration', async () => {
    const source = configurationSource();
    const backend = new ConfigurationManagedCatalogBackend(
        () => source.acquire(), 'managedRemoteCatalogData', 1,
    );
    const envelope = createEmptyManagedCatalogEnvelope('actor');

    await backend.write(envelope);

    // Holding one snapshot means every later read returns the value from
    // activation, so a Machine the user just added never comes back and the
    // panel stays empty.
    assert.deepEqual(
        backend.read(),
        envelope,
        'the backend must re-acquire configuration instead of caching a snapshot',
    );
});

test('MANAGED-REMOTE-MANAGEMENT-002 activates a Machine through the real configuration backend', async () => {
    const source = configurationSource();
    const coordinator = await ManagedCatalogCoordinator.create(
        new ConfigurationManagedCatalogBackend(
            () => source.acquire(), 'managedRemoteCatalogData', 1,
        ),
        new MementoManagedCatalogReplicaFacade(
            new MemoryMemento(),
            'managedRemote',
            new MemoryMemento(),
            (() => {
                const identities = ['writer', 'actor'];
                return () => identities.shift();
            })(),
        ),
    );
    let ordinal = 0;
    const store = new ManagedRemoteCatalogManagementStore(
        coordinator, 'catalog:one', prefix => `${prefix}:cfg-${++ordinal}`,
    );

    const added = await store.addMachine(null, {
        name: 'RedDev', host: 'reddev.example.com', user: 'dev', port: 22022,
    });
    assert.equal(added.lifecycle, 'active');

    // And it has to survive the next read, which is what the panel renders from.
    const reread = await store.getSnapshot();
    assert.equal(reread.catalog.machines.length, 1, 'the added Machine must persist');
    assert.equal(reread.catalog.machines[0].name, 'RedDev');
});
