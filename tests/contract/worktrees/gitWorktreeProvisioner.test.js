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

test('WORKTREE-PROVISIONING-GIT-001 lists fetched remote branches and creates from their frozen commit', async t => {
    const fixture = await repositoryFixture(t);
    const mainHead = git(fixture.repositoryPath, ['rev-parse', 'HEAD']);
    git(fixture.repositoryPath, ['checkout', '-b', 'remote-release']);
    await fs.promises.writeFile(path.join(fixture.repositoryPath, 'REMOTE_BASE.md'), 'remote\n');
    git(fixture.repositoryPath, ['add', 'REMOTE_BASE.md']);
    git(fixture.repositoryPath, ['commit', '-m', 'remote release base']);
    const remoteHead = git(fixture.repositoryPath, ['rev-parse', 'HEAD']);
    git(fixture.repositoryPath, ['checkout', 'main']);
    git(fixture.repositoryPath, ['update-ref', 'refs/remotes/origin/release/1.0', remoteHead]);
    git(fixture.repositoryPath, ['update-ref', 'refs/remotes/upstream/feature/search', mainHead]);
    git(fixture.repositoryPath, [
        'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/1.0',
    ]);
    git(fixture.repositoryPath, [
        'symbolic-ref', 'refs/remotes/team/origin/HEAD', 'refs/remotes/origin/release/1.0',
    ]);
    const provisioner = new GitWorktreeProvisioner();

    assert.deepEqual(await provisioner.listRemoteBranches(fixture.repositoryPath), [
        'origin/release/1.0', 'upstream/feature/search',
    ], 'symbolic remote aliases are not actionable task baselines');

    git(fixture.repositoryPath, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    git(fixture.repositoryPath, ['update-ref', 'refs/remotes/origin/HEAD', remoteHead]);
    assert.ok((await provisioner.listRemoteBranches(fixture.repositoryPath)).includes('origin/HEAD'),
        'a direct remote-tracking ref is retained even when its short name ends in HEAD');

    const plan = {
        ...planFor(fixture, 'from-origin-release'),
        baseRef: 'refs/remotes/origin/release/1.0',
    };
    plan.baseline = await provisioner.resolveBaseCommit(plan.commandCwd, plan.baseRef);
    assert.ok(plan.baseline, 'the selected remote ref freezes to a commit before creation');
    git(fixture.repositoryPath, ['update-ref', '-d', 'refs/remotes/origin/release/1.0']);
    const key = await provisioner.createWorktree(plan, () => false);
    assert.equal(git(key.canonicalWorktreePath, ['rev-parse', 'HEAD']), remoteHead,
        'the new local branch starts at the selected remote commit after its ref is pruned');
    assert.notEqual(remoteHead, mainHead,
        'the assertion would fail if creation silently fell back to main');
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

test('WORKTREE-GROUPS-BASELINE-001 resolveBaseCommit classifies branch, tag, and commit bases', async t => {
    const fixture = await repositoryFixture(t);
    const provisioner = new GitWorktreeProvisioner();
    const headSha = git(fixture.repositoryPath, ['rev-parse', 'HEAD']);
    git(fixture.repositoryPath, ['tag', '-a', 'v1.0', '-m', 'release']);

    const branch = await provisioner.resolveBaseCommit(fixture.repositoryPath, 'main');
    assert.equal(branch.commitSha, headSha);
    assert.deepEqual(branch.source, { kind: 'branch', fullRef: 'refs/heads/main' });
    assert.ok(Number.isSafeInteger(branch.capturedAt));

    const tag = await provisioner.resolveBaseCommit(fixture.repositoryPath, 'v1.0');
    assert.equal(tag.commitSha, headSha,
        'an annotated tag resolves to the tagged commit');
    assert.deepEqual(tag.source, { kind: 'tag', fullRef: 'refs/tags/v1.0' });

    const commit = await provisioner.resolveBaseCommit(fixture.repositoryPath, headSha);
    assert.equal(commit.commitSha, headSha);
    assert.deepEqual(commit.source, { kind: 'commit' },
        'a raw SHA has no movable base ref');

    assert.equal(await provisioner.resolveBaseCommit(
        fixture.repositoryPath, 'does-not-exist'), undefined,
        'an unresolvable base refuses capture instead of guessing');
});

test('WORKTREE-GROUPS-BASELINE-001 createWorktree branches from the frozen baseline, not the moved base', async t => {
    const fixture = await repositoryFixture(t);
    const provisioner = new GitWorktreeProvisioner();
    const plan = planFor(fixture, 'frozen-baseline');

    // Capture the baseline, then advance the base branch: provisioning must
    // still start from the frozen SHA (changes-panel PRD §4.2).
    const baseline = await provisioner.resolveBaseCommit(plan.commandCwd, plan.baseRef);
    plan.baseline = baseline;
    await fs.promises.writeFile(path.join(fixture.repositoryPath, 'advanced.txt'), 'advanced\n');
    git(fixture.repositoryPath, ['add', 'advanced.txt']);
    git(fixture.repositoryPath, ['commit', '-m', 'base advances mid-provisioning']);
    const advancedSha = git(fixture.repositoryPath, ['rev-parse', 'HEAD']);
    assert.notEqual(advancedSha, baseline.commitSha);

    const key = await provisioner.createWorktree(plan, () => false);
    assert.equal(git(plan.worktreePath, ['rev-parse', 'HEAD']), baseline.commitSha,
        'git worktree add used the frozen SHA, not the advanced base ref');
    assert.equal(git(plan.worktreePath, ['branch', '--show-current']), plan.branchName);

    // The reconcile path (retry after a crash) verifies the anchor too.
    assert.deepEqual(await provisioner.createWorktree(plan, () => false), key);

    // A worktree whose HEAD diverged from the recorded baseline fails the
    // post-creation anchor check (branch still checked out, but moved).
    git(plan.worktreePath, ['reset', '--hard', advancedSha]);
    await assert.rejects(
        provisioner.createWorktree(plan, () => false),
        error => error instanceof GitWorktreeProvisioningError
            && error.code === 'worktree-create-failed');
});
