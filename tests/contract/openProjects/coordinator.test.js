'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    validateOpenWorkspaceAggregate,
} = require('../../../out/openWorkspaces/protocol');
const {
    OpenWorkspaceCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceCoordinator');
const {
    OpenWorkspaceStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceStore');
const {
    OPEN_WORKSPACE_LEASE_MS,
    OTHER,
    SELF,
    createSyntheticOpenWorkspaceStore,
    flushAsync,
    makePublication,
    makeRegistration,
} = require('./helpers');

function createCoordinator(root, overrides = {}) {
    const store = overrides.store || createSyntheticOpenWorkspaceStore();
    const deliveries = [];
    const diagnostics = [];
    const createdInstanceIds = [];
    let nowMs = 1000;
    let fireInterval;
    let fireWatcher;
    const coordinator = new OpenWorkspaceCoordinator(root, {
        now: () => nowMs,
        setInterval: callback => {
            fireInterval = callback;
            return 'coordinator-interval';
        },
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        createStore: (_rootDirectory, instanceId) => {
            createdInstanceIds.push(instanceId);
            return store;
        },
        deliverAggregate: aggregate => deliveries.push(aggregate),
        reportDiagnostic: event => diagnostics.push(event),
        ...overrides.dependencies,
    });
    return {
        coordinator,
        createdInstanceIds,
        deliveries,
        diagnostics,
        fireInterval: () => fireInterval(),
        fireWatcher: () => fireWatcher(),
        setNow: value => { nowMs = value; },
        store,
    };
}

test('PERSIST-STORE-001 preserves sequence monotonicity and expires a registration immediately after its lease', async t => {
    const root = makeTempDirectory(t, 'open-workspace-focused-store-');
    const registration = makeRegistration(SELF, 900, '/work/owned', {
        sequence: 2,
        leaseUpdatedAtMs: 1000,
    });
    const store = new OpenWorkspaceStore(root, SELF);

    await store.write(registration);
    assert.deepEqual((await store.scan(1000 + OPEN_WORKSPACE_LEASE_MS)).registrations, [registration]);
    await assert.rejects(
        store.write({ ...registration, sequence: 1 }),
        /sequence decreased/
    );

    const expired = await store.scan(1000 + OPEN_WORKSPACE_LEASE_MS + 1);
    assert.deepEqual(expired.registrations, []);
    assert.equal(expired.counters.expired, 1);
});

test('ARCH-COORDINATOR-001 preserves focus order across heartbeat publications and renews without redelivery', async t => {
    const harness = createCoordinator('/synthetic-coordinator');
    t.after(() => harness.coordinator.dispose());

    await harness.coordinator.publish(makePublication());
    harness.setNow(2000);
    await harness.coordinator.publish(makePublication({ sequence: 2, followsFocusEvent: true }));
    harness.setNow(3000);
    await harness.coordinator.publish(makePublication({ sequence: 3 }));

    const registration = (await harness.store.scan(3000)).registrations[0];
    assert.equal(registration.openedAtMs, 1000);
    assert.equal(registration.lastFocusedAtMs, 2000);
    assert.equal(registration.leaseUpdatedAtMs, 3000);
    assert.equal(harness.deliveries.length, 2, 'lease-only changes must suppress aggregate delivery');

    harness.setNow(14_000);
    harness.fireInterval();
    await flushAsync();
    assert.equal((await harness.store.scan(14_000)).registrations[0].leaseUpdatedAtMs, 14_000);
    assert.equal(harness.deliveries.length, 2);
});

test('OPEN-ALL-WINDOWS-LIST-001 preserves first-opened time across coordinator recreation', async t => {
    const store = createSyntheticOpenWorkspaceStore();
    const first = createCoordinator('/synthetic-first-opened', { store });
    await first.coordinator.publish(makePublication());
    // An ungraceful loss (crash or kill) leaves the registration behind so the
    // recreated coordinator can reclaim the original first-opened time; an
    // orderly shutdown removes it instead (OPEN-UNREGISTER-ON-DEACTIVATE-001).

    const recreated = createCoordinator('/synthetic-first-opened', { store });
    t.after(() => recreated.coordinator.dispose());
    recreated.setNow(5000);
    await recreated.coordinator.publish(makePublication({ sequence: 2 }));

    const registration = (await store.scan(5000)).registrations[0];
    assert.equal(registration.openedAtMs, 1000);
    assert.equal(registration.leaseUpdatedAtMs, 5000);
});

test('OPEN-WORKSPACE-INSTANCE-ROLLOVER-001 replaces a reloaded Extension Host instance without stale reclaim', async t => {
    const harness = createCoordinator('/synthetic-instance-rollover');
    t.after(() => harness.coordinator.dispose());

    await harness.coordinator.publish(makePublication());
    harness.setNow(2000);
    await harness.coordinator.publish(makePublication({
        instanceId: OTHER,
        sequence: 1,
    }));

    let registrations = (await harness.store.scan(2000)).registrations;
    assert.deepEqual(registrations.map(registration => registration.instanceId), [OTHER]);
    assert.deepEqual(harness.createdInstanceIds, [SELF, OTHER]);

    harness.setNow(14_000);
    harness.fireInterval();
    await flushAsync();
    registrations = (await harness.store.scan(14_000)).registrations;
    assert.deepEqual(registrations.map(registration => registration.instanceId), [OTHER]);
    assert.equal(registrations[0].leaseUpdatedAtMs, 14_000);

    await assert.rejects(
        harness.coordinator.publish(makePublication({
            instanceId: SELF,
            sequence: 2,
        })),
        /retired instanceId/
    );
    await harness.coordinator.unregister({
        protocolVersion: 4,
        instanceId: SELF,
    });

    registrations = (await harness.store.scan(14_000)).registrations;
    assert.deepEqual(registrations.map(registration => registration.instanceId), [OTHER]);
});

test('OPEN-WORKSPACE-INSTANCE-ROLLOVER-001 does not partially persist a replacement when stale removal fails', async t => {
    const store = createSyntheticOpenWorkspaceStore();
    let rejectStaleRemoval = true;
    const failingRemovalStore = {
        write: registration => store.write(registration),
        remove: instanceId => {
            if (rejectStaleRemoval && instanceId === SELF) {
                return Promise.reject(new Error('stale removal blocked'));
            }
            return store.remove(instanceId);
        },
        scan: nowMs => store.scan(nowMs),
    };
    const harness = createCoordinator('/synthetic-instance-rollover-removal-failure', {
        store,
        dependencies: {
            createStore: () => failingRemovalStore,
        },
    });
    t.after(() => harness.coordinator.dispose());

    await harness.coordinator.publish(makePublication());
    harness.setNow(2000);
    await assert.rejects(
        harness.coordinator.publish(makePublication({
            instanceId: OTHER,
            sequence: 1,
        })),
        /stale removal blocked/
    );
    let registrations = (await store.scan(2000)).registrations;
    assert.deepEqual(registrations.map(registration => registration.instanceId), [SELF]);

    harness.setNow(14_000);
    harness.fireInterval();
    await flushAsync();
    registrations = (await store.scan(14_000)).registrations;
    assert.deepEqual(registrations.map(registration => registration.instanceId), [SELF]);
    assert.equal(registrations[0].leaseUpdatedAtMs, 14_000);

    rejectStaleRemoval = false;
    harness.setNow(15_000);
    await harness.coordinator.publish(makePublication({
        instanceId: OTHER,
        sequence: 1,
    }));
    registrations = (await store.scan(15_000)).registrations;
    assert.deepEqual(registrations.map(registration => registration.instanceId), [OTHER]);
});

test('ARCH-COORDINATOR-001 retries an unchanged semantic revision after delivery failure', async t => {
    let fireWatcher;
    const attempts = [];
    const coordinator = new OpenWorkspaceCoordinator('/synthetic-delivery-retry', {
        now: () => 1000,
        setInterval: () => 'retry-interval',
        clearInterval: () => undefined,
        createWatcher: (_directory, callback) => {
            fireWatcher = callback;
            return { close: () => undefined };
        },
        createStore: () => createSyntheticOpenWorkspaceStore(),
        deliverAggregate: aggregate => {
            attempts.push(aggregate);
            if (attempts.length === 1) throw new Error('delivery unavailable');
        },
    });
    t.after(() => coordinator.dispose());

    await assert.rejects(coordinator.publish(makePublication()), /delivery unavailable/);
    fireWatcher();
    await flushAsync();

    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].semanticRevision, attempts[0].semanticRevision);
});

