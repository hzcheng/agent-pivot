'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function loadNavigationProtocol() {
    return require('../../../out/projects/environmentHostNavigationProtocol');
}

function loadStore() {
    return require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/projectClientStore').ProjectClientStore;
}

function runProjectClientWorker(rootDirectory, index) {
    const modulePath = require.resolve(
        '../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/projectClientStore',
    );
    const worker = `
        const { ProjectClientStore } = require(process.argv[1]);
        const rootDirectory = process.argv[2];
        const index = Number(process.argv[3]);
        const state = { get() {}, update() { return Promise.resolve(); } };
        const store = new ProjectClientStore(state, {
            rootDirectory,
            createClientId: () => 'a'.repeat(32),
            now: () => index,
        });
        const prefix = index.toString(16).padStart(8, '0');
        store.updateProfile({
            protocolVersion: 2,
            requestId: index.toString(16).padStart(32, '0'),
            machineId: prefix + '-1111-4111-8111-111111111111',
            profile: {
                kind: 'ssh',
                target: 'worker-' + index,
                resolverAuthority: 'ssh-remote+worker-' + index,
            },
        }).then(() => process.exit(0), error => {
            console.error(error);
            process.exit(1);
        });
    `;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            '-e', worker, modulePath, rootDirectory, String(index),
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `project client worker exited with code ${code}`));
        });
    });
}

