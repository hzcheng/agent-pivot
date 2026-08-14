'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WorktreeGroupManifestStore } = require('../../../out/worktrees/groupManifestStore');
const {
    reconcileWorktreeGroupManifest,
} = require('../../../out/worktrees/groupManifestReconciliation');

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

function gitWorktree(repositoryKey, worktreePath, options) {
    return {
        key: { repositoryKey, canonicalWorktreePath: worktreePath },
        head: '1'.repeat(40),
        branchRef: 'refs/heads/main',
        isMain: false, isBare: false, health: 'normal', headKind: 'branch',
        ...(options || {}),
    };
}

function snapshot(repositories) {
    return { repositories, truncatedWorktreeCount: 0 };
}

test('WORKTREE-GROUPS-003 seeds extension-created worktrees as one-worktree groups, never merged by slug', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const content = snapshot([{
        repositoryKey: '/alpha/.git',
        rootBindings: [],
        worktrees: [
            gitWorktree('/alpha/.git', '/alpha/main', { isMain: true }),
            gitWorktree('/alpha/.git', '/alpha/.worktrees/fix-login', {
                branchRef: 'refs/heads/agent-pivot/fix-login',
            }),
        ],
    }, {
        repositoryKey: '/beta/.git',
        rootBindings: [],
        worktrees: [
            gitWorktree('/beta/.git', '/beta/.worktrees/fix-login', {
                branchRef: 'refs/heads/agent-pivot/fix-login',
            }),
            gitWorktree('/beta/.git', '/beta/.worktrees/manual', {
                branchRef: 'refs/heads/topic/manual',
            }),
        ],
    }]);
    await reconcileWorktreeGroupManifest({ store, workspaceIdentity: WORKSPACE, snapshot: content });
    const groups = store.listGroups(WORKSPACE);
    assert.equal(groups.length, 2,
        'same slug across repositories stays two separate authoritative groups');
    for (const group of groups) {
        assert.equal(group.displayName, 'fix-login');
        assert.equal(group.suggestedSlug, 'fix-login');
        assert.equal(group.members.length, 1);
        assert.equal(group.members[0].state, 'ready');
        assert.equal(group.primaryMemberId, group.members[0].memberId);
    }
});

test('WORKTREE-GROUPS-003 reconciliation is idempotent across repeated snapshots', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const content = snapshot([{
        repositoryKey: '/alpha/.git',
        rootBindings: [],
        worktrees: [gitWorktree('/alpha/.git', '/alpha/.worktrees/fix-login', {
            branchRef: 'refs/heads/agent-pivot/fix-login',
        })],
    }]);
    await reconcileWorktreeGroupManifest({ store, workspaceIdentity: WORKSPACE, snapshot: content });
    const first = store.listGroups(WORKSPACE);
    await reconcileWorktreeGroupManifest({ store, workspaceIdentity: WORKSPACE, snapshot: content });
    const second = store.listGroups(WORKSPACE);
    assert.deepEqual(second, first);
});

test('WORKTREE-GROUPS-003 flags members detached when their repository leaves and re-attaches on return', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const withBoth = snapshot([{
        repositoryKey: '/alpha/.git',
        rootBindings: [],
        worktrees: [gitWorktree('/alpha/.git', '/alpha/.worktrees/fix-login', {
            branchRef: 'refs/heads/agent-pivot/fix-login',
        })],
    }, {
        repositoryKey: '/beta/.git',
        rootBindings: [],
        worktrees: [gitWorktree('/beta/.git', '/beta/.worktrees/fix-login', {
            branchRef: 'refs/heads/agent-pivot/fix-login',
        })],
    }]);
    await reconcileWorktreeGroupManifest({ store, workspaceIdentity: WORKSPACE, snapshot: withBoth });

    const alphaOnly = snapshot([withBoth.repositories[0]]);
    await reconcileWorktreeGroupManifest({ store, workspaceIdentity: WORKSPACE, snapshot: alphaOnly });
    let groups = store.listGroups(WORKSPACE);
    const betaGroup = groups.find(group => group.members[0].repositoryKey === '/beta/.git');
    assert.equal(betaGroup.members[0].detached, true,
        'the group record survives its repository leaving the workspace');
    const alphaGroup = groups.find(group => group.members[0].repositoryKey === '/alpha/.git');
    assert.equal(alphaGroup.members[0].detached, undefined);

    await reconcileWorktreeGroupManifest({ store, workspaceIdentity: WORKSPACE, snapshot: withBoth });
    groups = store.listGroups(WORKSPACE);
    assert.equal(groups.find(group => group.members[0].repositoryKey === '/beta/.git')
        .members[0].detached, undefined, 're-adding the repository re-attaches the member');
});
