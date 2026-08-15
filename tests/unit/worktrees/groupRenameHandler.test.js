'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    handleRenameWorktreeGroup,
} = require('../../../out/worktrees/groupRenameHandler');
const {
    WorktreeGroupManifestStore,
} = require('../../../out/worktrees/groupManifestStore');
const {
    createSettlementReplayCache,
} = require('../../../out/worktrees/settlementReplayCache');

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

async function fixture() {
    const store = new WorktreeGroupManifestStore(memento());
    const group = await store.createGroup(WORKSPACE, {
        displayName: 'fix login',
        suggestedSlug: 'fix-login',
        members: [{
            repositoryKey: '/repos/alpha/.git',
            worktreeKey: {
                repositoryKey: '/repos/alpha/.git',
                canonicalWorktreePath: '/repos/alpha/.worktrees/fix-login',
            },
            branchName: 'agent-pivot/fix-login',
            path: '/repos/alpha/.worktrees/fix-login',
            state: 'ready',
        }],
    });
    const posted = [];
    let refreshes = 0;
    const deps = {
        postMessage: async message => { posted.push(message); },
        getNavigationIdentity: () => WORKSPACE,
        store,
        refreshNow: async () => { refreshes += 1; },
        showWarning: () => undefined,
        logError: () => undefined,
        replayCache: createSettlementReplayCache(),
    };
    return { store, group, posted, deps, refreshes: () => refreshes };
}

function renameRequest(group, overrides) {
    return {
        type: 'rename-worktree-group',
        version: 1,
        requestId: 'group-rename-n1-1',
        projectId: '/repo/main',
        groupId: group.groupId,
        displayName: 'Fix login v2',
        baseRevision: group.revision,
        ...(overrides || {}),
    };
}

test('WORKTREE-GROUPS-RENAME-001 a replayed request is settled from the cache, never re-executed', async () => {
    const { store, group, posted, deps } = await fixture();

    await handleRenameWorktreeGroup(renameRequest(group), deps);
    assert.equal(store.listGroups(WORKSPACE)[0].displayName, 'Fix login v2');
    assert.equal(store.listGroups(WORKSPACE)[0].revision, 2);
    assert.deepEqual(posted.map(message => message.status), ['accepted', 'settled']);

    // A replay (same request id, same or even different name) must not
    // re-execute the mutation nor move the revision.
    await handleRenameWorktreeGroup(
        renameRequest(store.listGroups(WORKSPACE)[0], {
            displayName: 'Hijacked name',
        }), deps);
    assert.deepEqual(posted.map(message => message.status),
        ['accepted', 'settled', 'settled'],
        'the replay re-receives the recorded terminal settlement');
    assert.equal(store.listGroups(WORKSPACE)[0].displayName, 'Fix login v2');
    assert.equal(store.listGroups(WORKSPACE)[0].revision, 2,
        'no second mutation, no second revision bump');
});

test('WORKTREE-GROUPS-RENAME-001 concurrent replays single-flight to one terminal settlement', async () => {
    const { store, group, posted, deps } = await fixture();

    // Two identical requests in flight at once: the second must not run
    // the mutation again nor produce its own terminal settlement.
    await Promise.all([
        handleRenameWorktreeGroup(renameRequest(group), deps),
        handleRenameWorktreeGroup(renameRequest(group), deps),
    ]);
    const statuses = posted.map(message => message.status);
    assert.deepEqual(statuses.filter(status => status === 'accepted').length, 1);
    assert.deepEqual(statuses.filter(status => status === 'settled').length, 2,
        'both callers receive the same terminal settlement');
    assert.equal(store.listGroups(WORKSPACE)[0].revision, 2,
        'the mutation ran exactly once');
});

test('WORKTREE-GROUPS-RENAME-001 a stale base revision fails closed', async () => {
    const { store, group, posted, deps } = await fixture();

    await handleRenameWorktreeGroup(renameRequest(group), deps);
    const current = store.listGroups(WORKSPACE)[0];
    await handleRenameWorktreeGroup(renameRequest(current, {
        requestId: 'group-rename-n1-2',
        displayName: 'Stale edit',
        baseRevision: group.revision,
    }), deps);
    const last = posted.at(-1);
    assert.equal(last.status, 'failed');
    assert.equal(last.errorCode, 'group-changed');
    assert.equal(store.listGroups(WORKSPACE)[0].displayName, 'Fix login v2',
        'the stale edit did not overwrite the newer name');
});
