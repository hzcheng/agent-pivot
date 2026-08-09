'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardLifecycleController } = require('../../../out/dashboard/lifecycleController');
const {
    SELF,
    createCommandRegistry,
    createFakeClock,
    flushAsync,
    loadWithFakeVscode,
    makeAggregate,
    makeRecord,
    makeRegistration,
} = require('./helpers');

const OpenWorkspaceBridgeClient = loadWithFakeVscode('../../../out/openWorkspaces/bridgeClient').default;
const {
    createOpenWorkspacePinSnapshot,
} = require('../../../out/openWorkspaces/pinProtocol');

function handshakeResponse() {
    return {
        accepted: true,
        protocolVersion: 4,
        bridgeExtensionVersion: '0.1.4',
        capabilities: {
            workspaces: true,
            atomicReplace: true,
            focusLeases: true,
            authoritativeUris: true,
            uiHostNavigation: true,
            savedProjectNavigation: true,
            workspacePins: true,
            stableOpenOrder: true,
        },
        pinSnapshot: createOpenWorkspacePinSnapshot([]),
    };
}

test('OPEN-BRIDGE-CLIENT-001 sequences changes and focus publications while suppressing unchanged metadata', async t => {
    const clock = createFakeClock(1000);
    const commands = createCommandRegistry();
    const publications = [];
    const aggregates = [];
    commands.register('_agentPivotOpenWorkspaces.bridge.publish', publication => {
        publications.push(publication);
    });
    commands.register('_agentPivotOpenWorkspaces.bridge.unregister', () => undefined);
    commands.register('_agentPivotOpenWorkspaces.bridge.handshake', handshakeResponse);
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        aggregate => aggregates.push(aggregate),
        error => { throw error; },
        {
            instanceId: SELF,
            now: () => clock.nowMs,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: clock.setInterval,
            clearInterval: clock.clearInterval,
        }
    );
    t.after(async () => {
        client.dispose();
        await flushAsync();
    });
    await flushAsync();

    await client.publish(makeRecord());
    await client.publish(makeRecord(), true);
    await client.publish(makeRecord({ name: 'Changed' }));
    await client.publish(makeRecord({ name: 'Changed' }));

    assert.deepEqual(publications.map(value => value.sequence), [1, 2, 3]);
    assert.deepEqual(publications.map(value => value.followsFocusEvent), [false, true, false]);
    assert.ok(publications.every(value => !Object.hasOwn(value, 'leaseUpdatedAtMs')));

    clock.advanceBy(10_000);
    await flushAsync();
    assert.equal(publications.at(-1).sequence, 4);
    assert.equal(publications.at(-1).followsFocusEvent, false);

    const aggregateCommand = commands.handlers.get('_agentPivotOpenWorkspaces.workspace.aggregate');
    const aggregate = makeAggregate([makeRegistration()]);
    await aggregateCommand(aggregate);
    await aggregateCommand({
        ...aggregate,
        observedAtMs: 6000,
        registrations: [{ ...aggregate.registrations[0], sequence: 99, leaseUpdatedAtMs: 5999 }],
    });
    assert.deepEqual(aggregates, [aggregate], 'a stale semantic revision must be ignored');
});

test('OPEN-BRIDGE-CLIENT-001 retries the same semantic publication after command delivery fails', async t => {
    const errors = [];
    const attempts = [];
    const retries = [];
    let rejectNext = true;
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        error => errors.push(error),
        {
            instanceId: '5'.repeat(32),
            now: () => 1000,
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async (command, publication) => {
                if (command === '_agentPivotOpenWorkspaces.bridge.handshake') {
                    return handshakeResponse();
                }
                if (command !== '_agentPivotOpenWorkspaces.bridge.publish') return;
                attempts.push(publication);
                if (rejectNext) {
                    rejectNext = false;
                    throw new Error('bridge unavailable');
                }
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            setTimeout: callback => {
                retries.push(callback);
                return retries.length;
            },
            clearTimeout: () => undefined,
        }
    );
    t.after(() => client.dispose());
    await flushAsync();

    assert.equal(attempts.length, 1);
    retries.shift()();
    await flushAsync();
    assert.deepEqual(attempts.map(value => value.sequence), [1, 2]);
    assert.equal(errors.length, 1);
});

