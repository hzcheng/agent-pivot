'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeGroupCreationController,
} = require('../../../out/worktrees/groupCreationController');
const {
    WorktreeGroupManifestError,
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
        { id: 'root-gamma', name: 'gamma', uri: 'file:///gamma', hostPath: '/gamma', ordinal: 2 },
    ],
};

function repository(repositoryKey, rootId, worktreePath) {
    return {
        repositoryKey,
        rootBindings: [{ workspaceRootId: rootId, repositoryRelativePath: '' }],
        baseRef: 'refs/heads/main',
        worktrees: [{
            key: { repositoryKey, canonicalWorktreePath: worktreePath },
            branchRef: 'refs/heads/main', head: 'a'.repeat(40), isMain: true,
            isBare: false, health: 'normal', headKind: 'branch',
        }],
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
            repository('/gamma/.git', 'root-gamma', '/gamma'),
        ],
    };
    const started = [];
    const options = {
        getWorkspaceTarget: projectId => projectId === 'project' ? { workspace } : null,
        getWorktreeSnapshot: () => snapshot,
        listLocalBranches: async () => ['main'],
        isBranchAvailable: async () => true,
        isPathAvailable: async () => true,
        preflightPlan: async () => 'ok',
        getSetupCommand: () => [],
        getWorktreeDirectory: () => '.worktrees',
        getActiveEditorPath: () => undefined,
        manifestStore: manifestStoreHandle,
        startMemberOperation: async input => {
            started.push(input);
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
        started,
        options,
    };
}

async function createBaseGroup(store) {
    return store.createGroup(workspace.navigationIdentity, {
        displayName: 'Fix login',
        suggestedSlug: 'fix-login',
        members: [{
            repositoryKey: '/alpha/.git',
            worktreeKey: {
                repositoryKey: '/alpha/.git',
                canonicalWorktreePath: '/alpha/.worktrees/fix-login',
            },
            branchName: 'agent-pivot/fix-login',
            path: '/alpha/.worktrees/fix-login',
            state: 'ready',
        }],
    });
}

test('WORKTREE-GROUPS-ADD-REPO-001 add-repo options exclude member repositories and check only the active editor', async () => {
    const { controller, manifestStore } = fixture({
        getActiveEditorPath: () => '/beta/src/index.ts',
    });
    const group = await createBaseGroup(manifestStore);
    const result = await controller.listAddRepoOptions('project', group.groupId);
    assert.equal(result.group.displayName, 'Fix login');
    assert.deepEqual(result.options.map(option => option.repositoryKey).sort(),
        ['/beta/.git', '/gamma/.git'], 'member repositories are excluded');
    assert.deepEqual(result.options.filter(option => option.defaultChecked)
        .map(option => option.repositoryKey), ['/beta/.git'],
        'the active editor repository is prechecked');
    // Without an active editor nothing is prechecked (zero-selection gate).
    const plainFixture = fixture();
    const plainGroup = await createBaseGroup(plainFixture.manifestStore);
    const plain = await plainFixture.controller
        .listAddRepoOptions('project', plainGroup.groupId);
    assert.equal(plain.options.some(option => option.defaultChecked), false);
    // A vanished group yields no form.
    assert.equal(await controller.listAddRepoOptions('project', 'gone'), null);
});

test('WORKTREE-GROUPS-ADD-REPO-001 confirm adds members to the group with the locked slug', async () => {
    const { controller, manifestStore, started } = fixture();
    const group = await createBaseGroup(manifestStore);
    const revision = group.revision;
    const preview = await controller.preview('project', 'FORGED NAME', [{
        repositoryKey: '/beta/.git',
    }], undefined, group.groupId);
    // The group identity is authoritative: name and slug come from the
    // manifest, not from the request.
    assert.equal(preview.displayName, 'Fix login');
    assert.equal(preview.slug, 'fix-login');
    assert.match(preview.members[0].branchName, /^agent-pivot\/fix-login/);
    const result = await controller.confirm({
        projectId: 'project',
        previewId: preview.previewId,
        displayName: preview.displayName,
        targetGroupId: group.groupId,
        members: preview.members.map(member => ({
            repositoryKey: member.repositoryKey,
            baseRef: member.baseRef,
            branchName: member.branchName,
            worktreePath: member.worktreePath,
            setupEnabled: false,
        })),
    });
    assert.equal(result.kind, 'created');
    assert.equal(result.groupId, group.groupId, 'members join the SAME group');
    const updated = manifestStore.listGroups(workspace.navigationIdentity)[0];
    assert.equal(updated.members.length, 2);
    assert.ok(updated.revision > revision);
    assert.equal(started.length, 1, 'only the new member provisions');
    assert.equal(started[0].plan.slug, 'fix-login', 'the locked slug drives the plan');
});

