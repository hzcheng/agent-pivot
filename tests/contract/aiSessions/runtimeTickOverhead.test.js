'use strict';

// Covers PERSIST-INCREMENTAL-JSONL-LIFECYCLE-READER-001 and
// RUNTIME-TMUX-FOCUSED-RUNTIME-MONITOR-001: the resident runtime timers are
// demand-driven — an idle tick performs no filesystem work at all — and the
// focused tmux monitor backs off while nothing changes.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAiSessionStatusCapability } = require('../../../out/aiSessions/statusCapability');
const { AiSessionAttentionController } = require('../../../out/aiSessions/attentionController');
const { createAiSessionRuntimeSettlementCapability } = require('../../../out/aiSessions/runtimeSettlementCapability');
const { TmuxFocusedRuntimeMonitor } = require('../../../out/aiSessions/tmuxFocusedRuntimeMonitor');

const FS_METHODS = [
    'statSync', 'lstatSync', 'existsSync', 'readdirSync',
    'readFileSync', 'openSync', 'readSync', 'realpathSync',
];

function countFsCalls(fn) {
    const fs = require('node:fs');
    const originals = new Map();
    const counts = new Map();
    for (const method of FS_METHODS) {
        originals.set(method, fs[method]);
        counts.set(method, 0);
        fs[method] = (...args) => {
            counts.set(method, counts.get(method) + 1);
            return originals.get(method).apply(fs, args);
        };
    }
    try {
        fn();
    } finally {
        for (const method of FS_METHODS) {
            fs[method] = originals.get(method);
        }
    }
    return [...counts.values()].reduce((total, count) => total + count, 0);
}

test('PERSIST-INCREMENTAL-JSONL-LIFECYCLE-READER-001 idle status tick performs no filesystem work', async () => {
    const providerReads = [];
    let executionEvaluations = 0;
    let attentionSignalEvaluations = 0;
    let runtimeReconciliations = 0;
    const timers = [];
    const capability = createAiSessionStatusCapability({
        getProviders: () => [{
            id: 'codex',
            service: {
                getLifecycleSignals: () => {
                    providerReads.push('read');
                    return {};
                },
            },
        }],
        getLifecycleRequests: () => [],
        evaluateExecution: () => { executionEvaluations += 1; },
        evaluateAttentionSignals: () => {
            attentionSignalEvaluations += 1;
            return Promise.resolve({});
        },
        evaluateAttentionRuntimes: () => {
            runtimeReconciliations += 1;
            return Promise.resolve({});
        },
        onFailure: () => undefined,
        setInterval: (callback, intervalMs) => {
            const handle = { callback, intervalMs };
            timers.push(handle);
            return handle;
        },
        clearInterval: () => undefined,
    });

    assert.deepStrictEqual(timers.map(timer => timer.intervalMs), [1000, 10000],
        'the cadence contract is unchanged');

    const tickFsCalls = countFsCalls(() => capability.tick());
    assert.strictEqual(tickFsCalls, 0, 'an idle lifecycle tick touches no files');
    assert.deepStrictEqual(providerReads, [], 'providers are not even queried without requests');
    assert.strictEqual(executionEvaluations, 1, 'execution evaluation still runs on the empty signal set');

    const reconcileFsCalls = countFsCalls(() => timers[1].callback());
    assert.strictEqual(reconcileFsCalls, 0, 'the idle runtime reconciliation touches no files');
    // The attention evaluation queue evaluates asynchronously.
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(runtimeReconciliations, 1);

    capability.dispose();
});

test('PERSIST-INCREMENTAL-JSONL-LIFECYCLE-READER-001 status ticks reuse the stable attention workspace snapshot', async () => {
    let workspaceTargetReads = 0;
    let workspaceIdentity = 'scope:fixture';
    const attentionController = new AiSessionAttentionController({
        isEnabled: () => true,
        getWorkspaceIdentity: () => workspaceIdentity,
        getWorkspaceTarget: () => {
            workspaceTargetReads += 1;
            return {
                cardId: 'current',
                workspace: { scopeIdentity: workspaceIdentity, roots: [] },
                sessions: { sessionsByProvider: {} },
            };
        },
        getProviders: () => [],
        getRuntimeById: () => null,
        publish: () => Promise.resolve(true),
        scheduleRefresh: () => undefined,
        nowMs: () => 0,
    });
    const capability = createAiSessionStatusCapability({
        getProviders: () => [],
        getLifecycleRequests: () => [attentionController.getLifecycleRequests()],
        evaluateExecution: () => undefined,
        evaluateAttentionSignals: signals => attentionController.evaluate([], signals),
        evaluateAttentionRuntimes: () => Promise.resolve({}),
        onFailure: () => undefined,
        setInterval: () => ({}),
        clearInterval: () => undefined,
    });
    const tick = async () => {
        capability.tick();
        await new Promise(resolve => setImmediate(resolve));
    };

    await tick();
    await tick();
    assert.strictEqual(workspaceTargetReads, 1,
        'resident ticks must not rebuild the workspace cards and session hydration');

    attentionController.invalidateWorkspaceTarget();
    await tick();
    assert.strictEqual(workspaceTargetReads, 2,
        'an explicit catalog invalidation must refresh the cached workspace target');

    workspaceIdentity = 'scope:other';
    await tick();
    assert.strictEqual(workspaceTargetReads, 3,
        'changing workspaces must refresh the cached workspace target');

    capability.dispose();
});

