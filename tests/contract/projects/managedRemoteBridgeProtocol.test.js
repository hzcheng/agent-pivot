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
