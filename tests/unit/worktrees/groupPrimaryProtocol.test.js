'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    acceptedWorktreeGroupPrimarySettlement,
    parseSetWorktreeGroupPrimaryRequest,
    settledWorktreeGroupPrimarySettlement,
} = require('../../../out/worktrees/groupPrimaryProtocol');

const request = {
    type: 'set-worktree-group-primary', version: 1,
    requestId: 'set-primary-1', projectId: 'project',
    groupId: 'g-1', memberId: 'm-2',
};

test('WORKTREE-GROUPS-001 accepts only the exact bounded set-primary request', () => {
    assert.deepEqual(parseSetWorktreeGroupPrimaryRequest(request), request);
    assert.equal(parseSetWorktreeGroupPrimaryRequest({ ...request, extra: true }), null);
    assert.equal(parseSetWorktreeGroupPrimaryRequest({ ...request, version: 2 }), null);
    assert.equal(parseSetWorktreeGroupPrimaryRequest({ ...request, requestId: 'bad id' }), null);
    assert.equal(parseSetWorktreeGroupPrimaryRequest({ ...request, groupId: '' }), null);
    assert.equal(parseSetWorktreeGroupPrimaryRequest({ ...request, memberId: 7 }), null);
    // Legacy unversioned requests (no requestId) no longer parse: the
    // settlement protocol is the only reliable release for the pending UI.
    const legacy = { type: request.type, projectId: 'project', groupId: 'g-1', memberId: 'm-2' };
    assert.equal(parseSetWorktreeGroupPrimaryRequest(legacy), null);
});

test('WORKTREE-GROUPS-001 correlates accepted and terminal set-primary settlements', () => {
    assert.deepEqual(acceptedWorktreeGroupPrimarySettlement(request), {
        type: 'worktree-group-primary-settlement', version: 1,
        requestId: 'set-primary-1', groupId: 'g-1', memberId: 'm-2',
        status: 'accepted',
    });
    assert.deepEqual(settledWorktreeGroupPrimarySettlement(request, { kind: 'settled' }), {
        type: 'worktree-group-primary-settlement', version: 1,
        requestId: 'set-primary-1', groupId: 'g-1', memberId: 'm-2',
        status: 'settled',
    });
    assert.deepEqual(settledWorktreeGroupPrimarySettlement(request, {
        kind: 'failed', errorCode: 'workspace-unavailable',
    }), {
        type: 'worktree-group-primary-settlement', version: 1,
        requestId: 'set-primary-1', groupId: 'g-1', memberId: 'm-2',
        status: 'failed', errorCode: 'workspace-unavailable',
    });
});
