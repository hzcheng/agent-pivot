'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeGroupCreationController,
    memberOperationId,
} = require('../../../out/worktrees/groupCreationController');
const {
    WorktreeGroupManifestStore,
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
    const manifestStore = new WorktreeGroupManifestStore(memento());
    const changes = [];
    const started = [];
    const retried = [];
    const dismissed = [];
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [
            repository('/alpha/.git', 'root-alpha', '/alpha'),
            repository('/beta/.git', 'root-beta', '/beta'),
        ],
    };
    const options = {
        getWorkspaceTarget: projectId => projectId === 'project'
            ? { workspace } : null,
        getWorktreeSnapshot: () => snapshot,
        listLocalBranches: async () => ['main', 'release/1.0'],
        isBranchAvailable: async () => true,
        isPathAvailable: async () => true,
        preflightPlan: async () => 'ok',
        getSetupCommand: repositoryKey =>
            repositoryKey === '/beta/.git' ? ['make', 'setup'] : ['npm', 'ci'],
        getWorktreeDirectory: () => '.worktrees',
        getActiveEditorPath: () => undefined,
        manifestStore,
        startMemberOperation: async input => {
            started.push(input);
            // Simulate the production finalize hook: ready before settle.
            await manifestStore.updateMember(
                workspace.navigationIdentity, input.groupId, input.memberId, {
                    state: 'ready',
                    worktreeKey: {
                        repositoryKey: input.plan.repositoryKey,
                        canonicalWorktreePath: input.plan.worktreePath,
                    },
                });
            if (input.preferredPrimary) {
                await manifestStore.setPrimaryMember(
                    workspace.navigationIdentity, input.groupId, input.memberId);
            }
            return {
                kind: 'succeeded',
                operationId: input.operationId,
                worktreeKey: {
                    repositoryKey: input.plan.repositoryKey,
                    canonicalWorktreePath: input.plan.worktreePath,
                },
                plan: input.plan,
            };
        },
        retryMemberOperation: async (operationId, projectId) => {
            retried.push([operationId, projectId]);
            const memberId = operationId.replace('group-member-', '');
            const group = manifestStore
                .listGroups(workspace.navigationIdentity)
                .find(candidate => candidate.members.some(m => m.memberId === memberId));
            const member = group.members.find(m => m.memberId === memberId);
            await manifestStore.updateMember(
                workspace.navigationIdentity, group.groupId, memberId, {
                    state: 'ready',
                    worktreeKey: {
                        repositoryKey: member.repositoryKey,
                        canonicalWorktreePath: member.path,
                    },
                });
            return { kind: 'succeeded', operationId, worktreeKey: {}, plan: {} };
        },
        dismissMemberOperation: (operationId, projectId) => {
            dismissed.push([operationId, projectId]);
            return true;
        },
        onDidChange: () => changes.push(1),
        ...overrides,
    };
    return {
        controller: new WorktreeGroupCreationController(options),
        manifestStore,
        started,
        retried,
        dismissed,
        changes,
        snapshot,
        options,
    };
}

function confirmedMembers(overrides = {}) {
    return [
        {
            repositoryKey: '/alpha/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/alpha/.worktrees/fix-login',
            setupCommand: ['npm', 'ci'],
            ...(overrides.alpha || {}),
        },
        {
            repositoryKey: '/beta/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/beta/.worktrees/fix-login',
            setupCommand: ['make', 'setup'],
            ...(overrides.beta || {}),
        },
    ];
}

test('WORKTREE-GROUPS-CREATE-001 lists repository options with per-repo setup and defaults', async () => {
    const current = fixture({
        getActiveEditorPath: () => '/beta/src/index.ts',
    });
    const options = await current.controller.listRepositoryOptions('project');
    assert.equal(options.length, 2);
    assert.deepEqual(options.map(option => option.defaultChecked), [false, true],
        'the active editor repository is checked by default');
    assert.deepEqual(options[1].setupCommand, ['make', 'setup'],
        'setup resolves per repository');
    assert.deepEqual(options[0].localBranches, ['main', 'release/1.0']);
    assert.equal(options[0].defaultBaseRef, 'refs/heads/main');
});

test('WORKTREE-GROUPS-CREATE-001 preview computes per-member plans with visible auto-suffixes', async () => {
    const current = fixture({
        isBranchAvailable: async (_cwd, branch) =>
            branch !== 'agent-pivot/fix-login',
    });
    const preview = await current.controller.preview('project', 'Fix login', [
        { repositoryKey: '/alpha/.git' },
        { repositoryKey: '/beta/.git', baseRef: 'refs/heads/release/1.0' },
    ]);
    assert.equal(preview.slug, 'fix-login');
    assert.equal(preview.members.length, 2);
    assert.equal(preview.members[0].branchName, 'agent-pivot/fix-login-2',
        'a taken branch name auto-suffixes and stays visible in the preview');
    assert.match(preview.members[0].worktreePath, /fix-login-2$/);
    assert.equal(preview.members[1].baseRef, 'refs/heads/release/1.0',
        'the base-ref override applies per member');
    assert.equal(preview.members[0].preflight, 'ok');

    const cjk = await current.controller.preview('project', '修复', [
        { repositoryKey: '/alpha/.git' },
    ]);
    assert.equal(cjk.formError, undefined,
        'CJK names fall back to a task-<id> slug');
    assert.match(cjk.slug, /^task-/);
    const empty = await current.controller.preview('project', '  ', []);
    assert.equal(empty.formError, 'invalid-task');
});

