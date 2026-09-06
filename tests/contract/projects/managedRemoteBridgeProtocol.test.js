'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    parseManagedRemoteBridgeHandshakeRequest,
    parseManagedRemoteBridgeRequest,
} = require('../../../out/projects/managedRemote/bridgeProtocol');

test('MANAGED-REMOTE-BRIDGE-001 accepts only identity-based versioned requests', () => {
    const request = {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'reconcile',
        expectedRevisionId: `revision:${'a'.repeat(64)}`,
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(request), request);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...request,
        host: 'attacker.example.com',
    }), null);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...request,
        expectedRevisionId: undefined,
    }), null);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...request,
        protocolVersion: 2,
    }), null);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...request,
        expectedRevisionId: `revision:${'A'.repeat(64)}`,
    }), null);
    const recover = {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'recover',
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(recover), recover);

    const terminal = {
        ...request,
        operation: 'openLocalSshTerminal',
        targetId: 'machine:one',
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(terminal), terminal);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...terminal,
        targetId: undefined,
    }), null);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...request,
        targetId: 'machine:one',
    }), null);
    const project = {
        ...request,
        operation: 'openManagedProject',
        targetId: 'project:one',
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(project), project);

    const localDirectory = {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'listFileTransferLocalDirectory',
        fileTransfer: {
            kind: 'localRoot',
            rootId: 'a'.repeat(32),
            directoryId: 'b'.repeat(32),
        },
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(localDirectory), localDirectory);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...localDirectory,
        fileTransfer: { ...localDirectory.fileTransfer, path: '/outside' },
    }), null);
    assert.deepEqual(parseManagedRemoteBridgeRequest({
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'selectFileTransferLocalRoot',
    }), {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'selectFileTransferLocalRoot',
    });

    const copy = {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'copyFileTransferEntries',
        expectedRevisionId: `revision:${'a'.repeat(64)}`,
        fileTransfer: {
            kind: 'copy',
            taskId: 'task-123456789012',
            source: { kind: 'local', rootId: 'a'.repeat(32), directoryId: 'b'.repeat(32) },
            destination: { kind: 'managedMachine', machineId: 'machine:one', directoryId: 'c'.repeat(32) },
            entryIds: ['d'.repeat(32)],
            conflictPolicy: 'skip',
        },
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(copy), copy);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...copy,
        fileTransfer: { ...copy.fileTransfer, entryIds: ['d'.repeat(32), 'd'.repeat(32)] },
    }), null);

    const preflight = {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'preflightFileTransfer',
        expectedRevisionId: `revision:${'a'.repeat(64)}`,
        fileTransfer: {
            kind: 'preflight',
            source: { kind: 'local', rootId: 'a'.repeat(32), directoryId: 'b'.repeat(32) },
            destination: { kind: 'managedMachine', machineId: 'machine:one', directoryId: 'c'.repeat(32) },
            entryIds: ['d'.repeat(32)],
        },
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(preflight), preflight);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...preflight,
        fileTransfer: { ...preflight.fileTransfer, path: '/untrusted' },
    }), null);

});

test('MANAGED-REMOTE-BRIDGE-001 correlates the strict capability handshake', () => {
    const request = {
        protocolVersion: 1,
        requestId: 'request-12345678',
        challenge: 'challenge-123456',
    };
    assert.deepEqual(parseManagedRemoteBridgeHandshakeRequest(request), request);
    assert.equal(parseManagedRemoteBridgeHandshakeRequest({ ...request, extra: true }), null);
});
