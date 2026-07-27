'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    DashboardBootstrapController,
} = require('../../../out/dashboard/bootstrapController');
const {
    DashboardBootstrapResources,
} = require('../../../out/dashboard/bootstrapResources');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function bootstrapResult(name, releases, resources) {
    resources.own({
        dispose() {
            releases.push(name);
        },
    });
    return { name };
}

async function settleBackgroundWork() {
    await new Promise(resolve => setImmediate(resolve));
}

function createHarness(overrides = {}) {
    const runs = [];
    const begins = [];
    const completes = [];
    const failures = [];
    const transfers = [];
    const diagnostics = [];
    const controller = new DashboardBootstrapController({
        run(generation, resources) {
            const pending = deferred();
            runs.push({ generation, resources, pending });
            return pending.promise;
        },
        begin(generation) {
            begins.push(generation);
            return true;
        },
        complete(generation, options) {
            completes.push({ generation, options });
            return true;
        },
        fail(generation) {
            failures.push(generation);
            return true;
        },
        transfer(resources) {
            transfers.push(resources);
        },
        logDiagnostic(event) {
            diagnostics.push(event);
        },
        nowMs: () => 100,
        ...overrides,
    });
    return {
        controller,
        runs,
        begins,
        completes,
        failures,
        transfers,
        diagnostics,
    };
}

