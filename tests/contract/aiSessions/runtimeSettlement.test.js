'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createAiSessionRuntimeSettlementCapability,
} = require('../../../out/aiSessions/runtimeSettlementCapability');

function flushAsync() {
    return new Promise(resolve => setImmediate(resolve));
}

async function flushAll() {
    for (let index = 0; index < 10; index++) {
        await flushAsync();
    }
}

function makeRuntime(overrides = {}) {
    const identity = {
        provider: 'codex',
        sessionId: 'session-a',
        workspaceScopeIdentity: 'scope-1',
        workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: ['/work/api'],
        cwd: '/work/api',
        ...(overrides.identity || {}),
    };
    const runtime = {
        identity,
        backend: 'vscode',
        state: 'completed',
        markerPath: '/markers/a',
        runStartedAtMs: 700,
        attached: true,
        terminal: { name: 'terminal-a' },
        ...overrides,
    };
    runtime.identity = identity;
    return runtime;
}

function settledEvaluation() {
    return {
        enabled: true,
        published: true,
        inScopeSessionKeys: [],
        overflowedSessionKeys: [],
        eventIdsBySession: {},
    };
}

function createFixture(overrides = {}) {
    const diagnostics = [];
    const attentionEvaluations = [];
    const viewRefreshes = [];
    const highlighterSyncs = [];
    const releasedSessions = [];
    const tmuxAcknowledgements = [];
    const timers = [];
    const terminalService = {
        getCompletedSessions: () => overrides.completedSessions || [],
        releaseCompletedSession: (provider, sessionId, workspaceScopeIdentity) => {
            releasedSessions.push([provider, sessionId, workspaceScopeIdentity]);
        },
    };
    const tmuxDiscovery = {
        getInactive: () => overrides.inactiveTmux || [],
        acknowledgeInactive: async runtime => {
            tmuxAcknowledgements.push(runtime.identity.sessionId);
            if (overrides.acknowledgeError) {
                throw overrides.acknowledgeError;
            }
            return overrides.acknowledgeOutcome || 'acknowledged';
        },
    };
    const capability = createAiSessionRuntimeSettlementCapability({
        runtimeBelongsToCurrentWorkspace: overrides.runtimeBelongsToCurrentWorkspace
            || (runtime => runtime.identity.workspaceScopeIdentity === 'scope-1'),
        evaluateAttention: overrides.evaluateAttention || (async runtimeOverrides => {
            attentionEvaluations.push(runtimeOverrides);
            return settledEvaluation();
        }),
        tmuxRuntimeDiscovery: tmuxDiscovery,
        aiSessionTerminalService: terminalService,
        refreshAiSessionViewsIncrementally: () => viewRefreshes.push(true),
        syncActiveTerminalHighlighter: () => highlighterSyncs.push(true),
        logDiagnostic: event => diagnostics.push(event),
        setInterval: (callback, intervalMs) => {
            const handle = { callback, intervalMs, cleared: false };
            timers.push(handle);
            return handle;
        },
        clearInterval: handle => { handle.cleared = true; },
    });
    return {
        capability,
        diagnostics,
        attentionEvaluations,
        viewRefreshes,
        highlighterSyncs,
        releasedSessions,
        tmuxAcknowledgements,
        timers,
    };
}

