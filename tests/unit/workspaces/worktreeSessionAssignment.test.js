'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assignPathToWorkspaceWorktree,
    getWorkspaceWorktreeCandidatePaths,
} = require('../../../out/workspaces/worktreeSessionAssignment');
const { buildWorkspaceAiSessionViewModel } = require('../../../out/workspaces/viewModels');

const WORKSPACE = {
    navigationIdentity: 'navigation:fixture',
    scopeIdentity: 'scope:fixture',
    kind: 'savedMultiRoot',
    displayName: 'Fixture',
    navigationUri: 'file:///work/fixture.code-workspace',
    environment: 'local',
    roots: [
        {
            id: 'api', name: 'API', uri: 'file:///repo/main/packages/api',
            hostPath: '/repo/main/packages/api', ordinal: 0,
        },
        {
            id: 'other', name: 'Other', uri: 'file:///other',
            hostPath: '/other', ordinal: 1,
        },
    ],
};

const SNAPSHOT = {
    revision: 3,
    repositories: [{
        repositoryKey: '/repo/.git',
        rootBindings: [{ workspaceRootId: 'api', repositoryRelativePath: 'packages/api' }],
        worktrees: [
            {
                key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/main' },
                head: '1'.repeat(40), branchRef: 'refs/heads/main', isMain: true,
                isBare: false, health: 'normal', headKind: 'branch',
            },
            {
                key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/topic' },
                head: '2'.repeat(40), branchRef: 'refs/heads/topic', isMain: false,
                isBare: false, health: 'normal', headKind: 'branch',
            },
        ],
    }, {
        repositoryKey: '/other/.git',
        rootBindings: [{ workspaceRootId: 'other', repositoryRelativePath: '' }],
        worktrees: [{
            key: { repositoryKey: '/other/.git', canonicalWorktreePath: '/other' },
            head: '3'.repeat(40), branchRef: 'refs/heads/main', isMain: true,
            isBare: false, health: 'normal', headKind: 'branch',
        }],
    }],
    truncatedWorktreeCount: 0,
};

test('SESSION-WORKTREE-ASSIGNMENT-001 scans sibling checkout roots once while retaining workspace-root priority', () => {
    assert.deepEqual(getWorkspaceWorktreeCandidatePaths(WORKSPACE, SNAPSHOT), [
        '/repo/main/packages/api',
        '/other',
        '/repo/main',
        '/repo/topic',
    ]);
});

test('SESSION-WORKTREE-ASSIGNMENT-001 maps sibling cwd to stable worktree identity and repository-relative root metadata', () => {
    const topic = assignPathToWorkspaceWorktree(
        '/repo/topic/packages/api/src/index.ts',
        WORKSPACE,
        SNAPSHOT,
    );
    assert.deepEqual(topic && {
        key: topic.worktree.key,
        rootId: topic.root && topic.root.id,
        mappedRootPath: topic.mappedRootPath,
    }, {
        key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/topic' },
        rootId: 'api',
        mappedRootPath: '/repo/topic/packages/api',
    });

    const repositoryOwned = assignPathToWorkspaceWorktree(
        '/repo/topic/tools/generator',
        WORKSPACE,
        SNAPSHOT,
    );
    assert.deepEqual(repositoryOwned && repositoryOwned.worktree.key, {
        repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/topic',
    });
    assert.equal(repositoryOwned.root, null,
        'repository visibility is broader than the mapped workspace subdirectory');
});

