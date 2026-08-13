'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeClock } = require('../../helpers/fakeClock');
const { GitWorktreeDiscoveryError } = require('../../../out/worktrees/gitWorktreeDiscovery');
const { WorktreeSnapshotCoordinator } = require('../../../out/worktrees/snapshotCoordinator');
const {
    AiSessionProjectionCoordinator,
} = require('../../../out/workspaces/sessionHydrationController');

function content(path = '/repo/main') {
    return {
        repositories: [{
            repositoryKey: '/repo/.git',
            rootBindings: [{ workspaceRootId: 'root', repositoryRelativePath: '' }],
            baseRef: 'refs/heads/main',
            worktrees: [{
                key: { repositoryKey: '/repo/.git', canonicalWorktreePath: path },
                branchRef: 'refs/heads/main',
                head: 'a'.repeat(40),
                isMain: true,
                isBare: false,
                health: 'normal',
                headKind: 'branch',
            }],
        }],
        truncatedWorktreeCount: 0,
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

test('WORKTREE-SNAPSHOT-001 publishes loading, immutable ready revisions, and last-good errors', async () => {
    const loads = [
        () => Promise.resolve(content()),
        () => Promise.reject(new GitWorktreeDiscoveryError('git unavailable', false)),
    ];
    const states = [];
    const coordinator = new WorktreeSnapshotCoordinator({ load: () => loads.shift()() });
    coordinator.onDidChange(state => states.push(state));

    await coordinator.start();
    assert.deepEqual(states.map(state => state.kind), ['loading', 'ready']);
    assert.equal(coordinator.getSnapshot().revision, 1);
    assert.equal(Object.isFrozen(coordinator.getSnapshot().repositories[0].worktrees[0].key), true);

    await coordinator.refresh();
    assert.equal(coordinator.getState().kind, 'error');
    assert.equal(coordinator.getState().retryable, false);
    assert.equal(coordinator.getState().lastGoodSnapshot.revision, 1);
    assert.equal(coordinator.getSnapshot().revision, 1);
    coordinator.dispose();
});

test('WORKTREE-SNAPSHOT-001 injects one coherent worktree snapshot into presentation transactions', async () => {
    const snapshotCoordinator = new WorktreeSnapshotCoordinator({
        load: async () => content(),
    });
    await snapshotCoordinator.start();
    const projectionCoordinator = new AiSessionProjectionCoordinator({
        getWorktreeSnapshot: () => snapshotCoordinator.getSnapshot(),
        getActiveRuntimes: () => [],
        getPendingRuntimes: () => [],
        getExecutionSnapshot: () => ({}),
        getFocusedIdentity: () => null,
        getAttentionAggregate: () => null,
    });

    const transaction = projectionCoordinator.captureNext(null);
    assert.equal(transaction.revision, 1);
    assert.strictEqual(transaction.worktreeSnapshot, snapshotCoordinator.getSnapshot());
    assert.equal(transaction.worktreeSnapshot.revision, 1);
    snapshotCoordinator.dispose();
});

test('WORKTREE-SNAPSHOT-001 keeps loads single-flight and discards stale generations', async () => {
    const first = deferred();
    const second = deferred();
    let loadCount = 0;
    const coordinator = new WorktreeSnapshotCoordinator({
        load: () => (++loadCount === 1 ? first.promise : second.promise),
        debounceMs: 0,
    });
    const startup = coordinator.start();
    coordinator.invalidate('workspace-roots');
    coordinator.invalidate('git-state');
    assert.equal(loadCount, 1);

    first.resolve(content('/repo/stale'));
    await flush();
    assert.equal(loadCount, 2);
    assert.equal(coordinator.getSnapshot(), null);
    second.resolve(content('/repo/current'));
    await startup;
    assert.equal(coordinator.getSnapshot().repositories[0].worktrees[0].key.canonicalWorktreePath, '/repo/current');
    assert.equal(coordinator.getSnapshot().revision, 1);
    coordinator.dispose();
});

test('WORKTREE-SNAPSHOT-001 debounces invalidations and refreshes on visibility and bounded TTL', async () => {
    const clock = createFakeClock(0);
    let loadCount = 0;
    const coordinator = new WorktreeSnapshotCoordinator({
        load: async () => {
            loadCount += 1;
            return content(`/repo/${loadCount}`);
        },
        debounceMs: 10,
        visibleTtlMs: 30,
        setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
        clearTimeout: handle => clock.clearTimeout(handle),
    });

    coordinator.invalidate('one');
    coordinator.invalidate('two');
    clock.advanceBy(9);
    assert.equal(loadCount, 0);
    clock.advanceBy(1);
    await flush();
    assert.equal(loadCount, 1);

    coordinator.setVisible(true);
    await flush();
    assert.equal(loadCount, 2);
    clock.advanceBy(30);
    clock.advanceBy(10);
    await flush();
    assert.equal(loadCount, 3);

    coordinator.setVisible(false);
    clock.advanceBy(100);
    await flush();
    assert.equal(loadCount, 3);
    coordinator.dispose();
    assert.equal(clock.pendingCount, 0);
});