test('ATTENTION-EXECUTION-STATE-SYNC-001 drains queued runtimes in key order with one attention evaluation per batch', async () => {
    const f = createFixture();
    const tmuxRuntime = makeRuntime({
        identity: { sessionId: 'session-b' },
        backend: 'tmux',
        tmux: { sessionName: 'agent-pivot' },
    });
    const vscodeRuntime = makeRuntime({ identity: { sessionId: 'session-c' } });

    f.capability.queueSettlements([tmuxRuntime, vscodeRuntime]);
    await flushAll();

    const expectedKey = runtime =>
        `scope-1:codex:${runtime.identity.sessionId}:700:${runtime.backend}`;
    assert.equal(f.attentionEvaluations.length, 1, 'one merged evaluation per drained batch');
    const overrides = f.attentionEvaluations[0];
    assert.deepEqual(overrides.map(override => override.attentionKey),
        [expectedKey(tmuxRuntime), expectedKey(vscodeRuntime)].sort(),
        'candidates drain in localeCompare key order');
    assert.deepEqual(overrides.map(override => [override.providerId, override.sessionId]), [
        ['codex', 'session-b'],
        ['codex', 'session-c'],
    ]);
    assert.equal(overrides[0].runtime.identity.sessionId, 'session-b');
    assert.deepEqual(f.tmuxAcknowledgements, ['session-b'],
        'tmux runtimes release through the discovery acknowledgement');
    assert.deepEqual(f.releasedSessions, [['codex', 'session-c', 'scope-1']],
        'vscode runtimes release through the terminal service');
    assert.equal(f.viewRefreshes.length, 1, 'a settled batch refreshes the session views');
    assert.equal(f.highlighterSyncs.length, 1, 'a settled batch resyncs the active terminal highlight');
    assert.deepEqual(f.diagnostics, []);
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 retains the batch and reports when attention evaluation fails', async () => {
    const f = createFixture({
        evaluateAttention: async () => { throw new Error('evaluation blew up'); },
    });

    f.capability.queueSettlements([makeRuntime()]);
    await flushAll();

    assert.deepEqual(f.diagnostics, [{
        event: 'runtime-lifecycle-settlement-failed',
        operation: 'evaluate',
        category: 'unexpected',
        hasRuntimeKey: false,
    }]);
    assert.deepEqual(f.releasedSessions, []);
    assert.deepEqual(f.viewRefreshes, [], 'a failed evaluation must not publish a refresh');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 reports stale tmux acknowledgements as release failures', async () => {
    const f = createFixture({ acknowledgeOutcome: 'stale' });
    const tmuxRuntime = makeRuntime({
        backend: 'tmux',
        tmux: { sessionName: 'agent-pivot' },
    });

    f.capability.queueSettlements([tmuxRuntime]);
    await flushAll();

    assert.deepEqual(f.tmuxAcknowledgements, ['session-a']);
    assert.deepEqual(f.diagnostics, [{
        event: 'runtime-lifecycle-settlement-failed',
        operation: 'release',
        category: 'unexpected',
        hasRuntimeKey: true,
    }]);
    assert.deepEqual(f.viewRefreshes, [], 'an unreleased runtime must not trigger a refresh');
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 runs lifecycle tasks behind the named-reason failure boundary', async () => {
    const f = createFixture();

    await f.capability.runSafeLifecycleTask('evaluate-attention-startup', async () => undefined);
    assert.deepEqual(f.diagnostics, [], 'a healthy task stays silent');

    await f.capability.runSafeLifecycleTask('evaluate-attention-startup', async () => {
        throw new Error('task failed');
    });
    await f.capability.runSafeLifecycleTask('acknowledge-user-terminal-close', () => {
        throw new Error('sync throw');
    });
    assert.deepEqual(f.diagnostics, [
        {
            event: 'runtime-lifecycle-task-failed',
            operation: 'evaluate-attention-startup',
            category: 'unexpected',
        },
        {
            event: 'runtime-lifecycle-task-failed',
            operation: 'acknowledge-user-terminal-close',
            category: 'unexpected',
        },
    ], 'every failure carries its explicit operation reason');

    await f.capability.runSafeLifecycleTask('evaluate-attention-startup', async () => {
        throw new Error('task failed');
    });
    assert.equal(f.diagnostics.length, 3, 'the safe boundary resolves instead of rejecting');
});

test('ATTENTION-SINGLE-RUN-COMPLETION-DEDUP-001 coalesces repeats of the same attention key', async () => {
    const f = createFixture();
    const runtime = makeRuntime();

    f.capability.queueSettlements([runtime, makeRuntime(), makeRuntime()]);
    await flushAll();

    assert.equal(f.attentionEvaluations.length, 1);
    assert.equal(f.attentionEvaluations[0].length, 1,
        'one run settles once no matter how many signals queued it');
    assert.deepEqual(f.releasedSessions, [['codex', 'session-a', 'scope-1']]);
});