test('PROJECT-CLIENT-PROTOCOL-001 validates exact profile messages and deterministic snapshots', () => {
    const protocol = loadProtocol();
    const snapshot = protocol.createProjectClientSnapshot('a'.repeat(32), [{
        machineId: OTHER_MACHINE_ID,
        kind: 'local',
        target: null,
        resolverAuthority: null,
        updatedAtMs: 20,
    }, {
        machineId: MACHINE_ID,
        kind: 'ssh',
        target: 'devbox',
        resolverAuthority: 'ssh-remote+devbox',
        updatedAtMs: 10,
    }]);

    assert.deepEqual(snapshot.profiles.map(profile => profile.machineId), [
        MACHINE_ID,
        OTHER_MACHINE_ID,
    ]);
    assert.deepEqual(protocol.validateProjectClientSnapshot(snapshot), snapshot);
    assert.throws(
        () => protocol.validateProjectConnectionProfileUpdateRequest({
            protocolVersion: 2,
            requestId: 'b'.repeat(32),
            machineId: MACHINE_ID,
            profile: { kind: 'ssh', target: 'dev box', resolverAuthority: 'ssh-remote+devbox' },
        }),
        /target is invalid/,
    );
    assert.throws(
        () => protocol.validateProjectConnectionProfileUpdateRequest({
            protocolVersion: 2,
            requestId: 'b'.repeat(32),
            machineId: MACHINE_ID,
            profile: { kind: 'local', target: 'must-not-leak', resolverAuthority: null },
        }),
        /must be null/,
    );
    assert.throws(
        () => protocol.validateProjectClientSnapshot({ ...snapshot, extra: true }),
        /unexpected fields/,
    );
    const otherClient = protocol.createProjectClientSnapshot('b'.repeat(32), snapshot.profiles);
    assert.notEqual(snapshot.revision, otherClient.revision);
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
        protocolVersion: 2,
        requestId,
        machineId: MACHINE_ID,
        profile: { kind: 'ssh', target, resolverAuthority: `ssh-remote+${target}` },
    });

    await firstStore.updateProfile(request('1'.repeat(32), 'workstation-a'));
    await secondStore.updateProfile(request('2'.repeat(32), 'workstation-b'));

    const firstWorkspaceHost = new ProjectClientStore(firstState);
    assert.deepEqual((await firstWorkspaceHost.getSnapshot()).profiles, [{
        machineId: MACHINE_ID,
        kind: 'ssh',
        target: 'workstation-a',
        resolverAuthority: 'ssh-remote+workstation-a',
        updatedAtMs: 100,
    }]);
    assert.deepEqual((await secondStore.getSnapshot()).profiles, [{
        machineId: MACHINE_ID,
        kind: 'ssh',
        target: 'workstation-b',
        resolverAuthority: 'ssh-remote+workstation-b',
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

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 serializes profile writes across UI windows', async t => {
    const ProjectClientStore = loadStore();
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-project-client-'));
    t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
    const firstStore = new ProjectClientStore(makeMemento(), {
        rootDirectory,
        createClientId: () => 'a'.repeat(32),
        now: () => 100,
    });
    const secondStore = new ProjectClientStore(makeMemento(), {
        rootDirectory,
        createClientId: () => 'b'.repeat(32),
        now: () => 200,
    });

    await Promise.all([
        firstStore.updateProfile({
            protocolVersion: 2,
            requestId: '7'.repeat(32),
            machineId: MACHINE_ID,
            profile: { kind: 'ssh', target: 'first', resolverAuthority: 'ssh-remote+first' },
        }),
        secondStore.updateProfile({
            protocolVersion: 2,
            requestId: '8'.repeat(32),
            machineId: OTHER_MACHINE_ID,
            profile: { kind: 'ssh', target: 'second', resolverAuthority: 'ssh-remote+second' },
        }),
    ]);

    const first = await firstStore.getSnapshot();
    const second = await secondStore.getSnapshot();
    assert.equal(first.clientId, second.clientId);
    assert.deepEqual(first.profiles.map(profile => profile.target), ['first', 'second']);
    assert.deepEqual(second, first);
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 serializes profile writes across real UI-host processes', async t => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-project-client-processes-'));
    t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));

    await Promise.all([1, 2, 3, 4].map(index => runProjectClientWorker(rootDirectory, index)));

    const stored = JSON.parse(fs.readFileSync(
        path.join(rootDirectory, 'project-client/v1/state.json'),
        'utf8',
    ));
    assert.equal(stored.profiles.length, 4);
    assert.deepEqual(stored.profiles.map(profile => profile.target), [
        'worker-1', 'worker-2', 'worker-3', 'worker-4',
    ]);
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 removes a profile through one atomic local document write', async () => {
    const ProjectClientStore = loadStore();
    const state = makeMemento();
    const store = new ProjectClientStore(state, {
        createClientId: () => 'c'.repeat(32),
        now: () => 300,
    });
    await store.updateProfile({
        protocolVersion: 2,
        requestId: '3'.repeat(32),
        machineId: MACHINE_ID,
        profile: { kind: 'local', target: null, resolverAuthority: null },
    });
    const removed = await store.updateProfile({
        protocolVersion: 2,
        requestId: '4'.repeat(32),
        machineId: MACHINE_ID,
        profile: null,
    });

    assert.equal(removed.saved, false);
    assert.deepEqual(removed.snapshot.profiles, []);
    assert.equal(state.values['projectClient.connectionProfiles.v1'].profiles.length, 0);
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 enforces one default local Machine atomically', async () => {
    const ProjectClientStore = loadStore();
    const state = makeMemento();
    const store = new ProjectClientStore(state, {
        createClientId: () => 'c'.repeat(32),
        now: () => 300,
    });
    await store.updateProfile({
        protocolVersion: 2,
        requestId: '9'.repeat(32),
        machineId: MACHINE_ID,
        profile: { kind: 'local', target: null, resolverAuthority: null },
    });

    await assert.rejects(store.updateProfile({
        protocolVersion: 2,
        requestId: 'a'.repeat(32),
        machineId: OTHER_MACHINE_ID,
        profile: { kind: 'local', target: null, resolverAuthority: null },
    }), /already has a default local Machine/);
    assert.deepEqual((await store.getSnapshot()).profiles.map(profile => profile.machineId), [MACHINE_ID]);
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 resolves concurrent cross-window Local binding to one Machine', async t => {
    const ProjectClientStore = loadStore();
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-project-client-local-'));
    t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
    const firstStore = new ProjectClientStore(makeMemento(), {
        rootDirectory, createClientId: () => 'a'.repeat(32), now: () => 100,
    });
    const secondStore = new ProjectClientStore(makeMemento(), {
        rootDirectory, createClientId: () => 'b'.repeat(32), now: () => 200,
    });

    const outcomes = await Promise.allSettled([
        firstStore.updateProfile({
            protocolVersion: 2,
            requestId: 'b'.repeat(32),
            machineId: MACHINE_ID,
            profile: { kind: 'local', target: null, resolverAuthority: null },
        }),
        secondStore.updateProfile({
            protocolVersion: 2,
            requestId: 'c'.repeat(32),
            machineId: OTHER_MACHINE_ID,
            profile: { kind: 'local', target: null, resolverAuthority: null },
        }),
    ]);

    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
    assert.equal((await firstStore.getSnapshot()).profiles.filter(profile => profile.kind === 'local').length, 1);
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 fails closed instead of overwriting corrupt local profiles', async () => {
    const ProjectClientStore = loadStore();
    const state = makeMemento({
        'projectClient.identity.v1': 'a'.repeat(32),
        'projectClient.connectionProfiles.v1': {
            schemaVersion: 1,
            profiles: [{
                machineId: MACHINE_ID,
                kind: 'ssh',
                target: 'has whitespace',
                resolverAuthority: 'ssh-remote+has-whitespace',
                updatedAtMs: 1,
            }],
        },
    });
    const store = new ProjectClientStore(state, { now: () => 500 });

    await assert.rejects(store.getSnapshot(), /stored project connection profiles are invalid/);
    await assert.rejects(store.updateProfile({
        protocolVersion: 2,
        requestId: '6'.repeat(32),
        machineId: OTHER_MACHINE_ID,
        profile: { kind: 'local', target: null, resolverAuthority: null },
    }), /stored project connection profiles are invalid/);
    assert.equal(state.values['projectClient.connectionProfiles.v1'].profiles.length, 1);
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 fails closed on a corrupt cross-window state file', async t => {
    const ProjectClientStore = loadStore();
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-project-client-corrupt-'));
    t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
    const store = new ProjectClientStore(makeMemento(), {
        rootDirectory, createClientId: () => 'd'.repeat(32), now: () => 400,
    });
    await store.getSnapshot();
    const statePath = path.join(rootDirectory, 'project-client/v1/state.json');
    fs.writeFileSync(statePath, '{not-json', 'utf8');

    await assert.rejects(store.updateProfile({
        protocolVersion: 2,
        requestId: 'd'.repeat(32),
        machineId: MACHINE_ID,
        profile: { kind: 'ssh', target: 'devbox', resolverAuthority: 'ssh-remote+devbox' },
    }), /stored project client state file is invalid/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{not-json');
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 rejects a persisted state with multiple Local Machines', async t => {
    const ProjectClientStore = loadStore();
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-project-client-local-corrupt-'));
    t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
    const stateDirectory = path.join(rootDirectory, 'project-client/v1');
    const statePath = path.join(stateDirectory, 'state.json');
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({
        schemaVersion: 1,
        clientId: 'a'.repeat(32),
        profiles: [MACHINE_ID, OTHER_MACHINE_ID].map((machineId, index) => ({
            machineId,
            kind: 'local',
            target: null,
            resolverAuthority: null,
            updatedAtMs: index + 1,
        })),
    })}\n`, 'utf8');
    const before = fs.readFileSync(statePath, 'utf8');
    const store = new ProjectClientStore(makeMemento(), { rootDirectory });

    await assert.rejects(store.getSnapshot(), /multiple default local Machines/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
});

test('PROJECT-CLIENT-PROFILE-ISOLATION-001 fences a writer that loses its lease before rename', async t => {
    const ProjectClientStore = loadStore();
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-project-client-fencing-'));
    t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
    const store = new ProjectClientStore(makeMemento(), {
        rootDirectory, createClientId: () => 'a'.repeat(32), now: () => 600,
    });
    await store.getSnapshot();
    const statePath = path.join(rootDirectory, 'project-client/v1/state.json');
    const before = fs.readFileSync(statePath, 'utf8');
    const originalWriteFile = fs.promises.writeFile;
    let releaseWrite;
    let reachedWriteResolve;
    const reachedWrite = new Promise(resolve => {
        reachedWriteResolve = resolve;
    });
    const writeGate = new Promise(resolve => {
        releaseWrite = resolve;
    });
    let paused = false;
    fs.promises.writeFile = async (...args) => {
        const result = await originalWriteFile.apply(fs.promises, args);
        const target = String(args[0]);
        if (!paused && target.includes('.state.json.') && target.endsWith('.tmp')) {
            paused = true;
            reachedWriteResolve();
            await writeGate;
        }
        return result;
    };

    try {
        const update = store.updateProfile({
            protocolVersion: 2,
            requestId: 'e'.repeat(32),
            machineId: MACHINE_ID,
            profile: { kind: 'ssh', target: 'must-not-commit', resolverAuthority: 'ssh-remote+must-not-commit' },
        });
        await reachedWrite;
        const lockRoot = path.join(rootDirectory, 'project-client-locks');
        const lockContainer = fs.readdirSync(lockRoot).find(name => name.endsWith('.lock'));
        assert.ok(lockContainer);
        fs.rmSync(path.join(lockRoot, lockContainer, 'held'), { recursive: true, force: true });
        releaseWrite();

        await assert.rejects(update, /ownership changed before commit/);
        assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    } finally {
        releaseWrite();
        fs.promises.writeFile = originalWriteFile;
    }
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
                protocolVersion: 2,
                bridgeExtensionVersion: '1.1.0',
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
    const updated = await client.updateProfile(MACHINE_ID, {
        kind: 'ssh', target: 'devbox', resolverAuthority: 'ssh-remote+devbox',
    });
    assert.equal(updated.profiles.find(profile => profile.machineId === MACHINE_ID).target, 'devbox');
    assert.equal((await client.getProfile(MACHINE_ID)).target, 'devbox');
    assert.equal(JSON.stringify(client).includes('projectClient.connectionProfiles.v1'), false);
});

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 requires runtime navigation capabilities and sends only stable identities', async () => {
    const protocol = loadProtocol();
    const navigation = loadNavigationProtocol();
    const snapshot = protocol.createProjectClientSnapshot('d'.repeat(32), []);
    const calls = [];
    const executeCommand = async (command, argument) => {
        calls.push([command, argument]);
        if (command === navigation.ENVIRONMENT_NAVIGATION_HANDSHAKE_COMMAND) {
            return {
                protocolVersion: 1,
                bridgeExtensionVersion: '1.2.0',
                capabilities: {
                    hostNavigation: true,
                    projectNavigation: true,
                    authoritativeProfiles: true,
                },
            };
        }
        if (command === protocol.PROJECT_CLIENT_HANDSHAKE_COMMAND) {
            return {
                accepted: true,
                protocolVersion: 2,
                bridgeExtensionVersion: '1.2.0',
                capabilities: protocol.PROJECT_CLIENT_CAPABILITIES,
                snapshot,
            };
        }
        return { protocolVersion: 1, requestId: argument.requestId, handedOff: true };
    };
    const ConnectionProfileClient = loadFreshWithFakeVscode(
        '../../../out/projects/connectionProfileClient',
        { commands: { executeCommand } },
        __dirname,
    ).default;
    const client = new ConnectionProfileClient({
        mainExtensionVersion: '1.4.0', executeCommand, createRequestId: () => '5'.repeat(32),
    });

    assert.deepEqual(await client.refreshForMachineProjects(), snapshot);
    await client.openHost(MACHINE_ID);
    await client.openProject(MACHINE_ID, '/work/api');
    assert.deepEqual(calls.at(-2), [navigation.ENVIRONMENT_HOST_OPEN_COMMAND, {
        protocolVersion: 1, requestId: '5'.repeat(32), machineId: MACHINE_ID,
    }]);
    assert.deepEqual(calls.at(-1), [navigation.ENVIRONMENT_PROJECT_OPEN_COMMAND, {
        protocolVersion: 1, requestId: '5'.repeat(32), machineId: MACHINE_ID,
        projectPath: '/work/api',
    }]);
    assert.equal(JSON.stringify(calls.slice(-2)).includes('resolverAuthority'), false);

    const oldBridgeClient = new ConnectionProfileClient({
        executeCommand: async () => undefined,
    });
    await assert.rejects(oldBridgeClient.refreshForMachineProjects(), /must be an object/);
});

test('PROJECT-CLIENT-PROFILE-CLIENT-001 serializes refresh and update so a late snapshot cannot win', async () => {
    const protocol = loadProtocol();
    let releaseRefresh;
    const oldSnapshot = protocol.createProjectClientSnapshot('e'.repeat(32), []);
    const newSnapshot = protocol.createProjectClientSnapshot('e'.repeat(32), [{
        machineId: MACHINE_ID,
        kind: 'ssh',
        target: 'new-target',
        resolverAuthority: 'ssh-remote+new-target',
        updatedAtMs: 500,
    }]);
    const calls = [];
    const executeCommand = (command, argument) => {
        calls.push(command);
        if (command === protocol.PROJECT_CLIENT_HANDSHAKE_COMMAND) {
            return new Promise(resolve => {
                releaseRefresh = () => resolve({
                    accepted: true,
                    protocolVersion: 2,
                    bridgeExtensionVersion: '1.1.0',
                    capabilities: protocol.PROJECT_CLIENT_CAPABILITIES,
                    snapshot: oldSnapshot,
                });
            });
        }
        return Promise.resolve({
            protocolVersion: 2,
            requestId: argument.requestId,
            machineId: MACHINE_ID,
            saved: true,
            snapshot: newSnapshot,
        });
    };
    const ConnectionProfileClient = loadFreshWithFakeVscode(
        '../../../out/projects/connectionProfileClient',
        { commands: { executeCommand } },
        __dirname,
    ).default;
    const client = new ConnectionProfileClient({
        mainExtensionVersion: '1.4.0',
        executeCommand,
        createRequestId: () => 'f'.repeat(32),
    });

    const refresh = client.refresh();
    const update = client.updateProfile(MACHINE_ID, {
        kind: 'ssh', target: 'new-target', resolverAuthority: 'ssh-remote+new-target',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [protocol.PROJECT_CLIENT_HANDSHAKE_COMMAND]);
    releaseRefresh();
    await refresh;
    const updated = await update;

    assert.equal(updated.profiles.find(profile => profile.machineId === MACHINE_ID).target, 'new-target');
});

test('PROJECT-CLIENT-PROFILE-CLIENT-001 reads the UI-host authority for every connection decision', async t => {
    const protocol = loadProtocol();
    const ProjectClientStore = loadStore();
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-project-client-read-through-'));
    t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
    const firstStore = new ProjectClientStore(makeMemento(), {
        rootDirectory, createClientId: () => 'a'.repeat(32), now: () => 700,
    });
    const secondStore = new ProjectClientStore(makeMemento(), {
        rootDirectory, createClientId: () => 'b'.repeat(32), now: () => 800,
    });
    const executeThrough = store => async (command, argument) => {
        if (command === protocol.PROJECT_CLIENT_HANDSHAKE_COMMAND) {
            protocol.validateProjectClientHandshakeRequest(argument);
            return {
                accepted: true,
                protocolVersion: 2,
                bridgeExtensionVersion: '1.1.0',
                capabilities: protocol.PROJECT_CLIENT_CAPABILITIES,
                snapshot: await store.getSnapshot(),
            };
        }
        return store.updateProfile(argument);
    };
    const ConnectionProfileClient = loadFreshWithFakeVscode(
        '../../../out/projects/connectionProfileClient',
        { commands: { executeCommand: () => Promise.reject(new Error('unexpected default command')) } },
        __dirname,
    ).default;
    const firstClient = new ConnectionProfileClient({
        mainExtensionVersion: '1.4.0',
        executeCommand: executeThrough(firstStore),
        createRequestId: () => '1'.repeat(32),
    });
    const secondClient = new ConnectionProfileClient({
        mainExtensionVersion: '1.4.0',
        executeCommand: executeThrough(secondStore),
        createRequestId: () => '2'.repeat(32),
    });

    assert.equal(await firstClient.getProfile(MACHINE_ID), null);
    await secondClient.updateProfile(MACHINE_ID, {
        kind: 'ssh', target: 'other-window', resolverAuthority: 'ssh-remote+other-window',
    });

    assert.equal((await firstClient.getProfile(MACHINE_ID)).target, 'other-window');
});
