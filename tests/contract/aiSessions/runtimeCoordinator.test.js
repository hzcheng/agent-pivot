'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createDeferred,
    createFakeRuntimeBackend,
    fakeCreateRequest,
    fakeResumeRequest,
    fakeRuntime,
    workspaceIdentity,
} = require('../../helpers/runtimeContract');
const { AiSessionRuntimeCoordinator } = require('../../../out/aiSessions/runtimeCoordinator');
const {
    AiSessionRuntimeTargetChangedError,
    TmuxRuntimeUnavailableError,
} = require('../../../out/aiSessions/runtimeTypes');

function createCoordinator(direct, tmux, overrides = {}) {
    return new AiSessionRuntimeCoordinator({
        direct,
        tmux,
        getConfiguration: () => ({ mode: 'tmux', tmuxLayout: 'project', tmuxPath: 'tmux' }),
        chooseTmuxFallback: async () => 'cancel',
        ...overrides,
    });
}

function createLaunchProbe(request, buildLaunchSpec) {
    const { launch, ...requestWithoutLaunch } = request;
    let builds = 0;
    let eagerReads = 0;
    const probedRequest = {
        ...requestWithoutLaunch,
        launchMarkerPath: launch.markerPath || '',
        createLaunchSpec: () => {
            builds += 1;
            return buildLaunchSpec
                ? buildLaunchSpec(launch)
                : { ...launch, args: [...launch.args] };
        },
    };
    Object.defineProperty(probedRequest, 'launch', {
        enumerable: true,
        get: () => {
            eagerReads += 1;
            return { ...launch, args: [...launch.args] };
        },
    });
    return {
        request: probedRequest,
        builds: () => builds,
        eagerReads: () => eagerReads,
    };
}

function assertLaunchProbe(probe, expectedBuilds) {
    assert.equal(probe.eagerReads(), 0, 'identity/preflight must not read an eager launch value');
    assert.equal(probe.builds(), expectedBuilds);
}

test('RUNTIME-RUNTIME-COORDINATOR-001 RUNTIME-AI-SESSION-RUNTIME-CONTROLLER-001 RUNTIME-RUNTIME-CONTROLLER-001 single-flights concurrent resume and create requests', async () => {
    const resumeGate = createDeferred();
    const pendingGate = createDeferred();
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux', { resumeGate, pendingGate });
    const coordinator = createCoordinator(direct, tmux);

    const resumes = [
        coordinator.resume(fakeResumeRequest('single-flight')),
        coordinator.resume(fakeResumeRequest('single-flight')),
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tmux.ensureResumeCalls, 1);
    resumeGate.resolve();
    assert.deepEqual((await Promise.all(resumes)).map(result => result.status), ['started', 'focused']);

    const creates = [
        coordinator.create(fakeCreateRequest('pending-single-flight')),
        coordinator.create(fakeCreateRequest('pending-single-flight')),
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tmux.ensurePendingCalls, 1);
    pendingGate.resolve();
    assert.deepEqual((await Promise.all(creates)).map(result => result.status), ['started', 'started']);
});

test('RUNTIME-RUNTIME-COORDINATOR-001 reuses one runtime and reports cross-backend conflicts', async () => {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux');
    direct.active.push(fakeRuntime('vscode', 'reused'));
    const coordinator = createCoordinator(direct, tmux);

    const reused = await coordinator.resume(fakeResumeRequest('reused'));
    assert.equal(reused.status, 'focused');
    assert.equal(direct.focusCalls.length, 1);
    assert.equal(direct.ensureResumeCalls, 0);

    tmux.active.push(fakeRuntime('tmux', 'reused', {
        attached: false,
        tmux: { layout: 'project', sessionName: 'managed', windowName: 'ai-codex-reused' },
    }));
    const conflict = await coordinator.resume(fakeResumeRequest('reused'));
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(conflict.conflicts.map(runtime => runtime.backend).sort(), ['tmux', 'vscode']);
});

