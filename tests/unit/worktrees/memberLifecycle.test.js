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


// ── review R5: atomic transition concurrency matrix ──────────────────

test('ARCH-WORKTREE-MEMBER-WRITER-001 racing readmit and dismiss: exactly one wins (review repro)', async () => {
    const { store, lifecycle, groupId, memberId } = await fixture();
    await lifecycle.markMemberFailed(WORKSPACE, groupId, memberId, 'setup-failed');

    // The review's reproduction: failed -> provisioning racing
    // failed -> removed must not both succeed.
    const outcomes = await Promise.allSettled([
        lifecycle.readmitMemberForRetry(WORKSPACE, groupId, memberId),
        lifecycle.removeFailedMember(WORKSPACE, groupId, memberId),
    ]);
    const succeeded = outcomes.filter(outcome => outcome.status === 'fulfilled');
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
    assert.equal(succeeded.length, 1, JSON.stringify(outcomes));
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0].reason), /illegal-member-transition|expected one of/);

    const state = memberState(store, groupId, memberId);
    if (state === undefined) {
        // Dismiss won: the member (and the group) is gone, consistently.
        assert.equal(store.listGroups(WORKSPACE).length, 0);
    } else {
        // Readmit won: the member is provisioning and still present.
        assert.equal(state, 'provisioning');
    }
});

test('ARCH-WORKTREE-MEMBER-WRITER-001 duplicate readmits: the second one fails closed', async () => {
    const { store, lifecycle, groupId, memberId } = await fixture();
    await lifecycle.markMemberFailed(WORKSPACE, groupId, memberId, 'setup-failed');

    const outcomes = await Promise.allSettled([
        lifecycle.readmitMemberForRetry(WORKSPACE, groupId, memberId),
        lifecycle.readmitMemberForRetry(WORKSPACE, groupId, memberId),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
    assert.equal(memberState(store, groupId, memberId), 'provisioning');
});

test('ARCH-WORKTREE-MEMBER-WRITER-001 a live finalize always wins the demotion race', async () => {
    const { store, lifecycle, groupId, memberId } = await fixture();
    const key = { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/.worktrees/fix-login' };

    // mark-ready accepts provisioning|failed, demotion accepts
    // provisioning|planned. Whichever order the queue serializes, the
    // finalize always lands: demote-then-finalize means failed is a legal
    // pre-state for the finalize; finalize-then-demote means the demotion
    // correctly fails closed (a ready member cannot demote).
    const outcomes = await Promise.allSettled([
        lifecycle.markMemberReady(WORKSPACE, groupId, memberId, key),
        lifecycle.demoteInterruptedMember(WORKSPACE, groupId, memberId),
    ]);
    assert.equal(outcomes[0].status, 'fulfilled', 'the finalize always lands');
    if (outcomes[1].status === 'rejected') {
        assert.match(String(outcomes[1].reason), /illegal-member-transition|expected one of/);
    }
    assert.equal(memberState(store, groupId, memberId), 'ready');
});

test('ARCH-WORKTREE-MEMBER-WRITER-001 settlement rewrite always wins against demotion', async () => {
    const { store, lifecycle, groupId, memberId } = await fixture();

    // mark-failed accepts provisioning|planned|failed, demotion accepts
    // provisioning|planned. Either the settlement lands after the demotion
    // (failed is legal) or before it (the demotion then fails closed) — in
    // both serializations the settlement's outcome is the recorded one.
    const outcomes = await Promise.allSettled([
        lifecycle.markMemberFailed(WORKSPACE, groupId, memberId, 'setup-failed'),
        lifecycle.demoteInterruptedMember(WORKSPACE, groupId, memberId),
    ]);
    assert.equal(outcomes[0].status, 'fulfilled', 'the settlement always lands');
    if (outcomes[1].status === 'rejected') {
        assert.match(String(outcomes[1].reason), /illegal-member-transition|expected one of/);
    }
    const member = store.listGroups(WORKSPACE)[0].members
        .find(candidate => candidate.memberId === memberId);
    assert.equal(member.state, 'failed');
    assert.equal(member.lastError, 'setup-failed');
});

test('ARCH-WORKTREE-MEMBER-WRITER-001 dismiss racing finalize rejects the inconsistent one', async () => {
    const { store, lifecycle, groupId, memberId } = await fixture();
    await lifecycle.markMemberFailed(WORKSPACE, groupId, memberId, 'setup-failed');
    const key = { repositoryKey: '/alpha/.git', canonicalWorktreePath: '/alpha/.worktrees/fix-login' };

    // failed -> removed races failed -> ready (finalize accepts failed).
    const outcomes = await Promise.allSettled([
        lifecycle.removeFailedMember(WORKSPACE, groupId, memberId),
        lifecycle.markMemberReady(WORKSPACE, groupId, memberId, key),
    ]);
    const succeeded = outcomes.filter(outcome => outcome.status === 'fulfilled').length;
    assert.equal(succeeded, 1, JSON.stringify(outcomes));
    const state = memberState(store, groupId, memberId);
    assert.ok(state === undefined || state === 'ready', `unexpected final state ${state}`);
});

test('ARCH-WORKTREE-MEMBER-WRITER-001 transitionMember rejects contradictory option combos', async () => {
    const { store, groupId, memberId } = await fixture();
    await assert.rejects(
        store.transitionMember(WORKSPACE, groupId, memberId, {
            expectedStates: ['ready'],
            transition: 'fixture',
            assignPrimary: true,
            patch: { state: 'ready' },
        }),
        /invalid-record/,
    );
    await assert.rejects(
        store.transitionMember(WORKSPACE, groupId, memberId, {
            expectedStates: ['ready'],
            transition: 'fixture',
            assignPrimary: true,
            remove: true,
        }),
        /invalid-record/,
    );
});