test('WORKTREE-GROUPS-ADD-REPO-001 target drift and forged targets fail closed', async () => {
    const { controller, manifestStore } = fixture();
    const group = await createBaseGroup(manifestStore);
    const preview = await controller.preview('project', 'Fix login', [{
        repositoryKey: '/beta/.git',
    }], undefined, group.groupId);
    const members = () => preview.members.map(member => ({
        repositoryKey: member.repositoryKey,
        baseRef: member.baseRef,
        branchName: member.branchName,
        worktreePath: member.worktreePath,
        setupEnabled: false,
    }));
    // A forged target under a valid preview id is stale, not executable.
    const forged = await controller.confirm({
        projectId: 'project',
        previewId: preview.previewId,
        displayName: 'Fix login',
        members: members(),
    });
    assert.deepEqual(forged, { kind: 'failed', errorCode: 'preview-stale' });
    // A fresh preview, then a rename (revision bump) before confirm.
    const preview2 = await controller.preview('project', 'Fix login', [{
        repositoryKey: '/beta/.git',
    }], undefined, group.groupId);
    await manifestStore.renameGroup(
        workspace.navigationIdentity, group.groupId, 'Renamed group');
    const drifted = await controller.confirm({
        projectId: 'project',
        previewId: preview2.previewId,
        displayName: 'Renamed group',
        targetGroupId: group.groupId,
        members: preview2.members.map(member => ({
            repositoryKey: member.repositoryKey,
            baseRef: member.baseRef,
            branchName: member.branchName,
            worktreePath: member.worktreePath,
            setupEnabled: false,
        })),
    });
    // The rename locked a new slug, so the name/slug binding also moved.
    assert.equal(drifted.kind, 'failed');
    assert.equal(manifestStore.listGroups(workspace.navigationIdentity)[0].members.length, 1);
});

test('WORKTREE-GROUPS-ADD-REPO-001 addPlannedMembers validates repository uniqueness and lease', async () => {
    const { manifestStore } = fixture();
    const group = await createBaseGroup(manifestStore);
    const newMember = {
        repositoryKey: '/beta/.git',
        branchName: 'agent-pivot/fix-login',
        path: '/beta/.worktrees/fix-login',
        state: 'provisioning',
    };
    // Repository already in the group → conflict, zero side effects.
    await assert.rejects(manifestStore.addPlannedMembers(
        workspace.navigationIdentity, group.groupId, [{
            repositoryKey: '/alpha/.git',
            branchName: 'x', path: '/alpha/.worktrees/x', state: 'provisioning',
        }]),
        error => error instanceof WorktreeGroupManifestError
            && error.code === 'repository-conflict');
    // Empty additions are meaningless.
    await assert.rejects(manifestStore.addPlannedMembers(
        workspace.navigationIdentity, group.groupId, []),
        error => error instanceof WorktreeGroupManifestError
            && error.code === 'invalid-record');
    // An active deletion journal leases the group.
    const journal = await manifestStore.beginDeletion(workspace.navigationIdentity, {
        groupId: group.groupId, mode: 'member',
        memberIds: [group.members[0].memberId], nowMs: 100,
    });
    await assert.rejects(manifestStore.addPlannedMembers(
        workspace.navigationIdentity, group.groupId, [newMember]),
        error => error instanceof WorktreeGroupManifestError
            && error.code === 'group-leased');
    await manifestStore.abandonDeletion(workspace.navigationIdentity, journal.operationId);
    const updated = await manifestStore.addPlannedMembers(
        workspace.navigationIdentity, group.groupId, [newMember]);
    assert.equal(updated.members.length, 2);
    assert.equal(updated.members[1].state, 'provisioning');
});
