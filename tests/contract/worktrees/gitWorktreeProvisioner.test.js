'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    GitWorktreeProvisioner,
    GitWorktreeProvisioningError,
} = require('../../../out/worktrees/gitWorktreeProvisioner');

function git(cwd, args) {
    return childProcess.execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

async function repositoryFixture(t) {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-provision-'));
    const repositoryPath = path.join(sandbox, 'repository');
    await fs.promises.mkdir(repositoryPath);
    git(repositoryPath, ['init', '-b', 'main']);
    git(repositoryPath, ['config', 'user.name', 'Agent Pivot Tests']);
    git(repositoryPath, ['config', 'user.email', 'tests@example.invalid']);
    await fs.promises.writeFile(path.join(repositoryPath, 'README.md'), 'fixture\n');
    git(repositoryPath, ['add', 'README.md']);
    git(repositoryPath, ['commit', '-m', 'fixture']);
    const repositoryKey = await fs.promises.realpath(path.join(repositoryPath, '.git'));
    t.after(async () => fs.promises.rm(sandbox, { recursive: true, force: true }));
    return { sandbox, repositoryPath, repositoryKey };
}

function planFor(fixture, slug = 'fix-login-race') {
    return {
        repositoryKey: fixture.repositoryKey,
        commandCwd: fixture.repositoryPath,
        baseRef: 'refs/heads/main',
        taskName: 'Fix login race',
        slug,
        branchName: `agent-pivot/${slug}`,
        worktreePath: path.join(fixture.repositoryPath, '.agent-pivot', 'worktrees', slug),
    };
}

test('WORKTREE-PROVISIONING-GIT-001 creates and reconciles a real linked worktree', async t => {
    const fixture = await repositoryFixture(t);
    const plan = planFor(fixture);
    const provisioner = new GitWorktreeProvisioner();

    assert.equal(await provisioner.isBranchAvailable(plan.commandCwd, plan.branchName), true);
    assert.equal(await provisioner.isPathAvailable(plan.worktreePath), true);
    const key = await provisioner.createWorktree(plan, () => false);

    assert.deepEqual(key, {
        repositoryKey: fixture.repositoryKey,
        canonicalWorktreePath: await fs.promises.realpath(plan.worktreePath),
    });
    assert.equal(git(plan.worktreePath, ['branch', '--show-current']), plan.branchName);
    assert.equal(git(plan.worktreePath, ['rev-parse', 'HEAD']), git(fixture.repositoryPath, ['rev-parse', 'HEAD']));
    assert.equal(await provisioner.isBranchAvailable(plan.commandCwd, plan.branchName), false);
    assert.equal(await provisioner.isPathAvailable(plan.worktreePath), false);

    assert.deepEqual(await provisioner.createWorktree(plan, () => false), key,
        'a retry reconciles the already-created target instead of reporting a false conflict');
});

test('WORKTREE-PROVISIONING-GIT-001 names an unborn base ref instead of a bare invalid plan', async t => {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-provision-'));
    t.after(async () => fs.promises.rm(sandbox, { recursive: true, force: true }));
    const repositoryPath = path.join(sandbox, 'repository');
    await fs.promises.mkdir(repositoryPath);
    git(repositoryPath, ['init', '-b', 'main']);
    // No commit at all: the base ref is unborn and cannot parent a worktree.
    const repositoryKey = await fs.promises.realpath(path.join(repositoryPath, '.git'));
    const provisioner = new GitWorktreeProvisioner();
    const plan = {
        repositoryKey,
        commandCwd: repositoryPath,
        baseRef: 'refs/heads/main',
        taskName: 'Test',
        slug: 'test',
        branchName: 'agent-pivot/test',
        worktreePath: path.join(repositoryPath, '.worktrees', 'test'),
    };

    await assert.rejects(
        provisioner.createWorktree(plan, () => false),
        error => error instanceof GitWorktreeProvisioningError
            && error.code === 'repository-has-no-commits'
            && error.retryable === true
    );
});

test('WORKTREE-PROVISIONING-GIT-001 classifies real branch and path collisions', async t => {
    const fixture = await repositoryFixture(t);
    const provisioner = new GitWorktreeProvisioner();
    const branchCollision = planFor(fixture, 'existing-branch');
    git(fixture.repositoryPath, ['branch', branchCollision.branchName]);

    await assert.rejects(
        provisioner.createWorktree(branchCollision, () => false),
        error => error instanceof GitWorktreeProvisioningError
            && error.code === 'branch-conflict'
    );

    const pathCollision = planFor(fixture, 'existing-path');
    await fs.promises.mkdir(pathCollision.worktreePath, { recursive: true });
    await assert.rejects(
        provisioner.createWorktree(pathCollision, () => false),
        error => error instanceof GitWorktreeProvisioningError
            && error.code === 'path-conflict'
    );
    assert.equal(await provisioner.isBranchAvailable(
        pathCollision.commandCwd, pathCollision.branchName), true,
    'a path collision must not create its proposed branch');
});

test('WORKTREE-PROVISIONING-GIT-001 does not reconcile another branch at the target path', async t => {
    const fixture = await repositoryFixture(t);
    const provisioner = new GitWorktreeProvisioner();
    const plan = planFor(fixture, 'occupied-worktree');
    git(fixture.repositoryPath, [
        'worktree', 'add', '-b', 'agent-pivot/other-branch',
        plan.worktreePath, 'refs/heads/main',
    ]);

    await assert.rejects(
        provisioner.createWorktree(plan, () => false),
        error => error instanceof GitWorktreeProvisioningError
            && error.code === 'path-conflict'
    );
    assert.equal(git(plan.worktreePath, ['branch', '--show-current']),
        'agent-pivot/other-branch');
    assert.equal(await provisioner.isBranchAvailable(plan.commandCwd, plan.branchName), true);
});

test('WORKTREE-PROVISIONING-GIT-001 cancellation before mutation leaves Git untouched', async t => {
    const fixture = await repositoryFixture(t);
    const plan = planFor(fixture, 'cancelled-task');
    const provisioner = new GitWorktreeProvisioner();

    await assert.rejects(
        provisioner.createWorktree(plan, () => true),
        error => error instanceof GitWorktreeProvisioningError && error.code === 'cancelled'
    );
    assert.equal(await provisioner.isBranchAvailable(plan.commandCwd, plan.branchName), true);
    assert.equal(await provisioner.isPathAvailable(plan.worktreePath), true);
});

test('WORKTREE-PROVISIONING-GIT-001 rejects a plan whose command cwd belongs to another repository', async t => {
    const fixture = await repositoryFixture(t);
    const other = await repositoryFixture(t);
    const plan = {
        ...planFor(fixture, 'wrong-repository'),
        repositoryKey: other.repositoryKey,
    };
    const provisioner = new GitWorktreeProvisioner();

    await assert.rejects(
        provisioner.createWorktree(plan, () => false),
        error => error instanceof GitWorktreeProvisioningError && error.code === 'invalid-plan'
    );
    assert.equal(await provisioner.isBranchAvailable(
        fixture.repositoryPath, plan.branchName), true,
    'validation must fail before creating a branch in the command repository');
});

test('WORKTREE-PROVISIONING-GIT-001 reconciles success when the runner reports a late timeout', async t => {
    const fixture = await repositoryFixture(t);
    const plan = planFor(fixture, 'late-timeout');
    const { runGitCommand } = require('../../../out/worktrees/gitWorktreeDiscovery');
    let mutationCompleted = false;
    const provisioner = new GitWorktreeProvisioner({
        runGit: async (cwd, args) => {
            const result = await runGitCommand(cwd, args);
            if (args.includes('add') && result.exitCode === 0) {
                mutationCompleted = true;
                return { ...result, exitCode: null, timedOut: true };
            }
            return result;
        },
    });

    const key = await provisioner.createWorktree(plan, () => mutationCompleted);
    assert.equal(key.canonicalWorktreePath, await fs.promises.realpath(plan.worktreePath));
});

test('WORKTREE-PROVISIONING-RECOVERY-001 rejects a durable path whose branch changed', async t => {
    const fixture = await repositoryFixture(t);
    const plan = planFor(fixture, 'changed-after-reload');
    const provisioner = new GitWorktreeProvisioner();
    const key = await provisioner.createWorktree(plan, () => false);
    git(plan.worktreePath, ['checkout', '-b', 'agent-pivot/replaced']);

    await assert.rejects(
        provisioner.validateCreatedWorktree(plan, key),
        error => error instanceof GitWorktreeProvisioningError
            && error.code === 'worktree-create-failed'
    );
});
