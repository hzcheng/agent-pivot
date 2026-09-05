'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCausalVersion, createVersionedCandidates, joinVersionVectors, vectorIncludingVersion } = require('../../../out/projects/managedRemote/causal');
const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { createEmptyManagedCatalogEnvelope, createManagedRevisionSlot } = require('../../../out/projects/managedRemote/envelope');
const { managedSshAliasSuffix } = require('../../../out/projects/managedRemote/sshConfigProjection');
const {
    formatManagedSshCommand,
    ManagedRemoteBridgeController,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedRemoteBridgeController');

function activeEnvelope(lifecycle = 'active') {
    const catalog = ManagedRemoteCatalogService.create('bridge', prefix => `${prefix}:one`);
    catalog.addMachine({ name: 'Build', host: 'build.example.com', user: 'dev', port: 22 });
    catalog.addProject({
        id: 'project:one',
        environmentId: 'host:machine:one',
        name: 'API',
        remotePath: '/work/api',
    });
    const slot = createManagedRevisionSlot(catalog.getDocument());
    const envelope = createEmptyManagedCatalogEnvelope('envelope');
    const version = createCausalVersion(envelope.causalContext, 'envelope');
    envelope.authority = createVersionedCandidates({ lifecycle, active: slot }, version);
    envelope.causalContext = joinVersionVectors(envelope.causalContext, vectorIncludingVersion(version));
    return { envelope, slot };
}

function request(operation, revisionId) {
    return {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation,
        ...(revisionId ? { expectedRevisionId: revisionId } : {}),
    };
}

test('MANAGED-REMOTE-BRIDGE-001 rereads authority and rejects stale identity before local effects', async () => {
    const { envelope, slot } = activeEnvelope();
    let reads = 0;
    let effects = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { reads += 1; return envelope; },
    }, {
        async create() {
            return {
                async reconcile() { effects += 1; return {}; },
            };
        },
    }, 'session-12345678');
    const stale = await controller.execute(request('reconcile', `revision:${'0'.repeat(64)}`));
    assert.equal(stale.status, 'catalogOutOfDate');
    assert.equal(effects, 0);
    const current = await controller.execute(request('reconcile', slot.revisionId));
    assert.equal(current.status, 'ok');
    assert.equal(effects, 1);
    assert.equal(reads, 2);
});

test('MANAGED-REMOTE-BRIDGE-001 rejects endpoint-bearing requests before creating a coordinator', async () => {
    let creates = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { throw new Error('must not read'); },
    }, {
        async create() { creates += 1; return {}; },
    }, 'session-12345678');
    const result = await controller.execute({
        ...request('reconcile', `revision:${'a'.repeat(64)}`),
        host: 'attacker.example.com',
    });
    assert.equal(result.status, 'failed');
    assert.equal(creates, 0);

    const expired = await controller.execute({
        ...request('reconcile', `revision:${'a'.repeat(64)}`),
        sessionToken: 'expired-12345678',
    });
    assert.equal(expired.status, 'failed');
    assert.match(expired.message, /session expired/);
    assert.equal(creates, 0);
});

test('MANAGED-REMOTE-BRIDGE-001 never returns local SSH config bytes to a workspace host', async () => {
    const { envelope, slot } = activeEnvelope();
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return envelope; },
    }, {
        async create() {
            return {
                async preflightEnable() {
                    return {
                        activeConfigPath: '/home/local/.ssh/config',
                        includeBlock: 'Include safe',
                        candidateConfigContent: 'Host private-secret',
                        currentConfigContent: 'Host private-secret',
                        dependencyFingerprint: { files: [{ checksum: 'secret' }] },
                        projection: { entries: [{ host: 'synced.example.com' }] },
                    };
                },
            };
        },
    }, 'session-12345678');
    const result = await controller.execute(request('preflightEnable', slot.revisionId));
    assert.equal(result.status, 'ok');
    assert.equal(result.value.activeConfigPath, '/home/local/.ssh/config');
    assert.equal(result.value.includeBlock, 'Include safe');
    assert.equal('candidateConfigContent' in result.value, false);
    assert.equal('currentConfigContent' in result.value, false);
    assert.equal('dependencyFingerprint' in result.value, false);
    assert.equal('projection' in result.value, false);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 allows enable preflight for preview but not runtime reconcile', async () => {
    const { envelope, slot } = activeEnvelope('preview');
    let preflights = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return envelope; },
    }, {
        async create() {
            return {
                async preflightEnable() {
                    preflights += 1;
                    return {
                        activeConfigPath: '/home/local/.ssh/config',
                        generatedConfigPath: '/home/local/.agent-pivot/ssh/config',
                        backupPath: '/home/local/.ssh/config.bak',
                        editMode: 'automatic',
                    };
                },
                async reconcile() { throw new Error('must not reconcile preview'); },
            };
        },
    }, 'session-12345678');
    const preflight = await controller.execute(request('preflightEnable', slot.revisionId));
    const reconcile = await controller.execute(request('reconcile', slot.revisionId));
    assert.equal(preflight.status, 'ok');
    assert.equal(preflights, 1);
    assert.equal(reconcile.status, 'catalogOutOfDate');
});

