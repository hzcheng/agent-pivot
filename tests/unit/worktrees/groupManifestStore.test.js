'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorktreeGroupManifestStore,
    WorktreeGroupManifestError,
} = require('../../../out/worktrees/groupManifestStore');

const WORKSPACE = 'workspace-nav-id';
const OTHER_WORKSPACE = 'other-workspace-nav-id';

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

test('WORKTREE-GROUPS-001 creates a group and resolves the primary ready member', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        plannedMember('alpha', 'fix-login'),
        readyMember('beta', 'fix-login'),
    ]);
    assert.equal(group.members.length, 2);
    const beta = group.members.find(member => member.repositoryKey.includes('beta'));
    assert.equal(group.primaryMemberId, beta.memberId);
    const listed = store.listGroups(WORKSPACE);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].groupId, group.groupId);
});

test('WORKTREE-GROUPS-001 rejects a requested primary that is not ready', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await assert.rejects(
        createGroup(store, [plannedMember('alpha', 'x'), readyMember('beta', 'x')],
            { primaryMemberIndex: 0 }),
        error => error instanceof WorktreeGroupManifestError
            && error.code === 'primary-not-ready');
    const group = await createGroup(store,
        [plannedMember('alpha', 'x'), readyMember('beta', 'x')],
        { primaryMemberIndex: 1 });
    assert.ok(group.primaryMemberId);
});

test('WORKTREE-GROUPS-001 enforces one member per repository within a group', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    await assert.rejects(
        createGroup(store, [readyMember('alpha', 'one'), readyMember('alpha', 'two')]),
        error => error.code === 'repository-conflict');
    const group = await createGroup(store, [readyMember('alpha', 'one')]);
    await assert.rejects(
        store.addMember(WORKSPACE, group.groupId, readyMember('alpha', 'two')),
        error => error.code === 'repository-conflict');
});

test('WORKTREE-GROUPS-001 enforces a worktree key belongs to at most one group per workspace', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [readyMember('alpha', 'fix-login')]);
    await assert.rejects(
        createGroup(store, [readyMember('alpha', 'fix-login')]),
        error => error.code === 'worktree-key-claimed');
    // The same physical worktree may be grouped independently in another
    // workspace bucket (PRD §9 known rule).
    const other = await store.createGroup(OTHER_WORKSPACE, {
        displayName: 'other', suggestedSlug: 'fix-login',
        members: [readyMember('alpha', 'fix-login')],
    });
    assert.ok(other.groupId);
    assert.equal(store.findGroupByWorktreeKey(WORKSPACE,
        readyMember('alpha', 'fix-login').worktreeKey).groupId, group.groupId);
});

test('WORKTREE-GROUPS-001 clears the primary when it stops being ready and requires a ready replacement', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'fix-login'),
        readyMember('beta', 'fix-login'),
    ]);
    const primary = group.members.find(member => member.memberId === group.primaryMemberId);
    const other = group.members.find(member => member.memberId !== group.primaryMemberId);
    await assert.rejects(
        store.setPrimaryMember(WORKSPACE, group.groupId, 'missing-member'),
        error => error.code === 'member-not-found');
    const failed = await store.updateMember(WORKSPACE, group.groupId, primary.memberId,
        { state: 'failed', lastError: 'interrupted' });
    assert.equal(failed.primaryMemberId, null);
    const updated = await store.setPrimaryMember(WORKSPACE, group.groupId, other.memberId);
    assert.equal(updated.primaryMemberId, other.memberId);
});

test('WORKTREE-GROUPS-001 removes the group record when its last member is removed', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'fix-login'),
        plannedMember('beta', 'fix-login'),
    ]);
    const remaining = await store.removeMember(
        WORKSPACE, group.groupId, group.members[0].memberId);
    assert.equal(remaining.members.length, 1);
    const gone = await store.removeMember(
        WORKSPACE, group.groupId, remaining.members[0].memberId);
    assert.equal(gone, null);
    assert.equal(store.listGroups(WORKSPACE).length, 0);
});