test('PERSIST-INCREMENTAL-JSONL-LIFECYCLE-READER-001 idle settlement scan performs no filesystem work', () => {
    let attentionEvaluations = 0;
    let refreshes = 0;
    let highlighterSyncs = 0;
    const timers = [];
    const capability = createAiSessionRuntimeSettlementCapability({
        runtimeBelongsToCurrentWorkspace: () => true,
        evaluateAttention: () => {
            attentionEvaluations += 1;
            return Promise.resolve({});
        },
        tmuxRuntimeDiscovery: { getInactive: () => [] },
        aiSessionTerminalService: { getCompletedSessions: () => [] },
        refreshAiSessionViewsIncrementally: () => { refreshes += 1; },
        syncActiveTerminalHighlighter: () => { highlighterSyncs += 1; },
        logDiagnostic: () => undefined,
        setInterval: (callback, intervalMs) => {
            const handle = { callback, intervalMs };
            timers.push(handle);
            return handle;
        },
        clearInterval: () => undefined,
    });

    capability.startSettlementScan();
    capability.startSettlementScan();
    assert.strictEqual(timers.length, 1, 'the scan start is idempotent');
    assert.strictEqual(timers[0].intervalMs, 1000, 'the scan cadence is unchanged');

    const fsCalls = countFsCalls(() => timers[0].callback());
    assert.strictEqual(fsCalls, 0, 'an idle settlement scan touches no files');
    assert.strictEqual(attentionEvaluations, 0, 'an empty queue never drains');
    assert.strictEqual(refreshes, 0);
    assert.strictEqual(highlighterSyncs, 0);

    capability.dispose();
});

function createMonitorHarness(options = {}) {
    const state = {
        now: options.startNow ?? 0,
        visible: options.visible ?? true,
        terminal: { name: 'Project tmux attach' },
        syncCalls: 0,
        refreshes: 0,
        errors: [],
        result: { monitored: true, changed: false, identity: null },
        timer: null,
    };
    const monitor = new TmuxFocusedRuntimeMonitor({
        isVisible: () => state.visible,
        getActiveTerminal: () => state.terminal,
        syncFocusedRuntime: () => {
            state.syncCalls += 1;
            return Promise.resolve(state.result);
        },
        refresh: () => { state.refreshes += 1; },
        onError: error => state.errors.push(error),
        setInterval: (callback, intervalMs) => {
            state.timer = { callback, intervalMs };
            return state.timer;
        },
        clearInterval: () => undefined,
        nowMs: () => state.now,
    });
    const beat = async () => {
        state.now += 1000;
        state.timer.callback();
        // Flush the resolved-promise chain (result handler + in-flight clear).
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
    };
    return { monitor, state, beat };
}

test('RUNTIME-TMUX-FOCUSED-RUNTIME-MONITOR-001 quiet focused runtimes back off to a 4s cadence', async () => {
    const { monitor, state, beat } = createMonitorHarness();
    monitor.start();
    assert.strictEqual(state.timer.intervalMs, 1000, 'the timer keeps its 1s beat');

    await beat(); // t=1000: first sync
    assert.strictEqual(state.syncCalls, 1);
    await beat(); // t=2000: backed off (1s -> 2s window)
    assert.strictEqual(state.syncCalls, 1, 'unchanged result skips the next beat');
    await beat(); // t=3000
    assert.strictEqual(state.syncCalls, 2);
    await beat(); // t=4000..6000: backed off (2s -> 4s window)
    await beat();
    await beat();
    assert.strictEqual(state.syncCalls, 2);
    await beat(); // t=7000
    assert.strictEqual(state.syncCalls, 3, 'the gap caps at 4s');
    await beat(); // t=8000
    assert.strictEqual(state.syncCalls, 3, 'the cap holds at 4s');
    await beat(); // t=9000
    assert.strictEqual(state.syncCalls, 3);
    await beat(); // t=10000
    assert.strictEqual(state.syncCalls, 3);
    await beat(); // t=11000
    assert.strictEqual(state.syncCalls, 4);

    monitor.dispose();
});

test('RUNTIME-TMUX-FOCUSED-RUNTIME-MONITOR-001 changes and explicit requests restore the fast cadence', async () => {
    const { monitor, state, beat } = createMonitorHarness();
    monitor.start();

    await beat(); // t=1000: sync, then back off
    await beat(); // t=2000: skipped
    assert.strictEqual(state.syncCalls, 1);

    state.result = { monitored: true, changed: true, identity: null };
    await beat(); // t=3000: sync sees a change
    assert.strictEqual(state.syncCalls, 2);
    assert.strictEqual(state.refreshes, 1, 'a change still refreshes immediately');
    await beat(); // t=4000: fast cadence restored after the change
    assert.strictEqual(state.syncCalls, 3);

    state.result = { monitored: true, changed: false, identity: null };
    await beat(); // t=5000: sync, back off again (1s -> 2s)
    assert.strictEqual(state.syncCalls, 4);
    state.now += 500;
    await monitor.request(); // explicit request bypasses the backoff window
    assert.strictEqual(state.syncCalls, 5, 'explicit requests run immediately');
    await beat(); // t=6500: backoff was reset by the explicit request
    assert.strictEqual(state.syncCalls, 6);

    monitor.dispose();
});

test('RUNTIME-TMUX-FOCUSED-RUNTIME-MONITOR-001 hidden periods skip timer syncs without advancing the backoff', async () => {
    const { monitor, state, beat } = createMonitorHarness();
    monitor.start();

    await beat(); // t=1000: sync, backoff window now 2s
    assert.strictEqual(state.syncCalls, 1);

    state.visible = false;
    await beat(); // t=2000
    await beat(); // t=3000
    await beat(); // t=4000
    assert.strictEqual(state.syncCalls, 1, 'hidden beats never spawn a sync');

    state.visible = true;
    await beat(); // t=5000: the pre-hidden 2s window (due at t=3000) fires on the first visible beat
    assert.strictEqual(state.syncCalls, 2, 'hidden time does not stretch the backoff further');

    monitor.dispose();
});
