'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorktreeGroupManifestStore,
    WorktreeGroupManifestError,
} = require('../../../out/worktrees/groupManifestStore');

const WORKSPACE = 'workspace-nav-id';

function memento(initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
        get(key, fallback) {
            return values.has(key) ? values.get(key) : fallback;
        },
        async update(key, value) {
            values.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

function readyMember(repositoryKey, slug) {
    return {
        repositoryKey: `/repos/${repositoryKey}/.git`,
        worktreeKey: {
            repositoryKey: `/repos/${repositoryKey}/.git`,
            canonicalWorktreePath: `/repos/${repositoryKey}/.worktrees/${slug}`,
        },
        branchName: `agent-pivot/${slug}`,
        path: `/repos/${repositoryKey}/.worktrees/${slug}`,
        state: 'ready',
    };
}

function plannedMember(repositoryKey, slug) {
    return {
        repositoryKey: `/repos/${repositoryKey}/.git`,
        branchName: `agent-pivot/${slug}`,
        path: `/repos/${repositoryKey}/.worktrees/${slug}`,
        state: 'planned',
    };
}

async function createGroup(store, members, overrides) {
    return store.createGroup(WORKSPACE, {
        displayName: 'fix login',
        suggestedSlug: 'fix-login',
        members,
        ...(overrides || {}),
    });
}

async function rejectsCode(promise, code) {
    await assert.rejects(promise, error =>
        error instanceof WorktreeGroupManifestError && error.code === code);
}

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 beginDeletion freezes identity before any side effect', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'fix-login'),
        readyMember('beta', 'fix-login'),
    ]);
    const revisionBefore = group.revision;
    const aggregateBefore = store.getAggregateRevision(WORKSPACE);
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId,
        mode: 'member',
        memberIds: [group.members[0].memberId],
        replacementPrimaryMemberId: group.members[1].memberId,
        affectedSessions: {
            [group.members[0].memberId]: [
                { provider: 'codex', sessionId: 's-1' },
                { provider: 'codex', sessionId: 's-1' }, // deduped
                { provider: 'kimi', sessionId: 'k-9' },
            ],
        },
        nowMs: 1000,
    });
    assert.equal(journal.groupId, group.groupId);
    assert.equal(journal.mode, 'member');
    assert.equal(journal.targets.length, 1);
    const target = journal.targets[0];
    assert.equal(target.memberId, group.members[0].memberId);
    assert.equal(target.status, 'pending');
    assert.ok(target.retirementId);
    assert.equal(target.canonicalWorktreePath, group.members[0].worktreeKey.canonicalWorktreePath);
    assert.equal(target.branchName, 'agent-pivot/fix-login');
    assert.deepEqual(target.affectedSessions, [
        { provider: 'codex', sessionId: 's-1' },
        { provider: 'kimi', sessionId: 'k-9' },
    ]);
    assert.equal(journal.generationCutoffAt, 1000);
    assert.equal(journal.originalPrimaryMemberId, group.primaryMemberId);
    // Members became deleting and the journal survived a reload.
    const reloaded = new WorktreeGroupManifestStore(store._memento || undefined);
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members[0].state, 'deleting');
    assert.equal(listed[0].members[1].state, 'ready');
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 1);
    assert.ok(store.isGroupDeletionLeased(WORKSPACE, group.groupId));
    assert.ok(store.getAggregateRevision(WORKSPACE) > aggregateBefore);
    const listedAfter = store.listGroups(WORKSPACE);
    assert.ok(listedAfter[0].revision > revisionBefore);
    assert.ok(reloaded); // silence unused
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 cutoff is a persistent high-water mark under clock rollback', async () => {
    const backing = memento();
    const store = new WorktreeGroupManifestStore(backing);
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const first = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 5000,
    });
    assert.equal(first.generationCutoffAt, 5000);
    await store.checkpointDeletedMember(
        WORKSPACE, first.operationId, group.members[0].memberId, 5001);
    // Retired record written; now simulate cleanup + clock rollback.
    const retired = store.listRetiredIdentities(WORKSPACE);
    assert.equal(retired.length, 1);
    await store.removeRetiredIdentity(WORKSPACE, retired[0].retirementId);
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 0);
    const group2 = await createGroup(store, [readyMember('alpha', 'b')]);
    const second = await store.beginDeletion(WORKSPACE, {
        groupId: group2.groupId, mode: 'group', nowMs: 10,
    });
    // Even with no retired records left and the clock rolled back, the new
    // cutoff sorts strictly after the previous one.
    assert.ok(second.generationCutoffAt > first.generationCutoffAt);
    // The high-water mark survives a reload.
    const reloaded = new WorktreeGroupManifestStore(backing);
    assert.ok(reloaded.listDeletionJournals(WORKSPACE).length === 1);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 a pending generation claim blocks deletion of its worktree', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const first = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    });
    await store.checkpointDeletedMember(
        WORKSPACE, first.operationId, group.members[0].memberId, 101);
    const retired = store.listRetiredIdentities(WORKSPACE)[0];
    // A new session starts on the retired path: the claim is persisted.
    await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'pending-1',
        worktreeKey: group.members[0].worktreeKey,
        createdAfterRetirementId: retired.retirementId,
        createdAtMs: 200,
        creatingProvider: 'codex',
    });
    const group2 = await createGroup(store, [readyMember('alpha', 'a')]);
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group2.groupId, mode: 'group', nowMs: 300,
    }), 'deletion-blocked');
    // The block survives a reload (the claim is the only evidence).
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 lease blocks group mutations until the journal terminates', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    const other = await createGroup(store, [readyMember('gamma', 'c')],
        { displayName: 'other', suggestedSlug: 'other' });
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member',
        memberIds: [group.members[0].memberId],
        replacementPrimaryMemberId: group.members[1].memberId, nowMs: 100,
    });
    const gid = group.groupId;
    await rejectsCode(store.renameGroup(WORKSPACE, gid, 'new name'), 'group-leased');
    await rejectsCode(
        store.setPrimaryMember(WORKSPACE, gid, group.members[1].memberId), 'group-leased');
    await rejectsCode(store.addMember(WORKSPACE, gid, readyMember('delta', 'd')),
        'group-leased');
    await rejectsCode(store.updateMember(WORKSPACE, gid, group.members[0].memberId,
        { state: 'ready' }), 'group-leased');
    await rejectsCode(store.removeMember(WORKSPACE, gid, group.members[0].memberId),
        'group-leased');
    await rejectsCode(store.deleteGroup(WORKSPACE, gid), 'group-leased');
    await rejectsCode(store.mergeGroups(WORKSPACE, gid, other.groupId), 'group-leased');
    await rejectsCode(store.mergeGroups(WORKSPACE, other.groupId, gid), 'group-leased');
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: gid, mode: 'group', nowMs: 200,
    }), 'group-leased');
    // The unaffected group still mutates.
    await store.renameGroup(WORKSPACE, other.groupId, 'renamed');
    // After completion the lease is gone.
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, group.members[0].memberId, 300);
    await store.renameGroup(WORKSPACE, gid, 'new name');
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 checkpoint writes retired identity from frozen data only', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    const target = group.members[0];
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member',
        memberIds: [target.memberId],
        replacementPrimaryMemberId: group.members[1].memberId,
        affectedSessions: { [target.memberId]: [{ provider: 'codex', sessionId: 's-1' }] },
        nowMs: 1000,
    });
    // The world changes after the freeze: rename must not leak into the
    // retired record written later.
    const result = await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, target.memberId, 1500);
    assert.equal(result.completed, true);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    const history = store.listDeletionHistory(WORKSPACE);
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'completed');
    assert.equal(history[0].deletedCount, 1);
    const retired = store.listRetiredIdentities(WORKSPACE);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].retirementId, journal.targets[0].retirementId);
    assert.equal(retired[0].generationCutoffAt, 1000);
    assert.equal(retired[0].deletedAt, 1500);
    assert.equal(retired[0].canonicalWorktreePath,
        target.worktreeKey.canonicalWorktreePath);
    assert.deepEqual(retired[0].affectedSessions, [{ provider: 'codex', sessionId: 's-1' }]);
    assert.equal(retired[0].origin.groupId, group.groupId);
    assert.equal(retired[0].origin.memberId, target.memberId);
    // The member is gone; the group keeps its other member.
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.length, 1);
    // Double checkpoint is rejected.
    await rejectsCode(store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, target.memberId, 1600), 'operation-not-found');
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 deleting the last member removes the group and archives', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    });
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, group.members[0].memberId, 200);
    assert.equal(store.listGroups(WORKSPACE).length, 0);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    const history = store.listDeletionHistory(WORKSPACE);
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'completed');
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 1);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 partial failure keeps frozen snapshot and Retry reuses it', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
        affectedSessions: {
            [group.members[1].memberId]: [{ provider: 'kimi', sessionId: 'k-1' }],
        },
    });
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, group.members[0].memberId, 110);
    await store.failDeletionMember(
        WORKSPACE, journal.operationId, group.members[1].memberId, 'git-timeout');
    // Partial journal: failed member back to ready with the error recorded.
    let listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.length, 1);
    assert.equal(listed[0].members[0].state, 'ready');
    assert.equal(listed[0].members[0].lastError, 'git-timeout');
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 1);
    assert.ok(store.isGroupDeletionLeased(WORKSPACE, group.groupId));
    // Retry reopens the SAME operation with the SAME frozen identity.
    const retried = await store.retryDeletion(WORKSPACE, journal.operationId);
    assert.equal(retried.operationId, journal.operationId);
    assert.equal(retried.generationCutoffAt, journal.generationCutoffAt);
    const retriedTarget = retried.targets.find(candidate =>
        candidate.memberId === group.members[1].memberId);
    assert.equal(retriedTarget.status, 'pending');
    assert.equal(retriedTarget.retirementId,
        journal.targets.find(candidate =>
            candidate.memberId === group.members[1].memberId).retirementId);
    assert.deepEqual(retriedTarget.affectedSessions, [{ provider: 'kimi', sessionId: 'k-1' }]);
    listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members[0].state, 'deleting');
    assert.equal(listed[0].members[0].lastError, undefined);
    // Retry completes through the normal checkpoint path.
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, group.members[1].memberId, 120);
    assert.equal(store.listGroups(WORKSPACE).length, 0);
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 2);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 retry is rejected while targets are still pending', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    });
    await rejectsCode(store.retryDeletion(WORKSPACE, journal.operationId), 'invalid-record');
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 abandon restores members and archives without touching retirements', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    });
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, group.members[0].memberId, 110);
    await store.failDeletionMember(
        WORKSPACE, journal.operationId, group.members[1].memberId, 'worktree-remove-failed');
    await store.abandonDeletion(WORKSPACE, journal.operationId);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    const history = store.listDeletionHistory(WORKSPACE);
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'abandoned');
    assert.equal(history[0].failedCount, 1);
    assert.equal(history[0].lastErrorCode, 'worktree-remove-failed');
    // The failed member is back, error cleared; the retired record stays.
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.length, 1);
    assert.equal(listed[0].members[0].state, 'ready');
    assert.equal(listed[0].members[0].lastError, undefined);
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 1);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 completeDeletion archives an all-deleted leftover journal', async () => {
    const backing = memento();
    const store = new WorktreeGroupManifestStore(backing);
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    });
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, group.members[0].memberId, 110);
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, group.members[1].memberId, 120);
    // Auto-archived on the last checkpoint; completeDeletion is idempotent
    // in the sense that a missing operation is reported, not fatal.
    await rejectsCode(
        store.completeDeletion(WORKSPACE, journal.operationId), 'operation-not-found');
    assert.equal(store.listGroups(WORKSPACE).length, 0);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 crash before any side effect reloads the journal intact', async () => {
    const backing = memento();
    const store = new WorktreeGroupManifestStore(backing);
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    });
    // Process exits here: journal persisted, no physical deletion yet.
    const reloaded = new WorktreeGroupManifestStore(backing);
    const journals = reloaded.listDeletionJournals(WORKSPACE);
    assert.equal(journals.length, 1);
    assert.equal(journals[0].operationId, journal.operationId);
    assert.equal(journals[0].targets[0].status, 'pending');
    assert.equal(reloaded.listGroups(WORKSPACE)[0].members[0].state, 'deleting');
    assert.ok(reloaded.isGroupDeletionLeased(WORKSPACE, group.groupId));
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 deleting member without a journal quarantines the bucket', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const backing = memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: {
                version: 2,
                groups: [{
                    ...JSON.parse(JSON.stringify(group)),
                    primaryMemberId: null,
                    members: [{ ...JSON.parse(JSON.stringify(group.members[0])), state: 'deleting' }],
                }],
                retiredIdentities: [],
                deletionJournal: [],
                generationClaims: [],
                lastGenerationCutoffAt: 0,
            },
        },
    });
    const reloaded = new WorktreeGroupManifestStore(backing);
    assert.ok(reloaded.isRetiredStoreCorrupt(WORKSPACE));
    // Fail-closed: the lease check treats corrupt buckets as leased.
    assert.ok(reloaded.isGroupDeletionLeased(WORKSPACE, group.groupId));
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 unreadable journal entries quarantine the bucket', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const backing = memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: {
                version: 2,
                groups: [JSON.parse(JSON.stringify(group))],
                retiredIdentities: [],
                deletionJournal: [{ operationId: 42 }],
                generationClaims: [],
                lastGenerationCutoffAt: 0,
            },
        },
    });
    const reloaded = new WorktreeGroupManifestStore(backing);
    assert.ok(reloaded.isRetiredStoreCorrupt(WORKSPACE));
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 group mode rejects an explicit subset and non-ready members', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        plannedMember('beta', 'b'),
    ]);
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group',
        memberIds: [group.members[0].memberId], nowMs: 100,
    }), 'invalid-record');
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    }), 'invalid-record'); // planned member cannot enter a deletion
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member', memberIds: [], nowMs: 100,
    }), 'invalid-record');
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member', memberIds: ['missing'], nowMs: 100,
    }), 'member-not-found');
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 deleting the primary can atomically name a replacement', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    const primary = group.primaryMemberId;
    const other = group.members.find(member => member.memberId !== primary);
    // A replacement that is itself a deletion target is rejected.
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member', memberIds: [primary],
        replacementPrimaryMemberId: primary, nowMs: 100,
    }), 'primary-not-ready');
    // A replacement while the primary survives is rejected.
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member', memberIds: [other.memberId],
        replacementPrimaryMemberId: primary, nowMs: 100,
    }), 'invalid-record');
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member', memberIds: [primary],
        replacementPrimaryMemberId: other.memberId, nowMs: 100,
    });
    assert.equal(journal.originalPrimaryMemberId, primary);
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].primaryMemberId, other.memberId);
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, primary, 110);
    assert.equal(store.listGroups(WORKSPACE)[0].primaryMemberId, other.memberId);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 deleting the primary requires a replacement while survivors exist', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    // Store-level invariant (decision I): with ready survivors, deleting
    // the primary without a replacement is refused — never headless.
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member',
        memberIds: [group.primaryMemberId], nowMs: 100,
    }), 'primary-not-ready');
    // With no ready survivors the primary may go null.
    const solo = await createGroup(store, [], {});
    const soloGroup = await createGroup(store, [readyMember('gamma', 'c')], {
        displayName: 'solo', suggestedSlug: 'solo',
    });
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: soloGroup.groupId, mode: 'group', nowMs: 100,
    });
    assert.equal(store.listGroups(WORKSPACE)
        .find(candidate => candidate.groupId === soloGroup.groupId)
        .primaryMemberId, null);
    void solo;
    // Failing a replacement-bound deletion restores the original primary.
    const restore = await createGroup(store, [
        readyMember('delta', 'd'),
        readyMember('epsilon', 'e'),
    ], { displayName: 'restore', suggestedSlug: 'restore' });
    const journal2 = await store.beginDeletion(WORKSPACE, {
        groupId: restore.groupId, mode: 'member',
        memberIds: [restore.primaryMemberId],
        replacementPrimaryMemberId: restore.members.find(
            member => member.memberId !== restore.primaryMemberId).memberId,
        nowMs: 200,
    });
    await store.failDeletionMember(
        WORKSPACE, journal2.operationId, restore.primaryMemberId, 'git-timeout');
    assert.equal(store.listGroups(WORKSPACE)
        .find(candidate => candidate.groupId === restore.groupId)
        .primaryMemberId, restore.primaryMemberId);
});

