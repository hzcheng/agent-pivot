'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCausalVersion, createVersionedCandidates, joinVersionVectors, vectorIncludingVersion } = require('../../../out/projects/managedRemote/causal');
const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { createEmptyManagedCatalogEnvelope, createManagedRevisionSlot } = require('../../../out/projects/managedRemote/envelope');
const {
    ManagedRemoteBridgeController,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedRemoteBridgeController');

function activeEnvelope() {
    const catalog = ManagedRemoteCatalogService.create('bridge', prefix => `${prefix}:one`);
    catalog.addMachine({ name: 'Build', host: 'build.example.com', user: 'dev', port: 22 });
    const slot = createManagedRevisionSlot(catalog.getDocument());
    const envelope = createEmptyManagedCatalogEnvelope('envelope');
    const version = createCausalVersion(envelope.causalContext, 'envelope');
    envelope.authority = createVersionedCandidates({ lifecycle: 'active', active: slot }, version);
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