test('ARCH-COORDINATOR-AGGREGATE-BOUNDARY-001 deterministically keeps the 100 most recently focused registrations', async () => {
    const registrations = Array.from({ length: 101 }, (_, index) => makeRegistration(
        index.toString(16).padStart(32, '0'),
        index >= 99 ? 1000 : index,
        `/work/project-${index}`,
        { sequence: index + 1, leaseUpdatedAtMs: 5000 }
    ));
    const expectedInstanceIds = registrations.slice()
        .sort((left, right) => right.lastFocusedAtMs - left.lastFocusedAtMs
            || left.instanceId.localeCompare(right.instanceId))
        .slice(0, 100)
        .map(registration => registration.instanceId);
    const deliverFromScan = async scanRegistrations => {
        const deliveries = [];
        const coordinator = new OpenWorkspaceCoordinator('/synthetic-boundary', {
            now: () => 5000,
            setInterval: () => 'boundary-interval',
            clearInterval: () => undefined,
            createWatcher: () => ({ close: () => undefined }),
            createStore: () => ({
                write: async () => undefined,
                remove: async () => undefined,
                scan: async () => ({ registrations: scanRegistrations, counters: {} }),
            }),
            deliverAggregate: aggregate => deliveries.push(aggregate),
        });
        try {
            await coordinator.publish(makePublication());
            return deliveries[0];
        } finally {
            coordinator.dispose();
        }
    };

    const forward = await deliverFromScan(registrations);
    const reverse = await deliverFromScan(registrations.slice().reverse());

    assert.deepEqual(validateOpenWorkspaceAggregate(forward), forward);
    assert.deepEqual(forward.registrations.map(value => value.instanceId), expectedInstanceIds);
    assert.deepEqual(reverse, forward);
    assert.ok(forward.registrations.some(value => value.instanceId === registrations[100].instanceId));
    assert.ok(!forward.registrations.some(value => value.instanceId === registrations[0].instanceId));
});