test('RUNTIME-RUNTIME-COORDINATOR-001 maps tmux unavailable choices without hiding other errors', async () => {
    const direct = createFakeRuntimeBackend('vscode');
    const unavailable = new TmuxRuntimeUnavailableError('not-found', 'tmux unavailable');
    const tmux = createFakeRuntimeBackend('tmux', { refreshError: unavailable });
    const choices = [];
    const coordinator = createCoordinator(direct, tmux, {
        chooseTmuxFallback: async context => {
            choices.push(context);
            return 'direct';
        },
    });

    const result = await coordinator.resume(fakeResumeRequest('fallback'));
    assert.equal(result.status, 'started');
    assert.equal(result.runtime.backend, 'vscode');
    assert.equal(direct.ensureResumeCalls, 1);
    assert.deepEqual(choices.map(choice => [choice.operation, choice.knownHint]), [['resume', false]]);

    const unexpected = new Error('private discovery detail');
    const failing = createCoordinator(
        createFakeRuntimeBackend('vscode'),
        createFakeRuntimeBackend('tmux', { refreshError: unexpected })
    );
    await assert.rejects(failing.resume(fakeResumeRequest('fail-closed')), error => error === unexpected);
});

test('SESSION-AI-SESSION-YOLO-LAZY-002 materializes resume specs once only on provider-dispatch branches', async () => {
    const focusedDirect = createFakeRuntimeBackend('vscode');
    focusedDirect.active.push(fakeRuntime('vscode', 'lazy-focused'));
    const focused = createLaunchProbe(fakeResumeRequest('lazy-focused'));
    assert.equal((await createCoordinator(
        focusedDirect, createFakeRuntimeBackend('tmux')
    ).resume(focused.request)).status, 'focused');
    assertLaunchProbe(focused, 0);

    const blockedDirect = createFakeRuntimeBackend('vscode');
    blockedDirect.lifecycleBlockers.push(fakeRuntime('vscode', 'lazy-blocked', {
        state: 'completed',
    }));
    const blocked = createLaunchProbe(fakeResumeRequest('lazy-blocked'));
    assert.equal((await createCoordinator(
        blockedDirect, createFakeRuntimeBackend('tmux')
    ).resume(blocked.request)).status, 'blocked');
    assertLaunchProbe(blocked, 0);

    const conflictDirect = createFakeRuntimeBackend('vscode');
    const conflictTmux = createFakeRuntimeBackend('tmux');
    conflictDirect.active.push(fakeRuntime('vscode', 'lazy-conflict'));
    conflictTmux.active.push(fakeRuntime('tmux', 'lazy-conflict', {
        attached: false,
        tmux: { layout: 'project', sessionName: 'managed', windowName: 'lazy-conflict' },
    }));
    const conflict = createLaunchProbe(fakeResumeRequest('lazy-conflict'));
    assert.equal((await createCoordinator(
        conflictDirect, conflictTmux
    ).resume(conflict.request)).status, 'conflict');
    assertLaunchProbe(conflict, 0);

    for (const choice of ['cancel', 'settings']) {
        const unavailable = new TmuxRuntimeUnavailableError('not-found', 'tmux unavailable');
        const noDispatch = createLaunchProbe(fakeResumeRequest(`lazy-${choice}`));
        const result = await createCoordinator(
            createFakeRuntimeBackend('vscode'),
            createFakeRuntimeBackend('tmux', { refreshError: unavailable }),
            { chooseTmuxFallback: async () => choice }
        ).resume(noDispatch.request);
        assert.equal(result.status, choice === 'settings' ? 'settings' : 'cancelled');
        assertLaunchProbe(noDispatch, 0);
    }

    const direct = createLaunchProbe(fakeResumeRequest('lazy-direct'));
    assert.equal((await createCoordinator(
        createFakeRuntimeBackend('vscode'),
        createFakeRuntimeBackend('tmux'),
        {
            getConfiguration: () => ({
                mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux',
            }),
        }
    ).resume(direct.request)).status, 'started');
    assertLaunchProbe(direct, 1);

    const tmux = createLaunchProbe(fakeResumeRequest('lazy-tmux'));
    assert.equal((await createCoordinator(
        createFakeRuntimeBackend('vscode'), createFakeRuntimeBackend('tmux')
    ).resume(tmux.request)).status, 'started');
    assertLaunchProbe(tmux, 1);
});