test('MANAGED-REMOTE-BRIDGE-001 can recover local disable without catalog authority', async () => {
    let reads = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { reads += 1; return null; },
    }, {
        async create() {
            return {
                async recover(slot) {
                    assert.equal(slot, undefined);
                    return { status: 'disabled', record: { status: 'disabled' } };
                },
            };
        },
    }, 'session-12345678');
    const result = await controller.execute(request('recover'));
    assert.equal(result.status, 'ok');
    assert.equal(result.value.status, 'disabled');
    assert.equal(reads, 0);
});

test('MANAGED-REMOTE-MIGRATION-SSH-INSPECTION-001 inspects only a validated alias in the UI host', async () => {
    let reads = 0;
    const calls = [];
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { reads += 1; return null; },
    }, {
        async create() {
            return {
                getExecutable() { return '/usr/bin/ssh'; },
                getActiveConfigPath() { return '/home/local/.ssh/config'; },
            };
        },
    }, 'session-12345678', {
        platform: 'linux',
        openTerminal() {},
        async writeClipboard() {},
        async openRemoteWindow() {},
        async openRemoteFolder() {},
        async inspectLegacySshTarget(executable, configPath, target) {
            calls.push({ executable, configPath, target });
            return {
                status: 'needsInput',
                reason: 'Review detected details.',
                endpoint: { host: 'build.example.com', user: 'dev', port: 2207 },
            };
        },
    });
    const result = await controller.execute({
        ...request('inspectLegacySshTarget'),
        legacySshTarget: 'build-alias',
    });

    assert.equal(result.status, 'ok');
    assert.equal(reads, 0);
    assert.deepEqual(calls, [{
        executable: '/usr/bin/ssh',
        configPath: '/home/local/.ssh/config',
        target: 'build-alias',
    }]);
    assert.equal(result.value.endpoint.port, 2207);
});

test('MANAGED-REMOTE-SSH-COMMAND-001 opens and copies the endpoint without projection', async () => {
    const { envelope, slot } = activeEnvelope();
    const terminals = [];
    const copied = [];
    let reconciles = 0;
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return envelope; },
    }, {
        async create() {
            return {
                async reconcile() { reconciles += 1; return {}; },
                getExecutable() { return '/usr/local/bin/ssh'; },
            };
        },
    }, 'session-12345678', {
        platform: 'linux',
        openTerminal(options) { terminals.push(options); },
        async writeClipboard(value) { copied.push(value); },
    });
    const target = 'machine:one';
    const terminal = await controller.execute({
        ...request('openLocalSshTerminal', slot.revisionId),
        targetId: target,
    });
    const copy = await controller.execute({
        ...request('copyLocalSshCommand', slot.revisionId),
        targetId: target,
    });

    assert.equal(terminal.status, 'ok');
    assert.equal(copy.status, 'ok');
    assert.equal(reconciles, 0);
    assert.equal(terminals[0].name, 'SSH: Build');
    assert.equal(terminals[0].shellPath, '/usr/local/bin/ssh');
    assert.deepEqual(terminals[0].shellArgs, [
        '-p', '22', '-l', 'dev', 'build.example.com',
    ]);
    assert.equal(copied[0], formatManagedSshCommand(
        '/usr/local/bin/ssh', terminals[0].shellArgs, 'linux',
    ));
    assert.match(copied[0], /build\.example\.com/u);
});

test('MANAGED-REMOTE-NAVIGATION-001 resolves Machine and Project identities inside the UI host', async () => {
    const { envelope, slot } = activeEnvelope();
    const windows = [];
    const folders = [];
    const ensured = [];
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return envelope; },
    }, {
        async create() {
            return { async reconcile() { throw new Error('action must not reconcile'); } };
        },
    }, 'session-12345678', {
        platform: 'linux',
        openTerminal() {},
        async writeClipboard() {},
        async openRemoteWindow(authority) { windows.push(authority); },
        async openRemoteFolder(uri) { folders.push(uri); },
    }, {
        schedule() {},
        async ensureReady(value) { ensured.push(value.revisionId); },
    });
    const machine = await controller.execute({
        ...request('openManagedMachine', slot.revisionId),
        targetId: 'machine:one',
    });
    const project = await controller.execute({
        ...request('openManagedProject', slot.revisionId),
        targetId: 'project:one',
    });

    assert.equal(machine.status, 'ok');
    assert.equal(project.status, 'ok');
    assert.deepEqual(ensured, [slot.revisionId, slot.revisionId]);
    const alias = `build-${managedSshAliasSuffix('machine:one')}`;
    assert.equal(windows[0], `ssh-remote+${alias}`);
    assert.equal(
        folders[0],
        `vscode-remote://${encodeURIComponent(`ssh-remote+${alias}`)}/work/api`,
    );
    assert.doesNotMatch(`${windows[0]} ${folders[0]}`, /build\.example\.com|dev@/u);
});
