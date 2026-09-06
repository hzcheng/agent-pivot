'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createManagedRemoteManagementSettlement,
    parseManagedRemoteManagementRequest,
    readManagedRemoteManagementCorrelation,
} = require('../../../out/projects/managedRemote/managementProtocol');

const requestId = 'request-1234567890';

test('MANAGED-REMOTE-MANAGEMENT-001 accepts strict identity-only management intents', () => {
    assert.deepEqual(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action',
        version: 1,
        requestId,
        operation: 'addMachine',
        expectedRevisionId: null,
    }), {
        type: 'managed-remote-action',
        version: 1,
        requestId,
        operation: 'addMachine',
        expectedRevisionId: null,
    });
    assert.ok(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action',
        version: 1,
        requestId,
        operation: 'editProject',
        expectedRevisionId: `revision:${'a'.repeat(64)}`,
        targetId: 'project:one',
    }));
    assert.ok(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action',
        version: 1,
        requestId,
        operation: 'addProject',
        expectedRevisionId: `revision:${'a'.repeat(64)}`,
    }));
    assert.equal(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action',
        version: 1,
        requestId,
        operation: 'rollbackMigration',
        expectedRevisionId: `revision:${'a'.repeat(64)}`,
    }), null, 'the managed catalog is the sole authority and cannot be rolled back');
    assert.equal(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action',
        version: 1,
        requestId,
        operation: 'beginMigration',
        expectedRevisionId: null,
    }), null, 'migration is not part of the managed catalog protocol');
});

test('MANAGED-REMOTE-MANAGEMENT-001 rejects payload injection and target-shape drift', () => {
    const base = {
        type: 'managed-remote-action',
        version: 1,
        requestId,
        operation: 'editMachine',
        expectedRevisionId: null,
        targetId: 'machine:one',
    };
    assert.equal(parseManagedRemoteManagementRequest({
        ...base,
        host: 'attacker.example.com',
    }), null);
    assert.equal(parseManagedRemoteManagementRequest({ ...base, targetId: undefined }), null);
    assert.equal(parseManagedRemoteManagementRequest({
        ...base,
        operation: 'addMachine',
    }), null);
    assert.deepEqual(readManagedRemoteManagementCorrelation({
        ...base,
        host: 'attacker.example.com',
    }), { requestId, operation: 'editMachine' });
});

test('MANAGED-REMOTE-MANAGEMENT-001 creates bounded correlated settlements', () => {
    assert.deepEqual(createManagedRemoteManagementSettlement({
        requestId,
        operation: 'addMachine',
        status: 'applied',
        authoritativeRevisionId: `revision:${'b'.repeat(64)}`,
    }), {
        type: 'managed-remote-settlement',
        version: 1,
        requestId,
        operation: 'addMachine',
        status: 'applied',
        authoritativeRevisionId: `revision:${'b'.repeat(64)}`,
    });
});