test('WORKTREE-GROUPS-CREATE-001 preview surfaces per-member preflight blockers', async () => {
    const current = fixture({
        preflightPlan: async plan =>
            plan.repositoryKey === '/beta/.git' ? 'path-conflict' : 'ok',
    });
    const preview = await current.controller.preview('project', 'Fix login', [
        { repositoryKey: '/alpha/.git' },
        { repositoryKey: '/beta/.git' },
    ]);
    assert.equal(preview.members[0].preflight, 'ok');
    assert.deepEqual(preview.members[1].preflight, { code: 'path-conflict' });
});

test('WORKTREE-GROUPS-CREATE-001 confirm provisions the exact confirmed set in parallel', async () => {
    const current = fixture();
    const result = await current.controller.confirm({
        projectId: 'project',
        displayName: 'Fix login',
        members: confirmedMembers(),
        primaryRepositoryKey: '/beta/.git',
    });
    assert.equal(result.kind, 'created');
    const group = current.manifestStore
        .listGroups(workspace.navigationIdentity)
        .find(candidate => candidate.groupId === result.groupId);
    assert.equal(group.displayName, 'Fix login');
    assert.equal(group.members.length, 2);
    assert.ok(group.members.every(member => member.state === 'ready'));
    const primary = group.members.find(member => member.memberId === group.primaryMemberId);
    assert.equal(primary.repositoryKey, '/beta/.git',
        'the confirmed primary applies once its member is ready');

    assert.equal(current.started.length, 2);
    const alphaStart = current.started.find(input =>
        input.plan.repositoryKey === '/alpha/.git');
    assert.equal(alphaStart.plan.branchName, 'agent-pivot/fix-login',
        'execution uses the confirmed values verbatim, never re-derived');
    assert.equal(alphaStart.plan.worktreePath, '/alpha/.worktrees/fix-login');
    assert.deepEqual(alphaStart.setupCommand, ['npm', 'ci']);
    assert.equal(alphaStart.preferredPrimary, false);
    assert.ok(current.changes.length > 0, 'state transitions publish');
});

test('WORKTREE-GROUPS-CREATE-001 a failed member stays in the group with its error', async () => {
    const current = fixture({
        startMemberOperation: async input => {
            if (input.plan.repositoryKey === '/beta/.git') {
                return {
                    kind: 'partial',
                    operationId: input.operationId,
                    worktreeKey: {
                        repositoryKey: '/beta/.git',
                        canonicalWorktreePath: input.plan.worktreePath,
                    },
                    errorCode: 'branch-conflict',
                    completedSteps: [],
                };
            }
            await current.options.manifestStore.updateMember(
                workspace.navigationIdentity, input.groupId, input.memberId, {
                    state: 'ready',
                    worktreeKey: {
                        repositoryKey: input.plan.repositoryKey,
                        canonicalWorktreePath: input.plan.worktreePath,
                    },
                });
            return {
                kind: 'succeeded', operationId: input.operationId,
                worktreeKey: {}, plan: input.plan,
            };
        },
    });
    const result = await current.controller.confirm({
        projectId: 'project',
        displayName: 'Fix login',
        members: confirmedMembers(),
        primaryRepositoryKey: '/beta/.git',
    });
    assert.equal(result.kind, 'created');
    const group = current.manifestStore
        .listGroups(workspace.navigationIdentity)[0];
    const failed = group.members.find(member =>
        member.repositoryKey === '/beta/.git');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.lastError, 'branch-conflict',
        'an execution-time collision fails the member, never re-suffixes');
    assert.equal(group.primaryMemberId, null,
        'the failed confirmed primary leaves the group awaiting selection');
    assert.equal(group.members.find(member =>
        member.repositoryKey === '/alpha/.git').state, 'ready');
});

