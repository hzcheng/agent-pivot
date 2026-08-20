'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeGroupCreationController,
} = require('../../../out/worktrees/groupCreationController');
const {
    createWorktreeGroupManifestStore,
    worktreeGroupManifestStoreOf,
} = require('../../../out/worktrees/groupManifestStore');

const workspace = {
    navigationIdentity: 'navigation:workspace',
    scopeIdentity: 'scope:workspace',
    kind: 'multiRoot',
    displayName: 'Workspace',
    navigationUri: 'file:///workspace.code-workspace',
    environment: 'local',
    roots: [
        { id: 'root-alpha', name: 'alpha', uri: 'file:///alpha', hostPath: '/alpha', ordinal: 0 },
        { id: 'root-beta', name: 'beta', uri: 'file:///beta', hostPath: '/beta', ordinal: 1 },
    ],
};

function repository(repositoryKey, rootId, worktreePath, extraWorktrees) {
    return {
        repositoryKey,
        rootBindings: [{ workspaceRootId: rootId, repositoryRelativePath: '' }],
        baseRef: 'refs/heads/main',
        worktrees: [{
            key: { repositoryKey, canonicalWorktreePath: worktreePath },
            branchRef: 'refs/heads/main', head: 'a'.repeat(40), isMain: true,
            isBare: false, health: 'normal', headKind: 'branch',
        }].concat(extraWorktrees || []),
    };
}

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

function fixture(overrides = {}) {
    const manifestStoreHandle = createWorktreeGroupManifestStore(memento());
    const manifestStore = worktreeGroupManifestStoreOf(manifestStoreHandle);
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [
            repository('/alpha/.git', 'root-alpha', '/alpha'),
            repository('/beta/.git', 'root-beta', '/beta'),
        ],
    };
    const options = {
        getWorkspaceTarget: projectId => projectId === 'project' ? { workspace } : null,
        getWorktreeSnapshot: () => snapshot,
        // The source group's branches exist as real refs.
        listLocalBranches: async () => ['main', 'agent-pivot/fix-login', 'agent-pivot/fix-login-2'],
        isBranchAvailable: async () => true,
        isPathAvailable: async () => true,
        preflightPlan: async () => 'ok',
        getSetupCommand: () => [],
        getWorktreeDirectory: () => '.worktrees',
        getActiveEditorPath: () => undefined,
        manifestStore: manifestStoreHandle,
        startMemberOperation: async input => {
            await manifestStore.updateMember(
                workspace.navigationIdentity, input.groupId, input.memberId, {
                    state: 'ready',
                    worktreeKey: {
                        repositoryKey: input.plan.repositoryKey,
                        canonicalWorktreePath: input.plan.worktreePath,
                    },
                });
            return { kind: 'succeeded', operationId: input.operationId, worktreeKey: {}, plan: input.plan };
        },
        retryMemberOperation: async () => ({ kind: 'failed', errorCode: 'unused' }),
        dismissMemberOperation: () => true,
        hasMemberOperation: () => true,
        onDidChange: () => undefined,
        ...overrides,
    };
    return {
        controller: new WorktreeGroupCreationController(options),
        manifestStore,
        snapshot,
        options,
    };
}

async function createSourceGroup(store, members) {
    return store.createGroup(workspace.navigationIdentity, {
        displayName: 'Fix login',
        suggestedSlug: 'fix-login',
        members,
    });
}

function sourceMember(repositoryKey, branchName, overrides) {
    return {
        repositoryKey,
        worktreeKey: {
            repositoryKey,
            canonicalWorktreePath: `/${repositoryKey.includes('alpha') ? 'alpha' : 'beta'}`
                + `/.worktrees/${branchName.split('/').pop()}`,
        },
        branchName,
        path: `/${repositoryKey.includes('alpha') ? 'alpha' : 'beta'}`
            + `/.worktrees/${branchName.split('/').pop()}`,
        state: 'ready',
        ...(overrides || {}),
    };
}

test('WORKTREE-GROUPS-DERIVE-001 the form context prechecks source repositories and overrides bases', async () => {
    const { controller, manifestStore } = fixture();
    const source = await createSourceGroup(manifestStore, [
        sourceMember('/alpha/.git', 'agent-pivot/fix-login'),
        sourceMember('/beta/.git', 'agent-pivot/fix-login-2'),
    ]);
    const context = await controller.deriveFormContext('project', source.groupId);
    assert.equal(context.sourceName, 'Fix login');
    assert.equal(context.suggestedName, 'Fix login-2');
    assert.deepEqual(context.checkedRepositories.sort(), ['/alpha/.git', '/beta/.git']);
    assert.deepEqual(context.baseOverrides, {
        '/alpha/.git': 'refs/heads/agent-pivot/fix-login',
        '/beta/.git': 'refs/heads/agent-pivot/fix-login-2',
    });
    assert.deepEqual(context.skipped, []);
    // The source group is never modified by deriving.
    assert.equal(manifestStore.listGroups(workspace.navigationIdentity)[0].revision, 1);
});

