'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeProvisioningController,
} = require('../../../out/worktrees/provisioningController');

const plan = {
    repositoryKey: '/repo/.git',
    commandCwd: '/repo',
    baseRef: 'refs/heads/main',
    taskName: 'Fix login race',
    slug: 'fix-login-race',
    branchName: 'agent-pivot/fix-login-race',
    worktreePath: '/repo/.agent-pivot/worktrees/fix-login-race',
};
const key = {
    repositoryKey: plan.repositoryKey,
    canonicalWorktreePath: plan.worktreePath,
};

function fixture(overrides = {}) {
    const calls = [];
    const publications = [];
    const settlements = [];
    const controller = new WorktreeProvisioningController({
        createWorktree: async () => { calls.push('worktree'); return key; },
        runSetup: async () => { calls.push('setup'); },
        publish: (revision, rows) => publications.push({ revision, rows }),
        onSettled: outcome => settlements.push(outcome),
        ...overrides,
    });
    return { controller, calls, publications, settlements };
}

test('WORKTREE-PROVISIONING-STATE-001 publishes every stage and one terminal success', async () => {
    const current = fixture();
    const outcome = await current.controller.start('operation-1', plan);

    assert.deepEqual(current.calls, ['worktree', 'setup']);
    assert.deepEqual(outcome, {
        kind: 'succeeded', operationId: 'operation-1', worktreeKey: key, plan,
    });
    assert.deepEqual(current.settlements, [outcome]);
    assert.deepEqual(current.publications.map(publication => publication.revision), [1, 2, 3, 4]);
    assert.deepEqual(current.publications.slice(0, -1).map(publication =>
        publication.rows[0].stage), ['queued', 'creating', 'setting-up']);
    assert.deepEqual(current.publications.at(-1).rows, []);
    assert.deepEqual(current.controller.getRows(), []);
});