test('SESSION-WORKTREE-ASSIGNMENT-001 prefers an exact runtime key and rejects keys outside the coherent snapshot', () => {
    const exact = assignPathToWorkspaceWorktree(
        '/legacy/location',
        WORKSPACE,
        SNAPSHOT,
        { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/topic' },
    );
    assert.deepEqual(exact && exact.worktree.key, {
        repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/topic',
    });

    assert.equal(assignPathToWorkspaceWorktree(
        '/legacy/location',
        WORKSPACE,
        SNAPSHOT,
        { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/removed' },
    ), null);
});

test('WORKTREE-PRESENTATION-001 defensively snapshots nested worktree identities in the combined view model', () => {
    const worktreeSnapshot = JSON.parse(JSON.stringify(SNAPSHOT));
    worktreeSnapshot.repositories.push({
        repositoryKey: '/stale/.git',
        rootBindings: [{ workspaceRootId: 'removed-root', repositoryRelativePath: '' }],
        worktrees: [{
            key: { repositoryKey: '/stale/.git', canonicalWorktreePath: '/stale/main' },
            head: '5'.repeat(40), isMain: true, isBare: false,
            health: 'normal', headKind: 'detached',
        }],
    });
    const worktreeKey = {
        repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo/topic',
    };
    const history = { id: 'history', name: 'History', provider: 'codex', worktreeKey };
    const activeKey = { ...worktreeKey };
    const active = {
        key: 'codex:history', provider: 'codex', sessionId: 'history', name: 'History',
        executionState: 'running', focused: false, needsAttention: false, pending: false,
        backend: 'vscode', attached: true, worktreeKey: activeKey,
    };
    const viewModel = buildWorkspaceAiSessionViewModel({
        workspace: WORKSPACE,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionsByProvider: { codex: [history] },
        unavailableProviders: [], activeSessions: [active], attentionCount: 0,
        worktreeSnapshot,
    });

    worktreeKey.canonicalWorktreePath = '/mutated/history';
    activeKey.canonicalWorktreePath = '/mutated/active';
    worktreeSnapshot.repositories[0].worktrees[1].key.canonicalWorktreePath = '/mutated/git';

    assert.equal(
        viewModel.sessionsByProvider.codex[0].worktreeKey.canonicalWorktreePath,
        '/repo/topic',
    );
    assert.equal(viewModel.activeSessions[0].worktreeKey.canonicalWorktreePath, '/repo/topic');
    assert.equal(viewModel.worktrees[0].git.key.canonicalWorktreePath, '/repo/topic');
    assert.equal(viewModel.worktrees[0].activity, 'active');
    assert.equal(viewModel.worktrees.length, 1,
        'unmanaged rows exclude main checkouts and claimed worktrees, and a last-good'
        + ' snapshot from removed workspace roots must not leak stale repositories');
    assert.deepEqual(
        viewModel.worktreeAnchor.entries.map(entry => entry.repositoryLabel).sort(),
        ['other', 'repo'],
        'main checkouts collapse into the anchor row with repository labels');
});

test('WORKTREE-PROVISIONING-STATE-001 WORKTREE-PROVISIONING-UI-001 projects only workspace-owned provisioning rows defensively', () => {
    const provisioning = [{
        kind: 'provisioning', operationId: 'operation-1', repositoryKey: '/repo/.git',
        taskName: 'Fix login race', proposedPath: '/repo/.agent-pivot/worktrees/fix-login-race',
        stage: 'creating', completedSteps: [], retryable: false, cancellable: true,
    }, {
        kind: 'provisioning', operationId: 'operation-foreign', repositoryKey: '/foreign/.git',
        taskName: 'Foreign', stage: 'queued', completedSteps: [],
        retryable: false, cancellable: true,
    }];
    const viewModel = buildWorkspaceAiSessionViewModel({
        workspace: WORKSPACE,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionsByProvider: { codex: [] }, unavailableProviders: [],
        activeSessions: [], attentionCount: 0,
        worktreeSnapshot: SNAPSHOT,
        provisioningWorktrees: provisioning,
    });

    provisioning[0].completedSteps.push('mutated');
    assert.equal(viewModel.worktrees[0].kind, 'provisioning');
    assert.equal(viewModel.worktrees[0].operationId, 'operation-1');
    assert.deepEqual(viewModel.worktrees[0].completedSteps, []);
    assert.equal(viewModel.worktrees.some(row => row.kind === 'provisioning'
        && row.operationId === 'operation-foreign'), false);
});

test('WORKTREE-MANAGED-CLEANUP-001 exposes removal for usable linked worktrees and lets the host guard busy ones', () => {
    const managedPath = '/repo/.agent-pivot/worktrees/fix-login-race';
    const worktreeSnapshot = JSON.parse(JSON.stringify(SNAPSHOT));
    worktreeSnapshot.repositories[0].worktrees.push({
        key: { repositoryKey: '/repo/.git', canonicalWorktreePath: managedPath },
        head: '6'.repeat(40), branchRef: 'refs/heads/agent-pivot/fix-login-race',
        isMain: false, isBare: false, health: 'normal', headKind: 'branch',
    });
    const build = workspace => buildWorkspaceAiSessionViewModel({
        workspace,
        providers: [{ id: 'codex', label: 'Codex' }],
        sessionsByProvider: { codex: [] }, unavailableProviders: [],
        activeSessions: [], attentionCount: 0, worktreeSnapshot,
    });
    const removable = build(WORKSPACE).worktrees.find(row =>
        row.kind === 'ready' && row.git.key.canonicalWorktreePath === managedPath);
    assert.equal(removable.authority.canRemove, true);

    const main = build(WORKSPACE).worktrees.find(row =>
        row.kind === 'ready' && row.git.key.canonicalWorktreePath === '/repo/main');
    assert.equal(main, undefined,
        'the main checkout is never a removable row; it collapses into the anchor');
    const topic = build(WORKSPACE).worktrees.find(row =>
        row.kind === 'ready' && row.git.key.canonicalWorktreePath === '/repo/topic');
    assert.equal(topic.authority.canRemove, true,
        'linked worktrees outside the managed directory remain removable');

    const openWorkspace = JSON.parse(JSON.stringify(WORKSPACE));
    openWorkspace.roots[0].hostPath = `${managedPath}/packages/api`;
    const open = build(openWorkspace).worktrees.find(row =>
        row.kind === 'ready' && row.git.key.canonicalWorktreePath === managedPath);
    assert.equal(open.authority.canRemove, true,
        'removal stays discoverable; the host refuses open worktrees with the reason');
});
