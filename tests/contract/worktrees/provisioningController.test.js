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
        startAgent: async () => { calls.push('agent'); },
        publish: (revision, rows) => publications.push({ revision, rows }),
        onSettled: outcome => settlements.push(outcome),
        ...overrides,
    });
    return { controller, calls, publications, settlements };
}

test('WORKTREE-PROVISIONING-STATE-001 publishes every stage and one terminal success', async () => {
    const current = fixture();
    const outcome = await current.controller.start('operation-1', plan);

    assert.deepEqual(current.calls, ['worktree', 'setup', 'agent']);
    assert.deepEqual(outcome, { kind: 'succeeded', operationId: 'operation-1', worktreeKey: key });
    assert.deepEqual(current.settlements, [outcome]);
    assert.deepEqual(current.publications.map(publication => publication.revision), [1, 2, 3, 4, 5]);
    assert.deepEqual(current.publications.slice(0, -1).map(publication =>
        publication.rows[0].stage), ['queued', 'creating', 'setting-up', 'starting-agent']);
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
        startAgent: async () => { current.calls.push('agent'); },
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
    assert.deepEqual(current.calls, ['worktree', 'setup', 'setup', 'agent'],
        'retry resumes after the durable worktree step');
    assert.equal(current.settlements.length, 2, 'each attempt settles exactly once');
});

test('WORKTREE-PROVISIONING-STATE-001 agent failure retries only the agent step', async () => {
    let agentAttempts = 0;
    const current = fixture({
        createWorktree: async () => { current.calls.push('worktree'); return key; },
        runSetup: async () => { current.calls.push('setup'); },
        startAgent: async () => {
            current.calls.push('agent');
            agentAttempts += 1;
            if (agentAttempts === 1) throw Object.assign(new Error('agent'), { code: 'agent-failed' });
        },
    });

    const failed = await current.controller.start('operation-agent', plan);
    assert.deepEqual(failed.completedSteps, ['worktree', 'setup']);
    await current.controller.retry('operation-agent');
    assert.deepEqual(current.calls, ['worktree', 'setup', 'agent', 'agent']);
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
        startAgent: async () => { current.calls.push('agent'); },
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
    assert.deepEqual(current.calls, ['worktree', 'setup', 'agent']);
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
