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

test('WORKTREE-GROUPS-003 recovery records migrate renamed branches with their original task name', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const content = snapshot([{
        repositoryKey: '/alpha/.git',
        rootBindings: [],
        worktrees: [gitWorktree('/alpha/.git', '/alpha/.worktrees/fix-login', {
            branchRef: 'refs/heads/hotfix/renamed-by-user',
        })],
    }]);
    const recoveryRecords = [{
        version: 1,
        operationId: 'op-1',
        projectId: 'project',
        providerId: 'codex',
        setupCommand: [],
        plan: {
            repositoryKey: '/alpha/.git', commandCwd: '/alpha/main',
            baseRef: 'refs/heads/main', taskName: '修复登录',
            slug: 'task-a1b2c3', branchName: 'agent-pivot/task-a1b2c3',
            worktreePath: '/alpha/.worktrees/fix-login',
        },
        completedSteps: ['worktree', 'setup'],
        worktreeKey: {
            repositoryKey: '/alpha/.git',
            canonicalWorktreePath: '/alpha/.worktrees/fix-login',
        },
        row: {
            kind: 'provisioning', operationId: 'op-1', repositoryKey: '/alpha/.git',
            taskName: '修复登录', stage: 'creating', completedSteps: [],
            retryable: false, cancellable: false,
        },
    }];
    await reconcileWorktreeGroupManifest({
        store, workspaceIdentity: WORKSPACE, snapshot: content, recoveryRecords,
    });
    const groups = store.listGroups(WORKSPACE);
    assert.equal(groups.length, 1,
        'a renamed managed branch still migrates via its recovery record');
    assert.equal(groups[0].displayName, '修复登录',
        'the original task name survives instead of the degraded slug');
    assert.equal(groups[0].suggestedSlug, 'task-a1b2c3');
    assert.equal(groups[0].members[0].branchName, 'hotfix/renamed-by-user',
        'the member records the branch as it actually is');
});

test('WORKTREE-GROUPS-003 a recovery record bound to another navigation identity never seeds this bucket', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const content = snapshot([{
        repositoryKey: '/alpha/.git',
        rootBindings: [],
        worktrees: [
            // The record is the only migration signal for a renamed branch.
            gitWorktree('/alpha/.git', '/alpha/.worktrees/renamed', {
                branchRef: 'refs/heads/hotfix/renamed-by-user',
            }),
            // The managed branch prefix stays an independent signal.
            gitWorktree('/alpha/.git', '/alpha/.worktrees/managed', {
                branchRef: 'refs/heads/agent-pivot/managed',
            }),
        ],
    }]);
    const foreignRecord = {
        version: 1,
        operationId: 'op-foreign',
        projectId: 'project',
        workspaceNavigationIdentity: 'workspace-other-nav-id',
        providerId: 'codex',
        setupCommand: [],
        plan: {
            repositoryKey: '/alpha/.git', commandCwd: '/alpha/main',
            baseRef: 'refs/heads/main', taskName: 'Renamed task', slug: 'renamed-task',
            branchName: 'agent-pivot/renamed-task',
            worktreePath: '/alpha/.worktrees/renamed',
        },
        completedSteps: ['worktree', 'setup'],
        worktreeKey: {
            repositoryKey: '/alpha/.git',
            canonicalWorktreePath: '/alpha/.worktrees/renamed',
        },
        row: {
            kind: 'provisioning', operationId: 'op-foreign', repositoryKey: '/alpha/.git',
            taskName: 'Renamed task', stage: 'creating', completedSteps: [],
            retryable: false, cancellable: false,
        },
    };
    await reconcileWorktreeGroupManifest({
        store, workspaceIdentity: WORKSPACE, snapshot: content,
        recoveryRecords: [foreignRecord],
    });
    const groups = store.listGroups(WORKSPACE);
    assert.equal(groups.length, 1,
        'the foreign record must not seed this workspace bucket');
    assert.equal(groups[0].members[0].path, '/alpha/.worktrees/managed',
        'the managed branch prefix still seeds independently');
});