test('WORKTREE-PROVISIONING-STATE-001 setup failure retries without creating a second worktree', async () => {
    let setupAttempts = 0;
    const current = fixture({
        createWorktree: async () => { current.calls.push('worktree'); return key; },
        runSetup: async () => {
            current.calls.push('setup');
            setupAttempts += 1;
            if (setupAttempts === 1) throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });

    const failed = await current.controller.start('operation-setup', plan);
    assert.deepEqual(failed, {
        kind: 'partial', operationId: 'operation-setup', worktreeKey: key,
        errorCode: 'setup-failed', completedSteps: ['worktree'],
    });
    assert.deepEqual(current.controller.getRows()[0], {
        kind: 'provisioning', operationId: 'operation-setup', repositoryKey: '/repo/.git',
        taskName: 'Fix login race', proposedPath: plan.worktreePath, stage: 'failed',
        completedSteps: ['worktree'], retryable: true, cancellable: false,
        errorCode: 'setup-failed',
    });

    const succeeded = await current.controller.retry('operation-setup');
    assert.equal(succeeded.kind, 'succeeded');
    assert.deepEqual(current.calls, ['worktree', 'setup', 'setup'],
        'retry resumes after the durable worktree step');
    assert.equal(current.settlements.length, 2, 'each attempt settles exactly once');
});

test('WORKTREE-PROVISIONING-STATE-001 cancellation before create does no work and removes the row', async () => {
    const current = fixture();
    const pending = current.controller.start('operation-cancel-before', plan);
    assert.equal(current.controller.cancel('operation-cancel-before'), true);
    const outcome = await pending;

    assert.deepEqual(outcome, {
        kind: 'failed', operationId: 'operation-cancel-before', errorCode: 'cancelled',
    });
    assert.deepEqual(current.calls, []);
    assert.deepEqual(current.controller.getRows(), []);
    assert.equal((await current.controller.retry('operation-cancel-before')).errorCode, 'retry-unavailable');
});

test('WORKTREE-PROVISIONING-STATE-001 cancellation after create retains a retryable partial row', async () => {
    let releaseCreate;
    const created = new Promise(resolve => { releaseCreate = resolve; });
    const current = fixture({
        createWorktree: async () => {
            current.calls.push('worktree');
            await created;
            return key;
        },
        runSetup: async () => { current.calls.push('setup'); },
    });
    const pending = current.controller.start('operation-cancel-after', plan);
    for (let index = 0; index < 10 && !current.calls.length; index += 1) await Promise.resolve();
    assert.deepEqual(current.calls, ['worktree']);
    assert.equal(current.controller.cancel('operation-cancel-after'), true);
    releaseCreate();
    const outcome = await pending;

    assert.equal(outcome.kind, 'partial');
    assert.deepEqual(outcome.completedSteps, ['worktree']);
    assert.equal(current.controller.getRows()[0].retryable, true);
    await current.controller.retry('operation-cancel-after');
    assert.deepEqual(current.calls, ['worktree', 'setup']);
});

test('WORKTREE-PROVISIONING-STATE-001 cancelling a queued retry preserves the completed worktree', async () => {
    let setupAttempts = 0;
    const current = fixture({
        runSetup: async () => {
            setupAttempts += 1;
            if (setupAttempts === 1) throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.start('operation-retry-cancel', plan);
    const retry = current.controller.retry('operation-retry-cancel');
    assert.equal(current.controller.cancel('operation-retry-cancel'), true);
    const outcome = await retry;
    assert.equal(outcome.kind, 'partial');
    assert.deepEqual(outcome.completedSteps, ['worktree']);
    assert.equal(current.controller.getRows()[0].retryable, true);
});

test('WORKTREE-PROVISIONING-STATE-001 discard drops only settled-failed rows', async () => {
    const current = fixture({
        runSetup: async () => {
            throw Object.assign(new Error('setup'), { code: 'setup-failed' });
        },
    });
    await current.controller.start('operation-dismiss', plan);
    assert.equal(current.controller.getRows()[0].stage, 'failed');

    assert.equal(current.controller.discard('operation-dismiss'), true);
    assert.deepEqual(current.controller.getRows(), []);
    assert.equal(current.controller.discard('operation-dismiss'), false,
        'a second discard finds no row');
});

test('WORKTREE-PROVISIONING-STATE-001 rejects duplicate, concurrent retry, and late cancellation', async () => {
    let releaseSetup;
    const setup = new Promise(resolve => { releaseSetup = resolve; });
    const current = fixture({
        runSetup: async () => { current.calls.push('setup'); await setup; },
    });
    const pending = current.controller.start('operation-guard', plan);
    assert.equal((await current.controller.start('operation-guard', plan)).errorCode, 'duplicate-operation');
    for (let index = 0; index < 10
        && current.controller.getRows()[0].stage !== 'setting-up'; index += 1) await Promise.resolve();
    assert.equal((await current.controller.retry('operation-guard')).errorCode, 'retry-unavailable');
    releaseSetup();
    await pending;
    assert.equal(current.controller.cancel('operation-guard'), false);
});

test('WORKTREE-PROVISIONING-STATE-001 cancellation publishes one non-cancellable authoritative row', async () => {
    let releaseCreate;
    const gate = new Promise(resolve => { releaseCreate = resolve; });
    const current = fixture({
        createWorktree: async () => {
            current.calls.push('worktree');
            await gate;
            return key;
        },
    });
    const pending = current.controller.start('operation-cancel-once', plan);
    for (let index = 0; index < 10 && !current.calls.length; index += 1) await Promise.resolve();
    assert.equal(current.controller.cancel('operation-cancel-once'), true);
    assert.equal(current.controller.cancel('operation-cancel-once'), false);
    assert.equal(current.controller.getRows()[0].cancellable, false);
    releaseCreate();
    await pending;
});

test('WORKTREE-PROVISIONING-STATE-001 a pre-create retry may atomically replace its collided plan', async () => {
    let attempts = 0;
    const current = fixture({
        createWorktree: async selectedPlan => {
            current.calls.push(selectedPlan.slug);
            attempts += 1;
            if (attempts === 1) {
                throw Object.assign(new Error('collision'), { code: 'branch-conflict' });
            }
            return { ...key, canonicalWorktreePath: selectedPlan.worktreePath };
        },
    });
    await current.controller.start('operation-replan', plan);
    const replacement = {
        ...plan,
        slug: 'fix-login-race-2',
        branchName: 'agent-pivot/fix-login-race-2',
        worktreePath: `${plan.worktreePath}-2`,
    };
    const outcome = await current.controller.retry('operation-replan', replacement);
    assert.equal(outcome.kind, 'succeeded');
    assert.deepEqual(current.calls.slice(0, 2), ['fix-login-race', 'fix-login-race-2']);
});

test('WORKTREE-PROVISIONING-STATE-001 preserves an explicitly non-retryable failure', async () => {
    const current = fixture({
        createWorktree: async () => {
            throw Object.assign(new Error('invalid plan'), {
                code: 'invalid-plan',
                retryable: false,
            });
        },
    });

    const outcome = await current.controller.start('operation-invalid', plan);
    assert.equal(outcome.errorCode, 'invalid-plan');
    assert.equal(current.controller.getRows()[0].retryable, false);
    assert.equal((await current.controller.retry('operation-invalid')).errorCode,
        'retry-unavailable');
});

test('WORKTREE-PROVISIONING-RECOVERY-001 restores interrupted durable state for explicit retry', async () => {
    const current = fixture();
    current.controller.restore([{
        operationId: 'operation-restored',
        plan,
        completedSteps: ['worktree'],
        worktreeKey: key,
        row: {
            kind: 'provisioning', operationId: 'operation-restored',
            repositoryKey: plan.repositoryKey, taskName: plan.taskName,
            proposedPath: plan.worktreePath, stage: 'setting-up',
            completedSteps: ['worktree'], retryable: false, cancellable: true,
        },
    }]);

    assert.deepEqual(current.controller.getRows()[0], {
        kind: 'provisioning', operationId: 'operation-restored',
        repositoryKey: plan.repositoryKey, taskName: plan.taskName,
        proposedPath: plan.worktreePath, stage: 'failed',
        completedSteps: ['worktree'], retryable: true, cancellable: false,
        errorCode: 'interrupted',
    });
    assert.equal((await current.controller.retry('operation-restored')).kind, 'succeeded');
    assert.deepEqual(current.calls, ['setup']);
});

test('WORKTREE-PROVISIONING-RECOVERY-001 exports defensive operation recovery state', async () => {
    let releaseSetup;
    const setup = new Promise(resolve => { releaseSetup = resolve; });
    const current = fixture({ runSetup: async () => setup });
    const pending = current.controller.start('operation-export', plan);
    for (let index = 0; index < 20
        && current.controller.getRows()[0]?.stage !== 'setting-up'; index += 1) await Promise.resolve();

    const exported = current.controller.getRecoveryOperations();
    assert.deepEqual(exported[0].completedSteps, ['worktree']);
    assert.deepEqual(exported[0].worktreeKey, key);
    exported[0].completedSteps.push('setup');
    assert.deepEqual(current.controller.getRecoveryOperations()[0].completedSteps, ['worktree']);
    releaseSetup();
    await pending;
});

test('WORKTREE-PROVISIONING-RECOVERY-001 checkpoints each durable step before advancing', async () => {
    const checkpoints = [];
    const releases = [];
    const current = fixture({
        checkpoint: () => new Promise(resolve => {
            const recovery = current.controller.getRecoveryOperations()[0];
            checkpoints.push({
                steps: recovery?.completedSteps || [],
                rowSteps: recovery?.row.completedSteps || [],
            });
            releases.push(resolve);
        }),
    });
    const pending = current.controller.start('operation-checkpoint', plan);
    for (let index = 0; index < 20 && checkpoints.length < 1; index += 1) await Promise.resolve();
    assert.deepEqual(checkpoints, [{ steps: ['worktree'], rowSteps: ['worktree'] }]);
    assert.deepEqual(current.calls, ['worktree'], 'setup waits for persisted worktree state');
    releases.shift()();
    for (let index = 0; index < 20 && checkpoints.length < 2; index += 1) await Promise.resolve();
    assert.deepEqual(checkpoints, [
        { steps: ['worktree'], rowSteps: ['worktree'] },
        { steps: ['worktree', 'setup'], rowSteps: ['worktree', 'setup'] },
    ]);
    assert.deepEqual(current.calls, ['worktree', 'setup'],
        'success waits for persisted setup state');
    releases.shift()();
    assert.equal((await pending).kind, 'succeeded');
});

test('WORKTREE-PROVISIONING-RECOVERY-001 revalidates a durable worktree before side effects', async () => {
    const current = fixture({
        validateWorktree: async () => {
            throw Object.assign(new Error('changed'), { code: 'worktree-create-failed' });
        },
    });
    current.controller.restore([{
        operationId: 'operation-changed', plan, completedSteps: ['worktree'],
        worktreeKey: key,
        row: {
            kind: 'provisioning', operationId: 'operation-changed',
            repositoryKey: plan.repositoryKey, taskName: plan.taskName,
            proposedPath: plan.worktreePath, stage: 'failed', completedSteps: ['worktree'],
            retryable: true, cancellable: false, errorCode: 'interrupted',
        },
    }]);

    const outcome = await current.controller.retry('operation-changed');
    assert.equal(outcome.errorCode, 'worktree-create-failed');
    assert.deepEqual(current.calls, [], 'setup must not run in a changed checkout');
});