test('WEBVIEW-TWO-STAGE-STARTUP-001 activation owner starts without awaiting bootstrap', async () => {
    const harness = createHarness();
    const releases = [];

    assert.equal(harness.controller.start(), undefined);
    assert.deepEqual(harness.begins, [1]);
    assert.deepEqual(harness.runs.map(run => run.generation), [1]);

    harness.controller.start();
    harness.controller.retry();
    assert.equal(harness.runs.length, 1);

    harness.runs[0].pending.resolve(bootstrapResult(
        'ready', releases, harness.runs[0].resources
    ));
    await settleBackgroundWork();

    assert.deepEqual(harness.completes.map(item => item.generation), [1]);
    assert.equal(harness.transfers.length, 1);
    assert.deepEqual(releases, []);
    assert.deepEqual(harness.diagnostics, [{
        event: 'agent-pivot-bootstrap-ready',
        generation: 1,
        durationMs: 0,
    }]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 transfers only the latest successful generation', async () => {
    const releases = [];
    const harness = createHarness({
        complete(generation, options) {
            harness.completes.push({ generation, options });
            return generation === 2;
        },
    });

    harness.controller.start();
    const firstResult = bootstrapResult(
        'superseded', releases, harness.runs[0].resources
    );
    harness.runs[0].pending.resolve(firstResult);
    await settleBackgroundWork();

    assert.deepEqual(releases, ['superseded']);
    assert.deepEqual(harness.transfers, []);

    harness.controller.retry();
    assert.deepEqual(harness.runs.map(run => run.generation), [1, 2]);
    const secondResult = bootstrapResult(
        'latest', releases, harness.runs[1].resources
    );
    harness.runs[1].pending.resolve(secondResult);
    await settleBackgroundWork();

    assert.deepEqual(harness.begins, [1, 2]);
    assert.deepEqual(harness.completes.map(item => item.generation), [1, 2]);
    assert.deepEqual(harness.failures, [1]);
    assert.deepEqual(harness.transfers, [harness.runs[1].resources]);
    assert.deepEqual(releases, ['superseded']);
    assert.deepEqual(harness.diagnostics, [{
        event: 'agent-pivot-bootstrap-failed',
        generation: 1,
        category: 'dashboard-bootstrap',
    }, {
        event: 'agent-pivot-bootstrap-ready',
        generation: 2,
        durationMs: 0,
    }]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 failure is safe and Retry is single-flight', async () => {
    const serializedDiagnostics = [];
    const harness = createHarness({
        logDiagnostic(event) {
            serializedDiagnostics.push(JSON.stringify(event));
        },
    });
    const rawRejection = { category: 'secret-runtime-value' };
    rawRejection.self = rawRejection;

    harness.controller.start();
    harness.runs[0].pending.reject(rawRejection);
    await settleBackgroundWork();

    assert.deepEqual(harness.failures, [1]);
    assert.deepEqual(serializedDiagnostics, [JSON.stringify({
        event: 'agent-pivot-bootstrap-failed',
        generation: 1,
        category: 'dashboard-bootstrap',
    })]);

    harness.controller.retry();
    harness.controller.retry();
    harness.controller.start();
    assert.deepEqual(harness.runs.map(run => run.generation), [1, 2]);

    const releases = [];
    harness.runs[1].pending.resolve(bootstrapResult(
        'retry', releases, harness.runs[1].resources
    ));
    await settleBackgroundWork();

    assert.deepEqual(harness.completes.map(item => item.generation), [2]);
    assert.equal(harness.transfers.length, 1);
    assert.deepEqual(releases, []);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 disposal rejects late completion and releases its result', async () => {
    const harness = createHarness();
    const releases = [];

    harness.controller.start();
    const lateResult = bootstrapResult(
        'late', releases, harness.runs[0].resources
    );
    harness.controller.dispose();
    harness.controller.dispose();
    assert.deepEqual(releases, ['late']);
    harness.runs[0].pending.resolve(lateResult);
    await settleBackgroundWork();

    assert.deepEqual(releases, ['late']);
    assert.deepEqual(harness.completes, []);
    assert.deepEqual(harness.transfers, []);
    assert.deepEqual(harness.diagnostics, []);

    harness.controller.start();
    harness.controller.retry();
    assert.equal(harness.runs.length, 1);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 disposal immediately releases the in-flight generation scope exactly once', async () => {
    const pending = deferred();
    const releases = [];
    let generationResources;
    const harness = createHarness({
        run(generation, resources) {
            generationResources = resources;
            resources.own({
                dispose() {
                    releases.push(`generation-${generation}`);
                },
            });
            return pending.promise;
        },
    });

    harness.controller.start();
    assert.ok(generationResources instanceof DashboardBootstrapResources);

    harness.controller.dispose();
    harness.controller.dispose();
    assert.deepEqual(releases, ['generation-1']);
    assert.throws(
        () => generationResources.own({ dispose() {} }),
        /already been disposed/
    );

    pending.resolve({ name: 'late' });
    await settleBackgroundWork();

    assert.deepEqual(releases, ['generation-1']);
    assert.deepEqual(harness.completes, []);
    assert.deepEqual(harness.transfers, []);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 rejected begin adoption uses the stable failure path', () => {
    const begins = [];
    const harness = createHarness({
        begin(generation) {
            begins.push(generation);
            return false;
        },
    });

    harness.controller.start();

    assert.deepEqual(begins, [1]);
    assert.deepEqual(harness.runs, []);
    assert.deepEqual(harness.failures, [1]);
    assert.deepEqual(harness.diagnostics, [{
        event: 'agent-pivot-bootstrap-failed',
        generation: 1,
        category: 'dashboard-bootstrap',
    }]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 begin exceptions fail safely without escaping', () => {
    const harness = createHarness({
        begin() {
            throw new Error('private begin failure');
        },
    });

    assert.doesNotThrow(() => harness.controller.start());

    assert.deepEqual(harness.runs, []);
    assert.deepEqual(harness.failures, [1]);
    assert.deepEqual(harness.diagnostics, [{
        event: 'agent-pivot-bootstrap-failed',
        generation: 1,
        category: 'dashboard-bootstrap',
    }]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 begin disposal reentrancy cannot launch or overwrite disposed state', () => {
    let harness;
    harness = createHarness({
        begin() {
            harness.controller.dispose();
            return true;
        },
    });

    harness.controller.start();
    harness.controller.retry();
    harness.controller.start();

    assert.deepEqual(harness.runs, []);
    assert.deepEqual(harness.failures, []);
    assert.deepEqual(harness.diagnostics, []);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 complete exceptions dispose the result and fail safely', async () => {
    const releases = [];
    const harness = createHarness({
        complete() {
            throw new Error('private complete failure');
        },
    });

    harness.controller.start();
    harness.runs[0].pending.resolve(bootstrapResult(
        'complete-exception', releases, harness.runs[0].resources
    ));
    await settleBackgroundWork();

    assert.deepEqual(releases, ['complete-exception']);
    assert.deepEqual(harness.failures, [1]);
    assert.deepEqual(harness.transfers, []);
    assert.deepEqual(harness.diagnostics, [{
        event: 'agent-pivot-bootstrap-failed',
        generation: 1,
        category: 'dashboard-bootstrap',
    }]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 complete disposal reentrancy remains terminal and cleans exactly once', async () => {
    const releases = [];
    let harness;
    harness = createHarness({
        complete() {
            harness.controller.dispose();
            return false;
        },
    });

    harness.controller.start();
    harness.runs[0].pending.resolve(bootstrapResult(
        'complete-dispose', releases, harness.runs[0].resources
    ));
    await settleBackgroundWork();
    harness.controller.retry();
    harness.controller.start();

    assert.deepEqual(releases, ['complete-dispose']);
    assert.deepEqual(harness.failures, []);
    assert.deepEqual(harness.transfers, []);
    assert.deepEqual(harness.diagnostics, []);
    assert.equal(harness.runs.length, 1);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 transfer exception keeps adopted resources until terminal disposal', async () => {
    const releases = [];
    const harness = createHarness({
        transfer() {
            throw new Error('private transfer failure');
        },
    });

    harness.controller.start();
    harness.runs[0].pending.resolve(bootstrapResult(
        'transfer-exception', releases, harness.runs[0].resources
    ));
    await settleBackgroundWork();
    harness.controller.retry();

    assert.deepEqual(releases, []);
    assert.deepEqual(harness.failures, []);
    assert.equal(harness.runs.length, 1);
    assert.deepEqual(harness.diagnostics, [{
        event: 'agent-pivot-bootstrap-failed',
        generation: 1,
        category: 'dashboard-bootstrap',
    }]);

    harness.controller.dispose();
    harness.controller.dispose();
    assert.deepEqual(releases, ['transfer-exception']);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 transfer disposal reentrancy cannot overwrite disposed state', async () => {
    const releases = [];
    let harness;
    harness = createHarness({
        transfer() {
            harness.controller.dispose();
            throw new Error('transfer stopped by disposal');
        },
    });

    harness.controller.start();
    harness.runs[0].pending.resolve(bootstrapResult(
        'transfer-dispose', releases, harness.runs[0].resources
    ));
    await settleBackgroundWork();
    harness.controller.retry();
    harness.controller.start();

    assert.deepEqual(releases, ['transfer-dispose']);
    assert.deepEqual(harness.failures, []);
    assert.deepEqual(harness.diagnostics, []);
    assert.equal(harness.runs.length, 1);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 rejected adoption can retry while the stale handler settles', async () => {
    const releases = [];
    let harness;
    harness = createHarness({
        complete(generation, options) {
            harness.completes.push({ generation, options });
            return generation === 2;
        },
        fail(generation) {
            harness.failures.push(generation);
            if (generation === 1) {
                harness.controller.retry();
            }
            return true;
        },
    });

    harness.controller.start();
    harness.runs[0].pending.resolve(bootstrapResult(
        'rejected-adoption', releases, harness.runs[0].resources
    ));
    await settleBackgroundWork();

    assert.deepEqual(harness.runs.map(run => run.generation), [1, 2]);
    assert.deepEqual(releases, ['rejected-adoption']);

    const latest = bootstrapResult(
        'latest-in-flight', releases, harness.runs[1].resources
    );
    harness.runs[1].pending.resolve(latest);
    await settleBackgroundWork();

    assert.deepEqual(harness.completes.map(item => item.generation), [1, 2]);
    assert.deepEqual(harness.transfers, [harness.runs[1].resources]);
    assert.deepEqual(releases, ['rejected-adoption']);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 fulfilled handler clock exceptions never become unhandled rejection', async () => {
    const releases = [];
    const unhandled = [];
    let clockReads = 0;
    const harness = createHarness({
        nowMs() {
            clockReads++;
            if (clockReads === 1) {
                return 10;
            }
            throw new Error('private clock failure');
        },
    });
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        harness.controller.start();
        harness.runs[0].pending.resolve(bootstrapResult(
            'clock', releases, harness.runs[0].resources
        ));
        await settleBackgroundWork();
        await settleBackgroundWork();
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(unhandled, []);
    assert.deepEqual(releases, []);
    assert.equal(harness.transfers.length, 1);
    assert.deepEqual(harness.diagnostics, [{
        event: 'agent-pivot-bootstrap-ready',
        generation: 1,
        durationMs: 0,
    }]);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 launch clock disposal reentrancy cannot begin work', () => {
    const begins = [];
    let harness;
    harness = createHarness({
        nowMs() {
            harness.controller.dispose();
            return 10;
        },
        begin(generation) {
            begins.push(generation);
            return true;
        },
    });

    harness.controller.start();
    harness.controller.retry();
    harness.controller.start();

    assert.deepEqual(begins, []);
    assert.deepEqual(harness.runs, []);
    assert.deepEqual(harness.diagnostics, []);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 completion clock disposal suppresses late ready diagnostic', async () => {
    const releases = [];
    let reads = 0;
    let harness;
    harness = createHarness({
        nowMs() {
            reads++;
            if (reads === 2) {
                harness.controller.dispose();
            }
            return reads * 10;
        },
    });

    harness.controller.start();
    harness.runs[0].pending.resolve(bootstrapResult(
        'clock-dispose', releases, harness.runs[0].resources
    ));
    await settleBackgroundWork();
    harness.controller.retry();
    harness.controller.start();

    assert.deepEqual(releases, []);
    assert.equal(harness.transfers.length, 1);
    assert.deepEqual(harness.diagnostics, []);
    assert.equal(harness.runs.length, 1);
});
