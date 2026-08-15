'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    parseAbandonWorktreeGroupDeletionRequest,
    parseDeleteWorktreeGroupMemberRequest,
    parseDiscardWorktreeGenerationClaimRequest,
    parsePreviewWorktreeGroupDeletionRequest,
    parseRetryWorktreeGroupDeletionRequest,
} = require('../../../out/worktrees/groupDeletionProtocol');

const BASE = {
    version: 1,
    requestId: 'group-delete-n1-1',
    projectId: '/repo/main',
    groupId: 'group-1',
};

test('WORKTREE-GROUPS-MEMBER-DELETE-001 preview request accepts only the exact shape', () => {
    const valid = { ...BASE, type: 'preview-worktree-group-deletion', mode: 'member', memberId: 'm-1' };
    assert.deepEqual(parsePreviewWorktreeGroupDeletionRequest(valid), valid);
    assert.equal(parsePreviewWorktreeGroupDeletionRequest(null), null);
    assert.equal(parsePreviewWorktreeGroupDeletionRequest({ ...valid, mode: 'group' }), null);
    assert.equal(parsePreviewWorktreeGroupDeletionRequest({ ...valid, extra: 1 }), null);
    assert.equal(parsePreviewWorktreeGroupDeletionRequest({ ...valid, requestId: '' }), null);
    assert.equal(parsePreviewWorktreeGroupDeletionRequest({ ...valid, version: 2 }), null);
    assert.equal(parsePreviewWorktreeGroupDeletionRequest({ ...valid, projectId: 'a\nb' }), null);
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 delete request binds member and base revision', () => {
    const valid = {
        ...BASE,
        type: 'delete-worktree-group-member',
        memberId: 'm-1',
        baseRevision: 3,
    };
    assert.deepEqual(parseDeleteWorktreeGroupMemberRequest(valid), valid);
    const withReplacement = { ...valid, replacementPrimaryMemberId: 'm-2' };
    assert.deepEqual(
        parseDeleteWorktreeGroupMemberRequest(withReplacement), withReplacement);
    assert.equal(parseDeleteWorktreeGroupMemberRequest({ ...valid, baseRevision: 0 }), null);
    assert.equal(parseDeleteWorktreeGroupMemberRequest({ ...valid, baseRevision: 2.5 }), null);
    assert.equal(parseDeleteWorktreeGroupMemberRequest(
        { ...valid, replacementPrimaryMemberId: 'bad id!' }), null);
    assert.equal(parseDeleteWorktreeGroupMemberRequest({ ...valid, memberId: '' }), null);
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 retry/abandon/discard requests bind the operation or claim', () => {
    const retry = { ...BASE, type: 'retry-worktree-group-deletion', operationId: 'op-1' };
    assert.deepEqual(parseRetryWorktreeGroupDeletionRequest(retry), retry);
    assert.equal(parseRetryWorktreeGroupDeletionRequest({ ...retry, operationId: '' }), null);
    const abandon = { ...BASE, type: 'abandon-worktree-group-deletion', operationId: 'op-1' };
    assert.deepEqual(parseAbandonWorktreeGroupDeletionRequest(abandon), abandon);
    const discard = { ...BASE, type: 'discard-worktree-generation-claim', claimId: 'c-1' };
    assert.deepEqual(parseDiscardWorktreeGenerationClaimRequest(discard), discard);
    assert.equal(parseDiscardWorktreeGenerationClaimRequest({ ...discard, claimId: 42 }), null);
    // Cross-type confusion fails closed.
    assert.equal(parseRetryWorktreeGroupDeletionRequest(abandon), null);
    assert.equal(parseDeleteWorktreeGroupMemberRequest(retry), null);
});
