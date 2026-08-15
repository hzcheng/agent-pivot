'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    acceptedWorktreeGroupRenameSettlement,
    parseRenameWorktreeGroupRequest,
    settledWorktreeGroupRenameSettlement,
} = require('../../../out/worktrees/groupRenameProtocol');

function validRequest() {
    return {
        type: 'rename-worktree-group',
        version: 1,
        requestId: 'group-rename-1',
        projectId: '/repo/main',
        groupId: 'abc123',
        displayName: '修复登录',
        baseRevision: 3,
    };
}

test('WORKTREE-GROUPS-RENAME-001 accepts the exact versioned request shape', () => {
    const parsed = parseRenameWorktreeGroupRequest(validRequest());
    assert.deepEqual(parsed, validRequest());
});

test('WORKTREE-GROUPS-RENAME-001 fails closed on malformed, extra-field, or unsafe input', () => {
    assert.equal(parseRenameWorktreeGroupRequest(null), null);
    assert.equal(parseRenameWorktreeGroupRequest('rename-worktree-group'), null);
    assert.equal(parseRenameWorktreeGroupRequest({}), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), version: 2,
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), type: 'rename-group',
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), extra: 'nope',
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), displayName: '',
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), displayName: '   ',
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), displayName: 'bad\nname',
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), displayName: 'x'.repeat(201),
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), requestId: 'bad id!',
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), groupId: '',
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), baseRevision: 0,
    }), null);
    assert.equal(parseRenameWorktreeGroupRequest({
        ...validRequest(), baseRevision: '3',
    }), null);
    const withoutRevision = validRequest();
    delete withoutRevision.baseRevision;
    assert.equal(parseRenameWorktreeGroupRequest(withoutRevision), null);
});

test('WORKTREE-GROUPS-RENAME-001 settlements correlate by requestId and groupId', () => {
    const request = parseRenameWorktreeGroupRequest(validRequest());
    assert.deepEqual(acceptedWorktreeGroupRenameSettlement(request), {
        type: 'worktree-group-rename-settlement',
        version: 1,
        requestId: 'group-rename-1',
        projectId: '/repo/main',
        groupId: 'abc123',
        status: 'accepted',
    });
    assert.deepEqual(settledWorktreeGroupRenameSettlement(request, { kind: 'settled' }), {
        type: 'worktree-group-rename-settlement',
        version: 1,
        requestId: 'group-rename-1',
        projectId: '/repo/main',
        groupId: 'abc123',
        status: 'settled',
    });
    assert.deepEqual(
        settledWorktreeGroupRenameSettlement(
            request, { kind: 'failed', errorCode: 'group-not-found' }),
        {
            type: 'worktree-group-rename-settlement',
            version: 1,
            requestId: 'group-rename-1',
            projectId: '/repo/main',
            groupId: 'abc123',
            status: 'failed',
            errorCode: 'group-not-found',
        });
});