test('SESSION-AI-SESSION-YOLO-LAZY-003 materializes create specs once only on provider-dispatch branches', async () => {
    const focusedDirect = createFakeRuntimeBackend('vscode');
    focusedDirect.pending.push(fakeRuntime('vscode', undefined, {
        identity: workspaceIdentity({ pendingId: 'lazy-pending-focused' }),
        state: 'pending',
        createdAt: '2026-07-18T10:00:00.000Z',
        excludedSessionIds: [],
    }));
    const focused = createLaunchProbe(fakeCreateRequest('lazy-pending-focused'));
    assert.equal((await createCoordinator(
        focusedDirect, createFakeRuntimeBackend('tmux')
    ).create(focused.request)).status, 'focused');
    assertLaunchProbe(focused, 0);

    const conflictDirect = createFakeRuntimeBackend('vscode');
    const conflictTmux = createFakeRuntimeBackend('tmux');
    for (const [backend, runtimeBackend] of [
        ['vscode', conflictDirect],
        ['tmux', conflictTmux],
    ]) {
        runtimeBackend.pending.push(fakeRuntime(backend, undefined, {
            identity: workspaceIdentity({ pendingId: 'lazy-pending-conflict' }),
            state: 'pending',
            createdAt: '2026-07-18T10:00:00.000Z',
            excludedSessionIds: [],
            ...(backend === 'tmux' ? {
                attached: false,
                tmux: {
                    layout: 'project', sessionName: 'managed',
                    windowName: 'lazy-pending-conflict',
                },
            } : {}),
        }));
    }
    const conflict = createLaunchProbe(fakeCreateRequest('lazy-pending-conflict'));
    assert.equal((await createCoordinator(
        conflictDirect, conflictTmux
    ).create(conflict.request)).status, 'conflict');
    assertLaunchProbe(conflict, 0);

    for (const choice of ['cancel', 'settings']) {
        const unavailable = new TmuxRuntimeUnavailableError('not-found', 'tmux unavailable');
        const noDispatch = createLaunchProbe(fakeCreateRequest(`lazy-pending-${choice}`));
        const result = await createCoordinator(
            createFakeRuntimeBackend('vscode'),
            createFakeRuntimeBackend('tmux', { refreshError: unavailable }),
            { chooseTmuxFallback: async () => choice }
        ).create(noDispatch.request);
        assert.equal(result.status, choice === 'settings' ? 'settings' : 'cancelled');
        assertLaunchProbe(noDispatch, 0);
    }

    const direct = createLaunchProbe(fakeCreateRequest('lazy-pending-direct'));
    assert.equal((await createCoordinator(
        createFakeRuntimeBackend('vscode'),
        createFakeRuntimeBackend('tmux'),
        {
            getConfiguration: () => ({
                mode: 'vscode', tmuxLayout: 'project', tmuxPath: 'tmux',
            }),
        }
    ).create(direct.request)).status, 'started');
    assertLaunchProbe(direct, 1);

    const tmux = createLaunchProbe(fakeCreateRequest('lazy-pending-tmux'));
    assert.equal((await createCoordinator(
        createFakeRuntimeBackend('vscode'), createFakeRuntimeBackend('tmux')
    ).create(tmux.request)).status, 'started');
    assertLaunchProbe(tmux, 1);
});

