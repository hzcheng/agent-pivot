'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    WorktreeGroupCreationController,
} = require('../../../out/worktrees/groupCreationController');
const {
    GitWorktreeProvisioner,
} = require('../../../out/worktrees/gitWorktreeProvisioner');
const {
    createWorktreeGroupManifestStore,
    worktreeGroupManifestStoreOf,
} = require('../../../out/worktrees/groupManifestStore');

function git(cwd, args) {
    return childProcess.execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

async function repositoryFixture(t, sandbox, name) {
    const repositoryPath = path.join(sandbox, name);
    await fs.promises.mkdir(repositoryPath);
    git(repositoryPath, ['init', '-b', 'main']);
    git(repositoryPath, ['config', 'user.name', 'Agent Pivot Tests']);
    git(repositoryPath, ['config', 'user.email', 'tests@example.invalid']);
    await fs.promises.writeFile(path.join(repositoryPath, 'README.md'), 'fixture\n');
    git(repositoryPath, ['add', 'README.md']);
    git(repositoryPath, ['commit', '-m', 'fixture']);
    return {
        repositoryPath,
        repositoryKey: await fs.promises.realpath(path.join(repositoryPath, '.git')),
        head: git(repositoryPath, ['rev-parse', 'refs/heads/main']),
    };
}

function memento() {
    const values = new Map();
    return {
        get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
        update: async (key, value) => {
            values.set(key, JSON.parse(JSON.stringify(value)));
        },
    };
}

/**
 * A two-repository workspace whose repositories really exist on disk; the
 * creation controller drives the REAL provisioner (no fakes anywhere in the
 * side-effect path).
 */
async function workspaceFixture(t) {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-group-e2e-'));
    t.after(async () => fs.promises.rm(sandbox, { recursive: true, force: true }));
    const alpha = await repositoryFixture(t, sandbox, 'alpha');
    const beta = await repositoryFixture(t, sandbox, 'beta');
    const workspace = {
        navigationIdentity: 'navigation:e2e',
        scopeIdentity: 'scope:e2e',
        kind: 'multiRoot',
        displayName: 'E2E',
        navigationUri: 'file:///e2e.code-workspace',
        environment: 'local',
        roots: [
            { id: 'root-alpha', name: 'alpha', uri: `file://${alpha.repositoryPath}`, hostPath: alpha.repositoryPath, ordinal: 0 },
            { id: 'root-beta', name: 'beta', uri: `file://${beta.repositoryPath}`, hostPath: beta.repositoryPath, ordinal: 1 },
        ],
    };
    const repositoryEntry = repository => ({
        repositoryKey: repository.repositoryKey,
        rootBindings: [{ workspaceRootId: repository.repositoryPath.endsWith('alpha') ? 'root-alpha' : 'root-beta', repositoryRelativePath: '' }],
        baseRef: 'refs/heads/main',
        worktrees: [{
            key: { repositoryKey: repository.repositoryKey, canonicalWorktreePath: repository.repositoryPath },
            branchRef: 'refs/heads/main', head: repository.head, isMain: true,
            isBare: false, health: 'normal', headKind: 'branch',
        }],
    });
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [repositoryEntry(alpha), repositoryEntry(beta)],
    };
    return { sandbox, alpha, beta, workspace, snapshot };
}

test('WORKTREE-PROVISIONING-GIT-001 a group confirm provisions real worktrees from the frozen baseline', async t => {
    const { alpha, beta, workspace, snapshot } = await workspaceFixture(t);
    const provisioner = new GitWorktreeProvisioner();
    const manifestStoreHandle = createWorktreeGroupManifestStore(memento());
    const manifestStore = worktreeGroupManifestStoreOf(manifestStoreHandle);
    const worktreeDirectory = '.agent-pivot/worktrees';
    const controller = new WorktreeGroupCreationController({
        getWorkspaceTarget: projectId => (projectId === 'project' ? { workspace } : null),
        getWorktreeSnapshot: () => snapshot,
        listLocalBranches: async commandCwd =>
            git(commandCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n'),
        isBranchAvailable: (commandCwd, branchName) =>
            provisioner.isBranchAvailable(commandCwd, branchName),
        isPathAvailable: worktreePath => provisioner.isPathAvailable(worktreePath),
        preflightPlan: plan => provisioner.preflightPlan(plan),
        getSetupCommand: () => [],
        getWorktreeDirectory: () => worktreeDirectory,
        getActiveEditorPath: () => undefined,
        manifestStore: manifestStoreHandle,
        resolveBaseCommit: (commandCwd, baseRef) =>
            provisioner.resolveBaseCommit(commandCwd, baseRef),
        startMemberOperation: async input => {
            // Mirror the production finalize path with the real provisioner.
            const worktreeKey = await provisioner.createWorktree(input.plan, () => false);
            await manifestStore.updateMember(
                workspace.navigationIdentity, input.groupId, input.memberId, {
                    state: 'ready',
                    worktreeKey,
                });
            return {
                kind: 'succeeded',
                operationId: input.operationId,
                worktreeKey,
                plan: input.plan,
            };
        },
        retryMemberOperation: async () => ({ kind: 'failed', operationId: 'x', errorCode: 'n/a' }),
        dismissMemberOperation: () => true,
        hasMemberOperation: () => false,
        onDidChange: () => {},
    });

    const preview = await controller.preview('project', 'Fix login', [
        { repositoryKey: alpha.repositoryKey },
        { repositoryKey: beta.repositoryKey },
    ]);
    assert.ok(preview.previewId, 'preview issued');

    const members = preview.members.map(member => ({
        repositoryKey: member.repositoryKey,
        baseRef: member.baseRef,
        branchName: member.branchName,
        worktreePath: member.worktreePath,
        setupEnabled: false,
    }));
    const result = await controller.confirm({
        projectId: 'project',
        previewId: preview.previewId,
        displayName: 'Fix login',
        members,
    });
    assert.equal(result.kind, 'created');

    // Both worktrees exist on disk, on branches cut from the frozen baseline.
    for (const repository of [alpha, beta]) {
        const worktreePath = path.join(repository.repositoryPath, worktreeDirectory, 'fix-login');
        assert.ok(fs.existsSync(path.join(worktreePath, 'README.md')),
            `${repository.repositoryPath} worktree materialized`);
        assert.equal(git(worktreePath, ['rev-parse', 'HEAD']), repository.head,
            'the new worktree HEAD is exactly the frozen baseline commit');
        assert.equal(
            git(repository.repositoryPath, ['rev-parse', 'refs/heads/agent-pivot/fix-login']),
            repository.head, 'the branch was created at the frozen commit');
    }

    // The manifest converged to ready members carrying the real worktree keys.
    const groups = manifestStore.listGroups(workspace.navigationIdentity);
    assert.equal(groups.length, 1);
    assert.ok(groups[0].members.every(member => member.state === 'ready'
        && member.worktreeKey && member.baseline
        && member.baseline.commitSha.length === 40));
});