test('WORKTREE-GROUPS-001 merges groups, moves every member state along, and blocks repository conflicts', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const target = await createGroup(store, [readyMember('alpha', 'fix-login')]);
    const source = await store.createGroup(OTHER_WORKSPACE, {
        displayName: 'source', suggestedSlug: 'fix-login',
        members: [readyMember('beta', 'fix-login')],
    });
    void source;
    const conflicting = await createGroup(store, [readyMember('alpha', 'fix-login-2')]);
    await assert.rejects(
        store.mergeGroups(WORKSPACE, target.groupId, conflicting.groupId),
        error => error.code === 'repository-conflict');
    const compatible = await store.createGroup(WORKSPACE, {
        displayName: 'compatible', suggestedSlug: 'fix-login',
        members: [{ ...plannedMember('beta', 'fix-login'), state: 'failed', lastError: 'interrupted' }],
    });
    const merged = await store.mergeGroups(WORKSPACE, target.groupId, compatible.groupId);
    assert.equal(merged.members.length, 2);
    const moved = merged.members.find(member => member.repositoryKey.includes('beta'));
    assert.equal(moved.state, 'failed');
    assert.equal(moved.lastError, 'interrupted');
    assert.equal(store.listGroups(WORKSPACE).length, 2);
    assert.equal(merged.primaryMemberId, target.primaryMemberId);
});

test('WORKTREE-GROUPS-001 tracks repository detachment without changing bucket membership', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await createGroup(store, [
        readyMember('alpha', 'fix-login'),
        readyMember('beta', 'fix-login'),
    ]);
    await store.setRepositoryDetached(WORKSPACE, readyMember('beta', 'fix-login').repositoryKey, true);
    let listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.find(member =>
        member.repositoryKey.includes('beta')).detached, true);
    await store.setRepositoryDetached(WORKSPACE, readyMember('beta', 'fix-login').repositoryKey, false);
    listed = store.listGroups(WORKSPACE);
    assert.equal(listed[0].members.find(member =>
        member.repositoryKey.includes('beta')).detached, undefined);
    assert.equal(listed[0].groupId, group.groupId);
});

test('WORKTREE-GROUPS-001 ignores corrupt persisted entries and rejects unsafe writes', async () => {
    const state = memento({
        'agentPivot.worktreeGroups.v1': {
            [WORKSPACE]: [
                null,
                { groupId: 'g1' },
                {
                    groupId: 'g2', displayName: 'ok', suggestedSlug: 'ok', createdAt: 1,
                    primaryMemberId: null,
                    members: [{
                        memberId: 'm1', repositoryKey: '/repos/alpha/.git',
                        branchName: 'agent-pivot/ok', path: '/tmp/ok', state: 'ready',
                    }],
                },
                {
                    groupId: 'g3', displayName: 'good', suggestedSlug: 'good', createdAt: 2,
                    primaryMemberId: null,
                    members: [{
                        memberId: 'm2', repositoryKey: '/repos/beta/.git',
                        worktreeKey: {
                            repositoryKey: '/repos/beta/.git',
                            canonicalWorktreePath: '/repos/beta/.worktrees/good',
                        },
                        branchName: 'agent-pivot/good',
                        path: '/repos/beta/.worktrees/good', state: 'ready',
                    }],
                },
            ],
            'bad\nbucket': [],
        },
    });
    const store = new WorktreeGroupManifestStore(state);
    const groups = store.listGroups(WORKSPACE);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].groupId, 'g3');
    await assert.rejects(
        createGroup(store, [{ ...readyMember('alpha', 'x'), branchName: '-evil' }]),
        error => error.code === 'invalid-record');
    await assert.rejects(
        store.createGroup('bad\nidentity', {
            displayName: 'x', suggestedSlug: 'x', members: [readyMember('alpha', 'x')],
        }),
        error => error.code === 'invalid-record');
});

test('WORKTREE-GROUPS-001 serializes concurrent writes without losing groups', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const [one, two] = await Promise.all([
        createGroup(store, [readyMember('alpha', 'one')]),
        store.createGroup(WORKSPACE, {
            displayName: 'two', suggestedSlug: 'two', members: [readyMember('beta', 'two')],
        }),
    ]);
    const ids = store.listGroups(WORKSPACE).map(group => group.groupId).sort();
    assert.deepEqual(ids, [one.groupId, two.groupId].sort());
});