test('OPEN-BRIDGE-CLIENT-001 rolls back partial constructor registrations before Retry', async t => {
    const activeRegistrations = new Map();
    const disposedRegistrations = [];
    let failDiagnosticRegistration = true;
    let heartbeatStarts = 0;
    let heartbeatClears = 0;
    const registerCommand = (command, callback) => {
        if (activeRegistrations.has(command)) {
            throw new Error(`duplicate command registration: ${command}`);
        }
        if (command === '_agentPivotOpenWorkspaces.workspace.diagnostic'
            && failDiagnosticRegistration) {
            failDiagnosticRegistration = false;
            throw new Error('controlled diagnostic registration failure');
        }
        activeRegistrations.set(command, callback);
        let disposed = false;
        return {
            dispose() {
                if (disposed) return;
                disposed = true;
                disposedRegistrations.push(command);
                if (activeRegistrations.get(command) === callback) {
                    activeRegistrations.delete(command);
                }
            },
        };
    };
    const dependencies = {
        instanceId: '7'.repeat(32),
        now: () => 1000,
        registerCommand,
        executeCommand: async command => (
            command === '_agentPivotOpenWorkspaces.bridge.handshake'
                ? handshakeResponse()
                : undefined
        ),
        setInterval: () => {
            heartbeatStarts += 1;
            return 'heartbeat';
        },
        clearInterval: () => {
            heartbeatClears += 1;
        },
    };

    assert.throws(
        () => new OpenWorkspaceBridgeClient(
            makeRecord(),
            () => undefined,
            () => undefined,
            dependencies
        ),
        /controlled diagnostic registration failure/
    );
    assert.deepEqual([...activeRegistrations.keys()], []);
    assert.deepEqual(disposedRegistrations, [
        '_agentPivotOpenWorkspaces.workspace.attentionFocusRequested',
        '_agentPivotOpenWorkspaces.workspace.runningFocusRequestedV2',
        '_agentPivotOpenWorkspaces.workspace.pinSnapshot',
        '_agentPivotOpenWorkspaces.workspace.aggregate',
    ]);
    assert.equal(heartbeatStarts, 0);
    assert.equal(heartbeatClears, 0);

    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        error => { throw error; },
        dependencies
    );
    t.after(() => client.dispose());
    await flushAsync();

    assert.deepEqual([...activeRegistrations.keys()].sort(), [
        '_agentPivotOpenWorkspaces.workspace.aggregate',
        '_agentPivotOpenWorkspaces.workspace.attentionFocusRequested',
        '_agentPivotOpenWorkspaces.workspace.diagnostic',
        '_agentPivotOpenWorkspaces.workspace.pinSnapshot',
        '_agentPivotOpenWorkspaces.workspace.runningFocusRequestedV2',
    ]);
    assert.equal(heartbeatStarts, 1);

    client.dispose();
    assert.deepEqual([...activeRegistrations.keys()], []);
    assert.equal(heartbeatClears, 1);
});

