'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    acceptedWorktreeGroupCreationSettlement,
    acceptedWorktreeGroupMemberSettlement,
    parseConfirmWorktreeGroupRequest,
    parseOpenWorktreeGroupFormRequest,
    parsePreviewWorktreeGroupRequest,
    parseWorktreeGroupMemberRequest,
    settledWorktreeGroupCreationSettlement,
    settledWorktreeGroupMemberSettlement,
} = require('../../../out/worktrees/groupCreationProtocol');

const confirmRequest = {
    type: 'confirm-worktree-group', version: 1,
    requestId: 'group-create-1', projectId: 'project',
    previewId: 'preview-1',
    displayName: 'Fix login',
    primaryRepositoryKey: '/alpha/.git',
    members: [{
        repositoryKey: '/alpha/.git',
        baseRef: 'refs/heads/main',
        branchName: 'agent-pivot/fix-login',
        worktreePath: '/alpha/.worktrees/fix-login',
        setupEnabled: true,
    }],
};

test('WORKTREE-GROUPS-CREATE-001 parses only exact bounded form requests', () => {
    assert.deepEqual(parseOpenWorktreeGroupFormRequest({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
    }), { type: 'open-worktree-group-form', version: 1, projectId: 'project' });
    assert.ok(parseOpenWorktreeGroupFormRequest({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        seedRepositoryKey: '/alpha/.git', seedWorktreePath: '/alpha/.worktrees/topic',
    }));
    assert.equal(parseOpenWorktreeGroupFormRequest({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        seedRepositoryKey: '/alpha/.git',
    }), null, 'a half seed is rejected');

});

test('WORKTREE-GROUPS-DERIVE-001 derive requests bind the source group end to end', () => {
    assert.deepEqual(parseOpenWorktreeGroupFormRequest({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        sourceGroupId: 'group-1',
    }), {
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        sourceGroupId: 'group-1',
    });
    assert.equal(parseOpenWorktreeGroupFormRequest({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        sourceGroupId: 'bad id!',
    }), null);
    assert.deepEqual(parsePreviewWorktreeGroupRequest({
        type: 'preview-worktree-group', version: 1,
        requestId: 'preview-1', projectId: 'project', displayName: 'X',
        selections: [{ repositoryKey: '/alpha/.git' }],
        sourceGroupId: 'group-1',
    }), {
        type: 'preview-worktree-group', version: 1,
        requestId: 'preview-1', projectId: 'project', displayName: 'X',
        selections: [{ repositoryKey: '/alpha/.git' }],
        sourceGroupId: 'group-1',
    });
    assert.equal(parsePreviewWorktreeGroupRequest({
        type: 'preview-worktree-group', version: 1,
        requestId: 'preview-1', projectId: 'project', displayName: 'X',
        selections: [{ repositoryKey: '/alpha/.git' }],
        sourceGroupId: 42,
    }), null);

    assert.deepEqual(parsePreviewWorktreeGroupRequest({
        type: 'preview-worktree-group', version: 1,
        requestId: 'preview-1', projectId: 'project', displayName: '',
        selections: [{ repositoryKey: '/alpha/.git' }],
    }), {
        type: 'preview-worktree-group', version: 1,
        requestId: 'preview-1', projectId: 'project', displayName: '',
        selections: [{ repositoryKey: '/alpha/.git' }],
    });
    assert.equal(parsePreviewWorktreeGroupRequest({
        type: 'preview-worktree-group', version: 1,
        requestId: 'preview-1', projectId: 'project', displayName: 'x',
        selections: [{ repositoryKey: '/alpha/.git', baseRef: '-evil' }],
    }), null, 'a flag-like base ref is rejected');

    assert.deepEqual(parseConfirmWorktreeGroupRequest(confirmRequest), confirmRequest);
    assert.equal(parseConfirmWorktreeGroupRequest({ ...confirmRequest, extra: 1 }), null);
    assert.equal(parseConfirmWorktreeGroupRequest({
        ...confirmRequest, members: [],
    }), null, 'an empty member set is rejected');
    assert.equal(parseConfirmWorktreeGroupRequest({
        ...confirmRequest,
        members: [{ ...confirmRequest.members[0], setupEnabled: 'yes' }],
    }), null, 'a non-boolean setupEnabled is rejected');
    assert.equal(parseConfirmWorktreeGroupRequest({
        ...confirmRequest,
        members: [{ ...confirmRequest.members[0], setupCommand: ['rm', '-rf', '/'] }],
    }), null, 'webview-supplied setup argv is rejected outright');
    assert.equal(parseConfirmWorktreeGroupRequest({
        ...confirmRequest,
        members: [{ ...confirmRequest.members[0], baseRef: '-x' }],
    }), null);

    const memberRequest = {
        type: 'retry-worktree-group-member', version: 1,
        requestId: 'member-1', projectId: 'project', groupId: 'g1', memberId: 'm1',
    };
    assert.deepEqual(parseWorktreeGroupMemberRequest(memberRequest), memberRequest);
    assert.equal(parseWorktreeGroupMemberRequest({ ...memberRequest, type: 'x' }), null);
    assert.equal(parseWorktreeGroupMemberRequest({ ...memberRequest, memberId: 'bad id' }), null);
});

