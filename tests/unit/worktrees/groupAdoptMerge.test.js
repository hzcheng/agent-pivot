'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    WorktreeGroupManifestError,
    createWorktreeGroupManifestStore,
    worktreeGroupManifestStoreOf,
} = require('../../../out/worktrees/groupManifestStore');
const {
    createSettlementReplayCache,
} = require('../../../out/worktrees/settlementReplayCache');
const {
    handleAdoptWorktrees,
} = require('../../../out/worktrees/groupAdoptHandler');

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

async function createGroup(store, name, members) {
    return store.createGroup(WORKSPACE, {
        displayName: name,
        suggestedSlug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        members,
    });
}

test('WORKTREE-GROUPS-ADOPT-MERGE-001 merge binds both revisions and adopts the source primary when headless', async () => {
    const store = worktreeGroupManifestStoreOf(createWorktreeGroupManifestStore(memento()));
    const target = await createGroup(store, 'Target', [readyMember('alpha', 'target')]);
    const source = await createGroup(store, 'Source', [readyMember('beta', 'source')]);
    // Target has no primary: clear it to exercise the fallback.
    await store.updateMember(WORKSPACE, target.groupId, target.members[0].memberId, {
        state: 'failed',
    });
    await store.updateMember(WORKSPACE, target.groupId, target.members[0].memberId, {
        state: 'ready',
    });
    const headless = store.listGroups(WORKSPACE)
        .find(group => group.groupId === target.groupId);
    // updateMember cleared the primary when the only member left ready,
    // leaving the target headless.
    assert.equal(headless.primaryMemberId, null);
    // Stale revisions fail closed.
    await assert.rejects(store.mergeGroups(WORKSPACE, target.groupId, source.groupId, {
        targetRevision: target.revision,
        sourceRevision: source.revision + 1,
    }), error => error instanceof WorktreeGroupManifestError
        && error.code === 'group-changed');
    const merged = await store.mergeGroups(WORKSPACE, target.groupId, source.groupId, {
        targetRevision: headless.revision,
        sourceRevision: source.revision,
    });
    assert.equal(merged.members.length, 2);
    assert.equal(store.listGroups(WORKSPACE).length, 1);
    // The source's ready primary became the merged group's primary.
    assert.equal(merged.primaryMemberId, source.members[0].memberId);
});

test('WORKTREE-GROUPS-ADOPT-MERGE-001 adoptReadyMembers requires ready members with physical identity', async () => {
    const store = worktreeGroupManifestStoreOf(createWorktreeGroupManifestStore(memento()));
    const group = await createGroup(store, 'Target', [readyMember('alpha', 'target')]);
    await assert.rejects(store.adoptReadyMembers(WORKSPACE, group.groupId, [{
        repositoryKey: '/repos/beta/.git',
        branchName: 'agent-pivot/x',
        path: '/repos/beta/.worktrees/x',
        state: 'provisioning',
    }]), error => error instanceof WorktreeGroupManifestError
        && error.code === 'invalid-record');
    const updated = await store.adoptReadyMembers(
        WORKSPACE, group.groupId, [readyMember('beta', 'adopted')]);
    assert.equal(updated.members.length, 2);
    assert.equal(updated.members[1].state, 'ready');
    assert.equal(updated.members[1].worktreeKey.canonicalWorktreePath,
        '/repos/beta/.worktrees/adopted');
});

test('WORKTREE-GROUPS-ADOPT-MERGE-001 the handler re-validates keys against snapshot and manifest', async () => {
    const storeHandle = createWorktreeGroupManifestStore(memento());
    const store = worktreeGroupManifestStoreOf(storeHandle);
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: '/repos/alpha/.git',
            rootBindings: [{ workspaceRootId: 'root', repositoryRelativePath: '' }],
            worktrees: [{
                key: {
                    repositoryKey: '/repos/alpha/.git',
                    canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
                },
                branchRef: 'refs/heads/agent-pivot/fix-login',
                head: 'a'.repeat(40), isMain: false, isBare: false,
                health: 'normal', headKind: 'branch',
            }],
        }],
    };
    const posted = [];
    const deps = {
        postMessage: async message => { posted.push(message); },
        getNavigationIdentity: () => WORKSPACE,
        store: storeHandle,
        getWorktreeSnapshot: () => snapshot,
        refreshNow: async () => undefined,
        logError: () => undefined,
        replayCache: createSettlementReplayCache(),
    };
    const key = { repositoryKey: '/repos/alpha/.git', canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login' };
    const adoptRequest = overrides => ({
        type: 'adopt-worktrees', version: 1,
        requestId: 'adopt-n1-1', projectId: '/repo/main',
        members: [key],
        displayName: 'Fix login',
        ...(overrides || {}),
    });
    await handleAdoptWorktrees(adoptRequest(), deps);
    let statuses = posted.map(message => message.status);
    assert.deepEqual(statuses, ['accepted', 'settled']);
    const group = store.listGroups(WORKSPACE)[0];
    assert.equal(group.displayName, 'Fix login');
    assert.equal(group.members[0].state, 'ready');
    assert.equal(group.members[0].branchName, 'agent-pivot/fix-login');
    // A second adopt of the now-claimed key fails closed.
    await handleAdoptWorktrees(adoptRequest({ requestId: 'adopt-n1-2' }), deps);
    statuses = posted.map(message => message.status);
    assert.deepEqual(statuses.slice(-2), ['accepted', 'failed']);
    assert.equal(posted[posted.length - 1].errorCode, 'worktree-key-claimed');
    // A vanished worktree fails closed.
    await handleAdoptWorktrees(adoptRequest({
        requestId: 'adopt-n1-3',
        members: [{ repositoryKey: '/repos/alpha/.git', canonicalWorktreePath: '/gone' }],
    }), deps);
    assert.equal(posted[posted.length - 1].errorCode, 'worktree-unavailable');
});

