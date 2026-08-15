'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    WorktreeProvisioningStore,
} = require('../../../out/worktrees/provisioningStore');

function record(operationId = 'operation-1') {
    return {
        version: 1,
        operationId,
        projectId: 'project-1',
        providerId: 'codex',
        profile: { kind: 'profile', name: 'glm' },
        setupCommand: ['npm', 'ci'],
        plan: {
            repositoryKey: '/repo/.git',
            commandCwd: '/repo',
            baseRef: 'refs/heads/main',
            taskName: 'Fix login race',
            slug: 'fix-login-race',
            branchName: 'agent-pivot/fix-login-race',
            worktreePath: '/repo/.agent-pivot/worktrees/fix-login-race',
        },
        completedSteps: ['worktree'],
        worktreeKey: {
            repositoryKey: '/repo/.git',
            canonicalWorktreePath: '/repo/.agent-pivot/worktrees/fix-login-race',
        },
        row: {
            kind: 'provisioning', operationId, repositoryKey: '/repo/.git',
            taskName: 'Fix login race', proposedPath: '/repo/.agent-pivot/worktrees/fix-login-race',
            stage: 'failed', completedSteps: ['worktree'], retryable: true,
            cancellable: false, errorCode: 'interrupted',
        },
    };
}

function memento(initial = undefined) {
    const state = new Map();
    if (initial !== undefined) state.set('agentPivot.worktreeProvisioning.v1', initial);
    return {
        state,
        get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
        async update(key, value) { state.set(key, value); },
    };
}

test('WORKTREE-PROVISIONING-RECOVERY-001 round-trips defensive bounded operation records', async () => {
    const state = memento();
    const store = new WorktreeProvisioningStore(state);
    const input = record();

    await store.replace([input]);
    input.completedSteps.push('setup');
    input.setupCommand.push('--mutated');
    const restored = store.read();

    assert.deepEqual(restored, [record()]);
    restored[0].row.completedSteps.push('mutated');
    assert.deepEqual(store.read(), [record()]);
});

test('WORKTREE-PROVISIONING-RECOVERY-001 round-trips the starting navigation identity', async () => {
    const state = memento();
    const store = new WorktreeProvisioningStore(state);
    const bound = { ...record('bound'), workspaceNavigationIdentity: 'navigation:workspace' };
    await store.replace([bound]);
    const restored = store.read();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].workspaceNavigationIdentity, 'navigation:workspace');
    const corrupt = memento([
        { ...record('bad-identity'), workspaceNavigationIdentity: 42 },
        { ...record('empty-identity'), workspaceNavigationIdentity: '' },
    ]);
    assert.deepEqual(new WorktreeProvisioningStore(corrupt).read(), [],
        'a non-string identity invalidates the whole record, fail closed');
});

test('WORKTREE-PROVISIONING-RECOVERY-001 tombstones have their own bounded bucket', async () => {
    const state = memento();
    const store = new WorktreeProvisioningStore(state);
    const tombstones = Array.from({ length: 40 }, (_unused, index) => ({
        ...record(`tombstone-${index}`),
        tombstone: true,
    }));
    await store.replace(tombstones);
    const restored = store.read();
    assert.equal(restored.length, 40,
        'tombstones are not evicted by the 32-record live cap');
    assert.ok(restored.every(entry => entry.tombstone === true));

    const live = Array.from({ length: 33 }, (_unused, index) => record(`live-${index}`));
    await store.replace([...restored.slice(0, 5), ...live]);
    const after = store.read();
    assert.equal(after.filter(entry => entry.tombstone).length, 5,
        'live records never crowd out tombstones');
    assert.equal(after.filter(entry => !entry.tombstone).length, 32,
        'live records keep their own cap');
});

test('WORKTREE-PROVISIONING-RECOVERY-001 pruneTombstones drops entries whose worktree is gone', async () => {
    const state = memento();
    const store = new WorktreeProvisioningStore(state);
    const gone = {
        ...record('tombstone-gone'),
        tombstone: true,
    };
    gone.plan = { ...gone.plan, worktreePath: '/repo/.agent-pivot/worktrees/gone' };
    gone.worktreeKey = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/.agent-pivot/worktrees/gone',
    };
    gone.row = { ...gone.row, proposedPath: '/repo/.agent-pivot/worktrees/gone' };
    const kept = { ...record('tombstone-kept'), tombstone: true };
    await store.replace([gone, kept]);
    await store.pruneTombstones(new Set([
        '/repo/.git /repo/.agent-pivot/worktrees/fix-login-race',
    ]));
    const restored = store.read();
    assert.deepEqual(restored.map(entry => entry.operationId), ['tombstone-kept'],
        'only the tombstone with a surviving worktree stays');
});

test('WORKTREE-PROVISIONING-RECOVERY-001 ignores corrupt, duplicate, and unsafe records', () => {
    const valid = record('valid');
    const state = memento([
        valid,
        record('valid'),
        { ...record('bad-provider'), providerId: 'unknown' },
        { ...record('bad-path'), plan: { ...valid.plan, worktreePath: 'relative' } },
        { ...record('unmanaged'), plan: {
            ...valid.plan, worktreePath: '/tmp/unmanaged',
        }, row: { ...valid.row, operationId: 'unmanaged', proposedPath: '/tmp/unmanaged' },
        worktreeKey: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/tmp/unmanaged' } },
        { ...record('bad-steps'), completedSteps: ['setup'],
            row: { ...valid.row, operationId: 'bad-steps', completedSteps: ['setup'] },
            worktreeKey: undefined },
        { ...record('wrong-key'), worktreeKey: {
            repositoryKey: '/repo/.git',
            canonicalWorktreePath: '/repo/.agent-pivot/worktrees/other',
        } },
        null,
    ]);

    assert.deepEqual(new WorktreeProvisioningStore(state).read(), [record('valid')]);
});

test('WORKTREE-PROVISIONING-RECOVERY-001 serializes replacements', async () => {
    const state = memento();
    const writes = [];
    let releaseFirst;
    state.update = async (key, value) => {
        if (key !== 'agentPivot.worktreeProvisioning.v1') return;
        writes.push(value);
        if (writes.length === 1) await new Promise(resolve => { releaseFirst = resolve; });
        state.state.set('agentPivot.worktreeProvisioning.v1', value);
    };
    const store = new WorktreeProvisioningStore(state);
    const first = store.replace([record('first')]);
    const second = store.replace([record('second')]);
    for (let index = 0; index < 10 && !releaseFirst; index += 1) await Promise.resolve();
    assert.equal(writes.length, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(writes.length, 2);
    assert.equal(store.read()[0].operationId, 'second');
});
