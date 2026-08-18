'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    acceptedWorktreeGroupMergeSettlement,
    parseMergeWorktreeGroupsRequest,
    settledWorktreeGroupMergeSettlement,
} = require('../../../out/worktrees/groupMergeProtocol');

const valid = () => ({
    type: 'merge-worktree-groups', version: 1,
    requestId: 'worktree-merge-1', projectId: '/repo/main', sourceGroupId: 'g-1',
});

test('WORKTREE-GROUPS-MERGE-001 the merge request parses fail-closed with an exact key set', () => {
    assert.ok(parseMergeWorktreeGroupsRequest(valid()));
    assert.equal(parseMergeWorktreeGroupsRequest(null), null);
    assert.equal(parseMergeWorktreeGroupsRequest({}), null);
    assert.equal(parseMergeWorktreeGroupsRequest({ ...valid(), version: 2 }), null);
    assert.equal(parseMergeWorktreeGroupsRequest({ ...valid(), extra: 1 }), null,
        'an extra key is rejected');
    assert.equal(parseMergeWorktreeGroupsRequest({ ...valid(), requestId: 'bad id!' }), null);
    const without = valid();
    delete without.sourceGroupId;
    assert.equal(parseMergeWorktreeGroupsRequest(without), null);
});

test('WORKTREE-GROUPS-MERGE-001 merge settlements carry the correlation and exact outcomes', () => {
    assert.deepEqual(acceptedWorktreeGroupMergeSettlement(valid()), {
        type: 'worktree-group-merge-settlement', version: 1,
        requestId: 'worktree-merge-1', status: 'accepted',
    });
    assert.deepEqual(settledWorktreeGroupMergeSettlement(valid(), {
        kind: 'merged', groupId: 'g-2',
    }), {
        type: 'worktree-group-merge-settlement', version: 1,
        requestId: 'worktree-merge-1', status: 'merged', groupId: 'g-2',
    });
    assert.deepEqual(settledWorktreeGroupMergeSettlement(valid(), { kind: 'cancelled' }), {
        type: 'worktree-group-merge-settlement', version: 1,
        requestId: 'worktree-merge-1', status: 'cancelled',
    });
    assert.deepEqual(settledWorktreeGroupMergeSettlement(valid(), {
        kind: 'failed', errorCode: 'group-changed',
    }).errorCode, 'group-changed');
    assert.equal(settledWorktreeGroupMergeSettlement(valid(), {
        kind: 'failed', errorCode: 'not a code!',
    }).errorCode, undefined, 'a malformed error code never ships');
});
