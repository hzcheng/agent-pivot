'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeGroupManifestStore,
} = require('../../../out/worktrees/groupManifestStore');
const {
    WorktreeMemberLifecycle,
} = require('../../../out/worktrees/memberLifecycle');

const WORKSPACE = 'navigation:unit';

function memento() {
    const values = new Map();
    return {
        get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        update: async (key, value) => {
            values.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

async function fixture() {
    const store = new WorktreeGroupManifestStore(memento());
    const lifecycle = new WorktreeMemberLifecycle(store);
    const group = await store.createGroup(WORKSPACE, {
        displayName: 'Fix login',
        suggestedSlug: 'fix-login',
        members: [{
            repositoryKey: '/alpha/.git',
            branchName: 'agent-pivot/fix-login',
            path: '/alpha/.worktrees/fix-login',
            state: 'provisioning',
        }],
    });
    return { store, lifecycle, memberId: group.members[0].memberId, groupId: group.groupId };
}

function memberState(store, groupId, memberId) {
    return store.listGroups(WORKSPACE)[0]?.members
        .find(member => member.memberId === memberId)?.state;
}

test('ARCH-WORKTREE-MEMBER-WRITER-001 the legal transition table runs through the coordinator', async () => {
    const { store, lifecycle, groupId, memberId } = await fixture();
    const key = { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/.worktrees/fix-login' };

    await lifecycle.markMemberReady(WORKSPACE, groupId, memberId, key);
    assert.equal(memberState(store, groupId, memberId), 'ready');
    await lifecycle.assignPrimary(WORKSPACE, groupId, memberId);
    assert.equal(store.listGroups(WORKSPACE)[0].primaryMemberId, memberId);

    await lifecycle.removeMemberRecord(WORKSPACE, groupId, memberId);
    assert.equal(store.listGroups(WORKSPACE).length, 0,
        'removing the last member removes the group record');
});

test('ARCH-WORKTREE-MEMBER-WRITER-001 retry readmission and dismissal stay on the failed rail', async () => {
    const { store, lifecycle, groupId, memberId } = await fixture();
    await lifecycle.markMemberFailed(WORKSPACE, groupId, memberId, 'setup-failed');
    assert.equal(memberState(store, groupId, memberId), 'failed');

    await lifecycle.readmitMemberForRetry(WORKSPACE, groupId, memberId);
    assert.equal(memberState(store, groupId, memberId), 'provisioning');

    await lifecycle.markMemberFailed(WORKSPACE, groupId, memberId, 'setup-failed');
    await lifecycle.removeFailedMember(WORKSPACE, groupId, memberId);
    assert.equal(store.listGroups(WORKSPACE).length, 0);
});

test('ARCH-WORKTREE-MEMBER-WRITER-001 illegal transitions fail closed with a coded error', async () => {
    const { lifecycle, groupId, memberId } = await fixture();

    await assert.rejects(
        lifecycle.readmitMemberForRetry(WORKSPACE, groupId, memberId),
        /illegal-member-transition|expected one of/,
        'retry requires failed');
    await assert.rejects(
        lifecycle.removeFailedMember(WORKSPACE, groupId, memberId),
        /expected one of/,
        'dismiss requires failed');
    await assert.rejects(
        lifecycle.assignPrimary(WORKSPACE, groupId, memberId),
        /expected one of/,
        'primary requires ready');
    await assert.rejects(
        lifecycle.demoteInterruptedMember(WORKSPACE, groupId, memberId + '-missing'),
        /expected one of/,
        'demotion requires a known member');
});

test('ARCH-WORKTREE-MEMBER-WRITER-001 a live finalize still wins the demotion race', async () => {
    const { store, lifecycle, groupId, memberId } = await fixture();
    const key = { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/.worktrees/fix-login' };

    // Reconciliation demotes while the operation is still live…
    await lifecycle.demoteInterruptedMember(WORKSPACE, groupId, memberId);
    assert.equal(memberState(store, groupId, memberId), 'failed');
    // …and the live operation's own finalize still lands ready.
    await lifecycle.markMemberReady(WORKSPACE, groupId, memberId, key);
    assert.equal(memberState(store, groupId, memberId), 'ready');
});