test('WORKTREE-GROUPS-REPLAY-001 a replayed adopt is settled from the cache, never re-executed', async () => {
    const storeHandle = createWorktreeGroupManifestStore(memento());
    const store = worktreeGroupManifestStoreOf(storeHandle);
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: '/repos/alpha/.git',
            rootBindings: [{ workspaceRootId: 'root', repositoryRelativePath: '' }],
            worktrees: [{
                key: {
                    repositoryKey: '/repos/alpha/.git',
                    canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
                },
                branchRef: 'refs/heads/agent-pivot/fix-login',
                head: 'a'.repeat(40), isMain: false, isBare: false,
                health: 'normal', headKind: 'branch',
            }],
        }],
    };
    const posted = [];
    const deps = {
        postMessage: async message => { posted.push(message); },
        getNavigationIdentity: () => WORKSPACE,
        store: storeHandle,
        getWorktreeSnapshot: () => snapshot,
        refreshNow: async () => undefined,
        logError: () => undefined,
        replayCache: createSettlementReplayCache(),
    };
    const request = {
        type: 'adopt-worktrees', version: 1,
        requestId: 'adopt-replay-n1-1', projectId: '/repo/main',
        members: [{
            repositoryKey: '/repos/alpha/.git',
            canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
        }],
        displayName: 'Fix login',
    };
    await handleAdoptWorktrees(request, deps);
    assert.equal(store.listGroups(WORKSPACE).length, 1);
    assert.deepEqual(posted.map(message => message.status), ['accepted', 'settled']);

    await handleAdoptWorktrees(request, deps);
    assert.equal(store.listGroups(WORKSPACE).length, 1,
        'the replay never creates a second group');
    assert.deepEqual(posted.map(message => message.status),
        ['accepted', 'settled', 'settled'],
        'the replay re-receives the recorded terminal settlement');
});

test('WORKTREE-GROUPS-ADOPT-MERGE-001 the handler adopts into an existing group', async () => {
    const storeHandle = createWorktreeGroupManifestStore(memento());
    const store = worktreeGroupManifestStoreOf(storeHandle);
    const group = await createGroup(store, 'Target', [readyMember('alpha', 'target')]);
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: '/repos/beta/.git',
            rootBindings: [{ workspaceRootId: 'root', repositoryRelativePath: '' }],
            worktrees: [{
                key: {
                    repositoryKey: '/repos/beta/.git',
                    canonicalWorktreePath: '/repos/beta/.worktrees/fix-login',
                },
                branchRef: 'refs/heads/agent-pivot/fix-login',
                head: 'a'.repeat(40), isMain: false, isBare: false,
                health: 'normal', headKind: 'branch',
            }],
        }],
    };
    const posted = [];
    await handleAdoptWorktrees({
        type: 'adopt-worktrees', version: 1,
        requestId: 'adopt-n2-1', projectId: '/repo/main',
        members: [{
            repositoryKey: '/repos/beta/.git',
            canonicalWorktreePath: '/repos/beta/.worktrees/fix-login',
        }],
        targetGroupId: group.groupId,
    }, {
        postMessage: async message => { posted.push(message); },
        getNavigationIdentity: () => WORKSPACE,
        store: storeHandle,
        getWorktreeSnapshot: () => snapshot,
        refreshNow: async () => undefined,
        logError: () => undefined,
        replayCache: createSettlementReplayCache(),
    });
    assert.equal(posted[posted.length - 1].status, 'settled');
    assert.equal(posted[posted.length - 1].groupId, group.groupId);
    assert.equal(store.listGroups(WORKSPACE)[0].members.length, 2);
});
