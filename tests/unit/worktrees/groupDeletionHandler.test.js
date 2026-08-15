'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorktreeGroupManifestStore,
} = require('../../../out/worktrees/groupManifestStore');
const {
    WorktreeDeletionController,
} = require('../../../out/worktrees/deletionController');
const {
    handleAbandonWorktreeGroupDeletion,
    handleDeleteWorktreeGroupMember,
    handleDiscardWorktreeGenerationClaim,
    handlePreviewWorktreeGroupDeletion,
    handleRetryWorktreeGroupDeletion,
} = require('../../../out/worktrees/groupDeletionHandler');
const {
    createSettlementReplayCache,
} = require('../../../out/worktrees/settlementReplayCache');

const WORKSPACE = 'workspace-nav-id';

function memento() {
    const values = new Map();
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

async function fixture(options) {
    const opts = options || {};
    const store = new WorktreeGroupManifestStore(memento());
    const group = await store.createGroup(WORKSPACE, {
        displayName: 'fix login',
        suggestedSlug: 'fix-login',
        members: [readyMember('alpha', 'fix-login'), readyMember('beta', 'fix-login-2')],
    });
    const removed = [];
    const blockers = opts.blockers || new Map();
    const failRemove = opts.failRemove || new Set();
    const controller = new WorktreeDeletionController({
        store,
        recheckBlocker: async (_group, member) => blockers.get(member.memberId) || null,
        snapshotAffectedSessions: async (_group, member) =>
            (opts.sessions && opts.sessions.get(member.memberId)) || [],
        removeWorktree: async target => {
            if (failRemove.has(target.memberId)) {
                return { kind: 'failed', errorCode: 'worktree-remove-failed' };
            }
            removed.push(target.memberId);
            return { kind: 'removed' };
        },
        observeWorktree: async () => 'unknown',
        nowMs: () => 1000,
    });
    const posted = [];
    let refreshes = 0;
    const deps = {
        postMessage: async message => { posted.push(message); },
        getNavigationIdentity: () => WORKSPACE,
        store,
        controller,
        probeMemberBlocker: async (_identity, groupId, memberId) => {
            const found = store.listGroups(WORKSPACE)
                .find(candidate => candidate.groupId === groupId)
                ?.members.find(candidate => candidate.memberId === memberId);
            return found ? blockers.get(memberId) || null : 'member-not-found';
        },
        countMemberHistorySessions: async (_identity, _groupId, memberId) =>
            ((opts.sessions && opts.sessions.get(memberId)) || []).length,
        getRepositoryLabel: repositoryKey =>
            repositoryKey.split('/').filter(Boolean)[1] || 'repository',
        refreshNow: async () => { refreshes += 1; },
        logError: () => undefined,
        replayCache: createSettlementReplayCache(),
    };
    return { store, group, controller, deps, posted, removed, refreshes: () => refreshes };
}

function previewRequest(group, member, overrides) {
    return {
        type: 'preview-worktree-group-deletion',
        version: 1,
        requestId: 'group-delete-preview-n1-1',
        projectId: '/repo/main',
        groupId: group.groupId,
        mode: 'member',
        memberId: member.memberId,
        ...(overrides || {}),
    };
}

function deleteRequest(group, member, overrides) {
    return {
        type: 'delete-worktree-group-member',
        version: 1,
        requestId: 'group-delete-n1-1',
        projectId: '/repo/main',
        groupId: group.groupId,
        memberId: member.memberId,
        baseRevision: group.revision,
        ...(overrides || {}),
    };
}

test('WORKTREE-GROUPS-MEMBER-DELETE-001 preview reports blockers, history counts, and primary candidates', async () => {
    const sessions = new Map();
    const { store, group, deps, posted } = await fixture({ sessions });
    const primary = group.members.find(member => member.memberId === group.primaryMemberId);
    sessions.set(primary.memberId, [{ provider: 'codex', sessionId: 's1' }]);
    await handlePreviewWorktreeGroupDeletion(previewRequest(group, primary), deps);
    const preview = posted.find(message =>
        message.type === 'worktree-group-deletion-preview');
    assert.equal(preview.status, 'ready');
    assert.equal(preview.member.memberId, primary.memberId);
    assert.equal(preview.member.blocker, null);
    assert.equal(preview.member.historyCount, 1);
    assert.equal(preview.member.isPrimary, true);
    assert.equal(preview.replacementRequired, true);
    assert.equal(preview.replacementCandidates.length, 1);
    assert.equal(preview.groupRevision, group.revision);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 delete executes the journaled flow and settles once', async () => {
    const { store, group, deps, posted, removed } = await fixture();
    const target = group.members[0];
    await handleDeleteWorktreeGroupMember(deleteRequest(group, target), deps);
    const statuses = posted
        .filter(message => message.type === 'worktree-group-deletion-settlement')
        .map(message => message.status);
    assert.deepEqual(statuses, ['accepted', 'settled']);
    const settled = posted[posted.length - 1];
    assert.equal(typeof settled.minimumAggregateRevision, 'number');
    assert.deepEqual(removed, [target.memberId]);
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.length, 1);
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 1);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 a stale card revision fails closed with zero side effects', async () => {
    const { store, group, deps, posted, removed } = await fixture();
    await handleDeleteWorktreeGroupMember(
        deleteRequest(group, group.members[0], { baseRevision: group.revision + 9 }), deps);
    const settled = posted[posted.length - 1];
    assert.equal(settled.status, 'failed');
    assert.equal(settled.errorCode, 'group-changed');
    assert.equal(removed.length, 0);
    assert.equal(store.listGroups(WORKSPACE)[0].members.length, 2);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 admission blockers reject before any side effect', async () => {
    const blockers = new Map();
    const { store, group, deps, posted, removed } = await fixture({ blockers });
    blockers.set(group.members[0].memberId, 'worktree-active');
    await handleDeleteWorktreeGroupMember(deleteRequest(group, group.members[0]), deps);
    const settled = posted[posted.length - 1];
    assert.equal(settled.status, 'failed');
    assert.equal(settled.errorCode, 'worktree-active');
    assert.equal(removed.length, 0);
    assert.equal(store.listGroups(WORKSPACE)[0].members[0].state, 'ready');
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 partial execution settles partial and Retry completes it', async () => {
    const failRemove = new Set();
    const { store, group, deps, posted } = await fixture({ failRemove });
    const target = group.members[0];
    failRemove.add(target.memberId);
    await handleDeleteWorktreeGroupMember(deleteRequest(group, target), deps);
    let settled = posted[posted.length - 1];
    assert.equal(settled.status, 'partial');
    const journal = store.listDeletionJournals(WORKSPACE)[0];
    assert.ok(journal);
    assert.equal(journal.targets[0].status, 'failed');
    // Retry through the protocol reopens the same operation.
    failRemove.delete(target.memberId);
    await handleRetryWorktreeGroupDeletion({
        type: 'retry-worktree-group-deletion',
        version: 1,
        requestId: 'group-delete-retry-n1-1',
        projectId: '/repo/main',
        groupId: group.groupId,
        operationId: journal.operationId,
    }, deps);
    settled = posted[posted.length - 1];
    assert.equal(settled.status, 'settled');
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    assert.equal(store.listGroups(WORKSPACE)[0].members.length, 1);
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 abandon keeps the remaining member and archives the operation', async () => {
    const failRemove = new Set();
    const { store, group, deps, posted } = await fixture({ failRemove });
    const target = group.members[0];
    failRemove.add(target.memberId);
    await handleDeleteWorktreeGroupMember(deleteRequest(group, target), deps);
    const journal = store.listDeletionJournals(WORKSPACE)[0];
    await handleAbandonWorktreeGroupDeletion({
        type: 'abandon-worktree-group-deletion',
        version: 1,
        requestId: 'group-delete-abandon-n1-1',
        projectId: '/repo/main',
        groupId: group.groupId,
        operationId: journal.operationId,
    }, deps);
    const settled = posted[posted.length - 1];
    assert.equal(settled.status, 'settled');
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.length, 2);
    assert.equal(listed[0].members[0].state, 'ready');
    assert.equal(listed[0].members[0].lastError, undefined);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    assert.equal(store.listDeletionHistory(WORKSPACE)[0].outcome, 'abandoned');
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 replays re-receive the recorded settlement without re-executing', async () => {
    const { store, group, deps, posted, removed } = await fixture();
    const request = deleteRequest(group, group.members[0]);
    await handleDeleteWorktreeGroupMember(request, deps);
    const revisionAfterFirst = store.getAggregateRevision(WORKSPACE);
    await handleDeleteWorktreeGroupMember(request, deps);
    const settlements = posted.filter(message =>
        message.type === 'worktree-group-deletion-settlement'
        && message.status !== 'accepted');
    assert.equal(settlements.length, 2);
    assert.equal(settlements[0].status, 'settled');
    assert.equal(settlements[1].status, 'settled');
    assert.deepEqual(removed, [group.members[0].memberId]);
    assert.equal(store.getAggregateRevision(WORKSPACE), revisionAfterFirst);
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 an orphan claim blocks until explicitly discarded', async () => {
    const { store, group, deps, posted } = await fixture();
    const target = group.members[0];
    // Simulate a previous deletion + a pending session claim on the path.
    const first = await store.beginDeletion(WORKSPACE, {
        groupId: group.groupId, mode: 'member', memberIds: [target.memberId], nowMs: 100,
    });
    await store.checkpointDeletedMember(WORKSPACE, first.operationId, target.memberId, 110);
    const retired = store.listRetiredIdentities(WORKSPACE)[0];
    const claim = await store.createGenerationClaim(WORKSPACE, {
        pendingId: 'pending-1',
        worktreeKey: target.worktreeKey,
        createdAfterRetirementId: retired.retirementId,
        createdAtMs: 200,
        creatingProvider: 'codex',
    });
    await store.addMember(WORKSPACE, group.groupId, {
        repositoryKey: target.repositoryKey,
        worktreeKey: target.worktreeKey,
        branchName: target.branchName,
        path: target.path,
        state: 'ready',
    });
    const rebuilt = store.listGroups(WORKSPACE)[0].members
        .find(member => member.memberId !== group.members[1].memberId);
    const previewPosted = [];
    await handlePreviewWorktreeGroupDeletion(
        previewRequest(group, rebuilt, { requestId: 'group-delete-preview-n1-2' }),
        { ...deps, postMessage: async message => { previewPosted.push(message); } });
    const preview = previewPosted[0];
    assert.equal(preview.status, 'ready');
    assert.equal(preview.blockingClaims.length, 1);
    await handleDeleteWorktreeGroupMember(deleteRequest(
        store.listGroups(WORKSPACE)[0], rebuilt,
        { requestId: 'group-delete-n1-2' }), deps);
    let settled = posted[posted.length - 1];
    assert.equal(settled.status, 'failed');
    assert.equal(settled.errorCode, 'deletion-blocked');
    // The explicit discard releases the claim; the deletion then succeeds.
    await handleDiscardWorktreeGenerationClaim({
        type: 'discard-worktree-generation-claim',
        version: 1,
        requestId: 'group-claim-discard-n1-1',
        projectId: '/repo/main',
        groupId: group.groupId,
        claimId: claim.claimId,
    }, deps);
    settled = posted[posted.length - 1];
    assert.equal(settled.status, 'settled');
    assert.equal(store.listGenerationClaims(WORKSPACE).length, 0);
    const current = store.listGroups(WORKSPACE)[0];
    await handleDeleteWorktreeGroupMember(deleteRequest(
        current, rebuilt, { requestId: 'group-delete-n1-3' }), deps);
    settled = posted[posted.length - 1];
    assert.equal(settled.status, 'settled');
});

test('WORKTREE-GROUPS-MEMBER-DELETE-001 malformed messages are ignored without side effects', async () => {
    const { store, group, deps, posted } = await fixture();
    await handleDeleteWorktreeGroupMember({ type: 'delete-worktree-group-member' }, deps);
    await handlePreviewWorktreeGroupDeletion(null, deps);
    await handleRetryWorktreeGroupDeletion({ type: 'retry-worktree-group-deletion' }, deps);
    await handleAbandonWorktreeGroupDeletion(undefined, deps);
    await handleDiscardWorktreeGenerationClaim(42, deps);
    assert.equal(posted.length, 0);
    assert.equal(store.listGroups(WORKSPACE)[0].members.length, 2);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
});
