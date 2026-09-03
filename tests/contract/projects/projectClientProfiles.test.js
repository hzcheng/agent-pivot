'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_MACHINE_ID = '22222222-2222-4222-8222-222222222222';

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeMemento(initial = {}) {
    const values = clone(initial);
    const syncKeys = [];
    return {
        values,
        syncKeys,
        get(key) {
            return clone(values[key]);
        },
        async update(key, value) {
            if (value === undefined) delete values[key];
            else values[key] = clone(value);
        },
        setKeysForSync(keys) {
            syncKeys.push([...keys]);
        },
    };
}

function loadProtocol() {
    return require('../../../out/projects/projectClientProtocol');
}

function loadStore() {
    return require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/projectClientStore').ProjectClientStore;
}

test('PROJECT-CLIENT-PROTOCOL-001 validates exact profile messages and deterministic snapshots', () => {
    const protocol = loadProtocol();
    const snapshot = protocol.createProjectClientSnapshot('a'.repeat(32), [{
        machineId: OTHER_MACHINE_ID,
        kind: 'local',
        target: null,
        updatedAtMs: 20,
    }, {
        machineId: MACHINE_ID,
        kind: 'ssh',
        target: 'devbox',
        updatedAtMs: 10,
    }]);

    assert.deepEqual(snapshot.profiles.map(profile => profile.machineId), [
        MACHINE_ID,
        OTHER_MACHINE_ID,
    ]);
    assert.deepEqual(protocol.validateProjectClientSnapshot(snapshot), snapshot);
    assert.throws(
        () => protocol.validateProjectConnectionProfileUpdateRequest({
            protocolVersion: 1,
            requestId: 'b'.repeat(32),
            machineId: MACHINE_ID,
            profile: { kind: 'ssh', target: 'dev box' },
        }),
        /target is invalid/,
    );
    assert.throws(
        () => protocol.validateProjectConnectionProfileUpdateRequest({
            protocolVersion: 1,
            requestId: 'b'.repeat(32),
            machineId: MACHINE_ID,
            profile: { kind: 'local', target: 'must-not-leak' },
        }),
        /must be null/,
    );
    assert.throws(
        () => protocol.validateProjectClientSnapshot({ ...snapshot, extra: true }),
        /unexpected fields/,
    );
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 keeps aliases local to one UI client and shared across its workspace hosts', async () => {
    const ProjectClientStore = loadStore();
    const firstState = makeMemento();
    const secondState = makeMemento();
    const firstStore = new ProjectClientStore(firstState, {
        createClientId: () => 'a'.repeat(32),
        now: () => 100,
    });
    const secondStore = new ProjectClientStore(secondState, {
        createClientId: () => 'b'.repeat(32),
        now: () => 200,
    });
    const request = (requestId, target) => ({
        protocolVersion: 1,
        requestId,
        machineId: MACHINE_ID,
        profile: { kind: 'ssh', target },
    });

    await firstStore.updateProfile(request('1'.repeat(32), 'workstation-a'));
    await secondStore.updateProfile(request('2'.repeat(32), 'workstation-b'));

    const firstWorkspaceHost = new ProjectClientStore(firstState);
    assert.deepEqual((await firstWorkspaceHost.getSnapshot()).profiles, [{
        machineId: MACHINE_ID,
        kind: 'ssh',
        target: 'workstation-a',
        updatedAtMs: 100,
    }]);
    assert.deepEqual((await secondStore.getSnapshot()).profiles, [{
        machineId: MACHINE_ID,
        kind: 'ssh',
        target: 'workstation-b',
        updatedAtMs: 200,
    }]);
    assert.equal(JSON.stringify(firstState.values).includes('workstation-b'), false);
    assert.equal(JSON.stringify(secondState.values).includes('workstation-a'), false);
    assert.deepEqual(firstState.syncKeys, [], 'profile keys must never be registered for Settings Sync');
    assert.deepEqual(secondState.syncKeys, [], 'profile keys must never be registered for Settings Sync');
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 concurrent workspace hosts observe one durable UI client id', async () => {
    const ProjectClientStore = loadStore();
    const state = makeMemento();
    let generated = 0;
    const store = new ProjectClientStore(state, {
        createClientId: () => (++generated).toString(16).padStart(32, '0'),
    });

    const snapshots = await Promise.all([store.getSnapshot(), store.getSnapshot()]);

    assert.equal(generated, 1);
    assert.equal(snapshots[0].clientId, snapshots[1].clientId);
    assert.equal(state.values['projectClient.identity.v1'], snapshots[0].clientId);
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 removes a profile through one atomic local document write', async () => {
    const ProjectClientStore = loadStore();
    const state = makeMemento();
    const store = new ProjectClientStore(state, {
        createClientId: () => 'c'.repeat(32),
        now: () => 300,
    });
    await store.updateProfile({
        protocolVersion: 1,
        requestId: '3'.repeat(32),
        machineId: MACHINE_ID,
        profile: { kind: 'local', target: null },
    });
    const removed = await store.updateProfile({
        protocolVersion: 1,
        requestId: '4'.repeat(32),
        machineId: MACHINE_ID,
        profile: null,
    });

    assert.equal(removed.saved, false);
    assert.deepEqual(removed.snapshot.profiles, []);
    assert.equal(state.values['projectClient.connectionProfiles.v1'].profiles.length, 0);
});

test('PROJECT-CLIENT-PROFILE-CLIENT-001 correlates mutations and keeps only validated bridge state', async () => {
    const protocol = loadProtocol();
    const ProjectClientStore = loadStore();
    const state = makeMemento();
    const store = new ProjectClientStore(state, {
        createClientId: () => 'd'.repeat(32),
        now: () => 400,
    });
    const executeCommand = async (command, argument) => {
        if (command === protocol.PROJECT_CLIENT_HANDSHAKE_COMMAND) {
            protocol.validateProjectClientHandshakeRequest(argument);
            return {
                accepted: true,
                protocolVersion: 1,
                bridgeExtensionVersion: '1.0.3',
                capabilities: protocol.PROJECT_CLIENT_CAPABILITIES,
                snapshot: await store.getSnapshot(),
            };
        }
        return store.updateProfile(argument);
    };
    const ConnectionProfileClient = loadFreshWithFakeVscode(
        '../../../out/projects/connectionProfileClient',
        { commands: { executeCommand } },
        __dirname,
    ).default;
    const client = new ConnectionProfileClient({
        mainExtensionVersion: '1.4.0',
        executeCommand,
        createRequestId: () => '5'.repeat(32),
    });

    const initial = await client.refresh();
    assert.equal(initial.clientId, 'd'.repeat(32));
    await client.updateProfile(MACHINE_ID, { kind: 'ssh', target: 'devbox' });
    assert.equal(client.getCachedProfile(MACHINE_ID).target, 'devbox');
    assert.equal(JSON.stringify(client).includes('projectClient.connectionProfiles.v1'), false);
});