test('WORKTREE-GROUPS-DERIVE-001 name collisions advance the suffix', async () => {
    const { controller, manifestStore } = fixture();
    const source = await createSourceGroup(manifestStore, [
        sourceMember('/alpha/.git', 'agent-pivot/fix-login'),
    ]);
    await manifestStore.createGroup(workspace.navigationIdentity, {
        displayName: 'Fix login-2',
        suggestedSlug: 'fix-login-2',
        members: [sourceMember('/beta/.git', 'agent-pivot/fix-login-2')],
    });
    const context = await controller.deriveFormContext('project', source.groupId);
    assert.equal(context.suggestedName, 'Fix login-3');
});

test('WORKTREE-GROUPS-DERIVE-001 detached and unverifiable members are skipped with reasons', async () => {
    const { controller, manifestStore, options } = fixture();
    const source = await createSourceGroup(manifestStore, [
        sourceMember('/alpha/.git', 'agent-pivot/fix-login'),
        // A failed member whose branch was deleted: refs cannot verify it.
        sourceMember('/beta/.git', 'agent-pivot/gone-branch', {
            state: 'failed', worktreeKey: undefined,
        }),
    ]);
    await manifestStore.setRepositoryDetached(
        workspace.navigationIdentity, '/alpha/.git', true);
    const context = await controller.deriveFormContext('project', source.groupId);
    assert.deepEqual(context.checkedRepositories, []);
    assert.deepEqual(context.skipped, [
        { repositoryLabel: 'alpha', reason: 'repository not in workspace' },
        { repositoryLabel: 'beta', reason: 'source branch no longer exists' },
    ]);
    void options;
});

test('WORKTREE-GROUPS-DERIVE-001 confirm binds the source revision and rejects drift', async () => {
    const { controller, manifestStore } = fixture();
    const source = await createSourceGroup(manifestStore, [
        sourceMember('/alpha/.git', 'agent-pivot/fix-login'),
    ]);
    const preview = await controller.preview('project', 'Fix login-2', [{
        repositoryKey: '/alpha/.git',
        baseRef: 'refs/heads/agent-pivot/fix-login',
    }], source.groupId);
    assert.ok(preview.previewId);
    const confirmRequest = () => ({
        projectId: 'project',
        previewId: preview.previewId,
        displayName: 'Fix login-2',
        members: preview.members.map(member => ({
            repositoryKey: member.repositoryKey,
            baseRef: member.baseRef,
            branchName: member.branchName,
            worktreePath: member.worktreePath,
            setupEnabled: false,
        })),
    });
    // Rename the source: the revision moves and the confirm fails closed.
    await manifestStore.renameGroup(
        workspace.navigationIdentity, source.groupId, 'Fix login renamed');
    const drifted = await controller.confirm(confirmRequest());
    assert.deepEqual(drifted, { kind: 'failed', errorCode: 'group-changed' });
    assert.equal(manifestStore.listGroups(workspace.navigationIdentity).length, 1,
        'no group was created from the stale preview');
});

test('WORKTREE-GROUPS-DERIVE-001 ABA: a rename away and back still rejects the old preview', async () => {
    const { controller, manifestStore } = fixture();
    const source = await createSourceGroup(manifestStore, [
        sourceMember('/alpha/.git', 'agent-pivot/fix-login'),
    ]);
    const preview = await controller.preview('project', 'Fix login-2', [{
        repositoryKey: '/alpha/.git',
        baseRef: 'refs/heads/agent-pivot/fix-login',
    }], source.groupId);
    await manifestStore.renameGroup(
        workspace.navigationIdentity, source.groupId, 'Interim name');
    await manifestStore.renameGroup(
        workspace.navigationIdentity, source.groupId, 'Fix login');
    const result = await controller.confirm({
        projectId: 'project',
        previewId: preview.previewId,
        displayName: 'Fix login-2',
        members: preview.members.map(member => ({
            repositoryKey: member.repositoryKey,
            baseRef: member.baseRef,
            branchName: member.branchName,
            worktreePath: member.worktreePath,
            setupEnabled: false,
        })),
    });
    // The revision is monotonic: same name, different revision.
    assert.deepEqual(result, { kind: 'failed', errorCode: 'group-changed' });
});

test('WORKTREE-GROUPS-DERIVE-001 an unchanged source confirms and creates a new group', async () => {
    const { controller, manifestStore } = fixture();
    const source = await createSourceGroup(manifestStore, [
        sourceMember('/alpha/.git', 'agent-pivot/fix-login'),
    ]);
    const preview = await controller.preview('project', 'Fix login-2', [{
        repositoryKey: '/alpha/.git',
        baseRef: 'refs/heads/agent-pivot/fix-login',
    }], source.groupId);
    const result = await controller.confirm({
        projectId: 'project',
        previewId: preview.previewId,
        displayName: 'Fix login-2',
        members: preview.members.map(member => ({
            repositoryKey: member.repositoryKey,
            baseRef: member.baseRef,
            branchName: member.branchName,
            worktreePath: member.worktreePath,
            setupEnabled: false,
        })),
    });
    assert.equal(result.kind, 'created');
    const groups = manifestStore.listGroups(workspace.navigationIdentity);
    assert.equal(groups.length, 2);
    const derived = groups.find(group => group.groupId !== source.groupId);
    assert.equal(derived.displayName, 'Fix login-2');
    assert.equal(derived.members[0].branchName, preview.members[0].branchName);
    // The source group is untouched.
    assert.equal(manifestStore.listGroups(workspace.navigationIdentity)
        .find(group => group.groupId === source.groupId).revision, 1);
});
