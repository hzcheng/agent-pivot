'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    acceptedManagedWorktreeRemovalSettlement,
    parseManagedWorktreeRemovalRequest,
    settledManagedWorktreeRemovalSettlement,
} = require('../../../out/worktrees/removalProtocol');

const request = {
    type: 'remove-managed-worktree', version: 1,
    requestId: 'remove-1', projectId: 'project',
    repositoryKey: '/repo/.git',
    worktreePath: '/repo/.agent-pivot/worktrees/task',
};

test('WORKTREE-MANAGED-CLEANUP-PROTOCOL-001 accepts only the exact bounded request', () => {
    assert.deepEqual(parseManagedWorktreeRemovalRequest(request), request);
    assert.equal(parseManagedWorktreeRemovalRequest({ ...request, extra: true }), null);
    assert.equal(parseManagedWorktreeRemovalRequest({ ...request, version: 2 }), null);
    assert.equal(parseManagedWorktreeRemovalRequest({ ...request, worktreePath: 'relative' }), null);
    assert.equal(parseManagedWorktreeRemovalRequest({ ...request, requestId: 'bad id' }), null);
});

test('WORKTREE-MANAGED-CLEANUP-PROTOCOL-001 correlates accepted and terminal settlements', () => {
    assert.deepEqual(acceptedManagedWorktreeRemovalSettlement(request), {
        type: 'managed-worktree-removal-settlement', version: 1,
        requestId: 'remove-1', status: 'accepted',
    });
    assert.deepEqual(settledManagedWorktreeRemovalSettlement(request, {
        kind: 'rejected', errorCode: 'worktree-dirty',
    }), {
        type: 'managed-worktree-removal-settlement', version: 1,
        requestId: 'remove-1', status: 'rejected', errorCode: 'worktree-dirty',
    });
});
