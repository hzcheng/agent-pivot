'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    IsolatedSessionController,
} = require('../../../out/worktrees/isolatedSessionController');

const workspace = {
    navigationIdentity: 'navigation:workspace',
    scopeIdentity: 'scope:workspace',
    kind: 'singleFolder',
    displayName: 'Workspace',
    navigationUri: 'file:///repo',
    environment: 'local',
    roots: [{ id: 'root', name: 'repo', uri: 'file:///repo', hostPath: '/repo', ordinal: 0 }],
};

function repository(repositoryKey = '/repo/.git', rootId = 'root', worktreePath = '/repo') {
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

function recoveryOperation() {
    return {
        version: 1,
        operationId: 'request-restored',
        projectId: 'project',
        providerId: 'codex',
        profile: { kind: 'base' },
        setupCommand: ['npm', 'ci'],
        plan: {
            repositoryKey: '/repo/.git', commandCwd: '/repo', baseRef: 'refs/heads/main',
            taskName: 'Restored task', slug: 'restored-task',
            branchName: 'agent-pivot/restored-task',
            worktreePath: '/repo/.agent-pivot/worktrees/restored-task',
        },
        completedSteps: ['worktree'],
        worktreeKey: {
            repositoryKey: '/repo/.git',
            canonicalWorktreePath: '/repo/.agent-pivot/worktrees/restored-task',
        },
        row: {
            kind: 'provisioning', operationId: 'request-restored', repositoryKey: '/repo/.git',
            taskName: 'Restored task', proposedPath: '/repo/.agent-pivot/worktrees/restored-task',
            stage: 'setting-up', completedSteps: ['worktree'], retryable: false, cancellable: true,
        },
    };
}

function fixture(overrides = {}) {
    const effects = [];
    const publications = [];
    const settlements = [];
    const persisted = [];
    const firstRepository = repository();
    const snapshot = {
        revision: 1,
        repositories: [firstRepository],
        truncatedWorktreeCount: 0,
    };
    const target = {
        cardId: 'project',
        workspace,
        sessions: {
            activeProvider: 'kimi',
            quickCreateProvider: 'codex',
            quickCreateProfile: 'glm',
        },
    };
    const provisioner = {
        isBranchAvailable: async (_cwd, branch) => {
            effects.push(['branch', branch]);
            return true;
        },
        isPathAvailable: async candidatePath => {
            effects.push(['path', candidatePath]);
            return true;
        },
        createWorktree: async (plan, isCancelled) => {
            effects.push(['create', plan, isCancelled()]);
            return {
                repositoryKey: plan.repositoryKey,
                canonicalWorktreePath: plan.worktreePath,
            };
        },
        validateCreatedWorktree: async () => undefined,
    };
    const controller = new IsolatedSessionController({
        getWorkspaceTarget: projectId => projectId === 'project' ? target : null,
        getWorktreeSnapshot: () => snapshot,
        getActiveEditorPath: () => undefined,
        isProviderId: value => ['codex', 'kimi', 'claude'].includes(value),
        isWorkspaceTrusted: () => true,
        showInputBox: async () => ' Fix login race ',
        showQuickPick: async items => items[0],
        refreshWorktreeSnapshot: async () => { effects.push(['refresh-snapshot']); },
        getSetupCommand: () => ['npm', 'ci'],
        runSetup: async (plan, worktreeKey, isCancelled, command) => {
            effects.push(['setup-command', plan.taskName, worktreeKey, isCancelled(), command]);
        },
        publishRows: (revision, rows) => publications.push({ revision, rows }),
        onSettled: outcome => settlements.push(outcome),
        persistOperations: operations => { persisted.push(operations); return Promise.resolve(); },
        provisioner,
        ...overrides,
    });
    return {
        controller, effects, publications, settlements, persisted, snapshot, target, provisioner,
    };
}

test('WORKTREE-ISOLATED-SESSION-001 provisions the worktree only and refreshes discovery', async () => {
    const current = fixture();

    const outcome = await current.controller.start('request-1', 'project');

    assert.equal(outcome.kind, 'succeeded');
    assert.equal(current.publications.at(-1).rows.length, 0);
    assert.deepEqual(current.publications.slice(0, -1).map(item => item.rows[0].stage), [
        'queued', 'creating', 'setting-up',
    ]);
    assert.deepEqual(current.effects.find(effect => effect[0] === 'setup-command')[4],
        ['npm', 'ci']);
    const create = current.effects.find(effect => effect[0] === 'create');
    assert.equal(create[1].taskName, 'Fix login race');
    assert.equal(create[1].branchName, 'agent-pivot/fix-login-race');
    assert.equal(create[1].worktreePath, '/repo/.worktrees/fix-login-race');
    assert.ok(current.effects.some(effect => effect[0] === 'refresh-snapshot'),
        'a finished worktree must refresh discovery so it appears in the list');
    assert.equal(current.effects.filter(effect => effect[0] === 'start-session').length, 0,
        'provisioning never starts a session; sessions are created from the row menu');
    assert.deepEqual(current.settlements, [outcome]);
});

test('WORKTREE-ISOLATED-SESSION-001 branches a new worktree from the selected worktree branch', async () => {
    const current = fixture();
    current.snapshot.repositories[0].worktrees.push({
        key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo-feature' },
        branchRef: 'refs/heads/feature/auth', head: 'b'.repeat(40), isMain: false,
        isBare: false, health: 'normal', headKind: 'branch',
    });

    const outcome = await current.controller.start('request-branch', 'project', {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo-feature',
    });

    assert.equal(outcome.kind, 'succeeded');
    const create = current.effects.find(effect => effect[0] === 'create');
    assert.equal(create[1].baseRef, 'refs/heads/feature/auth',
        'the plan must branch from the selected worktree, not the default base ref');
});

test('WORKTREE-ISOLATED-SESSION-001 rejects source worktrees outside the snapshot or workspace', async () => {
    const current = fixture();

    const unknown = await current.controller.start('request-unknown', 'project', {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/not-in-snapshot',
    });
    assert.deepEqual(unknown, {
        kind: 'rejected', operationId: 'request-unknown', errorCode: 'base-ref-unavailable',
    });

    const foreign = await current.controller.start('request-foreign', 'project', {
        repositoryKey: '/foreign/.git',
        canonicalWorktreePath: '/foreign',
    });
    assert.deepEqual(foreign, {
        kind: 'rejected', operationId: 'request-foreign', errorCode: 'base-ref-unavailable',
    });
    assert.equal(current.effects.filter(effect => effect[0] === 'create').length, 0,
        'rejected source worktrees must never reach Git');
});

test('WORKTREE-PROVISIONING-RECOVERY-001 restores an interrupted operation and freezes setup argv', async () => {
    const current = fixture({
        recoveredOperations: [recoveryOperation()],
        getSetupCommand: () => ['pnpm', 'install'],
    });

    assert.equal(current.controller.getRows()[0].errorCode, 'interrupted');
    const outcome = await current.controller.retry('request-restored', 'project');
    assert.equal(outcome.kind, 'succeeded');
    assert.deepEqual(current.effects.filter(effect => effect[0] === 'create'), []);
    assert.deepEqual(current.effects.find(effect => effect[0] === 'setup-command')[4],
        ['npm', 'ci']);
});

test('WORKTREE-PROVISIONING-RECOVERY-001 blocks restored side effects in an untrusted workspace', async () => {
    const current = fixture({
        recoveredOperations: [recoveryOperation()],
        isWorkspaceTrusted: () => false,
    });

    const outcome = await current.controller.retry('request-restored', 'project');
    assert.equal(outcome.errorCode, 'workspace-untrusted');
    assert.deepEqual(current.effects.filter(effect =>
        effect[0] === 'setup-command' || effect[0] === 'start-session'), []);
    assert.equal(current.controller.getRows()[0].errorCode, 'interrupted');
});

test('WORKTREE-ISOLATED-SESSION-001 active editor chooses one repository before the fallback picker', async () => {
    const current = fixture();
    current.snapshot.repositories.push(repository('/nested/.git', 'root', '/repo/packages/nested'));
    let picks = 0;
    const controller = new IsolatedSessionController({
        getWorkspaceTarget: () => current.target,
        getWorktreeSnapshot: () => current.snapshot,
        getActiveEditorPath: () => '/repo/packages/nested/src/index.ts',
        isProviderId: value => ['codex', 'kimi', 'claude'].includes(value),
        isWorkspaceTrusted: () => true,
        showInputBox: async () => 'Nested task',
        showQuickPick: async () => { picks += 1; return undefined; },
        refreshWorktreeSnapshot: async () => undefined,
        publishRows: () => undefined,
        provisioner: current.provisioner,
    });

    const outcome = await controller.start('request-nested', 'project');
    assert.equal(outcome.kind, 'succeeded');
    assert.equal(outcome.worktreeKey.repositoryKey, '/nested/.git');
    assert.equal(picks, 0);
});

test('WORKTREE-ISOLATED-SESSION-001 cancellation and duplicate preparation do not publish phantom rows', async () => {
    let releaseInput;
    const input = new Promise(resolve => { releaseInput = resolve; });
    const current = fixture({ showInputBox: () => input });

    const pending = current.controller.start('request-prompt', 'project');
    assert.deepEqual(await current.controller.start('request-prompt', 'project'), {
        kind: 'rejected', operationId: 'request-prompt', errorCode: 'duplicate-operation',
    });
    releaseInput(undefined);
    assert.deepEqual(await pending, { kind: 'cancelled', operationId: 'request-prompt' });
    assert.deepEqual(current.publications, []);
    assert.deepEqual(current.effects, []);
});

test('WORKTREE-ISOLATED-SESSION-001 rejects untrusted workspaces before prompts or Git checks', async () => {
    const current = fixture({ isWorkspaceTrusted: () => false });
    assert.deepEqual(await current.controller.start('request-untrusted', 'project'), {
        kind: 'rejected', operationId: 'request-untrusted', errorCode: 'workspace-untrusted',
    });
    assert.deepEqual(current.effects, []);
    assert.deepEqual(current.publications, []);
});

test('WORKTREE-ISOLATED-SESSION-001 reallocates after a pre-create branch collision', async () => {
    let createAttempts = 0;
    let collided = false;
    const current = fixture({
        provisioner: {
            isBranchAvailable: async (_cwd, branchName) =>
                !(collided && branchName === 'agent-pivot/fix-login-race'),
            isPathAvailable: async () => true,
            createWorktree: async plan => {
                createAttempts += 1;
                if (createAttempts === 1) {
                    collided = true;
                    throw Object.assign(new Error('race'), { code: 'branch-conflict' });
                }
                return {
                    repositoryKey: plan.repositoryKey,
                    canonicalWorktreePath: plan.worktreePath,
                };
            },
            validateCreatedWorktree: async () => undefined,
        },
    });

    const failed = await current.controller.start('request-collision', 'project');
    assert.equal(failed.errorCode, 'branch-conflict');
    const succeeded = await current.controller.retry('request-collision', 'project');
    assert.equal(succeeded.kind, 'succeeded');
    assert.equal(succeeded.worktreeKey.canonicalWorktreePath,
        '/repo/.worktrees/fix-login-race-2');
    assert.equal(createAttempts, 2);
});

test('WORKTREE-PROVISIONING-PROTOCOL-001 dismiss drops a failed row only from its own project', async () => {
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.start('request-dismiss', 'project');
    assert.equal(current.controller.getRows()[0].stage, 'failed');

    assert.equal(current.controller.dismiss('request-dismiss', 'forged-project'), false,
        'another project cannot dismiss the row');
    assert.equal(current.controller.getRows().length, 1);
    assert.equal(current.controller.dismiss('request-dismiss', 'project'), true);
    assert.deepEqual(current.controller.getRows(), []);
    assert.equal(current.persisted.at(-1).length, 0,
        'dismissal clears the persisted recovery record');
});

test('WORKTREE-PROVISIONING-PROTOCOL-001 rejects retry and cancel from another project scope', async () => {
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.start('request-scoped', 'project');

    assert.equal((await current.controller.retry('request-scoped', 'forged-project')).errorCode,
        'retry-unavailable');
    assert.equal(current.controller.cancel('request-scoped', 'forged-project'), false);
    assert.equal(current.controller.getRows()[0].retryable, true);
});