test('OPEN-WORKSPACE-RUNNING-FOCUS-CLIENT-001 sends correlated focus requests and degrades to false on delivery failure', async t => {
    const commands = createCommandRegistry();
    commands.register('_agentPivotOpenWorkspaces.bridge.handshake', handshakeResponse);
    commands.register('_agentPivotOpenWorkspaces.bridge.publish', () => undefined);
    commands.register('_agentPivotOpenWorkspaces.bridge.unregister', () => undefined);
    const requests = [];
    let rejectRequests = false;
    commands.register('_agentPivotOpenWorkspaces.bridge.requestRunningFocusV2', request => {
        if (rejectRequests) {
            throw new Error('command is not registered: simulated legacy bridge');
        }
        requests.push(request);
        return {
            protocolVersion: 2,
            requestId: request.requestId,
            targetNavigationIdentity: request.targetNavigationIdentity,
            delivered: true,
        };
    });
    const errors = [];
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        error => errors.push(error),
        {
            instanceId: SELF,
            now: () => 5000,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
        },
    );
    t.after(() => client.dispose());
    await flushAsync();

    const identity = 'f'.repeat(64);
    assert.equal(await client.requestRunningFocus(identity), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].protocolVersion, 2);
    assert.match(requests[0].requestId, /^[a-f0-9]{32}$/);
    assert.equal(requests[0].targetNavigationIdentity, identity);
    assert.equal(requests[0].createdAtMs, 5000);
    assert.equal(requests[0].expiresAtMs, 65_000);

    rejectRequests = true;
    assert.equal(await client.requestRunningFocus(identity), false);
    assert.equal(errors.length, 1);
    assert.equal(await client.requestRunningFocus('not-an-identity'), false);
    assert.equal(errors.length, 2);
});

test('OPEN-WORKSPACE-RUNNING-FOCUS-CLIENT-001 delivers focus requests exactly once and acknowledges malformed payloads', async t => {
    const commands = createCommandRegistry();
    commands.register('_agentPivotOpenWorkspaces.bridge.handshake', handshakeResponse);
    commands.register('_agentPivotOpenWorkspaces.bridge.publish', () => undefined);
    commands.register('_agentPivotOpenWorkspaces.bridge.unregister', () => undefined);
    const received = [];
    const errors = [];
    let adopted = false;
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        error => errors.push(error),
        {
            instanceId: SELF,
            now: () => 5000,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            onRunningFocusRequest: request => {
                if (!adopted) {
                    throw new Error('not adopted');
                }
                received.push(request);
            },
        },
    );
    t.after(() => client.dispose());
    await flushAsync();

    const deliver = commands.handlers.get(
        '_agentPivotOpenWorkspaces.workspace.runningFocusRequestedV2'
    );
    assert.ok(deliver, 'the client must register the running focus delivery command');
    const request = {
        protocolVersion: 2,
        requestId: 'a'.repeat(32),
        targetNavigationIdentity: 'f'.repeat(64),
        createdAtMs: 4000,
        expiresAtMs: 64_000,
    };
    await assert.rejects(
        Promise.resolve().then(() => deliver(request)),
        /not adopted/,
    );
    adopted = true;
    await deliver(request);
    await deliver(request);
    assert.deepEqual(received, [request]);
    assert.equal(errors.length, 1);

    await deliver({ ...request, requestId: 'b'.repeat(32), extra: true });
    assert.equal(received.length, 1);
    assert.equal(errors.length, 2);

    client.dispose();
    await deliver({ ...request, requestId: 'c'.repeat(32) });
    assert.equal(received.length, 1);
});

test('ATTENTION-STATUS-BAR-QUEUE-001 sends and receives exact cross-window attention focus requests', async t => {
    const commands = createCommandRegistry();
    commands.register('_agentPivotOpenWorkspaces.bridge.handshake', handshakeResponse);
    commands.register('_agentPivotOpenWorkspaces.bridge.publish', () => undefined);
    commands.register('_agentPivotOpenWorkspaces.bridge.unregister', () => undefined);
    const submitted = [];
    commands.register('_agentPivotOpenWorkspaces.bridge.requestAttentionFocus', request => {
        submitted.push(request);
        return {
            protocolVersion: 1,
            requestId: request.requestId,
            targetNavigationIdentity: request.targetNavigationIdentity,
            delivered: true,
        };
    });
    const received = [];
    const errors = [];
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        error => errors.push(error),
        {
            instanceId: SELF,
            now: () => 5000,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            onAttentionFocusRequest: request => received.push(request),
        },
    );
    t.after(() => client.dispose());
    await flushAsync();

    const identity = 'f'.repeat(64);
    const target = {
        projectId: 'e'.repeat(64),
        provider: 'codex',
        sessionId: 'session-1',
    };
    assert.equal(await client.requestAttentionFocus(identity, target), true);
    assert.equal(submitted.length, 1);
    assert.deepEqual(
        {
            targetNavigationIdentity: submitted[0].targetNavigationIdentity,
            projectId: submitted[0].projectId,
            provider: submitted[0].provider,
            sessionId: submitted[0].sessionId,
            createdAtMs: submitted[0].createdAtMs,
            expiresAtMs: submitted[0].expiresAtMs,
        },
        {
            targetNavigationIdentity: identity,
            ...target,
            createdAtMs: 5000,
            expiresAtMs: 65_000,
        },
    );

    const deliver = commands.handlers.get(
        '_agentPivotOpenWorkspaces.workspace.attentionFocusRequested'
    );
    assert.ok(deliver);
    await deliver(submitted[0]);
    await deliver(submitted[0]);
    assert.deepEqual(received, [submitted[0]], 'delivery is accepted exactly once');
    assert.deepEqual(errors, []);
});