test('WORKTREE-GROUPS-CREATE-001 correlates creation and member settlements', () => {
    assert.deepEqual(acceptedWorktreeGroupCreationSettlement(confirmRequest), {
        type: 'worktree-group-creation-settlement', version: 1,
        requestId: 'group-create-1', status: 'accepted',
    });
    assert.deepEqual(settledWorktreeGroupCreationSettlement(confirmRequest, {
        kind: 'created', groupId: 'g1',
    }), {
        type: 'worktree-group-creation-settlement', version: 1,
        requestId: 'group-create-1', status: 'created', groupId: 'g1',
    });
    assert.deepEqual(settledWorktreeGroupCreationSettlement(confirmRequest, {
        kind: 'failed', errorCode: 'invalid-members',
    }), {
        type: 'worktree-group-creation-settlement', version: 1,
        requestId: 'group-create-1', status: 'failed', errorCode: 'invalid-members',
    });
    const memberRequest = {
        type: 'dismiss-worktree-group-member', version: 1,
        requestId: 'member-2', projectId: 'project', groupId: 'g1', memberId: 'm1',
    };
    assert.deepEqual(acceptedWorktreeGroupMemberSettlement(memberRequest), {
        type: 'worktree-group-member-settlement', version: 1,
        requestId: 'member-2', groupId: 'g1', memberId: 'm1', status: 'accepted',
    });
    assert.deepEqual(settledWorktreeGroupMemberSettlement(memberRequest, {
        kind: 'failed', errorCode: 'dismiss-unavailable',
    }), {
        type: 'worktree-group-member-settlement', version: 1,
        requestId: 'member-2', groupId: 'g1', memberId: 'm1',
        status: 'failed', errorCode: 'dismiss-unavailable',
    });
});

test('WORKTREE-GROUPS-ADD-REPO-001 add-repo requests bind the target group end to end', () => {
    const { parseOpenWorktreeGroupFormRequest: parseOpen } = require('../../../out/worktrees/groupCreationProtocol');
    assert.deepEqual(parseOpen({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        targetGroupId: 'group-1',
    }), {
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        targetGroupId: 'group-1',
    });
    // Derive and add-repo are mutually exclusive entries.
    assert.equal(parseOpen({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        sourceGroupId: 'group-1', targetGroupId: 'group-2',
    }), null);
    assert.equal(parseOpen({
        type: 'open-worktree-group-form', version: 1, projectId: 'project',
        targetGroupId: 'bad id!',
    }), null);
    assert.deepEqual(parsePreviewWorktreeGroupRequest({
        type: 'preview-worktree-group', version: 1,
        requestId: 'preview-1', projectId: 'project', displayName: 'X',
        selections: [{ repositoryKey: '/alpha/.git' }],
        targetGroupId: 'group-1',
    }), {
        type: 'preview-worktree-group', version: 1,
        requestId: 'preview-1', projectId: 'project', displayName: 'X',
        selections: [{ repositoryKey: '/alpha/.git' }],
        targetGroupId: 'group-1',
    });
    assert.deepEqual(parseConfirmWorktreeGroupRequest({
        type: 'confirm-worktree-group', version: 1,
        requestId: 'confirm-1', projectId: 'project', previewId: 'preview-1',
        displayName: 'X',
        members: [{
            repositoryKey: '/alpha/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/x', worktreePath: '/alpha/.worktrees/x',
            setupEnabled: false,
        }],
        targetGroupId: 'group-1',
    }, undefined), {
        type: 'confirm-worktree-group', version: 1,
        requestId: 'confirm-1', projectId: 'project', previewId: 'preview-1',
        displayName: 'X',
        members: [{
            repositoryKey: '/alpha/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/x', worktreePath: '/alpha/.worktrees/x',
            setupEnabled: false,
        }],
        targetGroupId: 'group-1',
    });
});
