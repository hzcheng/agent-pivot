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

function bootstrapResult(name, releases) {
    const resources = new DashboardBootstrapResources();
    resources.own({
        dispose() {
            releases.push(name);
        },
    });
    return {
        options: { name },
        resources,
    };
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
        run(generation) {
            const pending = deferred();
            runs.push({ generation, pending });
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

    harness.runs[0].pending.resolve(bootstrapResult('ready', releases));
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
    const firstResult = bootstrapResult('superseded', releases);
    harness.runs[0].pending.resolve(firstResult);
    await settleBackgroundWork();

    assert.deepEqual(releases, ['superseded']);
    assert.deepEqual(harness.transfers, []);

    harness.controller.retry();
    assert.deepEqual(harness.runs.map(run => run.generation), [1, 2]);
    const secondResult = bootstrapResult('latest', releases);
    harness.runs[1].pending.resolve(secondResult);
    await settleBackgroundWork();

    assert.deepEqual(harness.begins, [1, 2]);
    assert.deepEqual(harness.completes.map(item => item.generation), [1, 2]);
    assert.deepEqual(harness.transfers, [secondResult.resources]);
    assert.deepEqual(releases, ['superseded']);
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
    harness.runs[1].pending.resolve(bootstrapResult('retry', releases));
    await settleBackgroundWork();

    assert.deepEqual(harness.completes.map(item => item.generation), [2]);
    assert.equal(harness.transfers.length, 1);
    assert.deepEqual(releases, []);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 disposal rejects late completion and releases its result', async () => {
    const harness = createHarness();
    const releases = [];

    harness.controller.start();
    harness.controller.dispose();
    harness.controller.dispose();
    const lateResult = bootstrapResult('late', releases);
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
