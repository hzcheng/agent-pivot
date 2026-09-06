'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createManagedRemoteManagementSettlement,
    parseManagedRemoteManagementRequest,
    readManagedRemoteManagementCorrelation,
} = require('../../../out/projects/managedRemote/managementProtocol');

const requestId = 'request-1234567890';

test('MANAGED-REMOTE-MANAGEMENT-001 accepts strict management intents and a bounded Machine draft', () => {
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
    assert.deepEqual(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action', version: 1, requestId, operation: 'addMachine',
        expectedRevisionId: null,
        input: { name: ' Build ', host: ' build.example.com ', user: ' dev ', port: 22022 },
    }).input, { name: 'Build', host: 'build.example.com', user: 'dev', port: 22022 });
    assert.deepEqual(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action', version: 1, requestId, operation: 'editProject',
        expectedRevisionId: null, targetId: 'project:one',
        input: { name: ' API ', remotePath: ' /work/api ', description: ' Useful ', tags: 'backend, #api', color: ' #ef4444 ' },
    }).input, { name: 'API', remotePath: '/work/api', description: 'Useful', tags: ['backend', 'api'], color: '#ef4444' });
    assert.deepEqual(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action', version: 1, requestId, operation: 'editMachine',
        expectedRevisionId: null, targetId: 'machine:one',
        input: { name: ' Build ', host: ' build.example.com ', user: ' dev ', port: 22022 },
    }).input, { name: 'Build', host: 'build.example.com', user: 'dev', port: 22022 });
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
    assert.equal(parseManagedRemoteManagementRequest({
        type: 'managed-remote-action', version: 1, requestId, operation: 'addMachine',
        expectedRevisionId: null,
        input: { name: 'Build', host: 'build.example.com', user: 'dev', port: 70000 },
    }), null);
    for (const input of [
        { name: 'x'.repeat(129), host: 'build.example.com', user: 'dev', port: 22 },
        { name: 'Build', host: 'not a host', user: 'dev', port: 22 },
        { name: 'Build', host: 'build.example.com', user: '-dev', port: 22 },
    ]) {
        assert.equal(parseManagedRemoteManagementRequest({
            type: 'managed-remote-action', version: 1, requestId, operation: 'addMachine',
            expectedRevisionId: null, input,
        }), null, `must reject invalid persisted Machine input: ${JSON.stringify(input)}`);
    }
});

test('MANAGED-REMOTE-MANAGEMENT-001 bounds inline Project tag input', () => {
    const base = {
        type: 'managed-remote-action', version: 1, requestId, operation: 'editProject',
        expectedRevisionId: null, targetId: 'project:one',
        input: { name: 'API', remotePath: '/work/api', description: '', tags: '', color: '' },
    };
    assert.equal(parseManagedRemoteManagementRequest({
        ...base, input: { ...base.input, tags: 'a'.repeat(8193) },
    }), null);
    assert.equal(parseManagedRemoteManagementRequest({
        ...base, input: { ...base.input, tags: Array(65).fill('tag').join(',') },
    }), null);
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
