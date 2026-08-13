'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { GitRepositoryStateMonitor } = require('../../../out/worktrees/gitRepositoryStateMonitor');

function eventSource() {
    const listeners = new Set();
    return {
        event(listener) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        fire(value) {
            for (const listener of Array.from(listeners)) listener(value);
        },
        get size() {
            return listeners.size;
        },
    };
}

function repository() {
    const changes = eventSource();
    return {
        repository: { state: { onDidChange: listener => changes.event(listener) } },
        changes,
    };
}

test('WORKTREE-SNAPSHOT-001 observes existing, opened, closed, and disposed Git repositories', async () => {
    const opened = eventSource();
    const closed = eventSource();
    const first = repository();
    const second = repository();
    let invalidations = 0;
    const monitor = new GitRepositoryStateMonitor({
        getApi: async () => ({
            repositories: [first.repository],
            onDidOpenRepository: listener => opened.event(listener),
            onDidCloseRepository: listener => closed.event(listener),
        }),
        onDidChange: () => { invalidations += 1; },
    });
    await monitor.start();
    await monitor.start();
    assert.equal(first.changes.size, 1);
    first.changes.fire();
    opened.fire(second.repository);
    second.changes.fire();
    closed.fire(second.repository);
    second.changes.fire();
    assert.equal(invalidations, 4);

    monitor.dispose();
    assert.equal(first.changes.size, 0);
    assert.equal(opened.size, 0);
    assert.equal(closed.size, 0);
});

test('WORKTREE-SNAPSHOT-001 treats unavailable or failing Git extension APIs as best effort', async () => {
    let error;
    const unavailable = new GitRepositoryStateMonitor({
        getApi: async () => undefined,
        onDidChange: () => assert.fail('unexpected invalidation'),
    });
    await unavailable.start();
    unavailable.dispose();

    const failing = new GitRepositoryStateMonitor({
        getApi: async () => { throw new Error('activation failed'); },
        onDidChange: () => assert.fail('unexpected invalidation'),
        onError: value => { error = value; },
    });
    await failing.start();
    assert.equal(error.message, 'activation failed');
    failing.dispose();
});