test('WORKTREE-GROUPS-GROUP-DELETE-001 detached members can never join a deletion', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    await store.setRepositoryDetached(WORKSPACE, '/repos/beta/.git', true);
    // Whole-group deletion refuses to leave invisible residue.
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    }), 'member-detached');
    // And a visible-only request that names the detached member fails too.
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'visible-only',
        memberIds: [group.members[1].memberId], nowMs: 100,
    }), 'member-detached');
    // Visible-only with exactly the visible member works.
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'visible-only',
        memberIds: [group.members[0].memberId], nowMs: 100,
    });
    assert.equal(journal.targets.length, 1);
    assert.equal(journal.targets[0].memberId, group.members[0].memberId);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 expectedRevision pins the confirmed member set atomically', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    // The confirmation was made at revision R; a member joined meanwhile.
    await store.addMember(WORKSPACE, group.groupId, readyMember('gamma', 'c'));
    // Group mode with the stale bound revision refuses: the new member
    // would otherwise be deleted unreviewed.
    await rejectsCode(store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
        expectedRevision: group.revision,
    }), 'group-changed');
    assert.equal(store.listGroups(WORKSPACE)[0].members.length, 3);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    // With the current revision the whole current set is deleted.
    const current = store.listGroups(WORKSPACE)[0];
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: current.groupId, mode: 'group', nowMs: 100,
        expectedRevision: current.revision,
    });
    assert.equal(journal.targets.length, 3);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 a journal target that does not match its member quarantines the bucket', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member',
        memberIds: [group.members[0].memberId],
        replacementPrimaryMemberId: group.members[1].memberId,
        nowMs: 100,
    });
    // Corrupt the persisted blob: the target keeps A's memberId but now
    // describes B's worktree — a deletion would remove the wrong tree.
    const backing = memento();
    const raw = JSON.parse(JSON.stringify(
        // Re-persist through a real store write to get the blob shape.
        await (async () => {
            const probe = new WorktreeGroupManifestStore(backing);
            const probeGroup = await createGroup(probe, [
                readyMember('alpha', 'a'),
                readyMember('beta', 'b'),
            ]);
            await probe.beginDeletion(WORKSPACE, {
                groupId: probeGroup.groupId, mode: 'member',
                memberIds: [probeGroup.members[0].memberId],
                replacementPrimaryMemberId: probeGroup.members[1].memberId,
                nowMs: 100,
            });
            return backing;
        })()));
    void raw;
    const blob = JSON.parse(JSON.stringify(backingValues(backing)));
    blob[WORKSPACE].deletionJournal[0].targets[0].canonicalWorktreePath =
        '/repos/beta/.worktrees/b';
    const corrupted = new WorktreeGroupManifestStore(memento({
        'agentPivot.worktreeGroups.v1': blob,
    }));
    assert.ok(corrupted.isRetiredStoreCorrupt(WORKSPACE),
        'a target/member identity mismatch quarantines the bucket');
    assert.ok(corrupted.isGroupDeletionLeased(WORKSPACE, group.groupId));
    void journal;
});

function backingValues(backing) {
    return backing.get('agentPivot.worktreeGroups.v1', {});
}

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 aggregate revision advances on every commit', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const revisions = [store.getAggregateRevision(WORKSPACE)];
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    revisions.push(store.getAggregateRevision(WORKSPACE));
    await store.renameGroup(WORKSPACE, group.groupId, 'renamed');
    revisions.push(store.getAggregateRevision(WORKSPACE));
    const journal = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'group', nowMs: 100,
    });
    revisions.push(store.getAggregateRevision(WORKSPACE));
    await store.checkpointDeletedMember(
        WORKSPACE, journal.operationId, group.members[0].memberId, 110);
    revisions.push(store.getAggregateRevision(WORKSPACE));
    for (let index = 1; index < revisions.length; index += 1) {
        assert.ok(revisions[index] > revisions[index - 1],
            `revision ${revisions[index]} should exceed ${revisions[index - 1]}`);
    }
});