test('WORKTREE-GROUPS-003 a foreign incomplete recovery still blocks ready seeding', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const content = snapshot([{
        repositoryKey: '/alpha/.git',
        rootBindings: [],
        worktrees: [gitWorktree('/alpha/.git', '/alpha/.worktrees/fix-login', {
            branchRef: 'refs/heads/agent-pivot/fix-login',
        })],
    }]);
    const foreignIncomplete = {
        version: 1,
        operationId: 'op-foreign-incomplete',
        projectId: 'project',
        workspaceNavigationIdentity: 'workspace-other-nav-id',
        providerId: 'codex',
        setupCommand: ['npm', 'ci'],
        plan: {
            repositoryKey: '/alpha/.git', commandCwd: '/alpha/main',
            baseRef: 'refs/heads/main', taskName: 'Fix login', slug: 'fix-login',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/alpha/.worktrees/fix-login',
        },
        completedSteps: ['worktree'],
        worktreeKey: {
            repositoryKey: '/alpha/.git',
            canonicalWorktreePath: '/alpha/.worktrees/fix-login',
        },
        row: {
            kind: 'provisioning', operationId: 'op-foreign-incomplete', repositoryKey: '/alpha/.git',
            taskName: 'Fix login', stage: 'setting-up', completedSteps: ['worktree'],
            retryable: true, cancellable: true,
        },
    };
    await reconcileWorktreeGroupManifest({
        store, workspaceIdentity: WORKSPACE, snapshot: content,
        recoveryRecords: [foreignIncomplete],
    });
    assert.deepEqual(store.listGroups(WORKSPACE), [],
        'a half-provisioned worktree stays unseeded even when the record is foreign');
});

test('WORKTREE-GROUPS-003 an interrupted provisioning record blocks ready seeding until retried', async () => {
    const store = new WorktreeGroupManifestStore(memento());
    const content = snapshot([{
        repositoryKey: '/alpha/.git',
        rootBindings: [],
        worktrees: [gitWorktree('/alpha/.git', '/alpha/.worktrees/fix-login', {
            branchRef: 'refs/heads/agent-pivot/fix-login',
        })],
    }]);
    const interruptedRecord = {
        version: 1,
        operationId: 'op-interrupted',
        projectId: 'project',
        providerId: 'codex',
        setupCommand: ['npm', 'ci'],
        plan: {
            repositoryKey: '/alpha/.git', commandCwd: '/alpha/main',
            baseRef: 'refs/heads/main', taskName: 'Fix login', slug: 'fix-login',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/alpha/.worktrees/fix-login',
        },
        completedSteps: ['worktree'],
        worktreeKey: {
            repositoryKey: '/alpha/.git',
            canonicalWorktreePath: '/alpha/.worktrees/fix-login',
        },
        row: {
            kind: 'provisioning', operationId: 'op-interrupted', repositoryKey: '/alpha/.git',
            taskName: 'Fix login', stage: 'setting-up', completedSteps: ['worktree'],
            retryable: true, cancellable: true,
        },
    };
    await reconcileWorktreeGroupManifest({
        store, workspaceIdentity: WORKSPACE, snapshot: content,
        recoveryRecords: [interruptedRecord],
    });
    assert.equal(store.listGroups(WORKSPACE).length, 0,
        'a worktree whose setup never finished must not become a ready group');

    // Once the record completes (or is dismissed and the worktree is
    // finished by hand), the next reconcile seeds it normally.
    await reconcileWorktreeGroupManifest({
        store, workspaceIdentity: WORKSPACE, snapshot: content,
        recoveryRecords: [{ ...interruptedRecord, completedSteps: ['worktree', 'setup'] }],
    });
    assert.equal(store.listGroups(WORKSPACE).length, 1);
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
