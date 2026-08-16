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
        hasMemberOperation: operationId =>
            dismissed.every(entry => entry[0] !== operationId)
                && started.every(input => input.operationId !== operationId),
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


async function previewIdFor(current, repositories = ['/alpha/.git', '/beta/.git']) {
    const preview = await current.controller.preview('project', 'Fix login',
        repositories.map(repositoryKey => ({ repositoryKey })));
    return preview.previewId;
}

function confirmedMembers(overrides = {}) {
    return [
        {
            repositoryKey: '/alpha/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/alpha/.worktrees/fix-login',
            setupEnabled: true,
            ...(overrides.alpha || {}),
        },
        {
            repositoryKey: '/beta/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/beta/.worktrees/fix-login',
            setupEnabled: true,
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
        previewId: await previewIdFor(current),
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
        previewId: await previewIdFor(current),
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

test('WORKTREE-GROUPS-CREATE-001 a failed member settlement is logged with its error code', async () => {
    const logged = [];
    const current = fixture({
        onError: (message, error) => logged.push([message, error]),
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
                    completedSteps: ['worktree'],
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
        previewId: await previewIdFor(current),
        displayName: 'Fix login',
        members: confirmedMembers(),
    });
    assert.equal(result.kind, 'created');
    const group = current.manifestStore
        .listGroups(workspace.navigationIdentity)[0];
    const failed = group.members.find(member =>
        member.repositoryKey === '/beta/.git');
    const entry = logged.find(([message]) =>
        message.includes('settled without success'));
    assert.ok(entry, 'a non-success settlement must reach the diagnostic sink');
    assert.ok(entry[0].includes('kind=partial'));
    assert.ok(entry[0].includes('error=branch-conflict'));
    assert.ok(entry[0].includes('completedSteps=worktree'));
    assert.ok(entry[0].includes(`groupId=${group.groupId}`));
    assert.ok(entry[0].includes(`memberId=${failed.memberId}`));
});

test('WORKTREE-GROUPS-CREATE-001 a settlement persist failure is logged without rejecting confirm', async () => {
    const logged = [];
    const current = fixture({
        onError: (message, error) => logged.push([message, error]),
        startMemberOperation: async input => {
            if (input.plan.repositoryKey === '/beta/.git') {
                return {
                    kind: 'partial',
                    operationId: input.operationId,
                    worktreeKey: {
                        repositoryKey: '/beta/.git',
                        canonicalWorktreePath: input.plan.worktreePath,
                    },
                    errorCode: 'setup-failed',
                    completedSteps: ['worktree'],
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
    // The settle-time state write races a dismissed record: updateMember
    // throws, and runMember must log instead of swallowing silently.
    const originalUpdateMember = current.manifestStore.updateMember.bind(
        current.manifestStore);
    current.manifestStore.updateMember = async (identity, groupId, memberId, patch) => {
        if (patch && patch.state === 'failed') {
            throw new Error('member-not-found');
        }
        return originalUpdateMember(identity, groupId, memberId, patch);
    };
    const result = await current.controller.confirm({
        projectId: 'project',
        previewId: await previewIdFor(current),
        displayName: 'Fix login',
        members: confirmedMembers(),
    });
    assert.equal(result.kind, 'created',
        'a settle persist failure never rejects the whole confirm');
    const entry = logged.find(([message]) =>
        message.includes('Failed to persist worktree group member outcome'));
    assert.ok(entry, 'a settlement persist failure must reach the diagnostic sink');
    assert.ok(entry[0].includes('outcome=partial/setup-failed'));
    assert.ok(entry[1] instanceof Error);
    assert.equal(entry[1].message, 'member-not-found');
});

test('WORKTREE-GROUPS-CREATE-001 confirm rejects forged or duplicate member sets', async () => {
    const current = fixture();
    const duplicate = await current.controller.confirm({
        projectId: 'project',
        previewId: await previewIdFor(current),
        displayName: 'Fix login',
        members: [confirmedMembers()[0], {
            ...confirmedMembers()[0], worktreePath: '/alpha/.worktrees/other',
        }],
    });
    assert.deepEqual(duplicate, { kind: 'failed', errorCode: 'invalid-members' },
        'one repository contributes at most one member');
    const unmanaged = await current.controller.confirm({
        projectId: 'project',
        previewId: await previewIdFor(current),
        displayName: 'Fix login',
        members: [{
            ...confirmedMembers()[0], worktreePath: '/tmp/outside',
        }],
    });
    assert.equal(unmanaged.kind, 'failed',
        'paths outside the managed directory are rejected');
    const unknown = await current.controller.confirm({
        projectId: 'project',
        previewId: await previewIdFor(current),
        displayName: 'Fix login',
        members: [{
            ...confirmedMembers()[0], repositoryKey: '/gamma/.git',
        }],
    });
    assert.equal(unknown.kind, 'failed',
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

test('WORKTREE-GROUPS-CREATE-001 memo keys never collide across concatenation boundaries', async () => {
    // Regression: base refs/heads/a + name "bc" and refs/heads/ab + name
    // "c" produced the same concatenated key and reused the wrong plan.
    const branchProbes = [];
    const current = fixture({
        isBranchAvailable: async (cwd, branch) => {
            branchProbes.push([cwd, branch]);
            return true;
        },
    });
    const first = await current.controller.preview('project', 'bc', [
        { repositoryKey: '/alpha/.git', baseRef: 'refs/heads/a' },
    ]);
    const second = await current.controller.preview('project', 'c', [
        { repositoryKey: '/alpha/.git', baseRef: 'refs/heads/ab' },
    ]);
    assert.equal(first.members[0].baseRef, 'refs/heads/a');
    assert.equal(second.members[0].baseRef, 'refs/heads/ab',
        'the second preview must not reuse the first result');
    assert.match(second.members[0].branchName, /^agent-pivot\/task-[a-f0-9]{6}$/,
        'a one-character name falls back to a task-<id> slug (PRD §5.2)');
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
        previewId: await previewIdFor(current),
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

test('WORKTREE-GROUPS-CREATE-001 a setup configuration change rejects the stale preview', async () => {
    // Preview shows npm ci; if the configuration changes before confirm,
    // the host must reject instead of executing a command the user never
    // saw (PRD §6.1 预览值与执行值逐项一致).
    let setup = ['npm', 'ci'];
    const current = fixture({
        getSetupCommand: () => setup,
    });
    const previewId = await previewIdFor(current);
    setup = ['make', 'setup'];
    const rejected = await current.controller.confirm({
        projectId: 'project',
        previewId,
        displayName: 'Fix login',
        members: confirmedMembers(),
    });
    assert.deepEqual(rejected, { kind: 'failed', errorCode: 'preview-stale' });
    assert.equal(current.manifestStore.listGroups(workspace.navigationIdentity).length, 0,
        'a stale confirm writes nothing');

    const fresh = await current.controller.preview('project', 'Fix login', [
        { repositoryKey: '/alpha/.git' }, { repositoryKey: '/beta/.git' },
    ]);
    const accepted = await current.controller.confirm({
        projectId: 'project',
        previewId: fresh.previewId,
        displayName: 'Fix login',
        members: confirmedMembers(),
    });
    assert.equal(accepted.kind, 'created', 'a fresh preview confirms');
    const alphaStart = current.started.find(input =>
        input.plan.repositoryKey === '/alpha/.git');
    assert.deepEqual(alphaStart.setupCommand, ['make', 'setup'],
        'execution uses the refreshed configuration the user just saw');
});

test('WORKTREE-GROUPS-CREATE-001 a forged plan under a valid previewId is rejected', async () => {
    // The preview snapshot binds the full plan: tampering with the branch
    // or path is stale, never executable.
    const current = fixture();
    const previewId = await previewIdFor(current);
    const forged = confirmedMembers();
    forged[0] = {
        ...forged[0],
        branchName: 'agent-pivot/forged',
        worktreePath: '/alpha/.worktrees/forged',
    };
    const rejected = await current.controller.confirm({
        projectId: 'project',
        previewId,
        displayName: 'Fix login',
        members: forged,
    });
    assert.deepEqual(rejected, { kind: 'failed', errorCode: 'preview-stale' });
    assert.equal(current.manifestStore.listGroups(workspace.navigationIdentity).length, 0);
    assert.equal(current.started.length, 0, 'nothing reaches provisioning');

    const baseRefForged = confirmedMembers();
    baseRefForged[1] = { ...baseRefForged[1], baseRef: 'refs/heads/release/1.0' };
    const rejectedRef = await current.controller.confirm({
        projectId: 'project',
        previewId,
        displayName: 'Fix login',
        members: baseRefForged,
    });
    assert.equal(rejectedRef.errorCode, 'preview-stale');
});

test('WORKTREE-GROUPS-CREATE-001 execution uses the frozen preview argv', async () => {
    // Config reads: 2 at preview, 2 at confirm validation. Any read after
    // that would observe a changed config; execution must use the frozen
    // preview argv instead.
    let reads = 0;
    const current = fixture({
        getSetupCommand: repositoryKey => {
            reads += 1;
            return reads <= 4
                ? (repositoryKey === '/beta/.git' ? ['make', 'setup'] : ['npm', 'ci'])
                : ['late', 'change'];
        },
    });
    const previewId = await previewIdFor(current);
    const result = await current.controller.confirm({
        projectId: 'project',
        previewId,
        displayName: 'Fix login',
        members: confirmedMembers(),
    });
    assert.equal(result.kind, 'created');
    const alphaStart = current.started.find(input =>
        input.plan.repositoryKey === '/alpha/.git');
    assert.deepEqual(alphaStart.setupCommand, ['npm', 'ci'],
        'the executed argv is the one the user reviewed');
});

test('WORKTREE-GROUPS-CREATE-001 a forged display name under a valid previewId is rejected', async () => {
    const current = fixture();
    const previewId = await previewIdFor(current);
    const rejected = await current.controller.confirm({
        projectId: 'project',
        previewId,
        displayName: 'Forged label',
        members: confirmedMembers(),
    });
    assert.deepEqual(rejected, { kind: 'failed', errorCode: 'preview-stale' });
    assert.equal(current.manifestStore.listGroups(workspace.navigationIdentity).length, 0,
        'a forged identity writes nothing');
});

test('WORKTREE-GROUPS-CREATE-001 a slower preview never overwrites a newer snapshot', async () => {
    // Compare-and-set by serial: preview A starts first but finishes after
    // preview B; the host snapshot must stay B's.
    let gate;
    const gatePromise = new Promise(resolve => { gate = resolve; });
    let preflightCalls = 0;
    const current = fixture({
        preflightPlan: async plan => {
            preflightCalls += 1;
            if (preflightCalls === 1) {
                await gatePromise;
            }
            return 'ok';
        },
    });
    const slow = current.controller.preview('project', 'Fix login', [
        { repositoryKey: '/alpha/.git' },
    ]);
    const fast = await current.controller.preview('project', 'Fix logout', [
        { repositoryKey: '/alpha/.git' },
    ]);
    gate();
    const slowResult = await slow;

    // The fast preview is the live snapshot; confirming against it works.
    const accepted = await current.controller.confirm({
        projectId: 'project',
        previewId: fast.previewId,
        displayName: 'Fix logout',
        members: [{
            repositoryKey: '/alpha/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/fix-logout',
            worktreePath: '/alpha/.worktrees/fix-logout',
            setupEnabled: true,
        }],
    });
    assert.equal(accepted.kind, 'created',
        'the newest preview snapshot confirms');
    const stale = await current.controller.confirm({
        projectId: 'project',
        previewId: slowResult.previewId,
        displayName: 'Fix login',
        members: [{
            repositoryKey: '/alpha/.git', baseRef: 'refs/heads/main',
            branchName: 'agent-pivot/fix-login',
            worktreePath: '/alpha/.worktrees/fix-login',
            setupEnabled: true,
        }],
    });
    assert.equal(stale.errorCode, 'preview-stale',
        'the slower preview never became the authoritative snapshot');
});

test('WORKTREE-GROUPS-CREATE-001 a preview token is single-use across replays and races', async () => {
    const current = fixture();
    const previewId = await previewIdFor(current);
    const first = await current.controller.confirm({
        projectId: 'project',
        previewId,
        displayName: 'Fix login',
        members: confirmedMembers(),
    });
    assert.equal(first.kind, 'created');
    const replay = await current.controller.confirm({
        projectId: 'project',
        previewId,
        displayName: 'Fix login',
        members: confirmedMembers(),
    });
    assert.equal(replay.errorCode, 'preview-stale',
        'a replayed token never provisions twice');
    assert.equal(current.manifestStore.listGroups(workspace.navigationIdentity).length, 1);

    // Concurrent confirms with the same token: exactly one wins.
    const second = await current.controller.preview('project', 'Fix login', [
        { repositoryKey: '/alpha/.git' }, { repositoryKey: '/beta/.git' },
    ]);
    const [winner, loser] = await Promise.all([
        current.controller.confirm({
            projectId: 'project', previewId: second.previewId,
            displayName: 'Fix login', members: confirmedMembers(),
        }),
        current.controller.confirm({
            projectId: 'project', previewId: second.previewId,
            displayName: 'Fix login', members: confirmedMembers(),
        }),
    ]);
    const outcomes = [winner, loser].map(outcome => outcome.kind).sort();
    assert.deepEqual(outcomes, ['created', 'failed'],
        'concurrent confirms settle exactly once');
});

test('WORKTREE-GROUPS-CREATE-001 a full tombstone bucket refuses the dismiss as store-full', async () => {
    const current = fixture({
        startMemberOperation: async input => ({
            kind: 'partial',
            operationId: input.operationId,
            worktreeKey: {
                repositoryKey: input.plan.repositoryKey,
                canonicalWorktreePath: input.plan.worktreePath,
            },
            errorCode: 'setup-failed',
            completedSteps: ['worktree'],
        }),
        memberDismissNeedsTombstone: () => true,
        isTombstoneStoreFull: () => true,
    });
    const created = await current.controller.confirm({
        projectId: 'project',
        previewId: await previewIdFor(current, ['/alpha/.git']),
        displayName: 'Fix login',
        members: [confirmedMembers()[0]],
    });
    const member = current.manifestStore
        .listGroups(workspace.navigationIdentity)[0].members[0];
    const dismissed = await current.controller.dismissMember(
        'project', created.groupId, member.memberId);
    assert.equal(dismissed, 'store-full',
        'the dismiss is refused instead of evicting another protection record');
    assert.equal(current.manifestStore
        .listGroups(workspace.navigationIdentity)[0].members.length, 1,
        'the member stays in the manifest');
});

test('WORKTREE-GROUPS-CREATE-001 dismissing a member without a recovery record writes a synthetic tombstone', async () => {
    const tombstones = [];
    const current = fixture({
        hasMemberOperation: () => false,
        writeSyntheticTombstone: async input => {
            tombstones.push(input);
            return true;
        },
        isTombstoneStoreFull: () => false,
    });
    const created = await current.controller.confirm({
        projectId: 'project',
        previewId: await previewIdFor(current, ['/alpha/.git']),
        displayName: 'Fix login',
        members: [confirmedMembers()[0]],
    });
    const group = current.manifestStore.listGroups(workspace.navigationIdentity)[0];
    await current.manifestStore.updateMember(
        workspace.navigationIdentity, group.groupId, group.members[0].memberId, {
            state: 'failed', lastError: 'setup-failed',
        });

    const dismissed = await current.controller.dismissMember(
        'project', group.groupId, group.members[0].memberId);
    assert.equal(dismissed, 'dismissed');
    assert.equal(tombstones.length, 1,
        'a missing recovery record still leaves a seeding tombstone');
    assert.equal(tombstones[0].worktreePath, '/alpha/.worktrees/fix-login');
    assert.equal(current.manifestStore.listGroups(workspace.navigationIdentity).length, 0);

    // And when the tombstone write itself fails, the member stays.
    const second = await current.controller.confirm({
        projectId: 'project',
        previewId: await previewIdFor(current, ['/alpha/.git']),
        displayName: 'Fix login',
        members: [confirmedMembers()[0]],
    });
    const group2 = current.manifestStore.listGroups(workspace.navigationIdentity)[0];
    await current.manifestStore.updateMember(
        workspace.navigationIdentity, group2.groupId, group2.members[0].memberId, {
            state: 'failed', lastError: 'setup-failed',
        });
    current.options.writeSyntheticTombstone = async () => false;
    assert.equal(
        await current.controller.dismissMember('project', group2.groupId, group2.members[0].memberId),
        'unavailable');
    assert.equal(current.manifestStore.listGroups(workspace.navigationIdentity).length, 1,
        'the member is never removed without protection');
});

test('WORKTREE-GROUPS-CREATE-001 a windows-style editor path matches case-insensitively', async () => {
    const current = fixture({
        getActiveEditorPath: () => 'c:\\BETA\\src\\index.ts',
    });
    current.snapshot.repositories[1].worktrees[0].key.canonicalWorktreePath = 'C:\\beta';
    const options = await current.controller.listRepositoryOptions('project');
    assert.deepEqual(options.map(option => option.defaultChecked), [false, true],
        'windows paths match case-insensitively');
});

test('WORKTREE-GROUPS-CREATE-001 a windows-style editor path still picks its repository', async () => {
    const current = fixture({
        getActiveEditorPath: () => 'C:\\beta\\src\\index.ts',
    });
    current.snapshot.repositories[1].worktrees[0].key.canonicalWorktreePath = 'C:\\beta';
    const options = await current.controller.listRepositoryOptions('project');
    assert.deepEqual(options.map(option => option.defaultChecked), [false, true],
        'backslash paths match their worktree');
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
        previewId: await previewIdFor(current, ['/alpha/.git']),
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
    assert.equal(dismissed, 'dismissed');
    assert.equal(group(), undefined,
        'the group disappears with its last member');
    assert.equal(
        await current.controller.dismissMember('project', created.groupId, 'missing'),
        'unavailable');
});