test('WORKTREE-GROUPS-CREATE-001 confirm rejects forged or duplicate member sets', async () => {
    const current = fixture();
    const duplicate = await current.controller.confirm({
        projectId: 'project',
        displayName: 'Fix login',
        members: [confirmedMembers()[0], {
            ...confirmedMembers()[0], worktreePath: '/alpha/.worktrees/other',
        }],
    });
    assert.deepEqual(duplicate, { kind: 'failed', errorCode: 'invalid-members' },
        'one repository contributes at most one member');
    const unmanaged = await current.controller.confirm({
        projectId: 'project',
        displayName: 'Fix login',
        members: [{
            ...confirmedMembers()[0], worktreePath: '/tmp/outside',
        }],
    });
    assert.deepEqual(unmanaged, { kind: 'failed', errorCode: 'invalid-members' },
        'paths outside the managed directory are rejected');
    const unknown = await current.controller.confirm({
        projectId: 'project',
        displayName: 'Fix login',
        members: [{
            ...confirmedMembers()[0], repositoryKey: '/gamma/.git',
        }],
    });
    assert.deepEqual(unknown, { kind: 'failed', errorCode: 'invalid-members' },
        'repositories outside the workspace snapshot are rejected');
    assert.equal(current.manifestStore.listGroups(workspace.navigationIdentity).length, 0,
        'rejected confirms write nothing');
});

test('WORKTREE-GROUPS-CREATE-001 preview recomputes only the affected repository', async () => {
    // PRD §6.1 增量重算: changing one repository's base ref must not re-run
    // git probes for the other rows; typing changes the slug everywhere.
    const branchProbes = [];
    const current = fixture({
        isBranchAvailable: async (cwd, branch) => {
            branchProbes.push([cwd, branch]);
            return true;
        },
    });
    const selections = [
        { repositoryKey: '/alpha/.git' },
        { repositoryKey: '/beta/.git' },
    ];
    await current.controller.preview('project', 'Fix login', selections);
    const firstRound = branchProbes.length;
    assert.ok(firstRound > 0);
    await current.controller.preview('project', 'Fix login', [
        selections[0],
        { repositoryKey: '/beta/.git', baseRef: 'refs/heads/release/1.0' },
    ]);
    const alphaProbes = branchProbes.slice(firstRound)
        .filter(probe => probe[0] === '/alpha');
    assert.deepEqual(alphaProbes, [],
        'an untouched repository reuses its memoized preview');
    assert.ok(branchProbes.slice(firstRound).some(probe => probe[0] === '/beta'),
        'the changed repository recomputes');
    await current.controller.preview('project', 'Fix logout', selections);
    assert.ok(branchProbes.slice(firstRound).some(probe => probe[0] === '/alpha'),
        'a new slug invalidates every row');
});

test('WORKTREE-GROUPS-CREATE-001 a throwing executor degrades the member without rejecting confirm', async () => {
    const current = fixture({
        startMemberOperation: async input => {
            if (input.plan.repositoryKey === '/beta/.git') {
                throw new Error('executor exploded');
            }
            await current.options.manifestStore.updateMember(
                workspace.navigationIdentity, input.groupId, input.memberId, {
                    state: 'ready',
                    worktreeKey: {
                        repositoryKey: input.plan.repositoryKey,
                        canonicalWorktreePath: input.plan.worktreePath,
                    },
                });
            return {
                kind: 'succeeded', operationId: input.operationId,
                worktreeKey: {}, plan: input.plan,
            };
        },
    });
    const result = await current.controller.confirm({
        projectId: 'project',
        displayName: 'Fix login',
        members: confirmedMembers(),
    });
    assert.equal(result.kind, 'created',
        'one member failure never rejects the whole confirm');
    const group = current.manifestStore.listGroups(workspace.navigationIdentity)[0];
    assert.equal(group.members.find(member =>
        member.repositoryKey === '/beta/.git').state, 'failed');
    assert.equal(group.members.find(member =>
        member.repositoryKey === '/alpha/.git').state, 'ready');
});

test('WORKTREE-GROUPS-CREATE-001 retry and dismiss follow the member lifecycle', async () => {
    const current = fixture({
        startMemberOperation: async input => ({
            kind: 'partial',
            operationId: input.operationId,
            worktreeKey: {
                repositoryKey: input.plan.repositoryKey,
                canonicalWorktreePath: input.plan.worktreePath,
            },
            errorCode: 'git-timeout',
            completedSteps: [],
        }),
    });
    const created = await current.controller.confirm({
        projectId: 'project',
        displayName: 'Fix login',
        members: [confirmedMembers()[0]],
    });
    const group = () => current.manifestStore
        .listGroups(workspace.navigationIdentity)
        .find(candidate => candidate.groupId === created.groupId);
    const member = () => group().members[0];
    assert.equal(member().state, 'failed');

    const retry = await current.controller.retryMember(
        'project', created.groupId, member().memberId);
    assert.equal(retry.kind, 'succeeded');
    assert.deepEqual(current.retried, [
        [memberOperationId(member().memberId), 'project'],
    ]);
    assert.equal(member().state, 'ready');

    // Force back to failed to exercise dismiss.
    await current.manifestStore.updateMember(
        workspace.navigationIdentity, created.groupId, member().memberId, {
            state: 'failed', lastError: 'git-timeout',
        });
    const dismissed = await current.controller.dismissMember(
        'project', created.groupId, member().memberId);
    assert.equal(dismissed, true);
    assert.equal(group(), undefined,
        'the group disappears with its last member');
    assert.equal(
        await current.controller.dismissMember('project', created.groupId, 'missing'),
        false);
});