test('ATTENTION-STATUS-BAR-QUEUE-001 retries an attention delivery rejected before handler adoption', async t => {
    const commands = createCommandRegistry();
    commands.register('_agentPivotOpenWorkspaces.bridge.handshake', handshakeResponse);
    commands.register('_agentPivotOpenWorkspaces.bridge.publish', () => undefined);
    commands.register('_agentPivotOpenWorkspaces.bridge.unregister', () => undefined);
    let adopted = false;
    const received = [];
    const errors = [];
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        error => errors.push(error),
        {
            instanceId: SELF,
            now: () => 5000,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            onAttentionFocusRequest: request => {
                if (!adopted) {
                    throw new Error('not adopted');
                }
                received.push(request);
            },
        },
    );
    t.after(() => client.dispose());
    await flushAsync();

    const deliver = commands.handlers.get(
        '_agentPivotOpenWorkspaces.workspace.attentionFocusRequested'
    );
    const request = {
        protocolVersion: 1,
        requestId: 'a'.repeat(32),
        targetNavigationIdentity: 'f'.repeat(64),
        projectId: 'e'.repeat(64),
        provider: 'claude',
        sessionId: 'session-1',
        createdAtMs: 4000,
        expiresAtMs: 64_000,
    };
    assert.throws(() => deliver(request), /not adopted/);
    adopted = true;
    deliver(request);

    assert.deepEqual(received, [request]);
    assert.equal(errors.length, 1);
});

test('OPEN-WORKSPACE-PIN-CLIENT-001 applies authoritative pin snapshots and validates correlated mutation results', async t => {
    const commands = createCommandRegistry();
    const snapshots = [];
    const identity = makeRecord().navigationIdentity;
    commands.register('_agentPivotOpenWorkspaces.bridge.handshake', handshakeResponse);
    commands.register('_agentPivotOpenWorkspaces.bridge.publish', () => undefined);
    commands.register('_agentPivotOpenWorkspaces.bridge.unregister', () => undefined);
    commands.register('_agentPivotOpenWorkspaces.bridge.setPin', request => ({
        protocolVersion: 1,
        requestId: request.requestId,
        navigationIdentity: request.navigationIdentity,
        pinned: request.pinned,
        snapshot: createOpenWorkspacePinSnapshot([{
            protocolVersion: 1,
            navigationIdentity: request.navigationIdentity,
            pinnedAtMs: 1234,
        }]),
    }));
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        error => { throw error; },
        {
            instanceId: SELF,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            onPinSnapshot: snapshot => snapshots.push(snapshot),
        },
    );
    t.after(() => client.dispose());
    await flushAsync();

    const outcome = await client.setPinned(7, identity, true);

    assert.equal(outcome.requestId, 7);
    assert.equal(outcome.pinned, true);
    assert.deepEqual(snapshots.map(snapshot => snapshot.pins.length), [0, 1]);
});