test('ARCH-COORDINATOR-001 suppresses aggregate delivery when only sequence and lease timestamps change', async t => {
    const store = createSyntheticOpenWorkspaceStore();
    const harness = createCoordinator('/synthetic-semantic-revision', { store });
    t.after(() => harness.coordinator.dispose());
    await harness.coordinator.publish(makePublication());
    const initial = (await store.scan(1000)).registrations[0];

    store.seed({ ...initial, sequence: 2, leaseUpdatedAtMs: 2000 });
    harness.setNow(2000);
    await harness.coordinator.scanAndDeliver();

    assert.equal(harness.deliveries.length, 1);
    assert.equal(harness.deliveries[0].registrations[0].leaseUpdatedAtMs, 1000);
});

test('OPEN-UNREGISTER-ON-DEACTIVATE-001 shutdown removes the bound registration after in-flight mutations', async t => {
    const root = makeTempDirectory(t, 'open-workspace-coordinator-shutdown-');
    const fixture = createCoordinator(root);
    t.after(() => fixture.coordinator.dispose());

    await fixture.coordinator.publish(makePublication({ sequence: 1 }));
    assert.deepEqual(
        (await fixture.store.scan(1000)).registrations.map(value => value.instanceId),
        [SELF]
    );

    let releaseWrite;
    const pendingWrite = new Promise(resolve => { releaseWrite = resolve; });
    const originalWrite = fixture.store.write;
    const writes = [];
    fixture.store.write = registration => {
        writes.push(registration);
        return pendingWrite.then(() => originalWrite(registration));
    };
    const publication = fixture.coordinator.publish(makePublication({ sequence: 2 }));
    await flushAsync();
    assert.equal(writes.length, 1);

    const shutdown = fixture.coordinator.shutdown();
    assert.equal(fixture.coordinator.shutdown(), shutdown);
    let shutdownSettled = false;
    void shutdown.then(() => { shutdownSettled = true; });
    await flushAsync();
    assert.equal(shutdownSettled, false,
        'shutdown must wait for the in-flight publication');

    releaseWrite();
    await shutdown;
    await publication;
    assert.equal(shutdownSettled, true);
    assert.deepEqual((await fixture.store.scan(1000)).registrations, []);
    assert.ok(fixture.diagnostics.some(event => event.event === 'unregister'));
});

test('OPEN-UNREGISTER-ON-DEACTIVATE-001 shutdown without a publication leaves the registry untouched', async t => {
    const root = makeTempDirectory(t, 'open-workspace-coordinator-shutdown-idle-');
    const fixture = createCoordinator(root);
    t.after(() => fixture.coordinator.dispose());

    await fixture.coordinator.shutdown();
    assert.deepEqual((await fixture.store.scan(1000)).registrations, []);
    assert.ok(!fixture.diagnostics.some(event => event.event === 'unregister'));
});
