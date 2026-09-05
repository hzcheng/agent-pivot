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