test('ATTENTION-SINGLE-RUN-COMPLETION-DEDUP-001 skips keys already settling and releases queued follow-ups in one drain', async () => {
    let releaseEvaluation;
    const f = createFixture({
        evaluateAttention: async runtimeOverrides => {
            f.attentionEvaluations.push(runtimeOverrides);
            if (f.attentionEvaluations.length === 1) {
                await new Promise(resolve => { releaseEvaluation = resolve; });
            }
            return settledEvaluation();
        },
    });
    const runtimeA = makeRuntime();
    const runtimeB = makeRuntime({ identity: { sessionId: 'session-b' } });

    f.capability.queueSettlements([runtimeA]);
    await flushAll();
    assert.equal(f.attentionEvaluations.length, 1, 'the first drain holds the batch open');

    f.capability.queueSettlements([makeRuntime(), runtimeB]);
    await flushAll();
    assert.equal(f.attentionEvaluations.length, 1,
        'a key already settling is not queued again; new keys wait for the in-flight drain');

    releaseEvaluation();
    await flushAll();
    assert.equal(f.attentionEvaluations.length, 2,
        'the queued follow-up batch drains inside the same in-flight task');
    assert.deepEqual(f.attentionEvaluations[1].map(override => override.sessionId), ['session-b']);
    assert.deepEqual(f.releasedSessions, [
        ['codex', 'session-a', 'scope-1'],
        ['codex', 'session-b', 'scope-1'],
    ]);
});

test('ATTENTION-SINGLE-RUN-COMPLETION-DEDUP-001 skips foreign workspaces and non-terminal states', async () => {
    const f = createFixture();

    f.capability.queueSettlements([
        makeRuntime({ identity: { workspaceScopeIdentity: 'scope-2' } }),
        makeRuntime({ state: 'running' }),
        makeRuntime({ identity: { sessionId: null } }),
    ]);
    await flushAll();

    assert.deepEqual(f.attentionEvaluations, []);
    assert.deepEqual(f.releasedSessions, []);
    assert.deepEqual(f.diagnostics, []);
});

test('ATTENTION-EXECUTION-STATE-SYNC-001 scans completed terminals and inactive tmux runtimes once per round', async () => {
    const completedIdentity = {
        provider: 'codex',
        sessionId: 'session-scan',
        workspaceScopeIdentity: 'scope-1',
        workspaceNavigationIdentity: 'nav-1',
        workspaceRootHostPaths: ['/work/api'],
        cwd: '/work/api',
    };
    const f = createFixture({
        completedSessions: [
            {
                entry: {
                    runtimeIdentity: completedIdentity,
                    markerPath: '/markers/scan',
                    runStartedAtMs: 900,
                },
                terminal: { name: 'terminal-scan' },
            },
            { entry: { runtimeIdentity: null }, terminal: { name: 'terminal-orphan' } },
        ],
        inactiveTmux: [makeRuntime({
            identity: { sessionId: 'session-tmux' },
            backend: 'tmux',
            tmux: { sessionName: 'agent-pivot' },
        })],
    });

    f.capability.startSettlementScan();
    f.capability.startSettlementScan();
    assert.equal(f.timers.length, 1, 'the scan starts one interval');
    assert.equal(f.timers[0].intervalMs, 1_000, 'the scan keeps the 1s cadence');

    f.timers[0].callback();
    await flushAll();
    assert.deepEqual(f.releasedSessions, [['codex', 'session-scan', 'scope-1']],
        'one round queues the completed terminal runtime');
    assert.deepEqual(f.tmuxAcknowledgements, ['session-tmux'],
        'one round queues the inactive tmux runtime');

    f.capability.dispose();
    assert.equal(f.timers[0].cleared, true, 'dispose clears the scan interval');
});
