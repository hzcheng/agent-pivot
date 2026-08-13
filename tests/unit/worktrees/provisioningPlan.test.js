'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeProvisioningPlanError,
    createWorktreeProvisioningPlan,
    slugifyTaskName,
} = require('../../../out/worktrees/provisioningPlan');

function repository(overrides = {}) {
    return {
        repositoryKey: '/repo/.git',
        rootBindings: [{ workspaceRootId: 'root', repositoryRelativePath: '' }],
        baseRef: 'refs/heads/main',
        worktrees: [{
            key: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/repo' },
            branchRef: 'refs/heads/main', head: 'a'.repeat(40), isMain: true,
            isBare: false, health: 'normal', headKind: 'branch',
        }],
        ...overrides,
    };
}

test('WORKTREE-PROVISIONING-PLAN-001 derives bounded stable slugs', () => {
    assert.equal(slugifyTaskName('  Fix login race condition  '), 'fix-login-race-condition');
    assert.equal(slugifyTaskName('Crème brûlée / OAuth'), 'creme-brulee-oauth');
    assert.match(slugifyTaskName('---'), /^task-[a-f0-9]{8}$/);
    assert.match(slugifyTaskName('修复登录'), /^task-[a-f0-9]{8}$/);
    assert.ok(slugifyTaskName('a'.repeat(200)).length <= 60);
});

test('WORKTREE-PROVISIONING-PLAN-001 allocates one shared suffix for branch and managed path', async () => {
    const branchChecks = [];
    const pathChecks = [];
    const plan = await createWorktreeProvisioningPlan({
        repository: repository(),
        taskName: 'Fix login race',
        isBranchAvailable: async branch => {
            branchChecks.push(branch);
            return branch.endsWith('-3');
        },
        isPathAvailable: async candidatePath => {
            pathChecks.push(candidatePath);
            return !candidatePath.endsWith('fix-login-race-2');
        },
        reservedBranches: new Set(['agent-pivot/fix-login-race']),
    });

    assert.equal(plan.branchName, 'agent-pivot/fix-login-race-3');
    assert.equal(plan.worktreePath, '/repo/.agent-pivot/worktrees/fix-login-race-3');
    assert.equal(plan.commandCwd, '/repo');
    assert.equal(plan.baseRef, 'refs/heads/main');
    assert.deepEqual(branchChecks, [
        'agent-pivot/fix-login-race-2',
        'agent-pivot/fix-login-race-3',
    ]);
    assert.deepEqual(pathChecks, [
        '/repo/.agent-pivot/worktrees/fix-login-race-2',
        '/repo/.agent-pivot/worktrees/fix-login-race-3',
    ]);
});

test('WORKTREE-PROVISIONING-PLAN-001 rejects empty tasks, missing bases, and repositories without a checkout', async () => {
    const available = async () => true;
    await assert.rejects(createWorktreeProvisioningPlan({
        repository: repository(), taskName: '   ',
        isBranchAvailable: available, isPathAvailable: available,
    }), error => error instanceof WorktreeProvisioningPlanError && error.code === 'invalid-task');
    await assert.rejects(createWorktreeProvisioningPlan({
        repository: repository({ baseRef: undefined }), taskName: 'task',
        isBranchAvailable: available, isPathAvailable: available,
    }), error => error instanceof WorktreeProvisioningPlanError && error.code === 'base-ref-unavailable');
    await assert.rejects(createWorktreeProvisioningPlan({
        repository: repository({ worktrees: [] }), taskName: 'task',
        isBranchAvailable: available, isPathAvailable: available,
    }), error => error instanceof WorktreeProvisioningPlanError && error.code === 'base-ref-unavailable');
});

test('WORKTREE-PROVISIONING-PLAN-001 supports Windows repository paths', async () => {
    const plan = await createWorktreeProvisioningPlan({
        repository: repository({
            repositoryKey: 'C:\\repo\\.git',
            worktrees: [{
                key: { repositoryKey: 'C:\\repo\\.git', canonicalWorktreePath: 'C:\\repo' },
                head: 'a'.repeat(40), isMain: true, isBare: false,
                health: 'normal', headKind: 'branch',
            }],
        }),
        taskName: 'Task',
        isBranchAvailable: async () => true,
        isPathAvailable: async () => true,
    });
    assert.equal(plan.worktreePath, 'C:\\repo\\.agent-pivot\\worktrees\\task');
});

test('WORKTREE-PROVISIONING-PLAN-001 keeps bare repositories in a repository-specific managed root', async () => {
    const plan = await createWorktreeProvisioningPlan({
        repository: repository({
            repositoryKey: '/repos/platform.git',
            worktrees: [{
                key: { repositoryKey: '/repos/platform.git', canonicalWorktreePath: '/linked/platform-main' },
                head: 'a'.repeat(40), isMain: false, isBare: false,
                health: 'normal', headKind: 'branch',
            }],
        }),
        taskName: 'Task',
        isBranchAvailable: async () => true,
        isPathAvailable: async () => true,
    });
    assert.equal(plan.worktreePath, '/repos/platform/.agent-pivot/worktrees/task');
});
