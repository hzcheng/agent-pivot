'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorktreeGroupManifestStore,
    WorktreeGroupManifestError,
} = require('../../../out/worktrees/groupManifestStore');
const {
    WorktreeDeletionController,
} = require('../../../out/worktrees/deletionController');

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

function harness(options) {
    const opts = options || {};
    const store = new WorktreeGroupManifestStore(memento());
    const state = {
        blockers: opts.blockers || new Map(),
        removed: new Set(),
        observations: opts.observations || new Map(),
        sessions: opts.sessions || new Map(),
        removedOrder: [],
    };
    const controller = new WorktreeDeletionController({
        store,
        recheckBlocker: async (_group, member) =>
            state.blockers.get(member.memberId) || null,
        snapshotAffectedSessions: async (_group, member) =>
            state.sessions.get(member.memberId) || [],
        removeWorktree: async target => {
            if (opts.failRemove && opts.failRemove.has(target.memberId)) {
                return { kind: 'failed', errorCode: 'worktree-remove-failed' };
            }
            state.removed.add(target.memberId);
            state.removedOrder.push(target.memberId);
            return { kind: 'removed' };
        },
        observeWorktree: async target =>
            state.observations.get(target.memberId) || 'unknown',
        nowMs: opts.nowMs || (() => 1000),
    });
    return { store, controller, state };
}

async function createGroup(store, members, overrides) {
    return store.createGroup(WORKSPACE, {
        displayName: 'fix login',
        suggestedSlug: 'fix-login',
        members,
        ...(overrides || {}),
    });
}

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 admission rechecks blockers and freezes sessions before side effects', async () => {
    const { store, controller, state } = harness();
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    state.sessions.set(group.members[0].memberId, [{ provider: 'codex', sessionId: 's1' }]);
    const outcome = await controller.beginDeletion(
        WORKSPACE, group.groupId, 'member', [group.members[0].memberId], {
            replacementPrimaryMemberId: group.members[1].memberId,
        });
    assert.equal(outcome.kind, 'started');
    assert.equal(outcome.journal.targets[0].affectedSessions.length, 1);
    // Journal persisted before ANY physical removal happened.
    assert.equal(state.removed.size, 0);
    await controller.executeOperation(WORKSPACE, outcome.journal.operationId);
    assert.deepEqual(state.removedOrder, [group.members[0].memberId]);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 1);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 a blocker at admission aborts with zero side effects', async () => {
    const blockers = new Map();
    const { store, controller, state } = harness({ blockers });
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    blockers.set(group.members[0].memberId, 'session-active');
    const outcome = await controller.beginDeletion(WORKSPACE, group.groupId, 'group');
    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.errorCode, 'session-active');
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    assert.equal(store.listGroups(WORKSPACE)[0].members[0].state, 'ready');
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 0);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 execution-time blocker fails only that member', async () => {
    const { store, controller, state } = harness();
    const group = await createGroup(store, [
        readyMember('alpha', 'a'),
        readyMember('beta', 'b'),
    ]);
    const outcome = await controller.beginDeletion(WORKSPACE, group.groupId, 'group');
    assert.equal(outcome.kind, 'started');
    // A blocker appears AFTER admission (TOCTOU): only that member fails.
    state.blockers.set(group.members[1].memberId, 'uncommitted-changes');
    await controller.executeOperation(WORKSPACE, outcome.journal.operationId);
    assert.deepEqual(state.removedOrder, [group.members[0].memberId]);
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.length, 1);
    assert.equal(listed[0].members[0].state, 'ready');
    assert.equal(listed[0].members[0].lastError, 'uncommitted-changes');
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 1);
    // Retry reopens the same operation for the failed member only.
    state.blockers.delete(group.members[1].memberId);
    await store.retryDeletion(WORKSPACE, outcome.journal.operationId);
    await controller.executeOperation(WORKSPACE, outcome.journal.operationId);
    assert.equal(store.listGroups(WORKSPACE).length, 0);
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 2);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 restart reconciliation: missing path completes from frozen data', async () => {
    const observations = new Map();
    const { store, controller } = harness({ observations });
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const outcome = await controller.beginDeletion(WORKSPACE, group.groupId, 'group');
    const operationId = outcome.kind === 'started'
        ? outcome.journal.operationId : undefined;
    // Crash after journal write, physical deletion happened outside the
    // process's knowledge: the path is now certainly gone.
    observations.set(group.members[0].memberId, 'missing');
    await controller.reconcileAfterRestart(WORKSPACE);
    assert.equal(store.listGroups(WORKSPACE).length, 0);
    assert.equal(store.listDeletionJournals(WORKSPACE).length, 0);
    const retired = store.listRetiredIdentities(WORKSPACE);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].generationCutoffAt, 1000);
    assert.ok(operationId);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 restart reconciliation: surviving worktree restores ready for Retry', async () => {
    const observations = new Map();
    const { store, controller } = harness({ observations });
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const outcome = await controller.beginDeletion(WORKSPACE, group.groupId, 'group');
    assert.equal(outcome.kind, 'started');
    // Crash before the physical removal: the worktree is still there.
    observations.set(group.members[0].memberId, 'present');
    await controller.reconcileAfterRestart(WORKSPACE);
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members[0].state, 'ready');
    assert.equal(listed[0].members[0].lastError, 'deletion-interrupted');
    assert.equal(store.listRetiredIdentities(WORKSPACE).length, 0);
    // Retry reuses the same operation and frozen identity.
    const retried = await store.retryDeletion(WORKSPACE, outcome.journal.operationId);
    assert.equal(retried.operationId, outcome.journal.operationId);
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 restart reconciliation: unknown observation keeps the lease', async () => {
    // No observation registered: the observer reports 'unknown'.
    const { store, controller } = harness();
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const outcome = await controller.beginDeletion(WORKSPACE, group.groupId, 'group');
    assert.equal(outcome.kind, 'started');
    await controller.reconcileAfterRestart(WORKSPACE);
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members[0].state, 'deleting');
    assert.ok(store.isGroupDeletionLeased(WORKSPACE, group.groupId));
    await assert.rejects(
        store.renameGroup(WORKSPACE, group.groupId, 'x'),
        error => error instanceof WorktreeGroupManifestError
            && error.code === 'group-leased');
});

test('WORKTREE-GROUPS-DELETE-JOURNAL-001 the admission mutex serializes deletion and session admission', async () => {
    const { store, controller } = harness();
    const group = await createGroup(store, [readyMember('alpha', 'a')]);
    const order = [];
    // Simulate New session admission holding the same lock while deletion
    // admission is mid-recheck.
    let releaseRecheck;
    const gate = new Promise(resolve => {
        releaseRecheck = resolve;
    });
    const gated = new WorktreeDeletionController({
        store,
        recheckBlocker: async () => {
            order.push('recheck');
            await gate;
            return null;
        },
        snapshotAffectedSessions: async () => [],
        removeWorktree: async () => ({ kind: 'removed' }),
        observeWorktree: async () => 'unknown',
        nowMs: () => 1000,
    });
    const deletion = gated.beginDeletion(WORKSPACE, group.groupId, 'group');
    const admission = gated.withAdmissionLock(WORKSPACE, group.groupId, async () => {
        order.push('admission');
        // Inside the lock the journal is already persisted: the lease
        // check sees it and refuses the new session.
        return store.isGroupDeletionLeased(WORKSPACE, group.groupId);
    });
    releaseRecheck();
    const [, leased] = await Promise.all([deletion, admission]);
    assert.deepEqual(order, ['recheck', 'admission']);
    assert.equal(leased, true);
});