test('OPEN-WORKSPACE-BRIDGE-COMPATIBILITY-001 rejects a Bridge without authoritative UI-host navigation', async t => {
    const commands = [];
    const statuses = [];
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        () => undefined,
        {
            instanceId: '6'.repeat(32),
            now: () => 1000,
            registerCommand: () => ({ dispose: () => undefined }),
            executeCommand: async command => {
                commands.push(command);
                if (command === '_agentPivotOpenWorkspaces.bridge.handshake') {
                    return {
                        accepted: true,
                        protocolVersion: 4,
                        bridgeExtensionVersion: '0.1.4',
                        capabilities: {
                            workspaces: true,
                            atomicReplace: true,
                            focusLeases: true,
                        },
                    };
                }
            },
            setInterval: () => 'heartbeat',
            clearInterval: () => undefined,
            setTimeout: () => 'retry',
            clearTimeout: () => undefined,
            onStatusChange: status => statuses.push(status),
        }
    );
    t.after(() => client.dispose());
    await flushAsync();

    assert.deepEqual(statuses, ['update-required']);
    assert.deepEqual(commands, ['_agentPivotOpenWorkspaces.bridge.handshake']);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 publishes a focus marker only when the window gains focus', () => {
    const publications = [];
    let attentionEvaluations = 0;
    const controller = new DashboardLifecycleController({
        checkDataMigration: async () => undefined,
        applyProjectColorToCurrentWindow: () => undefined,
        refresh: () => undefined,
        publishOpenWorkspace: followsFocusEvent => publications.push(followsFocusEvent || false),
        evaluateAiSessionAttention: () => { attentionEvaluations += 1; },
    });

    controller.handleWindowStateChanged({ focused: false });
    controller.handleWindowStateChanged({ focused: true });
    controller.handleWorkspaceFoldersChanged();

    assert.deepEqual(publications, [true, false]);
    assert.equal(attentionEvaluations, 2);
});

test('OPEN-UNREGISTER-ON-DEACTIVATE-001 shutdown awaits the in-flight publication before unregistering and stays idempotent', async t => {
    const clock = createFakeClock(1000);
    const commands = createCommandRegistry();
    const events = [];
    let releasePublish;
    let releaseUnregister;
    commands.register('_agentPivotOpenWorkspaces.bridge.publish', () => {
        events.push('publish');
        return new Promise(resolve => {
            releasePublish = () => { events.push('publish-settled'); resolve(); };
        });
    });
    commands.register('_agentPivotOpenWorkspaces.bridge.unregister', () => {
        events.push('unregister');
        return new Promise(resolve => {
            releaseUnregister = () => { events.push('unregister-settled'); resolve(); };
        });
    });
    commands.register('_agentPivotOpenWorkspaces.bridge.handshake', handshakeResponse);
    const client = new OpenWorkspaceBridgeClient(
        makeRecord(),
        () => undefined,
        error => { throw error; },
        {
            instanceId: SELF,
            now: () => clock.nowMs,
            registerCommand: commands.register,
            executeCommand: commands.execute,
            setInterval: clock.setInterval,
            clearInterval: clock.clearInterval,
        }
    );
    t.after(async () => {
        client.dispose();
        await flushAsync();
    });
    await flushAsync();

    const publication = client.publish(makeRecord());
    await flushAsync(2);
    assert.deepEqual(events, ['publish']);

    const firstShutdown = client.shutdown();
    assert.equal(client.shutdown(), firstShutdown);
    let shutdownSettled = false;
    void firstShutdown.then(() => { shutdownSettled = true; });
    await flushAsync();
    assert.deepEqual(events, ['publish'],
        'unregister must wait for the in-flight publication');
    assert.equal(shutdownSettled, false);

    releasePublish();
    await flushAsync();
    assert.deepEqual(events, ['publish', 'publish-settled', 'unregister']);
    assert.equal(shutdownSettled, false);

    releaseUnregister();
    await firstShutdown;
    await publication;
    assert.deepEqual(events, ['publish', 'publish-settled', 'unregister', 'unregister-settled']);
    assert.equal(shutdownSettled, true);
});
