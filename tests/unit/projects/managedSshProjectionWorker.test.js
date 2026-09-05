'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ManagedSshProjectionWorker,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshProjectionWorker');

function slot(value) {
    return { revisionId: `revision:${value.repeat(64)}`, document: {} };
}

test('MANAGED-REMOTE-CLIENT-ENABLE-001 coalesces projection to the latest catalog revision', async () => {
    const ready = new Set();
    const calls = [];
    let releaseFirst;
    let enteredFirst;
    const entered = new Promise(resolve => { enteredFirst = resolve; });
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const coordinator = {
        isProjectionReady(value) { return ready.has(value.revisionId); },
        async reconcile(value) {
            calls.push(value.revisionId);
            if (calls.length === 1) {
                enteredFirst();
                await gate;
            }
            ready.add(value.revisionId);
        },
    };
    const worker = new ManagedSshProjectionWorker({
        async getCoordinator() { return coordinator; },
        reportError(error) { assert.fail(error); },
        timeoutMs: 1_000,
    });
    const first = slot('a');
    const latest = slot('b');
    worker.schedule(first);
    await entered;
    worker.schedule(latest);
    releaseFirst();
    await worker.ensureReady(latest);

    assert.deepEqual(calls, [first.revisionId, latest.revisionId]);
});

test('MANAGED-REMOTE-PROJECTION-001 gives foreground navigation a finite deadline', async () => {
    const coordinator = {
        isProjectionReady() { return false; },
        reconcile() { return new Promise(() => {}); },
    };
    const worker = new ManagedSshProjectionWorker({
        async getCoordinator() { return coordinator; },
        reportError() {},
        timeoutMs: 5,
    });
    await assert.rejects(worker.ensureReady(slot('c')), /timed out/i);
});

test('MANAGED-REMOTE-PROJECTION-001 navigates when the alias resolves despite a failed audit', async () => {
    const reported = [];
    const coordinator = {
        // The OpenSSH audit of the user's own config fails, but Remote - SSH
        // can already resolve the projected alias.
        isProjectionReady() { return false; },
        isProjectionResolvable() { return true; },
        reconcile() {
            return Promise.reject(new Error(
                'OpenSSH aggregate validation failed for machine:one. OpenSSH exited 255: bad config',
            ));
        },
    };
    const worker = new ManagedSshProjectionWorker({
        async getCoordinator() { return coordinator; },
        reportError(error) { reported.push(error.message); },
        timeoutMs: 5_000,
    });

    await worker.ensureReady(slot('d'));

    assert.equal(reported.length, 1);
    assert.match(reported[0], /aggregate validation failed/u);
});

test('MANAGED-REMOTE-PROJECTION-001 still fails when the alias cannot be resolved', async () => {
    const coordinator = {
        isProjectionReady() { return false; },
        isProjectionResolvable() { return false; },
        reconcile() {
            return Promise.reject(new Error('OpenSSH aggregate validation failed for machine:one.'));
        },
    };
    const worker = new ManagedSshProjectionWorker({
        async getCoordinator() { return coordinator; },
        reportError() {},
        timeoutMs: 5_000,
    });

    await assert.rejects(
        worker.ensureReady(slot('e')),
        /aggregate validation failed/u,
    );
});
