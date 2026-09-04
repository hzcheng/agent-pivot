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
    const cancel = {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'cancelTransition',
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(cancel), cancel);
    assert.deepEqual(parseManagedRemoteBridgeRequest({
        ...cancel,
        operation: 'recover',
    }), { ...cancel, operation: 'recover' });

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

    const inspection = {
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation: 'inspectLegacySshTarget',
        legacySshTarget: 'build-alias',
    };
    assert.deepEqual(parseManagedRemoteBridgeRequest(inspection), inspection);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...inspection,
        legacySshTarget: '-F',
    }), null);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...inspection,
        legacySshTarget: 'build alias',
    }), null);
    assert.equal(parseManagedRemoteBridgeRequest({
        ...inspection,
        expectedRevisionId: `revision:${'a'.repeat(64)}`,
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