test('SESSION-AI-SESSION-YOLO-LAZY-004 reads changed launch configuration after a pending tmux fallback choice', async () => {
    const fallbackChoice = createDeferred();
    const unavailable = new TmuxRuntimeUnavailableError('not-found', 'tmux unavailable');
    const direct = createFakeRuntimeBackend('vscode');
    let yoloEnabled = false;
    const launch = createLaunchProbe(fakeResumeRequest('lazy-live-fallback'), original => ({
        ...original,
        args: yoloEnabled
            ? ['resume', '--dangerously-bypass-approvals-and-sandbox', 'lazy-live-fallback']
            : ['resume', 'lazy-live-fallback'],
    }));
    const coordinator = createCoordinator(
        direct,
        createFakeRuntimeBackend('tmux', { refreshError: unavailable }),
        { chooseTmuxFallback: async () => fallbackChoice.promise }
    );

    const pending = coordinator.resume(launch.request);
    await new Promise(resolve => setImmediate(resolve));
    assertLaunchProbe(launch, 0);
    yoloEnabled = true;
    fallbackChoice.resolve('direct');

    assert.equal((await pending).status, 'started');
    assertLaunchProbe(launch, 1);
    assert.deepEqual(direct.launches[0].args, [
        'resume', '--dangerously-bypass-approvals-and-sandbox', 'lazy-live-fallback',
    ]);
});

test('RUNTIME-RUNTIME-COORDINATOR-001 promotes the unique pending backend and preserves conflicts', async () => {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux');
    tmux.pending.push(fakeRuntime('tmux', undefined, {
        identity: workspaceIdentity({ pendingId: 'pending-one' }),
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
        attached: false, tmux: { layout: 'session', sessionName: 'pending-one' },
    }));
    const coordinator = createCoordinator(direct, tmux);

    const promoted = await coordinator.promotePending(
        workspaceIdentity({ pendingId: 'pending-one' }), 'session-one', 'Session one'
    );
    assert.equal(promoted[0].identity.sessionId, 'session-one');
    assert.deepEqual(tmux.promoted, [{ pendingId: 'pending-one', sessionId: 'session-one' }]);

    direct.pending.push(fakeRuntime('vscode', undefined, {
        identity: workspaceIdentity({ pendingId: 'pending-two' }),
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
    }));
    tmux.pending.push(fakeRuntime('tmux', undefined, {
        identity: workspaceIdentity({ pendingId: 'pending-two' }),
        state: 'pending', createdAt: '2026-07-18T10:00:00.000Z', excludedSessionIds: [],
        attached: false, tmux: { layout: 'project', sessionName: 'managed', windowName: 'pending-two' },
    }));
    const conflicted = await coordinator.promotePending(
        workspaceIdentity({ pendingId: 'pending-two' }), 'never', 'Never'
    );
    assert.equal(conflicted.length, 2);
    assert.ok(conflicted.every(runtime => runtime.state === 'conflict'));
});

test('RUNTIME-TMUX-FOCUS-FAST-PATH-001 focuses a unique cached tmux target without full discovery', async () => {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux');
    const runtime = fakeRuntime('tmux', 'focused', {
        attached: false,
        tmux: {
            layout: 'project',
            sessionName: 'managed',
            windowName: 'codex-focused',
        },
    });
    tmux.active.push(runtime);
    const coordinator = createCoordinator(direct, tmux);

    await coordinator.focus(runtime.identity);

    assert.equal(tmux.focusCalls.length, 1);
    assert.deepEqual(tmux.refreshCalls, []);
    assert.deepEqual(direct.refreshCalls, []);
});

test('RUNTIME-TMUX-FOCUS-FAST-PATH-001 reconciles and retries one changed target only once', async () => {
    const direct = createFakeRuntimeBackend('vscode');
    const tmux = createFakeRuntimeBackend('tmux');
    const runtime = fakeRuntime('tmux', 'changed', {
        attached: false,
        tmux: {
            layout: 'project',
            sessionName: 'managed',
            windowName: 'codex-changed',
        },
    });
    tmux.active.push(runtime);
    let focusAttempts = 0;
    tmux.focus = async value => {
        tmux.focusCalls.push(value);
        focusAttempts += 1;
        throw new AiSessionRuntimeTargetChangedError();
    };
    const coordinator = createCoordinator(direct, tmux);

    await coordinator.focus(runtime.identity);

    assert.equal(focusAttempts, 2);
    assert.deepEqual(tmux.refreshCalls, [true]);
    assert.deepEqual(direct.refreshCalls, [true]);
});
